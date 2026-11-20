// local patch (pi-app): copied into the pinned pi-ai package by prepare-pi-sdk.
// Keep this module dependency-free so SDK catches and trajectory use one serializer.
const MAX_DEPTH = 8
const MAX_NODES = 16
const MAX_MESSAGE = 2048
const MAX_STACK = 4096
const CREDENTIAL_KEY = /^(?:api[_-]?key|authorization|access[_-]?token|refresh[_-]?token|token|password|secret|signature)$/i

function read(value, key) {
  try { return value?.[key] } catch { return undefined }
}

function redact(text) {
  return text.replace(/(?:https?|wss?|socks[45]?):\/\/[^\s<>"']+/gi, raw => {
    try {
      const url = new URL(raw)
      if (url.username || url.password) { url.username = '[redacted]'; url.password = '' }
      for (const key of [...url.searchParams.keys()]) if (CREDENTIAL_KEY.test(key)) url.searchParams.set(key, '[redacted]')
      return url.href
    } catch { return raw }
  }).replace(/\bBearer\s+[^\s,;"']+/gi, 'Bearer [redacted]')
    .replace(/\b((?:api[_-]?key|authorization|access[_-]?token|refresh[_-]?token|token|password|secret)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&]+)/gi, '$1[redacted]')
}

function text(value, limit, target) {
  if (value.length > limit) target.truncated = true
  return redact(value.slice(0, limit)) + (value.length > limit ? '… [truncated]' : '')
}

function capture(value, state, depth = 0) {
  if (depth >= MAX_DEPTH || state.nodes++ >= MAX_NODES) return { message: '[error depth/node limit]', truncated: true }
  const object = value !== null && (typeof value === 'object' || typeof value === 'function')
  if (object && state.seen.has(value)) return { message: '[circular or repeated error]', truncated: true }
  if (object) state.seen.add(value)
  const result = { message: '' }
  const message = read(value, 'message')
  result.message = text(typeof message === 'string' ? message
    : object ? '[unknown thrown object]' : String(value), MAX_MESSAGE, result)
  const name = read(value, 'name')
  result.name = typeof name === 'string' ? text(name, 200, result) : object ? 'Error' : 'ThrownValue'
  for (const key of ['stack', 'syscall', 'address']) {
    const field = read(value, key)
    if (typeof field === 'string') result[key] = text(field, key === 'stack' ? MAX_STACK : 200, result)
  }
  for (const key of ['code', 'errno']) {
    const field = read(value, key)
    if (typeof field === 'string') result[key] = text(field, 200, result)
    else if (typeof field === 'number' && Number.isFinite(field)) result[key] = field
  }
  const status = read(value, 'status') ?? read(value, 'statusCode')
  if (typeof status === 'number' && Number.isFinite(status)) result.status = status
  const port = read(value, 'port')
  if (typeof port === 'number' && Number.isFinite(port)) result.port = port
  const socket = read(value, 'socket')
  if (socket !== null && typeof socket === 'object') {
    const fields = {}
    for (const key of ['localAddress', 'remoteAddress', 'localPort', 'remotePort', 'bytesWritten', 'bytesRead']) {
      const field = read(socket, key)
      if (typeof field === 'string' && key.endsWith('Address')) fields[key] = text(field, 200, result)
      else if (typeof field === 'number' && Number.isFinite(field)) fields[key] = field
    }
    if (Object.keys(fields).length) result.socket = fields
  }
  const cause = read(value, 'cause')
  if (cause !== undefined) result.cause = capture(cause, state, depth + 1)
  const errors = read(value, 'errors')
  if (Array.isArray(errors)) {
    const length = read(errors, 'length')
    result.errors = []
    for (let i = 0; i < Math.min(length, 4); i++) result.errors.push(capture(read(errors, i), state, depth + 1))
    if (length > 4) result.truncated = true
  }
  return result
}

export function providerErrorDiagnostic(error) {
  let captured
  try { captured = capture(error, { nodes: 0, seen: new Set() }) }
  catch { captured = { message: '[error diagnostics unavailable]', truncated: true } }
  return { type: 'provider_error', timestamp: Date.now(), error: captured }
}

export function appendProviderErrorDiagnostic(message, error) {
  // A diagnostic failure must never replace the provider's original failure.
  try { message.diagnostics = [...(message.diagnostics ?? []), providerErrorDiagnostic(error)] } catch { /* best effort */ }
}
