/** Real SDK + app snapshot/store integration, entirely in a temporary profile. No model/network calls. */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { ModelRuntime, SessionManager } from '@earendil-works/pi-coding-agent'
import { createPlanFixture } from './lib/plan-fixture.mjs'

const temporary = await mkdtemp(join(tmpdir(), 'pith-jev-'))
const agentDir = join(temporary, 'agent'), project = join(temporary, 'project')
const apps = []
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const until = async (predicate) => { for (let i = 0; i < 500; i++) { if (predicate()) return; await pause(10) } assert.fail('Timed out') }
try {
  await mkdir(agentDir); await mkdir(project)
  const sdk = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))
  const outfile = join(temporary, 'modules.mjs')
  await build({ stdin: { contents: `export { PiManager } from './src/main/pi/manager';
export * from './src/main/pi/jev/protocol';
export * from './src/main/pi/jev/service';
export * from './src/main/pi/jev/credentials';
export * from './src/main/pi/jev/tool';
export { jevRequiresAction } from './src/main/pi/jev/workflow';
export { PiStore } from './src/renderer/src/state/pi-store';
export { loadSettings } from './src/main/settings';
export { ceilingNeedsExtensions } from './src/main/pi/subagents/runtime';
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
extensionFactories:options.resourceLoaderOptions.extensionFactories}})};` }))
    } }]
  })
  const { PiManager, PiStore, jevRequiresAction, loadSettings, JevService, JevCredentials, parseJevRequest, readJevResult, JEV_MODEL, buildToolCatalog, ceilingNeedsExtensions } = await import(pathToFileURL(outfile).href)
  await writeFile(join(temporary, 'app-settings.json'), JSON.stringify({ jev: { enabled: true, score: false } }))
  assert.deepEqual(loadSettings().jev, { mode: 'tools', choice: true, score: false, noul: true }, 'migrate legacy enabled settings')
  await writeFile(join(temporary, 'app-settings.json'), '{}')
  const prefs = { mode: 'tools', choice: true, score: true, noul: true }
  const request = { state: 'The app crashes every time Settings opens.', questions: {
    category: { type: 'choice', instructions: 'Classify this report.', criteria: { bug: 'Broken existing feature', other: 'Something else' } },
    severity: { type: 'score', instructions: 'Rate impact.', criteria: ['Cosmetic', 'Feature unavailable', 'Crash'] },
    reproducible: { type: 'noul', instructions: 'Does it explicitly happen every time?', criteria: { true: 'Explicitly reports every time', false: 'No explicit claim of every occurrence' } }
  } }
  const response = { model: JEV_MODEL, answers: {
    category: { type: 'choice', choice: 'bug', confidence: 0.9, probabilities: { bug: 0.95, other: 0.05 } },
    severity: { type: 'score', score: 1.9, confidence: 0.9, probabilities: { 0: 0, 1: 0.1, 2: 0.9 }, legend: { 0: 'ignored remote label' } },
    reproducible: { type: 'noul', noul: 0.99 }
  }, usage: { input_tokens: 100, output_tokens: 10 } }
  const code = expected => error => error.code === expected && error.message === `JEV_${expected}`
  for (const invalid of [undefined, null, {}, { ...request, extra: true }, { ...request, state: ' ' },
    { ...request, questions: {} }, { ...request, questions: { 'bad.id': request.questions.reproducible } },
    { ...request, state: '中'.repeat(32000) }, { ...request, questions: { a: { ...request.questions.severity, criteria: ['one'] } } }]) {
    assert.throws(() => parseJevRequest(invalid, prefs), code('invalid_input'))
  }
  const circular = { ...request }; circular.state = circular
  assert.throws(() => parseJevRequest(circular, prefs), code('invalid_input'))
  assert.throws(() => parseJevRequest(request, { ...prefs, score: false }), code('capability_disabled'))
  for (const criteria of [{ true: 'Only one outcome' }, { true: ' ', false: 'No' }, { true: 'Yes', false: 'No', maybe: 'Unknown' }]) {
    assert.throws(() => parseJevRequest({ ...request, questions: { q: { type: 'noul', instructions: 'Is it reproducible?', criteria } } }, prefs), code('invalid_input'))
  }
  const copy = parseJevRequest(request, prefs)
  assert.notEqual(copy.questions, request.questions)
  assert.equal(readJevResult(response, request, 1).answers.severity.legend[0], 'Cosmetic')
  for (const mutate of [r => r.answers.category.choice = 'unknown', r => r.answers.reproducible.noul = NaN,
    r => r.answers.severity.score = 3, r => r.answers.category.probabilities.bug = 0.1,
    r => delete r.answers.category, r => r.usage.input_tokens = -1]) {
    const bad = structuredClone(response); mutate(bad)
    assert.throws(() => readJevResult(bad, request, 0), code('invalid_response'))
  }
  let fetches = 0
  const fetch = async (url, init) => {
    fetches++
    assert.equal(String(url), 'https://api.typesafe.ai/v1/systemone')
    const body = JSON.parse(init.body)
    assert.equal(body.model, JEV_MODEL)
    if (body.questions.reproducible.criteria) assert.deepEqual(body.questions.reproducible.criteria, request.questions.reproducible.criteria)
    const reply = structuredClone(response)
    if (body.questions.category.criteria.feature) reply.answers.category.probabilities = { bug: 0.95, feature: 0.05 }
    return new Response(JSON.stringify(reply), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  const service = new JevService({ preferences: () => prefs, apiKey: async () => 'fixture-secret', fetch })
  assert.equal((await service.evaluate(request, { owner: 'one' })).answers.category.choice, 'bug')
  prefs.mode = 'off'
  await assert.rejects(service.evaluate(request, { owner: 'one' }), code('disabled'))
  prefs.mode = 'tools'
  await assert.rejects(service.evaluate(request, { owner: 'one', signal: AbortSignal.abort() }), code('cancelled'))
  await assert.rejects(service.evaluate(request, { owner: 'one', canStart: () => false }), code('cancelled'))
  assert.equal(fetches, 1)
  let admit = true
  const lateKey = new JevService({ preferences: () => prefs, apiKey: async () => { admit = false; return 'fixture-secret' }, fetch })
  await assert.rejects(lateKey.evaluate(request, { owner: 'one', canStart: () => admit }), code('cancelled'))
  assert.equal(fetches, 1, 'stop during credential lookup prevents network admission')
  const missing = new JevService({ preferences: () => prefs, apiKey: async () => undefined, fetch })
  await assert.rejects(missing.evaluate(request, { owner: 'one' }), code('missing_key'))
  for (const [status, expected] of [[401, 'authentication'], [403, 'authentication'], [429, 'rate_limit'], [422, 'invalid_input'], [500, 'network']]) {
    let attempts = 0
    const errorService = new JevService({ preferences: () => prefs, apiKey: async () => 'fixture-secret', fetch: async () => {
      attempts++; return new Response(JSON.stringify({ error: { message: 'fixture-secret must never escape' } }), { status })
    } })
    await assert.rejects(errorService.evaluate(request, { owner: 'one' }), code(expected))
    assert.equal(attempts, 1, 'no hidden SDK retries')
  }
  const waitingFetch = async (_url, init) => new Promise((_resolve, reject) => {
    if (init.signal.aborted) reject(new DOMException('Aborted', 'AbortError'))
    else init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
  })
  const timeout = new JevService({ preferences: () => prefs, apiKey: async () => 'fixture-secret', fetch: waitingFetch, timeoutMs: 25 })
  await assert.rejects(timeout.evaluate(request, { owner: 'one' }), code('timeout'))
  const concurrent = new JevService({ preferences: () => prefs, apiKey: async () => 'fixture-secret', fetch: waitingFetch })
  const calls = Array.from({ length: 4 }, (_, i) => concurrent.evaluate(request, { owner: String(i) }).then(() => 'ok', e => e.code))
  await assert.rejects(concurrent.evaluate(request, { owner: 'extra' }), code('busy'))
  concurrent.cancel('0')
  assert.equal(await calls[0], 'cancelled')
  assert.equal(concurrent.requests.size, 3, 'owner cancellation leaves sibling requests running')
  concurrent.dispose()
  assert.deepEqual(await Promise.all(calls), ['cancelled', 'cancelled', 'cancelled', 'cancelled'])
  await assert.rejects(concurrent.evaluate(request, { owner: 'new' }), code('cancelled'))
  console.log('PASS: Jev schema, response verification, sanitized errors, stop/timeout, concurrency and owner cancellation')

  const credentialsPath = join(agentDir, 'isolated-jev.json')
  const credentials = new JevCredentials(credentialsPath, () => 'environment-fixture')
  assert.equal(await credentials.source(), 'environment')
  await credentials.save('saved-fixture')
  assert.equal(await credentials.key(), 'saved-fixture')
  assert.equal(await credentials.source(), 'saved')
  assert.equal((await stat(credentialsPath)).mode & 0o777, 0o600)
  const reloaded = new JevCredentials(credentialsPath, () => undefined)
  assert.equal(await reloaded.key(), 'saved-fixture')
  await credentials.save(null)
  assert.equal(await credentials.key(), 'environment-fixture')
  assert.equal(await reloaded.source(), 'missing')
  await writeFile(credentialsPath, '{corrupt')
  assert.equal(await credentials.source(), 'unavailable')
  await assert.rejects(credentials.key(), code('credentials'))
  await credentials.save('repaired-fixture')
  assert.equal(await credentials.key(), 'repaired-fixture')
  await assert.rejects(credentials.save('invalid\nkey'), code('invalid_input'))
  console.log('PASS: local credentials, 0600 permissions, environment fallback, read errors and replacement')

  const runtime = await ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: join(agentDir, 'models.json'), modelsStorePath: join(agentDir, 'models-store'), refreshOnCreate: false })
  runtime.hasConfiguredAuth = () => true
  runtime.checkAuth = () => { throw new Error('Unexpected model credential access') }
  // The visual workflow case requires an image-capable primary fixture.
  runtime.getAvailableSnapshot = () => [{ id: 'fixture', name: 'fixture', provider: 'fixture', api: 'openai-completions', baseUrl: 'http://127.0.0.1:1', reasoning: false, input: ['text', 'image'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 4096 }]
  const app = new PiManager(() => {}, error => { throw new Error(error) }); apps.push(app)
  app.runtime = async () => runtime
  app.jevService.options.fetch = fetch
  const managed = await app.buildSession(SessionManager.create(project, join(temporary, 'sessions')))
  await managed.lifecyclePromise
  const { session } = managed
  assert(session.getToolDefinition('jev_decide'), 'registered even when disabled')
  assert(!session.getActiveToolNames().includes('jev_decide'))
  assert.equal((await app.updateJevSettings({ preferences: { ...prefs } })).ok, true)
  assert(session.getActiveToolNames().includes('jev_decide'), 'enabling reaches existing sessions')
  assert.match(session.agent.state.tools.find(t => t.name === 'jev_decide').description, /Currently enabled question types: choice, score, noul\./)
  assert.match(session.systemPrompt, /Jev never sees question IDs/)
  assert.equal((await app.updateJevSettings({ apiKey: 'manager-fixture' })).ok, true)
  const settings = await app.jevSettings()
  assert.equal(settings.keySource, 'saved')
  assert(!JSON.stringify(settings).includes('manager-fixture'))
  assert(!(await readFile(join(temporary, 'app-settings.json'), 'utf8')).includes('manager-fixture'))
  const catalog = buildToolCatalog(managed.resourceLoader, session.getAllTools(), session.getActiveToolNames(), new Set(), new Map(), new Map())
  assert.equal(catalog.tools.find(t => t.name === 'jev_decide')?.source.kind, 'builtin')
  assert.equal(ceilingNeedsExtensions(['jev_decide'], session.getAllTools()), false)
  const entered = await app.setSessionMode({ sessionPath: managed.path, mode: 'plan' })
  assert.equal(entered.ok, true)
  assert(managed.gate.tools().some(t => t.name === 'jev_decide' && t.provenance === 'app'), 'Plan admits only the owned definition')
  let step = 0, stamp = Date.now()
  runtime.streamSimple = () => {
    const content = ++step === 1 ? [{ type: 'toolCall', id: 'sdk-jev', name: 'jev_decide', arguments: request }] : [{ type: 'text', text: 'Judgment received.' }]
    const message = { role: 'assistant', content, provider: 'fixture', model: 'fixture', api: 'openai-completions', stopReason: step === 1 ? 'toolUse' : 'stop', timestamp: ++stamp,
      usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }
    return { async *[Symbol.asyncIterator]() { yield { type: 'start', partial: { ...message, content: [] } }; yield { type: 'done', message } }, result: async () => message }
  }
  await session.prompt('Classify the synthetic bug report with Jev.')
  const toolResult = session.messages.find(m => m.role === 'toolResult' && m.toolCallId === 'sdk-jev')
  assert(toolResult, JSON.stringify(session.messages))
  assert(!toolResult.isError, JSON.stringify(toolResult))
  assert.equal(toolResult.details.kind, 'pi-app-jev')
  assert.equal(toolResult.details.evaluation.answers.category.choice, 'bug')
  assert(!(await readFile(managed.path, 'utf8')).includes('manager-fixture'), 'credential never enters persisted transcript')
  // A setting change must cancel an already-started call, including human probes.
  let reachedNetwork = false
  app.jevService.options.fetch = (url, init) => { reachedNetwork = true; return waitingFetch(url, init) }
  const inFlight = app.testJev()
  await until(() => reachedNetwork)
  await app.updateJevSettings({ preferences: { ...prefs, score: false } })
  assert.equal((await inFlight).code, 'cancelled')
  assert.match(session.agent.state.tools.find(t => t.name === 'jev_decide').description, /Currently enabled question types: choice, noul\./, 'real model-facing descriptor follows live flags, not SDK registration-time cache')
  managed.gate.refresh()
  assert.match(session.agent.state.tools.find(t => t.name === 'jev_decide').description, /Currently enabled question types: choice, noul\./, 'Plan rematerialization preserves current capabilities')
  app.jevService.options.fetch = fetch
  await app.updateJevSettings({ preferences: { ...prefs } })
  const held = session.getToolDefinition('jev_decide')
  // A held definition still enforces settings; Plan provenance remains covered by check-plan-mode.
  await app.updateJevSettings({ preferences: { ...prefs, mode: 'off' } })
  assert(!session.getActiveToolNames().includes('jev_decide'))
  await assert.rejects(held.execute('disabled', request), code('disabled'))
  const probe = await app.testJev()
  assert.equal(probe.ok, true, 'explicit settings test works while model access is disabled')
  assert.equal((await app.updateJevSettings({ preferences: { mode: 'invalid' } })).code, 'invalid_input')
  assert.equal((await app.updateJevSettings({ apiKey: null })).ok, true)
  // Exercise immutable child ceilings without permitting a new permission source.
  const oldRole = managed.subagentChild
  managed.subagentChild = { toolCeiling: ['read'] }
  await app.updateJevSettings({ preferences: { ...prefs } })
  assert(!session.getActiveToolNames().includes('jev_decide'), 'enabling never widens a frozen child ceiling')
  managed.subagentChild = { toolCeiling: ['read', 'jev_decide'] }
  app.applyActiveTools(managed, managed.resourceLoader)
  assert(session.getActiveToolNames().includes('jev_decide'))
  await app.updateJevSettings({ preferences: { ...prefs, mode: 'off' } })
  assert(!session.getActiveToolNames().includes('jev_decide'))
  managed.subagentChild = oldRole
  console.log('PASS: real SDK registration, live settings, prompt/catalog, Plan admission and frozen child ceiling')

  // Exercise the mandatory controller through the REAL manager/SDK provider boundary.
  // Replacing agent.streamFunction here would accidentally remove the controller.
  let route = 'act', actions = [], evidence = [], contexts = [], outputs = [], primaryCalls = 0
  const workflowFetch = async (_url, init) => {
    const input = JSON.parse(init.body)
    evidence.push(JSON.parse(input.state))
    const action = input.questions.review ? (actions.shift() ?? 'stop') : undefined
    const answers = Object.fromEntries(Object.entries(input.questions).map(([id, q]) => {
      const choice = id === 'route' ? route : action === 'stop' ? 'complete' : ['blocked', 'uncertain'].includes(action) ? action
        : action?.startsWith('verify:') ? Object.keys(q.criteria).filter(k => k.startsWith('verify_'))[Number(action.slice(7))]
        : action === 'verify' ? (Object.keys(q.criteria).find(k => k.startsWith('verify_')) ?? 'implement_request')
        : action === 'retry' ? (Object.keys(q.criteria).find(k => k.startsWith('repair_')) ?? 'implement_request') : 'implement_request'
      return [id, { type: 'choice', choice, confidence: 1, probabilities: Object.fromEntries(Object.keys(q.criteria).map(key => [key, key === choice ? 1 : 0])) }]
    }))
    return new Response(JSON.stringify({ model: JEV_MODEL, answers, usage: { input_tokens: 30, output_tokens: 5 } }), { status: 200 })
  }
  runtime.streamSimple = (_model, context) => {
    primaryCalls++; contexts.push(JSON.parse(JSON.stringify(context)))
    const content = outputs.shift() ?? [{ type: 'text', text: 'Requested result.' }]
    const message = { role: 'assistant', content, provider: 'fixture', model: 'fixture', api: 'openai-completions',
      stopReason: content.some(p => p.type === 'toolCall') ? 'toolUse' : 'stop', timestamp: ++stamp,
      usage: { input: 10, output: 5, cacheRead: 20, cacheWrite: 0, totalTokens: 35, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }
    return { async *[Symbol.asyncIterator]() { yield { type: 'done', message } }, result: async () => message }
  }
  const makeWorkflow = async () => {
    evidence = []; contexts = []; outputs = []; primaryCalls = 0; actions = []; route = 'act'
    app.jevService.options.fetch = workflowFetch
    await app.updateJevSettings({ apiKey: 'workflow-fixture' })
    await app.updateJevSettings({ preferences: { ...prefs, mode: 'workflow' } })
    const m = await app.buildSession(SessionManager.create(project, join(temporary, 'sessions')))
    await m.lifecyclePromise
    assert(m.jevWorkflow)
    assert(!m.session.getActiveToolNames().includes('jev_decide'), 'workflow owns its judgments, no optional recursive tool')
    return m
  }
  for (const text of ['将 jev 三种运行模式并排放（不单独一行）。', '直接修改。', 'Please fix the layout', 'Can you implement the feature?']) assert(jevRequiresAction(text), text)
  for (const text of ['如何修改布局？', '解释如何实现', 'How do I fix the layout?', 'Explain only, do not edit code.', 'Jev 是如何修改代码的？', '修改代码是什么意思？请只解释。']) assert(!jevRequiresAction(text), text)
  const corrections = await makeWorkflow()
  route = 'respond'; actions = ['stop', 'stop']
  const writeCall = id => [{ type: 'toolCall', id, name: 'write', arguments: { path: 'workflow.txt', content: 'verified change' } }]
  outputs = [[{ type: 'text', text: 'You could use a horizontal flex layout.' }], [{ type: 'toolCall', id: 'inspect-project', name: 'read', arguments: { path: 'missing-project-file.txt' } }], writeCall('allowed'), [{ type: 'text', text: 'Change saved.' }]]
  await corrections.session.prompt('将 jev 三种运行模式并排放（不单独一行）。 api_key=fixture-credential')
  const outcome = corrections.jevWorkflow.snapshot
  assert.equal(outcome.phase, 'completed', JSON.stringify({outcome,evidence,messages:corrections.session.messages})); assert.equal(outcome.corrections, 1)
  assert.equal(outcome.requests, 4); assert.equal(outcome.mainOutput, 20); assert.equal(outcome.cacheRead, 80)
  assert.equal(outcome.jevInput, 90)
  assert.equal(await readFile(join(project, 'workflow.txt'), 'utf8'), 'verified change')
  assert.equal(corrections.session.messages.find(m => m.role === 'toolResult' && m.toolCallId === 'inspect-project').isError, true)
  assert.equal(contexts[0].messages.at(-1).content[0].text.includes('workflow: act'), true, 'explicit action request corrects a respond route before execution')
  const traces = app.jevTraces(corrections.path)
  assert.equal(traces.items.length, 3)
  assert.equal(traces.items[1].override, 'missing_evidence')
  assert.equal(traces.items[1].choice, 'complete'); assert.equal(traces.items[1].effectiveChoice, 'continue')
  assert.equal(traces.items[2].override, 'action_request')
  const detail = app.jevTrace(corrections.path, traces.items[1].id)
  assert.equal(detail.evaluation.answers.review.choice, 'complete', 'keep original output distinct from app correction')
  assert(!JSON.stringify(detail).includes('fixture-credential'))
  assert(!contexts.some(c => JSON.stringify(c.messages).includes('pith_jev_judgment_v1')), 'audit records never enter model requests')
  assert.equal(corrections.session.messages.filter(m => m.role === 'user').length, 1, 'correction is not a new user turn/checkpoint')
  assert(evidence.some(e => e.results.some(r => r.isError)), 'verifier sees actual failed tool results')
  assert(!JSON.stringify(evidence).includes('fixture-credential'), 'common credential patterns redacted')
  for (const context of contexts) {
    assert.deepEqual(context.messages.filter(m => m.role === 'system'), contexts[0].messages.filter(m => m.role === 'system'), 'stage changes preserve system prompt and tool schema/order')
  }
  assert.deepEqual(contexts[1].messages.slice(0, contexts[0].messages.length), contexts[0].messages, 'the actual model request keeps the preceding guidance prefix')
  const store = new PiStore(), snapshot = app.snapshotOf(corrections)
  store.applySnapshot(snapshot)
  const olderSeq = snapshot.eventSequence
  store.dispatch({ type: 'jev_workflow_update', sessionPath: corrections.path, jevWorkflow: { ...outcome, phase: 'paused' }, jevWorkflowSeq: 1_000_000 })
  store.applySnapshot(snapshot)
  assert.equal(store.getState().jevWorkflow.phase, 'paused', 'stale snapshot cannot replace fresher sequence-free workflow metadata')
  assert.equal(store.getState().eventSequence, olderSeq, 'workflow metadata never advances transcript sequence')
  store.dispatch({ type: 'jev_workflow_update', sessionPath: corrections.path, jevWorkflow: null, jevWorkflowSeq: 1_000_001 })
  store.applySnapshot(snapshot)
  assert.equal(store.getState().jevWorkflow, null, 'a disabled state also rejects stale snapshots')

  const waiting = await makeWorkflow()
  const actualFacts = app.planFacts.bind(app)
  app.planFacts = m => ({ ...actualFacts(m), ...(m === waiting ? { tasks: 1 } : {}) })
  await waiting.session.prompt('Wait for the background work, then report.')
  assert.equal(waiting.jevWorkflow.snapshot.phase, 'waiting')
  assert.equal(evidence.length, 1, 'no verifier may certify pending background work')
  app.planFacts = actualFacts
  await waiting.session.sendCustomMessage({ customType: 'bash_task_completion', display: false, content: 'Background task completed successfully.' }, { triggerTurn: true, deliverAs: 'steer' })
  assert.equal(waiting.jevWorkflow.snapshot.phase, 'completed')
  assert.equal(evidence.length, 2, 'background wake verifies within the same routing epoch')
  assert(evidence[1].results.some(r => r.tool === 'bash_task_completion' && /completed successfully/.test(r.excerpt)), 'the verifier receives actual committed background completion evidence')
  assert.equal(waiting.jevWorkflow.snapshot.requests, 2)

  const visual = await makeWorkflow(); route = 'respond'
  const privateImage = (await readFile(new URL('../resources/icons/16x16.png', import.meta.url))).toString('base64')
  await visual.session.prompt('Explain this screenshot.', { images: [{ type: 'image', data: privateImage, mimeType: 'image/png' }] })
  assert.equal(visual.jevWorkflow.snapshot.phase, 'completed')
  assert(evidence.every(e => e.attachmentsOmitted === true), 'Jev is explicitly told about omitted images')
  assert(!JSON.stringify(evidence).includes(privateImage), 'image bytes never enter Jev requests')
  assert(contexts[0].messages.some(m => Array.isArray(m.content) && m.content.some(c => c.type === 'image')), 'the primary executor keeps the image')

  const planning = await makeWorkflow()
  assert.equal((await app.setSessionMode({ sessionPath: planning.path, mode: 'plan' })).ok, true)
  outputs = [[{ type: 'toolCall', id: 'jev-plan', name: 'submit_plan', arguments: { plan: '# Plan\nInvestigate, implement after approval, then run checks.' } }]]
  await planning.session.prompt('Plan the requested implementation.')
  assert.equal(planning.plan.submissionLocked, true)
  assert.equal(primaryCalls, 1, 'Plan submission still reaches the primary model')
  assert.equal(evidence.length, 0, 'Plan mode bypasses Jev implementation routing and verification')
  assert.equal(planning.jevWorkflow.snapshot, null)

  const continuous = await makeWorkflow(); actions = Array(30).fill('continue')
  outputs = Array.from({ length: 31 }, (_, i) => [
    [{ type: 'toolCall', id: `progress-${i}`, name: 'write', arguments: { path: 'continuous.txt', content: String(i) } }],
    [{ type: 'text', text: `Implemented stage ${i}.` }]
  ]).flat()
  await continuous.session.prompt('Update continuous.txt.')
  assert.equal(primaryCalls, 62); assert.equal(continuous.jevWorkflow.snapshot.phase, 'completed')
  assert.equal(continuous.jevWorkflow.snapshot.corrections, 30, 'no request or correction cap')
  const firstPage = app.jevTraces(continuous.path)
  assert.equal(firstPage.items.length, 30); assert(firstPage.nextCursor)
  assert(!('request' in firstPage.items[0]), 'list does not ship request evidence')
  const lastPage = app.jevTraces(continuous.path, firstPage.nextCursor)
  assert.equal(lastPage.items.length, 2); assert.equal(lastPage.nextCursor, null)
  const path = continuous.path
  await app.disposeManaged(continuous)
  const reopened = await app.buildSession(SessionManager.open(path)); await reopened.lifecyclePromise
  assert.equal(reopened.jevWorkflow.snapshot.phase, 'completed', 'counts beyond former caps restore')
  assert.equal(app.jevTrace(path, firstPage.items[0].id).evaluation.answers.review.choice, 'complete', 'audit survives reopen')
  const beforeTrace = reopened.session.sessionManager.getBranch().find(e => e.type === 'message' && e.message.role === 'user')
  reopened.session.sessionManager.branch(beforeTrace.id)
  assert.equal(app.jevTraces(path).items.length, 0, 'rewind reads only the selected branch')
  assert.equal(app.jevTrace(path, firstPage.items[0].id), null, 'off-branch details are unavailable')

  const stalled = await makeWorkflow(); actions = ['verify', 'verify', 'verify']
  outputs = [writeCall('stalled-write'), [{ type: 'text', text: 'Change saved and checked.' }],
    [{ type: 'toolCall', id: 'stalled-read', name: 'read', arguments: { path: 'workflow.txt' } }], [{ type: 'text', text: 'The requested change is present.' }]]
  await stalled.session.prompt('Write workflow.txt with verified change.')
  assert.equal(primaryCalls, 4, 'same target on unchanged code cannot schedule endless primary requests')
  assert.equal(stalled.jevWorkflow.snapshot.reason, 'no_progress')
  assert.equal(stalled.jevWorkflow.snapshot.phase, 'paused', 'unresolved semantic disagreement is never called success')
  const stalledTrace = app.jevTraces(stalled.path).items[0]
  assert.equal(stalledTrace.override, 'no_progress'); assert(stalledTrace.target.instruction.includes('workflow.txt'))
  assert.equal(stalledTrace.effectiveChoice, 'needs_review')
  await stalled.session.agent.continue()
  assert.equal(primaryCalls, 4, 'SDK drain cannot restart the stalled review')
  const largeEvidence = { request: '中'.repeat(3500), priorContext: [{ role: 'user', text: '中'.repeat(800) }, { role: 'assistant', text: '中'.repeat(800) }],
    attachmentsOmitted: false, revision: 'revision', versions: {}, generation: 1, changedFiles: [], externalChanges: [], omitted: 0, fingerprint: 'fingerprint',
    items: Array.from({ length: 48 }, (_, i) => ({ id: String(i), kind: 'check', key: String(i), tool: 'bash', status: 'success', generation: 1, excerpt: '中'.repeat(3200) })) }
  const largeTargets = Array.from({ length: 17 }, (_, i) => ({ id: i ? `verify_${i}` : 'implement_request', kind: 'verification', requirement: 'Original task', instruction: '中'.repeat(1900), paths: [], evidenceIds: [] }))
  const packed = stalled.jevWorkflow.fitRequest(largeEvidence, { message: { role: 'assistant', content: [{ type: 'text', text: '中'.repeat(2200) }] } }, largeTargets, [])
  parseJevRequest(packed, prefs)
  assert(JSON.parse(packed.state).reviewTargetsOmitted > 0, 'wire-budget truncation is explicit even for large Unicode criteria')
  const resumedRoute = stalled.jevWorkflow.packEvidence(largeEvidence, { route: { type: 'choice', instructions: 'Route this resumed task', criteria: { act: 'Execute', inspect: 'Investigate' } } })
  parseJevRequest(resumedRoute, prefs)
  assert(JSON.parse(resumedRoute.state).resultsOmitted > 0, 'resumed routing also bounds the retained ledger')
  const stalledPath = stalled.path
  await app.disposeManaged(stalled)
  const restoredStalled = await app.buildSession(SessionManager.open(stalledPath)); await restoredStalled.lifecyclePromise
  assert.equal(restoredStalled.jevWorkflow.snapshot.reason, 'no_progress', 'reopening preserves the specific unresolved reason instead of replacing it with interruption')

  const alternating = await makeWorkflow(); actions = ['verify:0', 'verify:1', 'verify:0']
  outputs = [[...writeCall('two-files-a'), { type: 'toolCall', id: 'two-files-b', name: 'write', arguments: { path: 'second.txt', content: 'verified' } }],
    [{ type: 'text', text: 'Both files saved.' }], [{ type: 'toolCall', id: 'check-a', name: 'read', arguments: { path: 'workflow.txt' } }],
    [{ type: 'text', text: 'First target checked.' }], [{ type: 'toolCall', id: 'temporary-test', name: 'write', arguments: { path: '.tmp-test.txt', content: 'check output' } }],
    [{ type: 'text', text: 'Second target checked.' }]]
  await alternating.session.prompt('Write workflow.txt and second.txt.')
  assert.equal(primaryCalls, 6); assert.equal(alternating.jevWorkflow.snapshot.reason, 'no_progress', 'A/B/A and unrelated temporary writes cannot reset the detector')

  for (const reason of ['blocked', 'uncertain']) {
    const unresolved = await makeWorkflow(); actions = [reason]
    outputs = [[{ type: 'toolCall', id: 'inspect-unresolved', name: 'read', arguments: { path: 'workflow.txt' } }], [{ type: 'text', text: 'Additional essential information is unavailable.' }]]
    await unresolved.session.prompt('Inspect the requested file.')
    assert.equal(unresolved.jevWorkflow.snapshot.phase, 'paused')
    assert.equal(unresolved.jevWorkflow.snapshot.reason, reason, 'blockers and unidentifiable gaps must never be called completion')
    assert.equal(primaryCalls, 2)
  }

  const failedRouter = await makeWorkflow()
  app.jevService.options.fetch = async () => new Response('{}', { status: 401 })
  await failedRouter.session.prompt('Do a task.')
  assert.equal(primaryCalls, 0); assert.equal(failedRouter.jevWorkflow.snapshot.reason, 'authentication')
  assert.equal(app.jevTraces(failedRouter.path).items[0].error, 'authentication', 'failed judgments have an inspectable safe error')
  for (const delivery of ['steer', 'followUp']) {
    const queued = await makeWorkflow()
    let continues = 0, settled = 0
    const previousContinue = queued.session.agent.continue
    // Bound the regression itself: the broken outer loop otherwise starves
    // timers indefinitely while repeatedly awaiting a no-op continue().
    queued.session.agent.continue = async (...args) => {
      if (++continues > 2) throw new Error('Paused Jev spun the SDK continuation loop')
      return previousContinue.apply(queued.session.agent, args)
    }
    const unsubscribe = queued.session.subscribe(event => { if (event.type === 'agent_settled') settled++ })
    app.jevService.options.fetch = async (url, init) => {
      if (!JSON.parse(init.body).questions.review) return workflowFetch(url, init)
      await queued.session[delivery]('Keep this queued input.')
      return new Response('{}', { status: 401 })
    }
    await queued.session.prompt('Answer this question.')
    assert.equal(queued.jevWorkflow.snapshot.reason, 'authentication')
    assert.equal(continues, 0, 'a paused verifier must stop outer-loop queue draining')
    assert.equal(settled, 1)
    assert.equal(queued.session.isIdle, true)
    assert.deepEqual(delivery === 'steer' ? queued.session.getSteeringMessages() : queued.session.getFollowUpMessages(), ['Keep this queued input.'])
    unsubscribe()
    queued.session.agent.continue = previousContinue
    queued.session.clearQueue()
    app.jevService.options.fetch = workflowFetch
    await queued.session.prompt('Answer a new question.')
    assert.equal(queued.jevWorkflow.snapshot.phase, 'completed', 'a new user turn can resume after a paused run')
  }
  const cancelled = await makeWorkflow()
  let verifying = false
  app.jevService.options.fetch = (url, init) => {
    if (JSON.parse(init.body).questions.review) { verifying = true; return waitingFetch(url, init) }
    return workflowFetch(url, init)
  }
  const pendingVerification = cancelled.session.prompt('Answer this question.')
  await until(() => verifying)
  await cancelled.session.abort(); await pendingVerification
  assert.equal(primaryCalls, 1); assert.equal(cancelled.jevWorkflow.snapshot.phase, 'paused')
  assert.equal(cancelled.jevWorkflow.snapshot.reason, 'cancelled')

  const switched = await makeWorkflow()
  let routing = false
  app.jevService.options.fetch = (url, init) => { routing = true; return waitingFetch(url, init) }
  const pendingRoute = switched.session.prompt('Route this task.')
  await until(() => routing)
  await app.updateJevSettings({ preferences: { ...prefs, mode: 'off' } }); await pendingRoute
  assert.equal(primaryCalls, 0); assert.equal(switched.jevWorkflow.snapshot, null)
  app.jevService.options.fetch = workflowFetch
  await switched.session.prompt('Jev is now off.')
  assert.equal(primaryCalls, 1, 'off mode restores ordinary primary execution')
  const boundary = await createPlanFixture({
    extensionFactories: [pi => pi.on('agent_before_settle', event => ({ continue: true, entries: [...event.entries,
      { type: 'custom_message', customType: 'fixture_continuation', content: 'Continue this task.', display: false }] }))]
  })
  try {
    await boundary.managed.lifecyclePromise
    assert((await boundary.app.updateJevSettings({ apiKey: 'boundary-fixture' })).ok)
    assert((await boundary.app.updateJevSettings({ preferences: { ...prefs, mode: 'workflow' } })).ok)
    boundary.app.jevService.options.fetch = (url, init) => JSON.parse(init.body).questions.review
      ? new Response('{}', { status: 401 }) : workflowFetch(url, init)
    let continues = 0
    const previousContinue = boundary.session.agent.continue
    boundary.session.agent.continue = async (...args) => {
      if (++continues > 2) throw new Error('Paused Jev spun the SDK boundary continuation loop')
      return previousContinue.apply(boundary.session.agent, args)
    }
    await boundary.session.prompt('Answer this question.')
    assert.equal(boundary.requests.length, 1)
    assert.equal(boundary.managed.jevWorkflow.snapshot.reason, 'authentication')
    assert.equal(boundary.session.isIdle, true)
    assert.equal(continues, 1, 'extension continuation cannot bypass a paused verifier or spin the outer loop')
  } finally { await boundary.close() }
  console.log('PASS: mandatory routing, action-intent correction, evidence verification, continuous execution, paged audit, cache prefix, pause/recovery, cancellation and mode switching')

  if (process.env.PI_JEV_LIVE_KEY_FILE || process.env.PI_JEV_LIVE_SAVED_KEY_FILE) {
    const key = process.env.PI_JEV_LIVE_SAVED_KEY_FILE ? await new JevCredentials(process.env.PI_JEV_LIVE_SAVED_KEY_FILE, () => undefined).key() : (await readFile(process.env.PI_JEV_LIVE_KEY_FILE, 'utf8')).trim()
    const live = new JevService({ preferences: () => prefs, apiKey: async () => key })
    const evaluation = await live.probe()
    console.log('LIVE Jev synthetic probe:', JSON.stringify(evaluation))
    live.dispose()
    const liveWorkflow = await makeWorkflow()
    app.jevService.options.fetch = undefined
    await app.updateJevSettings({ apiKey: key })
    outputs = Array.from({ length: 3 }, () => [{ type: 'text', text: 'OK' }])
    await liveWorkflow.session.prompt('Reply exactly OK. No tools or other work are needed.')
    assert.equal(liveWorkflow.jevWorkflow.snapshot.phase, 'completed', JSON.stringify(liveWorkflow.jevWorkflow.snapshot))
    console.log('LIVE Jev workflow (synthetic task, mocked primary executor):', JSON.stringify(liveWorkflow.jevWorkflow.snapshot))
    const liveChange = await makeWorkflow()
    app.jevService.options.fetch = undefined
    await app.updateJevSettings({ apiKey: key })
    await writeFile(join(project, 'icons-example.js'), "const tabIcon = 'ListChecks';\n")
    outputs = [[{ type: 'toolCall', id: 'live-write', name: 'write', arguments: { path: 'icons-example.js', content: "const tabIcon = 'Flask';\n" } }],
      [{ type: 'toolCall', id: 'live-check', name: 'bash', arguments: { command: "node -e \"const fs=require('fs');if(!fs.readFileSync('icons-example.js','utf8').includes(\\\"tabIcon = 'Flask'\\\"))throw Error('wrong icon');console.log('PASS: tabIcon is Flask')\"" } }],
      [{ type: 'text', text: '已将 icons-example.js 的 tabIcon 从 ListChecks 改为 Flask，实际读取文件的断言检查通过。' }]]
    await liveChange.session.prompt('把 icons-example.js 的 tabIcon 从 ListChecks 换成 Flask，并检查文件里的实际值。')
    assert.equal(liveChange.jevWorkflow.snapshot.phase, 'completed', JSON.stringify(liveChange.jevWorkflow.snapshot))
    assert.equal(primaryCalls, 3, 'real Jev should accept the actual change/check without extra executor rounds')
    assert.equal(liveChange.jevWorkflow.snapshot.corrections, 0)
    console.log('LIVE task convergence:', JSON.stringify({ primaryRequests: primaryCalls, judgments: app.jevTraces(liveChange.path).items.length, corrections: 0, phase: liveChange.jevWorkflow.snapshot.phase }))

  }
} finally {
  await Promise.all(apps.map(app => app.dispose()))
  await rm(temporary, { recursive: true, force: true })
}
