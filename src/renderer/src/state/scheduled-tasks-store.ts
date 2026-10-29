/**
 * Scheduled tasks renderer store.
 *
 * A module-level singleton fed two ways: the sequence-free
 * `scheduled_tasks_update` push (authoritative, emitted after every store
 * transaction) and an on-demand `scheduled:snapshot` read. Write actions go
 * through the same IPC surface and then refresh, so a missed push never
 * leaves stale state on screen.
 *
 * The store also diffs consecutive snapshots for runs that just left an
 * active status — the completion cue and native notification fire from that
 * transition (never at boot: runs that finished while the app was closed
 * arrive in the FIRST snapshot with no previous state, so they stay silent).
 */
import { useSyncExternalStore } from 'react'
import type { ScheduledTask, ScheduledTaskRun, ScheduledTaskInput } from '../../../shared/scheduled-tasks'
import { isScheduledTaskRunActive } from '../../../shared/scheduled-tasks'
import type { ScheduledTasksSnapshotDTO } from '../../../shared/types'

let snapshot: ScheduledTasksSnapshotDTO | null = null
let loadError: string | null = null
let eventWired = false
let statusByRunId = new Map<string, ScheduledTaskRun['status']>()

const listeners = new Set<() => void>()
const transitionListeners = new Set<(runs: ScheduledTaskRun[]) => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

function applySnapshot(next: ScheduledTasksSnapshotDTO): void {
  const previous = statusByRunId
  const nextStatuses = new Map<string, ScheduledTaskRun['status']>()
  const transitioned: ScheduledTaskRun[] = []
  for (const run of next.runs) {
    nextStatuses.set(run.id, run.status)
    const before = previous.get(run.id)
    if (before !== undefined && before !== run.status && !isScheduledTaskRunActive(run) && isScheduledTaskRunActive({ status: before })) {
      transitioned.push(run)
    }
  }
  statusByRunId = nextStatuses
  snapshot = next
  loadError = null
  emit()
  if (transitioned.length) for (const listener of transitionListeners) listener(transitioned)
}

export async function refreshScheduledTasks(): Promise<void> {
  try {
    applySnapshot(await window.pi.scheduledSnapshot())
  } catch (error) {
    loadError = error instanceof Error ? error.message : String(error)
    emit()
  }
}

function wireEvents(): void {
  if (eventWired) return
  eventWired = true
  window.pi.onEvent((event) => {
    if (event.type === 'scheduled_tasks_update' && event.scheduledTasks) {
      applySnapshot(event.scheduledTasks as ScheduledTasksSnapshotDTO)
    }
  })
}

export function subscribeScheduledTasks(listener: () => void): () => void {
  wireEvents()
  listeners.add(listener)
  if (!snapshot && !loadError) void refreshScheduledTasks()
  return () => {
    listeners.delete(listener)
  }
}

export function getScheduledTasksSnapshot(): ScheduledTasksSnapshotDTO | null {
  return snapshot
}

export function getScheduledTasksError(): string | null {
  return loadError
}

/** Runs that transitioned to a terminal status in one snapshot application. */
export function subscribeScheduledTransitions(listener: (runs: ScheduledTaskRun[]) => void): () => void {
  transitionListeners.add(listener)
  return () => {
    transitionListeners.delete(listener)
  }
}

/** The status an error carries through the preload unwrap (409 = conflict). */
export function scheduledErrorStatus(error: unknown): number | null {
  const status = (error as { status?: unknown } | null)?.status
  return typeof status === 'number' ? status : null
}

/** Every write refreshes afterwards: the push is authoritative, and this is
 * the belt-and-suspenders path for a window that missed it. */
async function act(work: Promise<unknown>): Promise<void> {
  try {
    await work
  } finally {
    await refreshScheduledTasks()
  }
}

export const scheduledTaskActions = {
  create: (input: ScheduledTaskInput) => act(window.pi.scheduledCreate(input)),
  update: (id: string, patch: Record<string, unknown>, revision?: number) => act(window.pi.scheduledUpdate(id, patch, revision)),
  delete: (id: string, revision?: number) => act(window.pi.scheduledDelete(id, revision)),
  runNow: (id: string, revision?: number) => act(window.pi.scheduledRunNow(id, revision)),
  cancelRun: (runId: string) => act(window.pi.scheduledCancelRun(runId)),
  markRead: (runId: string) => act(window.pi.scheduledMarkRead(runId)),
  deleteRuns: (ids: string[]) => act(window.pi.scheduledDeleteRuns(ids))
}

export interface ScheduledTasksState {
  snapshot: ScheduledTasksSnapshotDTO | null
  error: string | null
  unreadCount: number
}

export function useScheduledTasks(): ScheduledTasksState {
  const current = useSyncExternalStore(subscribeScheduledTasks, getScheduledTasksSnapshot)
  const error = useSyncExternalStore(
    (listener) => subscribeScheduledTasks(listener),
    () => loadError
  )
  return { snapshot: current, error, unreadCount: current?.unreadCount ?? 0 }
}
