import { useBashTasks, bashTaskStatus } from '@/lib/bash-tasks'
import { memo, useMemo, useState } from 'react'
import { AgentActivity } from '@/components/agents/agent-activity'
import { AgentDisclosure } from '@/components/agents/agent-disclosure'
import { useI18n } from '@/i18n'
import type { ToolCallContent, ToolResultMsg } from '../../../../shared/types'
import type { ToolRun } from '@/state/pi-store'
import type { ToolCategory } from '@/lib/tool-categories'
import { ToolCallView, statusOf } from './ToolCallView'

export interface ToolGroupViewProps {
  category: ToolCategory
  /** Adjacent same-category calls, in the model's output order. */
  calls: ToolCallContent[]
  toolResults: Map<string, ToolResultMsg>
  toolRuns: Record<string, ToolRun>
  /** Session working directory, forwarded to each row's file label. */
  cwd?: string | null
}

/**
 * One run of adjacent same-category tool calls, folded into a single trigger
 * row. Collapsed by default (per the grouping spec); expanding reveals every
 * call as its normal `ToolCallView` row, indented under the group icon.
 *
 * The trigger is deliberately status-free while the run is live; once every
 * call has settled it appends a compact tally (`· 3 completed, 0 failed`), so a
 * finished group reports its outcome without a second glyph competing with the
 * rows' own check/x.
 */
export const ToolGroupView = memo(function ToolGroupView({
  category,
  calls,
  toolResults,
  toolRuns,
  cwd
}: ToolGroupViewProps) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const Icon = category.icon

  const names = useMemo(() => {
    const seen = new Set<string>()
    for (const call of calls) seen.add(call.name)
    return [...seen].join(' · ')
  }, [calls])

  const tasks = useBashTasks()
  const statuses = calls.map((call) => {
    const task = call.name === 'bash' ? tasks.slice().reverse().find((item) => item.toolCallId === call.id) : undefined
    const saved = toolResults.get(call.id)?.details?.bashTask
    if (call.name === 'bash' && !task && saved?.background && (saved.status === 'running' || saved.status === 'stopping')) return 'unavailable'
    return task?.background ? bashTaskStatus(task) : statusOf(toolResults.get(call.id), toolRuns[call.id])
  })
  const settled = statuses.every((status) => status !== 'running')
  const completed = statuses.filter((status) => status === 'success').length
  const failed = statuses.filter((status) => status === 'error').length
  const cancelled = statuses.filter((status) => status === 'cancelled').length
  const unavailable = statuses.filter((status) => status === 'unavailable').length

  const summary = (
    <span className="inline-flex min-w-0 items-center gap-2">
      <Icon aria-hidden="true" className="size-4 shrink-0" />
      {/* The label, counts and mono tool names differ in size, so their line
          boxes differ too: centring each box independently (items-center) left
          the smaller mono names floating above the label's baseline. The text
          run shares one baseline instead, and the icon alone stays centred. */}
      <span className="inline-flex min-w-0 items-baseline gap-2">
        <span className="transcript-label shrink-0 font-medium text-foreground">{t(category.labelKey)}</span>
        <span className="transcript-label shrink-0 text-xs text-muted-foreground/60">
          {t('tool.groupCount', { count: calls.length })}
        </span>
        <span className="transcript-label min-w-0 truncate font-mono text-caption text-muted-foreground/55">
          {names}
        </span>
        {settled ? (
          <span className="transcript-label shrink-0 text-xs text-muted-foreground/60">
            · {t('tool.groupStats', { completed, failed })}
            {cancelled ? ` · ${t('tool.groupCancelled', { count: cancelled })}` : ''}
            {unavailable ? ` · ${t('bashTask.groupUnavailable', { count: unavailable })}` : ''}
          </span>
        ) : null}
      </span>
    </span>
  )

  return (
    <div className="w-full">
      {/* Same fold chrome as the turn's "show earlier" disclosure, so a folded
          run reads as one more collapsible section rather than a bespoke row.
          The body lives in the sibling disclosure below, not in AgentActivity's
          own empty item list. */}
      <AgentActivity
        status="complete"
        summary={summary}
        open={open}
        onOpenChange={setOpen}
        collapseOnComplete={false}
        items={[]}
        contentClassName="py-0"
      />
      <AgentDisclosure open={open} data-agent-body>
        {/* Group children share the transcript stack, including its gap. */}
        <div className="pl-6" data-transcript-rows data-transcript-tool-rows>
          {calls.map((call) => (
            <ToolCallView
              key={call.id}
              call={call}
              result={toolResults.get(call.id)}
              run={toolRuns[call.id]}
              cwd={cwd}
            />
          ))}
        </div>
      </AgentDisclosure>
    </div>
  )
}, toolGroupPropsEqual)

function toolGroupPropsEqual(prev: ToolGroupViewProps, next: ToolGroupViewProps): boolean {
  if (prev.category !== next.category || prev.cwd !== next.cwd) return false
  if (prev.calls.length !== next.calls.length) return false
  for (let index = 0; index < prev.calls.length; index++) {
    if (prev.calls[index].id !== next.calls[index].id) return false
    if (prev.calls[index].name !== next.calls[index].name) return false
  }
  if (prev.toolResults === next.toolResults && prev.toolRuns === next.toolRuns) return true
  for (const call of prev.calls) {
    if (prev.toolResults.get(call.id) !== next.toolResults.get(call.id)) return false
    if (prev.toolRuns[call.id] !== next.toolRuns[call.id]) return false
  }
  return true
}
