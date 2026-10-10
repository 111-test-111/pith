/** Real SDK + app fixture for offline Plan Mode tests. No model/network calls. */
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

/**
 * Repository root, derived from this fixture's own location (scripts/lib/ is two
 * levels below it) so the check runs on any clone, worktree or CI checkout.
 */
export const planRepoRoot = fileURLToPath(new URL('../..', import.meta.url))
const sdk = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))

/**
 * Create an isolated real-SDK fixture backed by a temporary profile.
 *
 * The fake stream is installed inside the mocked createAgentSessionFromServices
 * so it exists before PiManager takes ownership of the session.
 */
export async function createPlanFixture({ respond: initialRespond, extensionFactories = [], withRewind = false, withLibrary = false, keepRecentTokens = 20000, providerCallbacks = false, prepareAgentDir, loadDiscoveredExtensions = false, loadSkills = false, loadContextFiles = false, imageSkillPath, temporaryRoot, reuseBundle = false, sessionPath, keepFiles = false } = {}) {
  const temporary = temporaryRoot ?? await mkdtemp(join(tmpdir(), 'pith-plan-mode-'))
  const agentDir = join(temporary, 'agent')
  const project = join(temporary, 'project')
  const sessions = join(temporary, 'sessions')
  const userData = join(temporary, 'userData')

  await mkdir(agentDir, { recursive: true })
  await mkdir(project, { recursive: true })
  await mkdir(sessions, { recursive: true })
  await mkdir(userData, { recursive: true })
  if (prepareAgentDir) {
    try { await prepareAgentDir(agentDir) }
    catch (error) { await rm(temporary, { recursive: true, force: true }); throw error }
  }

  const outfile = join(temporary, 'modules.mjs')
  if (!reuseBundle) await build({
    stdin: {
      contents: `export { PiManager } from './src/main/pi/manager';
export { debugAdapterSpec } from './src/main/debug/adapters';
export { startLibraryService } from './src/main/library/service';
export { PlanStorage } from './src/main/pi/plan-storage';
export { GoalStorage } from './src/main/pi/goals/storage';
export { GoalInputStorage } from './src/main/pi/goals/input';
export { GoalAccounting } from './src/main/pi/goals/accounting';
export { JevService } from './src/main/pi/jev/service';
export * from './src/main/pi/plan-protocol';
export { PiStore } from './src/renderer/src/state/pi-store';
export { SessionManager, ModelRuntime, SettingsManager, setPlanFixtureStream, registerPlanFixtureExtensionFactories } from '@earendil-works/pi-coding-agent';`,
      resolveDir: planRepoRoot
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile,
    plugins: [{
      name: 'isolated-profile',
      setup(builder) {
        builder.onResolve({ filter: /^@earendil-works\/pi-coding-agent$/ }, () => ({ path: 'sdk', namespace: 'fixture' }))
        builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'fixture' }))
        builder.onResolve({ filter: /^proper-lockfile$|^@resvg\/resvg-js$/ }, args => ({ path: fileURLToPath(import.meta.resolve(args.path)), external: true }))
        // Strict absolute externalization for the browser dependency graph.
        builder.onResolve({ filter: /^playwright-core(\/|$)|^chromium-bidi(\/|$)/ }, (args) => {
          const resolved = fileURLToPath(import.meta.resolve(args.path))
          return { path: resolved, external: true }
        })
        builder.onResolve({ filter: /^\// }, (args) => args.path === sdk ? { path: sdk, external: true } : undefined)
        builder.onLoad({ filter: /^electron$/, namespace: 'fixture' }, () => ({
          contents: `export const app={getPath:(key)=>{
            if (key==='userData') return ${JSON.stringify(userData)};
            throw new Error('unexpected getPath '+key);
          }};export const shell={};`
        }))
        builder.onLoad({ filter: /^sdk$/, namespace: 'fixture' }, () => ({
          contents: `
export * from ${JSON.stringify(sdk)};
import {createAgentSessionServices as create,SettingsManager,createAgentSessionFromServices as realCreate} from ${JSON.stringify(sdk)};
export const getAgentDir=()=>${JSON.stringify(agentDir)};
let fixtureStream = null;
let fixtureExtensionFactories = [];
export function setPlanFixtureStream(fn){ fixtureStream = fn; }
export function registerPlanFixtureExtensionFactories(factories){ fixtureExtensionFactories = factories; }
export function createAgentSessionServices(options){
  return create({
    ...options,
    agentDir:getAgentDir(),
    settingsManager:SettingsManager.inMemory({compaction:{enabled:false,keepRecentTokens:${keepRecentTokens}},retry:{enabled:false}}),
    resourceLoaderOptions:{
      ...options.resourceLoaderOptions,
      noExtensions:${!loadDiscoveredExtensions},
      noSkills:${!loadSkills},
      noPromptTemplates:true,
      noThemes:true,
      noContextFiles:${!loadContextFiles},
      extensionFactories:[...(options.resourceLoaderOptions.extensionFactories??[]), ...fixtureExtensionFactories]
    }
  });
}
export async function createAgentSessionFromServices(options){
  const result = await realCreate(options);
  if (fixtureStream) result.session.agent.streamFunction = fixtureStream;
  return result;
}`
        }))
      }
    }]
  })

  if (!reuseBundle) await build({ entryPoints: [join(planRepoRoot, 'src/main/pi/trajectory-worker.ts')], outfile: join(temporary, 'trajectory-worker.mjs'), bundle: true, platform: 'node', format: 'esm' })
  if (withLibrary && !reuseBundle) await build({ entryPoints: [join(planRepoRoot, 'src/main/library/worker.ts')], outfile: join(temporary, 'library-worker.mjs'), bundle: true, platform: 'node', format: 'esm',
    plugins: [{ name: 'library-dependencies', setup(builder) { builder.onResolve({ filter: /^@earendil-works\/pi-coding-agent$|^proper-lockfile$/ }, args => ({ path: fileURLToPath(import.meta.resolve(args.path)), external: true })) } }] })
  if (withRewind && !reuseBundle) await build({ entryPoints: [join(planRepoRoot, 'src/main/rewind/worker.ts')], outfile: join(temporary, 'rewind-worker.mjs'), bundle: true, platform: 'node', format: 'esm' })

  const {
    PiManager,
    PiStore,
    startLibraryService,
    SessionManager,
    ModelRuntime,
    setPlanFixtureStream,
    registerPlanFixtureExtensionFactories,
    debugAdapterSpec
  } = await import(pathToFileURL(outfile).href)

  registerPlanFixtureExtensionFactories(extensionFactories)

  const requests = []
  let time = Date.now()
  let respond = initialRespond ?? (() => [{ type: 'text', text: 'ok' }])

  setPlanFixtureStream((model, context, options) => {
    requests.push(JSON.parse(JSON.stringify(context)))
    const content = respond(requests.length, context)
    const message = {
      role: 'assistant',
      content,
      provider: 'fixture',
      model: 'fixture',
      api: 'openai-completions',
      timestamp: ++time,
      stopReason: content.some((x) => x.type === 'toolCall') ? 'toolUse' : 'stop',
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
      }
    }
    return {
      async *[Symbol.asyncIterator]() {
        if (providerCallbacks) {
          await options?.onPayload?.({ model: model.id, messages: context.messages, authorization: 'fixture-secret' }, model)
          await options?.onResponse?.({ status: 200, headers: { authorization: 'fixture-secret', 'x-request-id': 'fixture-request' } }, model)
          yield { type: 'text_delta', contentIndex: 0, delta: '', partial: message }
          if (content[0]?.type === 'text') yield { type: 'text_delta', contentIndex: 0, delta: content[0].text, partial: message }
          else if (content[0]?.type === 'toolCall') yield { type: 'toolcall_delta', contentIndex: 0, delta: JSON.stringify(content[0].arguments), partial: message }
        }
        yield { type: 'done', message }
      },
      result: async () => message
    }
  })

  const runtime = await ModelRuntime.create({
    authPath: join(agentDir, 'auth.json'),
    modelsPath: join(agentDir, 'models.json'),
    modelsStorePath: join(agentDir, 'models-store'),
    refreshOnCreate: false
  })
  runtime.hasConfiguredAuth = () => true
  runtime.checkAuth = () => {
    throw new Error('Unexpected credential access')
  }
  const model = {
    id: 'fixture',
    name: 'fixture',
    provider: 'fixture',
    api: 'openai-completions',
    baseUrl: 'http://127.0.0.1:1',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 4096
  }
  runtime.getAvailableSnapshot = () => [model]

  const store = new PiStore()
  /** Every `pi:event` payload the app emitted, in order — Task-2 metadata
   * checks assert the sequence-free events themselves, not just the store. */
  const events = []
  const app = new PiManager(
    (channel, event) => {
      if (channel === 'pi:event') {
        events.push(event)
        store.dispatch(event)
      }
    },
    (error) => {
      throw new Error(error)
    },
    typeof imageSkillPath === 'function' ? imageSkillPath(agentDir) : imageSkillPath
  )
  app.runtime = async () => runtime

  const manager = sessionPath ? SessionManager.open(sessionPath) : SessionManager.create(project, sessions)
  const managed = await app.buildSession(manager)
  const { session } = managed

  store.applySnapshot(app.snapshot())
  const library = withLibrary ? startLibraryService(() => {}, id => app.librarySession(id)) : null

  return {
    app,
    managed,
    session,
    manager,
    store,
    library,
    debugAdapterSpec,
    project,
    userData,
    temporary,
    requests,
    events,
    setRespond(fn) {
      respond = fn
    },
    async close() {
      await app.dispose()
      if (!keepFiles) await rm(temporary, { recursive: true, force: true })
    }
  }
}

export async function submitFixturePlan(f, markdown = '# Plan\n1. Inspect.\n2. Implement.\n3. Verify.') {
  await f.managed.lifecyclePromise
  if (f.app.getPlanState(f.managed.path).mode !== 'plan') {
    const entered = await f.app.setSessionMode({ sessionPath: f.managed.path, mode: 'plan' })
    if (!entered.ok) throw new Error(entered.code)
  }
  const next = f.requests.length + 1
  f.setRespond(n => n === next
    ? [{ type: 'toolCall', id: `fixture-plan-${n}`, name: 'submit_plan', arguments: { plan: markdown } }]
    : [{ type: 'text', text: 'Done' }])
  await f.session.prompt('Prepare the implementation plan')
  const state = f.app.getPlanState(f.managed.path)
  if (!state.latest) throw new Error('fixture-plan-not-submitted')
  return state.latest
}
