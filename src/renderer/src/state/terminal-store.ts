import type { TerminalErrorCode, TerminalEvent, TerminalInfoDTO } from '../../../shared/types'
import type { TerminalRuntime } from '@/lib/terminal-runtime'

export interface TerminalTab {
  id: string
  number: number
  title: string
  status: 'starting' | 'running' | 'exited' | 'error'
  info?: TerminalInfoDTO
  error?: TerminalErrorCode
  exitCode?: number
}
interface Session {
  runtime?: TerminalRuntime
  host?: HTMLElement
  titleTimer?: ReturnType<typeof setTimeout>
}

/** Workspace-owned emulators outlive pane switches and sidebar collapse. */
export class TerminalStore {
  private state: { tabs: TerminalTab[]; active: string | null } = { tabs: [], active: null }
  private sessions = new Map<string, Session>()
  private listeners = new Set<() => void>()
  private serial = 0
  private offEvent?: () => void
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
    // One bridge subscription for the whole workspace: Electron must not clone
    // every output batch once for every open terminal.
    this.offEvent ??= window.pi.onTerminalEvent((event: TerminalEvent) => {
      const runtime = this.sessions.get(event.id)?.runtime
      if (!runtime) return
      if (event.type === 'data') runtime.write(event.data)
      else {
        // An ended page only shows status. Release its screen, scrollback and
        // GPU resources immediately; revisiting it must not restore old output.
        const session = this.sessions.get(event.id)!
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
    if (this.sessions.size === 0) {
      this.offEvent?.()
      this.offEvent = undefined
    }
    clearTimeout(session.titleTimer)
    session.runtime?.dispose()
    window.pi.terminalClose(id)
    const index = this.state.tabs.findIndex((tab) => tab.id === id)
    const tabs = this.state.tabs.filter((tab) => tab.id !== id)
    this.state = { tabs, active: this.state.active === id ? (tabs[index - 1] ?? tabs[index])?.id ?? null : this.state.active }
    this.emit()
  }
  dispose = (): void => { for (const id of this.sessions.keys()) this.close(id) }
}
