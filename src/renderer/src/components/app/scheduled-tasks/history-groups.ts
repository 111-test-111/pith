import type { ScheduledTaskRun } from '../../../../../shared/scheduled-tasks'

export type RunSortOrder = 'newest' | 'oldest'

export interface RunDateGroup {
  key: string
  label: string
  runs: ScheduledTaskRun[]
}

/** Match the timestamp shown on each history row. Persisted ISO dates are
 * absolute instants; the list sorts before applying its visible-row limit. */
function runTime(run: ScheduledTaskRun): number {
  const time = Date.parse(run.startedAt ?? run.scheduledFor)
  return Number.isFinite(time) ? time : Date.parse(run.createdAt)
}

export function sortScheduledRuns(runs: readonly ScheduledTaskRun[], order: RunSortOrder): ScheduledTaskRun[] {
  const direction = order === 'newest' ? -1 : 1
  return [...runs].sort((a, b) =>
    direction * (runTime(a) - runTime(b) || Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id))
  )
}

/** Group by the viewer's local calendar day, consistent with the row dates. */
export function groupScheduledRunsByDate(runs: readonly ScheduledTaskRun[], locale: string): RunDateGroup[] {
  const label = new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'long', day: 'numeric' })
  const groups: RunDateGroup[] = []
  for (const run of runs) {
    const date = new Date(runTime(run))
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
    let group = groups[groups.length - 1]
    if (group?.key !== key) {
      group = { key, label: label.format(date), runs: [] }
      groups.push(group)
    }
    group.runs.push(run)
  }
  return groups
}
