import { existsSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { RewindFailure } from './types'

type Kind = 'run' | 'subagent' | 'tool' | 'process' | 'terminal'
interface Lease { root: string; kind: Kind; sessionPath?: string }
/** The live facts that refuse a restore of one checkout, as data rather than a
 * yes/no: `PiManager` turns them into the single named reason the rewind panel
 * shows, so the banner can tell an in-flight turn from a writing tool, an open
 * terminal or an unfinished recovery instead of listing all of them. */
export interface RestoreBlockers {
  /** An interactive terminal is open (any checkout), or the terminal host was
   * lost — a shell can cd, so both conservatively fence restores. */
  terminal: boolean
  /** An unfinished recovery owns this checkout until it is resolved. */
  recovery: boolean
  /** A snapshot or restore window is open on this checkout. */
  exclusive: boolean
  /** Plain model turns for this checkout, which end on their own. */
  runs: number
  /** Leases that can write the checkout: tool, process and subagent runs. */
  writers: number
  /** The app is shutting down. */
  closing: boolean
}
/** Canonical checkout identity, independent for linked worktrees. Never key by
 * common Git directory: each linked worktree has its own files and index. */
export function checkoutRoot(cwd: string): string {
  let root: string
  try { root = realpathSync(cwd) } catch { root = resolve(cwd) }
  let cursor = root
  while (true) {
    if (existsSync(join(cursor, '.git'))) { root = cursor; break }
    const parent = dirname(cursor); if (parent === cursor) break; cursor = parent
  }
  return process.platform === 'win32' ? root.toLowerCase() : root
}
/** One authority in main for admission and actual process lifetimes. Restores
 * fail closed instead of implicitly killing other sessions or shell processes.
 * A shell can cd, so open interactive terminals conservatively block restores. */
export class CheckoutCoordinator {
  private leases = new Set<Lease>()
  private exclusive = new Map<string, 'snapshot' | 'restore' | 'git'>()
  /** An owned process whose cleanup could not be proved fences this app lifetime. */
  private uncertain = new Set<string>()
  fence(cwd: string): void { this.uncertain.add(checkoutRoot(cwd)) }
  private closed = false
  private terminalHostLost = false
  markTerminalHostLost(): void { this.terminalHostLost = true }
  restoreError(): { code: 'terminal' } | undefined { return this.terminalHostLost ? { code: 'terminal' } : undefined }
  private recovery = new Map<string, string>()
  private readiness: Promise<void> = Promise.resolve()
  private initializationError: unknown
  initialize(operation: () => Promise<{ root: string; operationId: string }[]>): void {
    this.readiness = operation().then(markers => { for (const marker of markers) this.setRecovery(marker.root, marker.operationId) }, error => { this.initializationError = error })
  }
  async ready(): Promise<void> { await this.readiness; if (this.initializationError) throw this.initializationError }
  needsRecovery(cwd: string): boolean { return this.recovery.has(checkoutRoot(cwd)) }
  private waiters = new Set<() => void>()
  async enter(cwd: string, kind: Kind, sessionPath?: string, signal?: AbortSignal): Promise<() => void> {
    await this.ready()
    while (this.exclusive.get(checkoutRoot(cwd)) === 'snapshot' && !this.closed) {
      if (signal?.aborted) throw new RewindFailure('cancelled')
      await new Promise<void>((resolve, reject) => {
        const wake = () => { this.waiters.delete(wake); signal?.removeEventListener('abort', abort); resolve() }
        const abort = () => { this.waiters.delete(wake); reject(new RewindFailure('cancelled')) }
        this.waiters.add(wake); signal?.addEventListener('abort', abort, { once: true })
      })
    }
    if (signal?.aborted) throw new RewindFailure('cancelled')
    return this.acquire(cwd, kind, sessionPath)
  }
  acquire(cwd: string, kind: Kind, sessionPath?: string): () => void {
    const root = checkoutRoot(cwd)
    const operationId = this.recovery.get(root) ?? (kind === 'terminal' ? this.recovery.values().next().value : undefined)
    if (operationId) throw new RewindFailure('recovery', [], operationId)
    if (this.closed || this.uncertain.has(root) || this.exclusive.has(root) || (kind === 'terminal' && (this.uncertain.size > 0 || [...this.exclusive.values()].some(purpose => purpose !== 'snapshot')))) throw new RewindFailure('busy')
    const lease: Lease = { root, kind, sessionPath }; this.leases.add(lease)
    return () => { this.leases.delete(lease) }
  }
  /** `busy` and the named reason the UI shows read the same facts. */
  restoreBlockers(cwd: string): RestoreBlockers {
    const root = checkoutRoot(cwd)
    let runs = 0, writers = 0
    for (const lease of this.leases) {
      if (lease.root !== root) continue
      if (lease.kind === 'run') runs++
      else if (lease.kind === 'subagent' || lease.kind === 'tool' || lease.kind === 'process') writers++
    }
    return {
      terminal: this.terminalHostLost || [...this.leases].some(lease => lease.kind === 'terminal'),
      recovery: this.recovery.has(root),
      exclusive: this.exclusive.has(root) || this.uncertain.has(root),
      runs,
      writers,
      closing: this.closed
    }
  }
  busy(cwd: string, purpose: 'snapshot' | 'restore' = 'restore'): boolean {
    const blockers = this.restoreBlockers(cwd)
    // A snapshot waits only for work that can write the checkout; a restore is
    // stricter (any lease on this root, plus terminals anywhere).
    if (purpose === 'snapshot') return blockers.closing || blockers.recovery || blockers.exclusive || blockers.writers > 0
    return blockers.closing || blockers.recovery || blockers.exclusive || blockers.writers > 0 || blockers.terminal || blockers.runs > 0
  }
  /** Snapshots are fenced only by work that can write the checkout: an
   * executing tool, a managed process, or a whole subagent run. Another
   * session's in-flight model turn (a plain 'run' lease) must not starve
   * pre-turn capture — its tools queue behind the snapshot window instead. */
  async withExclusive<T>(cwd: string, purpose: 'snapshot' | 'restore' | 'git', operation: () => Promise<T>, recovering = false): Promise<T> {
    if (purpose !== 'snapshot' && this.terminalHostLost) throw new RewindFailure('terminal')
    const pending = this.recovery.get(checkoutRoot(cwd))
    if (pending && !recovering) throw new RewindFailure('recovery', [], pending)
    const blockers = this.restoreBlockers(cwd)
    const blocked = blockers.closing || blockers.exclusive || blockers.writers > 0 || (purpose !== 'snapshot' && (blockers.terminal || blockers.runs > 0))
    if (blocked) throw new RewindFailure('busy')
    const root = checkoutRoot(cwd); this.exclusive.set(root, purpose)
    try { return await operation() } finally { this.exclusive.delete(root); for (const wake of [...this.waiters]) wake() }
  }
  setRecovery(cwd: string, operationId?: string): void {
    if (operationId) this.recovery.set(checkoutRoot(cwd), operationId)
    else this.recovery.delete(checkoutRoot(cwd))
  }
  canStart(cwd: string): boolean { return !this.closed && !this.uncertain.has(checkoutRoot(cwd)) && !this.recovery.has(checkoutRoot(cwd)) && !this.exclusive.has(checkoutRoot(cwd)) }
  close(): void { this.closed = true; for (const wake of [...this.waiters]) wake() }
}
