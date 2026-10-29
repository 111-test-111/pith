/** Immutable preview cache shared by visible bodies, look-ahead prefetch and
 * totals. Visible requests win; background work never queues an entire repo. */
import type { RewindPatchDTO, RewindStatsDTO } from '../../../shared/types'
export type RewindPatch = RewindPatchDTO
export interface RewindTotals { added: number; removed: number; binary: number }
type Job = { key?: string; priority: number; run: () => void; cancel: () => void }
export class RewindPatchCache {
  totals?: RewindTotals
  private stats = new Map<string, RewindStatsDTO>()
  private pendingStats = new Map<string, Promise<RewindStatsDTO>>()
  private values = new Map<string, RewindPatch>()
  private pending = new Map<string, Promise<RewindPatch>>()
  private needed = new Map<string, Set<() => boolean>>()
  private listeners = new Map<string, Set<() => void>>()
  private pinned = new Set<string>()
  private queue: Job[] = []
  private active = 0
  private chars = 0
  private disposed = false
  private disposal?: ReturnType<typeof setTimeout>
  retain(): () => void {
    clearTimeout(this.disposal)
    return () => { this.disposal = setTimeout(() => this.dispose(), 0) }
  }
  peek(key: string): RewindPatch | undefined { return this.values.get(key) }
  subscribe(key: string, listener: () => void): () => void {
    const set = this.listeners.get(key) ?? new Set()
    set.add(listener); this.listeners.set(key, set)
    return () => { set.delete(listener); if (!set.size) this.listeners.delete(key) }
  }
  pin(key: string): () => void { this.pinned.add(key); return () => { this.pinned.delete(key); this.trim() } }
  private notify(key: string): void { this.listeners.get(key)?.forEach(listener => listener()) }
  private trim(): void {
    while (this.chars > 4 * 1024 * 1024 || this.values.size > 64) {
      const key = [...this.values.keys()].find(key => !this.pinned.has(key))
      if (key === undefined) break
      this.chars -= this.values.get(key)!.patch.length; this.values.delete(key); this.notify(key)
    }
  }
  private schedule<T>(priority: number, fetch: () => Promise<T>, key?: string): Promise<T> {
    if (this.disposed) return Promise.reject({ code: 'cancelled' })
    const result = new Promise<T>((resolve, reject) => {
      this.queue.push({ key, priority, cancel: () => reject({ code: 'cancelled' }), run: () => {
        this.active++
        void Promise.resolve().then(fetch).then(resolve, reject).finally(() => { this.active--; this.drain() })
      } })
    })
    this.drain(); return result
  }
  private saveStats(key: string, value: RewindStatsDTO): void {
    this.stats.set(key, value)
    if (this.stats.size > 2000) this.stats.delete(this.stats.keys().next().value!)
  }
  readStats(key: string, fetch: () => Promise<RewindStatsDTO>): Promise<RewindStatsDTO> {
    const cached = this.stats.get(key)
    if (cached) return Promise.resolve(cached)
    const pending = this.pendingStats.get(key)
    if (pending) return pending
    const result = this.schedule(1, fetch).then(value => { this.saveStats(key, value); return value }).finally(() => this.pendingStats.delete(key))
    this.pendingStats.set(key, result); return result
  }
  async readStatsBatch(keys: string[], fetch: (indices: number[]) => Promise<RewindStatsDTO[]>): Promise<RewindStatsDTO[]> {
    const missing = keys.flatMap((key, index) => !this.stats.has(key) && !this.pendingStats.has(key) ? [index] : [])
    if (missing.length) {
      const batch = this.schedule(3, () => fetch(missing)).then(values => {
        if (values.length !== missing.length) throw { code: 'storage' }
        values.forEach((value, offset) => this.saveStats(keys[missing[offset]], value))
        return values
      })
      missing.forEach((index, offset) => {
        const key = keys[index]
        this.pendingStats.set(key, batch.then(values => values[offset]).finally(() => this.pendingStats.delete(key)))
      })
    }
    return Promise.all(keys.map(key => this.stats.get(key) ?? this.pendingStats.get(key)!))
  }
  read(key: string, fetch: () => Promise<RewindPatch>, prefetch = false, needed: () => boolean = () => true): Promise<RewindPatch> {
    const cached = this.values.get(key)
    if (cached) { this.values.delete(key); this.values.set(key, cached); return Promise.resolve(cached) }
    const readers = this.needed.get(key) ?? new Set()
    readers.add(needed); this.needed.set(key, readers)
    const pending = this.pending.get(key)
    if (pending) {
      const queued = this.queue.find(job => job.key === key)
      if (queued && !prefetch) queued.priority = 0
      return pending
    }
    const result = this.schedule(prefetch ? 2 : 0, () => {
      // Expand-all moves formerly visible headers below newly loaded bodies.
      // Check geometry at admission. A new visible reader can keep a queued
      // neighbor prefetch alive even after its original reader moves away.
      if (![...readers].some(reader => reader())) throw { code: 'cancelled' }
      return fetch()
    }, key).then(value => {
      if (!this.disposed) {
        this.values.set(key, value); this.chars += value.patch.length
        this.trim(); this.notify(key)
      }
      return value
    }).finally(() => { this.pending.delete(key); this.needed.delete(key) })
    this.pending.set(key, result); return result
  }
  dispose(): void { this.disposed = true; this.queue.splice(0).forEach(job => job.cancel()) }
  private drain(): void {
    this.queue.sort((a, b) => a.priority - b.priority)
    while (this.active < 3 && this.queue.length && !this.disposed) this.queue.shift()!.run()
  }
}
