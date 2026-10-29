import { memo, useEffect, useMemo, useState } from 'react'
import { CalendarCheck } from '@/lib/icons'
import { RunningLoader } from './RunningLoader'
import { PiStore } from '@/state/pi-store'
import { useScheduledTasks } from '@/state/scheduled-tasks-store'
import { useI18n } from '@/i18n'
import { ChatView } from './ChatView'

/**
 * A scheduled run's session in the right rail, read-only.
 *
 * Same hosting pattern as SubagentSessionPane: the pane owns its store, main
 * never activates the session for this view (`peekSession`), committed events
 * land row by row as they persist (streaming deltas stay with the live
 * surface), and no composer or session-level actions render. Scheduled
 * sessions never appear in the sidebar or session search — this pane and the
 * tasks view are the only way in.
 */
export const ScheduledSessionPane = memo(function ScheduledSessionPane({
  sessionPath
}: {
  sessionPath: string
}) {
  const { t } = useI18n()
  const store = useMemo(() => new PiStore(), [])
  const [error, setError] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const { snapshot } = useScheduledTasks()
  // The header names the run's task; runs carry both sessionPath and taskName.
  const taskName = useMemo(
    () => snapshot?.runs.find((run) => run.sessionPath === sessionPath)?.taskName ?? null,
    [snapshot, sessionPath]
  )

  useEffect(() => {
    let cancelled = false
    setLoaded(false)
    setError(null)
    void window.pi.peekSession(sessionPath).then(
      (snapshot) => {
        if (cancelled) return
        store.applySnapshot(snapshot)
        setLoaded(true)
      },
      (cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause))
      }
    )
    const off = window.pi.onEvent((event) => {
      if (event.sessionPath === sessionPath) store.dispatch(event)
    })
    return () => {
      cancelled = true
      off()
    }
  }, [sessionPath, store])

  return (
    <div className="flex h-full min-h-0 flex-col" data-scheduled-pane={sessionPath}>
      <header className="flex shrink-0 items-start gap-2 border-b border-border px-3 py-2">
        <CalendarCheck aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium text-foreground" title={taskName ?? undefined}>
            {taskName ?? t('scheduledTasks.pane.title')}
          </p>
          <p className="truncate text-caption text-muted-foreground">{t('scheduledTasks.pane.readOnly')}</p>
        </div>
      </header>

      {/* ChatView sizes its strip and scroller as flex items — keep this a
          flex COLUMN, not a block (see SubagentSessionPane). */}
      <div className="flex min-h-0 flex-1 flex-col">
        {error ? (
          <p className="px-3 py-4 text-xs text-destructive [overflow-wrap:anywhere]">
            {t('scheduledTasks.pane.error')}
            {` · ${error}`}
          </p>
        ) : loaded ? (
          <ChatView store={store} />
        ) : (
          <div className="flex h-full items-center justify-center">
            <RunningLoader variant="spinner" size={16} label={t('scheduledTasks.pane.loading')} className="text-primary" />
          </div>
        )}
      </div>
    </div>
  )
})
