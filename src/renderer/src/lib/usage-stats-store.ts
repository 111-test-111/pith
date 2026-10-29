import { useEffect, useSyncExternalStore } from 'react'
import type { UsageStatsDTO } from '../../../shared/types'

/**
 * Client-side shared cache for `pi:usageStats` (module memory, SWR
 * semantics), ported from pi-web's lib/usage-store.ts. Both Usage panels in
 * Settings → Usage read the same snapshot: a fresh cache draws the first
 * frame with zero IPC, a stale one keeps showing old data while it
 * revalidates in the background, and the very first load reports `loading`.
 *
 * The TTL matches the main-process cache (60s), so an unchanged session set
 * never triggers a second aggregation pass.
 */

export interface UsageStatsSnapshot {
  stats: UsageStatsDTO | null
  error: string | null
  /** True only while the very first load has nothing cached to show yet. */
  loading: boolean
}

const STALE_TTL_MS = 60_000

let snapshot: UsageStatsSnapshot = { stats: null, error: null, loading: false }
let fetchedAt = 0
let inflight: Promise<void> | null = null
const listeners = new Set<() => void>()

function setSnapshot(next: UsageStatsSnapshot): void {
  snapshot = next
  for (const listener of listeners) listener()
}

function fetchStats(): Promise<void> {
  if (inflight) return inflight
  inflight = window.pi
    .usageStats()
    .then((stats) => {
      fetchedAt = Date.now()
      setSnapshot({ stats, error: null, loading: false })
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      // A failed revalidate keeps the old data on screen; the error is only
      // visible when there is nothing to show.
      setSnapshot({ ...snapshot, error: snapshot.stats ? null : message, loading: false })
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}

export function getUsageStatsSnapshot(): UsageStatsSnapshot {
  return snapshot
}

export function subscribeUsageStats(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * Mount entry: a fresh cache is used as-is (zero IPC); a stale cache
 * revalidates in the background (old data stays visible); an empty cache
 * triggers the first load (entering `loading`). Concurrent calls share the
 * in-flight request.
 */
export function loadUsageStats(): void {
  if (inflight) return
  if (snapshot.stats && Date.now() - fetchedAt < STALE_TTL_MS) return
  if (!snapshot.stats && !snapshot.loading) setSnapshot({ ...snapshot, loading: true })
  void fetchStats()
}

export function useUsageStats(): UsageStatsSnapshot {
  useEffect(() => {
    loadUsageStats()
  }, [])
  return useSyncExternalStore(subscribeUsageStats, getUsageStatsSnapshot, getUsageStatsSnapshot)
}
