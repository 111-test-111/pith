import { existsSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { RewindFailure } from './types'

type Kind = 'run' | 'subagent' | 'tool' | 'process' | 'terminal'
interface Lease { root: string; kind: Kind; sessionPath?: string }
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
  private exclusive = new Map<string, 'snapshot' | 'restore'>()
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
    if (this.closed || this.exclusive.has(root) || (kind === 'terminal' && [...this.exclusive.values()].includes('restore'))) throw new RewindFailure('busy')
    const lease: Lease = { root, kind, sessionPath }; this.leases.add(lease)
    return () => { this.leases.delete(lease) }
  }
  busy(cwd: string, purpose: 'snapshot' | 'restore' = 'restore'): boolean {
    const root = checkoutRoot(cwd)
    return (purpose === 'restore' && this.terminalHostLost) || this.closed || this.recovery.has(root) || this.exclusive.has(root) || [...this.leases].some(lease =>
      purpose === 'restore' ? lease.kind === 'terminal' || lease.root === root : lease.root === root && (lease.kind === 'subagent' || lease.kind === 'tool' || lease.kind === 'process'))
  }
  /** Snapshots are fenced only by work that can write the checkout: an
   * executing tool, a managed process, or a whole subagent run. Another
   * session's in-flight model turn (a plain 'run' lease) must not starve
   * pre-turn capture — its tools queue behind the snapshot window instead. */
  async withExclusive<T>(cwd: string, purpose: 'snapshot' | 'restore', operation: () => Promise<T>, recovering = false): Promise<T> {
    if (purpose === 'restore' && this.terminalHostLost) throw new RewindFailure('terminal')
    const pending = this.recovery.get(checkoutRoot(cwd))
    if (pending && !recovering) throw new RewindFailure('recovery', [], pending)
    const blocked = this.closed || this.exclusive.has(checkoutRoot(cwd)) || [...this.leases].some(lease =>
      purpose === 'restore' ? lease.kind === 'terminal' || lease.root === checkoutRoot(cwd) : lease.root === checkoutRoot(cwd) && (lease.kind === 'subagent' || lease.kind === 'tool' || lease.kind === 'process'))
    if (blocked) throw new RewindFailure('busy')
    const root = checkoutRoot(cwd); this.exclusive.set(root, purpose)
    try { return await operation() } finally { this.exclusive.delete(root); for (const wake of [...this.waiters]) wake() }
  }
  setRecovery(cwd: string, operationId?: string): void {
    if (operationId) this.recovery.set(checkoutRoot(cwd), operationId)
    else this.recovery.delete(checkoutRoot(cwd))
  }
  canStart(cwd: string): boolean { return !this.closed && !this.recovery.has(checkoutRoot(cwd)) && !this.exclusive.has(checkoutRoot(cwd)) }
  close(): void { this.closed = true; for (const wake of [...this.waiters]) wake() }
}
