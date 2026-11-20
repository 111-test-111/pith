/** Offline provider adapters, real SDK retry/persistence and trajectory export. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { preparePiSdk } from './prepare-pi-sdk.mjs'
import { createPlanFixture } from './lib/plan-fixture.mjs'
import { providerErrorDiagnostic } from '../src/main/pi/provider-errors.mjs'

await preparePiSdk()
assert.equal(await preparePiSdk(), 0, 'preparation is idempotent')
const aiRoot = new URL('../node_modules/@earendil-works/pi-ai/dist/', import.meta.resolve('@earendil-works/pi-coding-agent'))
const api = async name => import(new URL(`api/${name}.js`, aiRoot).href)
const { isRetryableAssistantError } = await import(new URL('utils/retry.js', aiRoot).href)
const privateValue = 'private-cause-fixture-secret'
const fault = () => {
  const reset = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET', errno: -54, syscall: 'read' })
  const socket = Object.assign(new Error('other side closed', { cause: reset }), {
    name: 'SocketError', code: 'UND_ERR_SOCKET',
    socket: { localAddress: '127.0.0.1', localPort: 12345, remoteAddress: '203.0.113.10', remotePort: 443,
      bytesWritten: 321, bytesRead: 654, authorization: privateValue }
  })
  return Object.assign(new TypeError('terminated', { cause: socket }), {
    request: { authorization: privateValue }, response: { headers: { cookie: privateValue } }, apiKey: privateValue
  })
}
function verify(error) {
  assert.equal(error.name, 'TypeError')
  assert.equal(error.message, 'terminated')
  assert.equal(error.cause.name, 'SocketError')
  assert.equal(error.cause.code, 'UND_ERR_SOCKET')
  assert.equal(error.cause.cause.code, 'ECONNRESET')
  assert.equal(error.cause.cause.errno, -54)
  assert.equal(error.cause.cause.syscall, 'read')
  assert.deepEqual(error.cause.socket, { localAddress: '127.0.0.1', localPort: 12345,
    remoteAddress: '203.0.113.10', remotePort: 443, bytesWritten: 321, bytesRead: 654 })
  assert.match(error.stack, /TypeError: terminated/)
  assert(!JSON.stringify(error).includes(privateValue), 'operational objects are never copied')
}
verify(JSON.parse(JSON.stringify(providerErrorDiagnostic(fault()))).error)

const cyclic = new Error('cycle'); cyclic.cause = cyclic
assert.equal(providerErrorDiagnostic(cyclic).error.cause.truncated, true)
const aggregate = new AggregateError([Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }), fault()], 'connection failed')
assert.equal(providerErrorDiagnostic(aggregate).error.errors[0].code, 'ECONNREFUSED')
verify(providerErrorDiagnostic(aggregate).error.errors[1])
let deep = fault()
for (let i = 0; i < 100; i++) deep = new Error('x'.repeat(10000), { cause: deep })
const bounded = JSON.stringify(providerErrorDiagnostic(deep))
assert(bounded.length < 100000 && bounded.includes('truncated'), 'deep errors and stacks remain bounded')
const redacted = providerErrorDiagnostic(new Error(`See https://user:${privateValue}@example.com/error?api_key=${privateValue} Authorization: Bearer ${privateValue}`, {
  cause: new Error(`apiKey=${privateValue}`)
}))
assert(!JSON.stringify(redacted).includes(privateValue), 'diagnostic messages/stacks redact credentials')
const hostile = { message: 'safe', get cause() { throw new Error('getter failed') }, get stack() { throw new Error('getter failed') } }
assert.equal(providerErrorDiagnostic(hostile).error.message, 'safe')
assert.equal(providerErrorDiagnostic('string cause').error.message, 'string cause')
assert(!JSON.stringify(providerErrorDiagnostic(new Error(`wss://user:${privateValue}@example.com/error?token=${privateValue}`))).includes(privateValue))
console.log('PASS serializer: nested/aggregate causes, network fields, cycles, bounds, getters and credential redaction')

const event = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`
const start = event('message_start', { message: { id: 'msg_fixture', type: 'message', role: 'assistant',
  model: 'fixture', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } })
const thinking = start + event('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } })
  + event('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'Partial thinking before disconnect' } })
const completed = start + event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
  + event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Recovered' } })
  + event('content_block_stop', { index: 0 })
  + event('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } })
  + event('message_stop', {})
const responseThinking = event('response.created', { response: { id: 'resp_fixture' } })
  + event('response.output_item.added', { output_index: 0, item: { type: 'reasoning', id: 'rs_fixture', summary: [] } })
  + event('response.reasoning_summary_text.delta', { output_index: 0, delta: 'Partial thinking before disconnect' })
const chatPartial = `data: ${JSON.stringify({ id: 'chat_fixture', object: 'chat.completion.chunk', created: 1,
  model: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', content: 'Partial text before disconnect' }, finish_reason: null }] })}\n\n`
function disconnected(prefix) {
  let sent = false
  return new Response(new ReadableStream({ pull(controller) {
    if (sent) { controller.error(fault()); return }
    sent = true
    controller.enqueue(new TextEncoder().encode(prefix))
  } }), { status: 200, headers: { 'content-type': 'text/event-stream', 'x-request-id': 'fixture-disconnect' } })
}
const model = name => ({ id: 'fixture', name: 'fixture', api: name, provider: 'fixture',
  baseUrl: 'http://127.0.0.1:1', reasoning: true, input: ['text'], contextWindow: 200000, maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })
const context = { messages: [{ role: 'user', content: 'Diagnose a disconnect', timestamp: 1 }] }
const jwt = `fixture.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture' } })).toString('base64url')}.fixture`
const adapters = [
  ['anthropic-messages', thinking], ['openai-completions', chatPartial],
  ['openai-responses', responseThinking], ['openai-codex-responses', responseThinking]
]
for (const [name, prefix] of adapters) {
  const native = await api(name)
  let fetches = 0
  const stream = native.stream(model(name), context, { apiKey: name === 'openai-codex-responses' ? jwt : 'fixture',
    maxRetries: 0, transport: 'sse', timeoutMs: 1000, fetch: async () => { fetches++; return disconnected(prefix) } })
  const events = []
  for await (const value of stream) events.push(value)
  const output = await stream.result()
  assert.equal(fetches, 1, `${name}: fixture transport is used without provider retries`)
  assert.equal(output.stopReason, 'error', name)
  assert.equal(output.errorMessage, 'terminated', name)
  assert(output.content.length > 0, `${name}: the failure happens after streamed content`)
  assert(isRetryableAssistantError(output), `${name}: cause diagnostics do not alter retry classification`)
  verify(output.diagnostics.find(item => item.type === 'provider_error').error)
  assert.equal(events.at(-1).type, 'error')
  assert.deepEqual(events.at(-1).error.diagnostics, output.diagnostics)
  console.log(`PASS ${name}: real SDK stream adapter retains cause after partial output`)
}

const native = await api('anthropic-messages')
const fixture = await createPlanFixture()
try {
  await fixture.managed.lifecyclePromise
  fixture.session.settingsManager.applyOverrides({ retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } })
  let attempts = 0
  const requests = []
  fixture.managed.trajectory.previous = (_model, request, options) => {
    requests.push(structuredClone(request))
    return native.stream(model('anthropic-messages'), request, { ...options, apiKey: 'fixture', maxRetries: 0,
      fetch: async () => ++attempts === 1 ? disconnected(thinking)
        : new Response(completed, { headers: { 'content-type': 'text/event-stream' } }) })
  }
  await fixture.session.prompt('Retain the failure across an automatic retry')
  assert.equal(attempts, 2)
  assert(fixture.events.some(value => value.type === 'auto_retry_start'))
  assert(fixture.events.some(value => value.type === 'auto_retry_end' && value.success))
  assert.equal(fixture.events.filter(value => value.type === 'agent_settled').length, 1)
  assert(!requests[1].messages.some(message => message.errorMessage === 'terminated'), 'failed thinking stays out of retry context')
  const entries = (await readFile(fixture.managed.path, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  const failed = entries.find(value => value.message?.errorMessage === 'terminated')
  assert.equal(failed.message.content[0].type, 'thinking')
  verify(failed.message.diagnostics.find(item => item.type === 'provider_error').error)
  assert(entries.some(value => value.type === 'context_edit' && value.targetId === failed.id && value.replacement === null))
  const reloaded = fixture.manager.constructor.open(fixture.managed.path)
  verify(reloaded.getBranch().find(value => value.id === failed.id).message.diagnostics[0].error)
  verify(fixture.events.find(value => value.type === 'message_end' && value.message.errorMessage === 'terminated').message.diagnostics[0].error)
  await fixture.managed.trajectory.flush()
  const trace = await fixture.app.trajectoryPage({ sessionPath: fixture.managed.path, kind: 'request' })
  assert.deepEqual(trace.items.map(value => value.status), ['failed', 'completed'])
  const path = join(fixture.temporary, 'provider-error.json')
  await fixture.app.exportTrajectory(fixture.managed.path, trace.items[0].id, path)
  const exported = JSON.parse(await readFile(path, 'utf8'))
  assert.deepEqual(exported.documents.output.diagnostics, failed.message.diagnostics)
  verify(exported.documents.output.diagnostics[0].error)
  console.log('PASS durability: successful retry, JSONL reopen, IPC event and trajectory export preserve the failed cause')

  fixture.session.settingsManager.applyOverrides({ retry: { enabled: false } })
  for (const kind of ['construction', 'iteration']) {
    fixture.managed.trajectory.previous = () => {
      if (kind === 'construction') throw fault()
      return { async *[Symbol.asyncIterator]() { throw fault() }, result: async () => { throw fault() } }
    }
    await fixture.session.prompt(`Capture a raw ${kind} exception`)
    await fixture.managed.trajectory.flush()
    const page = await fixture.app.trajectoryPage({ sessionPath: fixture.managed.path, kind: 'request' })
    const record = page.items.at(-1)
    assert.equal(record.status, 'failed')
    assert(!record.captureError)
    await fixture.app.exportTrajectory(fixture.managed.path, record.id, path)
    const saved = JSON.parse(await readFile(path, 'utf8'))
    assert.equal(saved.documents.event.error, 'terminated')
    verify(saved.documents.event.diagnostics[0].error)
    console.log(`PASS ${kind}: exceptions outside a provider result retain cause in trajectory Event`)
  }
  fixture.managed.trajectory.previous = () => ({ async *[Symbol.asyncIterator]() {}, result: async () => { throw fault() } })
  const resultOnly = await fixture.session.agent.streamFunction(model('anthropic-messages'), context, {})
  await assert.rejects(resultOnly.result(), /terminated/)
  await fixture.managed.trajectory.flush()
  const page = await fixture.app.trajectoryPage({ sessionPath: fixture.managed.path, kind: 'request' })
  assert.equal(page.items.at(-1).status, 'failed')
  await fixture.app.exportTrajectory(fixture.managed.path, page.items.at(-1).id, path)
  verify(JSON.parse(await readFile(path, 'utf8')).documents.event.diagnostics[0].error)
  console.log('PASS result-only: rejected completions settle their record and preserve cause')
} finally { await fixture.close() }
