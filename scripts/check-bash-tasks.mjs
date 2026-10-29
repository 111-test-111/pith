/** Managed processes + real SDK steering. No credentials, network or real sessions. */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile, stat, open } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { createExtensionRuntime, createSyntheticSourceInfo, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent'

const temporary = await mkdtemp(join(tmpdir(), 'pith-bash-check-'))
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const until = async (predicate, label, ms = 10000) => {
  const end = Date.now() + ms
  while (!predicate()) { assert(Date.now() < end, label); await delay(10) }
}
const quote = (text) => `'${text.replaceAll("'", "'\\''")}'`
const nodeCommand = (js) => `${quote(process.execPath)} -e ${quote(js)}`
const requestTools = (context) => {
  const tools = new Map()
  for (const message of context.messages) {
    if (message.role !== 'system') continue
    for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name)
    for (const tool of message.toolsAdded ?? []) tools.set(tool.name, tool)
  }
  return [...tools.values()]
}
const requestPrompt = (context) => context.messages
  .filter((message) => message.role === 'system')
  .map((message) => [message.content, ...Object.values(message.sections ?? {})].join('\n'))
  .join('\n')
let tasks
const sessions = []
try {
  const outfile = join(temporary, 'modules.mjs')
  await build({
    stdin: { contents: `export { BashTaskManager } from './src/main/bash/manager';
export { createManagedBashTools } from './src/main/pi/bash-tools';
export { ChangeScopes } from './src/main/pi/change-scopes';
export { PiManager } from './src/main/pi/manager';
export { CheckoutCoordinator } from './src/main/rewind/coordinator';`, resolveDir: resolve('.') },
    bundle: true, platform: 'node', format: 'esm', outfile,
    plugins: [{ name: 'isolated-runtime', setup(builder) {
      builder.onResolve({ filter: /^@earendil-works\/pi-coding-agent$/ }, () => ({
        path: fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')), external: true
      }))
      builder.onResolve({ filter: /^playwright-core(\/|$)/ }, args => ({ path: fileURLToPath(import.meta.resolve(args.path)), external: true }))
      builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'fixture' }))
      builder.onResolve({ filter: /^proper-lockfile$|^@resvg\/resvg-js$/ }, args => ({ path: fileURLToPath(import.meta.resolve(args.path)), external: true }))
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents:
        `export const app = { getPath() { return ${JSON.stringify(temporary)} } }; export const shell = {};` }))
    } }]
  })
  const { BashTaskManager, createManagedBashTools, ChangeScopes, PiManager, CheckoutCoordinator } = await import(pathToFileURL(outfile).href)
  const changes = [], completions = []
  const outboxes = new Map()
  tasks = new BashTaskManager(join(temporary, 'tasks'), (task) => changes.push(task), (task) => {
    completions.push(task)
    outboxes.get(task.sessionPath)?.complete(task)
  })
  const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } })
  const services = { cwd: temporary, settingsManager: settings }
  const owner = { sessionId: 'session-a', sessionPath: '/fixture/a' }
  // Sandboxing is its own check (scripts/check-sandbox.mjs); this fixture is
  // about task lifecycle, so it runs unconfined on purpose.
  const tools = createManagedBashTools({ tasks, services, ...owner, maxWaitMs: () => 120, sandboxMode: () => 'danger-full-access', canStart: () => true })
  const context = { cwd: temporary, thinkingLevel: 'off', model: { provider: 'fixture', id: 'fixture' } }
  const run = (id, args, signal) => tools[0].execute(id, args, signal, () => {}, context)
  const fast = await run('fast', { command: 'printf fast' })
  assert.equal(fast.details.bashTask.status, 'succeeded')
  assert.equal(fast.details.bashTask.background, false)
  assert.equal(JSON.parse(fast.content[0].text).guidance, undefined, 'foreground output must not suggest waiting for a notification')
  assert.equal(completions.length, 0)

  const once = join(temporary, 'once')
  const begin = Date.now()
  const background = await run('threshold', { command: nodeCommand(`require('fs').appendFileSync(${JSON.stringify(once)},'once'); console.log('first'); setTimeout(()=>console.log('last 中文😀'),350)`), waitMs: 60_000 })
  const id = background.details.bashTask.id
  assert(Date.now() - begin < 320, 'model cannot override the app blocking ceiling')
  assert.equal(background.details.bashTask.reason, 'wait_threshold')
  assert.equal(background.details.bashTask.status, 'running')
  assert.match(JSON.parse(background.content[0].text).guidance, /completion status and recent output will arrive automatically/)
  const runningStatus = await tools[1].execute('pending-status', { action: 'status', taskId: id })
  assert.match(JSON.parse(runningStatus.content[0].text).guidance, /Do not launch sleep, delayed tail/)
  const before = tasks.output(owner.sessionPath, id)
  await tasks.wait(owner.sessionPath, id)
  const after = tasks.output(owner.sessionPath, id, before.cursor)
  const completedStatus = await tools[1].execute('completed-status', { action: 'status', taskId: id })
  assert.equal(JSON.parse(completedStatus.content[0].text).guidance, undefined, 'completed tasks must not tell the model to wait')
  assert.match(after.output, /last 中文😀/)
  assert.equal(await readFile(once, 'utf8'), 'once', 'detaching must never respawn')
  assert.equal(completions.filter((task) => task.id === id).length, 1)
  assert.throws(() => tasks.get('/fixture/b', id), /Unknown task/)
  assert.throws(() => tasks.output(owner.sessionPath, id, -1), /cursor/)

  const explicit = await run('background', { command: nodeCommand('setTimeout(()=>{},400)'), mode: 'background' })
  assert.equal(explicit.details.bashTask.reason, 'requested')
  const liveLog = await tasks.logOutput(owner.sessionPath, explicit.details.bashTask.id)
  assert.equal(liveLog.eof, false); assert.equal(liveLog.complete, false)
  assert.equal(liveLog.output, '', 'an immediate log read handles a newly opened, silent task')
  await tasks.wait(owner.sessionPath, explicit.details.bashTask.id)
  assert.equal(tasks.get(owner.sessionPath, explicit.details.bashTask.id).lastOutputAt, undefined, 'silent completion is not an output event')

  // Hold an in-flight file read after its initial size observation. The real
  // process then writes a final chunk and exits before that read returns.
  const releaseLog = join(temporary, 'release-log')
  const prefix = 'before 中文😀\n', suffix = 'after 中文😀\n'
  const racing = await run('log-eof-race', { command: nodeCommand(`process.stdout.write(${JSON.stringify(prefix)});const timer=setInterval(()=>{if(require('fs').existsSync(${JSON.stringify(releaseLog)})){clearInterval(timer);process.stdout.write(${JSON.stringify(suffix)});}},10)`), mode: 'background' })
  const raceTask = racing.details.bashTask
  await until(() => statSync(raceTask.logPath, { throwIfNoEntry: false })?.size === Buffer.byteLength(prefix), 'initial log prefix persisted')
  const handle = await open(raceTask.logPath, 'r')
  const prototype = Object.getPrototypeOf(handle), originalRead = prototype.read
  let held = false
  prototype.read = async function (...args) {
    const result = await originalRead.apply(this, args)
    if (!held) {
      held = true
      await writeFile(releaseLog, '')
      await tasks.wait(owner.sessionPath, raceTask.id)
    }
    return result
  }
  let racePage
  try { racePage = await tasks.logOutput(owner.sessionPath, raceTask.id) }
  finally { prototype.read = originalRead; await handle.close() }
  assert.equal(held, true)
  assert.equal(racePage.task.status, 'succeeded')
  assert.equal(racePage.output, prefix)
  assert.equal(racePage.eof, false, 'a command finishing during a log read cannot turn the old file size into EOF')
  assert.equal(racePage.complete, false)
  assert.equal(racePage.hasMore, true)
  assert.equal(racePage.availableBytes, Buffer.byteLength(prefix + suffix))
  const finalPage = await tasks.logOutput(owner.sessionPath, raceTask.id, racePage.nextByteOffset)
  assert.equal(racePage.output + finalPage.output, prefix + suffix)
  assert.equal(finalPage.eof, true)
  assert.equal(finalPage.hasMore, false)

  const control = new AbortController()
  const independent = await run('signal-ownership', { command: nodeCommand('setTimeout(()=>console.log("survived"),250)'), mode: 'background' }, control.signal)
  control.abort()
  await tasks.wait(owner.sessionPath, independent.details.bashTask.id)
  assert.equal(tasks.get(owner.sessionPath, independent.details.bashTask.id).status, 'succeeded', 'a returned call does not own the process abort signal')

  const failure = await run('failure', { command: 'printf broken >&2; exit 7' })
  assert.equal(failure.isError, true)
  assert.equal(failure.structuredContent.error.code, 'COMMAND_FAILED')
  assert.equal(failure.structuredContent.data.task.exitCode, 7)
  const timeout = await run('timeout', { command: nodeCommand('setInterval(()=>{},1000)'), timeout: 0.25 })
  await tasks.wait(owner.sessionPath, timeout.details.bashTask.id)
  assert.equal(tasks.get(owner.sessionPath, timeout.details.bashTask.id).status, 'timed_out')
  const childFile = join(temporary, 'child-pid')
  const parent = await run('tree', { command: nodeCommand(`const {spawn}=require('child_process');const c=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{stdio:'inherit'});require('fs').writeFileSync(${JSON.stringify(childFile)},String(c.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000)`), mode: 'background' })
  await delay(180)
  const childPid = Number(await readFile(childFile, 'utf8'))
  await tasks.stop(owner.sessionPath, parent.details.bashTask.id)
  assert.equal(tasks.get(owner.sessionPath, parent.details.bashTask.id).status, 'cancelled')
  assert.equal(tasks.get(owner.sessionPath, parent.details.bashTask.id).lastOutputAt, undefined, 'stopping a silent process must not invent output')
  await until(() => { try { process.kill(childPid, 0); return false } catch { return true } }, 'grandchild killed', 3000)

  const huge = await run('bounded', { command: nodeCommand('process.stdout.write("x".repeat(10*1024*1024));console.log("END中文😀")'), mode: 'background' })
  await tasks.wait(owner.sessionPath, huge.details.bashTask.id)
  const bounded = tasks.output(owner.sessionPath, huge.details.bashTask.id, 0, 65536)
  assert(bounded.output.length <= 65536)
  assert(bounded.truncated && bounded.task.logTruncated)
  assert.match(bounded.output, /END中文😀/)
  assert((await stat(bounded.task.logPath)).size <= 8 * 1024 * 1024)
  const logPage = await tasks.logOutput(owner.sessionPath, huge.details.bashTask.id, 8 * 1024 * 1024 - 100, 100)
  assert.equal(logPage.source, 'log'); assert.equal(logPage.cursorUnit, 'utf8')
  assert.equal(logPage.eof, true); assert.equal(logPage.truncated, true); assert.equal(logPage.complete, false)
  await assert.rejects(tasks.logOutput('/another-session', huge.details.bashTask.id), /Unknown task/)
  const unicodeLog = await run('unicode-log-cap', { command: nodeCommand('process.stdout.write("x".repeat(8*1024*1024-1)+"😀");setTimeout(()=>console.log("END"),10)'), mode: 'background' })
  await tasks.wait(owner.sessionPath, unicodeLog.details.bashTask.id)
  const unicodePage = await tasks.logOutput(owner.sessionPath, unicodeLog.details.bashTask.id, 8 * 1024 * 1024 - 20, 100)
  assert.equal(unicodePage.availableBytes, 8 * 1024 * 1024 - 1, 'the log cap must not cut a Unicode character or resume after a gap')
  assert.equal(unicodePage.truncated, true); assert.equal(unicodePage.eof, true)
  assert.equal(unicodePage.output, 'x'.repeat(19))
  const stopped = new AbortController()
  stopped.abort()
  await assert.rejects(run('pre-abort', { command: 'exit 0' }, stopped.signal), /cancelled/)
  const failedSpawn = await tasks.start({ ...owner, toolCallId: 'spawn-error', command: 'x', cwd: temporary, shell: '/not-a-shell', args: ['-c'], env: {} })
  assert.equal(failedSpawn.status, 'failed')
  console.log('PASS: foreground, forced/explicit background, one process, output cursors/Unicode, failure/timeout, cancellation, process tree, bounded logs and completion-during-read EOF.')

  // Use the real SDK event loop and replace only its model stream. Every
  // request is deterministic, and no API call or credential lookup is made.
  const runtime = await ModelRuntime.create({ authPath: join(temporary, 'auth.json'), modelsPath: join(temporary, 'models.json'), modelsStorePath: join(temporary, 'models-store'), refreshOnCreate: false })
  runtime.hasConfiguredAuth = () => true
  runtime.checkAuth = () => { throw new Error('Unexpected auth access') }
  const model = { id: 'fixture', name: 'fixture', provider: 'fixture', api: 'openai-completions', baseUrl: 'http://127.0.0.1:1', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 4096 }
  runtime.getAvailableSnapshot = () => [model]
  const loader = {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }), getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => undefined, getSystemPromptSource: () => undefined, getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [], extendResources: () => {}, reload: async () => {}
  }
  let messageTime = Date.now()
  const message = (content) => ({ role: 'assistant', content, provider: 'fixture', model: 'fixture', api: 'openai-completions', stopReason: content.some((c) => c.type === 'toolCall') ? 'toolUse' : 'stop',
    timestamp: ++messageTime, usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } })
  const stream = (final, wait = 0, during) => ({
    async *[Symbol.asyncIterator]() {
      yield { type: 'start', partial: { ...final, content: [] } }
      await during?.()
      if (wait) await delay(wait)
      yield { type: 'done', message: final }
    }, result: async () => final
  })
  const setup = async (name, respond, resourceLoader = loader) => {
    const sessionManager = SessionManager.create(temporary, join(temporary, name))
    const path = sessionManager.getSessionFile()
    // Exercise the production registration/binding path. A hand-picked SDK
    // active list missed duplicate bash entries in PiManager.buildSession.
    const app = Object.create(PiManager.prototype)
    // This constructor-free fixture keeps Jev explicitly off and network-free.
    app.jevPreferences = { mode: 'off', choice: true, score: true, noul: true }
    app.trajectory = { write: async () => {}, settle: async () => {}, dispose: async () => {} }
    app.jevService = { enabledQuestionTypes: () => [], cancel() {}, dispose() {} }
    app.checkoutCoordinator = new CheckoutCoordinator()
    app.rewindClient = { call: async () => { throw new Error('Checkpoint storage is outside this fixture') } }
    const routed = []
    app.emit = (_channel, event) => { routed.push(event) }
    app.sessions = new Map()
    app.planSequences = new Map()
    app.sessionBuilds = new Map()
    app.disabledExtensions = new Set()
    app.navigationEpoch = 0
    app.bashMaxWaitMs = 80
    app.commandTasksInstance = tasks
    app.servicesFor = async () => ({ ...services, agentDir: temporary, resourceLoader, modelRuntime: runtime })
    app.activateSession = (managed) => { app.activeSession = managed }
    const managed = await app.buildSession(sessionManager, false)
    await managed.lifecyclePromise
    const { session, notifications: outbox } = managed
    sessions.push(session)
    outboxes.set(path, outbox)
    const activeNames = session.getActiveToolNames()
    assert.equal(activeNames.length, new Set(activeNames).size, `app session has duplicate active tools: ${activeNames}`)
    const events = []
    session.subscribe((event) => { events.push(event) })
    let calls = 0
    session.agent.streamFunction = (_model, context, options) => {
      const names = requestTools(context).map((tool) => tool.name)
      assert.equal(names.length, new Set(names).size, `model request has duplicate tools: ${names}`)
      return respond(++calls, context, options, { session, outbox, path, managed })
    }
    return { session, outbox, path, events, routed, app, calls: () => calls }
  }
  const text = (value) => [{ type: 'text', text: value }]
  const call = (id, command, mode = 'blocking') => ({ type: 'toolCall', id, name: 'bash', arguments: { command, mode } })
  const extensionPath = join(temporary, 'fixture-extension.ts')
  const extensionRuntime = createExtensionRuntime()
  const sourceInfo = createSyntheticSourceInfo(extensionPath, { source: 'fixture' })
  const extension = { path: extensionPath, resolvedPath: extensionPath, sourceInfo,
    handlers: new Map(), tools: new Map(), messageRenderers: new Map(), commands: new Map(), flags: new Map(), shortcuts: new Map() }
  extension.handlers.set('session_start', [() => {
    for (const name of ['bash', 'read', 'extension_probe']) {
      extension.tools.set(name, { sourceInfo, definition: { name, label: name, description: `fixture ${name}`,
        parameters: { type: 'object', properties: {} },
        execute: async () => {
          assert.notEqual(name, 'bash', 'app bash must override the extension bash definition')
          return { content: text(`extension ${name}`), details: {} }
        } } })
      extensionRuntime.refreshTools() // SDK registerTool() refreshes after updating this map.
    }
  }])
  const extensionLoader = { ...loader,
    getExtensions: () => ({ extensions: [extension], errors: [], runtime: extensionRuntime }) }
  const registration = await setup('tool-registration', (n, context) => {
    const tools = requestTools(context)
    const prompt = requestPrompt(context)
    assert.match(tools.find((tool) => tool.name === 'bash').description, /threshold/)
    // Check the actual SDK/model boundary, including the request after reload:
    // putting guidelines on a tool object alone does not prove they reach it.
    assert.match(prompt, /end (?:the current |the )response/i)
    assert.match(prompt, /sleep.*tail.*polling/)
    assert.match(tools.find((tool) => tool.name === 'bash').description, /same command keeps running/)
    assert.match(tools.find((tool) => tool.name === 'bash_task').description, /bounded tail/)
    assert.equal(tools.find((tool) => tool.name === 'read').description, 'fixture read')
    assert(tools.some((tool) => tool.name === 'extension_probe'), 'session_start tools remain enabled')
    return stream(message(n === 1 ? [call('registered-bash', 'printf managed-bash'),
      { type: 'toolCall', id: 'registered-extension', name: 'extension_probe', arguments: {} },
      { type: 'toolCall', id: 'registered-read', name: 'read', arguments: {} }] : text('registration verified')))
  }, extensionLoader)
  await registration.session.prompt('check tool registration')
  assert.equal(registration.calls(), 2, JSON.stringify(registration.session.messages.at(-1)))
  const registeredResults = registration.session.messages.filter((message) => message.role === 'toolResult')
  assert.equal(registeredResults.length, 3)
  assert(registeredResults.every((result) => !result.isError))
  assert.equal(registeredResults.find((result) => result.toolName === 'bash').details.bashTask.status, 'succeeded')
  assert.equal(registeredResults.find((result) => result.toolName === 'read').content[0].text, 'extension read')
  await registration.session.reload()
  await registration.session.prompt('check tools after reload')
  assert.equal(registration.calls(), 3)
  console.log('PASS: production model requests have unique tools and explicit yield/no-sleep guidance, including after reload; overrides and lazy tools are preserved.')

  const immediate = await setup('immediate', (n, context) => {
    if (n === 1) return stream(message([call('notify-1', nodeCommand('setTimeout(()=>console.log("DONE_TOKEN"),140)'), 'background')]))
    if (n === 2) return stream(message([call('other-work', nodeCommand('setTimeout(()=>console.log("other"),60)'))]), 180)
    assert(context.messages.some((msg) => JSON.stringify(msg).includes('DONE_TOKEN')), 'completion must be in the next request BEFORE the model emits a final answer')
    return stream(message(text('checked completion')))
  })
  await immediate.session.prompt('run and continue independent work')
  assert.equal(immediate.calls(), 3)
  const notificationEvents = immediate.events.filter((event) => event.type === 'message_end' && event.message.role === 'custom')
  assert.equal(notificationEvents.length, 1)
  assert.match(immediate.session.systemPrompt, /STEERING/)
  assert.match(immediate.session.getAllTools().find((tool) => tool.name === 'bash').description, /threshold/)
  assert(immediate.session.getAllTools().some((tool) => tool.name === 'bash_task'))
  assert(immediate.events.findIndex((e) => e.type === 'message_end' && e.message.role === 'toolResult' && e.message.toolCallId === 'notify-1') < immediate.events.findIndex((e) => e.type === 'message_end' && e.message.role === 'custom'))

  const wake = await setup('idle', (n) => n === 1
    ? stream(message([call('idle-task', nodeCommand('setTimeout(()=>console.log("WAKE"),250)'), 'background')]))
    : stream(message(text(n === 2 ? 'independent work finished' : 'received result'))))
  await wake.session.prompt('launch')
  assert.equal(wake.calls(), 2)
  await until(() => wake.calls() === 3 && !wake.session.isStreaming, 'completion wakes the owning idle session')
  assert.equal(wake.session.messages.filter((m) => m.role === 'custom').length, 1)

  const preflight = await setup('preflight', (n) => n === 1
    ? stream(message([call('preflight-task', nodeCommand('setTimeout(()=>console.log("PREFLIGHT"),180)'), 'background')]))
    : stream(message(text('handled'))))
  await preflight.session.prompt('launch')
  preflight.outbox.holdWake()
  await until(() => tasks.list(preflight.path).every((task) => task.status === 'succeeded'), 'preflight completion')
  assert.equal(preflight.calls(), 2, 'notification cannot race user attachment/auth preflight')
  await preflight.session.prompt('user message after attachment preparation')
  preflight.outbox.releaseWake()
  await until(() => preflight.session.messages.some((m) => m.role === 'custom'), 'completion delivered with user run')
  assert.equal(preflight.session.messages.filter((m) => m.role === 'custom').length, 1)

  const reloadRace = await setup('reload-race', (n) => n === 1
    ? stream(message([call('reload-task', nodeCommand('setTimeout(()=>console.log("RELOAD_DONE"),150)'), 'background')]))
    : stream(message(text('handled reload'))))
  await reloadRace.session.prompt('launch')
  let finishReload
  const originalReload = reloadRace.session.reload.bind(reloadRace.session)
  reloadRace.session.reload = async () => { await new Promise((resolve) => { finishReload = resolve }); await originalReload() }
  const reloading = reloadRace.app.reloadManagedSession(reloadRace.app.activeSession)
  await until(() => tasks.list(reloadRace.path).every((task) => task.status === 'succeeded'), 'completion during resource reload')
  assert.equal(reloadRace.calls(), 2, 'automatic wake cannot race resource reload')
  finishReload()
  await reloading
  await until(() => reloadRace.calls() === 3 && !reloadRace.session.isStreaming, 'wake after resource reload')

  const late = await setup('late-end', (n, _context, _options, state) => n === 1
    ? stream(message([call('late-task', nodeCommand('setTimeout(()=>console.log("LATE_DONE"),50)'), 'background')]))
    : stream(message(text('handled late result')), 0, async () => {
      const task = tasks.list(state.path).find(t => t.toolCallId === 'late-task')
      await tasks.wait(state.path, task.id)
    }))
  outboxes.delete(late.path)
  let enqueuedAtEnd = false
  late.session.subscribe((event) => {
    if (event.type !== 'agent_end' || enqueuedAtEnd) return
    enqueuedAtEnd = true
    const task = tasks.list(late.path).find((task) => task.toolCallId === 'late-task')
    assert.equal(task.status, 'succeeded')
    late.outbox.complete(task)
  })
  await late.session.prompt('end-hook race')
  await until(() => late.calls() === 3 && !late.session.isStreaming, 'steer queued in agent_end is recovered at settled')
  assert.equal(late.session.messages.filter((m) => m.role === 'custom').length, 1)
  const deliveredAt = late.routed.findIndex((event) => event.type === 'message_end' && event.message.role === 'custom')
  assert(late.routed.slice(0, deliveredAt).filter((event) => event.type === 'agent_settled').every((event) => event.continuing),
    'an end-hook continuation cannot expose a transient settled file list')

  let completedInSettle = false
  const settleExtension = { ...extension, tools: new Map(), handlers: new Map([['agent_settled', [async () => {
    if (completedInSettle) return
    completedInSettle = true
    const pending = tasks.list(heldSettle.path)[0]
    await tasks.wait(heldSettle.path, pending.id)
    const task = tasks.get(heldSettle.path, pending.id)
    assert.equal(task.status, 'succeeded')
    heldSettle.outbox.complete(task)
  }]]]) }
  const heldSettle = await setup('held-settle', (n) => n === 1
    ? stream(message([call('held-task', nodeCommand('setTimeout(()=>{},50)'), 'background')]))
    : stream(message(text('handled held result')), 100),
    { ...loader, getExtensions: () => ({ extensions: [settleExtension], errors: [], runtime: createExtensionRuntime() }) })
  outboxes.delete(heldSettle.path)
  heldSettle.outbox.holdWake()
  await heldSettle.session.prompt('completion during final settle hook')
  assert.equal(heldSettle.calls(), 2)
  assert.equal(heldSettle.routed.find((event) => event.type === 'agent_settled').continuing, true,
    'a ready completion must stay visually active while prompt releases its idle-wake hold')
  heldSettle.outbox.releaseWake()
  await until(() => heldSettle.calls() === 3 && heldSettle.session.isIdle, 'held completion resumes after prompt returns')
  const heldRounds = heldSettle.app.snapshotOf(heldSettle.app.activeSession).messages.filter((m) => m.role === 'assistant')
  assert(heldRounds.every((m) => m.changeScopeId === heldRounds[0].changeScopeId))

  // Exercise the app's real queue rebuild, including image payload preservation.
  let cleared = false
  const queue = await setup('queue', (n, context, _options, state) => {
    if (n === 1) return stream(message([call('queue-task', nodeCommand('setTimeout(()=>console.log("QUEUE_DONE"),100)'), 'background')]))
    if (n === 2) return stream(message([call('queue-other', 'printf other')]), 50, async () => {
      await until(() => tasks.list(state.path).some((task) => task.toolCallId === 'queue-task' && task.status === 'succeeded'), 'background completed')
      const app = Object.create(PiManager.prototype)
    app.checkoutCoordinator = new CheckoutCoordinator()
    app.rewindClient = { call: async () => { throw new Error('Checkpoint storage is outside this fixture') } }
      app.emit = () => {}
      const image = { type: 'image', mimeType: 'image/png', data: 'fixture-image' }
      const item = { text: 'keep user payload', originalText: 'keep user payload', images: [image], filePaths: ['/fixture/file'] }
      const managed = { plan: state.managed.plan, askUser: state.managed.askUser, session: state.session, notifications: state.outbox, path: state.path, cwd: temporary, queueMirror: { steering: [], followUp: [item] }, pendingQueuePayloads: [], pendingStreamEvents: new Map(), eventSequence: 0 }
      app.activeSession = managed
      app.queueAction({ action: 'promote', kind: 'followUp', index: 0 })
      assert.equal(managed.queueMirror.steering[0].images[0].data, image.data)
      cleared = true
    })
    return stream(message(text('queue handled')))
  })
  await queue.session.prompt('queue race')
  assert(cleared, JSON.stringify(queue.session.messages.at(-1)))
  assert.equal(queue.session.messages.filter((m) => m.role === 'custom').length, 1)
  assert(queue.session.messages.some((m) => m.role === 'user' && JSON.stringify(m).includes('fixture-image')))
  const queueRounds = queue.app.snapshotOf(queue.app.activeSession).messages.filter((m) => m.role === 'assistant')
  assert(queueRounds.every((m) => m.changeScopeId === queueRounds[0].changeScopeId), 'user steer preserves cumulative change scope')

  const server = await setup('server-scope', (n) => n === 1
    ? stream(message([call('server-task', nodeCommand('setInterval(()=>{},1000)'), 'background')]))
    : stream(message(text('server handled'))))
  await server.session.prompt('start a server')
  assert.equal(server.session.isStreaming, false, 'a live server cannot keep the model turn open')
  const firstScope = server.app.snapshotOf(server.app.activeSession).messages.find((m) => m.role === 'assistant').changeScopeId
  const serverTask = tasks.list(server.path)[0]
  await server.app.stopBashTask({ sessionPath: server.path, taskId: serverTask.id })
  await until(() => server.calls() === 3 && server.session.isIdle, 'user stopping one server wakes the model')
  let serverSnapshot = server.app.snapshotOf(server.app.activeSession)
  assert(serverSnapshot.messages.filter((m) => m.role === 'assistant').every((m) => m.changeScopeId === firstScope), 'idle continuation reopens the same change scope')
  assert.match(serverSnapshot.messages.find((m) => m.role === 'custom').content, /do not restart/)
  await server.session.prompt('an unrelated new request')
  serverSnapshot = server.app.snapshotOf(server.app.activeSession)
  assert.notEqual(serverSnapshot.messages.at(-1).changeScopeId, firstScope, 'a fresh user request starts a separate change scope')
  const reopenedManager = SessionManager.open(server.path)
  const restoredScopes = new ChangeScopes(reopenedManager)
  const savedRounds = reopenedManager.buildSessionContext().messages.filter((m) => m.role === 'assistant').map((m) => restoredScopes.stamp(m))
  assert.deepEqual(savedRounds.map((m) => m.changeScopeId), serverSnapshot.messages.filter((m) => m.role === 'assistant').map((m) => m.changeScopeId), 'scope ownership survives reopening the saved session')
  const legacyManager = SessionManager.inMemory(temporary)
  legacyManager.appendMessage({ role: 'user', content: 'old request', timestamp: 1 })
  const legacyRound = message(text('old response'))
  legacyManager.appendMessage(legacyRound)
  const legacyScopes = new ChangeScopes(legacyManager)
  const legacyScope = legacyScopes.stamp(legacyRound).changeScopeId
  legacyScopes.continue()
  legacyScopes.observe({ type: 'agent_start' })
  legacyManager.appendMessage({ role: 'user', content: 'steer after legacy continuation', timestamp: 2 })
  const resumedLegacyRound = message(text('continued legacy response'))
  legacyManager.appendMessage(resumedLegacyRound)
  legacyScopes.observe({ type: 'agent_settled' })
  assert.equal(new ChangeScopes(legacyManager).stamp(resumedLegacyRound).changeScopeId, legacyScope,
    'a resumed legacy scope remains shared through subsequent user steers after reload')
  console.log('PASS: no transient settle on continuation, user-steer scope, live server settling, per-task user stop wakeup and durable cumulative scope.')

  let boundaryGate, reachedBoundary = false
  const boundary = await setup('drained', (n) => {
    if (n === 1) return stream(message([call('boundary-task', nodeCommand('setTimeout(()=>console.log("BOUNDARY_DONE"),80)'), 'background')]))
    if (n === 2) return stream(message([call('boundary-other', 'printf other')]), 120)
    return stream(message(text('boundary handled')))
  })
  const prepare = boundary.session.agent.prepareNextTurnWithContext
  boundary.session.agent.prepareNextTurnWithContext = async (...args) => {
    if (boundary.calls() === 2) {
      reachedBoundary = true
      await new Promise((resolve) => { boundaryGate = resolve })
    }
    return prepare(...args)
  }
  const boundaryRun = boundary.session.prompt('boundary race')
  await until(() => reachedBoundary, 'steer drain reached')
  boundary.session.clearQueue()
  boundary.outbox.queuesCleared()
  boundary.outbox.flush()
  boundaryGate()
  await boundaryRun
  assert.equal(boundary.session.messages.filter((m) => m.role === 'custom').length, 1, 'a drained notification must never be re-enqueued')

  const stop = await setup('stop', (n) => n === 1
    ? stream(message([call('stop-task', nodeCommand('setTimeout(()=>console.log("do not wake"),180)'), 'background')]))
    : stream(message(text('waiting'))))
  await stop.session.prompt('launch')
  const queuedImage = { type: 'image', mimeType: 'image/png', data: 'recall-image' }
  stop.app.activeSession.queueMirror.followUp = [{ text: 'queued', originalText: 'draft', images: [queuedImage], filePaths: ['/fixture/attachment'] }]
  const recalled = stop.app.clearQueue(true)
  assert.equal(recalled.followUp[0].images[0].data, 'recall-image')
  assert.equal(recalled.followUp[0].text, 'queued')
  assert.equal(recalled.followUp[0].originalText, 'draft')
  await delay(250)
  assert.equal(stop.calls(), 2, 'stop suppresses automatic wakeup')
  assert.equal(stop.session.messages.filter((m) => m.role === 'custom').length, 0)
  assert.equal(stop.app.setBashMaxWaitMs(2500), 2500)
  assert.equal(JSON.parse(await readFile(join(temporary, 'app-settings.json'), 'utf8')).bashMaxWaitMs, 2500)
  assert.throws(() => stop.app.setBashMaxWaitMs(0), /Invalid/)
  await immediate.session.reload()
  assert(immediate.session.getActiveToolNames().includes('bash_task'), 'tools survive reload')
  console.log('PASS: real SDK immediate steering, result ordering, idle wakeup, prompt preflight/end-hook races, user queue/image preservation, drain-boundary deduplication, stop suppression and reload.')

  // Restored records have no live process ownership and cannot auto-wake.
  const live = await run('shutdown', { command: nodeCommand('setInterval(()=>{},1000)'), mode: 'background' })
  await tasks.dispose()
  assert.equal(tasks.get(owner.sessionPath, live.details.bashTask.id).status, 'cancelled')
  const record = join(temporary, 'tasks', `${id}.json`)
  const saved = JSON.parse(await readFile(record, 'utf8'))
  saved.task.status = 'running'
  await writeFile(record, JSON.stringify(saved))
  tasks = new BashTaskManager(join(temporary, 'tasks'), () => {}, () => { throw new Error('restore must not auto-wake') })
  assert.equal(tasks.get(owner.sessionPath, id).status, 'interrupted')
  assert.match(tasks.output(owner.sessionPath, id).output, /last 中文😀/)
  console.log('PASS: application shutdown, persisted logs and interrupted-task recovery.')
} finally {
  for (const session of sessions) session.dispose()
  await tasks?.dispose()
  await rm(temporary, { recursive: true, force: true })
}
