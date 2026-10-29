import { memo, useEffect, useMemo, useState } from 'react'
import { Subagent } from '@/lib/icons'
import { Button } from '@/components/motion/button'
import { RunningLoader } from './RunningLoader'
import { PiStore } from '@/state/pi-store'
import { useI18n } from '@/i18n'
import { ChatView } from './ChatView'
import type { SubagentRunDTO } from '../../../../shared/types'

/**
 * A subagent child session in the right rail, read-only.
 *
 * Opening a delegation used to navigate the visible conversation to the child
 * and leave it there — the user lost their place in the parent chat for what is
 * usually a glance at "what did it actually do". The rail hosts it instead:
 * the transcript renders with the SAME components as the chat (folding,
 * spinner verbs, tool rows) but without a composer or the session-level
 * actions, and `main` never activates the child for this view (`peekSession`).
 *
 * Live enough on purpose: `main` withholds streaming DELTAS from a session the
 * user is not viewing, so this pane grows a row per committed message/tool
 * result and shows the waiting row while the child works. Progress numbers
 * (tokens, tool calls, status) come from the roster the workspace passes in.
 */
export const SubagentSessionPane = memo(function SubagentSessionPane({
  sessionPath,
  run,
  onOpenInChat
}: {
  sessionPath: string
  /** The roster row for this child, or null once its run left the roster. */
  run: SubagentRunDTO | null
  /** Escape hatch: the full read-only session view in the main chat. */
  onOpenInChat: (path: string) => void
}) {
  const { t } = useI18n()
  // The pane owns its store: the visible chat keeps its own, and neither view
  // can disturb the other's scroll or streaming state.
  const store = useMemo(() => new PiStore(), [])
  const [error, setError] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)

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
    // Committed events arrive for every managed session (only streaming deltas
    // are skipped for invisible ones), so the rows land as the child finishes
    // each message/tool call.
    const off = window.pi.onEvent((event) => {
      if (event.sessionPath === sessionPath) store.dispatch(event)
    })
    return () => {
      cancelled = true
      off()
    }
  }, [sessionPath, store])

  const meta = run
    ? [
        run.profile,
        run.model,
        t(`subagent.${run.status}`),
        ...(run.limitReached ? [t('subagent.turnLimit')] : []),
        ...(run.tokens !== undefined ? [t('subagent.tokens', { count: Math.round(run.tokens) })] : []),
        ...(run.toolUses !== undefined ? [t('subagent.toolUses', { count: run.toolUses })] : [])
      ].filter(Boolean).join(' · ')
    : ''

  return (
    <div className="flex h-full min-h-0 flex-col" data-subagent-pane={sessionPath}>
      <header className="flex shrink-0 items-start gap-2 border-b border-border px-3 py-2">
        <Subagent aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium text-foreground" title={run?.description}>
            {run?.description ?? t('subagent.sessionTab')}
          </p>
          <p className="truncate text-caption text-muted-foreground" title={meta}>
            {meta || t('subagent.paneReadOnly')}
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => onOpenInChat(sessionPath)}>
          {t('subagent.openInChat')}
        </Button>
      </header>

      {/* A flex COLUMN, not a plain block: `ChatView` renders the task strip
          and `MessageScroller` as siblings whose height comes from being flex
          items (`min-h-0 flex-1` + the scroller's inner `h-full` viewport). In
          a block wrapper the scroller's `flex-1` does nothing, its viewport
          resolves to `auto` and the transcript is clipped instead of scrolled. */}
      <div className="flex min-h-0 flex-1 flex-col">
        {error ? (
          <p className="px-3 py-4 text-xs text-destructive [overflow-wrap:anywhere]">
            {t('subagent.paneError')}
            {` · ${error}`}
          </p>
        ) : loaded ? (
          // No session-level actions: this view is read-only, and the buttons
          // that need them (resend/edit/fork/review) stay hidden rather than
          // rendering inert controls.
          <ChatView store={store} />
        ) : (
          <div className="flex h-full items-center justify-center">
            <RunningLoader variant="spinner" size={16} label={t('subagent.paneLoading')} className="text-primary" />
          </div>
        )}
      </div>
    </div>
  )
})
