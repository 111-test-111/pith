/** Pi's native MCP configuration, shared by main validation and the settings editor. */
import type { McpConfigScope, McpExposure } from './types'

export const MCP_SERVER_NAME = /^[A-Za-z0-9_-]+$/
export const MCP_EXPOSURES: McpExposure[] = ['codemode', 'deferred', 'direct', 'hidden']
export const MCP_SERVER_FIELDS = new Set([
  'type', 'description', 'command', 'args', 'env', 'cwd', 'url', 'headers', 'oauth', 'auth',
  'enabled', 'exposure', 'toolExposure', 'timeout'
])
const OAUTH_FIELDS = new Set([
  'clientId', 'clientSecret', 'callbackPort', 'callbackUrl', 'scope', 'clientName', 'authServerMetadataUrl'
])
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

export interface McpServerEntry {
  type?: 'stdio' | 'http' | 'streamable-http'
  description?: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  url?: string
  headers?: Record<string, string>
  auth?: { provider: string }
  oauth?: {
    clientId?: string
    clientSecret?: string
    callbackPort?: number
    callbackUrl?: string
    scope?: string
    clientName?: string
    authServerMetadataUrl?: string
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

/** SDK namespaces normalize hyphens, while editable config names stay verbatim. */
export function mcpServerKey(name: string): string {
  return name.replace(/-/g, '_')
}

/** Accept old config files without offering the retired alias as a new choice. */
export function normalizeMcpExposure(value: unknown): McpExposure | undefined {
  if (value === 'codemode-deferred') return 'codemode'
  return MCP_EXPOSURES.includes(value as McpExposure) ? value as McpExposure : undefined
}

export function isSecureMcpUrl(value: string): boolean {
  const url = URL.canParse(value) ? new URL(value) : null
  return !!url && (url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringRecord(value: unknown): boolean {
  return isRecord(value) && Object.values(value).every(item => typeof item === 'string')
}

export interface McpServerIssue {
  code: 'invalidField' | 'invalidServer' | 'legacyField'
  field?: string
}

/** Data-only errors keep renderer prose localized and main writes equally strict. */
export function mcpServerIssues(name: string, value: unknown, scope: McpConfigScope): McpServerIssue[] {
  if (!MCP_SERVER_NAME.test(name) || !isRecord(value)) return [{ code: 'invalidServer' }]
  const issues: McpServerIssue[] = []
  const invalid = (field: string) => issues.push({ code: 'invalidField', field })
  for (const field of Object.keys(value)) {
    if (!MCP_SERVER_FIELDS.has(field)) issues.push({ code: 'legacyField', field })
  }
  if (value.type !== undefined && !['stdio', 'http', 'streamable-http'].includes(String(value.type))) invalid('type')
  if (value.description !== undefined && typeof value.description !== 'string') invalid('description')
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') invalid('enabled')
  if (value.exposure !== undefined && !normalizeMcpExposure(value.exposure)) invalid('exposure')
  if (value.toolExposure !== undefined && (!isRecord(value.toolExposure) || Object.values(value.toolExposure).some(item => !normalizeMcpExposure(item)))) invalid('toolExposure')
  if (value.timeout !== undefined && (typeof value.timeout !== 'number' || !(value.timeout > 0))) invalid('timeout')
  if (value.auth !== undefined) {
    if (scope === 'project' || !isRecord(value.auth) || typeof value.auth.provider !== 'string' || !value.auth.provider.trim() || Object.keys(value.auth).some(key => key !== 'provider')) invalid('auth')
  }
  const http = typeof value.url === 'string' && (value.type === undefined || value.type === 'http' || value.type === 'streamable-http')
  const stdio = typeof value.command === 'string' && (value.type === undefined || value.type === 'stdio')
  if (!http && !stdio) {
    issues.push({ code: 'invalidServer' })
    return issues
  }
  if (http) {
    if (!URL.canParse(value.url as string) || !/^https?:$/.test(new URL(value.url as string).protocol)) invalid('url')
    if (value.auth !== undefined && !isSecureMcpUrl(value.url as string)) invalid('auth')
    if (value.headers !== undefined && !isStringRecord(value.headers)) invalid('headers')
    if (value.oauth !== undefined) {
      if (!isRecord(value.oauth)) invalid('oauth')
      else {
        const oauth = value.oauth
        for (const [field, item] of Object.entries(oauth)) {
          if (!OAUTH_FIELDS.has(field) || (field !== 'callbackPort' && typeof item !== 'string')) invalid(`oauth.${field}`)
        }
        const port = oauth.callbackPort
        if (port !== undefined && (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535)) invalid('oauth.callbackPort')
        if (typeof oauth.callbackUrl === 'string') {
          const url = URL.canParse(oauth.callbackUrl) ? new URL(oauth.callbackUrl) : null
          if (!url || url.protocol !== 'http:' || !LOOPBACK_HOSTS.has(url.hostname) || url.search || url.hash || (url.port && port !== undefined && Number(url.port) !== port)) invalid('oauth.callbackUrl')
        }
        if (typeof oauth.clientName === 'string' && !oauth.clientName.trim()) invalid('oauth.clientName')
        if (typeof oauth.authServerMetadataUrl === 'string' && !isSecureMcpUrl(oauth.authServerMetadataUrl)) invalid('oauth.authServerMetadataUrl')
      }
    }
  } else {
    if (value.args !== undefined && (!Array.isArray(value.args) || value.args.some(arg => typeof arg !== 'string'))) invalid('args')
    if (value.env !== undefined && !isStringRecord(value.env)) invalid('env')
    if (value.cwd !== undefined && typeof value.cwd !== 'string') invalid('cwd')
  }
  return issues
}

/** Two distinct config names cannot share the same normalized SDK namespace. */
export function collidingMcpServerNames(names: Iterable<string>): string[] {
  const seen = new Map<string, string>()
  const collisions = new Set<string>()
  for (const name of names) {
    const key = mcpServerKey(name)
    const previous = seen.get(key)
    if (previous !== undefined && previous !== name) {
      collisions.add(previous)
      collisions.add(name)
    }
    seen.set(key, name)
  }
  return [...collisions]
}
