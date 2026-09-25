/**
 * Pure MCP config helpers for Settings → MCP — parse/serialize the config
 * document, and convert one server entry to/from the visual editor form.
 * Form-owned keys are lifted into typed fields; everything else round-trips
 * through `extras` so the visual editor never silently drops adapter fields
 * (`lifecycle`, `includeTools`, `oauth`, …).
 *
 * File I/O lives in the main process (`src/main/pi/mcp.ts`); this module is
 * the renderer's side of the same document model.
 */

export type McpTransportKind = 'stdio' | 'http' | 'socket'
export type McpAuthKind = 'none' | 'bearer' | 'oauth'

export const MCP_ADAPTER_DOCS_URL = 'https://github.com/nicobailon/pi-mcp-adapter'

const SERVER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

const FORM_OWNED_KEYS = new Set([
  'command',
  'args',
  'env',
  'cwd',
  'url',
  'socket',
  'headers',
  'auth',
  'bearerToken',
  'disabled'
])

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

export interface McpKeyValue {
  key: string
  value: string
}

export interface McpServerForm {
  name: string
  originalName?: string
  transport: McpTransportKind
  command: string
  args: string[]
  env: McpKeyValue[]
  cwd: string
  socket: string
  url: string
  headers: McpKeyValue[]
  auth: McpAuthKind
  bearerToken: string
  disabled: boolean
  extras: Record<string, unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined
  const entries = Object.entries(value).filter((pair): pair is [string, string] => typeof pair[1] === 'string')
  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}

function toStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const items = value.filter((item): item is string => typeof item === 'string')
  return items.length > 0 ? items : undefined
}

function recordToRows(value: Record<string, string> | undefined): McpKeyValue[] {
  if (!value) return [{ key: '', value: '' }]
  const rows = Object.entries(value).map(([key, rowValue]) => ({ key, value: rowValue }))
  return rows.length > 0 ? rows : [{ key: '', value: '' }]
}

function rowsToRecord(rows: McpKeyValue[]): Record<string, string> | undefined {
  const entries = rows
    .map((row) => ({ key: row.key.trim(), value: row.value }))
    .filter((row) => row.key.length > 0)
  return entries.length > 0 ? Object.fromEntries(entries.map((row) => [row.key, row.value])) : undefined
}

export function parseMcpConfigJson(
  text: string
): { ok: true; config: McpConfigDocument } | { ok: false; error: string } {
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

export function inferMcpTransport(entry: McpServerEntry): McpTransportKind {
  if (typeof entry.url === 'string' && entry.url.length > 0) return 'http'
  if (typeof entry.socket === 'string' && entry.socket.length > 0) return 'socket'
  return 'stdio'
}

export function createEmptyMcpServerForm(): McpServerForm {
  return {
    name: '',
    transport: 'stdio',
    command: '',
    args: [''],
    env: [{ key: '', value: '' }],
    cwd: '',
    socket: '',
    url: '',
    headers: [{ key: '', value: '' }],
    auth: 'none',
    bearerToken: '',
    disabled: false,
    extras: {}
  }
}

function formAuthFromEntry(entry: McpServerEntry): McpAuthKind {
  if (entry.auth === 'oauth') return 'oauth'
  if (entry.auth === 'bearer') return 'bearer'
  return 'none'
}

export function serverEntryToForm(name: string, entry: McpServerEntry): McpServerForm {
  const extras: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(entry)) {
    if (!FORM_OWNED_KEYS.has(key) && value !== undefined) extras[key] = value
  }
  const args = toStringArray(entry.args) ?? []
  return {
    name,
    originalName: name,
    transport: inferMcpTransport(entry),
    command: typeof entry.command === 'string' ? entry.command : '',
    args: args.length > 0 ? args : [''],
    env: recordToRows(toStringRecord(entry.env)),
    cwd: typeof entry.cwd === 'string' ? entry.cwd : '',
    socket: typeof entry.socket === 'string' ? entry.socket : '',
    url: typeof entry.url === 'string' ? entry.url : '',
    headers: recordToRows(toStringRecord(entry.headers)),
    auth: formAuthFromEntry(entry),
    bearerToken: typeof entry.bearerToken === 'string' ? entry.bearerToken : '',
    disabled: entry.disabled === true,
    extras
  }
}

export function formToServerEntry(form: McpServerForm): McpServerEntry {
  const entry: McpServerEntry = { ...form.extras }
  for (const key of FORM_OWNED_KEYS) delete entry[key]
  if (form.transport === 'http') {
    const url = form.url.trim()
    if (url) entry.url = url
    const headers = rowsToRecord(form.headers)
    if (headers) entry.headers = headers
    if (form.auth === 'oauth') entry.auth = 'oauth'
    if (form.auth === 'bearer') entry.auth = 'bearer'
    const token = form.bearerToken.trim()
    if (token) entry.bearerToken = token
  } else if (form.transport === 'socket') {
    const socket = form.socket.trim()
    if (socket) entry.socket = socket
  } else {
    const command = form.command.trim()
    if (command) entry.command = command
    const args = form.args.map((arg) => arg.trim()).filter((arg) => arg.length > 0)
    if (args.length > 0) entry.args = args
    const env = rowsToRecord(form.env)
    if (env) entry.env = env
    const cwd = form.cwd.trim()
    if (cwd) entry.cwd = cwd
  }
  if (form.disabled) entry.disabled = true
  return entry
}

export function isValidMcpServerName(name: string): boolean {
  return SERVER_NAME_RE.test(name)
}

/**
 * Stable issue ids for the visual editor. Empty means the form can be saved.
 */
export function validateMcpServerForm(form: McpServerForm, existingNames: string[]): string[] {
  const issues: string[] = []
  const name = form.name.trim()
  if (!name) issues.push('name')
  else if (!isValidMcpServerName(name)) issues.push('nameInvalid')
  else if (existingNames.includes(name) && name !== form.originalName) issues.push('duplicate')
  if (form.transport === 'http') {
    if (!form.url.trim()) issues.push('url')
  } else if (form.transport === 'socket') {
    if (!form.socket.trim()) issues.push('socket')
  } else if (!form.command.trim()) {
    issues.push('command')
  }
  return issues
}

export function upsertMcpServer(config: McpConfigDocument, form: McpServerForm): McpConfigDocument {
  const name = form.name.trim()
  const servers = { ...config.mcpServers }
  if (form.originalName && form.originalName !== name) delete servers[form.originalName]
  servers[name] = formToServerEntry({ ...form, name })
  return { ...config, mcpServers: servers }
}

export function deleteMcpServer(config: McpConfigDocument, name: string): McpConfigDocument {
  const servers = { ...config.mcpServers }
  delete servers[name]
  return { ...config, mcpServers: servers }
}
