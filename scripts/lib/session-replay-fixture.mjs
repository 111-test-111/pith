/** Isolated real SDK, real filesystem tools and app trajectory worker. */
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { createReplayNormalizer } from './session-replay.mjs'

export const replayRepoRoot = fileURLToPath(new URL('../..', import.meta.url))
const sdkPath = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))
const sdk = await import(pathToFileURL(sdkPath).href)

export const REPLAY_MODEL = {
  id: 'offline-replay', name: 'Offline replay', provider: 'pith-replay', api: 'openai-completions',
  baseUrl: 'http://127.0.0.1:1', reasoning: false, input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 4096
}

/** No built-in bash, external extensions, user profile or ambient credentials.
 * streamFactory is mandatory and installed before the first prompt. */
export async function createReplayFixture({ scenario, streamFactory }) {
  if (typeof streamFactory !== 'function') throw new Error('session-replay-stream-required')
  // macOS /var is a symlink to /private/var. Canonicalize once so paths
  // returned by present and tool confinement share exactly the same root.
  const temporary = await realpath(await mkdtemp(join(tmpdir(), 'pith-session-replay-')))
  const project = join(temporary, 'workspace')
  const profile = join(temporary, 'profile')
  const sessions = join(temporary, 'sessions')
  let session
  let recorder
  let client
  let unsubscribe
  let unsubscribeCommitted
  try {
    await Promise.all([project, profile, sessions].map(path => mkdir(path)))
    for (const file of scenario.files ?? []) {
      const path = resolve(project, file.path)
      if (!path.startsWith(project + sep) || file.path.includes('\0')) throw new Error('session-replay-file-outside-workspace')
      if (file.directory) await mkdir(path, { recursive: true })
      else {
        await mkdir(resolve(path, '..'), { recursive: true })
        await writeFile(path, file.content)
      }
    }
    const modules = join(temporary, 'modules.mjs')
    await build({
      stdin: { contents: `export { createPresentTool } from './src/main/pi/present';
export { TrajectoryRecorder } from './src/main/pi/trajectory/recorder';
export { TrajectoryClient } from './src/main/pi/trajectory/client';
export { presentedFiles } from './src/renderer/src/lib/presented-files';`, resolveDir: replayRepoRoot },
      outfile: modules, bundle: true, platform: 'node', format: 'esm',
      plugins: [{ name: 'external-sdk', setup(builder) {
        builder.onResolve({ filter: /^@earendil-works\/pi-coding-agent$/ }, () => ({ path: sdkPath, external: true }))
      } }]
    })
    await build({ entryPoints: [join(replayRepoRoot, 'src/main/pi/trajectory-worker.ts')], outfile: join(temporary, 'trajectory-worker.mjs'), bundle: true, platform: 'node', format: 'esm' })
    const app = await import(pathToFileURL(modules).href)
    const runtime = await sdk.ModelRuntime.create({ authPath: join(profile, 'auth.json'), modelsPath: join(profile, 'models.json'), modelsStorePath: join(profile, 'models-store'), refreshOnCreate: false })
    runtime.hasConfiguredAuth = () => true
    runtime.checkAuth = () => { throw new Error('session-replay-unexpected-auth-access') }
    const settings = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false, ...scenario.retry }, transport: 'sse' })
    const services = await sdk.createAgentSessionServices({
      cwd: project, agentDir: profile, modelRuntime: runtime, settingsManager: settings,
      resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        systemPrompt: 'You are an offline regression fixture. Follow the user instruction and use only the supplied tools.', appendSystemPrompt: [] }
    })
    const manager = sdk.SessionManager.create(project, sessions)
    const confined = definition => ({ ...definition, async execute(id, args, signal, update) {
      let path = resolve(project, args.path)
      if (!path.startsWith(project + sep)) throw new Error('session-replay-tool-outside-workspace')
      // Also inspect the deepest existing ancestor, so an escaping symlink can
      // never turn a fixture's write into a mutation outside its temp project.
      while (true) {
        try {
          const canonical = await realpath(path)
          if (canonical !== project && !canonical.startsWith(project + sep)) throw new Error('session-replay-tool-outside-workspace')
          break
        } catch (error) {
          if (error.code !== 'ENOENT' || path === project) throw error
          path = resolve(path, '..')
        }
      }
      return definition.execute(id, args, signal, update)
    } })
    if (scenario.tools.some(name => !['read', 'write', 'present'].includes(name))) throw new Error('session-replay-fixture-tool-not-allowed')
    ;({ session } = await sdk.createAgentSessionFromServices({ services, sessionManager: manager, model: REPLAY_MODEL, thinkingLevel: 'off',
      tools: scenario.tools, customTools: [confined(sdk.createReadTool(project)), confined(sdk.createWriteTool(project)), app.createPresentTool({ cwd: project, canStart: () => true })] }))
    const normalizer = createReplayNormalizer({ workspace: project, profile, sessions })
    const driver = streamFactory(normalizer)
    session.agent.streamFunction = driver.streamFunction
    client = new app.TrajectoryClient(join(temporary, 'trajectory.sqlite'))
    recorder = new app.TrajectoryRecorder(session, client)
    const events = []
    const toolEvents = []
    unsubscribe = session.subscribe(event => {
      // AgentSession emits message_end to session listeners before appending
      // it. PiManager uses a later awaited agent subscriber for commitment.
      if (event.type !== 'message_end') recorder.observe(event)
      events.push(event.type)
      if (event.type === 'tool_execution_start' || event.type === 'tool_execution_end') toolEvents.push(normalizer.capture(event))
      // Do not await abort from inside an SDK subscriber: abort waits for idle.
      if (scenario.cancelAfterTextDelta && event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta' && event.assistantMessageEvent.delta) queueMicrotask(() => { void session.abort() })
      if (scenario.cancelDuringRetry && event.type === 'auto_retry_start') queueMicrotask(() => { void session.abort() })
    })
    unsubscribeCommitted = session.agent.subscribe(event => {
      if (event.type === 'message_end') recorder.observe(event)
    })
    const access = () => ({ sessionPath: manager.getSessionFile(), sessionId: manager.getSessionId(), leafId: manager.getLeafId() })
    return {
      session, manager, project, profile, sessions, temporary, driver, normalizer, recorder, client,
      async run() {
        for (const prompt of scenario.prompts) {
          let timer
          try { await Promise.race([session.prompt(prompt), new Promise((_, reject) => { timer = setTimeout(() => { void session.abort(); reject(new Error('session-replay-driver-timeout')) }, 10_000) })]) }
          finally { clearTimeout(timer) }
        }
        await recorder.flush()
      },
      async outcome() {
        await recorder.flush()
        const page = await client.page(access(), {})
        if (page.older || page.newer) throw new Error('session-replay-trajectory-exceeds-page')
        if (page.items.some(record => record.status === 'running')) throw new Error('session-replay-running-after-settlement')
        if (page.items.some(record => !record.captured || record.kind === 'assistant')) throw new Error('session-replay-uncommitted-or-duplicate-trajectory')
        if (page.items.filter(record => record.kind === 'user').length !== scenario.prompts.length) throw new Error('session-replay-user-trajectory-count')
        if (page.items.filter(record => record.kind === 'tool').length !== session.messages.filter(message => message.role === 'toolResult').length) throw new Error('session-replay-tool-trajectory-count')
        const runs = page.items.filter(record => record.kind === 'run')
        const requests = page.items.filter(record => record.kind === 'request')
        if (runs.length !== scenario.prompts.length || requests.some(request => !runs.some(run => run.id === request.turnId && run.id === request.parentId))) throw new Error('session-replay-logical-run-association')
        for (const run of runs) {
          const expectedUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }
          for (const request of requests.filter(value => value.turnId === run.id)) for (const key of Object.keys(expectedUsage)) expectedUsage[key] += request.usage?.[key] ?? 0
          if (JSON.stringify(run.usage) !== JSON.stringify(expectedUsage)) throw new Error('session-replay-run-lost-request-usage')
        }
        const trajectories = []
        // Creation/write order is semantic; wall-clock tie-breaking is not.
        for (const record of page.items.slice().sort((a, b) => a.seq - b.seq)) {
          const target = join(temporary, `${record.seq}.json`)
          await client.export(access(), record.id, target)
          const exported = JSON.parse(await readFile(target, 'utf8'))
          if (record.captureError) throw new Error(`session-replay-trajectory-capture-error:${record.kind}`)
          if (record.kind === 'request' && ['context', 'options', 'payload', 'response', 'output'].some(kind => !Object.hasOwn(exported.documents, kind))) throw new Error('session-replay-incomplete-request-documents')
          trajectories.push({ kind: record.kind, name: record.name, status: record.status, captured: record.captured,
            ...(record.provider ? { provider: record.provider } : {}), ...(record.model ? { model: record.model } : {}),
            ...(record.stopReason ? { stopReason: record.stopReason } : {}), ...(record.httpStatus !== undefined ? { httpStatus: record.httpStatus } : {}),
            ...(record.usage ? { usage: record.usage } : {}),
            // Real timings vary; whether the actual stream supplied a token does not.
            ...(record.kind === 'request' ? { firstTokenObserved: record.firstTokenAt !== undefined } : {}),
            documents: normalizer.capture(exported.documents) })
        }
        const messages = session.messages
        const results = new Map(messages.filter(message => message.role === 'toolResult').map(message => [message.toolCallId, message]))
        const delivered = app.presentedFiles(messages.filter(message => message.role === 'assistant'), results)
        const outputFiles = []
        for (const path of scenario.outputFiles ?? []) {
          const resolved = resolve(project, path)
          if (!resolved.startsWith(project + sep)) throw new Error('session-replay-output-outside-workspace')
          outputFiles.push({ path, content: await readFile(resolved, 'utf8') })
        }
        return { transcript: normalizer.capture(messages), toolEvents, eventTypes: events, delivered: normalizer.capture(delivered), outputFiles, trajectories }
      },
      async close() {
        await session.abort()
        unsubscribe()
        unsubscribeCommitted()
        await recorder.dispose()
        await session.dispose()
        await client.dispose()
        await rm(temporary, { recursive: true, force: true })
      }
    }
  } catch (error) {
    unsubscribe?.()
    unsubscribeCommitted?.()
    await recorder?.dispose()
    await session?.dispose()
    await client?.dispose()
    await rm(temporary, { recursive: true, force: true })
    throw error
  }
}
