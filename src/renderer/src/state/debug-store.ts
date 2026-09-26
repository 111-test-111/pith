import type { DebugBreakpointDTO, DebugSessionDTO, DebugSteppingGranularity } from '../../../shared/types'

/** Stable empty list: a missing session must not re-render subscribers. */
const NO_WATCHES: string[] = []
const NO_BREAKPOINTS: DebugBreakpointDTO[] = []

/**
 * Workspace-lifetime mirror of every debug session, fed by the main process's
 * `debug:event` broadcast. Only DTOs live here — stack frames, variables and
 * console output are pulled imperatively over `window.pi.debugAction` when the
 * panel actually shows them, mirroring how bash task logs are fetched.
 */
export class DebugStore {
  private selected = new Map<string, string>()
  private explicitSelection = new Set<string>()
  private sessions = new Map<string, DebugSessionDTO>()
  private listeners = new Set<() => void>()
  private off?: () => void
  private snapshot: { revision: number; sessions: DebugSessionDTO[] } = { revision: 0, sessions: [] }
  /** Watch expressions per debug target; renderer-local, evaluated at stops. */
  private stepping = new Map<string, DebugSteppingGranularity>()
  private watches = new Map<string, string[]>()
  /** Breakpoints per debug target, refreshed on demand by panes. */
  private breakpoints = new Map<string, DebugBreakpointDTO[]>()
  private refreshes = new Map<string, Promise<void>>()

  breakpointsFor(debugId: string | null, file?: string): DebugBreakpointDTO[] {
    if (!debugId) return NO_BREAKPOINTS
    const list = this.breakpoints.get(debugId) ?? NO_BREAKPOINTS
    return file ? list.filter((bp) => bp.file === file) : list
  }

  /** Pull the session's breakpoints; notifies only on a real change, so an
   * effect that refreshes on every revision cannot loop. */
  async refreshBreakpoints(sessionPath: string, debugId: string): Promise<void> {
    try {
      const list = await window.pi.debugAction({ sessionPath, debugId, action: 'breakpoints' }) as DebugBreakpointDTO[]
      const previous = this.breakpoints.get(debugId)
      if (JSON.stringify(previous) === JSON.stringify(list)) return
      this.breakpoints.set(debugId, list)
      this.notifyWatchChange()
    } catch { /* the session ended between render and fetch */ }
  }

  /** A human may inspect the visible chat's children; tool ownership stays in main. */
  forView(sessionPath: string | null, childPaths: readonly string[] = []): DebugSessionDTO[] {
    if (!sessionPath) return []
    const owners = new Set([sessionPath, ...childPaths])
    return this.snapshot.sessions.filter(session => owners.has(session.sessionPath))
  }

  selectedFor(sessionPath: string | null, childPaths: readonly string[] = []): DebugSessionDTO | undefined {
    if (!sessionPath) return undefined
    const sessions = this.forView(sessionPath, childPaths)
    return sessions.find(s => s.id === this.selected.get(sessionPath))
      ?? sessions.find(s => ['starting', 'running', 'stopped'].includes(s.status) && !sessions.some(child => child.parentId === s.id && ['starting', 'running', 'stopped'].includes(child.status))) ?? sessions.at(-1)
  }

  select(sessionPath: string, debugId: string, childPaths: readonly string[] = []): void {
    if (!this.forView(sessionPath, childPaths).some(s => s.id === debugId)) return
    this.selected.set(sessionPath, debugId)
    this.explicitSelection.add(sessionPath)
    this.notifyWatchChange()
  }

  /** Pin an automatic choice too, so a child's exit keeps its console visible. */
  retainSelection(sessionPath: string, childPaths: readonly string[]): void {
    const session = this.selectedFor(sessionPath, childPaths)
    if (!session || this.selected.get(sessionPath) === session.id) return
    this.selected.set(sessionPath, session.id)
    this.explicitSelection.delete(sessionPath)
    this.notifyWatchChange()
  }

  steppingFor(session: DebugSessionDTO): DebugSteppingGranularity {
    return this.stepping.get(session.id) ?? (session.capabilities?.supportsSteppingGranularity && session.location?.instructionPointerReference && !session.location.file ? 'instruction' : 'statement')
  }
  setStepping(debugId: string, granularity: DebugSteppingGranularity): void {
    this.stepping.set(debugId, granularity)
    this.notifyWatchChange()
  }

  watchList(debugId: string | null): string[] {
    if (!debugId) return NO_WATCHES
    return this.watches.get(debugId) ?? NO_WATCHES
  }

  addWatch(debugId: string, expression: string): void {
    const trimmed = expression.trim()
    if (!trimmed) return
    const list = this.watches.get(debugId) ?? []
    if (list.includes(trimmed)) return
    this.watches.set(debugId, [...list, trimmed])
    this.notifyWatchChange()
  }

  removeWatch(debugId: string, expression: string): void {
    const list = this.watches.get(debugId)
    if (!list) return
    this.watches.set(debugId, list.filter((item) => item !== expression))
    this.notifyWatchChange()
  }

  private notifyWatchChange(): void {
    this.snapshot = { revision: this.snapshot.revision + 1, sessions: this.snapshot.sessions }
    for (const listener of this.listeners) listener()
  }

  subscribe = (listener: () => void): (() => void) => {
    this.ensureBridge()
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getSnapshot = (): { revision: number; sessions: DebugSessionDTO[] } => this.snapshot

  private ensureBridge(): void {
    this.off ??= window.pi.onDebugEvent((dto) => this.upsert(dto))
  }

  private upsert(dto: DebugSessionDTO): void {
    const current = this.sessions.get(dto.id)
    if (current && current.revision >= dto.revision) return
    this.sessions.set(dto.id, dto)
    if (!current && dto.replacesId) {
      const previous = this.sessions.get(dto.replacesId)
      if (previous?.sessionPath === dto.sessionPath) {
        if (this.stepping.has(previous.id)) this.stepping.set(dto.id, this.stepping.get(previous.id)!)
        this.watches.set(dto.id, [...this.watchList(previous.id)])
        // The same target can be selected in its own chat and its parent's view.
        for (const [view, selected] of this.selected) {
          if (selected === previous.id) this.selected.set(view, dto.id)
        }
      }
    }
    for (const [view, selected] of this.selected) {
      if (!this.explicitSelection.has(view) && dto.parentId === selected && this.sessions.get(selected)?.sessionPath === dto.sessionPath) {
        this.selected.set(view, dto.id)
      }
    }
    const selected = this.selected.get(dto.sessionPath)
    if (!selected || !this.sessions.has(selected) || (!this.explicitSelection.has(dto.sessionPath) && dto.parentId === selected)) {
      this.selected.set(dto.sessionPath, dto.id)
    }
    const settled = [...this.sessions.values()].filter(s => s.status === 'terminated' || s.status === 'failed').sort((a, b) => b.startedAt - a.startedAt)
    for (const old of settled.slice(10)) {
      this.sessions.delete(old.id); this.breakpoints.delete(old.id); this.watches.delete(old.id); this.stepping.delete(old.id)
    }
    this.snapshot = {
      revision: this.snapshot.revision + 1,
      sessions: [...this.sessions.values()].sort((a, b) => a.startedAt - b.startedAt)
    }
    for (const listener of this.listeners) listener()
  }

  acceptRestart(dto: DebugSessionDTO): void { this.upsert(dto) }

  /** Pull the authoritative list (covers events missed before the first
   * subscription, e.g. a renderer reload mid-session). */
  refresh(sessionPath: string): Promise<void> {
    const pending = this.refreshes.get(sessionPath)
    if (pending) return pending
    const work = window.pi.debugList(sessionPath).then(list => {
      for (const dto of list) this.upsert(dto)
    }).catch(() => { /* A closing window loses the bridge; the next mount retries. */ })
      .finally(() => { this.refreshes.delete(sessionPath) })
    this.refreshes.set(sessionPath, work)
    return work
  }

  forSession(sessionPath: string | null): DebugSessionDTO[] {
    if (!sessionPath) return []
    return this.snapshot.sessions.filter((session) => session.sessionPath === sessionPath)
  }

  dispose(): void {
    this.off?.()
    this.off = undefined
    this.listeners.clear()
  }
}
