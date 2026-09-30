/** Pure helpers for Pi's built-in MCP mcp.json shape. Files are written by main. */
import type { McpExposure } from '../../../shared/types'

export type McpTransportKind = 'stdio' | 'http'
export const MCP_DOCS_URL = 'https://pi.dev/docs/latest/mcp'
export const MCP_EXPOSURES: McpExposure[] = ['codemode', 'codemode-deferred', 'deferred', 'direct', 'hidden']

const SERVER_NAME_RE = /^[A-Za-z0-9_-]+$/
const NATIVE_FIELDS = new Set([
  'type', 'command', 'args', 'env', 'cwd', 'url', 'headers', 'oauth',
  'enabled', 'exposure', 'toolExposure', 'timeout'
])
const FORM_OWNED_KEYS = new Set([
  'type', 'command', 'args', 'env', 'cwd', 'url', 'headers', 'oauth',
  'enabled', 'exposure', 'toolExposure'
])

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
  exposure?: McpExposure
  toolExposure?: Record<string, McpExposure>
  timeout?: number
  [key: string]: unknown
}

export interface McpConfigDocument {
  mcpServers: Record<string, McpServerEntry>
  autoEnableCodemode?: boolean
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
  url: string
  headers: McpKeyValue[]
  oauthClientId: string
  oauthClientSecret: string
  oauthCallbackPort: string
  oauthCallbackUrl: string
  oauthScope: string
  enabled: boolean
  exposure: McpExposure
  toolExposure: McpKeyValue[]
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

function recordToRows(value: Record<string, string> | undefined): McpKeyValue[] {
  const rows = Object.entries(value ?? {}).map(([key, rowValue]) => ({ key, value: rowValue }))
  return rows.length > 0 ? rows : [{ key: '', value: '' }]
}

function rowsToRecord(rows: McpKeyValue[]): Record<string, string> | undefined {
  const entries = rows.map((row) => ({ key: row.key.trim(), value: row.value })).filter((row) => row.key)
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
  if (raw.mcpServers !== undefined && !isRecord(raw.mcpServers)) {
    return { ok: false, error: 'mcpServers must be an object' }
  }
  return { ok: true, config: { ...raw, mcpServers: (raw.mcpServers ?? {}) as Record<string, McpServerEntry> } }
}

export function serializeMcpConfig(config: McpConfigDocument): string {
  return `${JSON.stringify(config, null, 2)}\n`
}

export function inferMcpTransport(entry: McpServerEntry): McpTransportKind {
  return typeof entry.url === 'string' ? 'http' : 'stdio'
}

export function createEmptyMcpServerForm(): McpServerForm {
  return {
    name: '',
    transport: 'stdio',
    command: '',
    args: [''],
    env: [{ key: '', value: '' }],
    cwd: '',
    url: '',
    headers: [{ key: '', value: '' }],
    oauthClientId: '',
    oauthClientSecret: '',
    oauthCallbackPort: '',
    oauthCallbackUrl: '',
    oauthScope: '',
    enabled: true,
    exposure: 'codemode',
    toolExposure: [{ key: '', value: 'codemode' }],
    extras: {}
  }
}

export function serverEntryToForm(name: string, entry: McpServerEntry): McpServerForm {
  const extras: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(entry)) {
    if (!FORM_OWNED_KEYS.has(key) && value !== undefined) extras[key] = value
  }
  const oauth = isRecord(entry.oauth) ? entry.oauth : {}
  const args = Array.isArray(entry.args) ? entry.args.filter((arg): arg is string => typeof arg === 'string') : []
  return {
    name,
    originalName: name,
    transport: inferMcpTransport(entry),
    command: typeof entry.command === 'string' ? entry.command : '',
    args: args.length > 0 ? args : [''],
    env: recordToRows(toStringRecord(entry.env)),
    cwd: typeof entry.cwd === 'string' ? entry.cwd : '',
    url: typeof entry.url === 'string' ? entry.url : '',
    headers: recordToRows(toStringRecord(entry.headers)),
    oauthClientId: typeof oauth.clientId === 'string' ? oauth.clientId : '',
    oauthClientSecret: typeof oauth.clientSecret === 'string' ? oauth.clientSecret : '',
    oauthCallbackPort: typeof oauth.callbackPort === 'number' ? String(oauth.callbackPort) : '',
    oauthCallbackUrl: typeof oauth.callbackUrl === 'string' ? oauth.callbackUrl : '',
    oauthScope: typeof oauth.scope === 'string' ? oauth.scope : '',
    enabled: entry.enabled !== false,
    exposure: MCP_EXPOSURES.includes(entry.exposure as McpExposure) ? entry.exposure as McpExposure : 'codemode',
    toolExposure: recordToRows(toStringRecord(entry.toolExposure)),
    extras
  }
}

export function formToServerEntry(form: McpServerForm): McpServerEntry {
  const entry: McpServerEntry = { ...form.extras }
  for (const key of FORM_OWNED_KEYS) delete entry[key]
  if (form.transport === 'http') {
    entry.url = form.url.trim()
    const headers = rowsToRecord(form.headers)
    if (headers) entry.headers = headers
    const oauth: NonNullable<McpServerEntry['oauth']> = {}
    if (form.oauthClientId.trim()) oauth.clientId = form.oauthClientId.trim()
    if (form.oauthClientSecret.trim()) oauth.clientSecret = form.oauthClientSecret.trim()
    if (form.oauthCallbackPort.trim()) oauth.callbackPort = Number(form.oauthCallbackPort.trim())
    if (form.oauthCallbackUrl.trim()) oauth.callbackUrl = form.oauthCallbackUrl.trim()
    if (form.oauthScope.trim()) oauth.scope = form.oauthScope.trim()
    if (Object.keys(oauth).length > 0) entry.oauth = oauth
  } else {
    entry.command = form.command.trim()
    const args = form.args.map((arg) => arg.trim()).filter(Boolean)
    if (args.length > 0) entry.args = args
    const env = rowsToRecord(form.env)
    if (env) entry.env = env
    if (form.cwd.trim()) entry.cwd = form.cwd.trim()
  }
  if (!form.enabled) entry.enabled = false
  if (form.exposure !== 'codemode') entry.exposure = form.exposure
  const toolExposure = rowsToRecord(form.toolExposure) as Record<string, McpExposure> | undefined
  if (toolExposure) entry.toolExposure = toolExposure
  return entry
}

export function isValidMcpServerName(name: string): boolean {
  return SERVER_NAME_RE.test(name)
}

export type McpSnippetIssue = 'json' | 'shape' | 'multiple'

export function parseMcpServerSnippet(
  text: string
):
  | { ok: true; name: string; entry: McpServerEntry }
  | { ok: false; issue: McpSnippetIssue; detail?: string; count?: number } {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    return { ok: false, issue: 'json', detail: error instanceof Error ? error.message : String(error) }
  }
  if (!isRecord(raw)) return { ok: false, issue: 'shape' }
  if ('mcp-servers' in raw) return { ok: false, issue: 'shape' }
  const servers = raw.mcpServers ?? raw
  if (!isRecord(servers)) return { ok: false, issue: 'shape' }
  const entries = Object.entries(servers).filter(([, value]) => isRecord(value))
  if (entries.length === 0) return { ok: false, issue: 'shape' }
  if (entries.length > 1) return { ok: false, issue: 'multiple', count: entries.length }
  const first = entries[0]
  if (!first) return { ok: false, issue: 'shape' }
  const [name, entry] = first
  return { ok: true, name, entry: entry as McpServerEntry }
}

/** One concrete field the native SDK would reject or ignore, if any. */
export function unsupportedMcpField(entry: McpServerEntry): string | null {
  for (const key of Object.keys(entry)) if (!NATIVE_FIELDS.has(key)) return key
  return null
}

export function validateMcpServerEntry(name: string, entry: McpServerEntry): string | null {
  if (!SERVER_NAME_RE.test(name)) return `${name}.name`
  const unsupported = unsupportedMcpField(entry)
  if (unsupported) return `${name}.${unsupported}`
  if (entry.type !== undefined && !['stdio', 'http', 'streamable-http'].includes(String(entry.type))) return `${name}.type`
  if (entry.enabled !== undefined && typeof entry.enabled !== 'boolean') return `${name}.enabled`
  if (entry.exposure !== undefined && !MCP_EXPOSURES.includes(entry.exposure)) return `${name}.exposure`
  if (entry.toolExposure !== undefined) {
    if (!isRecord(entry.toolExposure) || Object.values(entry.toolExposure).some((value) => !MCP_EXPOSURES.includes(value as McpExposure))) {
      return `${name}.toolExposure`
    }
  }
  if (entry.timeout !== undefined && (typeof entry.timeout !== 'number' || !(entry.timeout > 0))) return `${name}.timeout`
  const http = typeof entry.url === 'string' && (entry.type === undefined || entry.type === 'http' || entry.type === 'streamable-http')
  const stdio = typeof entry.command === 'string' && (entry.type === undefined || entry.type === 'stdio')
  if (!http && !stdio) return `${name}.command/url`
  if (http) {
    if (!URL.canParse(entry.url!) || !/^https?:$/.test(new URL(entry.url!).protocol)) return `${name}.url`
    if (entry.headers !== undefined && (!isRecord(entry.headers) || Object.values(entry.headers).some((value) => typeof value !== 'string'))) return `${name}.headers`
    if (entry.oauth !== undefined) {
      if (!isRecord(entry.oauth)) return `${name}.oauth`
      const oauth = entry.oauth
      for (const [field, value] of Object.entries(oauth)) {
        if (!['clientId', 'clientSecret', 'callbackPort', 'callbackUrl', 'scope'].includes(field)) return `${name}.oauth.${field}`
        if (field !== 'callbackPort' && typeof value !== 'string') return `${name}.oauth.${field}`
      }
      const port = oauth.callbackPort
      if (port !== undefined && (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535)) return `${name}.oauth.callbackPort`
      if (typeof oauth.callbackUrl === 'string') {
        const url = URL.canParse(oauth.callbackUrl) ? new URL(oauth.callbackUrl) : null
        if (!url || url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.search || url.hash || (url.port && port !== undefined && Number(url.port) !== port)) {
          return `${name}.oauth.callbackUrl`
        }
      }
    }
  } else {
    if (entry.args !== undefined && (!Array.isArray(entry.args) || entry.args.some((value) => typeof value !== 'string'))) return `${name}.args`
    if (entry.env !== undefined && !isRecord(entry.env)) return `${name}.env`
    if (entry.env !== undefined && Object.values(entry.env ?? {}).some((value) => typeof value !== 'string')) return `${name}.env`
    if (entry.cwd !== undefined && typeof entry.cwd !== 'string') return `${name}.cwd`
  }
  return null
}

export function validateMcpServerForm(form: McpServerForm, existingNames: string[]): string[] {
  const issues: string[] = []
  const name = form.name.trim()
  if (!name) issues.push('name')
  else if (!isValidMcpServerName(name)) issues.push('nameInvalid')
  else if (existingNames.includes(name) && name !== form.originalName) issues.push('duplicate')
  if (form.transport === 'http') {
    const url = form.url.trim()
    if (!URL.canParse(url) || !/^https?:$/.test(new URL(url).protocol)) issues.push('url')
    if (form.oauthCallbackPort.trim()) {
      const port = Number(form.oauthCallbackPort.trim())
      if (!Number.isInteger(port) || port < 1 || port > 65535) issues.push('oauthPort')
    }
    if (form.oauthCallbackUrl.trim()) {
      const callback = URL.canParse(form.oauthCallbackUrl) ? new URL(form.oauthCallbackUrl) : null
      if (!callback || callback.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(callback.hostname) || callback.search || callback.hash) {
        issues.push('oauthCallback')
      }
    }
  } else if (!form.command.trim()) {
    issues.push('command')
  }
  if (form.toolExposure.some((row) => row.key.trim() && !MCP_EXPOSURES.includes(row.value as McpExposure))) issues.push('toolExposure')
  if (Object.keys(form.extras).some((key) => !NATIVE_FIELDS.has(key))) issues.push('legacyField')
  return issues
}

export function validateMcpConfigDocument(config: McpConfigDocument): string | null {
  if (config['mcp-servers'] !== undefined) return 'mcp-servers'
  for (const key of Object.keys(config)) {
    if (key !== 'mcpServers' && key !== 'autoEnableCodemode') return key
  }
  if (config.autoEnableCodemode !== undefined && typeof config.autoEnableCodemode !== 'boolean') return 'autoEnableCodemode'
  for (const [name, entry] of Object.entries(config.mcpServers)) {
    if (!SERVER_NAME_RE.test(name) || !isRecord(entry)) return name
    const issue = validateMcpServerEntry(name, entry)
    if (issue) return issue
  }
  return null
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
