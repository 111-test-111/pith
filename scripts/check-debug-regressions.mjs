/** Deterministic debugger regressions: checkout ownership, child-target
 * restart and Python module configuration arguments. Uses wire fixtures only. */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const temp = realpathSync(mkdtempSync(join(tmpdir(), 'pith-debug-regressions-')))
const workspace = join(temp, 'workspace'), runtime = join(temp, 'launch-cwd')
const fixture = resolve('scripts/debug-fixtures/protocol-adapter.mjs')
const log = join(temp, 'requests.jsonl')
process.env.PI_DAP_PROTOCOL_LOG = log
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(read, label, budget = 10_000) {
  const deadline = Date.now() + budget
  do { const value = await read(); if (value) return value; await delay(10) } while (Date.now() < deadline)
  assert.fail(`Timed out: ${label}`)
}
let manager
const restoreAdapters = []
try {
  mkdirSync(join(workspace, '.git'), { recursive: true })
  mkdirSync(join(workspace, '.vscode'))
  mkdirSync(join(workspace, 'subdir'))
  mkdirSync(runtime)
  writeFileSync(join(workspace, '.vscode', 'launch.json'), JSON.stringify({ configurations: [{
    name: 'Python module', type: 'debugpy', request: 'launch', module: 'review_module', cwd: runtime, stopOnEntry: true
  }] }))
  await build({ stdin: { contents: `export * from './src/main/debug/manager'; export * from './src/main/debug/adapters'; export * from './src/main/debug/tools'; export * from './src/main/rewind/coordinator'`, resolveDir: process.cwd() },
    bundle: true, platform: 'node', format: 'esm', outfile: join(temp, 'module.mjs'), plugins: [{ name: 'sdk', setup(b) {
      b.onResolve({ filter: /^(@earendil-works\/pi-coding-agent|typebox)$/ }, a => ({ path: fileURLToPath(import.meta.resolve(a.path)), external: true }))
    } }] })
  const { DebugManager, debugAdapterSpec, createDebugTools, CheckoutCoordinator } = await import(pathToFileURL(join(temp, 'module.mjs')))
  const coordinator = new CheckoutCoordinator()
  manager = new DebugManager(() => {}, coordinator)
  const lldb = debugAdapterSpec(workspace, 'lldb-dap'), python = debugAdapterSpec(workspace, 'debugpy'), js = debugAdapterSpec(workspace, 'js-debug')
  for (const spec of [lldb, python, js]) { const detect = spec.detect, validateLaunch = spec.validateLaunch; restoreAdapters.push(() => { spec.detect = detect; spec.validateLaunch = validateLaunch }) }
  // Protocol fixtures use virtual target paths. Keep argument validation but
  // substitute a real file only for the host-file preflight.
  for (const spec of [lldb, python, js]) {
    const validate = spec.validateLaunch
    spec.validateLaunch = args => validate({ ...args, ...(typeof args.program === 'string' ? { program: process.execPath } : {}) })
  }
  const useFixture = (spec, mode) => { spec.detect = async () => ({ command: process.execPath, args: [fixture, mode, '${port}'] }) }
  useFixture(lldb, 'normal'); useFixture(python, 'normal'); useFixture(js, 'child-native')
  const toolFor = (sessionPath, runInTerminal) => createDebugTools({ manager, services: { cwd: workspace }, sessionId: sessionPath, sessionPath,
    enabled: () => true, sandboxMode: () => 'danger-full-access', canStart: () => true, runInTerminal: () => runInTerminal })[0]
  const invoke = async (path, args, signal, bridge) => {
    const result = await toolFor(path, bridge).execute('review', args, signal, undefined, { cwd: workspace })
    return JSON.parse(result.content[0].text)
  }
  const launch = (path, extra = {}) => invoke(path, { action: 'start', adapter: 'lldb-dap', program: '/fixture/demo', cwd: runtime, ...extra })
  const requests = () => readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse)
  const lastLaunch = () => requests().filter(r => r.type === 'request' && r.command === 'launch').at(-1).arguments
  const assertFenced = async () => {
    for (const root of [workspace, runtime]) {
      assert.equal(coordinator.restoreBlockers(root).writers, 1)
      await assert.rejects(coordinator.withExclusive(root, 'restore', async () => assert.fail('restore entered a live checkout')))
      await assert.rejects(coordinator.withExclusive(root, 'snapshot', async () => assert.fail('snapshot entered a live checkout')))
    }
  }
  const assertReleased = () => {
    assert.equal(coordinator.restoreBlockers(workspace).writers, 0)
    assert.equal(coordinator.restoreBlockers(runtime).writers, 0)
  }

  // Tool cwd is a launch setting, never the owner identity. Restart keeps both.
  const owner = '/review/owner'
  const started = await launch(owner)
  assert.equal(lastLaunch().cwd, runtime)
  await assertFenced()
  await manager.restart(owner, started.id)
  await assertFenced()
  await manager.stopSession(owner); assertReleased()
  const sameCheckout = await launch(owner, { cwd: join(workspace, 'subdir') })
  assert.equal(coordinator.restoreBlockers(workspace).writers, 1, 'canonical checkout identities must not acquire duplicate leases')
  await manager.stop(owner, sameCheckout.id); assertReleased()

  // Cancelling while the second checkout is taking a snapshot must release
  // the first reservation and must not get as far as sending a launch.
  let unlock
  const snapshot = coordinator.withExclusive(runtime, 'snapshot', () => new Promise(resolve => { unlock = resolve }))
  try {
    const before = requests().filter(r => r.command === 'launch').length
    const abort = new AbortController()
    const cancelled = assert.rejects(invoke(owner, { action: 'start', adapter: 'lldb-dap', program: '/fixture/demo', cwd: runtime }, abort.signal))
    await until(() => coordinator.restoreBlockers(workspace).writers === 1, 'first checkout reservation')
    abort.abort(); await cancelled; await manager.stopSession(owner)
    assertReleased()
    assert.equal(requests().filter(r => r.command === 'launch').length, before)
  } finally { unlock(); await snapshot }
  coordinator.setRecovery(runtime, 'review-recovery')
  try { await assert.rejects(launch(owner)); assertReleased() }
  finally { coordinator.setRecovery(runtime) }

  // Both leases survive adapter disposal until the target's terminal is gone.
  useFixture(lldb, 'terminal')
  let closeTerminal
  const terminal = await invoke(owner, { action: 'start', adapter: 'lldb-dap', program: '/fixture/demo', cwd: runtime }, undefined,
    async () => ({ terminalId: 'review-terminal', shellProcessId: process.pid, dispose: () => new Promise(resolve => { closeTerminal = resolve }) }))
  const stopping = manager.stop(owner, terminal.id)
  await until(() => closeTerminal, 'terminal cleanup'); await assertFenced()
  closeTerminal(); await stopping; assertReleased()
  useFixture(lldb, 'normal')
  console.log('[PASS] checkout ownership: external cwd, restart, deduplication, blocked acquisition/cancellation and terminal cleanup')

  // Test the actual tool/configuration path, including an explicit cwd override.
  const modulePath = '/review/module'
  const module = await invoke(modulePath, { action: 'start', configuration: 'Python module', cwd: runtime })
  assert.equal(module.target, 'review_module')
  assert.equal(lastLaunch().module, 'review_module')
  assert.equal(Object.hasOwn(lastLaunch(), 'program'), false)
  await assertFenced()
  await manager.restart(modulePath, module.id)
  assert.equal(lastLaunch().module, 'review_module')
  assert.equal(Object.hasOwn(lastLaunch(), 'program'), false)
  await manager.stopSession(modulePath); assertReleased()
  await invoke(modulePath, { action: 'start', configuration: 'Python module', program: '/fixture/override.py' })
  assert.equal(lastLaunch().program, '/fixture/override.py')
  assert.equal(Object.hasOwn(lastLaunch(), 'module'), false)
  await manager.stopSession(modulePath)
  const base = { sessionId: modulePath, sessionPath: modulePath, workspaceCwd: workspace, cwd: runtime, kind: 'launch' }
  await assert.rejects(manager.start({ ...base, adapterId: 'lldb-dap', extraArguments: { module: 'review_module' } }), /program is required/)
  await assert.rejects(manager.start({ ...base, adapterId: 'debugpy', extraArguments: { module: '' } }), /non-empty/)
  await assert.rejects(manager.start({ ...base, adapterId: 'debugpy', program: '/fixture/invalid.py', extraArguments: { module: 'review_module' } }), /not both/)
  assertReleased()
  console.log('[PASS] Python module configurations: wire arguments, owner cwd, restart, script override and invalid entry points')

  const childOf = (path, rootId, previousId) => until(() => manager.list(path).find(s => s.parentId === rootId && s.id !== previousId && s.status === 'stopped' && s.location), 'replacement child')
  const file = '/fixture/demo.c'
  for (const mode of ['child-native', 'child']) {
    useFixture(js, mode)
    const path = `/review/${mode}`
    const root = await launch(path, { adapter: 'js-debug' })
    const child = await childOf(path, root.id)
    const separate = await launch(path, { adapter: 'js-debug' })
    const separateChild = await childOf(path, separate.id)
    await manager.setBreakpoints(path, file, [4, 5], { conditions: ['value > 1', ''], hitConditions: ['3', ''], logMessages: ['v={value}', ''] }, child.id)
    await manager.toggleBreakpoint(path, file, 5, child.id)
    const restarted = await manager.restart(path, root.id)
    assert.equal(restarted.id === root.id, mode === 'child-native')
    const replacement = await childOf(path, restarted.id, child.id)
    const points = await manager.breakpoints(path, replacement.id)
    assert.deepEqual(points.map(p => p.requestedLine), [4])
    assert.equal(points[0].condition, 'value > 1'); assert.equal(points[0].hitCondition, '3'); assert.equal(points[0].logMessage, 'v={value}')
    assert.deepEqual(await manager.breakpoints(path, separateChild.id), [], 'independent launch trees must not inherit each other\'s breakpoints')
    // An intentional clear is retained too; no old entry may resurrect.
    await manager.setBreakpoints(path, file, [], undefined, replacement.id)
    const clearedRoot = await manager.restart(path, restarted.id)
    const cleared = await childOf(path, clearedRoot.id, replacement.id)
    assert.deepEqual(await manager.breakpoints(path, cleared.id), [])
    await manager.stopSession(path); assertReleased()
  }
  console.log('[PASS] child-target breakpoints: native/fallback restarts retain edits, extras and clears, with separate launch-tree ownership')

} finally {
  for (const restore of restoreAdapters) restore()
  await manager?.dispose()
  delete process.env.PI_DAP_PROTOCOL_LOG
  rmSync(temp, { recursive: true, force: true })
}
