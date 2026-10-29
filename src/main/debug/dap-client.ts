import { spawn, type ChildProcess } from 'node:child_process'
import { connect, type Socket } from 'node:net'

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000
const MAX_MESSAGE_BYTES = 64 * 1024 * 1024
const STDERR_TAIL_CHARS = 8192

/** DAP's short `message` is often just an error code; adapters put the actual
 * compiler/expression diagnostic in body.error.format and variables. */
function responseError(message: DapMessage): Error {
  const detail = message.body?.error as { format?: unknown; variables?: Record<string, unknown> } | undefined
  const formatted = typeof detail?.format === 'string' ? detail.format.replace(/\{([^}]+)\}/g,
    (placeholder, key: string) => typeof detail.variables?.[key] === 'string' ? String(detail.variables[key]) : placeholder) : undefined
  return new Error(formatted || message.message || `${message.command} failed`)
}

async function stopAdapterTree(child: ChildProcess): Promise<void> {
  if (!child.pid) return
  if (process.platform === 'win32') {
    // taskkill cannot prove descendant cleanup after its root has gone. Do not
    // release the checkout lease (or target a potentially reused PID) then.
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('Debug adapter exited before Windows tree cleanup could be confirmed; checkout remains blocked')
    await new Promise<void>((resolve, reject) => {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
      killer.once('error', reject)
      killer.once('exit', code => code === 0 ? resolve() : reject(new Error('Could not terminate debug adapter tree; checkout remains blocked')))
    })
    return
  }
  // The detached group is ours even if its leader crashed. A leader's exit
  // must neither skip cleanup nor cancel the descendants' SIGKILL deadline.
  const signal = (value: NodeJS.Signals | 0): boolean => {
    try { process.kill(-child.pid!, value); return true }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ESRCH') return false
      // macOS can report EPERM while the last group member is a zombie
      // awaiting reaping. Treat it as potentially present and keep polling:
      // only ESRCH proves exit; persistent permission failures retain the lease.
      if (code === 'EPERM') return true
      throw error
    }
  }
  if (!signal('SIGTERM')) return
  const deadline = Date.now() + 1500
  while (signal(0) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25))
  if (!signal(0)) return
  signal('SIGKILL')
  const killedDeadline = Date.now() + 1500
  while (signal(0) && Date.now() < killedDeadline) await new Promise(resolve => setTimeout(resolve, 25))
  if (signal(0)) throw new Error('Debug adapter process group did not exit; checkout remains blocked')
}

export interface DapLaunchSpec { command: string; args: string[]; cwd: string; env?: NodeJS.ProcessEnv }
export interface DapConnectSpec {
  host: string
  port: number
  spawn?: DapLaunchSpec
  readyTimeoutMs?: number
}
interface DapMessage {
  seq: number
  type: 'request' | 'response' | 'event'
  command?: string
  event?: string
  request_seq?: number
  success?: boolean
  message?: string
  body?: Record<string, unknown>
  arguments?: Record<string, unknown>
}
interface Pending {
  resolve: (body: Record<string, unknown> | undefined) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/** One transport per DAP target. Event waiters are owned by the transport,
 * so close/cancellation cannot leave a timer pointing at a disposed session. */
export class DapClient {
  private seq = 1
  private received = Buffer.alloc(0)
  private pending = new Map<number, Pending>()
  private events = new Map<string, Set<Pending>>()
  private child?: ChildProcess
  private socket?: Socket
  private connecting?: Socket
  private sink?: { write: (text: string, callback: (error?: Error | null) => void) => unknown }
  private stderrTail = ''
  private closed = false
  private disposing?: Promise<void>
  capabilities: Record<string, unknown> = {}
  onEvent: (event: string, body: Record<string, unknown> | undefined) => void = () => {}
  onReverseRequest: (command: string, args: Record<string, unknown> | undefined) => Promise<Record<string, unknown>> = async () => { throw new Error('not supported') }
  onClose: (reason: string) => void = () => {}
  get isOpen(): boolean { return !this.closed }
  get stderrText(): string { return this.stderrTail }

  private async spawnAdapter(spec: DapLaunchSpec, stdio: boolean): Promise<void> {
    if (this.child || this.socket || this.closed) throw new Error('DAP client already started')
    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd, env: { ...process.env, ...spec.env }, windowsHide: true,
      detached: process.platform !== 'win32', stdio: stdio ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'ignore', 'pipe']
    })
    this.child = child
    child.stderr!.on('data', (data: Buffer) => { this.stderrTail = (this.stderrTail + data.toString('utf8')).slice(-STDERR_TAIL_CHARS) })
    child.on('error', (error) => this.finish(`spawn: ${error.message}`))
    child.once('exit', (code, signal) => this.finish(`exit: ${code ?? signal ?? 'unknown'}`))
    if (stdio) {
      this.sink = child.stdin!
      child.stdin!.on('error', () => this.finish('stdin closed'))
      child.stdout!.on('data', (data: Buffer) => this.ingest(data))
    }
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve)
      child.once('error', reject)
    })
    if (this.closed) throw new Error('Debug adapter closed during launch')
  }

  start(spec: DapLaunchSpec): Promise<void> { return this.spawnAdapter(spec, true) }

  async connectTcp(spec: DapConnectSpec): Promise<void> {
    if (this.child || this.socket || this.connecting || this.closed) throw new Error('DAP client already started')
    if (spec.spawn) await this.spawnAdapter(spec.spawn, false)
    const deadline = Date.now() + Math.max(100, spec.readyTimeoutMs ?? 5000)
    let lastError: unknown
    while (!this.closed && Date.now() < deadline) {
      try { await this.tryConnect(spec.host, spec.port, Math.min(500, deadline - Date.now())); return }
      catch (error) { lastError = error }
      if (!this.closed) await new Promise((resolve) => setTimeout(resolve, Math.min(100, Math.max(0, deadline - Date.now()))))
    }
    const detail = lastError instanceof Error ? lastError.message : 'connection closed'
    throw new Error(`Cannot connect to debug adapter at ${spec.host}:${spec.port}: ${detail}`)
  }

  private tryConnect(host: string, port: number, timeout: number): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.closed) { reject(new Error('Debug adapter closed')); return }
      const socket = connect({ host, port })
      this.connecting = socket
      const timer = setTimeout(() => socket.destroy(new Error('Connection timed out')), timeout)
      const failed = (error?: Error) => {
        clearTimeout(timer)
        if (this.connecting === socket) this.connecting = undefined
        reject(error ?? new Error('Connection closed'))
      }
      socket.once('error', failed)
      socket.once('close', failed)
      socket.once('connect', () => {
        clearTimeout(timer)
        socket.removeListener('error', failed); socket.removeListener('close', failed)
        this.connecting = undefined
        if (this.closed) { socket.destroy(); reject(new Error('Debug adapter closed')); return }
        this.socket = socket; this.sink = socket
        socket.on('data', (data: Buffer) => this.ingest(data))
        socket.on('error', () => {})
        socket.once('close', () => this.finish('socket closed'))
        resolve()
      })
    })
  }

  waitForEvent(name: string, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<Record<string, unknown> | undefined> {
    if (this.closed) return Promise.reject(new Error('Debug adapter closed'))
    return new Promise((resolve, reject) => {
      const entries = this.events.get(name) ?? new Set<Pending>()
      this.events.set(name, entries)
      const entry: Pending = { resolve, reject, timer: setTimeout(() => {
        entries.delete(entry)
        if (!entries.size) this.events.delete(name)
        reject(new Error(`Timed out waiting for the adapter's ${name} event`))
      }, timeoutMs) }
      entries.add(entry)
    })
  }

  request(command: string, args?: Record<string, unknown>, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<Record<string, unknown> | undefined> {
    if (this.closed || !this.sink) return Promise.reject(new Error(`Debug adapter is not connected (cannot ${command})`))
    const seq = this.seq++
    return new Promise((resolve, reject) => {
      const entry: Pending = { resolve, reject, timer: setTimeout(() => {
        this.pending.delete(seq); reject(new Error(`DAP request timed out: ${command}`))
      }, timeoutMs) }
      this.pending.set(seq, entry)
      this.write({ seq, type: 'request', command, ...(args === undefined ? {} : { arguments: args }) }, (error) => {
        if (error && this.pending.delete(seq)) { clearTimeout(entry.timer); reject(error) }
      })
    })
  }

  private write(message: DapMessage, callback: (error?: Error | null) => void = () => {}): void {
    const text = JSON.stringify(message)
    try { this.sink?.write(`Content-Length: ${Buffer.byteLength(text)}\r\n\r\n${text}`, callback) }
    catch (error) { callback(error instanceof Error ? error : new Error(String(error))) }
  }

  /** Resolves after adapter termination, not merely after sending a signal. */
  dispose(): Promise<void> {
    if (this.disposing) return this.disposing
    // Install the promise before onClose can re-enter disposal.
    let complete!: () => void, failed!: (error: unknown) => void
    this.disposing = new Promise<void>((resolve, reject) => { complete = resolve; failed = reject })
    void this.disposing.catch(() => {}) // onClose/stream errors can initiate cleanup without a caller
    this.finish('disposed')
    this.connecting?.destroy(); this.socket?.destroy(); this.sink = undefined
    const child = this.child
    void (child ? stopAdapterTree(child) : Promise.resolve()).then(complete, failed)
    return this.disposing
  }

  private ingest(data: Buffer): void {
    if (this.closed) return
    this.received = Buffer.concat([this.received, data])
    for (;;) {
      const end = this.received.indexOf('\r\n\r\n')
      if (end < 0) { if (this.received.length > 8192) void this.dispose(); return }
      const match = /^Content-Length:\s*(\d+)\s*$/im.exec(this.received.subarray(0, end).toString('ascii'))
      const length = match ? Number(match[1]) : NaN
      if (!Number.isSafeInteger(length) || length > MAX_MESSAGE_BYTES) { void this.dispose(); return }
      const start = end + 4
      if (this.received.length < start + length) return
      const body = this.received.subarray(start, start + length)
      this.received = this.received.subarray(start + length)
      let message: DapMessage
      try { message = JSON.parse(body.toString('utf8')) as DapMessage } catch { continue }
      if (!message || typeof message !== 'object') continue
      if (message.type === 'response') {
        const entry = this.pending.get(message.request_seq!)
        if (!entry) continue
        this.pending.delete(message.request_seq!); clearTimeout(entry.timer)
        if (message.success === false) entry.reject(responseError(message))
        else entry.resolve(message.body)
      } else if (message.type === 'event') {
        const name = message.event ?? ''
        const entries = this.events.get(name); this.events.delete(name)
        for (const entry of entries ?? []) { clearTimeout(entry.timer); entry.resolve(message.body) }
        this.onEvent(name, message.body)
      } else if (message.type === 'request') void this.answerReverse(message)
    }
  }

  private async answerReverse(message: DapMessage): Promise<void> {
    const base: DapMessage = { seq: this.seq++, type: 'response', request_seq: message.seq, command: message.command }
    try {
      const body = await this.onReverseRequest(message.command ?? '', message.arguments)
      if (!this.closed) this.write({ ...base, success: true, body })
    } catch (error) {
      if (!this.closed) this.write({ ...base, success: false, message: error instanceof Error ? error.message : String(error) })
    }
  }

  private finish(reason: string): void {
    if (this.closed) return
    this.closed = true
    const entries = [...this.pending.values(), ...[...this.events.values()].flatMap((set) => [...set])]
    this.pending.clear(); this.events.clear(); this.received = Buffer.alloc(0)
    for (const entry of entries) { clearTimeout(entry.timer); entry.reject(new Error(`Debug adapter connection closed (${reason})`)) }
    this.onClose(reason)
  }
}
