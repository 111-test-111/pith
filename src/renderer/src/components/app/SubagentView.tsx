import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { ToolResult } from '@/components/agents/tool-result'
import { Button } from '@/components/motion/button'
import { Bot, FileDiff } from '@/lib/icons'
import { formatTime } from '@/lib/format'
import { useI18n } from '@/i18n'
import { SUBAGENT_READ_ONLY_TOOLS, type SubagentRunDTO } from '../../../../shared/types'

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
    <div data-subagent-completion={run.runId} data-subagent-status={run.status}>
      <ToolResult animateChanges={false} lazyContent open={open} onOpenChange={setOpen}
        title={t('subagent.completedTitle', { description: run.description })}
        status={status}
        icon={<Bot aria-hidden="true" className="size-4" />}
        meta={[run.profile, run.model, ...(run.runInBackground ? [t('subagent.background')] : []), ...(run.status === 'interrupted' ? [t('subagent.interrupted')] : []), ...(run.limitReached ? [t('subagent.turnLimit')] : []), ...(run.writtenFiles?.length ? [t('subagent.filesCount', { count: run.writtenFiles.length })] : [])].filter(Boolean).join(' · ')}
        copyText={run.result ?? run.error ?? run.task}
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

function SubagentRow({ run, sessionPath, onOpenSession }: {
  run: SubagentRunDTO
  sessionPath: string
  onOpenSession?: (path: string) => void
}) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [error, setError] = useState(false)
  const live = run.status === 'running'
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!live) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [live])

  const stop = async () => {
    setStopping(true)
    try {
      await window.pi.subagentAction({ sessionPath, sessionId: run.sessionId, action: 'abort' })
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
    // repeated here — `已完成Completed` was exactly that duplication.
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
        icon={<Bot aria-hidden="true" className="size-4" />}
        meta={meta}
        copyText={run.task}
        collapseOnComplete={false}>
        {open ? (
          <div className="space-y-2">
            {/* Only a live run (Stop) or an interrupted one (the word) has a
                footer: open-session moved up to the row, so an empty flex line
                would otherwise leave a stray 8px gap above the result. */}
            {live || run.status === 'interrupted' ? (
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                {/* The vendored row's own footer already names the status in
                    English; only `interrupted` needs a localized word here. */}
                {run.status === 'interrupted' ? <span>{t('subagent.interrupted')}</span> : null}
                {live ? (
                  <Button variant="ghost" size="sm" disabled={stopping} onClick={() => void stop()}>{t('subagent.stop')}</Button>
                ) : null}
              </div>
            ) : null}
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
          className="flex min-h-9 shrink-0 items-center whitespace-nowrap text-xs text-primary transition-none hover:underline focus-visible:text-foreground focus-visible:underline focus-visible:outline-none"
          onClick={() => onOpenSession(run.sessionPath)}>
          {t('subagent.openSession')}
        </button>
      ) : null}
    </div>
  )
}

/** BeUI's capped-list edge fade (the same 12px ramp the bash task list uses):
 * whole rows at the cap's boundaries stay crisp; a half-visible row fades. */
const SCROLL_FADE = 12
const fadeMask = (top: boolean, bottom: boolean) => {
  if (!top && !bottom) return undefined
  const stops = [
    ...(top ? ['transparent', `black ${SCROLL_FADE}px`] : ['black']),
    ...(bottom ? [`black calc(100% - ${SCROLL_FADE}px)`, 'transparent'] : [])
  ]
  return `linear-gradient(to bottom, ${stops.join(', ')})`
}

export function SubagentList({ runs, sessionPath, onOpenSession }: {
  runs: readonly SubagentRunDTO[]
  sessionPath: string
  onOpenSession?: (path: string) => void
}) {
  const list = useRef<HTMLDivElement>(null)
  const [cut, setCut] = useState({ top: false, bottom: false })
  const ids = useMemo(() => runs.map((run) => run.sessionId).join('\n'), [runs])
  useEffect(() => {
    const node = list.current
    if (!node) return
    let frame = 0
    const measure = () => {
      frame = 0
      const box = node.getBoundingClientRect()
      const pad = parseFloat(getComputedStyle(node).paddingTop) || 0
      const top = box.top + pad
      const bottom = box.bottom - pad
      let cutTop = false
      let cutBottom = false
      for (const row of node.children) {
        const rect = row.getBoundingClientRect()
        if (rect.top < top - 0.5 && rect.bottom > top + 0.5) cutTop = true
        if (rect.top < bottom - 0.5 && rect.bottom > bottom + 0.5) cutBottom = true
      }
      setCut((prev) => (prev.top === cutTop && prev.bottom === cutBottom ? prev : { top: cutTop, bottom: cutBottom }))
    }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure) }
    const observer = new ResizeObserver(schedule)
    observer.observe(node)
    for (const row of node.children) observer.observe(row)
    node.addEventListener('scroll', schedule, { passive: true })
    schedule()
    return () => {
      if (frame) cancelAnimationFrame(frame)
      observer.disconnect()
      node.removeEventListener('scroll', schedule)
    }
  }, [ids])
  const mask = fadeMask(cut.top, cut.bottom)
  return (
    <div
      ref={list}
      data-subagents-list=""
      // The drawer's list frame (see the bash list): the same 16.5rem cap,
      // 4px edge padding and 8px row gaps, so all three panels match.
      className="max-h-[16.5rem] space-y-2 overflow-y-auto p-1"
      style={{ maskImage: mask, WebkitMaskImage: mask }}
    >
      {runs.map((run) => (
        <SubagentRow key={run.sessionId} run={run} sessionPath={sessionPath} onOpenSession={onOpenSession} />
      ))}
    </div>
  )
}
