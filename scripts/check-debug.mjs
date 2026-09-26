/**
 * DAP adapter doctor: drives every detectable debug adapter through a real
 * launch → breakpoint → stop → inspect → disconnect cycle against the
 * fixtures in scripts/debug-fixtures/.
 *
 * Detection logic mirrors src/main/debug/adapters.ts (this script is plain
 * Node and cannot import the app's TypeScript). No app build required:
 *
 *   node scripts/check-debug.mjs
 *
 * Exit code is non-zero when any available adapter fails; adapters that are
 * simply absent report [SKIP] and never fail the run.
 */
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const FIXTURES = join(ROOT, 'scripts', 'debug-fixtures')
const REQUEST_TIMEOUT_MS = 15_000
const SCENARIO_TIMEOUT_MS = 30_000

/* ------------------------------------------------------------------ */
/* Minimal DAP client (Content-Length framing over stdio)              */
/* ------------------------------------------------------------------ */

class MiniDap {
  constructor(command, args, cwd) {
    this.seq = 1
    this.received = Buffer.alloc(0)
    this.pending = new Map()
    this.listeners = []
    this.stderrTail = ''
    this.child = spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    this.child.stdout.on('data', (data) => this.#ingest(data))
    this.child.stderr.on('data', (data) => {
      this.stderrTail = (this.stderrTail + data.toString('utf8')).slice(-4096)
    })
  }

  #ingest(data) {
    this.received = Buffer.concat([this.received, data])
    for (;;) {
      const headerEnd = this.received.indexOf('\r\n\r\n')
      if (headerEnd === -1) return
      const header = this.received.subarray(0, headerEnd).toString('ascii')
      const match = /Content-Length:\s*(\d+)/i.exec(header)
      if (!match) { this.received = Buffer.alloc(0); return }
      const length = Number(match[1])
      const start = headerEnd + 4
      if (this.received.length < start + length) return
      const body = this.received.subarray(start, start + length)
      this.received = this.received.subarray(start + length)
      let message
      try { message = JSON.parse(body.toString('utf8')) } catch { continue }
      this.#dispatch(message)
    }
  }

  #dispatch(message) {
    if (message.type === 'response') {
      const pending = this.pending.get(message.request_seq)
      if (!pending) return
      this.pending.delete(message.request_seq)
      clearTimeout(pending.timer)
      if (message.success === false) pending.reject(new Error(message.message ?? `${pending.command} failed`))
      else pending.resolve(message.body)
    } else if (message.type === 'event') {
      for (const listener of [...this.listeners]) listener(message.event, message.body)
    } else if (message.type === 'request') {
      // Reverse requests (runInTerminal…): not advertised, but answer politely.
      const response = { seq: this.seq++, type: 'response', request_seq: message.seq, command: message.command, success: false, message: 'not supported' }
      const text = JSON.stringify(response)
      this.child.stdin.write(`Content-Length: ${Buffer.byteLength(text)}\r\n\r\n${text}`, () => {})
    }
  }

  request(command, args) {
    const seq = this.seq++
    const message = JSON.stringify(args === undefined
      ? { seq, type: 'request', command }
      : { seq, type: 'request', command, arguments: args })
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq)
        reject(new Error(`request timed out: ${command}`))
      }, REQUEST_TIMEOUT_MS)
      this.pending.set(seq, { command, resolve, reject, timer })
      this.child.stdin.write(`Content-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`, (error) => {
        if (!error) return
        clearTimeout(timer)
        if (this.pending.delete(seq)) reject(error)
      })
    })
  }

  waitEvent(name, timeoutMs = REQUEST_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.listeners = this.listeners.filter((entry) => entry !== listener)
        reject(new Error(`timed out waiting for event "${name}"`))
      }, timeoutMs)
      const listener = (event, body) => {
        if (event !== name) return
        clearTimeout(timer)
        this.listeners = this.listeners.filter((entry) => entry !== listener)
        resolve(body)
      }
      this.listeners.push(listener)
    })
  }

  async dispose() {
    try { await this.request('disconnect', { terminateDebuggee: true }) } catch { /* already gone */ }
    this.child.kill('SIGTERM')
    await new Promise((resolve) => {
      const timer = setTimeout(() => { this.child.kill('SIGKILL'); resolve() }, 1500)
      this.child.once('exit', () => { clearTimeout(timer); resolve() })
    })
  }
}

/* ------------------------------------------------------------------ */
/* Detection (mirror of src/main/debug/adapters.ts)                    */
/* ------------------------------------------------------------------ */

function which(binary) {
  for (const dir of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const candidate = join(dir, binary)
    if (existsSync(candidate)) return candidate
  }
  return null
}

function probe(command, args) {
  try {
    return String(execFileSync(command, args, { timeout: 5000, windowsHide: true })).trim() || null
  } catch {
    return null
  }
}

const DETECTORS = {
  'lldb-dap': () => {
    if (process.platform === 'darwin') {
      const resolved = probe('xcrun', ['-f', 'lldb-dap'])
      if (resolved && existsSync(resolved)) return { command: resolved, args: [] }
    }
    const onPath = which('lldb-dap')
    return onPath ? { command: onPath, args: [] } : null
  },
  debugpy: () => {
    const python = which('python3') ?? which('python')
    if (!python) return null
    if (probe(python, ['-c', 'import debugpy']) === null) return null
    return { command: python, args: ['-m', 'debugpy.adapter'] }
  },
  dlv: () => {
    const onPath = which('dlv')
    return onPath ? { command: onPath, args: ['dap'] } : null
  }
}

/* ------------------------------------------------------------------ */
/* Shared scenario: launch → breakpoint → stop → inspect               */
/* ------------------------------------------------------------------ */

async function driveScenario(name, adapter, launchArgs, breakpoint, expected) {
  const dap = new MiniDap(adapter.command, adapter.args, FIXTURES)
  // Every request/event wait inside carries its own timeout; the finally
  // below disposes the adapter on any failure path.
  try {
    await dap.request('initialize', {
      clientID: 'pith-check-debug',
      adapterID: name,
      linesStartAt1: true,
      columnsStartAt1: true,
      pathFormat: 'path',
      supportsRunInTerminalRequest: false
    })
    const initialized = dap.waitEvent('initialized', SCENARIO_TIMEOUT_MS)
    await dap.request('launch', launchArgs)
    await initialized
    const breakpoints = await dap.request('setBreakpoints', {
      source: { path: breakpoint.file },
      breakpoints: [{ line: breakpoint.line }]
    })
    assert.equal(breakpoints?.breakpoints?.[0]?.verified, true, 'breakpoint did not bind (verified=false)')
    await dap.request('configurationDone').catch(() => undefined)
    const stopped = await dap.waitEvent('stopped', SCENARIO_TIMEOUT_MS)
    assert.equal(stopped?.reason, 'breakpoint', `unexpected stop reason: ${stopped?.reason}`)
    const threadId = stopped?.threadId
    assert.ok(typeof threadId === 'number', 'stopped event carried no threadId')
    const stack = await dap.request('stackTrace', { threadId, startFrame: 0, levels: 1 })
    const frame = stack?.stackFrames?.[0]
    assert.ok(frame, 'stackTrace returned no frame')
    assert.equal(frame.line, breakpoint.line, `stopped at line ${frame.line}, expected ${breakpoint.line}`)
    if (expected.frameName) {
      assert.ok(String(frame.name).includes(expected.frameName), `frame name "${frame.name}" does not contain "${expected.frameName}"`)
    }
    const evaluation = await dap.request('evaluate', { expression: expected.expression, frameId: frame.id, context: 'repl' })
    // Adapters format repl results their own way (lldb answers "(int) $0 = 7",
    // debugpy a bare "1"): the contract is that the value is IN there.
    assert.ok(String(evaluation?.result).includes(expected.value), `${expected.expression} evaluated to "${evaluation?.result}", expected it to contain "${expected.value}"`)
    return `stopped at ${breakpoint.file.split('/').pop()}:${breakpoint.line}, ${expected.expression} == ${expected.value}`
  } finally {
    await dap.dispose()
  }
}

/* ------------------------------------------------------------------ */
/* Per-adapter scenarios                                               */
/* ------------------------------------------------------------------ */

async function checkLldbDap(adapter) {
  // Compile THROUGH xcrun: the bare CLT clang binary has no SDK include paths
  // on its own (stdio.h goes missing); xcrun supplies SDKROOT.
  const clang = process.platform === 'darwin' ? 'xcrun' : which('clang')
  if (!clang) return { skipped: 'clang not found (cannot build demo.c)' }
  if (process.platform === 'darwin' && !probe('xcrun', ['-f', 'clang'])) return { skipped: 'clang not found (cannot build demo.c)' }
  const outDir = mkdtempSync(join(tmpdir(), 'pith-debug-check-'))
  try {
    const binary = join(outDir, 'demo')
    const compileArgs = process.platform === 'darwin'
      ? ['clang', '-g', '-O0', join(FIXTURES, 'demo.c'), '-o', binary]
      : ['-g', '-O0', join(FIXTURES, 'demo.c'), '-o', binary]
    execFileSync(clang, compileArgs, { timeout: 30000 })
    const detail = await driveScenario('lldb-dap', adapter,
      { program: binary, args: [], cwd: FIXTURES, stopOnEntry: false },
      { file: join(FIXTURES, 'demo.c'), line: 4 },
      { frameName: 'xorshift32', expression: 'x', value: '7' })
    return { detail }
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
}

async function checkDebugpy(adapter) {
  const detail = await driveScenario('debugpy', adapter,
    { program: join(FIXTURES, 'demo.py'), args: [], cwd: FIXTURES, console: 'internalConsole', stopOnEntry: false, justMyCode: true },
    { file: join(FIXTURES, 'demo.py'), line: 4 },
    { frameName: 'double', expression: 'v', value: '1' })
  return { detail }
}

async function checkDlv(adapter) {
  const go = which('go')
  if (!go) return { skipped: 'go toolchain not found (cannot build demo.go)' }
  const outDir = mkdtempSync(join(tmpdir(), 'pith-debug-check-'))
  try {
    const binary = join(outDir, 'demo-go')
    execFileSync(go, ['build', '-o', binary, join(FIXTURES, 'demo.go')], { timeout: 60000, cwd: FIXTURES })
    const detail = await driveScenario('dlv', adapter,
      { mode: 'exec', program: binary, args: [], cwd: FIXTURES, stopOnEntry: false },
      { file: join(FIXTURES, 'demo.go'), line: 6 },
      { frameName: 'add', expression: 'a', value: '2' })
    return { detail }
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
}

/* ------------------------------------------------------------------ */

const SCENARIOS = { 'lldb-dap': checkLldbDap, debugpy: checkDebugpy, dlv: checkDlv }

let failures = 0
for (const [name, scenario] of Object.entries(SCENARIOS)) {
  const adapter = DETECTORS[name]()
  if (!adapter) {
    console.log(`[SKIP] ${name}: adapter not available on this host`)
    continue
  }
  try {
    const result = await scenario(adapter)
    if (result.skipped) {
      console.log(`[SKIP] ${name}: ${result.skipped}`)
    } else {
      console.log(`[PASS] ${name}: ${result.detail}`)
    }
  } catch (error) {
    failures += 1
    console.log(`[FAIL] ${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}
process.exit(failures === 0 ? 0 : 1)
