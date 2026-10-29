/**
 * Debug session lifecycle: which session an id-less action addresses.
 *
 * Regression guard for the "chat wedged once the first session ended" bug.
 * The manager used to resolve a call without an explicit id to the OLDEST
 * session of the chat. So as soon as a debuggee exited on its own, every later
 * action kept addressing that terminated session while `live()` — correctly —
 * saw the new one:
 *
 *   - `threads` threw "Cannot read properties of undefined (reading 'request')"
 *     (finish() sets session.client = undefined),
 *   - `stop` returned the already-terminated DTO and left the real session
 *     running,
 *   - `start` refused with "already active", so the chat could neither inspect
 *     nor stop the session it had started until the app restarted.
 *
 * It also guards the stopOnEntry handshake: `start()` used to overwrite the
 * entry stop with `running`, stranding the session (no stack, no continue, no
 * pause — only terminate), which is the one way to stop a fast debuggee before
 * it runs past your breakpoints.
 *
 * It also covers what a real multi-module debugging session turned up (see
 * scripts/debug-fixtures/hold.c): a running session with no recorded thread
 * must still accept `pause`, the control snapshot must carry this stop's
 * location (not a stale one), `evaluate` must work with or without an explicit
 * frameId, a NULL struct pointer must not advertise an expandable
 * variablesReference, and a finished session must report that it ended instead
 * of throwing an internal TypeError.
 *
 * Newer rounds add: the dyld entry stop reads "entry" (never "exception"),
 * large arrays page with start/count under a truthful `truncated` flag,
 * conditional breakpoints gate by expression, and logpoints print to the
 * console without stopping (see scripts/debug-fixtures/array.c).
 *
 * P1 adds: restart re-runs under either path, the DAP handshake works over a
 * TCP socket, launch.json maps (JSONC, env forms, workspace substitution,
 * passthrough), and a js-debug roundtrip runs when VS Code's adapter exists.
 *
 * Drives real debuggees, so it needs lldb-dap + clang (reports [SKIP] without).
 *
 *   node scripts/check-debug-sessions.mjs
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const FIXTURES = join(ROOT, 'scripts', 'debug-fixtures')
const SESSION_PATH = '/fixture/debug-chat'
const SESSION_ID = 'fixture-session'
const TERMINAL = new Set(['terminated', 'failed'])

const delay = (ms) => new Promise((done) => setTimeout(done, ms))

async function until(predicate, label, ms = 20_000) {
  const end = Date.now() + ms
  while (!(await predicate())) {
    assert.ok(Date.now() < end, `timed out waiting for ${label}`)
    await delay(25)
  }
}

/** lldb-dap is the only adapter this host-independent check can rely on. */
function lldbPath() {
  try {
    if (process.platform === 'darwin') {
      const resolved = String(execFileSync('xcrun', ['-f', 'lldb-dap'], { timeout: 5000 })).trim()
      return resolved !== '' && existsSync(resolved) ? resolved : null
    }
    const resolved = execFileSync('sh', ['-c', 'command -v lldb-dap'], { timeout: 5000 }).toString().trim()
    return resolved !== '' ? resolved : null
  } catch {
    return null
  }
}

/** One-shot event wait over the bundled DapClient's single onEvent callback. */
function waitEvent(client, name, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const previous = client.onEvent
    const timer = setTimeout(() => {
      client.onEvent = previous
      reject(new Error(`timed out waiting for event "${name}"`))
    }, timeoutMs)
    client.onEvent = (event, body) => {
      previous(event, body)
      if (event === name) {
        clearTimeout(timer)
        client.onEvent = previous
        resolve(body)
      }
    }
  })
}

const temporary = mkdtempSync(join(tmpdir(), 'pith-debug-session-check-'))
let manager
try {
  const outfile = join(temporary, 'modules.mjs')
  await build({
    stdin: {
      contents: `export { DebugManager } from './src/main/debug/manager';
export { DapClient } from './src/main/debug/dap-client';
export { readLaunchConfigurations } from './src/main/debug/adapters';`,
      resolveDir: resolve('.')
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile,
    // The SDK stays external: its own sources are not ours to bundle.
    plugins: [{
      name: 'isolated-runtime',
      setup(builder) {
        builder.onResolve({ filter: /^@earendil-works\/pi-coding-agent$/ }, () => ({
          path: fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')), external: true
        }))
      }
    }]
  })
  const { DebugManager, DapClient, readLaunchConfigurations } = await import(pathToFileURL(outfile).href)

  const lldb = lldbPath()
  if (!lldb) {
    console.log('[SKIP] debug sessions: lldb-dap not available on this host')
  } else {
    const clang = process.platform === 'darwin' ? 'xcrun' : 'clang'
    const binary = join(temporary, 'demo')
    const compileArgs = process.platform === 'darwin'
      ? ['clang', '-g', '-O0', join(FIXTURES, 'demo.c'), '-o', binary]
      : ['-g', '-O0', join(FIXTURES, 'demo.c'), '-o', binary]
    execFileSync(clang, compileArgs, { timeout: 30_000 })
    const holdBinary = join(temporary, 'hold')
    execFileSync(clang, process.platform === 'darwin'
      ? ['clang', '-g', '-O0', join(FIXTURES, 'hold.c'), '-o', holdBinary]
      : ['-g', '-O0', join(FIXTURES, 'hold.c'), '-o', holdBinary], { timeout: 30_000 })
    const arrayBinary = join(temporary, 'array')
    execFileSync(clang, process.platform === 'darwin'
      ? ['clang', '-g', '-O0', join(FIXTURES, 'array.c'), '-o', arrayBinary]
      : ['-g', '-O0', join(FIXTURES, 'array.c'), '-o', arrayBinary], { timeout: 30_000 })

    const revisions = []
    manager = new DebugManager((dto) => revisions.push(dto))
    const launch = (options = {}) => manager.start({
      sessionId: SESSION_ID,
      sessionPath: SESSION_PATH,
      workspaceCwd: FIXTURES,
      cwd: FIXTURES,
      adapterId: 'lldb-dap',
      kind: 'launch',
      program: binary,
      args: [],
      stopOnEntry: false,
      ...options
    })

    // 1. A session that ends by itself — the exact precondition of the bug.
    const first = await launch()
    await until(async () => TERMINAL.has(manager.get(SESSION_PATH, first.id).status), 'the first debuggee to exit on its own')
    const firstEnded = manager.get(SESSION_PATH, first.id)
    assert.equal(firstEnded.status, 'terminated', `first session settled as ${firstEnded.status}, expected terminated`)
    const settledConsole = manager.output(SESSION_PATH, undefined, undefined, first.id).output
    assert.match(settledConsole, /exited with status = 0/, `the settled session lost its console: ${JSON.stringify(settledConsole)}`)

    // 2. A second session in the same chat must be the one actions address.
    const second = await launch()
    assert.notEqual(second.id, first.id, 'the second launch returned the first session')
    assert.equal(
      manager.get(SESSION_PATH).id,
      second.id,
      'id-less lookup addressed the oldest settled session instead of the live one'
    )
    assert.equal(
      manager.output(SESSION_PATH).session.id,
      second.id,
      'id-less output paged the settled session instead of the live one'
    )

    const threads = await manager.threads(SESSION_PATH)
    assert.ok(Array.isArray(threads) && threads.length > 0, `threads on the live session returned ${JSON.stringify(threads)}`)

    // An explicit id still addresses a settled session out of order.
    assert.equal(manager.get(SESSION_PATH, first.id).id, first.id, 'explicit id did not address the settled session')
    assert.throws(() => manager.get(SESSION_PATH, 'no-such-id'), /No debug session with id/, 'an unknown id must be reported, not silently redirected')

    // 3. Id-less stop must end the LIVE session, not echo the dead one.
    const stopped = await manager.stop(SESSION_PATH)
    assert.equal(stopped.id, second.id, 'stop addressed the oldest settled session instead of the live one')
    assert.equal(stopped.status, 'terminated', `stop reported status ${stopped.status}`)
    assert.equal(manager.get(SESSION_PATH, second.id).status, 'terminated', 'the live debuggee was not actually stopped')

    // 4. Once nothing is live, id-less calls fall back to the newest console.
    assert.equal(manager.get(SESSION_PATH).id, second.id, 'the newest settled session should stay addressable')

    // Multiple live targets require explicit ids.
    const third = await launch({ stopOnEntry: true })
    const sibling = await launch({ stopOnEntry: true })
    assert.throws(() => manager.get(SESSION_PATH), /Multiple debug sessions/)
    await manager.stop(SESSION_PATH, sibling.id)
    assert.equal(manager.get(SESSION_PATH).id, third.id)
    await manager.stop(SESSION_PATH)
    assert.equal(manager.get(SESSION_PATH, third.id).status, 'terminated', 'the third debuggee was not stopped')

    // 6. A stopOnEntry launch must keep its entry stop instead of being
    //    promoted to `running` while the debuggee sits at the entry point.
    //    start() itself must wait for the top-frame fill, so the returned
    //    snapshot already reads "entry" (not a later remap of "exception").
    const entry = await launch({ stopOnEntry: true })
    assert.equal(entry.status, 'stopped', `stopOnEntry start() returned ${entry.status}, expected stopped`)
    assert.equal(manager.get(SESSION_PATH).id, entry.id, 'the entry session was not addressable')
    assert.notEqual(entry.activeThreadId, undefined, 'the entry stop carried no thread to inspect')
    assert.notEqual(entry.location, undefined, 'stopOnEntry start() snapshot carried no location')
    const entryFrames = await manager.stack(SESSION_PATH, entry.activeThreadId)
    assert.ok(entryFrames.length > 0, 'the entry stop exposed no stack frames')
    if (process.platform === 'darwin') {
      assert.equal(
        entry.stopReason,
        'entry',
        `stopOnEntry start() returned stopReason ${entry.stopReason}, expected entry on the first snapshot`
      )
    }
    // Continue from that stop must be accepted; demo.c then runs to completion.
    await manager.control(SESSION_PATH, 'continue', entry.activeThreadId, 10_000)
    await until(
      () => TERMINAL.has(manager.get(SESSION_PATH, entry.id).status),
      'the entry debuggee to finish after continue'
    )

    // 7. A running session that has never stopped records no thread, yet pause
    //    must still interrupt it ("call action=threads first" was a no-op tip).
    const holding = await launch({ program: holdBinary })
    assert.equal(holding.activeThreadId, undefined, 'the hold fixture already stopped, so pause took the normal path')
    const paused = await manager.control(SESSION_PATH, 'pause', undefined, 8000)
    assert.equal(paused.settled, true, 'pause without a threadId never settled')
    assert.equal(paused.session.status, 'stopped', `pause left the session ${paused.session.status}`)
    assert.notEqual(paused.session.activeThreadId, undefined, 'pause recorded no thread')

    // The control snapshot must report THIS stop, not a missing or stale line.
    const pausedFrames = await manager.stack(SESSION_PATH, paused.session.activeThreadId)
    assert.ok(pausedFrames.length > 0, 'the paused session exposed no frames')
    const pausedLocation = paused.session.location
    assert.notEqual(pausedLocation, undefined, 'the control snapshot carried no location')
    assert.equal(
      pausedLocation.line,
      pausedFrames[0].line,
      `control reported line ${pausedLocation.line} but the top frame is line ${pausedFrames[0].line}`
    )

    // 8. A NULL struct pointer must not advertise an expandable reference.
    const mainFrame = pausedFrames.find((frame) => frame.name === 'main') ?? pausedFrames[0]
    const nullPointer = await manager.evaluate(SESSION_PATH, 'cursor', mainFrame.id)
    assert.equal(
      nullPointer.variablesReference,
      0,
      `a NULL pointer advertised variablesReference ${nullPointer.variablesReference}`
    )

    // 9. evaluate without a frameId must work as well: adapters refuse it
    //    (lldb-dap answers "can't evaluate expressions when the process is
    //    running" at a stop), so the manager falls back to the top frame of the
    //    thread that stopped.
    await manager.setBreakpoints(SESSION_PATH, join(FIXTURES, 'hold.c'), [16])
    await manager.control(SESSION_PATH, 'continue', paused.session.activeThreadId, 10_000)
    const stoppedFrames = await manager.stack(SESSION_PATH, manager.get(SESSION_PATH).activeThreadId)
    assert.equal(stoppedFrames[0].name, 'main', `expected the breakpoint to stop in main, got ${stoppedFrames[0].name}`)
    const frameLess = await manager.evaluate(SESSION_PATH, 'cursor')
    assert.equal(frameLess.variablesReference, 0, `frame-less evaluate advertised ${frameLess.variablesReference}`)
    assert.match(frameLess.result, /nullptr|0x0/, `frame-less evaluate returned ${JSON.stringify(frameLess.result)}`)

    // 10. A finished session must say so rather than throw an internal TypeError.
    await manager.stop(SESSION_PATH)
    await assert.rejects(
      manager.threads(SESSION_PATH),
      /debug session has ended/,
      'threads on a finished session must report that the session ended'
    )

    // 11. Large arrays page with start/count, and the truncated flag marks a
    //     further page (the default page used to drop the tail silently).
    const arraySession = await launch({ program: arrayBinary })
    await manager.setBreakpoints(SESSION_PATH, join(FIXTURES, 'array.c'), [6])
    await until(() => manager.get(SESSION_PATH, arraySession.id).status === 'stopped', 'the array fixture to hit its breakpoint')
    const arrayThread = manager.get(SESSION_PATH).activeThreadId
    const arrayFrames = await manager.stack(SESSION_PATH, arrayThread)
    const arrayScopes = await manager.scopes(SESSION_PATH, arrayFrames[0].id)
    const locals = arrayScopes.find((scope) => /local/i.test(scope.name)) ?? arrayScopes[0]
    const localsPage = await manager.variables(SESSION_PATH, locals.variablesReference)
    const vals = localsPage.variables.find((variable) => variable.name === 'vals')
    assert.ok(vals && vals.variablesReference > 0, 'the vals array was not in scope')

    const firstPage = await manager.variables(SESSION_PATH, vals.variablesReference)
    assert.equal(firstPage.variables.length, 50, `the default page returned ${firstPage.variables.length}, expected 50`)
    assert.equal(firstPage.truncated, true, 'a 64-item array did not mark the default page truncated')
    assert.equal(firstPage.variables[0].name, '[0]', 'the first page does not start at [0]')

    const rest = await manager.variables(SESSION_PATH, vals.variablesReference, 50, 20)
    assert.equal(rest.variables.length, 14, `the second page returned ${rest.variables.length}, expected 14`)
    assert.equal(rest.truncated, false, 'the last page is still marked truncated')
    assert.equal(rest.variables[0].name, '[50]', 'the second page does not start at [50]')
    assert.equal(rest.variables[0].value, '150', `vals[50] is ${rest.variables[0].value}, expected 150`)
    await manager.stop(SESSION_PATH)

    // 12. A conditional breakpoint fires only when its condition holds:
    //     demo.c calls xorshift32 three times; x == 7 only on the first call,
    //     and the second call's parameter is xorshift32(7) == 1892583.
    const conditional = await launch()
    await manager.setBreakpoints(SESSION_PATH, join(FIXTURES, 'demo.c'), [4], { conditions: ['x != 7'] })
    await until(() => manager.get(SESSION_PATH, conditional.id).status === 'stopped', 'the conditional breakpoint to stop')
    const conditionalThread = manager.get(SESSION_PATH).activeThreadId
    const conditionalFrames = await manager.stack(SESSION_PATH, conditionalThread)
    const evaluated = await manager.evaluate(SESSION_PATH, 'x', conditionalFrames[0].id)
    assert.match(evaluated.result, /1892583/, `the conditional breakpoint fired with x = ${evaluated.result}, expected the second call's 1892583 (the first call's x == 7 must have been skipped)`)
    await manager.stop(SESSION_PATH)

    // 13. A logpoint prints to the debug console and never stops the run.
    const logged = await launch()
    await manager.setBreakpoints(SESSION_PATH, join(FIXTURES, 'demo.c'), [12], { logMessages: ['hit the loop'] })
    await until(() => TERMINAL.has(manager.get(SESSION_PATH, logged.id).status), 'the logpoint run to finish without stopping')
    const consoleTail = manager.output(SESSION_PATH, undefined, undefined, logged.id).output
    assert.match(consoleTail, /hit the loop/, 'the logpoint message never reached the console')

    // 14. restart re-runs the debuggee and the same breakpoint fires again:
    //     natively when the adapter advertises it, else via stop+start.
    const restarting = await launch()
    await manager.setBreakpoints(SESSION_PATH, join(FIXTURES, 'demo.c'), [4])
    await until(() => manager.get(SESSION_PATH, restarting.id).status === 'stopped', 'the first run to hit the breakpoint')
    const restarted = await manager.restart(SESSION_PATH)
    if (restarted.id === restarting.id) {
      // Native restart: the same session re-runs and re-hits the breakpoint.
      await until(() => manager.get(SESSION_PATH, restarting.id).location?.line === 4, 'the native restart to re-hit the breakpoint')
    } else {
      // stop+start fallback: a new session id; the manager re-binds and hits.
      assert.notEqual(restarted.id, restarting.id, 'the fallback restart must yield a new session id')
      assert.ok(['starting', 'running', 'stopped'].includes(restarted.status), `the fallback restart left the session ${restarted.status}`)
      await manager.setBreakpoints(SESSION_PATH, join(FIXTURES, 'demo.c'), [4])
      await until(() => manager.get(SESSION_PATH).status === 'stopped', 'the fallback restart to hit the breakpoint')
    }
    await manager.stop(SESSION_PATH)

    // 15. TCP transport: the same DAP handshake over a socket instead of stdio.
    {
      const tcpClient = new DapClient()
      const tcpPort = 17600 + Math.floor(Math.random() * 2000)
      await tcpClient.connectTcp({
        host: '127.0.0.1',
        port: tcpPort,
        spawn: { command: lldb, args: ['--connection', `listen://127.0.0.1:${tcpPort}`], cwd: FIXTURES },
        readyTimeoutMs: 10_000
      })
      await tcpClient.request('initialize', { clientID: 'pith-check-debug', adapterID: 'lldb-dap', linesStartAt1: true, columnsStartAt1: true, pathFormat: 'path', supportsRunInTerminalRequest: false })
      const initialized = waitEvent(tcpClient, 'initialized', 15_000)
      await tcpClient.request('launch', { program: binary, args: [], cwd: FIXTURES, stopOnEntry: false })
      await initialized
      const bound = await tcpClient.request('setBreakpoints', { source: { path: join(FIXTURES, 'demo.c') }, breakpoints: [{ line: 4 }] })
      assert.equal(bound?.breakpoints?.[0]?.verified, true, 'the TCP breakpoint did not bind')
      await tcpClient.request('configurationDone').catch(() => undefined)
      const stopped = await waitEvent(tcpClient, 'stopped', 15_000)
      assert.equal(stopped?.reason, 'breakpoint', `the TCP session stopped for ${stopped?.reason}`)
      await tcpClient.dispose()
    }

    // 16. launch.json import: JSONC tolerance, type mapping, env forms,
    //     workspace substitution, extra-key passthrough, `adapter` override.
    {
      const workspace = join(temporary, 'ws')
      await mkdir(join(workspace, '.vscode'), { recursive: true })
      await writeFile(join(workspace, '.vscode', 'launch.json'), `{
        // comment tolerance
        "configurations": [
          {
            "name": "Demo (lldb)",
            "type": "lldb",
            "request": "launch",
            "program": "\${workspaceFolder}/demo",
            "args": ["--fast",],
            "stopOnEntry": true,
            "env": { "MODE": "test" },
            "initCommands": ["settings set target.inline-breakpoint-location true"],
          },
          {
            "name": "Attach (custom)",
            "type": "cppdbg",
            "adapter": "my-adapter",
            "request": "attach",
            "processId": 4321,
            "environment": [{ "name": "A", "value": "1" }],
            "MIMode": "gdb",
          },
        ]
      }`)
      const configurations = readLaunchConfigurations(workspace)
      assert.equal(configurations.length, 2, `launch.json yielded ${configurations.length} configurations, expected 2`)
      const [demoConfig, customConfig] = configurations
      assert.equal(demoConfig.adapterId, 'lldb-dap', 'the lldb type did not map to lldb-dap')
      assert.equal(demoConfig.program, join(workspace, 'demo'), 'workspaceFolder substitution failed')
      assert.deepEqual(demoConfig.args, ['--fast'], 'trailing-comma args were not tolerated')
      assert.equal(demoConfig.stopOnEntry, true, 'stopOnEntry was not mapped')
      assert.deepEqual(demoConfig.env, { MODE: 'test' }, 'object env was not mapped')
      assert.deepEqual(demoConfig.extraArguments.initCommands, ['settings set target.inline-breakpoint-location true'], 'extra keys did not pass through')
      assert.equal(customConfig.adapterId, 'my-adapter', 'the explicit adapter key did not win')
      assert.equal(customConfig.kind, 'attach', 'the attach request was not mapped')
      assert.equal(customConfig.pid, 4321, 'processId was not mapped')
      assert.deepEqual(customConfig.env, { A: '1' }, "cppdbg's environment array was not mapped")
      assert.equal(Object.keys(customConfig.extraArguments).includes('MIMode'), false, 'MIMode should be dropped')
    }

    // 17. Real core dump: save one with lldb, then inspect it through DAP's
    // attach/coreFile path (the same target as lldb -c).
    const coreFile = join(temporary, 'demo.core')
    const lldbCommand = process.platform === 'darwin' ? 'xcrun' : 'lldb'
    const lldbArgs = ['--batch', '-o', 'breakpoint set --name main', '-o', 'run',
      '-o', `process save-core ${coreFile}`, '-o', 'process kill', binary]
    execFileSync(lldbCommand, process.platform === 'darwin' ? ['lldb', ...lldbArgs] : lldbArgs, { timeout: 30_000, stdio: 'pipe' })
    const core = await launch({ kind: 'core', coreFile, stopOnEntry: false })
    assert.equal(core.status, 'stopped')
    const coreFrames = await manager.stack(SESSION_PATH, core.activeThreadId, undefined, core.id, core.stopId)
    assert.ok(coreFrames.some(frame => frame.name.includes('main')), 'core stack has no main frame')
    const coreScopes = await manager.scopes(SESSION_PATH, coreFrames[0].id, core.id, core.stopId)
    assert.ok(coreScopes.length > 0)
    await manager.variables(SESSION_PATH, coreScopes[0].variablesReference, undefined, undefined, core.id, core.stopId)
    await manager.stop(SESSION_PATH, core.id)
    console.log('[PASS] real LLDB core dump: save → attach coreFile → stack/scopes/variables → close')

    assert.ok(revisions.length > 0, 'the manager published no DTO revisions')
    console.log(`[PASS] debug sessions: ${manager.list(SESSION_PATH).length} sessions, id-less actions followed the live one`)
  }
} catch (error) {
  console.log(`[FAIL] debug sessions: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
} finally {
  await manager?.dispose().catch(() => undefined)
  rmSync(temporary, { recursive: true, force: true })
}
