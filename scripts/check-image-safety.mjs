/** Real SDK regression for corrupt codemode images and cold-session Continue. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { deflateSync } from 'node:zlib'
import { SessionManager, resizeImage, createCodemodeExtension } from '@earendil-works/pi-coding-agent'
import { createPlanFixture } from './lib/plan-fixture.mjs'

// This is the 70-byte image from the reported session. Its IDAT CRC and zlib
// checksum are wrong, although its PNG signature and IHDR are well formed.
const BAD_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='
function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const name = Buffer.from(type, 'ascii')
  const body = Buffer.concat([name, data])
  const out = Buffer.alloc(body.length + 8)
  out.writeUInt32BE(data.length, 0)
  body.copy(out, 4)
  out.writeUInt32BE(crc32(body), body.length + 4)
  return out
}
const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(1, 0)
ihdr.writeUInt32BE(1, 4)
ihdr[8] = 8
ihdr[9] = 6
const GOOD_PNG = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0, 255]))),
  chunk('IEND', Buffer.alloc(0))
]).toString('base64')

assert.equal(await resizeImage(Buffer.from(BAD_PNG, 'base64'), 'image/png'), null,
  'the actual corrupt PNG must fail the SDK decoder')
assert(await resizeImage(Buffer.from(GOOD_PNG, 'base64'), 'image/png'),
  'the control PNG must decode successfully')

let fixture
try {
  fixture = await createPlanFixture({ providerCallbacks: true, extensionFactories: [createCodemodeExtension()] })
  await fixture.managed.lifecyclePromise
  fixture.session.setActiveToolsByName([...fixture.session.getActiveToolNames(), 'codemode'])
  assert(fixture.session.getActiveToolNames().includes('codemode'), 'the isolated fixture explicitly activates its real SDK codemode extension')
  fixture.session.agent.state.model = { ...fixture.session.model, input: ['text', 'image'] }
  const first = fixture.requests.length + 1
  fixture.setRespond(index => index === first
    ? [{ type: 'toolCall', id: 'image-codemode', name: 'codemode', arguments: {
      code: `image('data:image/png;base64,${BAD_PNG}'); image('data:image/png;base64,${GOOD_PNG}'); text('images emitted');`
    } }]
    : [{ type: 'text', text: 'Finished after image output.' }])
  await fixture.session.prompt('Inspect both image outputs.')

  const freshResult = fixture.session.messages.find(message => message.role === 'toolResult' && message.toolCallId === 'image-codemode')
  assert(freshResult && !freshResult.isError, 'codemode completes normally')
  assert.equal(freshResult.content.filter(block => block.type === 'image').length, 1,
    'only the decodable image reaches persisted tool output')
  assert.equal(freshResult.content.find(block => block.type === 'image').data, GOOD_PNG,
    'valid image bytes stay unchanged')
  assert(freshResult.content.some(block => block.type === 'text' && block.text.includes('could not be decoded')),
    'the omitted image is visible as a bounded text note')
  const firstRequestAfterTool = fixture.requests.at(-1)
  assert(firstRequestAfterTool.messages.some(message => message.role === 'toolResult' &&
    message.toolCallId === 'image-codemode' && message.content.some(block => block.type === 'image' && block.data === GOOD_PNG)),
  'an image-capable model receives the valid image')
  assert(!firstRequestAfterTool.messages.some(message => Array.isArray(message.content) &&
    message.content.some(block => block.type === 'image' && block.data === BAD_PNG)),
  'the corrupt image never reaches the provider as an image block')

  // Simulate a historical 0.99.1 session whose invalid tool image was already
  // persisted, followed by the provider's 400 error. Reopen it like the app does.
  const model = fixture.session.model
  const timestamp = Date.now() + 1000
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
  const assistant = (content, stopReason, time, errorMessage) => ({ role: 'assistant', content,
    api: model.api, provider: model.provider, model: model.id, usage, stopReason, timestamp: time,
    ...(errorMessage ? { errorMessage } : {}) })
  fixture.session.sessionManager.appendMessage(assistant([
    { type: 'toolCall', id: 'historical-image', name: 'codemode', arguments: { code: 'image(...)' } }
  ], 'toolUse', timestamp))
  fixture.session.sessionManager.appendMessage({ role: 'toolResult', toolCallId: 'historical-image', toolName: 'codemode',
    content: [{ type: 'text', text: 'Old result' }, { type: 'image', data: BAD_PNG, mimeType: 'image/png' },
      { type: 'image', mimeType: 'image/png' }],
    isError: false, timestamp: timestamp + 1 })
  fixture.session.sessionManager.appendMessage(assistant([], 'error', timestamp + 2,
    '400: unsupported image in an earlier tool result'))
  const storedPath = fixture.managed.path
  const originalFile = await readFile(storedPath, 'utf8')
  assert(originalFile.includes(BAD_PNG), 'the old session still contains the original image')
  await fixture.app.disposeManaged(fixture.managed)
  const cold = await fixture.app.buildSession(SessionManager.open(storedPath))
  await cold.lifecyclePromise
  cold.session.agent.state.model = { ...cold.session.model, input: ['text', 'image'] }
  const requestCount = fixture.requests.length
  fixture.setRespond(() => [{ type: 'text', text: 'Continued successfully.' }])
  await fixture.app.continueMessage({ sessionPath: cold.path, timestamp: timestamp + 2 })
  assert.equal(fixture.requests.length, requestCount + 1, 'Continue makes exactly one provider request')
  const continued = fixture.requests.at(-1)
  const oldResult = continued.messages.find(message => message.role === 'toolResult' && message.toolCallId === 'historical-image')
  assert(oldResult, 'the historical result stays in the request as a paired tool result')
  assert.equal(oldResult.content.some(block => block.type === 'image'), false,
    'the existing corrupt image is removed from the outgoing request')
  assert.equal(oldResult.content.filter(block => block.type === 'text' && block.text.includes('could not be decoded')).length, 2,
    'missing image data is also handled without throwing')
  assert.equal((await readFile(storedPath, 'utf8')).includes(BAD_PNG), true,
    'Continue leaves the persisted transcript untouched')
  assert(cold.session.messages.some(message => message.role === 'assistant' &&
    message.content.some(block => block.type === 'text' && block.text === 'Continued successfully.')),
  'the simulated 400 frontier can complete after recovery')

  cold.session.agent.state.model = { ...cold.session.model, input: ['text'] }
  await cold.session.prompt('Summarize the earlier output without images.')
  const textOnly = fixture.requests.at(-1)
  const priorValidResult = textOnly.messages.find(message => message.role === 'toolResult' && message.toolCallId === 'image-codemode')
  assert(priorValidResult && !priorValidResult.content.some(block => block.type === 'image'),
    'a text-only model receives no historical image blocks')
  assert(priorValidResult.content.some(block => block.type === 'text' && block.text.includes('does not accept images')))
  assert((await readFile(storedPath, 'utf8')).includes(GOOD_PNG),
    'the valid historical image remains in the stored transcript')
  console.log('PASS corrupt codemode image rejected before persistence; valid image retained; cold historical session continues from a request-only repair')
} finally {
  await fixture?.close()
}
