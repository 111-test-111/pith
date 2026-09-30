/** Production DAP state machine over deterministic stdio/TCP fixtures.
 * No real debugpy/dlv/js-debug runtime coverage is implied. */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import { build } from 'esbuild'
const temp = mkdtempSync(join(tmpdir(), 'pith-dap-protocol-'))
const fixture = resolve('scripts/debug-fixtures/protocol-adapter.mjs')
const log = join(temp, 'requests.jsonl')
process.env.PI_DAP_PROTOCOL_LOG = log
const delay = ms => new Promise(r => setTimeout(r, ms))
async function until(predicate) { for (let i = 0; i < 200; i++) { if (predicate()) return; await delay(10) } assert.fail('condition timed out') }
let manager
try {
  await build({ stdin: { contents: `export * from './src/main/debug/manager'; export * from './src/main/debug/adapters'; export * from './src/main/debug/dap-client'; export * from './src/main/debug/tools'; export * from './src/main/debug/terminal'; export * from './src/main/rewind/coordinator'`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', outfile: join(temp, 'module.mjs'), plugins: [{ name: 'external-sdk', setup(b) { b.onResolve({ filter: /^(@earendil-works\/pi-coding-agent|typebox)$/ }, a => ({ path: fileURLToPath(import.meta.resolve(a.path)), external: true })) } }] })
  const { DebugManager, DapClient, debugAdapterSpec, parseJsonc, buildDebugCommandLine, createDebugTools, CheckoutCoordinator } = await import(pathToFileURL(join(temp, 'module.mjs')))
  const coordinator = new CheckoutCoordinator()
  const updates = []
  manager = new DebugManager(dto => updates.push(dto), coordinator)
  const specs = ['lldb-dap', 'debugpy', 'dlv', 'js-debug'].map(id => debugAdapterSpec(temp, id))
  const [lldb, python, go, js] = specs
  // A silent successful Python import must count as success.
  mkdirSync(join(temp, '.venv/bin'), { recursive: true })
  writeFileSync(join(temp, '.venv/bin/python'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  assert.ok(await python.detect(temp))
  const probeMarker = join(temp, 'probe-executed')
  writeFileSync(join(temp, '.venv/bin/python'), `#!/bin/sh\ntouch '${probeMarker}'\n`, { mode: 0o755 })
  const readOnlyTool = createDebugTools({ manager, services: { cwd: temp }, sessionId: 'p', sessionPath: '/parent', enabled: () => true, sandboxMode: () => 'read-only', canStart: () => true, runInTerminal: () => undefined })[0]
  await assert.rejects(readOnlyTool.execute('discover', { action: 'adapters' }, undefined, undefined, { cwd: temp }), /sandbox/i)
  assert.equal(existsSync(probeMarker), false, 'read-only discovery must not execute workspace Python')
  assert.equal(python.launchArguments({ program: 'demo.py', args: [], cwd: temp }).type, 'python')
  assert.equal(go.listen.spawn, true); assert.equal(js.listen.spawn, true); assert.equal(js.childSessions, true)
  assert.deepEqual(parseJsonc('{"args":[",}",",]","\\\",}",],/*ok*/}').args, [',}', ',]', '\",}'])
  const command = buildDebugCommandLine([process.execPath, '-e', 'process.stdout.write(JSON.stringify([process.env.SET,process.env.DELETE]))'], { SET: "a' b", DELETE: null })
  assert.deepEqual(JSON.parse(execFileSync('/bin/sh', ['-c', command], { env: { ...process.env, DELETE: 'old' } })), ["a' b", null])
  const windows = buildDebugCommandLine(['C:\\Program Files\\demo.exe', 'a"b', 'tail\\', '', '%PATH% & echo nope'], { SET: "a' b", DELETE: null }, 'win32')
  assert.match(windows, /^powershell\.exe .* -EncodedCommand [A-Za-z0-9+/=]+$/)
  const windowsScript = Buffer.from(windows.split(' ').at(-1), 'base64').toString('utf16le')
  assert.ok(windowsScript.includes("$p.EnvironmentVariables.Remove('DELETE')"))
  assert.ok(windowsScript.includes("$p.EnvironmentVariables['SET'] = 'a'' b'"))
  assert.ok(windowsScript.includes('"a\\"b" "tail\\\\" "" "%PATH% & echo nope"'))
  // Protocol fixtures use virtual target paths. Keep argument validation but
  // substitute a real file only for the host-file preflight.
  for (const spec of [lldb, python, go, js]) {
    const validate = spec.validateLaunch
    spec.validateLaunch = args => validate({ ...args, ...(typeof args.program === 'string' ? { program: process.execPath } : {}) })
  }
  const useFixture = (spec, mode) => { spec.detect = async () => ({ command: process.execPath, args: [fixture, mode, '${port}'] }) }
  useFixture(lldb, 'normal'); useFixture(python, 'normal'); useFixture(go, 'tcp'); useFixture(js, 'child')
  const start = (over = {}) => manager.start({ sessionId: 'parent', sessionPath: '/parent', workspaceCwd: temp, cwd: temp, adapterId: 'lldb-dap', kind: 'launch', program: '/fixture/demo', ...over })
  const a = await start(); await start(); const child = await start({ sessionPath: '/child' })
  assert.equal(a.status, 'stopped'); assert.ok(a.stopId > 0)
  assert.throws(() => manager.get('/parent'), /Multiple/)
  assert.throws(() => manager.get('/child', a.id), /No debug session/)
  assert.throws(() => manager.get('/parent', child.id), /No debug session/)
  assert.equal(coordinator.restoreBlockers(temp).writers, 3)
  await assert.rejects(coordinator.withExclusive(temp, 'restore', async () => {}))
  await manager.setBreakpoints('/parent', '/fixture/demo.c', [4], { conditions: ['value > 1'], hitConditions: ['3'], logMessages: ['v={value}'] }, a.id)
  await Promise.all([manager.toggleBreakpoint('/parent', '/fixture/demo.c', 5, a.id), manager.toggleBreakpoint('/parent', '/fixture/demo.c', 6, a.id)])
  let points = await manager.breakpoints('/parent', a.id)
  assert.deepEqual(points.map(p => p.requestedLine), [4, 5, 6]); assert.equal(points[0].condition, 'value > 1')
  const replacement = await manager.restart('/parent', a.id)
  assert.notEqual(replacement.id, a.id)
  assert.equal(replacement.replacesId, a.id)
  points = await manager.breakpoints('/parent', replacement.id)
  assert.equal(points[0].logMessage, 'v={value}')
  const slow = manager.variables('/parent', 100, 99, 1, replacement.id, replacement.stopId)
  const slowFailure = assert.rejects(slow, /stop changed/)
  const stepped = await manager.control('/parent', 'next', undefined, 500, replacement.id)
  await slowFailure
  assert.equal(stepped.session.status, 'stopped'); assert.ok(stepped.session.stopId > replacement.stopId)
  await until(() => manager.get('/parent', replacement.id).outputChars > 70000)
  assert.equal((await manager.breakpoints('/parent', replacement.id))[0].line, 9)
  const output = manager.output('/parent', undefined, 65536, replacement.id)
  assert.equal(output.output.length, 65536); assert.ok(output.output.endsWith('TAIL')); assert.equal(output.truncated, true)
  await assert.rejects(manager.scopes('/parent', 1, replacement.id, replacement.stopId), error => error.code === 'DEBUG_STALE_STOP')
  await manager.control('/parent', 'stepIn', undefined, 500, replacement.id)
  await until(() => updates.some(s => s.id === replacement.id && s.stopId === 3))
  await delay(20)
  assert.ok(!(await manager.breakpoints('/parent', replacement.id)).some(bp => bp.requestedLine === 4))
  assert.ok((await manager.breakpoints('/parent', replacement.id)).some(bp => bp.line === 20))
  await manager.toggleBreakpoint('/parent', '/fixture/demo.c', 20, replacement.id)
  assert.ok(!(await manager.breakpoints('/parent', replacement.id)).some(bp => bp.line === 20))
  // Model evaluate is process execution, even with an existing stopped target.
  const tool = createDebugTools({ manager, services: { cwd: temp }, sessionId: 'p', sessionPath: '/parent', enabled: () => true, sandboxMode: () => 'read-only', canStart: () => true, runInTerminal: () => undefined })[0]
  await assert.rejects(tool.execute('eval', { action: 'evaluate', debugId: replacement.id, expression: 'mutate()' }, undefined, undefined, { cwd: temp }), /sandbox/i)
  const core = await start({ kind: 'core', coreFile: '/fixture/core' })
  assert.equal(core.kind, 'core'); assert.equal((await manager.stack('/parent', 1, undefined, core.id)).length, 1)
  await assert.rejects(manager.control('/parent', 'continue', 1, 500, core.id), /cannot execute/)
  await assert.rejects(manager.evaluate('/parent', '1', 1, core.id), /Core inspection/)
  await assert.rejects(manager.restart('/parent', core.id), /core/)
  const requests = () => readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse)
  assert.ok(requests().some(r => r.command === 'attach' && r.arguments?.coreFile === '/fixture/core'))
  const py = await start({ adapterId: 'debugpy' }), dlv = await start({ adapterId: 'dlv' })
  assert.equal(py.status, 'stopped'); assert.equal(dlv.status, 'stopped')
  const root = await start({ adapterId: 'js-debug' })
  await until(() => manager.list('/parent').some(s => s.parentId === root.id && s.status === 'stopped'))
  const target = manager.list('/parent').find(s => s.parentId === root.id)
  assert.ok(requests().some(r => r.arguments?.__pendingTargetId === 'target-1'))
  await manager.stop('/parent', root.id)
  assert.equal(manager.get('/parent', target.id).status, 'terminated')
  await manager.stopSession('/parent'); assert.equal(manager.get('/child', child.id).status, 'stopped')
  await manager.stopSession('/child'); assert.equal(coordinator.restoreBlockers(temp).writers, 0)
  // Late stack fill from a superseded stop cannot settle a later continue.
  useFixture(lldb, 'slow-stack')
  const rapid = await start()
  const step = manager.control('/parent', 'next', undefined, 500, rapid.id)
  await until(() => manager.get('/parent', rapid.id).stopId === 2)
  const continuing = await manager.control('/parent', 'continue', undefined, 500, rapid.id)
  assert.equal(continuing.session.status, 'running'); assert.equal(continuing.settled, false)
  assert.equal((await step).settled, false)
  await manager.stop('/parent', rapid.id)
  // Lists just over the default page and lists of one must not repeat forever.
  for (const mode of ['variables-ignored', 'variables-paged']) {
    useFixture(lldb, mode)
    const vars = await start()
    for (const size of [1, 50, 51, 105]) {
      const names = []
      let page, offset = 0
      do {
        page = await manager.variables('/parent', size, offset, 50, vars.id, vars.stopId)
        names.push(...page.variables.map(v => Number(v.name))); offset += page.variables.length
        assert.ok(names.length <= size, `${mode} must advance without duplicates`)
      } while (page.truncated)
      assert.deepEqual(names, Array.from({ length: size }, (_, i) => i))
      assert.deepEqual((await manager.variables('/parent', size, size, 50, vars.id)).variables, [])
    }
    await assert.rejects(manager.evaluate('/parent', 'broken', 1, vars.id), /Cannot evaluate broken: unknown return type/)
    await manager.stop('/parent', vars.id)
  }
  // The adapter leader exits while an owned debuggee ignores SIGTERM.
  if (process.platform !== 'win32') {
    const pidFile = join(temp, 'child.pid')
    process.env.PI_DAP_CHILD_PID = pidFile
    useFixture(lldb, 'crash-tree')
    const crashed = await start()
    await until(() => existsSync(pidFile))
    const pid = Number(readFileSync(pidFile, 'utf8'))
    const alive = () => { try { process.kill(pid, 0); return true } catch { return false } }
    try {
      await until(() => manager.get('/parent', crashed.id).status === 'terminated')
      assert.ok(alive()); assert.equal(coordinator.restoreBlockers(temp).writers, 1)
      await manager.stop('/parent', crashed.id)
      assert.equal(alive(), false); assert.equal(coordinator.restoreBlockers(temp).writers, 0)
    } finally { if (alive()) process.kill(pid, 'SIGKILL'); delete process.env.PI_DAP_CHILD_PID }
  }
  // Cancel during discovery, before any process exists. Admission stays closed.
  let resolveDetect
  lldb.detect = () => new Promise(resolve => { resolveDetect = resolve })
  const abort = new AbortController()
  const pending = start({ signal: abort.signal }); const rejected = assert.rejects(pending, /cancelled/)
  await until(() => !!resolveDetect)
  abort.abort(); await manager.stopSession('/parent')
  resolveDetect({ command: process.execPath, args: [fixture, 'normal'] }); await rejected
  assert.equal(coordinator.restoreBlockers(temp).writers, 0)
  // A successfully launched integrated terminal stays owned through cleanup.
  useFixture(lldb, 'terminal')
  let closeTerminal
  const terminal = await start({ runInTerminal: async () => ({ terminalId: 'fixture-terminal', shellProcessId: process.pid,
    dispose: () => new Promise(resolve => { closeTerminal = resolve }) }) })
  const terminalStop = manager.stop('/parent', terminal.id)
  await until(() => !!closeTerminal)
  assert.equal(coordinator.restoreBlockers(temp).writers, 1)
  closeTerminal(); await terminalStop
  assert.equal(coordinator.restoreBlockers(temp).writers, 0)
  let terminalSeen = false, terminalCancelled = false
  const termController = new AbortController()
  const terminalStart = start({ signal: termController.signal, runInTerminal: ({ signal }) => new Promise((_resolve, reject) => {
    terminalSeen = true
    signal.addEventListener('abort', () => { terminalCancelled = true; reject(new Error('cancelled')) }, { once: true })
  }) })
  const terminalFailure = assert.rejects(terminalStart, /closed|disposed|cancelled/)
  await until(() => terminalSeen); termController.abort(); await terminalFailure
  assert.equal(terminalCancelled, true)
  assert.equal(coordinator.restoreBlockers(temp).writers, 0)
  useFixture(lldb, 'final-tail')
  const finalTail = await start()
  await until(() => manager.get('/parent', finalTail.id).outputChars === 'FINAL TAIL'.length)
  assert.equal(manager.output('/parent', undefined, undefined, finalTail.id).output, 'FINAL TAIL')
  useFixture(lldb, 'native-paged')
  const beforeInitial = requests().length
  const launchTool = createDebugTools({ manager, services: { cwd: temp }, sessionId: 'parent', sessionPath: '/parent',
    enabled: () => true, sandboxMode: () => 'workspace-write', canStart: () => true, runInTerminal: () => undefined })[0]
  const launchResult = await launchTool.execute('initial', { request: { action: 'start', adapter: 'lldb-dap', program: '/fixture/demo',
    breakpoints: [{ file: '/fixture/initial.c', items: [{ line: 7, condition: 'value > 0' }] }],
    functionBreakpoints: [{ name: 'entry' }] } }, undefined, undefined, { cwd: temp })
  const initial = JSON.parse(launchResult.content[0].text)
  const initialCommands = requests().slice(beforeInitial).map(row => row.command)
  assert.ok(initialCommands.indexOf('launch') < initialCommands.indexOf('setBreakpoints'))
  assert.ok(initialCommands.indexOf('setBreakpoints') < initialCommands.indexOf('setFunctionBreakpoints'))
  assert.ok(initialCommands.indexOf('setFunctionBreakpoints') < initialCommands.indexOf('configurationDone'))
  assert.equal((await manager.breakpoints('/parent', initial.id))[0].requestedLine, 7)
  assert.equal(manager.nativeBreakpoints('/parent', initial.id).function[0].name, 'entry')
  await assert.rejects(launchTool.execute('duplicate', { request: { action: 'start', adapter: 'lldb-dap', program: '/fixture/demo',
    breakpoints: [{ file: '/same.c', items: [] }, { file: '/same.c', items: [] }] } }, undefined, undefined, { cwd: temp }), /Duplicate initial breakpoint file/)
  await assert.rejects(launchTool.execute('core', { request: { action: 'start', adapter: 'lldb-dap', kind: 'core', coreFile: '/fixture/core',
    functionBreakpoints: [{ name: 'entry' }] } }, undefined, undefined, { cwd: temp }), /Core files cannot have breakpoints/)
  await manager.stop('/parent', initial.id)
  // The restart reservation spans stop AND the replacement's async startup.
  useFixture(lldb, 'normal')
  const fallback = await start({ sessionPath: '/restart-race' })
  let replacementDetect
  lldb.detect = () => new Promise(resolve => { replacementDetect = resolve })
  const replacing = manager.restart('/restart-race', fallback.id)
  await assert.rejects(manager.restart('/restart-race', fallback.id), /busy/)
  await until(() => !!replacementDetect)
  await assert.rejects(manager.restart('/restart-race', fallback.id), /busy/)
  replacementDetect({ command: process.execPath, args: [fixture, 'normal'] })
  const replacementOnce = await replacing
  assert.equal(manager.list('/restart-race').filter(s => ['starting', 'running', 'stopped'].includes(s.status)).length, 1)
  assert.equal(replacementOnce.replacesId, fallback.id)
  await manager.stopSession('/restart-race')
  // Gate real wire replies so cancellation is deterministic at both awaits.
  useFixture(lldb, 'native-gated-breakpoints')
  const gate = join(temp, 'breakpoint-release')
  process.env.PI_DAP_BREAKPOINT_GATE = gate
  try {
    const native = await start({ sessionPath: '/restart-admission' })
    let enabled = true
    const restartTool = createDebugTools({ manager, services: { cwd: temp }, sessionId: 'parent', sessionPath: '/restart-admission',
      enabled: () => enabled, sandboxMode: () => 'workspace-write', canStart: () => enabled, runInTerminal: () => undefined })[0]
    let before = requests().length
    const writing = manager.setInstructionBreakpoints('/restart-admission', [{ instructionReference: '0x10' }], native.id, native.stopId)
    await until(() => requests().slice(before).some(r => r.command === 'setInstructionBreakpoints'))
    const restarting = restartTool.execute('disabled', { debugId: native.id, request: { action: 'restart' } }, undefined, undefined, { cwd: temp })
    const disabled = assert.rejects(restarting, /restart cancelled/)
    await delay(0); enabled = false
    writeFileSync(gate, 'ready'); await writing; await disabled
    assert.ok(!requests().slice(before).some(r => r.command === 'restart'))
    assert.equal(manager.nativeBreakpoints('/restart-admission', native.id).instruction.length, 1)
    enabled = true; rmSync(gate)
    before = requests().length
    const cancellation = new AbortController()
    const cancelled = assert.rejects(restartTool.execute('cancelled', { debugId: native.id, request: { action: 'restart' } }, cancellation.signal, undefined, { cwd: temp }), /restart cancelled/)
    await until(() => requests().slice(before).some(r => r.command === 'setInstructionBreakpoints' && r.arguments.breakpoints.length === 0))
    cancellation.abort(); writeFileSync(gate, 'ready'); await cancelled
    assert.ok(!requests().slice(before).some(r => r.command === 'restart'))
    assert.equal(manager.nativeBreakpoints('/restart-admission', native.id).instruction.length, 0)
    // A cancelled restart releases its reservation for the next valid action.
    assert.equal((await manager.restart('/restart-admission', native.id)).stopId, native.stopId + 1)
    await manager.stopSession('/restart-admission')
  } finally { delete process.env.PI_DAP_BREAKPOINT_GATE }
  console.log('[PASS] restart races: one fallback replacement through startup; live enablement and abort rechecked after queued writes/address clearing')
  if (process.platform !== 'win32') {
    useFixture(lldb, 'normal')
    const reaping = await start({ sessionPath: '/reaping' })
    const group = -manager.sessions.get(reaping.id).client.child.pid
    const kill = process.kill
    let deniedProbes = 0
    process.kill = (pid, value) => {
      if (pid === group && value === 0 && deniedProbes < 2) {
        deniedProbes++; throw Object.assign(new Error('zombie group awaiting reaping'), { code: 'EPERM' })
      }
      return kill(pid, value)
    }
    try { await manager.stop('/reaping', reaping.id) } finally { process.kill = kill }
    assert.equal(deniedProbes, 2)
    assert.equal(manager.get('/reaping', reaping.id).status, 'terminated')
    assert.equal(coordinator.restoreBlockers(temp).writers, 0)
    // Persistent EPERM is never proof of exit and must keep the checkout fenced.
    const fencedCoordinator = new CheckoutCoordinator(), fencedManager = new DebugManager(() => {}, fencedCoordinator)
    const fenced = await fencedManager.start({ sessionId: 'fenced', sessionPath: '/fenced', workspaceCwd: temp, cwd: temp,
      adapterId: 'lldb-dap', kind: 'launch', program: '/fixture/demo' })
    const inaccessibleGroup = -fencedManager.sessions.get(fenced.id).client.child.pid
    let killAttempted = false
    process.kill = (pid, value) => {
      if (pid === inaccessibleGroup) {
        if (value === 'SIGKILL') killAttempted = true
        throw Object.assign(new Error('inaccessible process group'), { code: 'EPERM' })
      }
      return kill(pid, value)
    }
    try {
      await assert.rejects(fencedManager.stop('/fenced', fenced.id), /process group did not exit/)
      assert.ok(killAttempted)
      assert.equal(fencedManager.get('/fenced', fenced.id).status, 'failed')
      assert.equal(fencedCoordinator.restoreBlockers(temp).writers, 1)
    } finally {
      process.kill = kill
      try { kill(inaccessibleGroup, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
      await fencedManager.dispose().catch(() => {})
    }
    console.log('[PASS] process cleanup: transient EPERM waits for reaping; persistent EPERM reaches SIGKILL deadline and retains the checkout fence')
  }
  useFixture(lldb, 'fail')
  await assert.rejects(start(), /initialize failed/)
  useFixture(lldb, 'launch-rejected')
  const beforeRejected = new Set(manager.list('/parent').map(session => session.id))
  await assert.rejects(start(), /launch rejected: operation not permitted[\s\S]*fixture: OS denied debug launch/)
  const rejectedLaunch = manager.list('/parent').find(session => !beforeRejected.has(session.id))
  assert.equal(rejectedLaunch.status, 'failed')
  assert.match(rejectedLaunch.error, /launch rejected: operation not permitted[\s\S]*fixture: OS denied debug launch/)
  useFixture(lldb, 'launch-crash')
  const beforeCrash = new Set(manager.list('/parent').map(session => session.id))
  await assert.rejects(start(), /adapter connection closed[\s\S]*fixture: adapter crashed during launch/)
  const crashedLaunch = manager.list('/parent').find(session => !beforeCrash.has(session.id))
  assert.equal(crashedLaunch.status, 'failed')
  assert.match(crashedLaunch.error, /fixture: adapter crashed during launch/)
  useFixture(lldb, 'no-initialized')
  const controller = new AbortController(), handshake = start({ signal: controller.signal })
  const closed = assert.rejects(handshake, /closed|disposed|cancelled/)
  await delay(50); controller.abort(); await closed
  // Every event waiter belongs to the transport and rejects immediately on close.
  const transport = new DapClient()
  const event = transport.waitForEvent('initialized', 30)
  const eventClosed = assert.rejects(event, /closed|disposed/)
  await transport.dispose(); await eventClosed; await delay(50)
  await manager.dispose(); assert.equal(coordinator.restoreBlockers(temp).writers, 0)
  console.log('[PASS] DAP protocol: handshake, isolation, children, core, cancellation, crashed process trees/terminal cleanup, read-only probes, restart, stale fills, paged/unpaged variables, structured errors, bounded output, JSONC/POSIX/Windows commands')
} finally { await manager?.dispose(); delete process.env.PI_DAP_PROTOCOL_LOG; rmSync(temp, { recursive: true, force: true }) }
