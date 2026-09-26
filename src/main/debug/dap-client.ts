import { spawn, type ChildProcess } from 'node:child_process'
import { connect, type Socket } from 'node:net'

/**
 * Minimal Debug Adapter Protocol client over stdio.
 *
 * DAP frames JSON messages as `Content-Length: N\r\n\r\n<json>`. Three message
 * kinds ride the stream: responses (answers to our requests), events (adapter
 * → client notifications) and requests (reverse requests from the adapter,
 * e.g. runInTerminal). No external dependency: the protocol surface P0 needs
 * is small enough to own, and owning it gives exact control over timeouts,
 * cancellation and the reverse-request path.
 */

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000
const MAX_MESSAGE_BYTES = 64 * 1024 * 1024
const STDERR_TAIL_CHARS = 8192

export interface DapLaunchSpec {
  command: string
  args: string[]
  cwd: string
  env?: NodeJS.ProcessEnv
}

/** TCP transport: connect to an adapter's listen port, optionally spawning
 * the adapter process first (its args already carry the port). */
export interface DapConnectSpec {
  host: string
  port: number
  spawn?: DapLaunchSpec
  /** Budget for the listen port to come up when spawning, in ms. */
  readyTimeoutMs?: number
}

/** The framed write side of either transport (child stdin or TCP socket). */
interface DapSink {
  write: (text: string, callback: (error?: Error | null) => void) => void
}

interface PendingRequest {
  command: string
  resolve: (body: Record<string, unknown> | undefined) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
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

export class DapClient {
  private seq = 1
  private received = Buffer.alloc(0)
  private pending = new Map<number, PendingRequest>()
  private child?: ChildProcess
  private socket?: Socket
  private sink?: DapSink
  private stderrTail = ''
  private closed = false

  /** Capabilities reported by the initialize response. */
  capabilities: Record<string, unknown> = {}

  /** Adapter event (initialized, stopped, output, continued, terminated, …). */
  onEvent: (event: string, body: Record<string, unknown> | undefined) => void = () => {}
  /** Reverse request from the adapter (runInTerminal, …). The returned value
   * becomes the response body; throwing answers with success:false. */
  onReverseRequest: (command: string, args: Record<string, unknown> | undefined) => Promise<Record<string, unknown>> = async () => {
    throw new Error('not supported')
  }
  /** Fired once when the transport ends (adapter exit, spawn error, close). */
  onClose: (reason: string) => void = () => {}

  get isOpen(): boolean { return !this.closed }

  /** Last stderr bytes from the adapter, for failure reporting. */
  get stderrText(): string { return this.stderrTail }

  /** Spawn the adapter and wire the transport. Resolves once the process is
   * up; rejects if the spawn itself fails. */
  start(spec: DapLaunchSpec): Promise<void> {
    if (this.child || this.socket || this.closed) return Promise.reject(new Error('DAP client already started'))
    return new Promise<void>((resolve, reject) => {
      let child: ChildProcess
      try {
        child = spawn(spec.command, spec.args, {
          cwd: spec.cwd,
          env: spec.env ? { ...process.env, ...spec.env } : process.env,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true
        })
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)))
        return
      }
      this.child = child
      this.sink = { write: (text, callback) => child.stdin!.write(text, callback) }
      child.once('error', (error) => {
        // A spawn error before 'spawn' rejects start(); afterwards it closes.
        if (!this.closed && this.pending.size === 0 && !child.pid) {
          this.finish(`spawn: ${error.message}`)
          reject(new Error(`Failed to start debug adapter: ${error.message}`))
        } else {
          this.finish(`error: ${error.message}`)
        }
      })
      child.once('spawn', () => resolve())
      child.stdout!.on('data', (data: Buffer) => this.ingest(data))
      child.stderr!.on('data', (data: Buffer) => {
        this.stderrTail = (this.stderrTail + data.toString('utf8')).slice(-STDERR_TAIL_CHARS)
      })
      child.once('exit', (code, signal) => this.finish(`exit: ${code ?? signal ?? 'unknown'}`))
    })
  }

  /** Connect over TCP: optionally spawn the adapter, then retry the socket
   * until it listens (or the budget runs out). */
  async connectTcp(spec: DapConnectSpec): Promise<void> {
    if (this.child || this.socket || this.closed) return Promise.reject(new Error('DAP client already started'))
    if (spec.spawn) {
      let child: ChildProcess
      try {
        child = spawn(spec.spawn.command, spec.spawn.args, {
          cwd: spec.spawn.cwd,
          env: spec.spawn.env ? { ...process.env, ...spec.spawn.env } : process.env,
          stdio: ['ignore', 'ignore', 'pipe'],
          windowsHide: true
        })
      } catch (error) {
        throw error instanceof Error ? error : new Error(String(error))
      }
      this.child = child
      child.stderr!.on('data', (data: Buffer) => {
        this.stderrTail = (this.stderrTail + data.toString('utf8')).slice(-STDERR_TAIL_CHARS)
      })
      child.once('exit', (code, signal) => this.finish(`exit: ${code ?? signal ?? 'unknown'}`))
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', () => resolve())
        child.once('error', (error) => reject(new Error(`Failed to start debug adapter: ${error.message}`)))
      })
    }
    const deadline = Date.now() + Math.max(500, spec.readyTimeoutMs ?? 5000)
    let lastError: Error | undefined
    for (;;) {
      try {
        await this.tryConnect(spec.host, spec.port)
        return
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))
        if (Date.now() >= deadline || this.closed) break
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    }
    const stderr = this.stderrTail.trim()
    this.finish('connect failed')
    throw new Error(`Cannot connect to debug adapter at ${spec.host}:${spec.port}: ${lastError?.message ?? 'connection refused'}${stderr ? `\nadapter stderr: ${stderr.slice(0, 500)}` : ''}`)
  }

  private tryConnect(host: string, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = connect({ host, port })
      const onError = (error: Error) => { socket.destroy(); reject(error) }
      socket.once('error', onError)
      socket.once('connect', () => {
        socket.removeListener('error', onError)
        this.socket = socket
        this.sink = { write: (text, callback) => socket.write(text, callback) }
        socket.on('data', (data: Buffer) => this.ingest(data))
        socket.on('error', () => { /* the close event reports teardown */ })
        socket.once('close', () => this.finish('socket closed'))
        resolve()
      })
    })
  }

  /** Send a request; resolves with the response body (or undefined). */
  request(command: string, args?: Record<string, unknown>, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<Record<string, unknown> | undefined> {
    const sink = this.sink
    if (this.closed || !sink) {
      return Promise.reject(new Error(`Debug adapter is not connected (cannot ${command})`))
    }
    const seq = this.seq++
    const message = JSON.stringify(args === undefined
      ? { seq, type: 'request', command }
      : { seq, type: 'request', command, arguments: args })
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq)
        reject(new Error(`DAP request timed out: ${command}`))
      }, timeoutMs)
      this.pending.set(seq, { command, resolve, reject, timer })
      sink.write(`Content-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`, (error) => {
        if (!error) return
        clearTimeout(timer)
        if (this.pending.delete(seq)) reject(new Error(`Cannot write to debug adapter: ${error.message}`))
      })
    })
  }

  /** End the transport and terminate the adapter process. Idempotent. */
  dispose(): void {
    const child = this.child
    const socket = this.socket
    this.finish('disposed')
    this.sink = undefined
    if (socket) { socket.destroy(); this.socket = undefined }
    if (!child) return
    try { child.stdin?.end() } catch { /* transport already gone */ }
    const killer = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* gone */ } }, 1500)
    child.once('exit', () => clearTimeout(killer))
    try { child.kill('SIGTERM') } catch { /* gone */ }
  }

  private ingest(data: Buffer): void {
    this.received = Buffer.concat([this.received, data])
    for (;;) {
      const headerEnd = this.received.indexOf('\r\n\r\n')
      if (headerEnd === -1) return
      const header = this.received.subarray(0, headerEnd).toString('ascii')
      const match = /Content-Length:\s*(\d+)/i.exec(header)
      if (!match) {
        // Malformed frame: drop one line and try to resynchronize.
        const nextLine = this.received.indexOf('\r\n')
        if (nextLine === -1) { this.received = Buffer.alloc(0); return }
        this.received = this.received.subarray(nextLine + 2)
        continue
      }
      const length = Number(match[1])
      if (!Number.isSafeInteger(length) || length < 0 || length > MAX_MESSAGE_BYTES) {
        this.finish('oversized message')
        return
      }
      const bodyStart = headerEnd + 4
      if (this.received.length < bodyStart + length) return
      const body = this.received.subarray(bodyStart, bodyStart + length)
      this.received = this.received.subarray(bodyStart + length)
      let message: DapMessage
      try {
        message = JSON.parse(body.toString('utf8')) as DapMessage
      } catch {
        continue // A garbled frame must not kill the session.
      }
      this.dispatch(message)
    }
  }

  private dispatch(message: DapMessage): void {
    if (message.type === 'response') {
      const requestSeq = message.request_seq
      const pending = requestSeq === undefined ? undefined : this.pending.get(requestSeq)
      if (!pending) return
      this.pending.delete(requestSeq!)
      clearTimeout(pending.timer)
      if (message.success === false) {
        pending.reject(new Error(message.message ?? `${pending.command} failed`))
      } else {
        pending.resolve(message.body)
      }
      return
    }
    if (message.type === 'event') {
      try { this.onEvent(message.event ?? '', message.body) } catch { /* event handlers must not break framing */ }
      return
    }
    if (message.type === 'request') {
      void this.answerReverse(message)
    }
  }

  private async answerReverse(message: DapMessage): Promise<void> {
    const seq = this.seq++
    const base = { seq, type: 'response' as const, request_seq: message.seq, command: message.command ?? '' }
    let payload: Record<string, unknown>
    try {
      const body = await this.onReverseRequest(message.command ?? '', message.arguments)
      payload = { ...base, success: true, ...(body ? { body } : {}) }
    } catch (error) {
      payload = { ...base, success: false, message: error instanceof Error ? error.message : String(error) }
    }
    if (this.closed || !this.sink) return
    const text = JSON.stringify(payload)
    this.sink.write(`Content-Length: ${Buffer.byteLength(text)}\r\n\r\n${text}`, () => {})
  }

  private finish(reason: string): void {
    if (this.closed) return
    this.closed = true
    const pending = [...this.pending.values()]
    this.pending.clear()
    for (const entry of pending) {
      clearTimeout(entry.timer)
      entry.reject(new Error(`Debug adapter connection closed (${reason}) while awaiting ${entry.command}`))
    }
    try { this.onClose(reason) } catch { /* close handlers must not throw */ }
  }
}
