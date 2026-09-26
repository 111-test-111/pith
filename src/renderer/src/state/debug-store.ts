import type { DebugBreakpointDTO, DebugSessionDTO } from '../../../shared/types'

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
  private sessions = new Map<string, DebugSessionDTO>()
  private listeners = new Set<() => void>()
  private off?: () => void
  private snapshot: { revision: number; sessions: DebugSessionDTO[] } = { revision: 0, sessions: [] }
  /** Watch expressions per chat session; renderer-local, evaluated at stops. */
  private watches = new Map<string, string[]>()
  /** Breakpoints per chat session, refreshed on demand by panes. */
  private breakpoints = new Map<string, DebugBreakpointDTO[]>()

  breakpointsFor(sessionPath: string | null, file?: string): DebugBreakpointDTO[] {
    if (!sessionPath) return NO_BREAKPOINTS
    const list = this.breakpoints.get(sessionPath) ?? NO_BREAKPOINTS
    return file ? list.filter((bp) => bp.file === file) : list
  }

  /** Pull the session's breakpoints; notifies only on a real change, so an
   * effect that refreshes on every revision cannot loop. */
  async refreshBreakpoints(sessionPath: string): Promise<void> {
    try {
      const list = await window.pi.debugAction({ sessionPath, action: 'breakpoints' }) as DebugBreakpointDTO[]
      const previous = this.breakpoints.get(sessionPath)
      if (previous && previous.length === list.length && previous.every((bp, index) => bp.file === list[index].file && bp.line === list[index].line && bp.verified === list[index].verified)) return
      this.breakpoints.set(sessionPath, list)
      this.notifyWatchChange()
    } catch { /* the session ended between render and fetch */ }
  }

  watchList(sessionPath: string | null): string[] {
    if (!sessionPath) return NO_WATCHES
    return this.watches.get(sessionPath) ?? NO_WATCHES
  }

  addWatch(sessionPath: string, expression: string): void {
    const trimmed = expression.trim()
    if (!trimmed) return
    const list = this.watches.get(sessionPath) ?? []
    if (list.includes(trimmed)) return
    this.watches.set(sessionPath, [...list, trimmed])
    this.notifyWatchChange()
  }

  removeWatch(sessionPath: string, expression: string): void {
    const list = this.watches.get(sessionPath)
    if (!list) return
    this.watches.set(sessionPath, list.filter((item) => item !== expression))
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
    this.snapshot = {
      revision: this.snapshot.revision + 1,
      sessions: [...this.sessions.values()].sort((a, b) => a.startedAt - b.startedAt)
    }
    for (const listener of this.listeners) listener()
  }

  /** Pull the authoritative list (covers events missed before the first
   * subscription, e.g. a renderer reload mid-session). */
  async refresh(sessionPath: string): Promise<void> {
    try {
      const list = await window.pi.debugList(sessionPath)
      for (const dto of list) this.upsert(dto)
    } catch { /* A closing window loses the bridge; the next mount retries. */ }
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
