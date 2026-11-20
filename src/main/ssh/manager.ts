import { randomUUID } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import { stripVTControlCharacters } from 'node:util'
import ssh2, { type Client, type ClientChannel } from 'ssh2'
import headless, { type Terminal } from '@xterm/headless'
import { SerializeAddon } from '@xterm/addon-serialize'
import type { SshEvent, SshOutputDTO, SshSessionDTO, SshTerminalSnapshot } from '../../shared/ssh'
import { loadSshCredentials, type SshCredentialSource } from './credentials'
import { SshHostKeys } from './host-keys'

const TAIL_CHARS = 128 * 1024
const LIVE_LIMIT = 8
const HISTORY_LIMIT = 32
class SshLoginError extends Error {
  constructor(message: string, readonly retryable: boolean) { super(message) }
}
const live = (session: SshSessionDTO): boolean => ['connecting', 'connected', 'reconnecting'].includes(session.status)
const dimension = (n: number, max: number): number => {
  if (!Number.isInteger(n) || n < 2 || n > max) throw new Error('Invalid SSH terminal dimensions')
  return n
}

export interface SshConnectOptions extends SshCredentialSource {
  host: string
  port?: number
  username: string
  persistence?: 'tmux' | 'shell'
  remoteSession?: string
  hostFingerprint?: string
  cols?: number
  rows?: number
  autoReconnect?: boolean
  keepaliveIntervalMs?: number
  readyTimeoutMs?: number
}
interface Connection {
  dto: SshSessionDTO
  options: SshConnectOptions
  cwd: string
  canStart: () => boolean
  terminal?: Terminal
  serializer?: SerializeAddon
  parsedCursor: number
  lastScreen: string
  tail: string
  client?: Client
  channel?: ClientChannel
  epoch: number
  attempt?: Promise<void>
  cancelAttempt?: () => void
  reconnectTimer?: ReturnType<typeof setTimeout>
  batchTimer?: ReturnType<typeof setTimeout>
  batch: string
  batchStart: number
  listeners: Set<() => void>
  closePromise?: Promise<SshSessionDTO>
  closing: boolean
  retryFailures: number
}

/** One owner per chat. Connections survive tool returns and pane/session switches. */
export class SshSessionManager {
  private sessions = new Map<string, Connection>()
  private closing = false
  private viewers = new Map<number, Map<string, number>>()
  private keys: SshHostKeys
  constructor(hostKeysPath: string, private emit: (event: SshEvent) => void,
    private reconnectDelayMs = 1000) { this.keys = new SshHostKeys(hostKeysPath) }

  list(sessionPath?: string): SshSessionDTO[] {
    return [...this.sessions.values()].filter(c => sessionPath === undefined || c.dto.sessionPath === sessionPath).map(c => ({ ...c.dto }))
  }
  // Disconnected tmux jobs and cleanup in flight still own remote work.
  liveCount(sessionPath: string): number {
    return [...this.sessions.values()].filter(c => c.dto.sessionPath === sessionPath && (c.dto.status !== 'closed' || c.closing)).length
  }
  watchViewer(id: number, active: boolean): void {
    if (active) { if (!this.viewers.has(id)) this.viewers.set(id, new Map()) }
    else { this.viewers.delete(id); for (const c of this.sessions.values()) this.flush(c) }
  }
  ackViewer(viewer: number, id: string, chars: number): void {
    const pending = this.viewers.get(viewer)
    if (!pending) return
    pending.set(id, Math.max(0, (pending.get(id) ?? 0) - chars))
    const c = this.sessions.get(id); if (c) this.flush(c)
  }
  private owned(sessionPath: string, id: string): Connection {
    const c = this.sessions.get(id)
    if (!c || c.dto.sessionPath !== sessionPath) throw new Error('Unknown SSH session in this chat')
    return c
  }
  status(sessionPath: string, id: string): SshSessionDTO { return { ...this.owned(sessionPath, id).dto } }
  private changed(c: Connection): void {
    c.dto.revision++
    this.emit({ type: 'state', session: { ...c.dto } })
    for (const wake of [...c.listeners]) wake()
  }
  private admitted(c: Connection): void {
    if (this.closing || c.dto.status === 'closed' || !c.canStart()) throw new Error('SSH session admission is closed')
  }

  async connect(sessionPath: string, cwd: string, options: SshConnectOptions, canStart: () => boolean, signal?: AbortSignal): Promise<SshSessionDTO> {
    if (this.closing || signal?.aborted || !canStart()) throw new Error('SSH connection cancelled before login')
    if (!options.host || options.host.length > 253 || /[\s\x00-\x1f\x7f]/.test(options.host) || !options.username || options.username.length > 128 || /[\x00-\x1f\x7f]/.test(options.username)) throw new Error('Invalid SSH host or username')
    const port = options.port ?? 22
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid SSH port')
    if (options.hostFingerprint && !/^SHA256:[A-Za-z0-9+/]{43}$/.test(options.hostFingerprint)) throw new Error('Invalid SSH host fingerprint')
    if (options.remoteSession && !/^[A-Za-z0-9_-]{1,80}$/.test(options.remoteSession)) throw new Error('Invalid remote tmux session name')
    if (options.persistence && !['tmux', 'shell'].includes(options.persistence)) throw new Error('Invalid SSH persistence mode')
    for (const value of [options.keepaliveIntervalMs, options.readyTimeoutMs]) {
      if (value !== undefined && (!Number.isInteger(value) || value < 1000 || value > 120_000)) throw new Error('Invalid SSH connection timing')
    }
    if ([...this.sessions.values()].filter(c => c.dto.status !== 'closed' || c.closing).length >= LIVE_LIMIT) throw new Error('At most 8 SSH sessions may be open')
    const id = randomUUID()
    const persistence = options.persistence ?? 'tmux'
    const cols = dimension(options.cols ?? 100, 240), rows = dimension(options.rows ?? 30, 100)
    const c: Connection = {
      dto: { id, sessionPath, host: options.host, port, username: options.username, persistence,
        ...(persistence === 'tmux' ? { remoteSession: options.remoteSession ?? `pith_${id.replaceAll('-', '')}` } : {}),
        status: 'connecting', generation: 0, revision: 0, reconnectAttempts: 0, cols, rows, outputChars: 0, startedAt: Date.now() },
      options: { ...options }, cwd, canStart, terminal: new headless.Terminal({ cols, rows, scrollback: 1000, allowProposedApi: true }),
      serializer: new SerializeAddon(), parsedCursor: 0,
      lastScreen: '', tail: '', epoch: 0, batch: '', batchStart: 0, listeners: new Set(), retryFailures: 0, closing: false
    }
    c.terminal!.loadAddon(c.serializer!)
    c.terminal!.onData(data => {
      if (c.dto.status === 'connected' && c.channel?.writable && c.channel.writableLength < 128 * 1024) c.channel.write(data)
    })
    this.sessions.set(id, c); this.changed(c)
    const abort = (): void => { void this.close(sessionPath, id, true) }
    signal?.addEventListener('abort', abort, { once: true })
    try {
      await this.login(c)
      if (signal?.aborted) throw new Error('SSH login cancelled')
      return { ...c.dto }
    } catch (error) {
      if (c.dto.status !== 'closed') {
        c.dto.status = 'failed'; c.dto.error ??= error instanceof Error ? error.message.slice(0, 512) : 'SSH login failed'; this.changed(c)
      }
      throw error
    } finally { signal?.removeEventListener('abort', abort); this.prune() }
  }

  private login(c: Connection): Promise<void> {
    if (c.attempt) return c.attempt
    const epoch = ++c.epoch
    const promise = this.open(c, epoch)
    c.attempt = promise
    void promise.finally(() => { if (c.attempt === promise) c.attempt = undefined }).catch(() => {})
    return promise
  }
  private async open(c: Connection, epoch: number): Promise<void> {
    this.admitted(c)
    delete c.dto.error
    const credentials = await loadSshCredentials(c.options, c.cwd).catch(error => {
      throw new SshLoginError(`Could not load SSH credentials: ${error instanceof Error ? error.message.slice(0, 384) : 'unavailable'}`, false)
    })
    this.admitted(c)
    if (epoch !== c.epoch) throw new Error('SSH login cancelled')
    const client = new ssh2.Client()
    c.client = client
    let terminalReady = false, remoteExited = false, fatal = false
    await new Promise<void>((resolve, reject) => {
      let finished = false
      const finish = (error?: Error, destroy = true): void => {
        if (finished) return
        finished = true; clearTimeout(timer); c.cancelAttempt = undefined
        if (error) {
          c.dto.error ??= error.message
          if (destroy) client.destroy()
          reject(error instanceof SshLoginError ? error : new SshLoginError(error.message, false))
        } else resolve()
      }
      const timer = setTimeout(() => finish(new SshLoginError('SSH login or PTY allocation timed out', true)), (c.options.readyTimeoutMs ?? 20_000) + 1000)
      // Close may still need this authenticated client for bounded remote cleanup.
      c.cancelAttempt = () => finish(new Error('SSH login cancelled'), false)
      client.on('error', (error: Error & { level?: string }) => {
        if (epoch !== c.epoch) return
        // Authentication and changed keys need new evidence; never retry them indefinitely.
        fatal ||= error.level === 'client-authentication' || error.level === 'client-host-verification'
        c.dto.error ??= error.message.slice(0, 512)
        if (!terminalReady) finish(new SshLoginError(c.dto.error, !fatal))
      })
      client.on('close', () => {
        if (epoch !== c.epoch || c.dto.status === 'closed') return
        c.client = undefined; c.channel = undefined
        if (!terminalReady) { finish(new SshLoginError(c.dto.error ?? 'SSH connection closed during login', !fatal)); return }
        this.flush(c)
        if (remoteExited || fatal || c.options.autoReconnect === false || !c.canStart() || this.closing) {
          c.dto.status = fatal ? 'failed' : 'disconnected'; this.changed(c)
        } else this.scheduleReconnect(c)
      })
      client.on('keyboard-interactive', (_name, _instructions, _lang, prompts, answer) => {
        // Only a single password prompt can be answered without a human challenge.
        answer(prompts.length === 1 && !prompts[0].echo && /password/i.test(prompts[0].prompt) && credentials.password ? [credentials.password] : [])
      })
      client.once('ready', () => {
        try { this.admitted(c) } catch (error) { finish(error as Error); return }
        const opened = (error: Error | undefined, channel: ClientChannel): void => {
          if (epoch !== c.epoch || c.dto.status === 'closed') { channel?.destroy(); finish(new Error('SSH login cancelled')); return }
          if (error) { finish(new Error('Could not allocate the remote SSH terminal')); return }
          try { this.admitted(c) } catch (denial) { channel.destroy(); finish(denial as Error); return }
          terminalReady = true; c.channel = channel; c.retryFailures = 0
          c.dto.generation++; c.dto.status = 'connected'; delete c.dto.error
          if (c.dto.generation > 1) this.append(c, '\x1bc')
          this.changed(c)
          const stdout = new StringDecoder('utf8'), stderr = new StringDecoder('utf8')
          const consume = (decoder: StringDecoder, data: Buffer): void => {
            if (epoch !== c.epoch || c.dto.status === 'closed') return
            const text = decoder.write(data)
            if (!text) return
            // Bound headless-parser queues as well as retained output.
            channel.pause(); channel.stderr.pause()
            this.append(c, text, () => { if (epoch === c.epoch) { channel.resume(); channel.stderr.resume() } })
          }
          channel.on('data', (data: Buffer) => consume(stdout, data))
          channel.stderr.on('data', (data: Buffer) => consume(stderr, data))
          channel.on('error', () => { if (epoch === c.epoch) client.destroy() })
          channel.on('exit', (code: number) => {
            if (epoch !== c.epoch) return
            remoteExited = true
            if (code) c.dto.error = c.dto.persistence === 'tmux'
              ? `Remote tmux exited with code ${code}. Ensure tmux is installed, or explicitly use persistence="shell".`
              : `Remote shell exited with code ${code}`
          })
          channel.on('close', () => {
            if (epoch !== c.epoch) return
            this.append(c, stdout.end() + stderr.end()); client.end()
          })
          finish()
        }
        const pty = { term: 'xterm-256color', cols: c.dto.cols, rows: c.dto.rows, width: 0, height: 0 }
        if (c.dto.persistence === 'tmux') client.exec(`exec tmux -u new-session -A -s '${c.dto.remoteSession}'`, { pty }, opened)
        else client.shell(pty, opened)
      })
      try {
        client.connect({ host: c.dto.host, port: c.dto.port, username: c.dto.username, ...credentials,
          readyTimeout: c.options.readyTimeoutMs ?? 20_000, keepaliveInterval: c.options.keepaliveIntervalMs ?? 15_000,
          keepaliveCountMax: 3, tryKeyboard: Boolean(credentials.password),
          hostVerifier: (key: Buffer) => {
            try { c.dto.fingerprint = this.keys.verify(c.dto.host, c.dto.port, key, c.options.hostFingerprint); return true }
            catch (error) { fatal = true; c.dto.error = (error as Error).message; return false }
          }
        })
      } catch { finish(new Error('Invalid SSH credentials or connection configuration')) }
    })
  }
  private scheduleReconnect(c: Connection): void {
    if (c.reconnectTimer || this.closing || c.dto.status === 'closed') return
    c.dto.status = 'reconnecting'; c.dto.reconnectAttempts++; this.changed(c)
    const delay = Math.min(30_000, this.reconnectDelayMs * 2 ** Math.min(c.retryFailures++, 5))
    c.reconnectTimer = setTimeout(() => {
      c.reconnectTimer = undefined
      if (!c.canStart() || this.closing || c.dto.status === 'closed') { c.dto.status = 'disconnected'; this.changed(c); return }
      const attempt = this.login(c), attemptEpoch = c.epoch
      void attempt.catch(error => {
        if (c.dto.status === 'closed' || c.epoch !== attemptEpoch) return
        c.dto.error ??= error instanceof Error ? error.message : 'SSH reconnection failed'
        if (error instanceof SshLoginError && error.retryable) this.scheduleReconnect(c)
        else { c.dto.status = 'failed'; this.changed(c) }
      })
    }, delay)
    c.reconnectTimer.unref()
  }
  private append(c: Connection, data: string, parsed?: () => void): void {
    if (!data || c.dto.status === 'closed') { parsed?.(); return }
    if (!c.batch) c.batchStart = c.dto.outputChars
    c.tail = (c.tail + data).slice(-TAIL_CHARS); c.dto.outputChars += data.length
    c.batch = (c.batch + data).slice(-65_536)
    c.batchStart = c.dto.outputChars - c.batch.length
    const terminal = c.terminal, cursor = c.dto.outputChars
    if (terminal) terminal.write(data, () => {
      if (c.terminal === terminal) c.parsedCursor = cursor
      parsed?.()
    })
    else parsed?.()
    if (c.batch.length >= 32 * 1024) this.flush(c)
    else c.batchTimer ??= setTimeout(() => this.flush(c), 20)
    for (const wake of [...c.listeners]) wake()
  }
  private flush(c: Connection, force = false): void {
    clearTimeout(c.batchTimer); c.batchTimer = undefined
    if (!c.batch) return
    // A slow/hidden renderer cannot accumulate unlimited IPC or emulator writes.
    // Retain a bounded recent batch; its cursor gap triggers a complete screen snapshot.
    if (!force && [...this.viewers.values()].some(pending => (pending.get(c.dto.id) ?? 0) >= 128 * 1024)) return
    const data = c.batch; c.batch = ''
    for (const pending of this.viewers.values()) pending.set(c.dto.id, (pending.get(c.dto.id) ?? 0) + data.length)
    this.emit({ type: 'data', id: c.dto.id, sessionPath: c.dto.sessionPath, generation: c.dto.generation,
      data, startCursor: c.batchStart, cursor: c.dto.outputChars })
  }
  private screen(c: Connection): string {
    if (!c.terminal) return c.lastScreen
    const b = c.terminal.buffer.active
    return Array.from({ length: c.dto.rows }, (_, i) => b.getLine(b.viewportY + i)?.translateToString(true) ?? '').join('\n').trimEnd()
  }
  async output(sessionPath: string, id: string, cursor?: number, maxChars = 16_384, waitMs = 0, signal?: AbortSignal, includeSnapshot = false): Promise<SshOutputDTO> {
    const c = this.owned(sessionPath, id)
    if (cursor !== undefined && (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > c.dto.outputChars)) throw new Error('Invalid SSH output cursor')
    if (!Number.isInteger(maxChars) || maxChars < 2 || maxChars > 65_536 || !Number.isInteger(waitMs) || waitMs < 0 || waitMs > 30_000) throw new Error('Invalid SSH output bounds')
    if (waitMs && cursor === c.dto.outputChars && live(c.dto)) {
      await new Promise<void>((resolve, reject) => {
        const cleanup = (): void => { clearTimeout(timer); c.listeners.delete(wake); signal?.removeEventListener('abort', abort) }
        const wake = (): void => { cleanup(); resolve() }
        const abort = (): void => { cleanup(); reject(new Error('SSH output wait cancelled')) }
        const timer = setTimeout(wake, waitMs)
        c.listeners.add(wake); signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort()
      })
    }
    // Capture the framebuffer and parsed cursor inside the same write barrier.
    // Received bytes may still be queued; using outputChars here would skip them.
    let snapshot: SshTerminalSnapshot | undefined
    const terminal = c.terminal
    if (terminal) await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => includeSnapshot ? reject(new Error('SSH terminal snapshot timed out')) : resolve(), includeSnapshot ? 1000 : 250)
      terminal.write('', () => {
        clearTimeout(timer)
        try {
          if (includeSnapshot && c.terminal === terminal && c.serializer) snapshot = {
            data: c.serializer.serialize({ scrollback: 0 }), cursor: c.parsedCursor, cols: terminal.cols, rows: terminal.rows
          }
          resolve()
        } catch (error) { reject(error) }
      })
    })
    const end = c.dto.outputChars, retainedStart = end - c.tail.length
    let start = Math.max(retainedStart, cursor ?? Math.max(retainedStart, end - maxChars)), to = Math.min(end, start + maxChars)
    const low = (at: number): boolean => { const char = c.tail.charCodeAt(at - retainedStart); return char >= 0xdc00 && char <= 0xdfff }
    if (low(start)) start++
    if (to < end && low(to)) to--
    const output = c.tail.slice(start - retainedStart, to - retainedStart)
    return { session: { ...c.dto }, output, text: stripVTControlCharacters(output), screen: this.screen(c), ...(snapshot ? { snapshot } : {}),
      cursor: to, startCursor: start, truncated: cursor === undefined ? start > 0 : cursor < start, hasMore: to < end }
  }
  write(sessionPath: string, id: string, data: string, generation: number, binary = false): SshSessionDTO {
    const c = this.owned(sessionPath, id); this.admitted(c)
    if (c.dto.status !== 'connected' || !c.channel) throw new Error('SSH is not connected; input was not sent or queued')
    if (generation !== c.dto.generation) throw new Error('SSH connection generation changed; inspect the session before sending input')
    if (typeof data !== 'string' || data.length > 65_536) throw new Error('SSH input exceeds 64 KiB')
    if (c.channel.writableLength > 128 * 1024) throw new Error('SSH input is backpressured; input was not sent')
    c.channel.write(binary ? Buffer.from(data, 'binary') : data)
    return { ...c.dto }
  }
  resize(sessionPath: string, id: string, cols: number, rows: number): SshSessionDTO {
    const c = this.owned(sessionPath, id)
    c.dto.cols = dimension(cols, 240); c.dto.rows = dimension(rows, 100)
    c.terminal?.resize(cols, rows); c.channel?.setWindow(rows, cols, 0, 0); this.changed(c)
    return { ...c.dto }
  }
  async reconnect(sessionPath: string, id: string): Promise<SshSessionDTO> {
    const c = this.owned(sessionPath, id); this.admitted(c)
    clearTimeout(c.reconnectTimer); c.reconnectTimer = undefined
    c.epoch++; c.cancelAttempt?.(); c.client?.destroy(); c.client = undefined; c.channel = undefined
    const previous = c.attempt; if (previous) await previous.catch(() => {})
    this.admitted(c)
    c.dto.status = 'reconnecting'; delete c.dto.error; this.changed(c)
    try { await this.login(c); return { ...c.dto } }
    catch (error) { if (this.status(sessionPath, id).status !== 'closed') { c.dto.status = 'failed'; this.changed(c) }; throw error }
  }
  close(sessionPath: string, id: string, terminateRemote = false): Promise<SshSessionDTO> {
    const c = this.owned(sessionPath, id)
    return c.closePromise ??= this.closeConnection(c, terminateRemote)
  }
  private async closeConnection(c: Connection, terminateRemote: boolean): Promise<SshSessionDTO> {
    if (c.dto.status === 'closed') return { ...c.dto }
    const pendingLogin = Boolean(c.attempt)
    c.closing = true
    c.dto.status = 'closed'; c.epoch++; clearTimeout(c.reconnectTimer); c.reconnectTimer = undefined
    c.cancelAttempt?.(); this.flush(c, true); this.changed(c)
    const client = c.client; c.client = undefined; c.channel = undefined
    if (terminateRemote && c.dto.persistence === 'tmux') {
      c.dto.remoteTerminated = false
      if (client) await new Promise<void>(resolve => {
        let settled = false, retryTimer: ReturnType<typeof setTimeout> | undefined
        const deadline = Date.now() + 1500
        const finish = (): void => { if (settled) return; settled = true; clearTimeout(timer); clearTimeout(retryTimer); resolve() }
        const timer = setTimeout(finish, 1500)
        const kill = (): void => {
          if (settled) return
          try { client.exec(`tmux kill-session -t '=${c.dto.remoteSession}'`, (error, stream) => {
            if (settled) { stream?.destroy(); return }
            if (error) { finish(); return }
            stream.on('error', finish); stream.resume(); stream.stderr.resume()
            stream.on('close', (code: number) => {
              if (settled) return
              if (code === 0) { c.dto.remoteTerminated = true; finish() }
              // PTY acceptance can precede tmux startup. Retry only this
              // idempotent cleanup, never terminal input, within the deadline.
              else if (pendingLogin && code === 1 && Date.now() < deadline - 50) retryTimer = setTimeout(kill, 50)
              else finish()
            })
          }) } catch { finish() }
        }
        kill()
      })
    }
    client?.destroy()
    c.lastScreen = this.screen(c); c.terminal?.dispose(); c.terminal = undefined; c.serializer = undefined
    c.closing = false; this.changed(c); this.prune()
    for (const pending of this.viewers.values()) pending.delete(c.dto.id)
    return { ...c.dto }
  }
  private prune(): void {
    const ended = [...this.sessions.values()].filter(c => c.dto.status === 'closed' && !c.closing)
    for (const c of ended.slice(0, Math.max(0, ended.length - HISTORY_LIMIT))) {
      this.sessions.delete(c.dto.id)
    }
  }
  async stopSession(sessionPath: string): Promise<void> {
    await Promise.all([...this.sessions.values()].filter(c => c.dto.sessionPath === sessionPath).map(c => this.close(sessionPath, c.dto.id, true)))
  }
  async dispose(): Promise<void> {
    this.closing = true
    await Promise.all([...this.sessions.values()].map(c => this.close(c.dto.sessionPath, c.dto.id, true)))
  }
}
