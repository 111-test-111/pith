/** Real SDK + app snapshot/store integration, entirely in a temporary profile. No model/network calls. */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
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
  const sdk = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))
  const outfile = join(temporary, 'modules.mjs')
  await build({ stdin: { contents: `export { PiManager } from './src/main/pi/manager';
export { TodoState, createTodoTool } from './src/main/pi/todo';
export * from './src/main/pi/todo-protocol';
export { PiStore } from './src/renderer/src/state/pi-store';
export { buildToolCatalog } from './src/main/pi/catalog';`, resolveDir: resolve('.') },
    bundle: true, platform: 'node', format: 'esm', outfile,
    plugins: [{ name: 'isolated-profile', setup(builder) {
      builder.onResolve({ filter: /^@earendil-works\/pi-coding-agent$/ }, () => ({ path: 'sdk', namespace: 'fixture' }))
      builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'fixture' }))
      builder.onResolve({ filter: /^proper-lockfile$|^@resvg\/resvg-js$/ }, args => ({ path: fileURLToPath(import.meta.resolve(args.path)), external: true }))
      builder.onResolve({ filter: /^playwright-core(\/|$)|^chromium-bidi(\/|$)/ }, (args) => {
        // Keep the test bundle out of the embedded browser's heavy optional
        // dependency graph. The browser service is loaded for its type surface
        // but never exercised in this check, so an absolute external boundary
        // is enough (matches how the SDK is handled above).
        try {
          return { path: fileURLToPath(import.meta.resolve(args.path)), external: true }
        } catch {
          return { path: args.path, external: true }
        }
      })
      builder.onResolve({ filter: /^\// }, (args) => args.path === sdk ? { path: sdk, external: true } : undefined)
      builder.onLoad({ filter: /^electron$/, namespace: 'fixture' }, () => ({ contents: `export const app={getPath:()=>${JSON.stringify(temporary)}};export const shell={};` }))
      builder.onLoad({ filter: /^sdk$/, namespace: 'fixture' }, () => ({ contents: `
export * from ${JSON.stringify(sdk)};
import {createAgentSessionServices as create,SettingsManager} from ${JSON.stringify(sdk)};
export const getAgentDir=()=>${JSON.stringify(agentDir)};
export function createAgentSessionServices(options){return create({...options,agentDir:getAgentDir(),settingsManager:SettingsManager.inMemory({compaction:{enabled:false},retry:{enabled:false}}),
resourceLoaderOptions:{...options.resourceLoaderOptions,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,
extensionFactories:[...(options.resourceLoaderOptions.extensionFactories??[]),{name:'fixture-transform',hidden:true,factory:pi=>{
pi.on('tool_result',e=>{if(e.toolName==='todo_write'&&e.input.todos[0]?.content==='Rejected by extension')return {isError:true};});
}}]}})};` }))
    } }]
  })
  const { PiManager, PiStore, TodoState, createTodoTool, parseTodoResult, normalizeTodoItems, reconstructTodos, buildToolCatalog } = await import(pathToFileURL(outfile).href)
  const legacy = { role: 'toolResult', toolName: 'todo_write', toolCallId: 'legacy-call', isError: false,
    details: { kind: 'pi-web-todo', todos: [{ content: '  Old task  ', status: 'in_progress', activeForm: { invalid: true }, unknown: true }] } }
  assert.equal(parseTodoResult({ ...legacy, isError: true }), null)
  assert.equal(parseTodoResult({ ...legacy, toolName: 'bash' }), null)
  assert.equal(parseTodoResult({ ...legacy, details: { kind: 'pi-app-todo', version: 99, todos: [] } }), null)
  const old = parseTodoResult(legacy)
  assert.equal(old.items[0].content, 'Old task'); assert.equal(old.items[0].activeForm, undefined)
  assert.deepEqual(parseTodoResult(legacy), old, 'legacy IDs are deterministic')
  assert.equal(normalizeTodoItems([{ id: 'x', content: 'a', status: 'pending' }, { id: 'x', content: 'b', status: 'pending' }]), null)
  assert.equal(normalizeTodoItems(Array.from({ length: 101 }, () => ({ content: 'a', status: 'pending' }))), null)
  const memory = SessionManager.inMemory(project)
  const state = new TodoState(memory), tool = createTodoTool(state, () => true)
  await assert.rejects(tool.execute('invalid', { todos: [{ content: 'a', status: 'in_progress' }, { content: 'b', status: 'in_progress' }] }), /at most one/i)
  await assert.rejects(tool.execute('abort', { todos: [] }, AbortSignal.abort()), /cancelled/i)
  const first = await tool.execute('one', { todos: [{ content: 'a', status: 'in_progress' }, { content: 'b', status: 'pending' }] })
  const result = (id, details, isError = false) => ({ role: 'toolResult', toolName: 'todo_write', toolCallId: id, details, isError, content: [], timestamp: Date.now() })
  assert.equal(state.snapshot, null, 'execute alone never commits state')
  state.observe({ type: 'message_end', message: result('one', first.details) })
  const ids = state.snapshot.items.map((item) => item.id)
  const renamed = await tool.execute('two', { todos: [{ id: ids[1], content: 'renamed', status: 'cancelled' }, { content: 'a', status: 'completed' }] })
  assert.deepEqual(renamed.details.todos.map((item) => item.id), [ids[1], ids[0]], 'rename/reorder and omitted IDs preserve identity')
  state.observe({ type: 'message_end', message: result('rejected', renamed.details, true) })
  assert.equal(state.snapshot.toolCallId, 'one')
  const finishedResult = result('finished', renamed.details)
  const clearedResult = result('cleared', { kind: 'pi-app-todo', version: 1, todos: [] })
  state.observe({ type: 'message_end', message: finishedResult })
  state.observe({ type: 'message_end', message: clearedResult })
  assert.deepEqual(state.snapshot.items, [], 'retained tasks are not active work')
  assert.deepEqual(state.snapshot.retainedItems, renamed.details.todos, 'completed/cancelled tasks remain reviewable')
  const history = [finishedResult, clearedResult, { ...clearedResult, toolCallId: 'cleared-again' }].map((message) => ({ type: 'message', message }))
  assert.deepEqual(reconstructTodos(history).retainedItems, renamed.details.todos, 'repeated clears preserve the last finished list')
  const replacement = result('new-plan', first.details)
  assert.equal(reconstructTodos([...history, { type: 'message', message: replacement }]).retainedItems, undefined)
  state.observe({ type: 'message_end', message: replacement })
  assert.equal(state.snapshot.retainedItems, undefined, 'a new list replaces retained history')
  state.observe({ type: 'message_end', message: clearedResult })
  assert.deepEqual(state.snapshot.retainedItems, first.details.todos, 'clearing unfinished work retains its original statuses')
  const replacementHistory = [...history, { type: 'message', message: replacement }, { type: 'message', message: clearedResult }]
  assert.deepEqual(reconstructTodos(replacementHistory), state.snapshot, 'restore retains the latest unfinished replacement, never an older finished plan')
  state.observe({ type: 'message_end', message: { ...clearedResult, toolCallId: 'clear-again' } })
  assert.deepEqual(state.snapshot.retainedItems, first.details.todos, 'repeated clears keep unfinished review history')
  assert.deepEqual(reconstructTodos([{ type: 'message', message: clearedResult }]), { toolCallId: 'cleared', items: [] }, 'an empty-only branch has no review history')
  // Same-batch callback ordering must not freshen unseen results, including custom tails.
  for (const order of ['activity-first', 'todo-first']) {
    const local = new TodoState(memory), handlers = new Map()
    local.extension().factory({ on: (name, handler) => handlers.set(name, handler) })
    const todoEnd = () => local.observe({ type: 'message_end', message: result('same-batch', first.details) })
    if (order === 'activity-first') { local.activityOccurred(); todoEnd() } else { todoEnd(); local.activityOccurred() }
    const input = [{ role: 'custom', customType: 'bash_task_completion', content: 'finished', display: true, timestamp: 1 }]
    const context = handlers.get('context')({ messages: input })
    assert.match(context.messages.at(-1).content, /changed a task's status or scope/)
    assert.match(context.messages.at(-1).content, /Never restate, summarize or acknowledge this list/)
    assert.equal(input.length, 1, 'reminder never changes the original context')
    assert.equal(handlers.get('context')({ messages: input }), undefined, 'no duplicate reminder without activity')
    assert.equal(handlers.has('agent_settled'), false, 'no automatic todo wakeups')
  }
  console.log('PASS: sanitized/failed/legacy inputs, bounds, cancellation, stable IDs and freshness ordering.')

  const runtime = await ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: join(agentDir, 'models.json'), modelsStorePath: join(agentDir, 'models-store'), refreshOnCreate: false })
  runtime.hasConfiguredAuth = () => true
  runtime.checkAuth = () => { throw new Error('Unexpected credential access') }
  const model = { id: 'fixture', name: 'fixture', provider: 'fixture', api: 'openai-completions', baseUrl: 'http://127.0.0.1:1', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 4096 }
  runtime.getAvailableSnapshot = () => [model]
  const store = new PiStore()
  const app = new PiManager((channel, event) => { if (channel === 'pi:event') store.dispatch(event) }, (error) => { throw new Error(error) }); apps.push(app)
  app.runtime = async () => runtime
  const manager = SessionManager.create(project, join(temporary, 'sessions'))
  const managed = await app.buildSession(manager)
  const { session } = managed
  store.applySnapshot(app.snapshot())
  let time = Date.now(), requests = 0
  const contexts = []
  let respond = () => [{ type: 'text', text: 'done' }]
  session.agent.streamFunction = (_model, context) => {
    requests++; contexts.push(JSON.parse(JSON.stringify(context)))
    const content = respond(requests, context)
    const message = { role: 'assistant', content, provider: 'fixture', model: 'fixture', api: 'openai-completions', stopReason: content.some((c) => c.type === 'toolCall') ? 'toolUse' : 'stop', timestamp: ++time,
      usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }
    return { async *[Symbol.asyncIterator]() { yield { type: 'start', partial: { ...message, content: [] } }; yield { type: 'done', message } }, result: async () => message }
  }
  const write = (id, todos) => [{ type: 'toolCall', name: 'todo_write', id, arguments: { todos } }]
  respond = (n) => n === 1 ? write('sdk-create', [{ content: 'Run checks', status: 'in_progress' }, { content: 'Review', status: 'pending' }]) : [{ type: 'text', text: 'Working' }]
  await session.prompt('Track the work')
  assert.equal(requests, 2, JSON.stringify(session.messages))
  assert.equal(managed.todos.snapshot.toolCallId, 'sdk-create')
  assert.deepEqual(store.getState().todos, app.snapshot().todos, 'committed events and snapshot agree')
  const requestSystem = contexts[0].messages.filter((message) => message.role === 'system')
  assert(requestSystem.flatMap((message) => message.toolsAdded ?? []).some((tool) => tool.name === 'todo_write'))
  const requestPrompt = requestSystem.map((message) => [message.content, ...Object.values(message.sections ?? {})].join('\n')).join('\n')
  assert.match(requestPrompt, /at most one item in_progress/)
  assert.match(requestPrompt, /do not repeat or acknowledge the list in prose/)
  const original = structuredClone(managed.todos.snapshot)
  const catalog = buildToolCatalog(managed.resourceLoader, session.getAllTools(), session.getActiveToolNames(), new Set(), new Map(), new Map())
  assert.equal(catalog.tools.find((t) => t.name === 'todo_write')?.source.kind, 'builtin')
  assert(!catalog.extensions.some((e) => /todo-context/.test(e.name)))
  // Another extension can turn a successful execute into a failed final result.
  let next = true
  respond = () => { if (next) { next = false; return write('sdk-rejected', [{ content: 'Rejected by extension', status: 'completed' }]) } return [{ type: 'text', text: 'Rejected correctly' }] }
  await session.prompt('try rejected update')
  assert.deepEqual(managed.todos.snapshot, original)
  assert(session.messages.some((m) => m.role === 'toolResult' && m.toolCallId === 'sdk-rejected' && m.isError))

  const kept = manager.appendMessage({ role: 'user', content: 'keep this recent message', timestamp: ++time })
  manager.appendCompaction('Earlier work summarized', kept, 2000)
  session.agent.state.messages = manager.buildSessionContext().messages
  assert(!session.messages.some((m) => m.role === 'toolResult' && m.toolName === 'todo_write'))
  assert.deepEqual(app.snapshot().todos, original, 'compaction never removes task state')
  await session.reload()
  assert.deepEqual(managed.todos.snapshot, original, 'reload reconstructs full branch')
  const savedPath = session.sessionFile
  assert.deepEqual(reconstructTodos(SessionManager.open(savedPath).getBranch()), original, 'disk reopen survives compaction')
  const forkPath = SessionManager.open(savedPath).createBranchedSession(manager.getLeafId())
  assert.deepEqual(reconstructTodos(SessionManager.open(forkPath).getBranch()), original, 'fork inherits selected branch state')
  respond = () => [{ type: 'text', text: 'Background results checked' }]
  const beforeWake = requests
  await session.sendCustomMessage({ customType: 'bash_task_completion', content: 'Tests exited 0', display: true }, { deliverAs: 'steer', triggerTurn: true })
  assert.equal(requests, beforeWake + 1, 'todo creates no extra provider turns')
  assert.match(JSON.stringify(contexts.at(-1).messages), /Current task list/)
  assert.doesNotMatch(await readFile(savedPath, 'utf8'), /<system-reminder>|Current task list/, 'ephemeral reminder is never persisted')
  assert(!store.getState().messages.some((m) => JSON.stringify(m).includes('<system-reminder>')))

  // Finishing retains every row, including when the model clears its active list afterwards.
  const finishedItems = original.items.map((item) => ({ ...item, status: 'completed' }))
  next = true
  respond = () => { if (next) { next = false; return write('sdk-finished', finishedItems) } return [{ type: 'text', text: 'Finished' }] }
  await session.prompt('finish every task')
  assert.deepEqual(store.getState().todos.items, finishedItems)
  // Clear is authoritative for active work; completed rows remain UI history.
  next = true
  respond = () => { if (next) { next = false; return write('sdk-clear', []) } return [{ type: 'text', text: 'Cleared' }] }
  await session.prompt('clear the list')
  assert.deepEqual(store.getState().todos.items, [])
  assert.deepEqual(reconstructTodos(manager.getBranch()).items, [])
  assert.deepEqual(store.getState().todos.retainedItems, finishedItems)
  assert.deepEqual(reconstructTodos(SessionManager.open(savedPath).getBranch()).retainedItems, finishedItems, 'reopening retains completed rows')
  await session.reload()
  assert.deepEqual(app.snapshot().todos.retainedItems, finishedItems)
  await session.sendCustomMessage({ customType: 'bash_task_completion', content: 'Already handled', display: true }, { deliverAs: 'steer', triggerTurn: true })
  assert.doesNotMatch(JSON.stringify(contexts.at(-1).messages), /Current task list/, 'retained rows never become task reminders')
  // Screenshot regression: create three todos, update only some, then clear as a tool test.
  const testItems = ['in_progress', 'pending', 'pending'].map((status, i) => ({ id: `test-${i + 1}`, content: `Test step ${i + 1}`, status }))
  const updatedItems = testItems.map((item, i) => ({ ...item, status: i === 2 ? 'in_progress' : 'completed' }))
  let testStep = 0
  respond = () => {
    const lists = [testItems, updatedItems, [], []]
    return testStep < lists.length ? write(`sdk-test-${testStep}`, lists[testStep++]) : [{ type: 'text', text: 'Tool test finished' }]
  }
  await session.prompt('test create, update and clear')
  const retainedTest = { toolCallId: 'sdk-test-3', items: [], retainedItems: updatedItems }
  assert.deepEqual(store.getState().todos, retainedTest, 'clearing before all todos finish keeps their entry data through agent_settled')
  assert.deepEqual(app.snapshot().todos, retainedTest)
  assert.deepEqual(reconstructTodos(SessionManager.open(savedPath).getBranch()), retainedTest, 'old persisted create/update/clear histories restore without migration')
  const retainedFork = SessionManager.open(savedPath).createBranchedSession(manager.getLeafId())
  assert.deepEqual(reconstructTodos(SessionManager.open(retainedFork).getBranch()), retainedTest, 'fork retains review data on its selected branch')
  const afterTest = manager.appendMessage({ role: 'user', content: 'keep after the cleared test', timestamp: ++time })
  manager.appendCompaction('Tool test summarized', afterTest, 2000)
  session.agent.state.messages = manager.buildSessionContext().messages
  await session.reload()
  assert.deepEqual(app.snapshot().todos, retainedTest, 'compaction and reload preserve unfinished review history')
  await session.sendCustomMessage({ customType: 'bash_task_completion', content: 'Unrelated later completion', display: true }, { deliverAs: 'steer', triggerTurn: true })
  assert.doesNotMatch(JSON.stringify(contexts.at(-1).messages), /Current task list/, 'retained unfinished rows never restart active task reminders')
  // Manual leaf rewind path bypasses session_tree; the manager must restore it.
  const leafTime = Date.now() + 60000
  const leafUser = manager.appendMessage({ role: 'user', content: 'retry me', timestamp: leafTime })
  session.agent.state.messages = manager.buildSessionContext().messages
  respond = () => [{ type: 'text', text: 'Retried' }]
  const beforeRetry = requests
  await app.resendMessage({ timestamp: leafTime, text: 'retry me', images: [] })
  await until(() => requests > beforeRetry && session.isIdle)
  assert.notEqual(manager.getLeafId(), leafUser)
  assert.deepEqual(app.snapshot().todos.items, [])
  assert.deepEqual(app.snapshot().todos.retainedItems, updatedItems, 'retry preserves cleared review history on this branch')
  // Navigate before all todo writes restores no list on the selected branch.
  const firstUser = manager.getBranch().find((e) => e.type === 'message' && e.message.role === 'user')
  await session.navigateTree(firstUser.id)
  await session.prompt('restart')
  await until(() => requests > beforeRetry && session.isIdle)
  assert.equal(app.snapshot().todos, null)
  assert.equal(store.getState().todos, null)
  // The independently copied fork remains untouched.
  assert.deepEqual(reconstructTodos(SessionManager.open(forkPath).getBranch()), original)
  const other = await app.buildSession(SessionManager.create(project, join(temporary, 'other')))
  assert.equal(other.todos.snapshot, null, 'sessions with the same cwd never share todo state')
  console.log('PASS: real SDK registration, catalog, committed events, extension rejection, compaction/reload/disk/fork, custom wake, clear, retries and session isolation.')

  const cached = new PiStore()
  const snapshot = { ...app.snapshot(), sessionPath: '/a', eventSequence: 1, todos: original }
  cached.applySnapshot(snapshot)
  cached.dispatch({ type: 'message_end', sessionPath: '/b', eventSequence: 3, message: result('clear', { kind: 'pi-app-todo', version: 1, todos: [] }), todos: { toolCallId: 'clear', items: [] } })
  cached.applySnapshot({ ...snapshot, sessionPath: '/b', eventSequence: 2 })
  assert.deepEqual(cached.getState().todos.items, [], 'events newer than the snapshot replay')
  cached.dispatch({ type: 'agent_start', sessionPath: '/b', eventSequence: 1, todos: original })
  assert.deepEqual(cached.getState().todos.items, [], 'old events cannot overwrite tasks')
  cached.dispatch({ type: 'compaction_end', sessionPath: '/b', eventSequence: 4, messages: [] })
  assert.deepEqual(cached.getState().todos.items, [])
  cached.applySnapshot(snapshot)
  assert.deepEqual(cached.getState().todos, original, 'switching sessions restores its own cached list')
  console.log('PASS: renderer snapshot races, stale events, compaction and session cache.')
} finally {
  await Promise.all(apps.map((app) => app.dispose()))
  await rm(temporary, { recursive: true, force: true })
}
