import { useEffect, useRef, useState } from 'react'
import { ToolResult, ToolResultOutput } from '@/components/agents/tool-result'
import { Button } from '@/components/motion/button'
import { ToolIcon } from '@/lib/tool-icons'
import { bashTaskLive, bashTaskStatus, useBashTask, useBashTaskAvailable } from '@/lib/bash-tasks'
import { useI18n } from '@/i18n'
import type { BashTaskDTO } from '../../../../shared/types'

function BashOutput({ task }: { task: BashTaskDTO }) {
  const { t } = useI18n()
  const [output, setOutput] = useState('')
  const [truncated, setTruncated] = useState(false)
  const [error, setError] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [now, setNow] = useState(Date.now)
  const cursor = useRef<number | undefined>(undefined)
  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const read = async () => {
      try {
        const next = await window.pi.bashTaskOutput({ sessionPath: task.sessionPath, taskId: task.id, cursor: cursor.current })
        if (!active) return
        setNow(Date.now())
        const initial = cursor.current === undefined
        cursor.current = next.cursor
        setOutput((prev) => (initial || next.truncated ? next.output : prev + next.output).slice(-65_536))
        if (next.truncated || next.cursor > 65_536) setTruncated(true)
        setError(false)
        if (bashTaskLive(next.task) || next.cursor < next.task.outputChars) timer = setTimeout(read, 1000)
      } catch {
        if (active) setError(true)
      }
    }
    void read()
    return () => { active = false; clearTimeout(timer) }
  }, [task.id, task.sessionPath, task.status])

  const stop = async () => {
    setStopping(true)
    try { await window.pi.stopBashTask({ sessionPath: task.sessionPath, taskId: task.id }) }
    catch { setError(true) }
    finally { setStopping(false) }
  }
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>{t('bashTask.id', { id: task.id })}</span>
        <span>{t('bashTask.elapsed', { seconds: Math.max(0, ((task.endedAt ?? now) - task.startedAt) / 1000).toFixed(1) })}</span>
        {task.lastOutputAt ? <span>{t('bashTask.lastOutput', { seconds: Math.max(0, (now - task.lastOutputAt) / 1000).toFixed(0) })}</span> : null}
        {task.exitCode != null ? <span>{t('bashTask.exitCode', { code: task.exitCode })}</span> : null}
        {bashTaskLive(task) ? <Button variant="ghost" size="sm" disabled={stopping || task.status === 'stopping'} onClick={() => void stop()}>{t('bashTask.stop')}</Button> : null}
        <Button variant="ghost" size="sm" onClick={() => void window.pi.openPath(task.logPath).then((message) => { if (message) setError(true) }).catch(() => setError(true))}>{t('bashTask.openLog')}</Button>
      </div>
      {error ? <p className="text-xs text-destructive" role="status">{t('bashTask.operationFailed')}</p> : null}
      {truncated || task.logTruncated ? <p className="text-xs text-muted-foreground">{t(task.logTruncated ? 'bashTask.logCapped' : 'bashTask.outputTruncated')}</p> : null}
      <div className="max-h-64 overflow-auto">
        <ToolResultOutput language="text" highlight={false}>{output || task.error || t('bashTask.noOutput')}</ToolResultOutput>
      </div>
    </div>
  )
}

export function BashTaskRow({ task: fallback, completion = false }: { task: BashTaskDTO; completion?: boolean }) {
  const task = useBashTask(undefined, fallback) ?? fallback
  const available = useBashTaskAvailable(task.id)
  const expired = !available && bashTaskLive(task)
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const firstLine = task.command.split('\n')[0]
  return (
    <div className="" data-bash-task-id={task.id} data-bash-task-status={expired ? 'unavailable' : task.status}>
      <ToolResult animateChanges={false} lazyContent open={open} onOpenChange={setOpen}
        title={completion ? t('bashTask.completedCommand', { command: firstLine }) : `bash · ${firstLine}`}
        status={expired ? 'cancelled' : bashTaskStatus(task)} icon={<ToolIcon name="bash" />}
        meta={t(expired ? 'bashTask.unavailable' : task.background && task.status === 'running' ? 'bashTask.background' : `bashTask.${task.status}`)}
        copyText={task.command} collapseOnComplete={false}>
        {open ? available ? <BashOutput key={task.id} task={task} /> : <p className="text-xs text-muted-foreground">{t('bashTask.recordExpired')}</p> : null}
      </ToolResult>
    </div>
  )
}

/** BeUI's capped-list edge fade: the same 12px ramp AgentActivity puts on its
 * scrolling viewport, applied to whichever end actually cuts a row. Whole rows
 * at the cap's boundaries stay crisp; a row that is only half in view fades out
 * instead of ending in a hard chop. */
const SCROLL_FADE = 12
const fadeMask = (top: boolean, bottom: boolean) => {
  if (!top && !bottom) return undefined
  const stops = [
    ...(top ? ['transparent', `black ${SCROLL_FADE}px`] : ['black']),
    ...(bottom ? [`black calc(100% - ${SCROLL_FADE}px)`, 'transparent'] : []),
  ]
  return `linear-gradient(to bottom, ${stops.join(', ')})`
}

export function BashTaskList({ tasks }: { tasks: readonly BashTaskDTO[] }) {
  const list = useRef<HTMLDivElement>(null)
  const [cut, setCut] = useState({ top: false, bottom: false })
  const ids = tasks.map((task) => task.id).join('\n')
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
      data-bash-tasks-list=""
      // Whole rows only: the cap is the list's 4px padding plus six collapsed
      // rows (ToolResult's `min-h-9`) and the `space-y-2` gaps between them —
      // 4 + 6*36 + 5*8 + 4 = 264px, six row pitches, so the bottom edge of the
      // resting list lands on a row boundary and never cuts one in half.
      className="max-h-[16.5rem] space-y-2 overflow-y-auto p-1"
      style={{ maskImage: mask, WebkitMaskImage: mask }}
    >
      {tasks.slice().reverse().map((task) => <BashTaskRow key={task.id} task={task} />)}
    </div>
  )
}

