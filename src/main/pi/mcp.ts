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

/** Configuration files consumed by Pi's built-in MCP extension. */
export const MAX_MCP_CONFIG_LENGTH = 200_000
const PROJECT_CONFIG_NAME = join('.pi', 'mcp.json')
const SERVER_NAME = /^[A-Za-z0-9_-]+$/
const EXPOSURES = new Set(['codemode', 'codemode-deferred', 'deferred', 'direct', 'hidden'])
const SERVER_FIELDS = new Set([
  'type', 'command', 'args', 'env', 'cwd', 'url', 'headers', 'oauth',
  'enabled', 'exposure', 'toolExposure', 'timeout'
])
const OAUTH_FIELDS = new Set(['clientId', 'clientSecret', 'callbackPort', 'callbackUrl', 'scope'])

export interface McpServerEntry {
  type?: 'stdio' | 'http' | 'streamable-http'
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  url?: string
  headers?: Record<string, string>
  oauth?: {
    clientId?: string
    clientSecret?: string
    callbackPort?: number
    callbackUrl?: string
    scope?: string
  }
  enabled?: boolean
  exposure?: string
  toolExposure?: Record<string, string>
  timeout?: number
  [key: string]: unknown
}

export interface McpConfigDocument {
  mcpServers: Record<string, McpServerEntry>
  autoEnableCodemode?: boolean
  [key: string]: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === 'string')
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
    if (!SERVER_NAME.test(name) || !isRecord(value)) {
      issues.push({ scope, code: 'invalidServer', name })
      continue
    }
    for (const field of Object.keys(value)) {
      if (!SERVER_FIELDS.has(field)) issues.push({ scope, code: 'legacyField', name, field })
    }
    if (value.type !== undefined && !['stdio', 'http', 'streamable-http'].includes(String(value.type))) {
      issues.push({ scope, code: 'invalidField', name, field: 'type' })
    }
    if (value.enabled !== undefined && typeof value.enabled !== 'boolean') {
      issues.push({ scope, code: 'invalidField', name, field: 'enabled' })
    }
    if (value.exposure !== undefined && !EXPOSURES.has(String(value.exposure))) {
      issues.push({ scope, code: 'invalidField', name, field: 'exposure' })
    }
    if (value.toolExposure !== undefined) {
      if (!isRecord(value.toolExposure) || Object.values(value.toolExposure).some((item) => !EXPOSURES.has(String(item)))) {
        issues.push({ scope, code: 'invalidField', name, field: 'toolExposure' })
      }
    }
    if (value.timeout !== undefined && (typeof value.timeout !== 'number' || !(value.timeout > 0))) {
      issues.push({ scope, code: 'invalidField', name, field: 'timeout' })
    }
    const http = typeof value.url === 'string' && (value.type === undefined || value.type === 'http' || value.type === 'streamable-http')
    const stdio = typeof value.command === 'string' && (value.type === undefined || value.type === 'stdio')
    if (!http && !stdio) {
      issues.push({ scope, code: 'invalidServer', name })
      continue
    }
    if (http) {
      if (!URL.canParse(value.url!) || !/^https?:$/.test(new URL(value.url!).protocol)) {
        issues.push({ scope, code: 'invalidField', name, field: 'url' })
      }
      if (value.headers !== undefined && !isStringRecord(value.headers)) {
        issues.push({ scope, code: 'invalidField', name, field: 'headers' })
      }
      if (value.oauth !== undefined) {
        if (!isRecord(value.oauth)) {
          issues.push({ scope, code: 'invalidField', name, field: 'oauth' })
        } else {
          for (const [field, item] of Object.entries(value.oauth)) {
            if (!OAUTH_FIELDS.has(field) || (field !== 'callbackPort' && typeof item !== 'string')) {
              issues.push({ scope, code: 'invalidField', name, field: `oauth.${field}` })
            }
          }
          const port = value.oauth.callbackPort
          if (port !== undefined && (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535)) {
            issues.push({ scope, code: 'invalidField', name, field: 'oauth.callbackPort' })
          }
          const callback = value.oauth.callbackUrl
          if (typeof callback === 'string') {
            const url = URL.canParse(callback) ? new URL(callback) : null
            if (!url || url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.search || url.hash || (url.port && port !== undefined && Number(url.port) !== port)) {
              issues.push({ scope, code: 'invalidField', name, field: 'oauth.callbackUrl' })
            }
          }
        }
      }
    } else {
      if (value.args !== undefined && (!Array.isArray(value.args) || value.args.some((arg) => typeof arg !== 'string'))) {
        issues.push({ scope, code: 'invalidField', name, field: 'args' })
      }
      if (value.env !== undefined && !isStringRecord(value.env)) {
        issues.push({ scope, code: 'invalidField', name, field: 'env' })
      }
      if (value.cwd !== undefined && typeof value.cwd !== 'string') {
        issues.push({ scope, code: 'invalidField', name, field: 'cwd' })
      }
    }
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
  return issues
}

function validateForWrite(config: McpConfigDocument): void {
  const issue = documentIssues(config, 'global')[0]
  if (issue) {
    const target = issue.name ? `server "${issue.name}"` : 'config'
    throw new Error(`Invalid native MCP ${target}: ${issue.field ?? issue.code}`)
  }
}

function writeConfigDocument(path: string, config: McpConfigDocument): void {
  validateForWrite(config)
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
  agentDir: string
): McpConfigFileDTO | null {
  const path = configPath(scope, cwd, agentDir)
  if (!path) return null
  if (content.length > MAX_MCP_CONFIG_LENGTH) throw new Error(`MCP config must be at most ${MAX_MCP_CONFIG_LENGTH} characters`)
  const parsed = parseMcpConfigJson(content)
  if (!parsed.ok) throw new Error(`Invalid MCP config: ${parsed.error}`)
  validateForWrite(parsed.config)
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
      if (!SERVER_NAME.test(name) || !isRecord(entry)) continue
      merged.set(name, { entry, scope, path: file.path })
    }
  }
  const rows: McpServerDTO[] = [...merged].map(([name, { entry, scope, path }]) => {
    const available = live?.get(name)
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
      exposure: typeof entry.exposure === 'string' && EXPOSURES.has(entry.exposure) ? entry.exposure as McpServerDTO['exposure'] : 'codemode',
      entry
    }
  })
  // Pi extensions can register servers with no config file. Keep those read-only.
  for (const [name, available] of live ?? []) {
    if (merged.has(name)) continue
    rows.push({
      name,
      transport: 'registered',
      summary: '—',
      disabled: false,
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
    writeConfigDocument(path, config)
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

export function upsertMcpServerEntry(payload: McpUpsertPayload, options: { cwd: string | null; agentDir: string }): void {
  const path = resolveWritablePath(payload, options.cwd, options.agentDir)
  const name = payload.name.trim()
  if (!SERVER_NAME.test(name)) throw new Error('Invalid MCP server name')
  const config = readConfigDocument(path)
  if (payload.originalName && payload.originalName !== name) delete config.mcpServers[payload.originalName]
  config.mcpServers[name] = payload.entry
  writeConfigDocument(path, config)
}

export function deleteMcpServerEntry(path: string, name: string, options: { cwd: string | null; agentDir: string }): void {
  if (!writablePaths(options.cwd, options.agentDir).includes(path)) throw new Error('Refusing to write outside the MCP config files')
  const config = readConfigDocument(path)
  if (!(name in config.mcpServers)) return
  delete config.mcpServers[name]
  writeConfigDocument(path, config)
}
