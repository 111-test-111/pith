import { utilityProcess, type UtilityProcess, type WebContents } from 'electron'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { stat } from 'node:fs/promises'
import { isDefaultWorkspace } from '../pi/default-workspace'
import type { TerminalCommand, TerminalCreatePayload, TerminalCreateResult, TerminalHostEvent } from '../../shared/types'
import type { CheckoutCoordinator } from '../rewind/coordinator'

interface OwnedTerminal {
  release?: () => void
  sent?: boolean
  closing?: boolean
  owner: WebContents
  resolve: (result: TerminalCreateResult) => void
  timer: ReturnType<typeof setTimeout>
  pid?: number
  closed: Promise<void>
  resolveClosed: () => void
}
const dimension = (value: number, max: number): number => Math.max(2, Math.min(max, Math.floor(value) || 24))

/** Owns lifetimes and authorization; output is already batched in the PTY host. */
export class TerminalManager {
  private host: UtilityProcess | null = null
  private terminals = new Map<string, OwnedTerminal>()
  private watched = new WeakSet<WebContents>()
  constructor(private coordinator?: CheckoutCoordinator) {}

  async create(owner: WebContents, payload: TerminalCreatePayload): Promise<TerminalCreateResult> {
    if (!payload || typeof payload.id !== 'string' || !/^[\w-]{1,80}$/.test(payload.id) || this.terminals.has(payload.id)) return { error: 'spawn' }
    if (payload.cwd != null && typeof payload.cwd !== 'string') return { error: 'directory' }
    const cwd = !payload.cwd || isDefaultWorkspace(payload.cwd) ? homedir() : payload.cwd
    if (typeof cwd !== 'string' || !isAbsolute(cwd)) return { error: 'directory' }
    let release: (() => void) | undefined
    try { release = await this.coordinator?.enter(cwd, 'terminal') } catch { return { error: 'spawn' } }
    if (this.terminals.has(payload.id) || owner.isDestroyed()) { release?.(); return { error: 'closed' } }
    if (!this.watched.has(owner)) {
      this.watched.add(owner)
      const closeAll = (): void => {
        for (const [id, entry] of this.terminals) if (entry.owner === owner) this.close(owner, id)
      }
      owner.once('destroyed', closeAll)
      owner.on('render-process-gone', closeAll)
      owner.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
        if (mainFrame && !inPlace) closeAll()
      })
    }
    return new Promise((resolve) => {
      let resolveClosed!: () => void
      const entry: OwnedTerminal = {
        owner, resolve, release,
        closed: new Promise<void>(done => { resolveClosed = done }), resolveClosed: () => resolveClosed(),
        timer: setTimeout(() => this.close(owner, payload.id, 'host'), 15_000)
      }
      this.terminals.set(payload.id, entry)
      void stat(cwd).then((info) => {
        if (this.terminals.get(payload.id) !== entry) return
        if (!info.isDirectory()) { this.close(owner, payload.id, 'directory'); return }
        try {
          const host = this.ensureHost()
          host.postMessage({ type: 'create', payload: {
            ...payload, cwd, cols: dimension(payload.cols, 1000), rows: dimension(payload.rows, 500)
          } } satisfies TerminalCommand)
          entry.sent = true
        } catch { this.close(owner, payload.id, 'host') }
      }, () => this.close(owner, payload.id, 'directory'))
    })
  }

  /** A debug target owns its terminal until the PTY host confirms tree exit. */
  async closeAndWait(owner: WebContents, id: string): Promise<void> {
    const entry = this.terminals.get(id)
    if (!entry || entry.owner !== owner) return
    this.close(owner, id)
    await entry.closed
  }

  command(owner: WebContents, command: Exclude<TerminalCommand, { type: 'create' | 'dispose' }>): void {
    if (!command || this.terminals.get(command.id)?.owner !== owner) return
    if (command.type === 'close') { this.close(owner, command.id); return }
    if (command.type === 'input' && (typeof command.data !== 'string' || command.data.length > 64 * 1024)) return
    if (command.type === 'ack' && (!Number.isSafeInteger(command.chars) || command.chars <= 0)) return
    if (command.type === 'resize') command = { ...command, cols: dimension(command.cols, 1000), rows: dimension(command.rows, 500) }
    this.host?.postMessage(command)
  }

  private close(owner: WebContents, id: string, error: 'closed' | 'host' | 'directory' = 'closed'): void {
    const entry = this.terminals.get(id)
    if (!entry || entry.owner !== owner) return
    if (entry.closing) return
    entry.closing = true
    clearTimeout(entry.timer)
    entry.resolve({ error })
    if (!entry.sent) { entry.release?.(); this.terminals.delete(id); entry.resolveClosed(); return }
    this.host?.postMessage({ type: 'close', id } satisfies TerminalCommand)
  }

  private ensureHost(): UtilityProcess {
    if (this.host) return this.host
    const host = utilityProcess.fork(join(__dirname, 'terminal-host.mjs'), [], { serviceName: 'Pith Terminal', stdio: 'ignore' })
    this.host = host
    host.on('message', (event: TerminalHostEvent) => {
      const id = event.type === 'ready' ? event.terminal.id : event.id
      const entry = this.terminals.get(id)
      if (!entry) return
      if (event.type === 'ready') {
        clearTimeout(entry.timer)
        entry.pid = event.terminal.pid
        if (entry.closing) { host.postMessage({ type: 'close', id } satisfies TerminalCommand); return }
        entry.resolve({ terminal: event.terminal })
      } else {
        // Programmatic debug cleanup leaves a status page in the renderer.
        // Deliver exit even when main initiated the close; suppress late data.
        if ((!entry.closing || event.type === 'exit') && !entry.owner.isDestroyed()) entry.owner.send('terminal:event', event)
        if (event.type === 'exit' || (event.type === 'error' && event.error === 'spawn')) {
          clearTimeout(entry.timer)
          entry.resolve({ error: event.type === 'error' ? event.error : 'closed' })
          this.terminals.delete(id)
          entry.release?.()
          entry.resolveClosed()
        }
      }
    })
    host.once('exit', () => {
      if (this.host !== host) return
      this.host = null
      // The lost IPC channel cannot prove that shell children have exited.
      // Fence restores for this app lifetime; never infer safety from host exit.
      if ([...this.terminals.values()].some(entry => entry.sent)) this.coordinator?.markTerminalHostLost()
      for (const [id, entry] of this.terminals) {
        entry.release?.()
        clearTimeout(entry.timer)
        entry.resolve({ error: 'host' })
        entry.resolveClosed() // markTerminalHostLost above retains the restore fence
        if (!entry.owner.isDestroyed()) entry.owner.send('terminal:event', { type: 'error', id, error: 'host' })
      }
      this.terminals.clear()
    })
    return host
  }

  dispose(): Promise<void> {
    for (const [id, entry] of this.terminals) this.close(entry.owner, id)
    const host = this.host
    this.host = null
    if (!host) return Promise.resolve()
    // Give the host time to close its PTYs before Electron tears down utility
    // processes. Killing the host first can leave shell children orphaned.
    return new Promise((resolve) => {
      const timer = setTimeout(() => { host.kill(); resolve() }, 1000)
      host.once('exit', () => { clearTimeout(timer); for (const entry of this.terminals.values()) { entry.release?.(); entry.resolveClosed() }; this.terminals.clear(); resolve() })
      host.postMessage({ type: 'dispose' } satisfies TerminalCommand)
    })
  }
}
