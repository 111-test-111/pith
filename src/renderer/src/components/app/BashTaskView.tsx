import { useEffect, useRef, useState } from 'react'
import { ToolResult, ToolResultOutput } from '@/components/agents/tool-result'
import { Button } from '@/components/motion/button'
import { FadeScroll } from './FadeScroll'
import { ToolIcon } from '@/lib/tool-icons'
import { bashTaskLive, bashTaskStatus, useBashTask, useBashTaskAvailable } from '@/lib/bash-tasks'
import { useI18n } from '@/i18n'
import { useCappedListFade } from '@/lib/hooks/use-capped-list-fade'
import type { BashTaskDTO } from '../../../../shared/types'

/**
 * The FULL command a bash row only previews in its title (the tool-call row
 * cuts it at the first line / 72 chars, a task row CSS-truncates it). Pinned
 * above the output's scroll viewport by `ToolResult`'s `header` slot, it stays
 * in view while long output scrolls beneath; an over-long command caps and
 * scrolls inside the header instead of pushing the output's fold down. The
 * caption is the existing `chat.bashCommand` label.
 */
export function BashCommandHeader({ command }: { command: string }) {
  const { t } = useI18n()
  return (
    <div className="px-3 pb-2 pt-2.5">
      <div className="mb-1 text-caption text-muted-foreground/60">{t('chat.bashCommand')}</div>
      {/* `overflow-wrap: anywhere` (see WRAP_OUTPUT in ToolCallView): an
          unbroken command line wraps instead of blowing out the row's width.
          `FadeScroll` bounds the header: an over-long command scrolls inside
          it instead of pushing the output's fold down, and the shared 12px
          ramp marks the edge that really hides lines — the bottom while more
          remains, the top once it is scrolled. */}
      <FadeScroll data-bash-command className="max-h-32 [&_pre]:[overflow-wrap:anywhere]">
        <ToolResultOutput language="bash" className="text-foreground">{command}</ToolResultOutput>
      </FadeScroll>
    </div>
  )
}

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
        {/* Whole seconds: the row is a readout, not a timer with precision — a
            decimal flickered between samples and read as noise beside the
            minute-resolution rows around it. */}
        <span>{t('bashTask.elapsed', { seconds: Math.max(0, Math.floor(((task.endedAt ?? now) - task.startedAt) / 1000)) })}</span>
        {task.lastOutputAt && task.outputChars > 0 ? <span>{t('bashTask.lastOutput', { seconds: Math.max(0, (now - task.lastOutputAt) / 1000).toFixed(0) })}</span> : null}
        {task.exitCode != null ? <span>{t('bashTask.exitCode', { code: task.exitCode })}</span> : null}
        {bashTaskLive(task) ? <Button variant="destructive" size="sm" disabled={stopping || task.status === 'stopping'} onClick={() => void stop()}>{t('bashTask.stop')}</Button> : null}
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

export function BashTaskRow({ task: fallback, completion = false, inset = false }: { task: BashTaskDTO; completion?: boolean; /** Task-panel rows only: see below. */ inset?: boolean }) {
  const task = useBashTask(undefined, fallback) ?? fallback
  const available = useBashTaskAvailable(task.id)
  const expired = !available && bashTaskLive(task)
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const firstLine = task.command.split('\n')[0]
  return (
    // The task panel's rows inset their content 6px on both sides — on top of
    // the list's own 4px that is the todo list's 10px, so the three panels lead
    // with an icon on the same line. A transcript row keeps the shared
    // `ToolResult` inset it has beside every other tool row.
    //
    // A transcript row is a PROCESS row for compact tool-call display
    // (`lib/compact-tools`): the completion notice a steer delivers is a tool
    // row like the call it reports, so it takes the same tightened gap beside
    // its neighbours. The panel's `inset` rows are not transcript rows and are
    // left untagged.
    <div className={inset ? 'px-1.5' : ''} data-row={inset ? undefined : 'process'} data-bash-task-id={task.id} data-bash-task-status={expired ? 'unavailable' : task.status}>
      <ToolResult animateChanges={false} lazyContent open={open} onOpenChange={setOpen}
        title={completion ? t('bashTask.completedCommand', { command: firstLine }) : `bash · ${firstLine}`}
        status={expired ? 'cancelled' : bashTaskStatus(task)} icon={<ToolIcon name="bash" />}
        meta={t(expired ? 'bashTask.unavailable' : task.background && task.status === 'running' ? 'bashTask.background' : `bashTask.${task.status}`)}
        header={<BashCommandHeader command={task.command} />}
        collapseOnComplete={false}>
        {open ? available ? <BashOutput key={task.id} task={task} /> : <p className="text-xs text-muted-foreground">{t('bashTask.recordExpired')}</p> : null}
      </ToolResult>
    </div>
  )
}

export function BashTaskList({ tasks }: { tasks: readonly BashTaskDTO[] }) {
  // The drawer's shared capped-list frame: a 4 + 6*36 + 5*8 + 4 = 264px
  // (16.5rem) cap — six collapsed rows (`ToolResult`'s `min-h-9`) with 4px edge
  // padding and 8px gaps — plus the edge fade wherever a scroll cuts a row.
  const { list, mask } = useCappedListFade(tasks.map((task) => task.id).join('\n'))
  return (
    <div
      ref={list}
      data-bash-tasks-list=""
      // The drawer's list frame, shared with the todo, subagent and Q&A panels.
      className="max-h-[16.5rem] space-y-2 overflow-y-auto p-1"
      style={{ maskImage: mask, WebkitMaskImage: mask }}
    >
      {tasks.slice().reverse().map((task) => <BashTaskRow key={task.id} task={task} inset />)}
    </div>
  )
}
