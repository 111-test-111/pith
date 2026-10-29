/** Real SDK + app snapshot/store integration, entirely in a temporary profile. No model/network calls. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { ModelRuntime, SessionManager } from '@earendil-works/pi-coding-agent'

const temporary = await mkdtemp(join(tmpdir(), 'pith-todos-'))
const agentDir = join(temporary, 'agent'), project = join(temporary, 'project')
const apps = []
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const until = async (predicate) => { for (let i = 0; i < 500; i++) { if (predicate()) return; await pause(10) } assert.fail('Timed out') }
try {
  await mkdir(agentDir); await mkdir(project)
  const extensionDir = join(project, '.pi', 'extensions')
  await mkdir(extensionDir, { recursive: true })
  const startupLog = join(temporary, 'extension-starts')
  await writeFile(join(extensionDir, 'probe.ts'), `import { appendFileSync } from 'node:fs'; export default function(pi) { appendFileSync(${JSON.stringify(startupLog)}, 'loaded\\n'); pi.on('session_start', () => {}); }`)
  const sdk = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))
  const outfile = join(temporary, 'modules.mjs')
  const sessionDir = join(agentDir, 'sessions', '--rewind-fixture-project--')
  await build({ stdin: { contents: `export { PiManager } from './src/main/pi/manager';
export { RewindFailure } from './src/main/rewind/types';
export { uncoveredWrites } from './src/main/rewind/coverage';
export { TodoState, createTodoTool } from './src/main/pi/todo';
export * from './src/main/pi/todo-protocol';
export { selectedBranchHasMessages } from './src/main/pi/session-branch';
export { PiStore } from './src/renderer/src/state/pi-store';
export { buildToolCatalog } from './src/main/pi/catalog';`, resolveDir: resolve('.') },
    bundle: true, platform: 'node', format: 'esm', outfile,
    plugins: [{ name: 'isolated-profile', setup(builder) {
      builder.onResolve({ filter: /^@earendil-works\/pi-coding-agent$/ }, () => ({ path: 'sdk', namespace: 'fixture' }))
      builder.onResolve({ filter: /^playwright-core(\/|$)/ }, args => ({ path: fileURLToPath(import.meta.resolve(args.path)), external: true }))
      builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'fixture' }))
      builder.onResolve({ filter: /^proper-lockfile$|^@resvg\/resvg-js$/ }, args => ({ path: fileURLToPath(import.meta.resolve(args.path)), external: true }))
      builder.onResolve({ filter: /^\// }, (args) => args.path === sdk ? { path: sdk, external: true } : undefined)
      builder.onLoad({ filter: /^electron$/, namespace: 'fixture' }, () => ({ contents: `export const app={getPath:()=>${JSON.stringify(temporary)}};export const shell={};` }))
      builder.onLoad({ filter: /^sdk$/, namespace: 'fixture' }, () => ({ contents: `
export * from ${JSON.stringify(sdk)};
import {createAgentSessionServices as create,SettingsManager,SessionManager as BaseManager} from ${JSON.stringify(sdk)};
export const getAgentDir=()=>${JSON.stringify(agentDir)};
// The app lists sessions through the SDK's own session root; point that root at
// this profile so the sidebar rule is exercised against the fixture sessions.
export class SessionManager extends BaseManager { static listAll(_dir, onProgress) { return BaseManager.listAll(${JSON.stringify(sessionDir)}, onProgress) } }
export function createAgentSessionServices(options){return create({...options,agentDir:getAgentDir(),settingsManager:SettingsManager.inMemory({compaction:{enabled:false},retry:{enabled:false}}),
resourceLoaderOptions:{...options.resourceLoaderOptions,noExtensions:options.resourceLoaderOptions.noExtensions??false,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,
extensionFactories:[...(options.resourceLoaderOptions.extensionFactories??[]),{name:'fixture-transform',hidden:true,factory:pi=>{
pi.on('tool_result',e=>{if(e.toolName==='todo_write'&&e.input.todos[0]?.content==='Rejected by extension')return {isError:true};});
}}]}})};` }))
    } }]
  })
  const { PiManager, PiStore, RewindFailure, uncoveredWrites, selectedBranchHasMessages } = await import(pathToFileURL(outfile).href)
  const scope = join(temporary, 'coverage', 'scope'), sibling = join(temporary, 'coverage', 'scope-sibling')
  await mkdir(scope, { recursive: true }); await mkdir(sibling)
  await writeFile(join(scope, 'space name.txt'), 'covered')
  await symlink(sibling, join(scope, 'escape')); await symlink(scope, join(temporary, 'scope-alias'))
  const coverageBranch = []
  const record = (id, name, path, isError = false, result = true) => {
    coverageBranch.push({ id, type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id, name, arguments: { path } }] } })
    if (result) coverageBranch.push({ id: id + '-result', type: 'message', message: { role: 'toolResult', toolCallId: id, toolName: name, isError } })
  }
  record('earlier', 'write', join(sibling, 'before-anchor.txt'))
  coverageBranch.push({ id: 'anchor', type: 'custom', data: {} })
  record('covered', 'write', 'space\u00a0name.txt')
  record('covered-alias', 'write', join(temporary, 'scope-alias', 'space name.txt'))
  record('outside', 'write', pathToFileURL(join(sibling, 'new.txt')).href)
  record('outside-again', 'edit', join(sibling, 'new.txt'))
  record('escape', 'write', 'escape/deleted-parent/file.txt')
  record('excluded', 'edit', '@./.ignored/nested.txt')
  record('failed', 'write', join(sibling, 'failed.txt'), true)
  record('read-only', 'read', join(sibling, 'read.txt'))
  record('pending', 'write', join(sibling, 'pending.txt'), false, false)
  coverageBranch.push({ id: 'nested-parent', type: 'message', message: { role: 'assistant', content: [
    { type: 'toolCall', id: 'nested-parent-call', name: 'codemode', arguments: { code: 'write files' } }
  ] } })
  coverageBranch.push({ id: 'nested-parent-result', type: 'message', message: {
    role: 'toolResult', toolCallId: 'nested-parent-call', toolName: 'codemode', isError: true,
    details: { piAppNestedWrites: { version: 1, paths: [join(sibling, 'nested-omitted.txt')] } },
    nestedCalls: { complete: false, calls: [
      { id: 'nested-parent-call/1', name: 'write', status: 'ok', arguments: { path: join(sibling, 'nested-recorded.txt') } },
      { id: 'nested-parent-call/2', name: 'edit', status: 'error', arguments: { path: join(sibling, 'nested-failed.txt') } },
      { id: 'nested-parent-call/3', name: 'write', status: 'ok', argumentsBytes: 65536 }
    ] }
  } })
  coverageBranch.push({ id: 'prose', type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'write ' + join(sibling, 'prose.txt') }] } })
  assert.deepEqual(await uncoveredWrites(coverageBranch, scope, scope, 'anchor', [{ path: '.ignored', reason: 'ignored' }]), [
    { path: join(sibling, 'new.txt'), reason: 'outside-workspace' },
    { path: join(scope, 'escape/deleted-parent/file.txt'), reason: 'outside-workspace' },
    { path: join(scope, '.ignored/nested.txt'), reason: 'excluded' },
    { path: join(sibling, 'nested-omitted.txt'), reason: 'outside-workspace' },
    { path: join(sibling, 'nested-recorded.txt'), reason: 'outside-workspace' }
  ], 'scope diagnosis respects anchors, normalization, aliases, removed parents and successful write evidence')
  console.log('PASS: coverage path boundaries, exclusions, symlink escape, deduplication and committed tool evidence')
  await build({ entryPoints: [resolve('src/main/rewind/worker.ts')], outfile: join(temporary, 'rewind-worker.mjs'), bundle: true, platform: 'node', format: 'esm' })
  const runtime = await ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: join(agentDir, 'models.json'), modelsStorePath: join(agentDir, 'models-store'), refreshOnCreate: false })
  runtime.hasConfiguredAuth = () => true
  runtime.checkAuth = () => { throw new Error('Unexpected credential access') }
  const model = { id: 'fixture', name: 'fixture', provider: 'fixture', api: 'openai-completions', baseUrl: 'http://127.0.0.1:1', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 4096 }
  runtime.getAvailableSnapshot = () => [model]
  const store = new PiStore()
  const app = new PiManager((channel, event) => { if (channel === 'pi:event') store.dispatch(event) }, (error) => { throw new Error(error) }); apps.push(app)
  app.runtime = async () => runtime
  const manager = SessionManager.create(project, sessionDir)
  const managed = await app.buildSession(manager)
  const { session } = managed
  store.applySnapshot(app.snapshot())
  await managed.lifecyclePromise
  await managed.rewind.idle()
  await writeFile(join(project, 'file.txt'), 'USER BEFORE\r\n')
  let step = 0, time = Date.now()
  let respond = () => {
    if (++step === 1) return [{ type: 'toolCall', name: 'write', id: 'write-one', arguments: { path: 'file.txt', content: 'TOOL AFTER\n' } }]
    if (step === 2) return [{ type: 'toolCall', name: 'todo_write', id: 'todo-one', arguments: { todos: [{ content: 'Review rewind', status: 'completed' }] } }]
    return [{ type: 'text', text: 'Done' }]
  }
  let during
  session.agent.streamFunction = () => {
    const content = respond()
    const message = { role: 'assistant', content, provider: 'fixture', model: 'fixture', api: 'openai-completions', stopReason: content.some(c => c.type === 'toolCall') ? 'toolUse' : 'stop', timestamp: ++time,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }
    return { async *[Symbol.asyncIterator]() { yield { type: 'start', partial: { ...message, content: [] } }; await during?.(); yield { type: 'done', message } }, result: async () => message }
  }
  const value = reply => { assert(!reply.error, JSON.stringify(reply)); return reply.value }
  await session.prompt('Make the change')
  await managed.rewind.idle()
  const user = manager.getEntries().find(entry => entry.type === 'message' && entry.message.role === 'user')
  assert(user)
  const list = value(await app.rewindList(managed.path))
  const before = list.checkpoints.find(cp => cp.messageTimestamp === user.message.timestamp && cp.trigger === 'before-turn')
  assert(before, JSON.stringify(list))
  assert.equal(before.messageEntryId, user.id)
  assert.equal(store.getState().messages.find(message => message.role === 'user').sessionEntryId, user.id)
  assert.equal(before.entryId, user.parentId, 'checkpoint belongs to the exact pre-user leaf')
  assert.equal(list.checkpoints.length, 1, 'only one point before the user turn, independent of tool count')
  assert(list.checkpoints.every(cp => cp.trigger === 'before-turn'))
  assert(!manager.getEntries().some(entry => entry.customType === 'pith_rewind_anchor'), 'capture does not mutate session history')
  const todo = structuredClone(managed.todos.snapshot)
  assert.equal(todo.items[0].status, 'completed')
  const originalCall = app.rewindClient.call.bind(app.rewindClient)
  // Simulate expensive capture. Tool admission must wait for the actual bytes.
  app.rewindClient.call = async (method, ...args) => { if (method === 'checkpoint') await pause(60); return originalCall(method, ...args) }
  let queued = false
  respond = () => [{ type: 'text', text: 'Queue boundary' }]
  during = async () => { if (!queued) { queued = true; await session.steer('Queued user message') } }
  await session.prompt('Start with queued continuation')
  during = undefined
  app.rewindClient.call = originalCall
  const queueUser = manager.getEntries().find(entry => entry.type === 'message' && entry.message.role === 'user' && JSON.stringify(entry.message.content).includes('Queued user message'))
  const queuedCheckpoint = value(await app.rewindList(managed.path)).checkpoints.find(cp => cp.messageTimestamp === queueUser.message.timestamp)
  assert.equal(queuedCheckpoint.messageEntryId, queueUser.id)
  assert.equal(queuedCheckpoint.entryId, queueUser.parentId, 'steering messages have exact awaited checkpoints')
  console.log('PASS: real SDK prompt/steer capture barriers, one pre-turn point, no tool/resume points or hidden capture entries')
  // Concurrent sessions share one checkout: another session's model turn (a
  // plain run lease) must not starve this session's pre-turn capture, while
  // the leases that can actually write — tool, process and a subagent run —
  // still fence the snapshot window and surface a busy capture error.
  {
    const otherRun = app.checkoutCoordinator.acquire(project, 'run', join(temporary, 'other-session.jsonl'))
    respond = () => [{ type: 'text', text: 'Done beside a run' }]
    await session.prompt('Capture beside another session run')
    await managed.rewind.idle(); otherRun()
    const beside = value(await app.rewindList(managed.path))
    assert.equal(beside.error, undefined, JSON.stringify(beside))
    const besideUser = manager.getEntries().filter(entry => entry.type === 'message' && entry.message.role === 'user').at(-1)
    assert(beside.checkpoints.some(cp => cp.messageEntryId === besideUser.id), 'a checkpoint is captured while a sibling session only streams')
    for (const kind of ['tool', 'process', 'subagent']) {
      const release = app.checkoutCoordinator.acquire(project, kind, join(temporary, 'writer-session.jsonl'))
      respond = () => [{ type: 'text', text: 'Done' }]
      await session.prompt('Capture fenced by ' + kind)
      await managed.rewind.idle(); release()
      const fenced = value(await app.rewindList(managed.path))
      assert.equal(fenced.error?.code, 'busy', kind + ' lease fences the snapshot; the list surfaces the failed capture')
    }
    respond = () => [{ type: 'text', text: 'Done' }]
    await session.prompt('Capture recovers')
    await managed.rewind.idle()
    assert.equal(value(await app.rewindList(managed.path)).error, undefined, 'a later successful capture clears the sticky error')
  }
  console.log('PASS: concurrent-session capture — sibling runs never starve checkpoints; writing leases still fence snapshots')
  async function restore(id, action, mode = 'all') {
    const preview = value(await app.rewindPreview(managed.path, id, action))
    return value(await app.rewindRestore({ sessionPath: managed.path, token: preview.token, mode, operationId: randomUUID() }))
  }
  const restored = await restore(before.id)
  assert.equal(await readFile(join(project, 'file.txt'), 'utf8'), 'USER BEFORE\r\n')
  assert.equal(managed.todos.snapshot, null)
  assert(!session.messages.some(message => message.role === 'user'))
  assert(!SessionManager.open(managed.path).buildSessionContext().messages.some(message => message.role === 'user'), 'conversation selection survives reopen without another prompt')
  // The sidebar lists a session from its SELECTED branch: `messageCount` counts
  // the abandoned history this restore left behind, so the persisted selection
  // carries the branch fact and the list reads it back.
  const selectionOf = (path) => SessionManager.open(path).getEntries().filter(entry => entry.customType === 'pith_rewind_selection').at(-1)?.data
  assert.equal(selectionOf(managed.path).empty, true, 'a selection to before the first turn records an empty branch')
  assert.equal(await selectedBranchHasMessages(managed.path), false, 'the reader agrees that the branch has nothing to show')
  assert(!(await app.listSessions()).some(summary => summary.path === managed.path), 'an emptied session leaves the sidebar instead of listing as an unopenable chat')
  const undone = await restore(restored.operation.id, 'undo')
  assert.equal(await readFile(join(project, 'file.txt'), 'utf8'), 'TOOL AFTER\n')
  assert.deepEqual(managed.todos.snapshot, todo)
  assert(SessionManager.open(managed.path).buildSessionContext().messages.some(message => message.role === 'user'))
  assert.equal(selectionOf(managed.path).empty, false, 'an Undo selection carries the messages it restored')
  assert.equal(await selectedBranchHasMessages(managed.path), true)
  assert((await app.listSessions()).some(summary => summary.path === managed.path), 'Undo puts the session back in the sidebar')
  const redone = await restore(undone.operation.id, 'redo')
  assert.equal(await readFile(join(project, 'file.txt'), 'utf8'), 'USER BEFORE\r\n')
  assert.equal(managed.todos.snapshot, null)
  await restore(redone.operation.id, 'undo')
  console.log('PASS: combined restore, persistent conversation selection, Todo, full Undo/Redo')
  // The sidebar reader: only the newest relevant entry decides, and a message
  // appended after a selection is on the selected branch.
  const branchDir = join(temporary, 'branch-files')
  await mkdir(branchDir, { recursive: true })
  const at = new Date().toISOString()
  const userMessage = (id, parentId) => ({ type: 'message', id, parentId, timestamp: at, message: { role: 'user', content: [{ type: 'text', text: 'hello' }], timestamp: 1 } })
  const systemMessage = (id, parentId) => ({ type: 'message', id, parentId, timestamp: at, message: { role: 'system', content: 'prompt', timestamp: 1 } })
  const selection = (id, parentId, data) => ({ type: 'custom', customType: 'pith_rewind_selection', data, id, parentId, timestamp: at })
  let branchFiles = 0
  const branchFile = async (list) => {
    const file = join(branchDir, `branch-${branchFiles++}.jsonl`)
    await writeFile(file, [{ type: 'session', version: 3, id: `branch-${branchFiles}`, timestamp: at, cwd: project }, ...list].map(entry => JSON.stringify(entry)).join('\n') + '\n')
    return file
  }
  const assertBranch = async (expected, entries, label) => assert.equal(await selectedBranchHasMessages(await branchFile(entries)), expected, label)
  await assertBranch(true, [userMessage('m1', null)], 'a branch ending in a message has something to show')
  await assertBranch(false, [systemMessage('sys1', null)], 'SDK system declarations alone do not create a chat row')
  await assertBranch(false, [selection('s1', null, { operationId: 'op', target: null, empty: true })], 'a selection that recorded an empty branch hides the session')
  await assertBranch(false, [selection('s1', null, { operationId: 'op', target: null, empty: true }), systemMessage('sys1', 's1')], 'a later SDK system update leaves an empty chat hidden')
  await assertBranch(true, [userMessage('m1', null), selection('s1', 'm1', { operationId: 'op', target: 'm1', empty: false })], 'a selection that recorded messages keeps it')
  await assertBranch(false, [userMessage('m1', null), selection('s1', 'm1', { operationId: 'op', target: null })], 'a selection written before the fact is known still decides a reset leaf')
  await assertBranch(true, [userMessage('m1', null), selection('s1', 'm1', { operationId: 'op', target: 'm1' })], 'an unrecorded selection over messages stays listed')
  await assertBranch(true, [userMessage('m1', null), selection('s1', null, { operationId: 'op', target: null, empty: true }), userMessage('m2', 's1')], 'a message sent after the restore puts the session back')
  await assertBranch(false, [selection('s1', null, { operationId: 'op', target: null, empty: true }), ...Array.from({ length: 400 }, (_, index) => ({ type: 'model_change', id: `pad-${index}`, parentId: 's1', timestamp: at, provider: 'fixture', modelId: 'x'.repeat(200) }))], 'the decision survives a tail larger than one read window')
  await assertBranch(false, [], 'a file with no message entry has an empty branch')
  assert.equal(await selectedBranchHasMessages(join(branchDir, 'missing.jsonl')), true, 'an unreadable file is listed, never hidden')
  console.log('PASS: the selected branch decides the sidebar row, without a second full read')
  const preview = value(await app.rewindPreview(managed.path, before.id))
  const id = randomUUID()
  app.rewindClient.call = async (method, ...args) => {
    const reply = await originalCall(method, ...args)
    if (method === 'finish' && args[3] === true) throw new Error('IPC reply lost after durable commit')
    return reply
  }
  const lostReply = value(await app.rewindRestore({ sessionPath: managed.path, token: preview.token, mode: 'all', operationId: id }))
  assert.equal(lostReply.operation.status, 'committed')
  assert.equal(await readFile(join(project, 'file.txt'), 'utf8'), 'USER BEFORE\r\n')
  assert(!session.messages.some(message => message.role === 'user'), 'lost commit response cannot compensate only the conversation')
  app.rewindClient.call = originalCall
  const duplicate = value(await app.rewindRestore({ sessionPath: managed.path, token: preview.token, mode: 'all', operationId: id }))
  assert.equal(duplicate.operation.id, id)
  console.log('PASS: lost committed reply reconciliation and operation idempotency')
  const release = await app.checkoutCoordinator.enter(project, 'process', 'another-session')
  const blockedPreview = value(await app.rewindPreview(managed.path, before.id))
  const blockedList = value(await app.rewindList(managed.path))
  assert.equal(blockedList.busy, true)
  assert.equal(blockedList.busyReason, 'work', 'a live writer is named as work, not as this session’s own turn')
  const blocked = await app.rewindRestore({ sessionPath: managed.path, token: blockedPreview.token, mode: 'files', operationId: randomUUID() })
  assert.equal(blocked.error.code, 'busy'); release()
  console.log('PASS: checkout process lifetime blocks restore independently of SDK idle')
  // The panel is told WHICH fact refuses the restore, so it never has to list
  // three unrelated causes in one sentence. Each lease kind names itself, and
  // the order is what the user acts on first.
  session.clearQueue()
  const busyReason = async () => value(await app.rewindList(managed.path)).busyReason
  assert.equal(await busyReason(), undefined, 'an idle checkout reports no reason')
  const runLease = app.checkoutCoordinator.acquire(project, 'run', managed.path)
  assert.equal(await busyReason(), 'turn', 'a plain model turn is named as the turn')
  const toolLease = app.checkoutCoordinator.acquire(project, 'tool', managed.path)
  assert.equal(await busyReason(), 'work', 'a writer outranks the plain turn it belongs to')
  toolLease()
  const terminalLease = app.checkoutCoordinator.acquire(project, 'terminal')
  assert.equal(await busyReason(), 'terminal', 'a terminal lease anywhere is named as the terminal')
  terminalLease()
  await session.steer('queued while blocked')
  assert.equal(await busyReason(), 'queued', 'a queued message is named as the queue, ahead of the turn')
  session.clearQueue()
  // A recovery marker comes from the engine's pending operations: the list
  // mirrors them into the coordinator on every read, so a marker injected by
  // hand is cleared again by the next list call. Inject it through the list.
  const listReply = async (method, ...args) => {
    const reply = await originalCall(method, ...args)
    return method === 'list' ? { ...reply, pending: [{ id: 'op-reason', status: 'conflict' }] } : reply
  }
  app.rewindClient.call = listReply
  assert.equal(await busyReason(), 'recovery', 'an unresolved recovery outranks everything')
  app.rewindClient.call = originalCall
  assert.equal(await busyReason(), 'turn', 'with the recovery resolved the surviving run lease reports itself')
  runLease()
  assert.equal(await busyReason(), undefined, 'releasing the last lease clears the reason')
  await session.prompt('Preserve this branch across crash recovery')
  await writeFile(join(project, 'file.txt'), 'CRASH PREIMAGE\r\n')
  const crashPreview = value(await app.rewindPreview(managed.path, before.id))
  const crashId = randomUUID(), oldLeaf = manager.getLeafId()
  await originalCall('prepare', project, session.sessionId, crashPreview.token, 'all', crashId, oldLeaf, before.entryId, managed.path)
  await app.rewindLeaf(managed, before.entryId, crashId)
  app.checkoutCoordinator.setRecovery(project, crashId)
  const loadCount = await readFile(startupLog, 'utf8')
  await app.dispose()
  const restarted = new PiManager(() => {}, error => { throw new Error(error) }); apps.push(restarted)
  restarted.runtime = async () => runtime
  const reopened = await restarted.buildSession(SessionManager.open(managed.path))
  await reopened.lifecyclePromise
  assert.equal(reopened.recoveryOnly, true)
  assert.equal(await readFile(startupLog, 'utf8'), loadCount, 'unresolved restore prevents external extension evaluation')
  assert.equal(value(await restarted.rewindList(reopened.path)).pending[0].id, crashId)
  assert.equal(restarted.checkoutCoordinator.canStart(project), false)
  const recovered = await restarted.rewindRecover(reopened.path, crashId)
  if (recovered.error) console.log('Recovery leaf:', JSON.stringify(reopened.session.sessionManager.getBranch().slice(-5)), 'Operation:', JSON.stringify(value(await restarted.rewindList(reopened.path)).pending))
  value(recovered)
  assert.equal(await readFile(join(project, 'file.txt'), 'utf8'), 'CRASH PREIMAGE\r\n')
  assert(SessionManager.open(reopened.path).buildSessionContext().messages.some(message => message.role === 'user' && JSON.stringify(message.content).includes('Preserve this branch')))
  assert.notEqual(await readFile(startupLog, 'utf8'), loadCount, 'resolved recovery recreates the normal extension runtime')
  console.log('PASS: cold restart fences extension loading, recovers both phases and reloads normal runtime')
  const live = restarted.activeSession, singleLeaf = live.session.sessionManager.getLeafId()
  const singleFull = value(await restarted.rewindPreview(live.path, before.id))
  assert.deepEqual(value(await restarted.rewindStats(live.path, singleFull.token, 'file.txt', 'worktree')), { added: 1, removed: 1, binary: false })
  assert.deepEqual(value(await restarted.rewindStatsBatch(live.path, singleFull.token, [{ path: 'file.txt', area: 'worktree' }])), [{ added: 1, removed: 1, binary: false }])
  assert.equal((await restarted.rewindStatsBatch(live.path, singleFull.token, [{ path: 'file.txt', area: 'worktree', stage: -1 }])).error.code, 'missing')
  const singlePreview = value(await restarted.rewindPreviewFile(live.path, singleFull.token, 'file.txt'))
  const wrongMode = await restarted.rewindRestore({ sessionPath: live.path, token: singlePreview.token, mode: 'all', operationId: randomUUID() })
  assert.equal(wrongMode.error.code, 'unsupported')
  const singleRequest = { sessionPath: live.path, token: singlePreview.token, mode: 'files', operationId: randomUUID() }
  const single = value(await restarted.rewindRestore(singleRequest))
  assert.equal(single.operation.file, 'file.txt')
  assert.equal(live.session.sessionManager.getLeafId(), singleLeaf, 'single working-file restore cannot navigate conversation')
  assert.equal(await readFile(join(project, 'file.txt'), 'utf8'), 'USER BEFORE\r\n')
  assert.equal(value(await restarted.rewindRestore(singleRequest)).operation.id, single.operation.id, 'single-file result remains idempotent')
  const undoSingle = value(await restarted.rewindPreview(live.path, single.operation.id, 'undo'))
  assert.equal(undoSingle.file, 'file.txt')
  value(await restarted.rewindRestore({ sessionPath: live.path, token: undoSingle.token, mode: 'files', operationId: randomUUID() }))
  assert.equal(await readFile(join(project, 'file.txt'), 'utf8'), 'CRASH PREIMAGE\r\n')
  assert.equal(live.session.sessionManager.getLeafId(), singleLeaf)
  console.log('PASS: single-file stats/preview, enforced files mode, unchanged conversation, idempotency and Undo')
  // The screenshot regression: an empty standalone cwd, but an absolute-path
  // write in a different project. A valid empty snapshot is not full coverage.
  const empty = join(temporary, 'empty-workspace')
  await mkdir(empty)
  const outside = await restarted.buildSession(SessionManager.create(empty, sessionDir))
  await outside.lifecyclePromise
  outside.session.agent.streamFunction = session.agent.streamFunction
  let outsideStep = 0
  const externalPath = join(project, 'file.txt')
  respond = () => ++outsideStep === 1 ? [{ type: 'toolCall', name: 'write', id: 'outside-write', arguments: { path: externalPath, content: 'OUTSIDE CHANGE\n' } }] : [{ type: 'text', text: 'Done outside cwd' }]
  await outside.session.prompt('Edit a file outside the standalone workspace')
  await outside.rewind.idle()
  const outsideCheckpoint = value(await restarted.rewindList(outside.path)).checkpoints[0]
  assert.equal(outsideCheckpoint.files, 0)
  const outsidePreview = value(await restarted.rewindPreview(outside.path, outsideCheckpoint.id))
  assert.deepEqual(outsidePreview.uncovered, [{ path: externalPath, reason: 'outside-workspace' }])
  assert.equal(outsidePreview.blocked, undefined, 'missing originals are a consent warning, not a blanket block')
  const externalRestore = await restarted.rewindRestore({ sessionPath: outside.path, token: outsidePreview.token, mode: 'all', operationId: randomUUID() })
  assert.equal(externalRestore.error.code, 'uncovered', 'main requires explicit partial-restore consent')
  assert.equal((await restarted.rewindRestore({ sessionPath: outside.path, token: outsidePreview.token, mode: 'files', operationId: randomUUID(), skipUncovered: true })).error.code, 'uncovered', 'an empty file restore cannot report success even with consent')
  value(await restarted.rewindRestore({ sessionPath: outside.path, token: outsidePreview.token, mode: 'conversation', operationId: randomUUID() }))
  assert.equal(await readFile(externalPath, 'utf8'), 'OUTSIDE CHANGE\n', 'conversation-only leaves uncovered bytes untouched')
  console.log('PASS: standalone absolute-path writes expose missing coverage, block false file success and retain conversation-only restore')

  // A mixed checkpoint restores backed-up bytes/index and preserves both
  // ignored and external writes. Consent is tied to the reviewed token.
  const mixedRoot = join(temporary, 'mixed-workspace'), skippedExternal = join(temporary, 'external-unbacked.txt')
  await mkdir(mixedRoot)
  const git = (...args) => execFileSync('git', ['-C', mixedRoot, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
  git('init', '-q');await writeFile(join(mixedRoot, '.gitignore'), 'ignored.txt\n')
  await writeFile(join(mixedRoot, 'file.txt'), 'MIXED BEFORE\r\n')
  await writeFile(join(mixedRoot, 'ignored.txt'), 'IGNORED BEFORE\n')
  await writeFile(skippedExternal, 'EXTERNAL BEFORE\n')
  git('add', '.');git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture')
  const mixed = await restarted.buildSession(SessionManager.create(mixedRoot, sessionDir))
  await mixed.lifecyclePromise
  mixed.session.agent.streamFunction = session.agent.streamFunction
  let mixedStep = 0
  respond = () => ++mixedStep === 1 ? [
    { type: 'toolCall', name: 'write', id: 'mixed-covered', arguments: { path: 'file.txt', content: 'MIXED AFTER\n' } },
    { type: 'toolCall', name: 'write', id: 'mixed-ignored', arguments: { path: 'ignored.txt', content: 'IGNORED AFTER\n' } },
    { type: 'toolCall', name: 'write', id: 'mixed-external', arguments: { path: skippedExternal, content: 'EXTERNAL AFTER\n' } }
  ] : [{ type: 'text', text: 'Done mixed changes' }]
  await mixed.session.prompt('Change covered, excluded and external files');await mixed.rewind.idle()
  const mixedCheckpoint = value(await restarted.rewindList(mixed.path)).checkpoints[0]
  const indexBefore = await readFile(join(mixedRoot, '.git', 'index'))
  git('add', 'file.txt')
  const indexAfter = await readFile(join(mixedRoot, '.git', 'index'))
  const mixedLeaf = mixed.session.sessionManager.getLeafId()
  const mixedPreview = value(await restarted.rewindPreview(mixed.path, mixedCheckpoint.id))
  const expectedSkipped = [{ path: join(mixedRoot, 'ignored.txt'), reason: 'excluded' }, { path: skippedExternal, reason: 'outside-workspace' }]
  assert.deepEqual(mixedPreview.uncovered, expectedSkipped)
  assert(mixedPreview.changes.some(row=>row.area==='worktree')&&mixedPreview.changes.some(row=>row.area==='index'))
  const partialRequest = { sessionPath: mixed.path, token: mixedPreview.token, mode: 'files', operationId: randomUUID() }
  for (const skipUncovered of [undefined, false, 'true']) assert.equal((await restarted.rewindRestore({ ...partialRequest, skipUncovered })).error.code, 'uncovered')
  await assert.rejects(restarted.rewindClient.call('prepare', mixedRoot, mixed.session.sessionId, mixedPreview.token, 'files', randomUUID(), mixedLeaf, mixedLeaf, mixed.path, { uncovered: expectedSkipped, confirmed: false }), error=>error.code==='uncovered', 'worker also requires explicit consent')
  const partialFiles = value(await restarted.rewindRestore({ ...partialRequest, skipUncovered: true }))
  assert.deepEqual(partialFiles.operation.skipped, expectedSkipped)
  assert.equal(await readFile(join(mixedRoot, 'file.txt'), 'utf8'), 'MIXED BEFORE\r\n')
  assert.deepEqual(await readFile(join(mixedRoot, '.git', 'index')), indexBefore)
  assert.equal(mixed.session.sessionManager.getLeafId(), mixedLeaf, 'files-only keeps the full conversation')
  const assertSkipped = async () => {
    assert.equal(await readFile(join(mixedRoot, 'ignored.txt'), 'utf8'), 'IGNORED AFTER\n')
    assert.equal(await readFile(skippedExternal, 'utf8'), 'EXTERNAL AFTER\n')
  }
  await assertSkipped()
  assert.deepEqual(value(await restarted.rewindRestore({ ...partialRequest, skipUncovered: true })).operation.skipped, expectedSkipped, 'lost/repeated replies retain the recorded omissions')
  // A fresh host reads the durable omission metadata before Undo/Redo.
  await restarted.dispose()
  const cold = new PiManager(()=>{}, error=>{throw new Error(error)});apps.push(cold);cold.runtime=async()=>runtime
  const coldMixed = await cold.buildSession(SessionManager.open(mixed.path));await coldMixed.lifecyclePromise
  assert.deepEqual(value(await cold.rewindList(mixed.path)).operations.find(op=>op.id===partialFiles.operation.id).skipped, expectedSkipped)
  const undoPartial = value(await cold.rewindPreview(mixed.path, partialFiles.operation.id, 'undo'))
  assert.deepEqual(undoPartial.uncovered, expectedSkipped)
  const undoRequest = { sessionPath: mixed.path, token: undoPartial.token, mode: 'files', operationId: randomUUID() }
  assert.equal((await cold.rewindRestore(undoRequest)).error.code, 'uncovered')
  const undonePartial = value(await cold.rewindRestore({ ...undoRequest, skipUncovered: true }))
  assert.deepEqual(undonePartial.operation.skipped, expectedSkipped)
  assert.equal(await readFile(join(mixedRoot, 'file.txt'), 'utf8'), 'MIXED AFTER\n')
  assert.deepEqual(await readFile(join(mixedRoot, '.git', 'index')), indexAfter);await assertSkipped()
  const redoPartial = value(await cold.rewindPreview(mixed.path, undonePartial.operation.id, 'redo'))
  const redonePartial = value(await cold.rewindRestore({ sessionPath: mixed.path, token: redoPartial.token, mode: 'files', operationId: randomUUID(), skipUncovered: true }))
  assert.deepEqual(redonePartial.operation.skipped, expectedSkipped)
  assert.equal(await readFile(join(mixedRoot, 'file.txt'), 'utf8'), 'MIXED BEFORE\r\n');await assertSkipped()
  // Consent never bypasses a newer disk state; a new preview needs new consent.
  const stale = value(await cold.rewindPreview(mixed.path, mixedCheckpoint.id))
  await writeFile(join(mixedRoot, 'file.txt'), 'NEW EXTERNAL EDIT\n')
  assert.equal((await cold.rewindRestore({ sessionPath: mixed.path, token: stale.token, mode: 'all', operationId: randomUUID(), skipUncovered: true })).error.code, 'changed')
  const combinedPreview = value(await cold.rewindPreview(mixed.path, mixedCheckpoint.id))
  assert.equal((await cold.rewindRestore({ sessionPath: mixed.path, token: combinedPreview.token, mode: 'all', operationId: randomUUID() })).error.code, 'uncovered')
  const combined = value(await cold.rewindRestore({ sessionPath: mixed.path, token: combinedPreview.token, mode: 'all', operationId: randomUUID(), skipUncovered: true }))
  assert.deepEqual(combined.operation.skipped, expectedSkipped)
  assert.equal(await readFile(join(mixedRoot, 'file.txt'), 'utf8'), 'MIXED BEFORE\r\n');await assertSkipped()
  assert(!SessionManager.open(mixed.path).buildSessionContext().messages.some(message=>message.role==='user'), 'partial combined restore persists conversation selection')
  console.log('PASS: partial consent, raw files/index, preserved excluded/external bytes, cold history and Undo/Redo, stale-preview rejection and combined navigation')
  const active = cold.activeSession
  cold.checkoutCoordinator.markTerminalHostLost()
  assert.equal(value(await cold.rewindList(active.path)).error.code, 'terminal')
  await assert.rejects(cold.checkoutCoordinator.withExclusive(mixedRoot, 'restore', async () => assert.fail('must not restore')), error => error.code === 'terminal')
  const reopenedStore = new PiStore()
  reopenedStore.applySnapshot(cold.snapshot())
  cold.emit = (channel, event) => { if (channel === 'pi:event') reopenedStore.dispatch(event) }
  cold.emitSessionError(active, new RewindFailure('recovery', [], crashId))
  assert.deepEqual(reopenedStore.getState().error, { code: 'recovery', operationId: crashId })
  assert.equal(reopenedStore.getState().isStreaming, false)
  console.log('PASS: lost terminal host fences restores; session errors retain localized error codes')
} finally {
  for (const app of apps) await app.dispose()
  if (process.env.PI_REWIND_KEEP_TEST) console.log('Artifacts: ' + temporary)
  else await rm(temporary, { recursive: true, force: true })
}
