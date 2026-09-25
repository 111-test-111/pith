import { DefaultPackageManager, SettingsManager, getAgentDir } from '@earendil-works/pi-coding-agent'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type {
  McpConfigFileDTO,
  McpRuntimeStatus,
  McpServerDTO,
  McpServerDetailDTO,
  McpStateDTO,
  McpStatusPushDTO
} from '../../shared/types'

/**
 * Settings → MCP backend. The pi-mcp-adapter extension owns MCP at runtime;
 * this module reads/writes its config files and, when the adapter package is
 * installed, reuses the adapter's OWN compiled config/metadata-cache modules
 * (dynamic import from the package's install path) so discovery, provenance
 * and cache-validity semantics never drift from what sessions actually run.
 *
 * Editable files: the pi-global `<agentDir>/mcp.json` and the project-shared
 * `<cwd>/.mcp.json`. Servers defined anywhere else (shared global files,
 * ancestors, host-config imports) appear in the merged roster as external;
 * their enable/disable goes through the adapter's project override layer.
 */

/** Cap so the settings editor cannot write unbounded MCP config text. */
export const MAX_MCP_CONFIG_LENGTH = 200_000

const PROJECT_CONFIG_NAME = '.mcp.json'
const PROJECT_PI_CONFIG_NAME = join('.pi', 'mcp.json')

// ---- config document model (plain JSON; the renderer validates before save) ----

export interface McpServerEntry {
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  socket?: string
  url?: string
  headers?: Record<string, string>
  auth?: 'oauth' | 'bearer' | false
  bearerToken?: string
  bearerTokenEnv?: string
  disabled?: boolean
  [key: string]: unknown
}

export interface McpConfigDocument {
  mcpServers: Record<string, McpServerEntry>
  imports?: unknown
  settings?: unknown
  [key: string]: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseMcpConfigJson(text: string): { ok: true; config: McpConfigDocument } | { ok: false; error: string } {
  if (!text.trim()) return { ok: true, config: { mcpServers: {} } }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  if (!isRecord(raw)) return { ok: false, error: 'root value must be an object' }
  const servers = raw.mcpServers ?? raw['mcp-servers']
  const mcpServers: Record<string, McpServerEntry> = {}
  if (isRecord(servers)) {
    for (const [name, entry] of Object.entries(servers)) {
      if (isRecord(entry)) mcpServers[name] = entry as McpServerEntry
    }
  }
  return { ok: true, config: { ...raw, mcpServers } }
}

export function serializeMcpConfig(config: McpConfigDocument): string {
  const { mcpServers, ...rest } = config
  const raw: Record<string, unknown> = { ...rest, mcpServers }
  delete raw['mcp-servers']
  return `${JSON.stringify(raw, null, 2)}\n`
}

// ---- file I/O ----

function configPath(scope: 'global' | 'project', cwd: string | null, agentDir: string): string | null {
  if (scope === 'global') return join(agentDir, 'mcp.json')
  if (!cwd) return null
  return join(cwd, PROJECT_CONFIG_NAME)
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

/** Atomic enough for a user-edited config: tmp file + rename in the same dir. */
export function writeMcpConfigFile(
  scope: 'global' | 'project',
  content: string,
  cwd: string | null,
  agentDir: string
): McpConfigFileDTO | null {
  const path = configPath(scope, cwd, agentDir)
  if (!path) return null
  const parsed = parseMcpConfigJson(content)
  if (!parsed.ok) throw new Error(`Invalid MCP config: ${parsed.error}`)
  if (content.length > MAX_MCP_CONFIG_LENGTH) {
    throw new Error(`MCP config must be at most ${MAX_MCP_CONFIG_LENGTH} characters`)
  }
  const text = content.trim() ? (content.endsWith('\n') ? content : `${content}\n`) : serializeMcpConfig({ mcpServers: {} })
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, path)
  return { path, exists: true, content: text, parseError: null }
}

// ---- adapter discovery + dynamic bridge ----

/** `npm:pi-mcp-adapter`, a pinned spec or a local checkout path all count. */
export function isPiMcpAdapterPackage(source: string): boolean {
  const trimmed = source.trim()
  const withoutNpm = trimmed.startsWith('npm:') ? trimmed.slice(4) : trimmed
  const name = withoutNpm.split('/')[withoutNpm.startsWith('@') ? 1 : 0] ?? withoutNpm
  const bare = name.split('@')[0] ?? name
  return bare === 'pi-mcp-adapter' || trimmed.endsWith('/pi-mcp-adapter')
}

export interface AdapterInstall {
  source: string
  installedPath: string
  version?: string
}

/** Find the installed pi-mcp-adapter package among the configured pi packages. */
export function findAdapterInstall(cwd: string | null, agentDir: string): AdapterInstall | null {
  try {
    const probe = cwd ?? agentDir
    const settingsManager = SettingsManager.create(probe, agentDir)
    const packageManager = new DefaultPackageManager({ cwd: probe, agentDir, settingsManager })
    for (const pkg of packageManager.listConfiguredPackages()) {
      if (!isPiMcpAdapterPackage(pkg.source) || !pkg.installedPath) continue
      let version: string | undefined
      try {
        const meta = JSON.parse(readFileSync(join(pkg.installedPath, 'package.json'), 'utf8')) as { version?: unknown }
        if (typeof meta.version === 'string') version = meta.version
      } catch {
        // version is cosmetic
      }
      return { source: pkg.source, installedPath: pkg.installedPath, version }
    }
  } catch {
    // no settings/packages readable — treated as not installed
  }
  return null
}

/** Minimal shape of the adapter's compiled `dist/config.js` we consume. */
interface AdapterConfigModule {
  loadMcpConfig: (overridePath?: string, cwd?: string) => { mcpServers: Record<string, McpServerEntry> }
  getServerProvenance: (
    overridePath?: string,
    cwd?: string
  ) => Map<string, { path: string; kind: 'user' | 'project' | 'import'; importKind?: string }>
  writeProjectServerDisabledOverride: (
    overridePath: string | undefined,
    cwd: string,
    serverName: string,
    disabled: boolean
  ) => { path: string; changed: boolean }
}

/** Minimal shape of the adapter's compiled `dist/metadata-cache.js`. */
interface AdapterCacheModule {
  loadMetadataCache: () => {
    version: number
    servers: Record<
      string,
      {
        configHash: string
        tools: { name: string; description?: string }[]
        resources: { uri: string; name: string; description?: string }[]
        prompts?: { name: string; description?: string }[]
        cachedAt: number
      }
    >
  } | null
  isServerCacheValid: (entry: { configHash: string; cachedAt: number }, definition: McpServerEntry) => boolean
}

interface AdapterModules {
  config: AdapterConfigModule
  cache: AdapterCacheModule
}

const adapterModulesCache = new Map<string, Promise<AdapterModules | null>>()

/**
 * Import the adapter's compiled modules from its install path. Both are plain
 * ESM listed in the package's exports map; a failure (older version, partial
 * install) degrades the state read to the app's own file parsing.
 */
export function loadAdapterModules(installedPath: string): Promise<AdapterModules | null> {
  let pending = adapterModulesCache.get(installedPath)
  if (!pending) {
    pending = (async () => {
      try {
        const [config, cache] = await Promise.all([
          import(pathToFileURL(join(installedPath, 'dist', 'config.js')).href),
          import(pathToFileURL(join(installedPath, 'dist', 'metadata-cache.js')).href)
        ])
        return { config: config as AdapterConfigModule, cache: cache as AdapterCacheModule }
      } catch {
        return null
      }
    })()
    adapterModulesCache.set(installedPath, pending)
  }
  return pending
}

// ---- merged server roster ----

function inferTransport(entry: McpServerEntry): McpServerDTO['transport'] {
  if (typeof entry.url === 'string' && entry.url.trim()) return 'http'
  if (typeof entry.socket === 'string' && entry.socket.trim()) return 'socket'
  return 'stdio'
}

function serverSummary(entry: McpServerEntry): string {
  if (typeof entry.url === 'string' && entry.url.trim()) return entry.url.trim()
  if (typeof entry.socket === 'string' && entry.socket.trim()) return entry.socket.trim()
  const command = typeof entry.command === 'string' ? entry.command.trim() : ''
  const args = Array.isArray(entry.args) ? entry.args.filter((arg): arg is string => typeof arg === 'string' && arg.length > 0) : []
  return [command, ...args].filter(Boolean).join(' ') || '—'
}

type MetadataCacheShape = ReturnType<AdapterCacheModule['loadMetadataCache']>

/** Raw cache read for when the adapter package is absent — the file is plain JSON. */
function readMetadataCacheFile(agentDir: string): MetadataCacheShape {
  try {
    const raw = JSON.parse(readFileSync(join(agentDir, 'mcp-cache.json'), 'utf8')) as NonNullable<MetadataCacheShape>
    return isRecord(raw) && isRecord(raw.servers) ? raw : null
  } catch {
    return null
  }
}

export interface McpRosterOptions {
  cwd: string | null
  agentDir: string
  adapter: AdapterInstall | null
  modules: AdapterModules | null
  /** Latest live snapshots by server name (from the adapter's event bus). */
  live: Map<string, { status: McpRuntimeStatus; toolCount: number; disabled: boolean }> | null
}

/**
 * Build the merged server roster. With the adapter bridged, the merge follows
 * its own source order (shared globals → pi global → ancestors → project files
 * → imports); without it, the two editable files merge with project winning.
 */
export function buildMcpRoster(options: McpRosterOptions): McpServerDTO[] {
  const { cwd, agentDir, modules, live } = options
  const globalPath = join(agentDir, 'mcp.json')
  const projectPath = cwd ? join(cwd, PROJECT_CONFIG_NAME) : null
  const projectPiPath = cwd ? join(cwd, PROJECT_PI_CONFIG_NAME) : null

  let merged: Record<string, McpServerEntry> = {}
  const provenance = new Map<string, { path: string; kind: string }>()
  if (modules) {
    try {
      merged = modules.config.loadMcpConfig(undefined, cwd ?? undefined).mcpServers ?? {}
      const prov = modules.config.getServerProvenance(undefined, cwd ?? undefined)
      for (const [name, entry] of prov) provenance.set(name, entry)
    } catch {
      merged = {}
    }
  } else {
    // Fallback: the two editable layers, project last so it wins.
    for (const file of [readMcpConfigFile('global', null, agentDir), cwd ? readMcpConfigFile('project', cwd, agentDir) : null]) {
      if (!file || file.parseError) continue
      const parsed = parseMcpConfigJson(file.content)
      if (!parsed.ok) continue
      for (const [name, entry] of Object.entries(parsed.config.mcpServers)) {
        merged[name] = entry
        provenance.set(name, { path: file.path, kind: file.path === globalPath ? 'user' : 'project' })
      }
    }
  }

  const cache = modules ? modules.cache.loadMetadataCache() : readMetadataCacheFile(agentDir)
  const cacheServers = cache?.servers ?? {}

  return Object.entries(merged)
    .map(([name, entry]): McpServerDTO => {
      const prov = provenance.get(name)
      const editable = prov?.path === globalPath || prov?.path === projectPath || prov?.path === projectPiPath
      const scope: McpServerDTO['scope'] =
        prov?.path === globalPath ? 'global' : editable ? 'project' : 'external'
      const disabled = entry.disabled === true
      const cacheEntry = cacheServers[name]
      let cacheValid = false
      if (cacheEntry && modules) {
        try {
          cacheValid = modules.cache.isServerCacheValid(cacheEntry, entry)
        } catch {
          cacheValid = false
        }
      } else if (cacheEntry) {
        cacheValid = true
      }
      const liveEntry = live?.get(name)
      const status: McpRuntimeStatus | null =
        liveEntry?.status ?? (disabled ? 'disabled' : cacheValid ? 'cached' : cacheEntry ? 'cached' : 'not-connected')
      return {
        name,
        transport: inferTransport(entry),
        summary: serverSummary(entry),
        disabled,
        scope,
        sourcePath: prov?.path,
        editable,
        status,
        toolCount: liveEntry?.toolCount ?? cacheEntry?.tools.length ?? null,
        cachedAt: cacheEntry?.cachedAt ?? null,
        entry: entry as Record<string, unknown>
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

// ---- per-server detail (metadata cache) ----

export function mcpServerDetail(name: string, agentDir: string, modules: AdapterModules | null): McpServerDetailDTO {
  const cache = modules ? modules.cache.loadMetadataCache() : readMetadataCacheFile(agentDir)
  const entry = cache?.servers?.[name]
  return {
    name,
    tools: (entry?.tools ?? []).map((tool) => ({ name: tool.name, description: tool.description })),
    resources: (entry?.resources ?? []).map((resource) => ({
      uri: resource.uri,
      name: resource.name,
      description: resource.description
    })),
    prompts: (entry?.prompts ?? []).map((prompt) => ({ name: prompt.name, description: prompt.description })),
    cachedAt: entry?.cachedAt ?? null
  }
}

// ---- enable / disable ----

/**
 * Flip one server's `disabled` flag. A server defined in an app-editable file
 * is edited there (the key is removed when enabling); an external server goes
 * through the adapter's override writer, which persists ONLY the flag in the
 * project's `.pi/mcp.json` and never copies credentials. Without the adapter
 * bridge, external servers cannot be toggled (the caller surfaces the error).
 */
export function setMcpServerDisabled(
  name: string,
  disabled: boolean,
  options: { cwd: string | null; agentDir: string; modules: AdapterModules | null }
): void {
  const { cwd, agentDir, modules } = options
  const editablePaths = [join(agentDir, 'mcp.json'), ...(cwd ? [join(cwd, PROJECT_CONFIG_NAME), join(cwd, PROJECT_PI_CONFIG_NAME)] : [])]
  for (const path of editablePaths) {
    if (!existsSync(path)) continue
    let text: string
    try {
      text = readFileSync(path, 'utf8')
    } catch {
      continue
    }
    const parsed = parseMcpConfigJson(text)
    if (!parsed.ok || !(name in parsed.config.mcpServers)) continue
    const servers = { ...parsed.config.mcpServers }
    const entry = { ...servers[name] }
    if (disabled) entry.disabled = true
    else delete entry.disabled
    servers[name] = entry
    const next = serializeMcpConfig({ ...parsed.config, mcpServers: servers })
    const tmp = `${path}.tmp-${process.pid}`
    writeFileSync(tmp, next, 'utf8')
    renameSync(tmp, path)
    return
  }
  if (modules && cwd) {
    modules.config.writeProjectServerDisabledOverride(undefined, cwd, name, disabled)
    return
  }
  throw new Error(`Server "${name}" is not defined in an editable config file`)
}

// ---- visual editor writes (upsert / delete one server in one file) ----

/** Every file the settings page may write, for path validation. */
function editableConfigPaths(cwd: string | null, agentDir: string): string[] {
  return [
    join(agentDir, 'mcp.json'),
    ...(cwd ? [join(cwd, PROJECT_CONFIG_NAME), join(cwd, PROJECT_PI_CONFIG_NAME)] : [])
  ]
}

export interface McpUpsertPayload {
  /** Existing server's defining file (from `McpServerDTO.sourcePath`). */
  targetPath?: string
  /** New server's target layer; resolves to that scope's default file. */
  scope?: 'global' | 'project'
  /** Set when a rename should drop the old key. */
  originalName?: string | null
  name: string
  entry: McpServerEntry
}

function resolveWritablePath(payload: { targetPath?: string; scope?: 'global' | 'project' }, cwd: string | null, agentDir: string): string {
  const paths = editableConfigPaths(cwd, agentDir)
  if (payload.targetPath) {
    if (!paths.includes(payload.targetPath)) throw new Error('Refusing to write outside the MCP config files')
    return payload.targetPath
  }
  const path = configPath(payload.scope ?? 'global', cwd, agentDir)
  if (!path) throw new Error('No workspace is open for the project scope')
  return path
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

function writeConfigDocument(path: string, config: McpConfigDocument): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, serializeMcpConfig(config), 'utf8')
  renameSync(tmp, path)
}

/** Insert/replace one server entry in its config file (visual editor save). */
export function upsertMcpServerEntry(payload: McpUpsertPayload, options: { cwd: string | null; agentDir: string }): void {
  const path = resolveWritablePath(payload, options.cwd, options.agentDir)
  const name = payload.name.trim()
  if (!name) throw new Error('Server name is required')
  if (!isRecord(payload.entry)) throw new Error('Server entry must be an object')
  const config = readConfigDocument(path)
  const servers = { ...config.mcpServers }
  if (payload.originalName && payload.originalName !== name) delete servers[payload.originalName]
  servers[name] = payload.entry
  writeConfigDocument(path, { ...config, mcpServers: servers })
}

/** Remove one server entry from its defining file (validated as editable). */
export function deleteMcpServerEntry(path: string, name: string, options: { cwd: string | null; agentDir: string }): void {
  if (!editableConfigPaths(options.cwd, options.agentDir).includes(path)) {
    throw new Error('Refusing to write outside the MCP config files')
  }
  const config = readConfigDocument(path)
  if (!(name in config.mcpServers)) return
  const servers = { ...config.mcpServers }
  delete servers[name]
  writeConfigDocument(path, { ...config, mcpServers: servers })
}
