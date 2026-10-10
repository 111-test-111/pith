/** Subagent boundaries through real SessionManager/AgentSession, PiManager,
 * renderer store and Review. Temporary data, deterministic streams, no API calls. */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { Type } from 'typebox'
import { SessionManager, ModelRuntime, SettingsManager, createExtensionRuntime, createAgentSessionFromServices } from '@earendil-works/pi-coding-agent'

const temporary = await mkdtemp(join(tmpdir(), 'pith-subagent-integration-'))
const sessionsDir = join(temporary, 'sessions')
const sessions = []
const tick = () => new Promise(resolve => setImmediate(resolve))
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
const materialize = async manager => {
  await writeFile(manager.getSessionFile(), `${JSON.stringify(manager.getHeader())}\n`)
  manager.setSessionFile(manager.getSessionFile())
}
const text = value => [{ type: 'text', text: value }]
const call = (id, name, args) => ({ type: 'toolCall', id, name, arguments: args })
let timestamp = Date.now()
const assistant = content => ({ role: 'assistant', content, timestamp: ++timestamp, provider: 'fixture', model: 'fixture', api: 'openai-completions',
  stopReason: content.some(part => part.type === 'toolCall') ? 'toolUse' : 'stop',
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } })
const stream = final => ({ async *[Symbol.asyncIterator]() { yield { type: 'start', partial: { ...final, content: [] } }; yield { type: 'done', message: final } }, result: async () => final })
try {
  await mkdir(sessionsDir)
  const bundle = join(temporary, 'modules.mjs')
  await build({ stdin: { contents: `export { PiManager } from './src/main/pi/manager';
export { CheckoutCoordinator } from './src/main/rewind/coordinator';
export { loadSettings, saveSettings } from './src/main/settings';
export { SubagentRuntime, SubagentParentState } from './src/main/pi/subagents/runtime';
export * from './src/main/pi/subagents/protocol';
export { installSubagentResultHook } from './src/main/pi/subagents/tools';
export { createManagedBashTools } from './src/main/pi/bash-tools';
export { BashTaskManager } from './src/main/bash/manager';
export { TaskNotifications } from './src/main/pi/task-notifications';
export { PiStore } from './src/renderer/src/state/pi-store';
export { buildTurns, collectChangeScopes } from './src/renderer/src/lib/chat-turns';
export { extractTurnWrittenFiles, extractReviewTurns } from './src/renderer/src/lib/turn-written-files';`, resolveDir: resolve('.') },
    bundle: true, platform: 'node', format: 'esm', outfile: bundle,
    plugins: [{ name: 'isolated', setup(builder) {
      builder.onResolve({ filter: /^@earendil-works\/pi-coding-agent$/ }, () => ({ path: fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')), external: true }))
      // PiManager carries the browser service in its module graph, but this
      // fixture never connects a browser. Keep Playwright (and its optional
      // chromium-bidi graph) behind the same absolute external boundary used
      // by the other isolated main-process checks.
      builder.onResolve({ filter: /^playwright-core(\/|$)|^chromium-bidi(\/|$)/ }, (args) => ({
        path: fileURLToPath(import.meta.resolve(args.path)), external: true
      }))
      builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'fixture' }))
      builder.onResolve({ filter: /^proper-lockfile$|^@resvg\/resvg-js$/ }, args => ({ path: fileURLToPath(import.meta.resolve(args.path)), external: true }))
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `export const app={getPath(){return ${JSON.stringify(temporary)}}}; export const shell={};` }))
    } }] })
  const { PiManager, CheckoutCoordinator, loadSettings, saveSettings, SubagentRuntime, SubagentParentState, PiStore, buildTurns, collectChangeScopes, BashTaskManager, TaskNotifications, createManagedBashTools,
    extractTurnWrittenFiles, extractReviewTurns, installSubagentResultHook, currentDiskRun, SUBAGENT_RUN_TYPE, SUBAGENT_RESULT_TYPE } = await import(pathToFileURL(bundle))

  // Both independent clocks, both IPC arrival orders, and unrelated sessions.
  {
    const store = new PiStore()
    const run = { sessionId: 'child', runId: 'run', seq: 1, status: 'running', createdAt: new Date().toISOString() }
    const snapshot = (path, subagents = [], eventSequence = 10) => ({ sessionId: path, sessionPath: path, cwd: temporary, projectless: false,
      messages: [], model: null, thinkingLevel: 'off', isStreaming: false, eventSequence, subagents })
    store.applySnapshot(snapshot('a', [run]))
    store.applySnapshot(snapshot('b'))
    assert.deepEqual(store.getState().subagents, [], 'a roster must never leak into b')
    store.dispatch({ type: 'subagents_update', sessionPath: 'a', subagents: [{ ...run, status: 'completed', seq: 2 }] })
    store.applySnapshot(snapshot('a', [run]))
    assert.equal(store.getState().subagents[0].status, 'completed', 'parked sequence-free event survives snapshot replay')
    store.applySnapshot(snapshot('a', [run]))
    assert.equal(store.getState().subagents[0].status, 'completed', 'late snapshot cannot regress terminal state')
    store.applySnapshot(snapshot('a', [{ ...run, status: 'failed', seq: 3 }], 9))
    assert.equal(store.getState().subagents[0].status, 'failed', 'older transcript snapshot can still contain a newer roster')
    const original = new SubagentParentState('a')
    const seq = original.nextSeq()
    assert(new SubagentParentState('a').nextSeq() > seq, 'parent reconstruction must not reset roster ordering')
  }
  console.log('PASS: roster session isolation, parked events, snapshot races and parent reconstruction.')

  // The renderer's one typed action surface must route to the existing
  // runtime methods without creating a parallel control path. Main owns the
  // blank-message/open-parent guards before a runtime method can be reached.
  {
    const actionState = {}
    const actionSession = {}
    const routed = []
    const manager = Object.create(PiManager.prototype)
    Object.assign(manager, {
      sessions: new Map([['/parent.jsonl', { session: actionSession, subagents: actionState }]]),
      subagentRuntimeInstance: {
        steer: (state, sessionId, message, expectedRunId) => routed.push({ action: 'steer', state, sessionId, message, expectedRunId }),
        abort: (state, sessionId, expectedRunId) => routed.push({ action: 'abort', state, sessionId, expectedRunId }),
        resume: async (state, session, sessionId, message, options) => { routed.push({ action: 'resume', state, session, sessionId, message, options }) }
      }
    })
    await manager.subagentAction({ sessionPath: '/parent.jsonl', sessionId: 'child', expectedRunId: 'run-one', action: 'steer', message: 'redirect now' })
    await manager.subagentAction({ sessionPath: '/parent.jsonl', sessionId: 'child', expectedRunId: 'run-two', action: 'resume', message: 'continue now' })
    await manager.subagentAction({ sessionPath: '/parent.jsonl', sessionId: 'child', expectedRunId: 'run-three', action: 'abort' })
    assert.deepEqual(routed, [
      { action: 'steer', state: actionState, sessionId: 'child', message: 'redirect now', expectedRunId: 'run-one' },
      { action: 'resume', state: actionState, session: actionSession, sessionId: 'child', message: 'continue now', options: { expectedRunId: 'run-two' } },
      { action: 'abort', state: actionState, sessionId: 'child', expectedRunId: 'run-three' }
    ])
    await assert.rejects(manager.subagentAction({ sessionPath: '/parent.jsonl', sessionId: 'child', action: 'resume', message: 'missing identity' }), /run identity/)
    await assert.rejects(manager.subagentAction({ sessionPath: '/parent.jsonl', sessionId: 'child', expectedRunId: 'run-one', action: 'steer', message: '   ' }), /required/)
    await assert.rejects(manager.subagentAction({ sessionPath: '/closed.jsonl', sessionId: 'child', expectedRunId: 'run-one', action: 'resume', message: 'continue' }), /open session/)
  }
  console.log('PASS: panel Steer/Resume actions use the typed PiManager route and fail closed before runtime dispatch.')

  // One derivation for transcript + Review, across user-steer display groups.
  {
    const run = { sessionId: 'child', runId: 'r1', writtenFilesScope: 'run', writtenFiles: [{ filePath: join(temporary, 'one.ts'), displayPath: 'one.ts', added: 1, removed: 0, patch: '--- a/one.ts\n+++ b/one.ts\n@@ -0,0 +1 @@\n+one\n' }] }
    const completion = { role: 'custom', customType: 'subagent_completion', display: true, timestamp: 3, content: 'done', details: { subagent: run } }
    const rounds = [
      { ...assistant([call('agent-call', 'agent', {})]), timestamp: 2, changeScopeId: 'scope' },
      { ...assistant(text('after steer')), timestamp: 5, changeScopeId: 'scope' }
    ]
    const messages = [{ role: 'user', content: 'task', timestamp: 1 }, rounds[0], completion,
      { role: 'user', content: 'steer', timestamp: 4 }, rounds[1]]
    const scope = [...collectChangeScopes(buildTurns(messages)).values()][0]
    assert.equal(scope.completions.length, 1)
    assert.equal(scope.ownerKey, buildTurns(messages).at(-1).key)
    assert.equal(extractReviewTurns(messages, temporary)[0].files.length, 1, 'Review consumes the same completion evidence')
    const failed = { role: 'toolResult', toolName: 'agent', toolCallId: 'agent-call', isError: true, timestamp: 3, content: [], details: { subagent: run } }
    assert.equal(extractTurnWrittenFiles(rounds, new Map([['agent-call', failed]]), temporary, [completion])[0].added, 1,
      'failed result preserves writes; duplicate tool/notice delivery counts once')
    const resumed = { ...completion, timestamp: 6, details: { subagent: { ...run, runId: 'r2' } } }
    assert.equal(extractTurnWrittenFiles(rounds, new Map(), temporary, [completion, resumed])[0].added, 2, 'distinct resumes contribute their own writes')
    const legacy = { ...run, writtenFilesScope: undefined }
    assert.equal(extractTurnWrittenFiles(rounds, new Map(), temporary,
      [{ ...completion, details: { subagent: legacy } }, { ...resumed, details: { subagent: legacy } }])[0].added, 1, 'legacy cumulative results remain deduplicated')
  }
  console.log('PASS: completion notices, cumulative scope ownership, Review, failure evidence and run/legacy deduplication.')

  const parent = SessionManager.create(temporary, sessionsDir); await materialize(parent)
  const profile = { name: 'worker', displayName: 'Worker', description: 'test', systemPrompt: 'test', tools: ['write'], enabled: true, inheritContext: false, runInBackground: false }
  const parentSession = { sessionId: parent.getSessionId(), sessionManager: parent, getActiveToolNames: () => ['write'], getCallableToolNames: () => [], getAllTools: () => [], messages: [] }
  const request = { parentSession, parentSessionPath: parent.getSessionFile(), parentToolCallId: 'call', profile, description: 'test', task: 'test', runInBackground: false }
  const makeRuntime = (over = {}) => {
    const counters = { prompts: 0, halts: 0, releases: 0, listeners: 0, resources: [], steers: [] }
    const leases = new Set()
    let settled = over.settled ?? true
    const host = { isClosing: () => false, subagentsEnabled: () => true, subagentReuseEnabled: () => true,
      subagentCommsEnabled: () => false, planRestricted: () => false, frozenToolCeiling: () => null,
      subagentTurnLimitOverrideEnabled: () => false, subagentMaxTurns: () => null,
      maxConcurrentSubagents: () => over.limit ?? 4, commandTasks: () => null,
      acquireRunLease: (_cwd, path) => { const lease = { path }; leases.add(lease); return () => leases.delete(lease) },
      resolveModelSpec: async () => ({}), emitSubagents: () => {}, notifySubagentChildWrite: () => {},
      createChildSession: async options => {
        await over.creation?.promise
        counters.resources.push(options.resource)
        const manager = SessionManager.create(temporary, sessionsDir, { parentSession: parent.getSessionFile() }); await materialize(manager)
        const session = { sessionId: manager.getSessionId(), sessionManager: manager, messages: [], isIdle: true, getLastAssistantText: () => 'done',
          subscribe: () => { counters.listeners++; return () => { counters.listeners-- } },
          prompt: async () => { counters.prompts++; await over.promptGate?.promise },
          steer: message => { counters.steers.push(message) }, abort: async () => {} }
        if (over.writeFailure) manager.appendCustomEntry = () => { throw Error('injected persistence failure') }
        return { session, sessionManager: manager, path: manager.getSessionFile(), cwd: temporary, resource: options.resource, runId: options.runId,
          parentSessionId: options.parentSessionId, isSettled: () => settled,
          halt: async () => { counters.halts++; over.haltEntered?.resolve(); await over.haltGate?.promise },
          release: async () => { counters.releases++; over.releaseEntered?.resolve(); await over.releaseGate?.promise } }
      } }
    return { runtime: new SubagentRuntime(host), host, state: new SubagentParentState(parent.getSessionId()), counters, leases, settle: () => { settled = true } }
  }
  {
    const settings = loadSettings()
    assert.equal(settings.subagentTurnLimitOverrideEnabled, false, 'missing settings revoke the model grant')
    assert.equal(settings.subagentMaxTurns, null, 'missing user limit means unlimited')
    const app = Object.create(PiManager.prototype)
    let reloads = 0
    app.reloadLiveSessions = async () => { reloads++ }
    await app.setSubagentTurnLimitOverrideEnabled(true)
    app.setSubagentMaxTurns(12)
    assert.equal(loadSettings().subagentTurnLimitOverrideEnabled, true)
    assert.equal(loadSettings().subagentMaxTurns, 12, 'the user limit persists across reloads')
    for (const invalid of [0, -1, 201, 1.5, NaN, undefined, '12']) {
      assert.throws(() => app.setSubagentMaxTurns(invalid), /Invalid subagent turn limit/)
    }
    assert.equal(loadSettings().subagentMaxTurns, 12, 'invalid values cannot replace the user setting')
    await app.setSubagentTurnLimitOverrideEnabled(false)
    app.setSubagentMaxTurns(null)
    assert.equal(loadSettings().subagentTurnLimitOverrideEnabled, false)
    assert.equal(loadSettings().subagentMaxTurns, null, 'clearing persists unlimited')
    assert.equal(reloads, 2, 'permission changes refresh the live model schemas')
    saveSettings({ ...settings, subagentTurnLimitOverrideEnabled: 'true', subagentMaxTurns: 0 })
    assert.equal(loadSettings().subagentTurnLimitOverrideEnabled, false)
    assert.equal(loadSettings().subagentMaxTurns, null, 'invalid persisted values fail back to user-owned unlimited')
    saveSettings(settings)
    app.cwd = temporary
    const rolesDir = join(temporary, '.pi', 'agents')
    await mkdir(rolesDir, { recursive: true })
    const rolePath = join(rolesDir, 'fixture-defaults-role.md')
    const original = '---\ndescription: Editable defaults\ntools: write\nmax_turns: 99\n---\n\nOriginal prompt.\n'
    await writeFile(rolePath, original)
    const defaults = { model: 'fixture/fixture', thinking: 'high', inheritContext: false, runInBackground: true }
    const list = await app.setSubagentProfileDefaults(rolePath, defaults)
    const role = list.profiles.find(p => p.filePath === rolePath)
    assert.equal(role.model, defaults.model)
    assert.equal(role.thinking, defaults.thinking)
    assert.equal(role.inheritContext, false)
    assert.equal(role.runInBackground, true)
    assert.equal(role.systemPrompt, 'Original prompt.')
    assert.equal(role.maxTurns, 99, 'legacy role limits are preserved as ignored file metadata')
    const outside = join(temporary, 'not-a-listed-role.md')
    await writeFile(outside, original)
    await assert.rejects(app.setSubagentProfileDefaults(outside, defaults), /Unknown subagent profile/)
    assert.equal(await readFile(outside, 'utf8'), original, 'the defaults IPC route cannot write an arbitrary file')
    await app.setSubagentProfileDefaults(rolePath, { model: null, thinking: null, inheritContext: true, runInBackground: false })
    assert.equal(app.subagentProfiles().profiles.find(p => p.filePath === rolePath).model, undefined)
    assert.equal(reloads, 4, 'saving role defaults refreshes the existing agent roster')
  }
  {
    const creation = deferred()
    const e = makeRuntime({ creation })
    let allowed = true
    e.host.subagentTurnLimitOverrideEnabled = () => allowed
    e.host.subagentMaxTurns = () => 7
    const launching = e.runtime.start(e.state, { ...request, maxTurns: 200 })
    await tick()
    allowed = false
    creation.resolve()
    const finished = await (await launching).completion
    assert.equal(e.runtime.readChildRuns(finished.sessionPath)[0].start.resource.maxTurns, 7,
      'revocation during asynchronous session creation reaches the actual dispatch')
    assert.equal(e.leases.size, 0)
  }
  {
    const e = makeRuntime({ limit: 0 })
    await assert.rejects(e.runtime.start(e.state, request), /concurrency/)
    assert.equal(e.state.starting.size + e.state.launching.size, 0, 'rejected admission owns no launch promises')
    await e.runtime.stopAll(e.state)
  }
  {
    const creation = deferred(), releaseEntered = deferred(), releaseGate = deferred()
    const e = makeRuntime({ creation, releaseEntered, releaseGate })
    const start = e.runtime.start(e.state, request)
    await tick()
    const stopping = e.runtime.stopAll(e.state)
    creation.resolve()
    const { completion } = await start
    // The frozen resource snapshot: the ceiling as filtered, and a ceiling
    // with no extension-attributed tool stays extension-free (the stub
    // parent registers no extension tools).
    assert.deepEqual(e.counters.resources[0].tools, ['write'])
    assert.equal(e.counters.resources[0].extensions, undefined, 'a pure built-in ceiling never loads extensions')
    await releaseEntered.promise
    assert.equal(e.counters.prompts, 0)
    assert.equal(e.leases.size, 1, 'cleanup still owns its run lease')
    releaseGate.resolve()
    await completion; await stopping
    assert.equal(e.state.runs.size + e.state.starting.size + e.state.launching.size + e.leases.size + e.counters.listeners, 0)
  }
  {
    const haltEntered = deferred(), haltGate = deferred()
    const e = makeRuntime({ writeFailure: true, haltEntered, haltGate })
    const rejected = assert.rejects(e.runtime.start(e.state, request), /persistence failure/)
    await haltEntered.promise
    assert.equal(e.leases.size, 1, 'persistence failure cannot unlock before halt')
    haltGate.resolve(); await rejected
    assert.equal(e.leases.size, 0); assert.equal(e.counters.releases, 1)
  }
  {
    const promptGate = deferred()
    const e = makeRuntime({ promptGate })
    const { run, completion } = await e.runtime.start(e.state, request)
    await tick()
    assert.throws(() => e.runtime.steer(e.state, run.sessionId, 'stale redirect', 'older-run'), /run changed/)
    assert.throws(() => e.runtime.abort(e.state, run.sessionId, 'older-run'), /run changed/)
    e.runtime.steer(e.state, run.sessionId, 'human redirect', run.runId)
    assert.deepEqual(e.counters.steers, ['human redirect'], 'Steer reaches only the exact live child run')
    promptGate.resolve()
    await completion
    assert.throws(() => e.runtime.steer(e.state, run.sessionId, 'too late'), /not running/)
  }
  {
    const e = makeRuntime({ settled: false })
    const { completion } = await e.runtime.start(e.state, request)
    let done = false; void completion.then(() => { done = true })
    await delay(40)
    assert.equal(done, false, 'empty bash list is not completion while child notification is pending')
    assert.equal(e.leases.size, 1)
    e.settle(); await completion
  }
  console.log('PASS: rejected admission, creation cancellation, human Steer ownership, async cleanup and child completion handoff.')

  // Actual PiManager and SDK with only provider I/O replaced by local streams.
  const modelRuntime = await ModelRuntime.create({ authPath: join(temporary, 'auth.json'), modelsPath: join(temporary, 'models.json'), modelsStorePath: join(temporary, 'models-store'), refreshOnCreate: false })
  modelRuntime.hasConfiguredAuth = () => true
  modelRuntime.checkAuth = () => { throw Error('Unexpected auth access') }
  const model = { id: 'fixture', name: 'fixture', provider: 'fixture', api: 'openai-completions', baseUrl: 'http://127.0.0.1:1', reasoning: false,
    input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 4096 }
  modelRuntime.getAvailableSnapshot = () => [model]
  const loader = { getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }), getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }), getSystemPrompt: () => undefined, getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [], extendResources: () => {}, reload: async () => {} }
  const services = { cwd: temporary, agentDir: temporary, resourceLoader: loader, modelRuntime,
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }) }
  // The fixture parent carries the delegation that created the child: the
  // legacy run below has no dispatch entry, so branch ownership of a resume
  // is proven by its `agent` tool call + result on the selected branch —
  // exactly what a real pre-dispatch-era session looks like.
  parent.appendMessage({ role: 'user', content: 'delegate the task', timestamp: ++timestamp })
  parent.appendMessage(assistant([call('call', 'agent', { subagent_type: 'worker' })]))
  parent.appendMessage({ role: 'toolResult', toolCallId: 'call', toolName: 'agent', isError: false, content: text('ok'), timestamp: ++timestamp })
  const child = SessionManager.create(temporary, sessionsDir, { parentSession: parent.getSessionFile() }); await materialize(child)
  const resource = { tools: ['write'], inheritContext: false }
  child.appendCustomEntry(SUBAGENT_RUN_TYPE, { version: 1, runId: 'initial', parentSessionId: parent.getSessionId(), parentSessionPath: parent.getSessionFile(),
    parentToolCallId: 'call', profile: 'worker', description: 'child', task: 'initial task', createdAt: new Date().toISOString(), runInBackground: false, resource })
  child.appendCustomEntry(SUBAGENT_RESULT_TYPE, { version: 1, runId: 'initial', status: 'completed', completedAt: new Date().toISOString() })
  const app = Object.create(PiManager.prototype)
  app.jevPreferences = { mode: 'workflow', choice: true, score: true, noul: true }
  app.trajectory = { write: async () => {}, settle: async () => {}, dispose: async () => {} }
  app.jevService = { enabledQuestionTypes: () => [], cancel() {}, dispose() {} }
  const refusals = []
  Object.assign(app, { checkoutCoordinator: new CheckoutCoordinator(), emit: () => {}, sessions: new Map(), planSequences: new Map(), sessionBuilds: new Map(),
    disabledExtensions: new Set(), navigationEpoch: 0, closing: false, bashMaxWaitMs: 80, subagentMaxConcurrentSetting: 4, subagentsEnabledFlag: true,
    commandTasksInstance: { list: () => [], stopSession: async () => {} }, servicesFor: async () => services,
    activateSession: managed => { app.activeSession = managed }, routeEvent: () => {}, contextUsageOf: () => null,
    notifyError: message => { refusals.push(message) } })
  const managed = await app.buildSession(child, false); await managed.lifecyclePromise; sessions.push(managed.session)
  assert(managed.subagentChild)
  assert.equal(managed.jevWorkflow, undefined, 'mandatory Jev never wraps a subagent recursively')
  let calls = 0
  managed.session.agent.streamFunction = () => { calls++; return stream(assistant(text('should not run'))) }
  await app.checkoutCoordinator.withExclusive(temporary, 'restore', async () => {
    app.prompt({ text: 'forbidden', files: [], images: [] }); await tick(); assert.equal(calls, 0)
    assert.match(refusals.at(-1), /read-only/, 'the refusal is reported, not silently dropped')
  })
  await assert.rejects(app.resendMessage({}), /read-only/)
  await assert.rejects(app.setModel('fixture', 'fixture'), /read-only/)
  await assert.rejects(app.setThinkingLevel('off'), /read-only/)
  await assert.rejects(app.forkFromMessage(0), /read-only/)
  managed.notifications.pause()
  const state = new SubagentParentState(parent.getSessionId())
  state.apply({ ...currentDiskRun(child.getEntries(), child.getSessionId(), child.getSessionFile()), seq: state.nextSeq() })
  const beforeResume = parent.getLeafId()
  let file = join(temporary, 'first.txt'), round = 0
  managed.session.agent.streamFunction = () => stream(assistant(++round % 2 ? [call(`write-${round}`, 'write', { path: file, content: file })] : text('done')))
  await assert.rejects(app.subagentRuntime.resume(state, parentSession, child.getSessionId(), 'stale resume', { expectedRunId: 'older-run' }), /run changed/)
  const first = app.subagentRuntime.resume(state, parentSession, child.getSessionId(), 'resume one', { expectedRunId: 'initial' })
  await assert.rejects(app.subagentRuntime.resume(state, parentSession, child.getSessionId(), 'racing resume'), /already running/)
  const firstResult = await (await first).completion
  assert.equal(managed.notifications.canStart, true, 'reuse reopens the child bash owner')
  assert.equal(firstResult.writtenFilesScope, 'run')
  assert.deepEqual(firstResult.writtenFiles.map(file => file.displayPath), ['first.txt'])
  const afterFirst = parent.getLeafId()
  await assert.rejects(app.subagentRuntime.resume(state, parentSession, child.getSessionId(), 'old dialog resume', { expectedRunId: 'initial' }), /run changed/)
  file = join(temporary, 'second.txt')
  const secondResult = await (await app.subagentRuntime.resume(state, parentSession, child.getSessionId(), 'resume two', { expectedRunId: firstResult.runId })).completion
  assert.deepEqual(secondResult.writtenFiles.map(file => file.displayPath), ['second.txt'], 'resume evidence excludes previous runs')
  assert.equal(await readFile(file, 'utf8'), file)
  const disk = SessionManager.open(child.getSessionFile())
  const users = disk.getBranch().filter(entry => entry.type === 'message' && entry.message.role === 'user').map(entry => entry.message.content)
  assert.equal(users.length, 2, 'both resumes survive reload on the same selected branch')
  assert.deepEqual(await app.subagentRuntime.collectSubagentWritePaths(parent, temporary, afterFirst, sessionsDir), [file])
  assert.equal((await app.subagentRuntime.collectSubagentWritePaths(parent, temporary, beforeResume, sessionsDir)).length, 2)
  parent.branch(afterFirst)
  assert.deepEqual(await app.subagentRuntime.collectSubagentWritePaths(parent, temporary, afterFirst, sessionsDir), [], 'abandoned dispatches do not contribute writes')
  assert.equal(app.sessions.get(child.getSessionFile()), managed, 'resume retains the one managed instance')
  managed.unsubscribe(); managed.notifications.dispose()
  console.log('PASS: real SDK read-only admission, atomic stale-run rejection, serial resume, one SessionManager, stopped-owner recovery, per-run writes and branch coverage.')

  // A live run's lease fences restores: rewindRestore can only enter its
  // exclusive window (where stopAll runs) once nothing is running — the
  // existing product contract ("active tasks block restore") stays intact and
  // the stop path is never used to smuggle a restore under a live writer.
  {
    const coordinator = new CheckoutCoordinator()
    const release = coordinator.acquire(temporary, 'run', join(temporary, 'x.jsonl'))
    assert.equal(coordinator.busy(temporary), true, 'a live run marks the workspace busy')
    await assert.rejects(coordinator.withExclusive(temporary, 'restore', async () => {}), error => {
      const code = error?.dto?.code ?? error?.message
      return code === 'busy' || /busy/.test(String(error?.message ?? ''))
    }, 'restore cannot enter while the run lease is held')
    release()
    assert.equal(coordinator.busy(temporary), false)
    assert.equal(await coordinator.withExclusive(temporary, 'restore', async () => 'entered'), 'entered')
  }
  console.log('PASS: run leases fence restores; stopAll never bypasses the busy contract.')

  // Real BashTaskManager + real SDK child: a background command's completion
  // steers the child awake, the run only finishes after the woken round
  // settles, and Stop silences the wake path instead of restarting the child.
  {
    const tasks = new BashTaskManager(join(temporary, 'bash-tasks'), () => {}, task => notifications?.complete(task), new CheckoutCoordinator())
    const drainParent = SessionManager.create(temporary, sessionsDir); await materialize(drainParent)
    const drainChild = SessionManager.create(temporary, sessionsDir, { parentSession: drainParent.getSessionFile() }); await materialize(drainChild)
    let notifications
    const bashServices = { ...services, cwd: temporary }
    const { session: drainSession } = await createAgentSessionFromServices({ services: bashServices, sessionManager: drainChild,
      tools: ['bash'], customTools: [...createManagedBashTools({ tasks, services: bashServices,
        sessionId: drainChild.getSessionId(), sessionPath: drainChild.getSessionFile(),
        maxWaitMs: () => 0, sandboxMode: () => 'danger-full-access', canStart: () => notifications?.canStart ?? false })] })
    sessions.push(drainSession)
    notifications = new TaskNotifications(drainSession, tasks)
    notifications.onWake = () => {}
    const unsubscribeDrain = drainSession.subscribe(event => notifications.observe(event))
    const host = { isClosing: () => false, subagentsEnabled: () => true, subagentReuseEnabled: () => true,
      subagentCommsEnabled: () => false, planRestricted: () => false, frozenToolCeiling: () => null, maxConcurrentSubagents: () => 4,
      subagentTurnLimitOverrideEnabled: () => false, subagentMaxTurns: () => null,
      commandTasks: () => tasks,
      acquireRunLease: () => () => {}, resolveModelSpec: async () => ({}), emitSubagents: () => {}, notifySubagentChildWrite: () => {},
      createChildSession: async () => ({ session: drainSession, sessionManager: drainChild, path: drainChild.getSessionFile(), cwd: temporary,
        runId: crypto.randomUUID(), parentSessionId: drainParent.getSessionId(), resource: { tools: ['bash'], inheritContext: false },
        halt: async () => { drainSession.clearQueue(); await tasks.stopSession(drainChild.getSessionFile()); notifications.pause(); await drainSession.abort() },
        release: () => {}, isSettled: () => !notifications.continuesAtSettled && drainSession.isIdle }) }
    const drainRuntime = new SubagentRuntime(host)
    const drainState = new SubagentParentState(drainParent.getSessionId())
    drainState.notifications = { complete: () => {}, drop: () => {}, canStart: true }
    const bashProfile = { ...profile, name: 'bashworker', tools: ['bash'] }
    const drainRequest = { parentSession: { sessionId: drainParent.getSessionId(), sessionManager: drainParent, getActiveToolNames: () => ['bash'], getCallableToolNames: () => [], getAllTools: () => [], messages: [] },
      parentSessionPath: drainParent.getSessionFile(), parentToolCallId: 'drain-call', profile: bashProfile, description: 'drain', task: 'run bg', runInBackground: false }
    let rounds = 0, woke = 0
    drainSession.agent.streamFunction = () => stream(assistant((++rounds % 3) === 1
      ? [call(`bash-${rounds}`, 'bash', { command: 'sleep 0.3; echo finished', mode: 'background' })]
      : (woke++, text('done after background'))))
    const drained = await drainRuntime.start(drainState, drainRequest)
    const completion = await drained.completion
    assert.equal(rounds, 3, 'background completion wakes the child for a final round')
    assert.ok(woke >= 1)
    assert.equal(completion.status, 'completed')
    assert.equal(tasks.list(drainChild.getSessionFile())[0].status, 'succeeded', 'the run waited for the real process to exit')
    unsubscribeDrain()
    notifications.dispose()
    await tasks.dispose()

    // Stopped wake path: the command may finish, but a paused child never
    // restarts, and the run settles without the woken round.
    const tasks2 = new BashTaskManager(join(temporary, 'bash-tasks-2'), () => {}, task => notifications2?.complete(task), new CheckoutCoordinator())
    const stopChild = SessionManager.create(temporary, sessionsDir, { parentSession: drainParent.getSessionFile() }); await materialize(stopChild)
    let notifications2
    const { session: stopSession } = await createAgentSessionFromServices({ services: bashServices, sessionManager: stopChild,
      tools: ['bash'], customTools: [...createManagedBashTools({ tasks: tasks2, services: bashServices,
        sessionId: stopChild.getSessionId(), sessionPath: stopChild.getSessionFile(),
        maxWaitMs: () => 0, sandboxMode: () => 'danger-full-access', canStart: () => notifications2?.canStart ?? false })] })
    sessions.push(stopSession)
    notifications2 = new TaskNotifications(stopSession, tasks2)
    notifications2.onWake = () => {}
    const unsubscribeStop = stopSession.subscribe(event => notifications2.observe(event))
    let stopRounds = 0
    // Round 1 = the background tool call, round 2 = the same run's post-tool
    // continuation (normal SDK flow). A WAKE by the finished command would be
    // round 3 — that is what Stop must prevent.
    stopSession.agent.streamFunction = () => stream(assistant(++stopRounds === 1
      ? [call(`bash-stop-${stopRounds}`, 'bash', { command: 'sleep 0.3; echo stopped-run', mode: 'background' })]
      : text('continuation')))
    const host2 = { ...host, commandTasks: () => tasks2,
      createChildSession: async () => ({ session: stopSession, sessionManager: stopChild, path: stopChild.getSessionFile(), cwd: temporary,
        runId: crypto.randomUUID(), parentSessionId: drainParent.getSessionId(), resource: { tools: ['bash'], inheritContext: false },
        halt: async () => { stopSession.clearQueue(); await tasks2.stopSession(stopChild.getSessionFile()); notifications2.pause(); await stopSession.abort() },
        release: () => {}, isSettled: () => !notifications2.continuesAtSettled && stopSession.isIdle }) }
    const stopRuntime = new SubagentRuntime(host2)
    const stopState = new SubagentParentState(drainParent.getSessionId())
    const stopped = await stopRuntime.start(stopState, { ...drainRequest, parentSession: { ...drainRequest.parentSession, messages: [] } })
    // Stop against an observed live command, not a host-timing guess: CI process
    // startup can make a fixed delay land before launch or after completion.
    let runningStopTask
    for (let attempt = 0; attempt < 100 && !runningStopTask; attempt++) {
      runningStopTask = tasks2.list(stopChild.getSessionFile()).find(task => task.status === 'running')
      if (!runningStopTask) await delay(10)
    }
    assert(runningStopTask, 'the stopped-run command entered the managed running state')
    assert.equal(stopState.runs.size, 1, 'the child is still owned by the live run before Stop')
    await stopRuntime.stopAll(stopState)
    const stoppedResult = await stopped.completion
    assert.equal(stoppedResult.status, 'aborted')
    assert.equal(stopRounds, 2, 'a stopped child is never re-woken by its command')
    assert.ok(['cancelled', 'interrupted'].includes(tasks2.list(stopChild.getSessionFile())[0].status))
    unsubscribeStop()
    notifications2.dispose()
    await tasks2.dispose()
  }
  console.log('PASS: real background bash drains through steering; Stop silences the wake path.')

  // SDK error flags are set without throwing away a failed child's details.
  {
    // `tools: []` is an EMPTY allowlist — it hides customTools too (the
    // same SDK rule the manager works around), routing the call to the
    // immediate-error path that never reaches afterToolCall.
    const { session } = await createAgentSessionFromServices({ services, sessionManager: SessionManager.create(temporary, sessionsDir), tools: ['agent'], customTools: [{
      // A plain JSON object fails prepareToolCall's TypeBox validation and
      // takes the "immediate" error path, which never reaches afterToolCall.
      name: 'agent', label: 'agent', description: 'fixture', parameters: Type.Object({}),
      execute: async () => ({ content: text('failed after writing'), details: { kind: 'pi-app-subagent', subagent: { status: 'failed', writtenFiles: [{ filePath: file }] } } })
    }] })
    sessions.push(session)
    let sawFailure = false
    const previous = session.agent.afterToolCall
    session.agent.afterToolCall = async (context, signal) => { sawFailure = context.isError; return previous?.(context, signal) }
    installSubagentResultHook(session)
    let round = 0
    session.agent.streamFunction = () => stream(assistant(++round === 1 ? [call('failed-child', 'agent', {})] : text('handled')))
    await session.prompt('run')
    const result = session.messages.find(message => message.role === 'toolResult')
    assert(sawFailure); assert(result.isError); assert.equal(result.details.subagent.writtenFiles[0].filePath, file)
  }
  console.log('PASS: real SDK failed delegation retains committed file details and extension error hooks.')
} finally {
  for (const session of sessions) session.dispose()
  await rm(temporary, { recursive: true, force: true })
}
