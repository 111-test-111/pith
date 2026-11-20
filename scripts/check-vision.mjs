/** Offline, real-SDK regression for the visual bridge's request/persistence boundary. */
import assert from 'node:assert/strict'
import { readFile, rm } from 'node:fs/promises'
import { Type } from 'typebox'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { createPlanFixture } from './lib/plan-fixture.mjs'

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=='
const image = { type: 'image', data: PNG, mimeType: 'image/png' }
const ENTRY = 'pith_vision_analysis_v1'
const usage = { input: 9, output: 4, cacheRead: 2, cacheWrite: 0, totalTokens: 15,
  cost: { input: .01, output: .02, cacheRead: .001, cacheWrite: 0, total: .031 } }
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
async function waitFor(check) {
  for (let i = 0; i < 300; i++) { if (check()) return; await pause(10) }
  throw new Error('Vision fixture did not reach the expected state')
}
const toolNames = context => {
  const names = new Set()
  for (const message of context.messages) if (message.role === 'system') {
    for (const tool of message.toolsRemoved ?? []) names.delete(tool.name)
    for (const tool of message.toolsAdded ?? []) names.add(tool.name)
  }
  return [...names]
}
const blocks = context => context.messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
const analyses = manager => manager.getBranch().filter(entry => entry.type === 'custom' && entry.customType === ENTRY)
const receipts = manager => manager.getEntries().filter(entry => entry.type === 'usage' && entry.kind === 'vision')
let synthetic = false
let f, reopened
let directory
const originalWindow = globalThis.window
try {
  f = await createPlanFixture({ keepFiles: true, extensionFactories: [{ name: 'vision-fixture', factory(pi) {
    pi.registerTool({ name: 'fixture_screenshot', label: 'Screenshot', description: 'Return a fixture screenshot.',
      parameters: Type.Object({}), async execute() { return { content: [{ type: 'text', text: 'Screenshot ready' }, image], details: {} } } })
    pi.on('context', event => synthetic ? { messages: [...event.messages, { role: 'user', content: 'Synthetic reminder', timestamp: Date.now() + 10_000 }] } : undefined)
  } }] })
  await f.managed.lifecyclePromise
  directory = f.temporary
  const runtime = await f.app.runtime()
  const main = f.session.model
  const native = { ...main, id: 'native', input: ['text', 'image'] }
  const vision = { ...native, id: 'vision', provider: 'vision-provider', name: 'Fixture Vision' }
  runtime.getModel = (provider, id) => [main, native, vision].find(model => model.provider === provider && model.id === id)
  runtime.getAvailableSnapshot = () => [main, native, vision]
  runtime.checkAuth = async () => ({ configured: true })
  const calls = []
  const reply = (text = 'Image shows a red pixel and readable fixture evidence.', stopReason = 'stop') => ({ role: 'assistant', content: [{ type: 'text', text }],
    provider: vision.provider, model: vision.id, api: vision.api, timestamp: Date.now(), stopReason, usage: structuredClone(usage), errorMessage: stopReason === 'error' ? 'Fixture provider failure' : undefined })
  let respond = async () => reply()
  runtime.completeSimple = async (model, context, options) => { calls.push({ model, context, options }); return respond(options) }
  const selection = { providerId: vision.provider, modelId: vision.id }

  assert.equal(f.app.visionModel(), null)
  assert(!f.session.getActiveToolNames().includes('vision_analyze'))
  const before = f.manager.getLeafId()
  const rejected = f.app.prompt({ text: '读图', images: [image], files: [] })
  assert.equal(rejected.accepted, false)
  assert.equal(rejected.visionError.code, 'not-configured')
  assert.equal(f.manager.getLeafId(), before, 'admission must not commit a user entry')
  globalThis.window = { pi: { prompt: payload => Promise.resolve(f.app.prompt(payload)) } }
  assert.equal(await f.store.sendPrompt({ text: '保留草稿', images: [image], files: [] }), false)
  assert(!f.store.getState().messages.some(message => message.__optimistic), 'rejected sends remove the local echo')
  assert.equal(f.store.getState().error.code, 'not-configured')
  const goalResult = await f.app.goalAction({ sessionPath: f.managed.path, expectedSeq: f.managed.goals.seq, goalId: f.managed.goals.snapshot?.id ?? null,
    action: 'create', objective: 'Read image', acceptance: 'Image described', limits: { tokenBudget: 1000, maxAutoRuns: 1 }, images: [image] })
  assert.equal(goalResult.ok, false)
  assert.equal(goalResult.visionError.code, 'not-configured')
  assert.equal(f.manager.getLeafId(), before, 'a rejected Goal must not store attachment state')

  await assert.rejects(f.app.setVisionModel({ providerId: main.provider, modelId: main.id }), error => error.dto?.code === 'model-text-only')
  await assert.rejects(f.app.setVisionModel({ providerId: 'missing', modelId: 'missing' }), error => error.dto?.code === 'model-missing')
  runtime.hasConfiguredAuth = () => false
  await assert.rejects(f.app.setVisionModel(selection), error => error.dto?.code === 'auth')
  runtime.hasConfiguredAuth = () => true
  await f.app.setVisionModel(selection)
  assert.deepEqual(f.app.visionModel(), selection)
  assert.deepEqual(JSON.parse(await readFile(f.userData + '/app-settings.json', 'utf8')).visionModel, selection)
  assert(f.session.getActiveToolNames().includes('vision_analyze'))
  assert.equal(f.session.getToolDefinition('vision_analyze').exposure, 'model-only')
  const staleTool = f.session.agent.state.tools.find(tool => tool.name === 'vision_analyze')

  await f.app.setModel(main.provider, native.id)
  assert(!f.session.getActiveToolNames().includes('vision_analyze'))
  await f.app.reloadSession(f.managed.path)
  assert(!f.session.getActiveToolNames().includes('vision_analyze'), 'SDK reload cannot activate it on a native image model')
  await assert.rejects(staleTool.execute('held', { prompt: 'Inspect' }), /not available/)
  await f.session.prompt('Native image request', { images: [image] })
  assert.equal(calls.length, 0)
  assert(blocks(f.requests.at(-1)).some(block => block.type === 'image' && block.data === PNG))
  assert(!toolNames(f.requests.at(-1)).includes('vision_analyze'))
  const nativeContext = { messages: [{ role: 'user', content: [image], timestamp: 1 }] }
  assert.equal(await f.managed.vision.transform(native, nativeContext), nativeContext, 'native request identity stays intact')

  await f.session.setModel(main) // Exercise the SDK extension event, not only app.setModel.
  assert(f.session.getActiveToolNames().includes('vision_analyze'))
  synthetic = true
  await f.session.prompt('请比较这两张截图中的错误', { images: [image, image] })
  synthetic = false
  assert.equal(calls.length, 1, 'a synthetic user reminder must not hide current attachments')
  assert.equal(calls[0].context.tools.length, 0, 'the helper has no tools or nested session')
  assert.equal(calls[0].options.toolChoice, 'none')
  assert(calls[0].context.messages[0].content[0].text.includes('请比较这两张截图中的错误'))
  assert.equal(calls[0].context.messages[0].content.filter(block => block.type === 'image').length, 2)
  assert(!blocks(f.requests.at(-1)).some(block => block.type === 'image'), 'a text-only provider sees no image blocks')
  assert(blocks(f.requests.at(-1)).some(block => block.text?.includes('red pixel')))
  assert.equal(blocks(f.requests.at(-1)).filter(block => block.text?.includes('red pixel')).length, 1, 'one batch result is not duplicated for every image')
  assert(toolNames(f.requests.at(-1)).includes('vision_analyze'))
  const saved = analyses(f.manager).at(-1).data
  const ref = saved.imageRefs[0]
  assert(saved.imageRefs.every(value => /^image:[\w-]+:\d+$/.test(value)))
  assert.equal(receipts(f.manager).length, 1)
  assert.deepEqual(receipts(f.manager)[0].usage, usage)
  const persistedUser = f.manager.getBranch().findLast(entry => entry.type === 'message' && entry.message.role === 'user')
  assert.equal(persistedUser.message.content.filter(block => block.type === 'image').length, 2)
  assert(persistedUser.message.content.filter(block => block.type === 'image').every(block => block.data === PNG))
  const exact = await f.managed.vision.ask(saved.prompt, saved.imageRefs)
  assert.equal(exact.id, saved.id)
  assert.equal(calls.length, 1)
  assert.equal(receipts(f.manager).length, 1, 'cache reuse has no synthetic billing')

  const followUp = f.requests.length + 1
  f.setRespond(index => index === followUp ? [{ type: 'toolCall', id: 'vision-detail', name: 'vision_analyze', arguments: { prompt: '请转录最下面的文字', image_refs: [ref] } }] : [{ type: 'text', text: 'Details received' }])
  await f.session.prompt('追问第一张图底部的文字')
  assert.equal(calls.length, 2)
  const toolResult = f.session.messages.find(message => message.role === 'toolResult' && message.toolCallId === 'vision-detail')
  assert.equal(toolResult.details.kind, 'pith-vision-v1')
  assert.equal(toolResult.details.usage, undefined, 'standalone usage is the only canonical receipt')
  assert.equal(receipts(f.manager).length, 2)
  assert.deepEqual(toolResult.details.imageRefs, [ref])
  await assert.rejects(f.managed.vision.ask('Read', ['image:missing:0']), error => error.dto?.code === 'unknown-image')

  assert.equal((await f.app.setSessionMode({ sessionPath: f.managed.path, mode: 'plan' })).ok, true)
  assert(f.session.getActiveToolNames().includes('vision_analyze'), 'the owned read-only tool remains available in Plan')
  const planRequest = f.requests.length + 1
  f.setRespond(index => index === planRequest ? [{ type: 'toolCall', id: 'vision-plan', name: 'vision_analyze', arguments: { prompt: saved.prompt, image_refs: saved.imageRefs } }] : [{ type: 'text', text: 'Visual inspection completed' }])
  await f.session.prompt('Inspect the pictures for planning')
  assert.equal(calls.length, 2, 'Plan can reuse factual evidence without another paid call')
  assert.equal((await f.app.setSessionMode({ sessionPath: f.managed.path, mode: 'normal' })).ok, true)

  // A compacted request still advertises bounded references from full ancestry.
  const compactContext = { messages: [{ role: 'user', content: 'Compare earlier screenshots', timestamp: Date.now() }] }
  const compactCopy = await f.managed.vision.transform(main, compactContext)
  assert(compactCopy.messages.some(message => message.role === 'system' && message.sections?.['pith.vision'].includes(ref)))
  assert.equal(compactContext.messages.length, 1)
  const leaf = f.manager.getLeafId()
  f.manager.branch(persistedUser.parentId)
  f.session.refreshContext()
  await assert.rejects(f.managed.vision.ask('Read', [ref]), error => error.dto?.code === 'unknown-image')
  f.manager.branch(leaf)
  f.session.refreshContext()

  const screenshotRequest = f.requests.length + 1
  f.setRespond(index => index === screenshotRequest ? [{ type: 'toolCall', id: 'screenshot', name: 'fixture_screenshot', arguments: {} }] : [{ type: 'text', text: 'Screenshot described' }])
  await f.session.prompt('Read a browser screenshot')
  assert.equal(calls.length, 3)
  const screenshot = f.session.messages.find(message => message.role === 'toolResult' && message.toolCallId === 'screenshot')
  assert.equal(screenshot.content.find(block => block.type === 'image').data, PNG)
  assert(!blocks(f.requests.at(-1)).some(block => block.type === 'image'))

  f.setRespond(() => [{ type: 'text', text: 'Done' }])
  respond = async () => reply('', 'error')
  const mainRequests = f.requests.length
  await f.session.prompt('Fail closed', { images: [image] })
  assert.equal(f.requests.length, mainRequests, 'a failed analysis must not send a blind primary request')
  assert.equal(f.store.getState().error.code, 'request-failed')
  assert.equal(receipts(f.manager).length, 4, 'a failed provider receipt remains billed once')
  respond = async () => reply('')
  await f.session.prompt('Empty analysis', { images: [image] })
  assert.equal(f.requests.length, mainRequests)
  assert.equal(f.store.getState().error.code, 'empty-result')
  const errorSnapshot = f.app.snapshot()
  f.store.clearError()
  f.store.applySnapshot(errorSnapshot)
  assert.equal(f.store.getState().error, null, 'a dismissed error stays dismissed across equal-revision snapshots')

  let reached, aborted = false
  respond = options => new Promise(resolve => { reached = options; options.signal.addEventListener('abort', () => { aborted = true; resolve(reply('', 'aborted')) }, { once: true }) })
  f.managed.vision.options.timeoutMs = () => 25
  await f.session.prompt('Timeout', { images: [image] })
  assert(aborted && reached.signal.aborted)
  assert.equal(f.store.getState().error.code, 'timeout')
  assert.equal(f.requests.length, mainRequests)
  aborted = false; reached = null
  f.managed.vision.options.timeoutMs = () => 120_000
  const stopped = f.session.prompt('Stop image analysis', { images: [image] })
  await waitFor(() => !!reached)
  assert(f.app.snapshot().vision.progress)
  f.app.abort()
  await stopped
  assert(aborted)
  assert.equal(f.managed.vision.currentProgress, null)
  assert.equal(f.requests.length, mainRequests)

  respond = async () => reply()
  const child = await f.app.createManagedSession(SessionManager.create(f.project, f.temporary + '/children'), {
    parentPath: f.managed.path, resource: { tools: ['read'], inheritContext: false }, model: main })
  await child.lifecyclePromise
  assert(!child.session.getActiveToolNames().includes('vision_analyze'))
  assert.throws(() => child.vision.preflight([image]), error => error.dto?.code === 'unavailable')
  const childAllowed = await f.app.createManagedSession(SessionManager.create(f.project, f.temporary + '/children'), {
    parentPath: f.managed.path, resource: { tools: ['read', 'vision_analyze'], inheritContext: false }, model: main })
  await childAllowed.lifecyclePromise
  assert(childAllowed.session.getActiveToolNames().includes('vision_analyze'))
  await childAllowed.session.prompt('Child may inspect an image', { images: [image] })
  assert.equal(receipts(childAllowed.session.sessionManager).length, 1)
  assert.equal(receipts(child.session.sessionManager).length, 0)

  // A queued image retains its own user intent and pixels until delivery.
  let queueRelease, queueStarted
  const queueGate = new Promise(resolve => { queueRelease = resolve })
  respond = async () => { queueStarted = true; await queueGate; return reply() }
  const queueTurn = f.session.prompt('First visual request', { images: [image] })
  await waitFor(() => queueStarted)
  assert.equal(f.app.prompt({ text: '排队图片的独立问题', images: [image], files: [], streamingBehavior: 'followUp' }).accepted, true)
  await waitFor(() => f.managed.queueMirror.followUp.length === 1)
  assert.equal(f.managed.queueMirror.followUp[0].images[0].data, PNG)
  queueRelease()
  await queueTurn
  await waitFor(() => f.session.isIdle && !f.managed.plan.workCount)
  assert(calls.at(-1).context.messages[0].content[0].text.includes('排队图片的独立问题'))
  assert.equal(f.managed.queueMirror.followUp.length, 0)

  respond = async () => reply()
  const requestsBeforeGoal = f.requests.length, callsBeforeGoal = calls.length
  const goal = f.managed.goals.snapshot
  const created = await f.app.goalAction({ sessionPath: f.managed.path, expectedSeq: f.managed.goals.seq, goalId: goal?.id ?? null,
    action: 'create', objective: 'Read the image within the shared allowance', acceptance: 'Image described', limits: { maxAutoRuns: 1, tokenBudget: 10 }, images: [image] })
  assert.equal(created.ok, true)
  await waitFor(() => f.managed.goals.snapshot?.reason === 'tokens' && f.session.isIdle && !f.managed.plan.workCount)
  assert.equal(calls.length, callsBeforeGoal + 1)
  assert.equal(f.requests.length, requestsBeforeGoal, 'vision spend stops the primary request at the shared cap')
  assert.equal(f.managed.goals.snapshot.tokens, 15)
  assert.equal(f.managed.goals.snapshot.billing.parentTokens, 15)

  const meta = f.events.filter(event => event.type === 'vision_update')
  assert(meta.length && meta.every(event => event.eventSequence === undefined))
  assert(!JSON.stringify(meta).includes(PNG))
  const snapshot = f.app.snapshot()
  f.store.applySnapshot(snapshot)
  f.store.dispatch({ type: 'vision_update', sessionPath: snapshot.sessionPath, vision: { revision: snapshot.vision.revision + 2, progress: { id: 'later', ...selection, imageCount: 1 } } })
  f.store.applySnapshot(snapshot)
  assert.equal(f.store.getState().vision.progress.id, 'later', 'an old IPC snapshot cannot erase newer progress')
  f.store.dispatch({ type: 'vision_update', sessionPath: 'other-session', vision: { revision: 1, progress: null } })
  assert.equal(f.store.getState().vision.progress.id, 'later', 'background metadata belongs to its own session')

  await f.app.setVisionModel(null)
  assert(!f.session.getActiveToolNames().includes('vision_analyze'))
  assert.equal(f.app.visionModel(), null)
  await f.app.setVisionModel(selection)
  const path = f.managed.path, temporary = f.temporary
  const recordCount = analyses(f.manager).length
  await f.close(); f = null
  reopened = await createPlanFixture({ temporaryRoot: temporary, reuseBundle: true, sessionPath: path })
  await reopened.managed.lifecyclePromise
  const coldRuntime = await reopened.app.runtime()
  coldRuntime.getModel = (provider, id) => provider === vision.provider && id === vision.id ? vision : main
  let coldCalls = 0
  coldRuntime.completeSimple = async () => { coldCalls++; return reply() }
  assert.deepEqual(reopened.app.visionModel(), selection)
  assert.equal(analyses(reopened.manager).length, recordCount)
  const coldRecord = analyses(reopened.manager).find(entry => entry.data.id === exact.id).data
  assert.equal((await reopened.managed.vision.ask(coldRecord.prompt, coldRecord.imageRefs)).id, exact.id)
  assert.equal(coldCalls, 0, 'a reopened selected branch restores cached analyses')
  const bytes = await readFile(path, 'utf8')
  assert(bytes.includes(PNG), 'JSONL keeps original image bytes through all request transformations')
  console.log('PASS vision: native bypass, saved selection, admission, automatic/tool images, historical references, branch cache, billing, abort/timeout, children and progress revisions')
} finally {
  globalThis.window = originalWindow
  await f?.close()
  await reopened?.close()
  if (directory) await rm(directory, { recursive: true, force: true })
}
