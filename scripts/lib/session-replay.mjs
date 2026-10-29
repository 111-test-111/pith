/** Public Pi SDK stream recording/replay. Test support only; no provider I/O. */
import { readFile, writeFile } from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'

export const SESSION_REPLAY_FORMAT = 'pith-session-replay-v2'
const tokenPattern = /\{\{pith:(workspace|profile|sessions|tool:\d+)\}\}/g
const secretKey = /^(?:authorization|proxy-authorization|cookie|set-cookie|(?:(?:x[-_])?(?:goog[-_])?)api[-_]?key|(?:x[-_])?auth[-_]?token|access[-_]?token|refresh[-_]?token|client[-_]?secret|password|secret)$/i
// AgentLoopConfig is spread into stream options by the public SDK. These
// callbacks/identities are not JSON provider inputs; their effects ARE checked
// through the resulting context, tool events and durable transcript.
const callbackOptions = new Set(['signal', 'onPayload', 'onResponse', 'fetch', 'telemetryContext', 'model',
  'convertToLlm', 'transformContext', 'getApiKey', 'getSteeringMessages', 'getFollowUpMessages',
  'finishTurn', 'prepareRequest', 'prepareNextTurn', 'prepareNextTurnWithContext', 'beforeToolCall', 'afterToolCall', 'onProviderStreamEvent'])
const chunkTypes = new Set(['start', 'text_start', 'text_delta', 'text_end', 'thinking_start', 'thinking_delta', 'thinking_end', 'toolcall_start', 'toolcall_delta', 'toolcall_end', 'done', 'error'])
const jsonClone = value => JSON.parse(JSON.stringify(value))

/** pi-ai's public provider Tool surface. AgentTool's execute/label/sourceInfo
 * are runtime hooks, not payload fields. Retain every model-visible schema. */
export function providerReplayContext(context) {
  const { contextBudget: _diagnostic, ...result } = context
  result.messages = context.messages.map(message => message.role === 'system' ? {
    ...message,
    toolsAdded: message.toolsAdded?.map(({ name, description, parameters, constrainedSampling }) => ({
      name, description, parameters, ...(constrainedSampling === undefined ? {} : { constrainedSampling })
    }))
  } : message)
  return result
}

export class ReplayMismatch extends Error {
  constructor(message) { super(message); this.name = 'ReplayMismatch' }
}

function difference(actual, expected, path = '$') {
  if (isDeepStrictEqual(actual, expected)) return null
  if (actual && expected && typeof actual === 'object' && typeof expected === 'object' && Array.isArray(actual) === Array.isArray(expected)) {
    for (const key of [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort()) {
      if (!Object.hasOwn(actual, key) || !Object.hasOwn(expected, key)) return `${path}.${key}: ${Object.hasOwn(expected, key) ? 'missing' : 'unexpected'} field`
      const mismatch = difference(actual[key], expected[key], `${path}.${key}`)
      if (mismatch) return mismatch
    }
  }
  const preview = value => JSON.stringify(value)?.slice(0, 300) ?? String(value)
  return `${path}: expected ${preview(expected)}, received ${preview(actual)}`
}

export function assertReplayEqual(actual, expected, label) {
  const mismatch = difference(actual, expected)
  if (mismatch) throw new ReplayMismatch(`${label}: ${mismatch}`)
}

/** Only declared roots, message timestamps and tool correlation IDs vary.
 * Tool arguments, prose, schemas, usage, stop reasons and ordering stay exact.
 * Token-looking source text is rejected instead of becoming a wildcard. */
export function createReplayNormalizer({ workspace, profile, sessions, secretValues = [] } = {}) {
  const roots = Object.entries({ workspace, profile, sessions }).filter(([, path]) => path).sort((a, b) => b[1].length - a[1].length)
  const tools = new Map()
  const counters = { tool: 0 }
  const token = (kind, map, value) => {
    if (!map.has(value)) map.set(value, `{{pith:${kind}:${++counters[kind]}}}`)
    return map.get(value)
  }
  function walk(value, parent, key, redactCredentials, data = false) {
    // A schema property named "password" is still a schema. Credential
    // redaction is restricted to explicitly operational documents and scalars.
    if (redactCredentials && secretKey.test(key) && (typeof value === 'string' || value === null)) return '[redacted]'
    if (typeof value === 'string') {
      if (value.includes('{{pith:')) throw new Error('session-replay-reserved-token-in-source')
      if (!data && ((parent?.type === 'toolCall' && key === 'id') || (parent?.role === 'toolResult' && key === 'toolCallId') || (parent?.type?.startsWith('tool_execution_') && key === 'toolCallId'))) return token('tool', tools, value)
      let result = value
      for (const secret of secretValues) if (secret && result.includes(secret)) {
        if (!redactCredentials) throw new Error('session-replay-secret-in-model-visible-data')
        result = result.replaceAll(secret, '[redacted]')
      }
      for (const [name, root] of roots) result = result.replaceAll(root, (match, offset, source) => {
        const after = source[offset + root.length]
        return after === undefined || /[\/\\\s"'<>),;:#?]/.test(after) ? `{{pith:${name}}}` : match
      })
      // Separator spelling is non-semantic only in an explicitly rooted
      // Windows path (or present's canonical-path text), never arbitrary code.
      for (const [name, root] of roots) if (root.includes('\\')) {
        const marker = `{{pith:${name}}}`
        if (key === 'path' && result.startsWith(marker)) result = marker + result.slice(marker.length).replaceAll('\\', '/')
        if (result.startsWith(`Presented ${marker}`)) result = result.split('\n').map(line => line.startsWith(`Presented ${marker}`) ? line.replaceAll('\\', '/') : line).join('\n')
      }
      return result
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new Error('session-replay-non-finite-number')
      // Equal wall-clock milliseconds need not stay equal on another run.
      // Message order/correlation is checked separately, so time is zeroed.
      if (!data && key === 'timestamp' && ['system', 'user', 'assistant', 'toolResult', 'custom', 'compactionSummary', 'branchSummary', 'bashExecution'].includes(parent?.role)) return 0
      return value
    }
    if (value === null || typeof value === 'boolean') return value
    if (Array.isArray(value)) return value.map(item => walk(item, null, '', redactCredentials, data))
    if (typeof value === 'object') {
      const result = {}
      for (const field of Object.keys(value).sort()) if (value[field] !== undefined) Object.defineProperty(result, field, {
        value: walk(value[field], value, field, redactCredentials, data || ['arguments', 'args', 'details', 'metadata'].includes(field)), enumerable: true, configurable: true, writable: true
      })
      return result
    }
    throw new Error(`session-replay-non-json-value:${key}`)
  }
  function restore(value) {
    if (typeof value === 'string') {
      return value.replace(tokenPattern, (whole, name) => {
        if (name.startsWith('tool:')) {
          const id = `replay-${name.replace(':', '-')}`
          tools.set(id, whole)
          counters.tool = Math.max(counters.tool, Number(name.slice(5)))
          return id
        }
        const path = roots.find(([key]) => key === name)?.[1]
        if (!path) throw new Error(`session-replay-unbound-root:${name}`)
        return path
      })
    }
    if (Array.isArray(value)) return value.map(restore)
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, restore(child)]))
    return value
  }
  return { capture(value, { redactCredentials = false } = {}) { return walk(value, null, '', redactCredentials) }, restore }
}

function requestOf(model, context, options, normalizer) {
  const serializableOptions = {}
  for (const [key, value] of Object.entries(options ?? {})) {
    if (callbackOptions.has(key) || value === undefined) continue
    // The session identifier is a cache-affinity identity, not model content.
    serializableOptions[key] = key === 'sessionId' ? '{{session}}' : value
  }
  // contextBudget is app-authored diagnostic metadata; provider-visible
  // system messages, schemas and dialogue remain byte-for-byte semantic inputs.
  return { model: normalizer.capture(model, { redactCredentials: true }), context: normalizer.capture(providerReplayContext(context)),
    options: normalizer.capture(serializableOptions, { redactCredentials: true }) }
}

function failureOf(error, normalizer) {
  return normalizer.capture({ name: error instanceof Error ? error.name : 'Error', message: error instanceof Error ? error.message : String(error) }, { redactCredentials: true })
}

/** Wrap a caller-supplied stream; this function never selects a live provider.
 * Capture callbacks in order, including the final payload after replacement.
 * Every retained chunk is cloned immediately (providers mutate partials). */
export function createSessionRecorder({ stream, normalizer }) {
  const calls = []
  const pending = new Set()
  const streamFunction = async (model, context, options) => {
    const call = { request: requestOf(model, context, options, normalizer), exchanges: [] }
    calls.push(call)
    let aborted = false
    const noteAbort = () => {
      if (!aborted && options?.signal?.aborted) { call.exchanges.push({ kind: 'abort' }); aborted = true }
    }
    let source
    try {
      source = await stream(model, context, { ...options,
        onPayload: async (payload, requestModel) => {
          const before = normalizer.capture(payload, { redactCredentials: true })
          const replacement = await options?.onPayload?.(payload, requestModel)
          call.exchanges.push({ kind: 'payload', model: normalizer.capture(requestModel, { redactCredentials: true }), before, actual: normalizer.capture(replacement === undefined ? payload : replacement, { redactCredentials: true }) })
          return replacement
        },
        onResponse: async (response, requestModel) => {
          call.exchanges.push({ kind: 'response', model: normalizer.capture(requestModel, { redactCredentials: true }), response: normalizer.capture(response, { redactCredentials: true }) })
          await options?.onResponse?.(response, requestModel)
        }
      })
    } catch (error) {
      noteAbort()
      call.exchanges.push({ kind: 'throw', error: failureOf(error, normalizer) })
      call.thrown = true
      throw error
    }
    pending.add(call)
    return {
      async *[Symbol.asyncIterator]() {
        try {
          for await (const event of source) {
            if (event.type === 'error' && event.error.stopReason === 'aborted') noteAbort()
            call.exchanges.push({ kind: 'chunk', event: normalizer.capture(event) })
            yield event
          }
        } catch (error) {
          noteAbort()
          call.exchanges.push({ kind: 'throw', error: failureOf(error, normalizer) })
          call.thrown = true
          pending.delete(call)
          throw error
        }
      },
      async result() {
        const result = await source.result()
        call.result = normalizer.capture(result)
        pending.delete(call)
        return result
      }
    }
  }
  return { streamFunction, calls, assertComplete() {
    if (pending.size) throw new Error('session-replay-recording-incomplete-stream')
    validateCalls(calls)
  } }
}

function validateCalls(calls) {
  if (!Array.isArray(calls) || !calls.length || calls.length > 100) throw new Error('session-replay-invalid-call-count')
  calls.forEach((call, index) => {
    if (!call.request?.model || !Array.isArray(call.request.context?.messages) || !call.request.options || !Array.isArray(call.exchanges)) throw new Error(`session-replay-invalid-call:${index + 1}`)
    let terminal = null
    for (const exchange of call.exchanges) {
      if (terminal) throw new Error(`session-replay-exchange-after-terminal:${index + 1}`)
      if (exchange.kind === 'payload') {
        if (!Object.hasOwn(exchange, 'before') || !Object.hasOwn(exchange, 'actual') || !exchange.model) throw new Error('session-replay-invalid-payload')
      } else if (exchange.kind === 'response') {
        if (!Number.isInteger(exchange.response?.status) || !exchange.response?.headers || !exchange.model) throw new Error('session-replay-invalid-response')
      } else if (exchange.kind === 'abort') {
        // The driver must actually abort; this is not an automatic timer.
      } else if (exchange.kind === 'throw') {
        if (typeof exchange.error?.message !== 'string') throw new Error('session-replay-invalid-throw')
        terminal = exchange
      } else if (exchange.kind === 'chunk') {
        if (!chunkTypes.has(exchange.event?.type)) throw new Error('session-replay-invalid-chunk')
        if (exchange.event.type === 'done' || exchange.event.type === 'error') terminal = exchange
      } else throw new Error('session-replay-invalid-exchange-kind')
    }
    if (!terminal) throw new Error(`session-replay-missing-terminal:${index + 1}`)
    if (terminal.kind === 'throw') {
      if (!call.thrown || call.result) throw new Error('session-replay-invalid-thrown-settlement')
    } else {
      const final = terminal.event.type === 'done' ? terminal.event.message : terminal.event.error
      const reasons = terminal.event.type === 'done' ? ['stop', 'length', 'toolUse', 'deferred'] : ['aborted', 'error']
      if (final?.role !== 'assistant' || !Array.isArray(final.content) || !reasons.includes(final.stopReason) || terminal.event.reason !== final.stopReason ||
        typeof final.timestamp !== 'number' || !final.usage || typeof final.provider !== 'string' || typeof final.model !== 'string' || typeof final.api !== 'string') throw new Error('session-replay-invalid-terminal-message')
      const callIds = new Set()
      for (const block of final.content) if (block.type === 'toolCall') {
        if (!block.id || !block.name || !block.arguments || Array.isArray(block.arguments) || typeof block.arguments !== 'object' || callIds.has(block.id)) throw new Error('session-replay-invalid-tool-call')
        callIds.add(block.id)
      }
      if (!call.result || !isDeepStrictEqual(final, call.result)) throw new Error('session-replay-terminal-result-disagrees')
    }
  })
}

async function awaitAbort(signal) {
  if (!signal) throw new ReplayMismatch('Replay cancellation requires the SDK abort signal')
  if (signal.aborted) return
  await new Promise((resolve, reject) => {
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve() }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', done)
      reject(new ReplayMismatch('Replay cancellation driver did not abort within 5 seconds'))
    }, 5000)
    signal.addEventListener('abort', done, { once: true })
  })
}

/** Strict ordered replay. Mismatches are latched because the SDK converts
 * provider exceptions into assistant errors; teardown must still fail loud. */
export function createSessionReplay({ calls, normalizer }) {
  validateCalls(calls)
  let cursor = 0
  let failure = null
  const pending = new Set()
  const latch = error => { failure ??= error; return error }
  const streamFunction = async (model, context, options) => {
    if (failure) throw failure
    const index = cursor++
    const call = calls[index]
    if (!call) throw latch(new ReplayMismatch(`Replay exhausted at provider call ${index + 1}`))
    try { assertReplayEqual(requestOf(model, context, options, normalizer), call.request, `Provider call ${index + 1} request`) }
    catch (error) { throw latch(error) }
    const state = { exchanges: 0, result: false }
    // SDK correlation requires a stable timestamp throughout one response.
    // Give each replayed response a distinct value; comparison zeroes it.
    const reply = value => ({ ...normalizer.restore(jsonClone(value)), timestamp: 1_700_000_000_000 + index })
    pending.add(state)
    let iterated = false
    return {
      async *[Symbol.asyncIterator]() {
        if (iterated) throw latch(new ReplayMismatch(`Provider call ${index + 1} stream consumed twice`))
        iterated = true
        try {
          for (const exchange of call.exchanges) {
            state.exchanges++
            if (exchange.kind === 'payload') {
              const payload = normalizer.restore(jsonClone(exchange.before))
              const replacement = await options?.onPayload?.(payload, normalizer.restore(exchange.model))
              assertReplayEqual(normalizer.capture(replacement === undefined ? payload : replacement, { redactCredentials: true }), exchange.actual, `Provider call ${index + 1} final payload`)
            } else if (exchange.kind === 'response') {
              await options?.onResponse?.(normalizer.restore(exchange.response), normalizer.restore(exchange.model))
            } else if (exchange.kind === 'abort') await awaitAbort(options?.signal)
            else if (exchange.kind === 'chunk') {
              const event = normalizer.restore(jsonClone(exchange.event))
              for (const key of ['partial', 'message', 'error']) if (event[key]?.role === 'assistant') event[key] = reply(exchange.event[key])
              yield event
            }
            else if (exchange.kind === 'throw') {
              pending.delete(state)
              const recorded = normalizer.restore(exchange.error)
              const error = new Error(recorded.message)
              error.name = recorded.name
              throw error
            }
          }
        } catch (error) {
          if (error instanceof ReplayMismatch) latch(error)
          throw error
        }
      },
      async result() {
        if (state.exchanges !== call.exchanges.length || call.thrown) throw latch(new ReplayMismatch(`Provider call ${index + 1} result read before its terminal`))
        state.result = true
        pending.delete(state)
        return reply(call.result)
      }
    }
  }
  return { streamFunction, assertConsumed() {
    if (failure) throw failure
    if (cursor !== calls.length || pending.size) throw new ReplayMismatch(`Replay incomplete: consumed ${cursor}/${calls.length} calls; ${pending.size} streams unfinished`)
  } }
}

export async function loadSessionReplay(path) {
  const source = await readFile(path, 'utf8')
  if (Buffer.byteLength(source) > 20 * 1024 * 1024) throw new Error('session-replay-fixture-too-large')
  const fixture = JSON.parse(source)
  if (fixture.format !== SESSION_REPLAY_FORMAT || typeof fixture.scenario?.id !== 'string' || !fixture.expected) throw new Error('session-replay-invalid-fixture')
  validateCalls(fixture.calls)
  return fixture
}

/** Explicit output and exclusive create prevent check runs refreshing baselines. */
export async function saveSessionReplay(path, fixture, { overwrite = false } = {}) {
  if (fixture.format !== SESSION_REPLAY_FORMAT) throw new Error('session-replay-invalid-format')
  validateCalls(fixture.calls)
  await writeFile(path, `${JSON.stringify(fixture, null, 2)}\n`, { flag: overwrite ? 'w' : 'wx', mode: 0o600 })
}
