import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type {
  McpConfigFileDTO,
  McpConfigIssueDTO,
  McpRuntimeStatus,
  McpServerDTO,
  McpServerDetailDTO,
  McpToolDTO
} from '../../shared/types'

import { MCP_SERVER_NAME, collidingMcpServerNames, mcpServerIssues, mcpServerKey, normalizeMcpExposure, type McpServerEntry, type McpConfigDocument } from '../../shared/mcp'
export type { McpServerEntry, McpConfigDocument } from '../../shared/mcp'

/** Configuration files consumed by Pi's built-in MCP extension. */
export const MAX_MCP_CONFIG_LENGTH = 200_000
const PROJECT_CONFIG_NAME = join('.pi', 'mcp.json')
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Parse without rewriting legacy documents: a user must explicitly migrate unsupported fields. */
export function parseMcpConfigJson(text: string): { ok: true; config: McpConfigDocument } | { ok: false; error: string } {
  if (!text.trim()) return { ok: true, config: { mcpServers: {} } }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  if (!isRecord(raw)) return { ok: false, error: 'root value must be an object' }
  if (raw.mcpServers !== undefined && !isRecord(raw.mcpServers)) {
    return { ok: false, error: 'mcpServers must be an object' }
  }
  return { ok: true, config: { ...raw, mcpServers: (raw.mcpServers ?? {}) as Record<string, McpServerEntry> } }
}

export function serializeMcpConfig(config: McpConfigDocument): string {
  return `${JSON.stringify(config, null, 2)}\n`
}

function configPath(scope: 'global' | 'project', cwd: string | null, agentDir: string): string | null {
  if (scope === 'global') return join(agentDir, 'mcp.json')
  return cwd ? join(cwd, PROJECT_CONFIG_NAME) : null
}

export function readMcpConfigFile(
  scope: 'global' | 'project',
  cwd: string | null,
  agentDir: string
): McpConfigFileDTO | null {
  const path = configPath(scope, cwd, agentDir)
  if (!path) return null
  try {
    const content = readFileSync(path, 'utf8')
    const parsed = parseMcpConfigJson(content)
    return { path, exists: true, content, parseError: parsed.ok ? null : parsed.error }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { path, exists: false, content: '', parseError: null }
    }
    return { path, exists: true, content: '', parseError: error instanceof Error ? error.message : String(error) }
  }
}

/** Translate config problems into data so the renderer can localize them. */
function documentIssues(config: McpConfigDocument, scope: 'global' | 'project'): McpConfigIssueDTO[] {
  const issues: McpConfigIssueDTO[] = []
  if (config['mcp-servers'] !== undefined) issues.push({ scope, code: 'legacyAlias', field: 'mcp-servers' })
  if (config.autoEnableCodemode !== undefined && typeof config.autoEnableCodemode !== 'boolean') {
    issues.push({ scope, code: 'invalidField', field: 'autoEnableCodemode' })
  }
  for (const field of Object.keys(config)) {
    if (field !== 'mcpServers' && field !== 'autoEnableCodemode' && field !== 'mcp-servers') {
      issues.push({ scope, code: 'legacyField', field })
    }
  }
  for (const [name, value] of Object.entries(config.mcpServers)) {
    issues.push(...mcpServerIssues(name, value, scope).map(issue => ({ ...issue, scope, name })))
  }
  for (const name of collidingMcpServerNames(Object.keys(config.mcpServers))) {
    issues.push({ scope, code: 'invalidField', name, field: 'name' })
  }
  return issues
}

export function readMcpConfigIssues(cwd: string | null, agentDir: string, projectTrusted: boolean): McpConfigIssueDTO[] {
  const issues: McpConfigIssueDTO[] = []
  if (cwd && existsSync(join(cwd, '.mcp.json'))) issues.push({ scope: 'project', code: 'legacyProjectPath' })
  if (existsSync(join(agentDir, 'mcp-adapter.json'))) issues.push({ scope: 'global', code: 'adapterConfigPath' })
  if (cwd && existsSync(join(cwd, '.pi', 'mcp-adapter.json'))) issues.push({ scope: 'project', code: 'adapterConfigPath' })
  for (const scope of ['global', 'project'] as const) {
    const file = readMcpConfigFile(scope, cwd, agentDir)
    if (!file || !file.exists) continue
    if (scope === 'project' && !projectTrusted) {
      issues.push({ scope, code: 'untrustedProject' })
      continue
    }
    const parsed = parseMcpConfigJson(file.content)
    if (!parsed.ok) {
      issues.push({ scope, code: 'invalidJson', detail: parsed.error })
      continue
    }
    issues.push(...documentIssues(parsed.config, scope))
  }
  const roster = buildMcpRoster({ cwd, agentDir, projectTrusted })
  for (const name of collidingMcpServerNames(roster.map(row => row.name))) {
    const row = roster.find(row => row.name === name)!
    if (!issues.some(issue => issue.name === name && issue.field === 'name')) {
      issues.push({ scope: row.scope as 'global' | 'project', code: 'invalidField', name, field: 'name' })
    }
  }
  return issues
}

interface McpWriteOptions {
  cwd: string | null
  agentDir: string
  projectTrusted?: boolean
}

function validateForWrite(config: McpConfigDocument, scope: 'global' | 'project', options: McpWriteOptions): void {
  const issue = documentIssues(config, scope)[0]
  if (issue) {
    const target = issue.name ? `server "${issue.name}"` : 'config'
    throw new Error(`Invalid native MCP ${target}: ${issue.field ?? issue.code}`)
  }
  // Same-name project overrides are valid; different names sharing a namespace
  // are rejected by Pi even when they come from two different files.
  if (scope === 'project' || options.projectTrusted) {
    const other = readMcpConfigFile(scope === 'global' ? 'project' : 'global', options.cwd, options.agentDir)
    const parsed = other && !other.parseError ? parseMcpConfigJson(other.content) : null
    const names = new Set([...Object.keys(config.mcpServers), ...(parsed?.ok ? Object.keys(parsed.config.mcpServers) : [])])
    const collision = collidingMcpServerNames(names)[0]
    if (collision) throw new Error(`Invalid native MCP server "${collision}": name conflicts with another server namespace`)
  }
}

function writeConfigDocument(path: string, config: McpConfigDocument, options: McpWriteOptions): void {
  validateForWrite(config, path === join(options.agentDir, 'mcp.json') ? 'global' : 'project', options)
  const text = serializeMcpConfig(config)
  if (text.length > MAX_MCP_CONFIG_LENGTH) throw new Error(`MCP config must be at most ${MAX_MCP_CONFIG_LENGTH} characters`)
  atomicWriteConfigText(path, text)
}

/** One-use temp path prevents concurrent settings writes from colliding. */
function atomicWriteConfigText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`
  try {
    writeFileSync(tmp, text, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    renameSync(tmp, path)
  } catch (error) {
    try { unlinkSync(tmp) } catch { /* temp may not have been created */ }
    throw error
  }
}

export function writeMcpConfigFile(
  scope: 'global' | 'project',
  content: string,
  cwd: string | null,
  agentDir: string,
  projectTrusted = false
): McpConfigFileDTO | null {
  const path = configPath(scope, cwd, agentDir)
  if (!path) return null
  if (content.length > MAX_MCP_CONFIG_LENGTH) throw new Error(`MCP config must be at most ${MAX_MCP_CONFIG_LENGTH} characters`)
  const parsed = parseMcpConfigJson(content)
  if (!parsed.ok) throw new Error(`Invalid MCP config: ${parsed.error}`)
  validateForWrite(parsed.config, scope, { cwd, agentDir, projectTrusted })
  const text = content.trim() ? (content.endsWith('\n') ? content : `${content}\n`) : serializeMcpConfig({ mcpServers: {} })
  atomicWriteConfigText(path, text)
  return { path, exists: true, content: text, parseError: null }
}

function readConfigDocument(path: string): McpConfigDocument {
  try {
    const parsed = parseMcpConfigJson(readFileSync(path, 'utf8'))
    if (!parsed.ok) throw new Error(`Invalid MCP config: ${parsed.error}`)
    return parsed.config
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { mcpServers: {} }
    throw error
  }
}

function inferTransport(entry: McpServerEntry): McpServerDTO['transport'] {
  return typeof entry.url === 'string' ? 'http' : 'stdio'
}

function serverSummary(entry: McpServerEntry): string {
  if (typeof entry.url === 'string') {
    try {
      const url = new URL(entry.url)
      return `${url.origin}${url.pathname}`
    } catch {
      return '—'
    }
  }
  return [entry.command ?? '', ...(Array.isArray(entry.args) ? entry.args : [])].join(' ').trim() || '—'
}

export interface McpLiveServer {
  /** Native server spelling, including extension registrations without tools. */
  name?: string
  status?: McpRuntimeStatus
  tools: McpToolDTO[]
}

export interface McpRosterOptions {
  cwd: string | null
  agentDir: string
  projectTrusted: boolean
  live?: Map<string, McpLiveServer> | null
}

/** Mirror the built-in extension's precedence: trusted project replaces global by name. */
export function buildMcpRoster(options: McpRosterOptions): McpServerDTO[] {
  const { cwd, agentDir, projectTrusted, live } = options
  const merged = new Map<string, { entry: McpServerEntry; scope: 'global' | 'project'; path: string }>()
  for (const scope of ['global', 'project'] as const) {
    if (scope === 'project' && !projectTrusted) continue
    const file = readMcpConfigFile(scope, cwd, agentDir)
    if (!file || file.parseError) continue
    const parsed = parseMcpConfigJson(file.content)
    if (!parsed.ok) continue
    for (const [name, entry] of Object.entries(parsed.config.mcpServers)) {
      if (!MCP_SERVER_NAME.test(name) || !isRecord(entry)) continue
      merged.set(name, { entry, scope, path: file.path })
    }
  }
  const rows: McpServerDTO[] = [...merged].map(([name, { entry, scope, path }]) => {
    const available = live?.get(mcpServerKey(name))
    const disabled = entry.enabled === false
    return {
      name,
      transport: inferTransport(entry),
      summary: serverSummary(entry),
      disabled,
      scope,
      sourcePath: path,
      editable: true,
      status: disabled ? 'disabled' : (available?.status ?? 'configured'),
      toolCount: available ? available.tools.length : null,
      exposure: normalizeMcpExposure(entry.exposure) ?? 'codemode',
      entry
    }
  })
  // Pi extensions can register servers with no config file. Keep those read-only.
  const configuredKeys = new Set([...merged.keys()].map(mcpServerKey))
  for (const [name, available] of live ?? []) {
    if (configuredKeys.has(mcpServerKey(name))) continue
    rows.push({
      name: available.name ?? name,
      transport: 'registered',
      summary: '—',
      disabled: available.status === 'disabled',
      scope: 'external',
      editable: false,
      status: available.status ?? 'configured',
      toolCount: available.tools.length,
      exposure: 'codemode',
      entry: {}
    })
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name))
}

export function mcpServerDetail(name: string, tools: McpToolDTO[] = []): McpServerDetailDTO {
  return { name, tools, resources: [], prompts: [], cachedAt: null }
}

function writablePaths(cwd: string | null, agentDir: string): string[] {
  return [join(agentDir, 'mcp.json'), ...(cwd ? [join(cwd, PROJECT_CONFIG_NAME)] : [])]
}

/** Native MCP uses enabled:false. The winning trusted project definition is edited first. */
export function setMcpServerDisabled(
  name: string,
  disabled: boolean,
  options: { cwd: string | null; agentDir: string; projectTrusted: boolean }
): void {
  const paths = options.projectTrusted && options.cwd
    ? [join(options.cwd, PROJECT_CONFIG_NAME), join(options.agentDir, 'mcp.json')]
    : [join(options.agentDir, 'mcp.json')]
  for (const path of paths) {
    if (!existsSync(path)) continue
    const config = readConfigDocument(path)
    const current = config.mcpServers[name]
    if (!isRecord(current)) continue
    const entry = { ...current }
    if (disabled) entry.enabled = false
    else delete entry.enabled
    config.mcpServers[name] = entry
    writeConfigDocument(path, config, options)
    return
  }
  throw new Error(`Server "${name}" is not defined in an editable native MCP config file`)
}

export interface McpUpsertPayload {
  targetPath?: string
  scope?: 'global' | 'project'
  originalName?: string | null
  name: string
  entry: McpServerEntry
}

function resolveWritablePath(payload: { targetPath?: string; scope?: 'global' | 'project' }, cwd: string | null, agentDir: string): string {
  const paths = writablePaths(cwd, agentDir)
  if (payload.targetPath) {
    if (!paths.includes(payload.targetPath)) throw new Error('Refusing to write outside the MCP config files')
    return payload.targetPath
  }
  const path = configPath(payload.scope ?? 'global', cwd, agentDir)
  if (!path) throw new Error('No workspace is open for the project scope')
  return path
}

export function upsertMcpServerEntry(payload: McpUpsertPayload, options: McpWriteOptions): void {
  const path = resolveWritablePath(payload, options.cwd, options.agentDir)
  const name = payload.name.trim()
  if (!MCP_SERVER_NAME.test(name)) throw new Error('Invalid MCP server name')
  const config = readConfigDocument(path)
  if (payload.originalName && payload.originalName !== name) delete config.mcpServers[payload.originalName]
  config.mcpServers[name] = payload.entry
  writeConfigDocument(path, config, options)
}

export function deleteMcpServerEntry(path: string, name: string, options: McpWriteOptions): void {
  if (!writablePaths(options.cwd, options.agentDir).includes(path)) throw new Error('Refusing to write outside the MCP config files')
  const config = readConfigDocument(path)
  if (!(name in config.mcpServers)) return
  delete config.mcpServers[name]
  writeConfigDocument(path, config, options)
}
