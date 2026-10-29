/**
 * Session-scoped switches during a run: the model, the thinking level and the
 * DSH sandbox mode are the composer's bottom-row choices. Changing one while a
 * run is streaming is gated by Settings → General ("allow mid-run changes") —
 * off by default, the manager refuses every one of them for as long as the run
 * is live, and accepts the same call the moment it settles; on, the switches
 * are accepted mid-run, land in the snapshot the composer applies, and take
 * effect on the next model/tool call of the run already in flight.
 *
 * Real offline SDK fixture with a gate tool holding the run open; no model or
 * network calls, no user data. Run after `npm run build` (esbuild bundles the
 * app modules, so no build output is read).
 */
import assert from 'node:assert/strict'
import { Type } from 'typebox'
import { createPlanFixture } from './lib/plan-fixture.mjs'

const deferred = () => {
  let resolve
  return { promise: new Promise((done) => { resolve = done }), resolve: (value) => resolve(value) }
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const until = async (predicate) => {
  const deadline = Date.now() + 15000
  while (!predicate()) { assert(Date.now() < deadline, 'mid-run fixture timed out'); await delay(10) }
}
/** The switch may refuse synchronously (the sandbox mode) or reject (the
 * async model/thinking setters), so both shapes are caught here. */
const refusal = async (call) => {
  try { await call(); return null } catch (error) { return error }
}

const gate = deferred()
let entered = 0
const f = await createPlanFixture({ extensionFactories: [api => {
  api.registerTool({
    name: 'mid_run_gate', label: 'Mid-run gate', description: 'Hold the run open for the switch checks.',
    parameters: Type.Object({}),
    execute: async () => {
      entered += 1
      await gate.promise
      return { content: [{ type: 'text', text: 'Gate released.' }], details: {} }
    }
  })
}] })

try {
  await f.managed.lifecyclePromise
  f.session.setActiveToolsByName([...f.session.getActiveToolNames(), 'mid_run_gate'])

  // The fixture runtime exposes one offline model. `getModel` is the lookup the
  // manager's switch uses, so it also resolves a second, reasoning model; the
  // fixture's credential tripwire is answered as the app's own transport would
  // (this check never reaches a provider).
  const runtime = await f.app.runtime()
  const base = f.session.model
  const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  const pro = {
    id: 'fixture-pro', name: 'fixture-pro', provider: 'fixture', api: 'anthropic-messages',
    baseUrl: 'http://127.0.0.1:1', reasoning: true, input: ['text'], cost, contextWindow: 200000, maxTokens: 4096
  }
  const lookup = runtime.getModel.bind(runtime)
  runtime.getModel = (provider, id) => {
    if (id === pro.id) return pro
    if (id === base.id) return base
    return lookup(provider, id)
  }
  runtime.checkAuth = async () => true

  // One run, held open by the gate tool the model called.
  f.setRespond((n) => n === 1
    ? [{ type: 'toolCall', id: 'mid-run-gate-call', name: 'mid_run_gate', arguments: {} }]
    : [{ type: 'text', text: 'Finished after the switches.' }])
  const run = f.session.prompt('Hold the run open while the switches are checked.')
  await until(() => entered === 1)
  assert.equal(f.session.isStreaming, true, 'the gate keeps the run active')
  assert.equal(f.app.snapshot().isStreaming, true, 'the snapshot reports the run as live')

  // Off, the default: every switch is refused while the run is live, and the
  // refusal is the gate itself — not a lookup or plan error standing in for it.
  const refused = [
    ['model', () => f.app.setModel('fixture', pro.id)],
    ['thinking level', () => f.app.setThinkingLevel('high')],
    ['sandbox mode', () => f.app.setSessionSandboxMode(f.managed.path, 'read-only')]
  ]
  for (const [name, call] of refused) {
    const error = await refusal(call)
    assert(error instanceof Error, `${name}: the switch is refused mid-run`)
    assert.match(error.message, /mid-run-changes-disabled/, `${name}: the refusal is the mid-run gate (${error.message})`)
  }
  assert.equal(f.app.snapshot().model.id, base.id, 'the refused model switch never applied')
  assert.equal(f.app.snapshot().sandboxMode, 'workspace-write', 'the refused mode switch never applied')

  // On: the same switches are accepted while the run stays live, and each one
  // is already reflected in the snapshot the renderer applies.
  assert.equal(f.app.setAllowMidRunChanges(true), true, 'the preference saves and reports itself')
  const switched = await f.app.setModel('fixture', pro.id)
  assert.equal(switched.model.id, pro.id, 'the model switch lands mid-run')
  assert.equal(switched.sessionPath, f.managed.path, 'the switch answers with the running session')
  const levels = f.session.getAvailableThinkingLevels()
  const level = levels.find((value) => value !== f.session.thinkingLevel) ?? f.session.thinkingLevel
  const leveled = await f.app.setThinkingLevel(level)
  assert.equal(leveled.thinkingLevel, f.session.thinkingLevel, 'the thinking level lands mid-run')
  const moded = await f.app.setSessionSandboxMode(f.managed.path, 'read-only')
  assert.equal(moded.sandboxMode, 'read-only', 'the sandbox mode lands mid-run')
  assert.equal(moded.plan.configuredSandboxMode, 'read-only', "the picker's stored choice follows the mid-run switch")
  assert.equal(f.session.isStreaming, true, 'the run is still the one the switches joined')
  assert.equal(
    f.manager.getBranch().some((entry) => entry.type === 'custom' && entry.customType === 'pith_sandbox_mode' && entry.data?.mode === 'read-only'),
    true,
    'the mid-run mode change is recorded on the session branch'
  )

  // The setting round-trips through the app settings file, so a relaunch keeps
  // the same admission.
  const persisted = JSON.parse(await (await import('node:fs/promises')).readFile(new URL(`file://${f.temporary}/userData/app-settings.json`), 'utf8'))
  assert.equal(persisted.allowMidRunChanges, true, 'the preference is persisted app-local')

  gate.resolve()
  await run
  assert.equal(f.session.isStreaming, false, 'the run settled')

  // Off again: the gate no longer applies because nothing is running.
  assert.equal(f.app.setAllowMidRunChanges(false), false)
  const idleModel = await f.app.setModel('fixture', base.id)
  assert.equal(idleModel.model.id, base.id, 'an idle switch is accepted with the setting off')
  await f.app.setThinkingLevel('off')
  const idleMode = await f.app.setSessionSandboxMode(f.managed.path, 'workspace-write')
  assert.equal(idleMode.sandboxMode, 'workspace-write', 'an idle mode switch is accepted with the setting off')

  console.log('PASS: mid-run switches — the model, thinking and permission gates refuse while a run is live unless Settings → General allows it, then apply on the next call and persist')
} finally {
  gate.resolve()
  await f.close()
}
