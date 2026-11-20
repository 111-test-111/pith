/** Real SDK persistence/lifecycle with an offline auxiliary model. */
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { createPlanFixture } from './lib/plan-fixture.mjs'

const ENTRY = 'pith_session_naming_v1'
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
async function waitFor(check, description) {
  for (let i = 0; i < 400; i++) { if (check()) return; await pause(5) }
  throw new Error('Naming fixture timed out: ' + description)
}
const state = managed => managed.session.sessionManager.getEntries().filter(e => e.type === 'custom' && e.customType === ENTRY).at(-1)?.data
const receipts = managed => managed.session.sessionManager.getEntries().filter(e => e.type === 'usage' && e.kind === 'session-naming')
const usage = { input: 20, output: 6, cacheRead: 0, cacheWrite: 0, totalTokens: 26,
  cost: { input: .001, output: .002, cacheRead: 0, cacheWrite: 0, total: .003 } }
const reply = (text = '修复会话自动命名', stopReason = 'stop') => ({
  role: 'assistant', content: [{ type: 'text', text }], provider: 'fixture', model: 'namer',
  api: 'openai-completions', timestamp: Date.now(), stopReason, usage: structuredClone(usage)
})
let f
try {
  f = await createPlanFixture({ autoNameSessions: true })
  const { loadSettings } = await import(pathToFileURL(join(f.temporary, 'modules.mjs')).href)
  const settingsPath = join(f.userData, 'app-settings.json')
  // Old settings opt in by default and malformed selectors never survive a read.
  await writeFile(settingsPath, JSON.stringify({ cwd: f.project, folders: [f.project], sessionNamingModel: { providerId: '', modelId: 7 } }))
  assert.equal(loadSettings().autoNameSessions, true)
  assert.equal(loadSettings().sessionNamingModel, null)
  const runtime = await f.app.runtime()
  const main = f.session.model
  const namingModel = { ...main, id: 'namer', name: 'Fixture Naming' }
  runtime.getModel = (provider, id) => provider === main.provider ? [main, namingModel].find(m => m.id === id) : undefined
  const calls = []
  let respond = async () => reply()
  runtime.completeSimple = async (model, context, options) => {
    calls.push({ model, context, options })
    assert(f.events.some(event => event.type === 'message_end' && event.message?.role === 'user'), 'naming dispatch follows committed user input')
    return respond(options)
  }
  await f.managed.lifecyclePromise
  await pause(10)
  assert.equal(calls.length, 0, 'startup and an empty new chat never dispatch naming')
  await assert.rejects(f.app.setSessionNamingModel({ providerId: '', modelId: 'x' }))
  await assert.rejects(f.app.setSessionNamingModel({ providerId: 'missing', modelId: 'x' }))
  runtime.hasConfiguredAuth = () => false
  await assert.rejects(f.app.setSessionNamingModel({ providerId: main.provider, modelId: 'namer' }))
  runtime.hasConfiguredAuth = () => true
  await f.app.setSessionNamingModel({ providerId: main.provider, modelId: 'namer' })
  assert.deepEqual(loadSettings().sessionNamingModel, { providerId: main.provider, modelId: 'namer' })

  const sessionsDir = join(f.temporary, 'agent', 'sessions', 'naming-fixture')
  await mkdir(sessionsDir, { recursive: true })
  async function openCase(manager = SessionManager.create(f.project, sessionsDir)) {
    const managed = await f.app.buildSession(manager)
    // Deterministic retries/deadlines; production uses 1s/3s and 20s.
    managed.naming.options.retryDelaysMs = [1, 3]
    managed.naming.options.timeoutMs = 2000
    await managed.lifecyclePromise
    return managed
  }
  const messageText = '增加简洁有力的自动会话命名，处理重试和回退'
  const named = await openCase()
  const mainStream = named.session.agent.streamFunction
  let finishTurn
  const turnGate = new Promise(resolve => { finishTurn = resolve })
  named.session.agent.streamFunction = async (...args) => {
    const stream = await mainStream(...args)
    return { async *[Symbol.asyncIterator]() { for await (const event of stream) { await turnGate; yield event } }, result: () => stream.result() }
  }
  const attachedFile = join(f.project, 'secret.txt')
  await writeFile(attachedFile, 'ATTACHMENT_BODY_MUST_NOT_LEAK')
  assert.deepEqual(f.app.prompt({ sessionPath: named.path, text: messageText, images: [], files: [attachedFile] }), { accepted: true }, 'the production prompt admission starts the primary run')
  await waitFor(() => named.session.sessionManager.getBranch().some(e => e.type === 'message' && e.message.role === 'user'), 'committed first user')
  await waitFor(() => named.session.sessionName === '修复会话自动命名', 'first automatic title')
  assert(named.session.isStreaming, 'the title is published while the first response is still running')
  assert(!f.events.some(e => e.sessionPath === named.path && e.type === 'agent_settled'), 'naming does not wait for settlement')
  assert.equal(named.session.messages.filter(m => m.role === 'assistant').length, 0, 'the primary response is still blocked independently of naming')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].model.id, 'namer')
  assert.equal(named.session.model.id, main.id, 'the dedicated model never changes the chat model')
  assert.deepEqual(calls[0].context.tools, [])
  assert.equal(calls[0].options.toolChoice, 'none')
  assert.equal(calls[0].options.maxRetries, 0, 'only the app owns the bounded retry budget')
  assert(!JSON.stringify(calls[0].context).includes('ATTACHMENT_BODY_MUST_NOT_LEAK'))
  assert.deepEqual(JSON.parse(calls[0].context.messages[0].content), { user: messageText, assistant: '' })
  assert.equal(SessionManager.open(named.path).getSessionName(), '修复会话自动命名')
  const titleEvent = f.events.findLast(e => e.type === 'session_info_changed' && e.sessionPath === named.path)
  assert(titleEvent && titleEvent.eventSequence === undefined, 'background title changes are sequence-free sidebar metadata')
  assert.equal(receipts(named).length, 1)
  assert.equal(receipts(named)[0].model, 'namer')
  assert.equal((await f.app.listSessions()).find(s => s.path === named.path).label, '修复会话自动命名')
  finishTurn()
  await waitFor(() => f.events.some(e => e.sessionPath === named.path && e.type === 'agent_settled') && named.plan.workCount === 0, 'primary run settlement and admission release')
  named.session.agent.streamFunction = mainStream
  await named.session.prompt('继续完善测试')
  await pause(10)
  assert.equal(calls.length, 1, 'subsequent turns never rename an already named conversation')

  // A title event arriving during an older index read must refresh that read,
  // even when the renderer shares its still-in-flight listing promise.
  const refresh = f.app.sessionIndex.refresh.bind(f.app.sessionIndex)
  let indexRead, releaseIndex
  const readGate = new Promise(resolve => { indexRead = resolve })
  const releaseGate = new Promise(resolve => { releaseIndex = resolve })
  let refreshes = 0
  f.app.sessionIndex.refresh = async (...args) => {
    await refresh(...args)
    if (++refreshes === 1) { indexRead(); await releaseGate }
  }
  const oldList = f.app.listSessions()
  await readGate
  await f.app.renameSession(named.path, '手动标题刷新竞态')
  const titleList = f.app.listSessions()
  releaseIndex()
  for (const list of await Promise.all([oldList, titleList])) assert.equal(list.find(row => row.path === named.path).label, '手动标题刷新竞态')
  assert.equal(refreshes, 2)
  f.app.sessionIndex.refresh = refresh

  // A delayed naming response remains valid as assistant/tool messages arrive.
  // Resolve it from the SDK's early message_end listener to exercise the gap
  // before its awaited persistence subscriber and app commit checks finish.
  const progressing = await openCase()
  const progressFile = join(f.project, 'naming-progress.txt')
  await writeFile(progressFile, 'fixture naming progress\n')
  const firstProgressRequest = f.requests.length + 1
  f.setRespond(n => n === firstProgressRequest ? [
    { type: 'text', text: 'I will inspect the file and fix title refresh.' },
    { type: 'toolCall', id: 'naming-progress-read', name: 'read', arguments: { path: progressFile } }
  ] : [{ type: 'text', text: 'ok' }])
  const progressStream = progressing.session.agent.streamFunction
  let releaseProgress, finishNaming
  const progressGate = new Promise(resolve => { releaseProgress = resolve })
  const namingGate = new Promise(resolve => { finishNaming = resolve })
  progressing.session.agent.streamFunction = async (...args) => {
    const stream = await progressStream(...args)
    return { async *[Symbol.asyncIterator]() { for await (const event of stream) { await progressGate; yield event } }, result: () => stream.result() }
  }
  respond = () => namingGate
  const beforeProgress = calls.length
  const progressTurn = progressing.session.prompt('修复执行期间的标题刷新')
  await waitFor(() => calls.length === beforeProgress + 1, 'naming before assistant progress')
  const progressCall = calls.at(-1)
  assert.equal(JSON.parse(progressCall.context.messages[0].content).assistant, '')
  const offProgress = progressing.session.subscribe(event => {
    if (event.type === 'message_end' && event.message.role === 'toolResult') finishNaming(reply('执行中刷新会话标题'))
  })
  releaseProgress()
  await progressTurn
  offProgress()
  f.setRespond(() => [{ type: 'text', text: 'ok' }])
  await waitFor(() => progressing.session.sessionName === '执行中刷新会话标题', 'title after assistant progress')
  assert.equal(calls.length, beforeProgress + 1, 'new assistant entries do not cancel or restart the frozen naming job')
  assert.equal(receipts(progressing).length, 1)
  assert.equal(state(progressing).attempts, 1)
  const toolResult = progressing.session.sessionManager.getBranch().find(e => e.type === 'message' && e.message.role === 'toolResult')
  assert(toolResult && !toolResult.message.isError, 'parallel title/usage writes preserve the SDK tool-result commit')

  // Attachment-only first input names from the first committed assistant text,
  // even when that assistant calls a tool and the final reply is still pending.
  const textless = await openCase()
  const textlessStream = textless.session.agent.streamFunction
  const firstTextlessRequest = f.requests.length + 1
  f.setRespond(n => n === firstTextlessRequest ? [
    { type: 'text', text: 'Inspect the attached configuration and repair its naming rules.' },
    { type: 'toolCall', id: 'naming-textless-read', name: 'read', arguments: { path: progressFile } }
  ] : [{ type: 'text', text: 'ok' }])
  let releaseTextless, textlessRequests = 0
  const textlessGate = new Promise(resolve => { releaseTextless = resolve })
  textless.session.agent.streamFunction = async (...args) => {
    const stream = await textlessStream(...args)
    const finalReply = ++textlessRequests > 1
    return { async *[Symbol.asyncIterator]() { for await (const event of stream) { if (finalReply) await textlessGate; yield event } }, result: () => stream.result() }
  }
  respond = async () => reply('修复附件命名配置')
  const beforeTextless = calls.length
  const textlessTurn = textless.session.prompt('<file path="config.txt">ATTACHMENT_BODY_MUST_NOT_LEAK</file>')
  await waitFor(() => textless.session.sessionName === '修复附件命名配置', 'textless first input naming')
  assert(textless.session.isStreaming)
  assert.equal(calls.length, beforeTextless + 1)
  assert.deepEqual(JSON.parse(calls.at(-1).context.messages[0].content), { user: '', assistant: 'Inspect the attached configuration and repair its naming rules.' })
  releaseTextless()
  await textlessTurn
  f.setRespond(() => [{ type: 'text', text: 'ok' }])

  // Default model inheritance plus transport/format retries, with each receipt billed once.
  await f.app.setSessionNamingModel(null)
  assert.equal(loadSettings().sessionNamingModel, null)
  const retried = await openCase()
  let attempt = 0
  respond = async () => {
    attempt++
    if (attempt === 1) throw new Error('temporary provider failure')
    if (attempt === 2) return reply('This title is far too long and contains more than eight unnecessary words')
    return reply('Title: “修复自动命名重试”')
  }
  await retried.session.prompt(messageText)
  await waitFor(() => retried.session.sessionName === '修复自动命名重试', 'retried title')
  assert.equal(attempt, 3)
  assert.equal(calls.at(-1).model.id, main.id)
  assert.equal(state(retried).attempts, 3)
  assert.equal(receipts(retried).length, 2)
  assert.equal(retried.session.messages.filter(m => m.role === 'assistant').length, 1, 'auxiliary responses never enter model history')

  const failed = await openCase()
  respond = async () => reply('标题一\n标题二')
  const fallbackText = messageText.repeat(4)
  const beforeFailure = calls.length
  await failed.session.prompt(fallbackText)
  await waitFor(() => state(failed)?.status === 'failed', 'exhausted retries')
  assert.equal(calls.length - beforeFailure, 3)
  assert.equal(failed.session.sessionName, undefined)
  assert.equal((await f.app.listSessions()).find(s => s.path === failed.path).label, fallbackText.slice(0, 80))
  await failed.session.prompt('下一轮仍应保留摘要')
  await pause(10)
  assert.equal(calls.length - beforeFailure, 3, 'failure is terminal for the same first user entry')
  await f.app.disposeManaged(failed)
  const restoredFailure = await openCase(SessionManager.open(failed.path))
  await restoredFailure.session.prompt('重启也不应重新烧掉重试预算')
  await pause(10)
  assert.equal(calls.length - beforeFailure, 3, 'restart retains exhaustion')

  // A hard deadline works even if the transport ignores cancellation.
  const timedOut = await openCase()
  timedOut.naming.options.timeoutMs = 15
  respond = () => new Promise(() => {})
  const beforeTimeout = calls.length
  await timedOut.session.prompt('处理永不返回的命名请求')
  await waitFor(() => state(timedOut)?.status === 'failed', 'hard naming deadlines')
  assert.equal(calls.length - beforeTimeout, 3)
  assert.equal(timedOut.session.sessionName, undefined)
  assert(calls.slice(beforeTimeout).every(call => call.options.signal.aborted))

  const disabled = await openCase()
  f.app.setAutoNameSessions(false)
  assert.equal(loadSettings().autoNameSessions, false)
  const beforeDisabled = calls.length
  await disabled.session.prompt('关闭自动命名')
  await pause(10)
  assert.equal(calls.length, beforeDisabled)
  assert.equal(state(disabled), undefined)
  f.app.setAutoNameSessions(true)
  respond = async () => reply('恢复自动命名')
  await disabled.session.prompt('打开后完成一轮')
  await waitFor(() => disabled.session.sessionName === '恢复自动命名', 'enabled naming')

  const enabledLive = await openCase()
  const liveStream = enabledLive.session.agent.streamFunction
  let releaseLive
  const liveGate = new Promise(resolve => { releaseLive = resolve })
  enabledLive.session.agent.streamFunction = async (...args) => {
    const stream = await liveStream(...args)
    return { async *[Symbol.asyncIterator]() { for await (const event of stream) { await liveGate; yield event } }, result: () => stream.result() }
  }
  f.app.setAutoNameSessions(false)
  const beforeLive = calls.length
  const liveTurn = enabledLive.session.prompt('运行期间打开自动命名')
  await waitFor(() => enabledLive.session.sessionManager.getBranch().some(e => e.type === 'message' && e.message.role === 'user'), 'live committed input')
  await pause(10)
  assert.equal(calls.length, beforeLive)
  respond = async () => reply('运行期间启用命名')
  f.app.setAutoNameSessions(true)
  await waitFor(() => enabledLive.session.sessionName === '运行期间启用命名', 'enable naming during a live run')
  assert(enabledLive.session.isStreaming)
  releaseLive()
  await liveTurn

  async function pendingCase(text) {
    const managed = await openCase()
    let finish
    const pending = new Promise(resolve => { finish = resolve })
    const primaryStream = managed.session.agent.streamFunction
    let releasePrimary
    const primaryGate = new Promise(resolve => { releasePrimary = resolve })
    managed.session.agent.streamFunction = async (...args) => {
      const stream = await primaryStream(...args)
      return { async *[Symbol.asyncIterator]() { for await (const event of stream) { await primaryGate; yield event } }, result: () => stream.result() }
    }
    respond = () => pending
    const before = calls.length
    const primaryTurn = managed.session.prompt(text)
    await waitFor(() => calls.length === before + 1, 'pending naming request')
    releasePrimary()
    await primaryTurn
    managed.session.agent.streamFunction = primaryStream
    return { managed, finish, call: calls.at(-1) }
  }
  const manual = await pendingCase('手动改名优先')
  await f.app.renameSession(manual.managed.path, '手动标题')
  assert(manual.call.options.signal.aborted)
  manual.finish(reply('迟到自动标题'))
  await pause(10)
  assert.equal(manual.managed.session.sessionName, '手动标题')
  assert.equal(SessionManager.open(manual.managed.path).getSessionName(), '手动标题')
  assert.equal(receipts(manual.managed).length, 1, 'a late real receipt is still counted without applying its title')

  const cleared = await openCase()
  await f.app.renameSession(cleared.path, '')
  const beforeClear = calls.length
  await cleared.session.prompt('显式清除标题')
  await pause(10)
  assert.equal(calls.length, beforeClear, 'an explicit clear is a manual choice too')

  const background = await pendingCase('切换会话后标题仍属于原会话')
  const foreground = await openCase()
  background.finish(reply('后台会话正确命名'))
  await waitFor(() => background.managed.session.sessionName === '后台会话正确命名', 'background title')
  assert.equal(f.app.snapshot().sessionPath, foreground.path)
  assert.equal(foreground.session.sessionName, undefined)

  const stopped = await pendingCase('停止后不再自动重试')
  f.app.abort()
  stopped.finish(reply('停止后迟到标题'))
  await pause(10)
  assert(stopped.call.options.signal.aborted)
  assert.equal(stopped.managed.session.sessionName, undefined)
  assert.equal(receipts(stopped.managed).length, 1, 'Stop suppresses the late title but retains actual billed usage')
  const beforeStoppedResume = calls.length
  f.app.setAutoNameSessions(false)
  f.app.setAutoNameSessions(true)
  await pause(10)
  assert.equal(calls.length, beforeStoppedResume, 'changing settings does not resume a user-stopped naming job')

  const toggled = await pendingCase('关闭时取消正在命名的请求')
  f.app.setAutoNameSessions(false)
  toggled.finish(reply('不应采用的标题'))
  await pause(10)
  assert(toggled.call.options.signal.aborted)
  assert.equal(toggled.managed.session.sessionName, undefined)
  respond = async () => reply('恢复待完成命名')
  f.app.setAutoNameSessions(true)
  await waitFor(() => toggled.managed.session.sessionName === '恢复待完成命名', 'resume on re-enable')
  assert.equal(state(toggled.managed).attempts, 2, 'cancellation does not reset the retry budget')

  const stale = await pendingCase('分支切换必须拒绝迟到标题')
  stale.managed.session.sessionManager.resetLeaf()
  stale.managed.session.sessionManager.appendCustomEntry('pith_rewind_selection', { empty: true, target: null })
  const staleLeaf = stale.managed.session.sessionManager.getLeafId()
  stale.finish(reply('错误分支标题'))
  await pause(10)
  assert.equal(stale.managed.session.sessionName, undefined)
  assert.equal(stale.managed.session.sessionManager.getLeafId(), staleLeaf, 'a stale response appends no state or usage on the selected branch')

  const rewound = await pendingCase('恢复请求也必须核对原始首轮分支')
  const rewindManager = rewound.managed.session.sessionManager
  const firstUser = rewindManager.getBranch().find(e => e.type === 'message' && e.message.role === 'user')
  rewindManager.branch(firstUser.id)
  rewindManager.appendCustomEntry('pith_rewind_selection', { empty: false, target: firstUser.id })
  await f.app.disposeManaged(rewound.managed)
  rewound.finish(reply('已离开的分支标题'))
  respond = async () => reply('不应恢复过时命名')
  const beforeRewindResume = calls.length
  await openCase(SessionManager.open(rewound.managed.path))
  await pause(10)
  assert.equal(calls.length, beforeRewindResume, 'reopening the same first user on a changed branch does not resume the old job')

  const restarting = await pendingCase('重启后续用剩余命名次数')
  assert.equal(JSON.parse(restarting.call.context.messages[0].content).assistant, '')
  await f.app.disposeManaged(restarting.managed)
  assert(restarting.call.options.signal.aborted)
  restarting.finish(reply('旧实例迟到标题'))
  respond = async () => reply('重启恢复命名')
  const restored = await openCase(SessionManager.open(restarting.managed.path))
  await waitFor(() => restored.session.sessionName === '重启恢复命名', 'restart pending naming')
  assert.equal(state(restored).attempts, 2)
  assert.equal(JSON.parse(calls.at(-1).context.messages[0].content).assistant, '', 'restart retains user-only input despite later committed assistant replies')

  // Existing unnamed history is not named merely by opening it.
  f.app.setAutoNameSessions(false)
  const historical = await openCase()
  await historical.session.prompt('历史未命名会话')
  await f.app.disposeManaged(historical)
  f.app.setAutoNameSessions(true)
  const beforeHistory = calls.length
  const reopened = await openCase(SessionManager.open(historical.path))
  await pause(10)
  assert.equal(calls.length, beforeHistory)
  assert.equal(reopened.session.sessionName, undefined)
  const scheduledManager = SessionManager.create(f.project, sessionsDir)
  f.app.materializeSession(scheduledManager)
  scheduledManager.appendCustomEntry('pith_scheduled_task', { version: 1, taskId: 'fixture-task', runId: 'fixture-run', taskName: 'Fixture' })
  const scheduled = await f.app.buildSession(scheduledManager)
  await scheduled.lifecyclePromise
  await scheduled.session.prompt('定时任务会话不应触发命名')
  await pause(10)
  assert.equal(calls.length, beforeHistory, 'hidden scheduled-run conversations do not dispatch auxiliary naming')
  const errors = f.events.filter(event => event.type === 'pi_error')
  assert.equal(errors.length, 0, 'all naming failures stay out of chat errors')
  const persisted = await readFile(restored.path, 'utf8')
  assert(persisted.includes('session-naming') && persisted.includes('重启恢复命名'))

  const closing = await pendingCase('退出必须取消辅助命名')
  await f.app.dispose()
  assert(closing.call.options.signal.aborted)
  closing.finish(reply('退出后迟到标题'))
  await pause(10)
  assert.equal(SessionManager.open(closing.managed.path).getSessionName(), undefined)
  console.log('PASS session-naming: early committed-input timing, live title refresh, stable input, dedicated/inherited models, bounded silent retries/fallback, billing, manual priority, switching, Stop/disable, branch fencing, restart and shutdown')
} finally { await f?.close() }
