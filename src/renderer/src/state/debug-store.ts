import type { DebugSessionDTO } from '../../../shared/types'

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
