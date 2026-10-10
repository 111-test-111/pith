import { memo, useCallback, useEffect, useId, useRef, useState } from 'react'
import { ChevronDown, CircleHelp, Compass, Subagent, ListTodo, Terminal, X } from '@/lib/icons'
import { AgentDisclosure } from '@/components/agents/agent-disclosure'
import { TodoList } from '@/components/agents/todo-list'
import { Button } from '@/components/motion/button'
import { ActionSwapRollText } from '@/components/motion/action-swap-roll'
import { useI18n } from '@/i18n'
import { bashTaskLive, useBashTasks } from '@/lib/bash-tasks'
import { useDismiss } from '@/lib/hooks/use-dismiss'
import { cn } from '@/lib/utils'
import { BashTaskList } from './BashTaskView'
import { SubagentList } from './SubagentView'
import { AskUserRecordList } from './AskUserRecordList'
import { ToolIcon } from '@/lib/tool-icons'
import { JevWorkflowPanel } from './JevWorkflowPanel'
import type { JevWorkflowDTO, SubagentRunDTO, TodoSnapshotDTO } from '../../../../shared/types'
import type { AskUserRecordDTO } from '../../../../shared/ask-user'
import type { GoalSnapshotDTO } from '../../../../shared/goal'
import { GoalPanel } from './GoalPanel'
import type { GoalUIState } from '@/state/pi-store'

type Panel = 'todo' | 'bash' | 'agents' | 'ask' | 'jev' | 'goal'

/** One stable overlay owner for all task views, including Jev. Switching tabs never moves the transcript. */
export const SessionTasks = memo(function SessionTasks({ todos, subagents = [], askUserRecords = [], busy, sessionPath = null, onOpenSession, jevState = null, goal = null, goalSeq = 0, goalAvailable = false, goalRestricted = false, goalInitializing = false, goalUI, onGoalDraft, onGoalEnd, onGoalState }: {
  goal?: GoalSnapshotDTO | null
  goalSeq?: number
  goalAvailable?: boolean
  goalRestricted?: boolean
  goalInitializing?: boolean
  goalUI?: GoalUIState
  onGoalDraft?: (draft: Pick<GoalUIState, 'limits' | 'acceptance'>) => void
  onGoalEnd?: () => void
  onGoalState?: (path: string, goal: GoalSnapshotDTO | null, seq: number) => void
  jevState?: JevWorkflowDTO | null
  todos: TodoSnapshotDTO | null
  /** Roster of this session's subagent runs (store-fed). */
  subagents: readonly SubagentRunDTO[]
  /** Every ask_user_question of this session, oldest first (store-fed). */
  askUserRecords?: readonly AskUserRecordDTO[]
  busy: boolean
  /** This session's file — the parent path roster actions address. */
  sessionPath: string | null
  /** Open a subagent child session as the visible chat. */
  onOpenSession?: (path: string) => void
}) {
  const { t } = useI18n()
  const records = askUserRecords
  const tasks = useBashTasks().filter((task) => task.background)
  const [selected, setSelected] = useState<Panel | null>(null)
  const showGoal = goalAvailable && !!goalUI?.enabled && !!goalUI.submitted && !!goal
  const root = useRef<HTMLDivElement>(null)
  const triggers = useRef<Partial<Record<Panel, HTMLButtonElement | null>>>({})
  const baseId = useId()
  // Clearing stops active tracking without deleting the last list from the UI.
  const items = todos?.items.length ? todos.items : todos?.retainedItems ?? []
  const retained = !todos?.items.length && items.length > 0
  const working = busy && !retained
  const done = items.filter((item) => item.status === 'completed').length
  const cancelled = items.filter((item) => item.status === 'cancelled').length
  const unfinished = items.some((item) => item.status === 'pending' || item.status === 'in_progress')
  const running = tasks.filter(bashTaskLive).length
  const agentsRunning = subagents.filter((run) => run.status === 'running').length
  const awaiting = records.filter((record) => record.status === 'pending').length
  const open = selected !== null && (selected === 'goal' ? showGoal && !!sessionPath : selected === 'jev' ? !!sessionPath && !!jevState : selected === 'todo' ? items.length > 0 : selected === 'bash' ? tasks.length > 0 : selected === 'agents' ? subagents.length > 0 : records.length > 0)
  const close = useCallback(() => setSelected(null), [])
  const focusTrigger = useCallback(() => { if (selected) triggers.current[selected]?.focus() }, [selected])
  // Portalled dialogs sit outside `root` but own the whole window. Their
  // pointerdown/backdrop and Escape must close only the dialog, never tear
  // down the task panel underneath before the intended click can run.
  const modalOwnsDismiss = useCallback(() => Boolean(document.querySelector('[aria-modal="true"]')), [])
  useDismiss(open, close, root, { escape: false, ignore: modalOwnsDismiss })
  useEffect(() => { if (selected && !open) setSelected(null) }, [selected, open])
  useEffect(() => {
    if (!open) return
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented) return
      if (document.querySelector('[aria-modal="true"]')) return
      event.preventDefault() // The first Escape closes this surface; it must not stop the run.
      focusTrigger()
      close()
    }
    window.addEventListener('keydown', keydown, true)
    return () => window.removeEventListener('keydown', keydown, true)
  }, [open, close, focusTrigger])
  const hasTasks = !!(showGoal || items.length || tasks.length || subagents.length || records.length || jevState)
  if (!hasTasks) return null
  const title = selected === 'goal' ? t('goal.title') : selected === 'jev' ? t('jev.panelTitle') : selected === 'todo' ? t('todo.title') : selected === 'bash' ? t('taskPanel.background') : selected === 'agents' ? t('taskPanel.agents') : t('askUser.recordsTitle')
  const summary = selected === 'goal' ? null : selected === 'jev' ? t('jev.panelSummary') : selected === 'todo'
    ? t('todo.progress', { done, total: items.length })
    : selected === 'bash'
      ? t('bashTask.summary', { count: tasks.length, running })
      : selected === 'agents'
        ? t('subagent.summary', { count: subagents.length, running: agentsRunning })
        : t('askUser.recordsSummary', { count: records.length, answered: records.filter((record) => record.status === 'answered').length })

  return (
    <div ref={root} className="relative z-20 shrink-0" data-session-tasks>
      <div role="group" aria-label={t('taskPanel.label')} className="flex flex-wrap items-center gap-1 border-b border-border px-4 py-1.5">
        {(['goal', 'todo', 'bash', 'agents', 'ask', 'jev'] as const).map((panel) => {
          if (panel === 'goal' ? !showGoal : panel === 'jev' ? !jevState : panel === 'todo' ? !items.length : panel === 'bash' ? !tasks.length : panel === 'agents' ? !subagents.length : !records.length) return null
          const active = open && selected === panel
          const Icon = panel === 'goal' ? Compass : panel === 'todo' ? ListTodo : panel === 'bash' ? Terminal : panel === 'agents' ? Subagent : CircleHelp
          const label = panel === 'goal' ? t('goal.title') : panel === 'jev' ? t('jev.title') : panel === 'todo' ? t('todo.title') : panel === 'bash' ? t('taskPanel.background') : panel === 'agents' ? t('taskPanel.agents') : t('askUser.recordsTitle')
          const count = panel === 'goal' ? goal ? t(`goal.status.${goal.status}`) : '' : panel === 'jev' ? String(jevState?.requests ?? 0) : panel === 'todo'
            ? `${done}/${items.length}`
            : panel === 'bash'
              ? String(running || tasks.length)
              : panel === 'agents'
                ? String(agentsRunning || subagents.length)
                : String(awaiting || records.length)
          return (
            <Button key={panel} ref={(node) => { triggers.current[panel] = node }}
              id={`${baseId}-${panel}`} size="sm" variant={active ? 'secondary' : 'ghost'}
              data-task-trigger={panel} data-jev-trigger={panel === 'jev' ? '' : undefined} aria-expanded={active} aria-controls={`${baseId}-panel`}
              onClick={() => setSelected(active ? null : panel)}
              className={cn('gap-2 text-xs', active && 'bg-muted')}>
              {panel === 'jev' ? <ToolIcon name="jev_decide" className="size-3.5 text-muted-foreground" /> : <Icon aria-hidden="true" className="size-3.5 text-muted-foreground" />}
              {label}
              {panel !== 'jev' && count ? <span className="tabular-nums text-muted-foreground"><ActionSwapRollText value={count}>{count}</ActionSwapRollText></span> : null}
              <ChevronDown aria-hidden="true" className={cn('size-3 text-muted-foreground transition-transform', active && 'rotate-180')} />
            </Button>
          )
        })}
      </div>
      <div className={cn('absolute inset-x-0 top-full transition-opacity duration-150', open ? 'opacity-100' : 'pointer-events-none opacity-0')}>
        <AgentDisclosure id={`${baseId}-panel`} role="region" aria-labelledby={selected ? `${baseId}-${selected}` : undefined}
          open={open} data-task-panel={selected ?? ''} className="border-b border-border bg-popover">
          <div className="flex min-h-12 items-center gap-3 border-b border-border/60 px-3 py-2">
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">{title}</div>
              {summary ? <div className="text-xs text-muted-foreground">{summary}{selected === 'todo' && cancelled > 0 ? ` · ${t('todo.cancelledCount', { count: cancelled })}` : ''}</div> : null}
            </div>
            {selected === 'todo' && (retained || unfinished) ? <span className="text-xs text-muted-foreground">{t(retained ? 'todo.retained' : working ? 'todo.working' : 'todo.paused')}</span> : null}
            <Button size="icon" variant="ghost" className="size-7" aria-label={t('taskPanel.close')} onClick={() => { focusTrigger(); close() }}>
              <X aria-hidden="true" className="size-3.5" />
            </Button>
          </div>
          {selected === 'todo' ? (
            <TodoList headerless collapseOnComplete={false} className="rounded-none border-0" title={t('todo.title')}
              // The drawer's list frame: the same 16.5rem cap, 4px edge padding
              // and 8px row gaps as the bash/subagent lists.
              viewportClassName="max-h-[16.5rem] p-1" listClassName="space-y-2" items={items.map((item) => ({
                id: item.id,
                title: <span className="block whitespace-normal break-words py-1" data-todo-id={item.id} data-todo-status={item.status}>
                  {item.content}
                  {item.status === 'in_progress' && item.activeForm && working ? <span className="mt-0.5 block text-xs text-muted-foreground">{item.activeForm}</span> : null}
                </span>,
                status: item.status === 'in_progress' ? 'in-progress' : item.status,
                // Idle and retained rows stay still without rewriting the saved status.
                progress: !working && item.status === 'in_progress' ? 0 : undefined,
                detail: t(item.status === 'in_progress' && !busy && !retained ? 'todo.paused' : `todo.${item.status}`)
              }))} />
          ) : selected === 'bash' ? <BashTaskList tasks={tasks} /> : null}
          {selected === 'agents' && sessionPath ? (
            <SubagentList runs={subagents} sessionPath={sessionPath} onOpenSession={onOpenSession} />
          ) : null}
          {selected === 'jev' && sessionPath ? <JevWorkflowPanel key={sessionPath} sessionPath={sessionPath} state={jevState} /> : null}
          {showGoal && goalUI && sessionPath && onGoalState && onGoalDraft && onGoalEnd ? <div hidden={selected !== 'goal'}>
            <GoalPanel sessionPath={sessionPath} goal={goal} seq={goalSeq} busy={busy || goalInitializing || !!goal?.executing} restricted={goalRestricted} visible={open && selected === 'goal'}
              ui={goalUI} onDraft={onGoalDraft} onEnd={onGoalEnd} onState={onGoalState} />
          </div> : null}
          {selected === 'ask' ? <AskUserRecordList records={records} /> : null}
        </AgentDisclosure>
      </div>
    </div>
  )
})
