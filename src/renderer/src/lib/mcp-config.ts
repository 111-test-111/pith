/** Pure helpers for Pi's built-in MCP mcp.json shape. Files are written by main. */
import type { McpConfigScope, McpExposure } from '../../../shared/types'
import { MCP_EXPOSURES, MCP_SERVER_NAME, MCP_SERVER_FIELDS, collidingMcpServerNames, isSecureMcpUrl, mcpServerIssues, mcpServerKey, normalizeMcpExposure, type McpServerEntry, type McpConfigDocument } from '../../../shared/mcp'
export { MCP_EXPOSURES } from '../../../shared/mcp'
export type { McpServerEntry, McpConfigDocument } from '../../../shared/mcp'

export type McpTransportKind = 'stdio' | 'http'
export const MCP_DOCS_URL = 'https://pi.dev/docs/latest/mcp'
const FORM_OWNED_KEYS = new Set([
  'type', 'description', 'command', 'args', 'env', 'cwd', 'url', 'headers', 'oauth', 'auth',
  'enabled', 'exposure', 'toolExposure'
])

export interface McpKeyValue {
  key: string
  value: string
}

export interface McpServerForm {
  name: string
  description: string
  originalName?: string
  transport: McpTransportKind
  command: string
  args: string[]
  env: McpKeyValue[]
  cwd: string
  url: string
  headers: McpKeyValue[]
  authProvider: string
  oauthClientName: string
  oauthAuthServerMetadataUrl: string
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
    description: '',
    transport: 'stdio',
    command: '',
    args: [''],
    env: [{ key: '', value: '' }],
    cwd: '',
    url: '',
    headers: [{ key: '', value: '' }],
    authProvider: '',
    oauthClientName: '',
    oauthAuthServerMetadataUrl: '',
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
    description: typeof entry.description === 'string' ? entry.description : '',
    originalName: name,
    transport: inferMcpTransport(entry),
    command: typeof entry.command === 'string' ? entry.command : '',
    args: args.length > 0 ? args : [''],
    env: recordToRows(toStringRecord(entry.env)),
    cwd: typeof entry.cwd === 'string' ? entry.cwd : '',
    url: typeof entry.url === 'string' ? entry.url : '',
    headers: recordToRows(toStringRecord(entry.headers)),
    authProvider: isRecord(entry.auth) && typeof entry.auth.provider === 'string' ? entry.auth.provider : '',
    oauthClientName: typeof oauth.clientName === 'string' ? oauth.clientName : '',
    oauthAuthServerMetadataUrl: typeof oauth.authServerMetadataUrl === 'string' ? oauth.authServerMetadataUrl : '',
    oauthClientId: typeof oauth.clientId === 'string' ? oauth.clientId : '',
    oauthClientSecret: typeof oauth.clientSecret === 'string' ? oauth.clientSecret : '',
    oauthCallbackPort: typeof oauth.callbackPort === 'number' ? String(oauth.callbackPort) : '',
    oauthCallbackUrl: typeof oauth.callbackUrl === 'string' ? oauth.callbackUrl : '',
    oauthScope: typeof oauth.scope === 'string' ? oauth.scope : '',
    enabled: entry.enabled !== false,
    exposure: normalizeMcpExposure(entry.exposure) ?? 'codemode',
    toolExposure: recordToRows(toStringRecord(entry.toolExposure)).map(row => ({ ...row, value: normalizeMcpExposure(row.value) ?? row.value })),
    extras
  }
}

export function formToServerEntry(form: McpServerForm): McpServerEntry {
  const entry: McpServerEntry = { ...form.extras }
  for (const key of FORM_OWNED_KEYS) delete entry[key]
  if (form.description.trim()) entry.description = form.description.trim()
  if (form.transport === 'http') {
    if (form.authProvider.trim()) entry.auth = { provider: form.authProvider.trim() }
    entry.url = form.url.trim()
    const headers = rowsToRecord(form.headers)
    if (headers) entry.headers = headers
    const oauth: NonNullable<McpServerEntry['oauth']> = {}
    if (form.oauthClientName.trim()) oauth.clientName = form.oauthClientName.trim()
    if (form.oauthAuthServerMetadataUrl.trim()) oauth.authServerMetadataUrl = form.oauthAuthServerMetadataUrl.trim()
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
  return MCP_SERVER_NAME.test(name)
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
  for (const key of Object.keys(entry)) if (!MCP_SERVER_FIELDS.has(key)) return key
  return null
}

export function validateMcpServerEntry(name: string, entry: McpServerEntry, scope: McpConfigScope = 'global'): string | null {
  const issue = mcpServerIssues(name, entry, scope)[0]
  return issue ? `${name}.${issue.field ?? 'command/url'}` : null
}

export function validateMcpServerForm(form: McpServerForm, existingNames: string[], scope: McpConfigScope = 'global'): string[] {
  const issues: string[] = []
  const name = form.name.trim()
  if (!name) issues.push('name')
  else if (!isValidMcpServerName(name)) issues.push('nameInvalid')
  else if (existingNames.some(existing => existing !== form.originalName && mcpServerKey(existing) === mcpServerKey(name))) issues.push('duplicate')
  if (form.transport === 'http') {
    const url = form.url.trim()
    if (!URL.canParse(url) || !/^https?:$/.test(new URL(url).protocol)) issues.push('url')
    if (form.authProvider.trim()) {
      if (scope === 'project') issues.push('authScope')
      if (!isSecureMcpUrl(url)) issues.push('authUrl')
    }
    if (form.oauthAuthServerMetadataUrl.trim() && !isSecureMcpUrl(form.oauthAuthServerMetadataUrl.trim())) issues.push('oauthMetadataUrl')
    if (form.oauthCallbackPort.trim()) {
      const port = Number(form.oauthCallbackPort.trim())
      if (!Number.isInteger(port) || port < 1 || port > 65535) issues.push('oauthPort')
    }
    if (form.oauthCallbackUrl.trim()) {
      const callback = URL.canParse(form.oauthCallbackUrl) ? new URL(form.oauthCallbackUrl) : null
      if (!callback || callback.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(callback.hostname) || callback.search || callback.hash || (callback.port && form.oauthCallbackPort.trim() && Number(callback.port) !== Number(form.oauthCallbackPort.trim()))) {
        issues.push('oauthCallback')
      }
    }
  } else if (!form.command.trim()) {
    issues.push('command')
  }
  if (form.toolExposure.some((row) => row.key.trim() && !MCP_EXPOSURES.includes(row.value as McpExposure))) issues.push('toolExposure')
  if (Object.keys(form.extras).some((key) => !MCP_SERVER_FIELDS.has(key))) issues.push('legacyField')
  return issues
}

export function validateMcpConfigDocument(config: McpConfigDocument, scope: McpConfigScope = 'global'): string | null {
  if (config['mcp-servers'] !== undefined) return 'mcp-servers'
  for (const key of Object.keys(config)) {
    if (key !== 'mcpServers' && key !== 'autoEnableCodemode') return key
  }
  if (config.autoEnableCodemode !== undefined && typeof config.autoEnableCodemode !== 'boolean') return 'autoEnableCodemode'
  const collision = collidingMcpServerNames(Object.keys(config.mcpServers))[0]
  if (collision) return `${collision}.name`
  for (const [name, entry] of Object.entries(config.mcpServers)) {
    if (!MCP_SERVER_NAME.test(name) || !isRecord(entry)) return name
    const issue = validateMcpServerEntry(name, entry, scope)
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
