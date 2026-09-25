/**
 * Scheduled-run session marker.
 *
 * Sessions CREATED by scheduled task runs carry a `pith_scheduled_task`
 * custom entry appended before the session's first prompt, so a bounded head
 * read always covers it — the same membership test the subagent run marker
 * (`pith_subagent_run`) provides. The sidebar and the session search index
 * hide these sessions; they are reachable only from the scheduled tasks view
 * (runs record their sessionId/sessionPath) through the read-only peek pane.
 *
 * `existing_session` targets are ordinary user sessions and are NEVER marked.
 */
import { closeSync, openSync, readSync } from 'node:fs'

export const SCHEDULED_TASK_ENTRY_TYPE = 'pith_scheduled_task'

export interface ScheduledTaskMarkerData {
  version: 1
  taskId: string
  runId: string
  taskName: string
}

const MARKER = `"customType":"${SCHEDULED_TASK_ENTRY_TYPE}"`
/** The marker is appended before the first prompt, so a bounded head read always covers it. */
const HEAD_BYTES = 128 * 1024

/** Cheap membership test for "this session file belongs to a scheduled run". */
export function isScheduledTaskSessionFile(path: string): boolean {
  let fd: number
  try {
    fd = openSync(path, 'r')
  } catch {
    return false
  }
  try {
    const buffer = Buffer.alloc(HEAD_BYTES)
    const read = readSync(fd, buffer, 0, HEAD_BYTES, 0)
    return buffer.subarray(0, read).includes(MARKER)
  } catch {
    return false
  } finally {
    closeSync(fd)
  }
}

/** Fold the marker out of already-parsed entries (live sessions, list index). */
export function hasScheduledTaskMarker(entries: readonly unknown[]): boolean {
  for (const entry of entries) {
    const e = entry as { type?: unknown; customType?: unknown }
    if (e?.type === 'custom' && e.customType === SCHEDULED_TASK_ENTRY_TYPE) return true
  }
  return false
}

/**
 * Restore the owning run from the LAST marker entry (a reopened session file
 * keeps its restrictions: the persisted marker is the only place they live).
 */
export function scheduledTaskRoleFromEntries(entries: readonly unknown[]): { taskId: string; runId: string } | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const e = entries[index] as { type?: unknown; customType?: unknown; data?: unknown }
    if (e?.type !== 'custom' || e.customType !== SCHEDULED_TASK_ENTRY_TYPE) continue
    const data = e.data as Partial<ScheduledTaskMarkerData> | undefined
    if (typeof data?.taskId === 'string' && typeof data?.runId === 'string') return { taskId: data.taskId, runId: data.runId }
  }
  return undefined
}
