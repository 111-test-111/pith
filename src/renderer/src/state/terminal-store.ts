import type { TerminalErrorCode, TerminalEvent, TerminalInfoDTO } from '../../../shared/types'
import type { TerminalRuntime } from '@/lib/terminal-runtime'
import type { SshEvent, SshSessionDTO } from '../../../shared/ssh'

export interface TerminalTab {
  id: string
  number: number
  title: string
  status: 'starting' | 'running' | 'exited' | 'error'
  info?: TerminalInfoDTO
  error?: TerminalErrorCode
  exitCode?: number
  ssh?: SshSessionDTO
}
interface Session {
  runtime?: TerminalRuntime
  host?: HTMLElement
  offEvent?: () => void
  titleTimer?: ReturnType<typeof setTimeout>
  ssh?: SshSessionDTO
  cursor?: number
  hydrating?: boolean
  pending?: Extract<SshEvent, { type: 'data' }>[]
}

const localTerminalListeners = new Map<string, (event: TerminalEvent) => void>()
let offLocalTerminals: (() => void) | undefined

function subscribeLocalTerminal(id: string, listener: (event: TerminalEvent) => void): () => void {
  localTerminalListeners.set(id, listener)
  offLocalTerminals ??= window.pi.onTerminalEvent(event => localTerminalListeners.get(event.id)?.(event))
  return () => {
    localTerminalListeners.delete(id)
    if (localTerminalListeners.size > 0) return
    offLocalTerminals?.()
    offLocalTerminals = undefined
  }
}

/** One SSH bridge subscription routes metadata and each acknowledged batch to
 * the session that owns the connection. */
export function watchSshTerminals(
  resolve: (sessionPath: string) => TerminalStore | undefined,
  onOpen: (sessionPath: string) => void
): () => void {
  if (!window.pi.onSshEvent || !window.pi.listSshSessions) return () => {}
  let watching = true
  const state = (dto: SshSessionDTO): void => {
    if (resolve(dto.sessionPath)?.applySshState(dto)) onOpen(dto.sessionPath)
  }
  const off = window.pi.onSshEvent(event => {
    if (event.type === 'state') state(event.session)
    else if (!resolve(event.sessionPath)?.applySshData(event)) window.pi.sshAck(event.id, event.data.length)
  })
  void window.pi.listSshSessions().then(list => { if (watching) for (const dto of list) state(dto) }).catch(() => {})
  return () => { watching = false; off() }
}

/** Conversation-owned emulators outlive pane switches and sidebar collapse. */
export class TerminalStore {
  private state: { tabs: TerminalTab[]; active: string | null } = { tabs: [], active: null }
  private sessions = new Map<string, Session>()
  private listeners = new Set<() => void>()
  private serial = 0
  private closingSsh = new Set<string>()
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  getSnapshot = () => this.state
  private emit(): void { for (const listener of this.listeners) listener() }
  private patch(id: string, patch: Partial<TerminalTab>): void {
    if (!this.sessions.has(id)) return
    this.state = { ...this.state, tabs: this.state.tabs.map((tab) => tab.id === id ? { ...tab, ...patch } : tab) }
    this.emit()
  }
  select = (id: string): void => {
    if (!this.sessions.has(id)) return
    this.state = { ...this.state, active: id }
    this.emit()
  }

  /** SSH emulators share the terminal pane, with remote ownership in main. */
  applySshState(dto: SshSessionDTO): boolean {
    const id = `ssh:${dto.id}`
    if (this.closingSsh.has(id)) {
      if (dto.status === 'closed') this.closingSsh.delete(id)
      return false
    }
    const session = this.sessions.get(id)
    if (!session) {
      if (dto.status === 'closed') return false
      this.addSsh(id, dto)
      return true
    }
    if (session.ssh && dto.revision <= session.ssh.revision) return false
    const wasConnected = session.ssh?.status === 'connected'
    session.ssh = dto
    this.patch(id, { ssh: dto, status: dto.status === 'closed' ? 'exited' : 'running' })
    if (!wasConnected && dto.status === 'connected' && !dto.readOnly && session.runtime) {
      const { cols, rows } = session.runtime.terminal
      void window.pi.sshPanelAction({ action: 'resize', sessionPath: dto.sessionPath, id: dto.id,
        cols: Math.min(240, cols), rows: Math.min(100, rows) })
    }
    if (dto.status === 'closed') {
      this.disposeSshRuntime(session)
      session.host = undefined
    }
    return false
  }
  private addSsh(id: string, dto: SshSessionDTO): void {
    const session: Session = { ssh: dto, cursor: 0, hydrating: true, pending: [] }
    this.sessions.set(id, session)
    this.state = { ...this.state, active: id, tabs: [...this.state.tabs, {
      id, number: ++this.serial, title: `SSH · ${dto.username}@${dto.host}`, status: 'running', ssh: dto
    }] }
    this.emit()
    void import('@/lib/terminal-runtime').then(({ TerminalRuntime }) => {
      if (this.sessions.get(id) !== session || session.ssh?.status === 'closed') return
      session.runtime = new TerminalRuntime(id, () => {}, {
        // Observation-only: main already responds to remote protocol queries.
        input: () => {}, ack: chars => window.pi.sshAck(dto.id, chars),
        resize: (cols, rows) => {
          if (!session.ssh?.readOnly && session.ssh?.status === 'connected') void window.pi.sshPanelAction({
            action: 'resize', sessionPath: dto.sessionPath, id: dto.id, cols: Math.min(240, cols), rows: Math.min(100, rows)
          })
        }
      })
      session.runtime.stop()
      if (session.host) session.runtime.attach(session.host)
      void this.hydrateSsh(id, session)
    }).catch(() => this.patch(id, { status: 'error', error: 'host' }))
  }
  applySshData(event: Extract<SshEvent, { type: 'data' }>): boolean {
    const id = `ssh:${event.id}`, session = this.sessions.get(id)
    if (!session?.ssh || session.ssh.status === 'closed') return false
    if (!session.runtime || session.hydrating) {
      const pending = session.pending ??= []
      pending.push(event)
      while (pending.reduce((sum, item) => sum + item.data.length, 0) > 65_536) {
        const dropped = pending.shift()!
        window.pi.sshAck(dropped.id, dropped.data.length)
      }
    } else this.sshData(id, session, event)
    return true
  }
  private disposeSshRuntime(session: Session): void {
    for (const event of session.pending ?? []) window.pi.sshAck(event.id, event.data.length)
    session.pending = []
    session.runtime?.dispose()
    session.runtime = undefined
  }
  private sshData(id: string, session: Session, event: Extract<SshEvent, { type: 'data' }>): void {
    const cursor = session.cursor ?? 0
    if (event.cursor <= cursor) { window.pi.sshAck(event.id, event.data.length); return }
    if (event.startCursor > cursor) {
      session.pending = [event]; void this.hydrateSsh(id, session); return
    }
    session.runtime?.write(event.data.slice(Math.max(0, cursor - event.startCursor)))
    if (cursor > event.startCursor) window.pi.sshAck(event.id, Math.min(event.data.length, cursor - event.startCursor))
    session.cursor = event.cursor
  }
  private async hydrateSsh(id: string, session: Session): Promise<void> {
    const dto = session.ssh
    if (!dto || !session.runtime) return
    session.hydrating = true
    try {
      const page = await window.pi.sshOutput({ sessionPath: dto.sessionPath, id: dto.id, maxChars: 65_536, snapshot: true })
      if (this.sessions.get(id) !== session || !session.runtime) return
      if (!page.snapshot) throw new Error('SSH terminal snapshot unavailable')
      const runtime = session.runtime
      await runtime.restore(page.snapshot)
      if (this.sessions.get(id) !== session || session.runtime !== runtime) return
      session.cursor = page.snapshot.cursor
      session.hydrating = false
      const pending = session.pending ?? []; session.pending = []
      for (const event of pending) {
        // A later gap can begin another hydration while this backlog drains.
        // Keep its subsequent deltas queued until that new replay completes.
        if (session.hydrating) (session.pending ??= []).push(event)
        else this.sshData(id, session, event)
      }
      this.emit()
    } catch { session.hydrating = false }
  }
  reconnectSsh = (id: string): void => {
    const dto = this.sessions.get(id)?.ssh
    if (dto && !dto.readOnly) void window.pi.sshPanelAction({ action: 'reconnect', sessionPath: dto.sessionPath, id: dto.id })
  }

  create(cwd: string | null): void {
    void this.spawn(cwd)
  }

  /** DAP runInTerminal: spawn a tab for the debuggee and resolve with its PTY
   * pid once the shell is up. The command is typed by the caller afterwards. */
  spawnForDebug(cwd: string | null, title: string): Promise<{ id: string; pid: number } | { error: TerminalErrorCode }> {
    return this.spawn(cwd, title)
  }

  /** The shared spawn path: `create` fires and forgets, debug awaits the pid.
   * Never rejects — the tab's own status already carries every failure. */
  private spawn(cwd: string | null, title = ''): Promise<{ id: string; pid: number } | { error: TerminalErrorCode }> {
    const id = crypto.randomUUID()
    const session: Session = {}
    this.sessions.set(id, session)
    session.offEvent = subscribeLocalTerminal(id, event => {
      const runtime = session.runtime
      if (!runtime) return
      if (event.type === 'data') runtime.write(event.data)
      else {
        // An ended page only shows status. Release its screen, scrollback and
        // GPU resources immediately; revisiting it must not restore old output.
        session.offEvent?.()
        session.offEvent = undefined
        session.host = undefined
        session.runtime = undefined
        clearTimeout(session.titleTimer)
        runtime.dispose()
        this.patch(event.id, event.type === 'exit'
          ? { status: 'exited', exitCode: event.exitCode }
          : { status: 'error', error: event.error })
      }
    })
    this.state = { active: id, tabs: [...this.state.tabs, { id, number: ++this.serial, title, status: 'starting' }] }
    this.emit()
    // Subscribe before spawning so the login prompt cannot race the invoke reply.
    return import('@/lib/terminal-runtime').then(async ({ TerminalRuntime }) => {
      if (this.sessions.get(id) !== session) return { error: 'closed' as const }
      const runtime = new TerminalRuntime(id, (title) => {
        clearTimeout(session.titleTimer)
        session.titleTimer = setTimeout(() => this.patch(id, { title: title.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 120) }), 100)
      })
      session.runtime = runtime
      if (session.host) { runtime.attach(session.host); runtime.focus() }
      const result = await window.pi.terminalCreate({ id, cwd, cols: runtime.terminal.cols, rows: runtime.terminal.rows })
      if (this.sessions.get(id) !== session) { window.pi.terminalClose(id); return { error: 'closed' as const } }
      if ('error' in result) {
        session.runtime?.stop()
        if (this.state.tabs.find((tab) => tab.id === id)?.status === 'starting') this.patch(id, { status: 'error', error: result.error })
        return { error: result.error }
      }
      const status = this.state.tabs.find((tab) => tab.id === id)?.status
      this.patch(id, { info: result.terminal, ...(status === 'starting' ? { status: 'running' as const } : {}) })
      if (session.runtime === runtime) window.pi.terminalResize(id, runtime.terminal.cols, runtime.terminal.rows)
      return { id, pid: result.terminal.pid }
    }).catch(() => {
      if (this.sessions.get(id) !== session) return { error: 'closed' as const }
      session.runtime?.stop()
      window.pi.terminalClose(id)
      this.patch(id, { status: 'error', error: 'host' })
      return { error: 'host' as const }
    })
  }

  /** Context-menu plumbing for the active pane. Everything routes through the
   * emulator (and therefore `terminal:*` IPC for paste), never React state. */
  hasSelection(id: string): boolean { return Boolean(this.sessions.get(id)?.runtime?.terminal.hasSelection()) }
  selection(id: string): string { return this.sessions.get(id)?.runtime?.terminal.getSelection() ?? '' }
  paste(id: string, text: string): void { this.sessions.get(id)?.runtime?.terminal.paste(text) }
  clear(id: string): void { this.sessions.get(id)?.runtime?.terminal.clear() }
  selectAll(id: string): void { this.sessions.get(id)?.runtime?.terminal.selectAll() }
  focus(id: string): void { this.sessions.get(id)?.runtime?.focus() }

  attach(id: string, host: HTMLElement, promptLabel: string, tooMuchOutput: string): () => void {
    const session = this.sessions.get(id)
    if (!session) return () => {}
    session.host = host
    const attach = (): void => {
      session.runtime?.labels(promptLabel, tooMuchOutput)
      session.runtime?.attach(host)
      session.runtime?.focus()
    }
    attach()
    const off = this.subscribe(() => {
      if (this.sessions.get(id) !== session || session.host !== host) return
      if (session.runtime && session.runtime.element.parentElement !== host) attach()
      else session.runtime?.labels(promptLabel, tooMuchOutput)
    })
    return () => {
      off()
      if (session.host === host) {
        session.host = undefined
        session.runtime?.detach()
      }
    }
  }

  close = (id: string): void => {
    const session = this.sessions.get(id)
    if (!session) return
    this.sessions.delete(id)
    session.host = undefined
    session.offEvent?.()
    clearTimeout(session.titleTimer)
    if (session.ssh) {
      this.disposeSshRuntime(session)
      this.closingSsh.add(id)
      if (!session.ssh.readOnly && session.ssh.status !== 'closed') void window.pi.sshPanelAction({ action: 'close', sessionPath: session.ssh.sessionPath, id: session.ssh.id, terminateRemote: true })
    } else {
      session.runtime?.dispose()
      window.pi.terminalClose(id)
    }
    const index = this.state.tabs.findIndex((tab) => tab.id === id)
    const tabs = this.state.tabs.filter((tab) => tab.id !== id)
    this.state = { tabs, active: this.state.active === id ? (tabs[index - 1] ?? tabs[index])?.id ?? null : this.state.active }
    this.emit()
  }
  dispose = (closeSsh = false): void => {
    for (const [id, session] of this.sessions) {
      if (session.ssh && !closeSsh) {
        this.disposeSshRuntime(session)
        this.sessions.delete(id)
      } else this.close(id)
    }
    this.state = { tabs: [], active: null }; this.emit()
  }
}
