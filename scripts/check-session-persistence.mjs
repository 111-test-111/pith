// Real SDK files + PiManager's fork/materialize/retry paths; all data is
// temporary, with no agent runtime, credentials, extensions or model calls.
// Run: node scripts/check-session-persistence.mjs
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { SessionManager } from '@earendil-works/pi-coding-agent'

const temp = await mkdtemp(join(tmpdir(), 'pith-persistence-check-'))
const user = (text, timestamp) => ({ role: 'user', content: [{ type: 'text', text }], timestamp })
const assistant = (text, timestamp) => ({
  role: 'assistant', content: [{ type: 'text', text }], timestamp,
  api: 'openai-responses', provider: 'fixture', model: 'fixture', stopReason: 'stop',
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
})
const read = async (path) => (await readFile(path, 'utf8')).trim().split('\n').map(JSON.parse)
const verify = async (manager) => {
  const entries = await read(manager.getSessionFile())
  assert.equal(entries[0].type, 'session')
  assert.equal(entries[0].id, manager.getSessionId())
  assert.equal(entries.filter((entry) => entry.type === 'session').length, 1)
  const seen = new Set()
  for (const entry of entries.slice(1)) {
    assert(!entry.parentId || seen.has(entry.parentId), `missing parent: ${entry.parentId}`)
    seen.add(entry.id)
  }
  return entries
}

try {
  const outfile = join(temp, 'manager.mjs')
  await build({
    stdin: { contents: "export { PiManager } from './src/main/pi/manager'; export { TodoState } from './src/main/pi/todo'; export { CheckoutCoordinator } from './src/main/rewind/coordinator'; export { PlanController } from './src/main/pi/plan-mode'; export { PlanStorage } from './src/main/pi/plan-storage';", resolveDir: resolve('.') }, bundle: true, platform: 'node', format: 'esm', outfile,
    plugins: [{ name: 'isolated-runtime', setup(builder) {
      builder.onResolve({ filter: /^@earendil-works\/pi-coding-agent$/ }, () => ({
        path: fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')), external: true
      }))
      builder.onResolve({ filter: /^playwright-core(\/|$)/ }, args => ({ path: fileURLToPath(import.meta.resolve(args.path)), external: true }))
      builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'fixture' }))
      builder.onResolve({ filter: /^proper-lockfile$|^@resvg\/resvg-js$/ }, args => ({ path: fileURLToPath(import.meta.resolve(args.path)), external: true }))
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
        contents: `export const app = { getPath(name) { if (name === "userData") return ${JSON.stringify(join(temp, 'user-data'))}; throw Error("Unexpected app path: " + name) } }; export const shell = {};`
      }))
    } }]
  })
  const { PiManager, TodoState, CheckoutCoordinator, PlanController, PlanStorage } = await import(pathToFileURL(outfile).href)
  const planFor = manager => new PlanController({ manager, storage: new PlanStorage(manager), changed() {}, facts: () => ({
    initializing: false, closing: false, child: false, recovery: false, sdkIdle: true,
    tasks: 0, subagents: 0, deliveries: 0, questions: 0, escalations: 0, queuedMessages: 0,
    configuredSandboxMode: 'workspace-write', inheritedPlanRestriction: false, shellEnforcement: 'unavailable'
  }) })
  // Skip the runtime constructor; execute the real methods against real SDK
  // managers, replacing only model activation and renderer snapshots.
  const app = Object.create(PiManager.prototype)
  app.checkoutCoordinator = new CheckoutCoordinator()
  Object.defineProperty(app, 'subagentRuntime', { value: { stopAll: async () => {} } })
  app.navigationEpoch = 0
  app.snapshot = () => ({ sessionPath: app.activeSession.path })
  app.buildSession = async (sessionManager) => {
    app.activeSession = { plan: planFor(sessionManager), todos: new TodoState(sessionManager), path: sessionManager.getSessionFile(), session: { sessionManager } }
    return app.activeSession
  }

  const source = SessionManager.create(temp, join(temp, 'sessions'))
  app.materializeSession(source)
  await verify(source)
  source.appendMessage(user('Original question', 1))
  const forkAt = source.appendMessage(assistant('Fork here', 2))
  source.appendMessage(user('Later question stays in original', 3))
  source.appendMessage(assistant('Later answer stays in original', 4))
  const original = source.getSessionFile()
  const before = await readFile(original, 'utf8')
  const originalId = source.getSessionId()
  const originalLeaf = source.getLeafId()
  const managed = { cwd: temp, plan: planFor(source), askRecords: { restore() {} }, todos: new TodoState(source), path: original, session: {
    sessionManager: source, isStreaming: false,
    agent: { state: { messages: source.buildSessionContext().messages } },
    refreshContext() { this.agent.state.messages = source.buildSessionContext().messages },
    prompt: async (text) => { source.appendMessage(user(text, 6)) }
  } }
  app.activeSession = managed
  const forkResult = await app.forkFromMessage(2)
  const fork = app.activeSession.session.sessionManager
  assert.equal(forkResult.baseLabel, 'Original question')
  assert.notEqual(fork.getSessionFile(), original)
  assert.equal(source.getSessionFile(), original, 'fork must not redirect the live source')
  assert.equal(source.getSessionId(), originalId)
  assert.equal(source.getLeafId(), originalLeaf, 'fork must not rewind the source')
  assert.equal(await readFile(original, 'utf8'), before)
  assert.equal(fork.getHeader().parentSession, original)
  assert.equal(fork.getLeafId(), forkAt)
  await verify(fork)

  // Each conversation continues into its own file after the fork.
  fork.appendMessage(user('Only in fork', 5))
  source.appendMessage(user('Only in original', 5))
  assert(!(await readFile(original, 'utf8')).includes('Only in fork'))
  assert(!(await readFile(fork.getSessionFile(), 'utf8')).includes('Only in original'))
  await rm(fork.getSessionFile())
  app.activeSession = managed
  // Retry a user-only tail, then keep chatting after deleting the fork.
  await app.resendMessage({ timestamp: 5, text: 'Retry original', images: [] })
  source.appendMessage(assistant('Continue original', 7))
  await verify(source)
  assert(!existsSync(fork.getSessionFile()), 'continuing the original must not recreate a deleted fork')

  // The SDK also supports deferred forks before any assistant. Their first
  // completed response must flush the header and every inherited setup entry.
  const deferred = SessionManager.create(temp, join(temp, 'deferred'))
  const setup = deferred.appendModelChange('fixture', 'fixture')
  const deferredPath = deferred.createBranchedSession(setup)
  assert(!existsSync(deferredPath))
  deferred.appendMessage(user('First question', 8))
  deferred.appendMessage(assistant('First answer', 9))
  await verify(deferred)
  assert((await read(deferredPath)).some((entry) => entry.id === setup))
  console.log('PASS: new-session header, isolated fork, independent writes, delete-fork/continue-original, user-tail retry, deferred SDK fork and parent integrity.')
} finally {
  await rm(temp, { recursive: true, force: true })
}
