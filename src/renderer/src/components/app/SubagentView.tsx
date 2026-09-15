import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { ToolResult } from '@/components/agents/tool-result'
import { Button } from '@/components/motion/button'
import { Bot, FileDiff } from '@/lib/icons'
import { useI18n } from '@/i18n'
import type { SubagentRunDTO } from '../../../../shared/types'

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
        meta={[run.profile, run.model, t(`subagent.${run.status}`), ...(run.writtenFiles?.length ? [t('subagent.filesCount', { count: run.writtenFiles.length })] : [])].filter(Boolean).join(' · ')}
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

  const meta = [
    run.profile,
    run.model,
    formatElapsed(elapsedOf(run, now), t),
    ...(run.tokens !== undefined ? [t('subagent.tokens', { count: Math.round(run.tokens) })] : []),
    ...(run.toolUses !== undefined ? [t('subagent.toolUses', { count: run.toolUses })] : [])
  ].filter(Boolean).join(' · ')

  return (
    <div data-subagent-id={run.sessionId} data-subagent-status={run.status}>
      <ToolResult animateChanges={false} lazyContent open={open} onOpenChange={setOpen}
        title={`agent · ${run.description}`}
        status={run.status === 'running' ? 'running' : run.status === 'completed' ? 'success' : run.status === 'aborted' || run.status === 'interrupted' ? 'cancelled' : 'error'}
        icon={<Bot aria-hidden="true" className="size-4" />}
        meta={meta}
        copyText={run.task}
        collapseOnComplete={false}>
        {open ? (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span>{t(`subagent.${run.status}`)}</span>
              {live ? (
                <Button variant="ghost" size="sm" disabled={stopping} onClick={() => void stop()}>{t('subagent.stop')}</Button>
              ) : null}
              {onOpenSession ? (
                <Button variant="ghost" size="sm" onClick={() => onOpenSession(run.sessionPath)}>{t('subagent.openSession')}</Button>
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
      // Whole rows only (same pitch math as the bash task list): the resting
      // list never cuts a row in half.
      className="max-h-[16.5rem] space-y-2 overflow-y-auto p-1"
      style={{ maskImage: mask, WebkitMaskImage: mask }}
    >
      {runs.map((run) => (
        <SubagentRow key={run.sessionId} run={run} sessionPath={sessionPath} onOpenSession={onOpenSession} />
      ))}
    </div>
  )
}
