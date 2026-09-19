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
export async function createPlanFixture({ respond: initialRespond, extensionFactories = [] } = {}) {
  const temporary = await mkdtemp(join(tmpdir(), 'pith-plan-mode-'))
  const agentDir = join(temporary, 'agent')
  const project = join(temporary, 'project')
  const sessions = join(temporary, 'sessions')
  const userData = join(temporary, 'userData')

  await mkdir(agentDir)
  await mkdir(project)
  await mkdir(sessions)
  await mkdir(userData)

  const outfile = join(temporary, 'modules.mjs')
  await build({
    stdin: {
      contents: `export { PiManager } from './src/main/pi/manager';
export { PlanStorage } from './src/main/pi/plan-storage';
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
    settingsManager:SettingsManager.inMemory({compaction:{enabled:false},retry:{enabled:false}}),
    resourceLoaderOptions:{
      ...options.resourceLoaderOptions,
      noExtensions:true,
      noSkills:true,
      noPromptTemplates:true,
      noThemes:true,
      noContextFiles:true,
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

  const {
    PiManager,
    PiStore,
    SessionManager,
    ModelRuntime,
    setPlanFixtureStream,
    registerPlanFixtureExtensionFactories
  } = await import(pathToFileURL(outfile).href)

  registerPlanFixtureExtensionFactories(extensionFactories)

  const requests = []
  let time = Date.now()
  let respond = initialRespond ?? (() => [{ type: 'text', text: 'ok' }])

  setPlanFixtureStream((model, context) => {
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
  const app = new PiManager(
    (channel, event) => {
      if (channel === 'pi:event') store.dispatch(event)
    },
    (error) => {
      throw new Error(error)
    }
  )
  app.runtime = async () => runtime

  const manager = SessionManager.create(project, sessions)
  const managed = await app.buildSession(manager)
  const { session } = managed

  store.applySnapshot(app.snapshot())

  return {
    app,
    managed,
    session,
    manager,
    store,
    project,
    temporary,
    requests,
    setRespond(fn) {
      respond = fn
    },
    async close() {
      await app.dispose()
      await rm(temporary, { recursive: true, force: true })
    }
  }
}
