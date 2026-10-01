import { memo, useEffect, useRef, useState } from 'react'
import { ToolResult } from '@/components/agents/tool-result'
import { Button } from '@/components/motion/button'
import { FileDiff, Subagent, MessageSquareText } from '@/lib/icons'
import { formatTime } from '@/lib/format'
import { useI18n } from '@/i18n'
import { useCappedListFade } from '@/lib/hooks/use-capped-list-fade'
import { SubagentActionDialog, type SubagentActionTarget, type SubagentHumanAction } from './SubagentActionDialog'
import { SUBAGENT_READ_ONLY_TOOLS, type SubagentMessageDetails, type SubagentRunDTO } from '../../../../shared/types'

/**
 * The in-turn completion row for a background subagent, mirroring how a
 * finished background bash command reads: a quiet tool row attached to the
 * running turn (a notice), never a conversation card — the parent model
 * consumed the same payload as steering data.
 */
export const SubagentCompletionRow = memo(function SubagentCompletionRow({ run }: { run: SubagentRunDTO }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const status = run.status === 'completed' ? 'success' : run.status === 'failed' ? 'error' : 'cancelled'
  return (
    // A PROCESS row for compact tool-call display (`lib/compact-tools`): the notice
    // is a tool row, so it takes the transcript's tightened gap beside the rows
    // around it.
    <div data-row="process" data-subagent-completion={run.runId} data-subagent-status={run.status}>
      <ToolResult animateChanges={false} lazyContent open={open} onOpenChange={setOpen}
        title={t('subagent.completedTitle', { description: run.description })}
        status={status}
        icon={<Subagent aria-hidden="true" className="size-4" />}
        meta={[run.profile, run.model, ...(run.runInBackground ? [t('subagent.background')] : []), ...(run.status === 'interrupted' ? [t('subagent.interrupted')] : []), ...(run.limitReached ? [t('subagent.turnLimit')] : []), ...(run.writtenFiles?.length ? [t('subagent.filesCount', { count: run.writtenFiles.length })] : [])].filter(Boolean).join(' · ')}
        collapseOnComplete={false}>
        {open ? (
          <div className="space-y-2">
            {run.error ? <p className="whitespace-pre-wrap break-words text-xs text-destructive">{run.error}</p> : null}
            {run.writtenFiles?.length ? (
              <div className="space-y-1 text-xs">
                {run.writtenFiles.map((file) => (
                  <div key={file.filePath} className="flex items-center gap-1.5 text-muted-foreground">
                    <FileDiff aria-hidden="true" className="size-3.5 shrink-0" />
                    <span className="truncate" title={file.filePath}>{file.displayPath}</span>
                    {file.added !== undefined || file.removed !== undefined ? (
                      <span className="ml-auto shrink-0 tabular-nums">
                        <span className="text-emerald-600 dark:text-emerald-400">+{file.added ?? 0}</span>{' '}
                        <span className="text-rose-600 dark:text-rose-400">-{file.removed ?? 0}</span>
                      </span>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : null}
            {run.result ? <p className="whitespace-pre-wrap break-words text-xs">{run.result}</p> : null}
          </div>
        ) : null}
      </ToolResult>
    </div>
  )
})

/** Normalize persisted `subagent_message` details (they cross the wire as
 * plain records): anything without the marker kind or a message body is not
 * one of ours, so the row never guesses at a half-shaped payload. */
export function subagentMessageDetailsOf(details: unknown): SubagentMessageDetails | null {
  if (!details || typeof details !== 'object') return null
  const record = details as Record<string, unknown>
  if (record.kind !== 'pi-app-subagent-message') return null
  const sessionId = typeof record.sessionId === 'string' ? record.sessionId : ''
  const message = typeof record.message === 'string' ? record.message : ''
  if (!sessionId || !message) return null
  return {
    kind: 'pi-app-subagent-message',
    sessionId,
    ...(typeof record.runId === 'string' && record.runId ? { runId: record.runId } : {}),
    description: typeof record.description === 'string' && record.description ? record.description : 'Subagent',
    profile: typeof record.profile === 'string' && record.profile ? record.profile : 'subagent',
    message,
    sentAt: typeof record.sentAt === 'string' && record.sentAt ? record.sentAt : new Date(0).toISOString()
  }
}

/** A running subagent's message to its parent, mirroring the completion
 * notice: a quiet tool row attached to the running turn — never a
 * conversation card (the parent model consumed the same payload as steering
 * data). */
export const SubagentMessageRow = memo(function SubagentMessageRow({ details }: { details: SubagentMessageDetails }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const sentAt = Date.parse(details.sentAt)
  return (
    // A PROCESS row like the completion notice above: see `lib/compact-tools`.
    <div data-row="process" data-subagent-message={details.sessionId} data-subagent-message-sent={details.sentAt}>
      <ToolResult animateChanges={false} lazyContent open={open} onOpenChange={setOpen}
        title={t('subagent.messageTitle', { description: details.description })}
        status="success"
        icon={<MessageSquareText aria-hidden="true" className="size-4" />}
        meta={[
          details.profile,
          ...(Number.isFinite(sentAt) ? [formatTime(sentAt)] : [])
        ].filter(Boolean).join(' · ')}
        collapseOnComplete={false}>
        {open ? (
          <p className="whitespace-pre-wrap break-words text-xs">{details.message}</p>
        ) : null}
      </ToolResult>
    </div>
  )
})

/** Elapsed seconds while a run is live; frozen at its completion time. */
function elapsedOf(run: SubagentRunDTO, now: number): number {
  const end = run.completedAt ? Date.parse(run.completedAt) : now
  const start = Date.parse(run.createdAt)
  return Math.max(0, (end - (Number.isFinite(start) ? start : end)) / 1000)
}

function formatElapsed(seconds: number, t: ReturnType<typeof useI18n>['t']): string {
  if (seconds < 60) return t('subagent.elapsedSeconds', { seconds: seconds.toFixed(0) })
  if (seconds < 3600) return t('subagent.elapsedMinutes', { minutes: Math.floor(seconds / 60), seconds: Math.floor(seconds % 60) })
  return t('subagent.elapsedHours', { hours: Math.floor(seconds / 3600), minutes: Math.floor((seconds % 3600) / 60) })
}

function SubagentRow({ run, sessionPath, onOpenSession, onAction }: {
  run: SubagentRunDTO
  sessionPath: string
  onOpenSession?: (path: string) => void
  onAction: (run: SubagentRunDTO, action: SubagentHumanAction, trigger: HTMLButtonElement) => void
}) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [error, setError] = useState(false)
  const live = run.status === 'running'
  const humanAction: SubagentHumanAction = live ? 'steer' : 'resume'
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!live) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [live])

  const stop = async () => {
    setStopping(true)
    try {
      await window.pi.subagentAction({ sessionPath, sessionId: run.sessionId, expectedRunId: run.runId, action: 'abort' })
    } catch {
      setError(true)
    } finally {
      setStopping(false)
    }
  }

  // The frozen ceiling tells the card whether this run could write at all —
  // the difference between a research delegation and an implementation one.
  const readOnly = Boolean(run.tools?.length) && run.tools!.every((tool) => SUBAGENT_READ_ONLY_TOOLS.includes(tool))
  const meta = [
    run.profile,
    run.model,
    ...(readOnly ? [t('subagent.readOnlyTag')] : []),
    ...(run.runInBackground ? [t('subagent.background')] : []),
    // `interrupted` has no equivalent in the vendored status vocabulary (it
    // renders as "Cancelled"), so it keeps an explicit localized label; the
    // other statuses come from the row's own glyph/word and must not be
    // repeated here — `CompletedCompleted` was exactly that duplication.
    ...(run.status === 'interrupted' ? [t('subagent.interrupted')] : []),
    ...(run.limitReached ? [t('subagent.turnLimit')] : []),
    formatElapsed(elapsedOf(run, now), t),
    ...(run.tokens !== undefined ? [t('subagent.tokens', { count: Math.round(run.tokens) })] : []),
    ...(run.toolUses !== undefined ? [t('subagent.toolUses', { count: run.toolUses })] : []),
    ...(Number.isFinite(Date.parse(run.createdAt)) ? [formatTime(Date.parse(run.createdAt))] : [])
  ].filter(Boolean).join(' · ')

  return (
    // Same row inset as the bash task rows: 4px list padding + 6px here puts
    // the leading icon box on the todo list's own 10px. The row is a flex line
    // so the open-session link can sit beside the entry instead of inside the
    // disclosure: `flex-1` (and the `w-auto` that replaces the disclosure's own
    // `w-full`) leaves the entry the free space and the link its text width.
    <div className="flex items-start gap-2 px-1.5" data-subagent-id={run.sessionId} data-subagent-status={run.status}>
      <ToolResult className="w-auto min-w-0 flex-1" animateChanges={false} lazyContent open={open} onOpenChange={setOpen}
        title={`agent · ${run.description}`}
        status={run.status === 'running' ? 'running' : run.status === 'completed' ? 'success' : run.status === 'aborted' || run.status === 'interrupted' ? 'cancelled' : 'error'}
        icon={<Subagent aria-hidden="true" className="size-4" />}
        meta={meta}
        collapseOnComplete={false}>
        {open ? (
          <div className="space-y-2">
            {/* Human control lives only in the expanded body, so the shared
                36px collapsed row and its open-session link never move. The
                latest roster remains authoritative after an action. */}
            <div data-subagent-actions="" className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              {/* The vendored row's own footer already names the status in
                  English; only `interrupted` needs a localized word here. */}
              {run.status === 'interrupted' ? <span>{t('subagent.interrupted')}</span> : null}
              <Button
                data-subagent-action={humanAction}
                variant="ghost"
                size="sm"
                onClick={(event) => onAction(run, humanAction, event.currentTarget)}
              >
                {t(humanAction === 'steer' ? 'subagent.steer' : 'subagent.resume')}
              </Button>
              {live ? (
                <Button variant="destructive" size="sm" disabled={stopping} onClick={() => void stop()}>{t('subagent.stop')}</Button>
              ) : null}
            </div>
            {error ? <p className="text-xs text-destructive" role="status">{t('subagent.operationFailed')}</p> : null}
            {run.writtenFiles?.length ? (
              <div className="space-y-1 text-xs">
                {run.writtenFiles.map((file) => (
                  <div key={file.filePath} className="flex items-center gap-1.5 text-muted-foreground">
                    <FileDiff aria-hidden="true" className="size-3.5 shrink-0" />
                    <span className="truncate" title={file.filePath}>{file.displayPath}</span>
                    {file.added !== undefined || file.removed !== undefined ? (
                      <span className="ml-auto shrink-0 tabular-nums">
                        <span className="text-emerald-600 dark:text-emerald-400">+{file.added ?? 0}</span>{' '}
                        <span className="text-rose-600 dark:text-rose-400">-{file.removed ?? 0}</span>
                      </span>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : null}
            {run.error ? <p className="whitespace-pre-wrap break-words text-xs text-destructive">{run.error}</p> : null}
            {run.result ? <p className="whitespace-pre-wrap break-words text-xs">{run.result}</p> : null}
          </div>
        ) : null}
      </ToolResult>
      {/* A child is a real session, so opening it is a link, not a panel
          control: it stays beside the entry whatever the disclosure does,
          keeps the header's own 36px line (so the row never grows), and draws
          no surface of its own — no box, no press animation, no transition,
          only the hover underline. */}
      {onOpenSession ? (
        <button type="button" data-subagent-open={run.sessionId}
          className="flex min-h-9 shrink-0 items-center whitespace-nowrap rounded-control px-2 text-xs text-primary transition-colors hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          onClick={() => onOpenSession(run.sessionPath)}>
          {t('subagent.openSession')}
        </button>
      ) : null}
    </div>
  )
}

export function SubagentList({ runs, sessionPath, onOpenSession }: {
  runs: readonly SubagentRunDTO[]
  sessionPath: string
  onOpenSession?: (path: string) => void
}) {
  const [actionTarget, setActionTarget] = useState<SubagentActionTarget | null>(null)
  const actionTriggerRef = useRef<HTMLButtonElement | null>(null)
  // The drawer's list frame (see the bash list): the same 16.5rem cap, 4px edge
  // padding, 8px row gaps and edge fade, so all four panels match.
  const { list, mask } = useCappedListFade(runs.map((run) => run.sessionId).join('\n'))

  useEffect(() => {
    setActionTarget(null)
    actionTriggerRef.current = null
  }, [sessionPath])

  const openAction = (run: SubagentRunDTO, action: SubagentHumanAction, trigger: HTMLButtonElement) => {
    actionTriggerRef.current = trigger
    setActionTarget({
      action,
      sessionId: run.sessionId,
      runId: run.runId,
      description: run.description
    })
  }
  const closeAction = () => {
    setActionTarget(null)
    requestAnimationFrame(() => {
      if (actionTriggerRef.current?.isConnected) actionTriggerRef.current.focus({ preventScroll: true })
      actionTriggerRef.current = null
    })
  }
  const actionRun = actionTarget
    ? runs.find((run) => run.sessionId === actionTarget.sessionId) ?? null
    : null

  return (
    <>
      <div
        ref={list}
        data-subagents-list=""
        // The drawer's list frame (see the bash list): the same 16.5rem cap,
        // 4px edge padding, 8px row gaps and edge fade, so all four panels match.
        className="max-h-[16.5rem] space-y-2 overflow-y-auto p-1"
        style={{ maskImage: mask, WebkitMaskImage: mask }}
      >
        {runs.map((run) => (
          <SubagentRow
            key={run.sessionId}
            run={run}
            sessionPath={sessionPath}
            onOpenSession={onOpenSession}
            onAction={openAction}
          />
        ))}
      </div>
      {actionTarget ? (
        <SubagentActionDialog
          key={`${actionTarget.sessionId}:${actionTarget.runId}:${actionTarget.action}`}
          target={actionTarget}
          run={actionRun}
          sessionPath={sessionPath}
          onClose={closeAction}
        />
      ) : null}
    </>
  )
}
