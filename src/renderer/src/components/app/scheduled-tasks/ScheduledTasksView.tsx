import { memo, useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { AlertCircle, ArrowLeft, CalendarCheck, Pencil, Plus, Search, X, Zap } from '@/lib/icons'
import { EASE_OUT } from '@/lib/ease'
import { Button } from '@/components/motion/button'
import { Input } from '@/components/motion/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/motion/select'
import { FadeScroll } from '../FadeScroll'
import { WindowTitlebar } from '../WindowTitlebar'
import { ConfirmDialog } from '../ConfirmDialog'
import { ScheduledTaskEditor } from './ScheduledTaskEditor'
import { groupScheduledRunsByDate, sortScheduledRuns, type RunSortOrder } from './history-groups'
import { formatDateTime, scheduleDetailText, scheduleText, taskNextRunText } from './schedule-text'
import { useScheduledTasks, scheduledTaskActions, refreshScheduledTasks, scheduledErrorStatus } from '@/state/scheduled-tasks-store'
import { useI18n } from '@/i18n'
import { Markdown } from '@/lib/markdown'
import { isScheduledTaskRunActive, type ScheduledTask, type ScheduledTaskRun } from '../../../../../shared/scheduled-tasks'
import type { ModelDTO, SessionSummaryDTO } from '../../../../../shared/types'
import { cn } from '@/lib/utils'

/**
 * The scheduled tasks full-page surface (SettingsPage shell precedent): back
 * button in the titlebar, two columns on wide windows, list↔detail switch on
 * narrow ones. All state reads come from the push-fed store; every mutation
 * refreshes the authoritative snapshot afterwards.
 */

export interface ScheduledTasksViewProps {
  open: boolean
  onBack: () => void
  currentSessionId: string | null
  currentCwd: string | null
  currentProjectless: boolean
  sessions: readonly SessionSummaryDTO[]
  folders: readonly string[]
  models: readonly ModelDTO[]
  /** Open a run's session in the main conversation view. */
  onOpenRunSession: (sessionPath: string) => Promise<void>
}

type StatusFilter = 'all' | ScheduledTask['status']
type RunFilter = 'all' | 'unread' | 'active' | ScheduledTaskRun['status']
const RUN_PAGE_SIZE = 40

/** The run-status → ring color mapping stays textual (status-ring is chat-owned). */
function RunStatusDot({ status }: { status: ScheduledTaskRun['status'] }) {
  const color =
    status === 'succeeded'
      ? 'bg-emerald-500'
      : status === 'failed'
        ? 'bg-destructive'
        : status === 'cancelled' || status === 'interrupted'
          ? 'bg-muted-foreground/60'
          : status === 'waiting'
            ? 'bg-amber-500'
            : 'bg-primary'
  return (
    <span
      aria-hidden="true"
      className={cn('mt-1.5 size-2 shrink-0 rounded-full', color, (status === 'running' || status === 'queued') && 'animate-pulse')}
    />
  )
}

export const ScheduledTasksView = memo(function ScheduledTasksView({
  open,
  onBack,
  currentSessionId,
  currentCwd,
  currentProjectless,
  sessions,
  folders,
  models,
  onOpenRunSession
}: ScheduledTasksViewProps) {
  const { t, locale } = useI18n()
  const reduce = useReducedMotion()
  const { snapshot, error } = useScheduledTasks()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [view, setView] = useState<'tasks' | 'history'>('tasks')
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [runFilter, setRunFilter] = useState<RunFilter>('all')
  const [runSort, setRunSort] = useState<RunSortOrder>('newest')
  const [historyLimit, setHistoryLimit] = useState(RUN_PAGE_SIZE)
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [runOutput, setRunOutput] = useState<{ runId: string; text: string | null } | null>(null)
  const [editorOpen, setEditorOpen] = useState(false)
  const [editorTask, setEditorTask] = useState<ScheduledTask | null>(null)
  const [editorDraft, setEditorDraft] = useState<Partial<ScheduledTask> | null>(null)
  const [confirm, setConfirm] = useState<
    | { kind: 'deleteTask'; task: ScheduledTask }
    | { kind: 'deleteRun'; run: ScheduledTaskRun }
    | { kind: 'cleanup'; ids: string[] }
    | null
  >(null)
  const [actionError, setActionError] = useState<string | null>(null)
  // Narrow windows show either the list or the detail, never both.
  const [mobileDetail, setMobileDetail] = useState(false)

  const tasks = useMemo(() => snapshot?.tasks ?? [], [snapshot])
  const runs = useMemo(() => snapshot?.runs ?? [], [snapshot])
  const unreadByTask = useMemo(() => {
    const map = new Map<string, number>()
    for (const run of runs) {
      if (!isScheduledTaskRunActive(run) && !run.readAt) map.set(run.taskId, (map.get(run.taskId) ?? 0) + 1)
    }
    return map
  }, [runs])

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return tasks.filter((task) => {
      if (statusFilter !== 'all' && task.status !== statusFilter) return false
      if (needle && !task.name.toLowerCase().includes(needle) && !task.prompt.toLowerCase().includes(needle)) return false
      return true
    })
  }, [tasks, query, statusFilter])

  const selected = useMemo(() => filtered.find((task) => task.id === selectedId) ?? filtered[0] ?? null, [filtered, selectedId])
  const filteredRuns = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return runs.filter((run) => {
      if (runFilter === 'unread' && (isScheduledTaskRunActive(run) || !!run.readAt)) return false
      if (runFilter === 'active' && !isScheduledTaskRunActive(run)) return false
      if (runFilter !== 'all' && runFilter !== 'unread' && runFilter !== 'active' && run.status !== runFilter) return false
      return !needle || [run.taskName, run.summary ?? '', run.error ?? '', run.cwd ?? ''].some((value) => value.toLowerCase().includes(needle))
    })
  }, [runs, runFilter, query])
  const orderedRuns = useMemo(() => sortScheduledRuns(filteredRuns, runSort), [filteredRuns, runSort])
  const visibleRuns = useMemo(() => orderedRuns.slice(0, historyLimit), [orderedRuns, historyLimit])
  const runGroups = useMemo(() => groupScheduledRunsByDate(visibleRuns, locale), [visibleRuns, locale])
  const selectedRun = useMemo(() => visibleRuns.find((run) => run.id === selectedRunId) ?? visibleRuns[0] ?? null, [visibleRuns, selectedRunId])

  useEffect(() => {
    if (view !== 'history' || !selectedRun) return
    const runId = selectedRun.id
    const fallback = selectedRun.summary ?? null
    let cancelled = false
    setRunOutput(null)
    void window.pi.scheduledRunOutput(runId).then(
      ({ text }) => { if (!cancelled) setRunOutput({ runId, text }) },
      () => { if (!cancelled) setRunOutput({ runId, text: fallback }) }
    )
    return () => { cancelled = true }
  }, [view, selectedRun?.id, selectedRun?.status, selectedRun?.summary])

  const runAction = async (work: Promise<unknown>) => {
    setActionError(null)
    try {
      await work
    } catch (cause) {
      setActionError(
        scheduledErrorStatus(cause) === 409 ? t('scheduledTasks.conflict') : cause instanceof Error ? cause.message : String(cause)
      )
    }
  }

  const openEditor = (task: ScheduledTask | null, draft?: Partial<ScheduledTask>) => {
    setEditorTask(task)
    setEditorDraft(draft ?? null)
    setEditorOpen(true)
  }

  const exampleDrafts: Array<{ key: string; draft: Partial<ScheduledTask> }> = [
    {
      key: 'projectCheck',
      draft: {
        name: t('scheduledTasks.example.projectCheck'),
        schedule: { type: 'interval', minutes: 120 }
      }
    },
    {
      key: 'dailyBriefing',
      draft: {
        name: t('scheduledTasks.example.dailyBriefing'),
        schedule: { type: 'daily', time: '09:00', timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }
      }
    },
    {
      key: 'followUp',
      draft: {
        name: t('scheduledTasks.example.followUp'),
        schedule: { type: 'once', at: new Date(Date.now() + 3600_000).toISOString() }
      }
    }
  ]

  const detail = selected ? (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 px-5 pb-3 pt-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-foreground">{selected.name}</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {scheduleText(selected.schedule, t)} · {scheduleDetailText(selected, t, locale)}
              {selected.model ? ` · ${selected.model.provider}/${selected.model.modelId}` : ''}
              {selected.permissionMode ? ` · ${t(`scheduledTasks.mode.${selected.permissionMode}`)}` : ''}
              {selected.target.type === 'new_session' ? ` · ${t(selected.target.environment === 'worktree' ? 'scheduledTasks.editor.environmentWorktree' : 'scheduledTasks.editor.environmentLocal')}` : ''}
            </p>
            <p className="mt-0.5 text-caption text-muted-foreground">
              {t(`scheduledTasks.status.${selected.status}`)}
              {taskNextRunText(selected, t, locale) ? ` · ${taskNextRunText(selected, t, locale)}` : ''}
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
            <Button
              variant="ghost"
              size="sm"
              className="gap-1.5"
              onClick={() => void runAction(scheduledTaskActions.runNow(selected.id, selected.revision))}
            >
              <Zap aria-hidden="true" className="size-3.5" />
              {t('scheduledTasks.runNow')}
            </Button>
            {selected.status !== 'completed' ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  void runAction(
                    scheduledTaskActions.update(selected.id, { status: selected.status === 'paused' ? 'active' : 'paused' }, selected.revision)
                  )
                }
              >
                {t(selected.status === 'paused' ? 'scheduledTasks.resume' : 'scheduledTasks.pause')}
              </Button>
            ) : null}
            <Button variant="ghost" size="sm" className="gap-1.5" onClick={() => openEditor(selected)}>
              <Pencil aria-hidden="true" className="size-3.5" />
              {t('scheduledTasks.edit')}
            </Button>
            <Button variant="destructive" size="sm" className="gap-1.5" onClick={() => setConfirm({ kind: 'deleteTask', task: selected })}>
              <X aria-hidden="true" className="size-3.5" />
              {t('scheduledTasks.delete')}
            </Button>
          </div>
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col px-5 pb-4">
        <FadeScroll
          key={`${selected.id}:${selected.revision}`}
          data-scheduled-prompt
          data-file-markdown
          role="region"
          aria-label={t('scheduledTasks.editor.prompt')}
          tabIndex={0}
          className="min-h-0 flex-1 rounded-item focus-visible:outline-1 focus-visible:-outline-offset-2 focus-visible:outline-ring"
        >
          <div className="rounded-item bg-muted/50 px-3 py-2">
            <Markdown>{selected.prompt}</Markdown>
          </div>
        </FadeScroll>
      </div>
    </div>
  ) : (
    <div className="grid flex-1 place-items-center">
      <p className="text-xs text-muted-foreground">{t('scheduledTasks.emptyTitle')}</p>
    </div>
  )

  const selectedRunOutput = selectedRun && runOutput?.runId === selectedRun.id ? runOutput.text : null
  const runOutputLoading = selectedRun !== null && runOutput?.runId !== selectedRun.id
  const historyDetail = selectedRun ? (
    <div className="flex min-h-0 flex-1 flex-col" data-scheduled-run-detail={selectedRun.id}>
      <div className="shrink-0 border-b border-border/60 px-5 pb-3 pt-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-foreground">{selectedRun.taskName}</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t(`scheduledTasks.run.status.${selectedRun.status}`)} · {t(`scheduledTasks.run.trigger.${selectedRun.trigger}`)}
            </p>
            <p className="mt-0.5 text-caption tabular-nums text-muted-foreground">
              {t('scheduledTasks.run.scheduledFor', { time: formatDateTime(selectedRun.scheduledFor, locale) })}
              {selectedRun.startedAt ? ` · ${t('scheduledTasks.run.startedAt', { time: formatDateTime(selectedRun.startedAt, locale) })}` : ''}
              {selectedRun.finishedAt ? ` · ${t('scheduledTasks.run.finishedAt', { time: formatDateTime(selectedRun.finishedAt, locale) })}` : ''}
            </p>
            {selectedRun.cwd ? <p className="mt-0.5 break-all text-caption text-muted-foreground">{selectedRun.cwd}</p> : null}
          </div>
          <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
            {selectedRun.sessionPath ? (
              <Button variant="ghost" size="sm" onClick={() => void runAction(onOpenRunSession(selectedRun.sessionPath!))}>
                {t('scheduledTasks.run.open')}
              </Button>
            ) : null}
            {isScheduledTaskRunActive(selectedRun) ? (
              <Button variant="destructive" size="sm" onClick={() => void runAction(scheduledTaskActions.cancelRun(selectedRun.id))}>
                {t('scheduledTasks.run.cancel')}
              </Button>
            ) : null}
            {!isScheduledTaskRunActive(selectedRun) && !selectedRun.readAt ? (
              <Button variant="ghost" size="sm" onClick={() => void runAction(scheduledTaskActions.markRead(selectedRun.id))}>
                {t('scheduledTasks.run.markRead')}
              </Button>
            ) : null}
            {!isScheduledTaskRunActive(selectedRun) ? (
              <Button variant="destructive" size="sm" onClick={() => setConfirm({ kind: 'deleteRun', run: selectedRun })}>
                {t('scheduledTasks.run.delete')}
              </Button>
            ) : null}
          </div>
        </div>
        {selectedRun.error ? <p role="alert" className="mt-2 whitespace-pre-wrap text-xs leading-ui text-destructive">{selectedRun.error}</p> : null}
      </div>
      <div className="flex min-h-0 flex-1 flex-col px-5 pb-4 pt-3">
        <h3 className="mb-2 shrink-0 text-xs font-medium text-foreground">{t('scheduledTasks.run.output')}</h3>
        <FadeScroll
          key={selectedRun.id}
          data-scheduled-run-output
          data-file-markdown
          role="region"
          aria-label={t('scheduledTasks.run.output')}
          tabIndex={0}
          className="min-h-0 flex-1 rounded-item focus-visible:outline-1 focus-visible:-outline-offset-2 focus-visible:outline-ring"
        >
          <div className="rounded-item bg-muted/50 px-3 py-2">
            {selectedRunOutput
              ? <Markdown>{selectedRunOutput}</Markdown>
              : <p className="text-xs text-muted-foreground">{t(runOutputLoading ? 'scheduledTasks.run.outputLoading' : isScheduledTaskRunActive(selectedRun) ? 'scheduledTasks.run.outputPending' : 'scheduledTasks.run.outputEmpty')}</p>}
          </div>
        </FadeScroll>
      </div>
    </div>
  ) : (
    <div className="grid flex-1 place-items-center">
      <p className="text-xs text-muted-foreground">{t(filteredRuns.length ? 'scheduledTasks.history.selectRun' : 'scheduledTasks.history.empty')}</p>
    </div>
  )

  return (
    <AnimatePresence initial={false}>
      {open ? (
        <motion.div
          initial={{ opacity: 0, x: reduce ? 0 : 24 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: reduce ? 0 : 24 }}
          transition={reduce ? { duration: 0 } : { duration: 0.22, ease: EASE_OUT }}
          className="window-page absolute inset-0 z-40 flex flex-col"
          // A full-page surface: the shortcut dispatcher's layer (no command
          // of its own — nothing passes through).
          data-shortcut-layer
          data-scheduled-tasks-view
        >
          <WindowTitlebar className="gap-1.5 border-b border-border/50">
            <Button variant="ghost" size="icon" aria-label={t('scheduledTasks.back')} onClick={onBack}>
              <ArrowLeft className="size-4" />
            </Button>
            <h1 className="flex items-center gap-2 px-1 text-sm font-semibold text-foreground">
              <CalendarCheck aria-hidden="true" className="size-4 text-muted-foreground" />
              {t('scheduledTasks.title')}
            </h1>
            <div className="ml-auto flex items-center gap-1.5">
              {view === 'history' && filteredRuns.some((run) => !isScheduledTaskRunActive(run)) ? (
                <Button
                  variant="destructive"
                  size="sm"
                  className="shrink-0"
                  onClick={() => setConfirm({ kind: 'cleanup', ids: filteredRuns.filter((run) => !isScheduledTaskRunActive(run)).map((run) => run.id) })}
                >
                  {t('scheduledTasks.runs.cleanup')}
                </Button>
              ) : null}
              <Button variant="primary" size="sm" className="gap-1.5" onClick={() => openEditor(null)}>
                <Plus aria-hidden="true" className="size-3.5" />
                {t('scheduledTasks.new')}
              </Button>
            </div>
          </WindowTitlebar>

          <nav aria-label={t('scheduledTasks.views')} className="flex shrink-0 gap-1 border-b border-border/60 px-3 py-1.5">
            <Button variant={view === 'tasks' ? 'secondary' : 'ghost'} size="sm" className={view === 'tasks' ? 'bg-muted' : undefined} aria-current={view === 'tasks' ? 'page' : undefined} onClick={() => { setView('tasks'); setQuery(''); setMobileDetail(false) }}>
              {t('scheduledTasks.views.tasks')} · {tasks.length}
            </Button>
            <Button variant={view === 'history' ? 'secondary' : 'ghost'} size="sm" className={view === 'history' ? 'bg-muted' : undefined} aria-current={view === 'history' ? 'page' : undefined} onClick={() => { setView('history'); setQuery(''); setMobileDetail(false) }}>
              {t('scheduledTasks.views.history')}{snapshot?.unreadCount ? ` · ${snapshot.unreadCount}` : ''}
            </Button>
          </nav>

          {error ? (
            <div className="grid flex-1 place-items-center">
              <div className="flex flex-col items-center gap-3">
                <p role="alert" className="flex items-center gap-1.5 text-xs text-destructive">
                  <AlertCircle aria-hidden="true" className="size-3.5" />
                  {t('scheduledTasks.loadError')}
                </p>
                <Button variant="ghost" size="sm" onClick={() => void refreshScheduledTasks()}>
                  {t('scheduledTasks.retry')}
                </Button>
              </div>
            </div>
          ) : view === 'history' ? (
            <div className="flex min-h-0 flex-1 flex-col md:flex-row">
              <div className={cn('flex min-h-0 w-full flex-col border-b border-border/60 md:w-72 md:shrink-0 md:border-b-0 md:border-r', mobileDetail && 'hidden md:flex')}>
                <div className="flex shrink-0 flex-col gap-1.5 px-3 py-2.5">
                  <Input value={query} onChange={(value) => { setQuery(value); setHistoryLimit(RUN_PAGE_SIZE) }} placeholder={t('scheduledTasks.history.search')} aria-label={t('scheduledTasks.history.search')} className="w-full min-w-0"  />
                  <div className="flex gap-1.5">
                    <Select value={runFilter} onValueChange={(value) => { setRunFilter(value as RunFilter); setHistoryLimit(RUN_PAGE_SIZE) }} className="min-w-0 flex-1">
                      <SelectTrigger aria-label={t('scheduledTasks.history.filter')} className="h-8 min-w-0 flex-1 whitespace-nowrap text-xs"><SelectValue /></SelectTrigger>
                      <SelectContent portal>
                        {(['all', 'unread', 'active', 'waiting', 'succeeded', 'failed', 'interrupted', 'cancelled'] as const).map((value) => (
                          <SelectItem key={value} value={value} className="text-xs">{t(`scheduledTasks.history.filter.${value}`)}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Select value={runSort} onValueChange={(value) => { setRunSort(value as RunSortOrder); setHistoryLimit(RUN_PAGE_SIZE) }} className="min-w-0 flex-1">
                      <SelectTrigger aria-label={t('scheduledTasks.history.sort')} className="h-8 min-w-0 flex-1 whitespace-nowrap text-xs"><SelectValue /></SelectTrigger>
                      <SelectContent portal portalWidth={160}>
                        <SelectItem value="newest" className="text-xs">{t('scheduledTasks.history.sort.newest')}</SelectItem>
                        <SelectItem value="oldest" className="text-xs">{t('scheduledTasks.history.sort.oldest')}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <FadeScroll className="min-h-0 flex-1">
                  <div className="flex flex-col gap-0.5 px-2 pb-2">
                    {runGroups.length ? runGroups.map((group) => (
                      <section key={group.key} data-scheduled-run-group={group.key} aria-label={group.label}>
                        <h3 className="px-2.5 pb-1 pt-3 text-caption font-medium text-muted-foreground">{group.label}</h3>
                        {group.runs.map((run) => (
                          <button
                            key={run.id}
                            type="button"
                            data-scheduled-run={run.id}
                            onClick={() => { setSelectedRunId(run.id); setMobileDetail(true) }}
                            className={cn('flex w-full items-start gap-2 rounded-control px-2.5 py-2 text-left transition-colors hover:bg-accent/60', selectedRun?.id === run.id && 'bg-accent')}
                          >
                            <RunStatusDot status={run.status} />
                            <span className="min-w-0 flex-1">
                              <span className="flex items-center gap-1.5">
                                <span className="truncate text-xs font-medium text-foreground">{run.taskName}</span>
                                {!isScheduledTaskRunActive(run) && !run.readAt ? <span aria-label={t('scheduledTasks.unread', { count: 1 })} className="size-1.5 shrink-0 rounded-full bg-primary" /> : null}
                              </span>
                              <span className="mt-0.5 block truncate text-caption text-muted-foreground">
                                {formatDateTime(run.startedAt ?? run.scheduledFor, locale)} · {t(`scheduledTasks.run.status.${run.status}`)}
                              </span>
                            </span>
                          </button>
                        ))}
                      </section>
                    )) : <p className="py-6 text-center text-xs text-muted-foreground">{t('scheduledTasks.history.empty')}</p>}
                    {filteredRuns.length > historyLimit ? <Button variant="ghost" size="sm" onClick={() => setHistoryLimit((limit) => limit + RUN_PAGE_SIZE)}>{t('scheduledTasks.history.showMore')}</Button> : null}
                  </div>
                </FadeScroll>
              </div>
              <div className={cn('min-h-0 flex-1 flex-col md:flex', mobileDetail ? 'flex' : 'hidden md:flex')}>{historyDetail}</div>
            </div>
          ) : !tasks.length ? (
            <div className="grid flex-1 place-items-center px-6">
              <div className="flex w-full max-w-2xl flex-col items-center gap-4 text-center">
                <CalendarCheck aria-hidden="true" className="size-8 text-muted-foreground/50" />
                <div>
                  <h2 className="text-sm font-semibold text-foreground">{t('scheduledTasks.emptyTitle')}</h2>
                  <p className="mt-1.5 text-xs leading-ui text-muted-foreground">{t('scheduledTasks.emptyBody')}</p>
                </div>
                <div className="flex items-center justify-center gap-2">
                  {exampleDrafts.map((example) => (
                    <Button key={example.key} variant="ghost" size="sm" onClick={() => openEditor(null, example.draft)}>
                      {example.draft.name}
                    </Button>
                  ))}
                  <Button variant="primary" size="sm" className="gap-1.5" onClick={() => openEditor(null)}>
                    <Plus aria-hidden="true" className="size-3.5" />
                    {t('scheduledTasks.new')}
                  </Button>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col md:flex-row">
              {/* List column: hidden on narrow windows while the detail shows. */}
              <div className={cn('flex min-h-0 w-full flex-col border-b border-border/60 md:w-72 md:shrink-0 md:border-b-0 md:border-r', mobileDetail && 'hidden md:flex')}>
                <div className="flex shrink-0 gap-1.5 px-3 py-2.5">
                  <Input
                    value={query}
                    onChange={setQuery}
                    placeholder={t('scheduledTasks.search')}
                    aria-label={t('scheduledTasks.search')}
                    className="flex-1"

                  />
                  <Select value={statusFilter} onValueChange={(value) => setStatusFilter(value as StatusFilter)}>
                    <SelectTrigger aria-label={t('scheduledTasks.filter.all')} className="h-8 w-24 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent portal>
                      {(['all', 'active', 'paused', 'completed'] as const).map((value) => (
                        <SelectItem key={value} value={value} className="text-xs">
                          {t(`scheduledTasks.filter.${value}`)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <FadeScroll className="min-h-0 flex-1">
                  <div className="flex flex-col gap-0.5 px-2 pb-2">
                    {filtered.length ? (
                      filtered.map((task) => {
                        const unread = unreadByTask.get(task.id) ?? 0
                        return (
                          <button
                            key={task.id}
                            type="button"
                            data-scheduled-task={task.id}
                            onClick={() => {
                              setSelectedId(task.id)
                              setMobileDetail(true)
                            }}
                            className={cn(
                              'flex w-full items-start gap-2 rounded-control px-2.5 py-2 text-left transition-colors hover:bg-accent/60',
                              selected?.id === task.id && 'bg-accent'
                            )}
                          >
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-1.5">
                                <span className="truncate text-xs font-medium text-foreground">{task.name}</span>
                                {unread ? <span aria-label={t('scheduledTasks.unread', { count: unread })} className="size-1.5 shrink-0 rounded-full bg-primary" /> : null}
                              </div>
                              <p className="mt-0.5 truncate text-caption text-muted-foreground">
                                {scheduleText(task.schedule, t)}
                                {taskNextRunText(task, t, locale) ? ` · ${taskNextRunText(task, t, locale)}` : ''}
                              </p>
                            </div>
                            <span
                              className={cn(
                                'mt-0.5 shrink-0 rounded-control px-1.5 py-px text-micro leading-ui-tight',
                                task.status === 'active'
                                  ? 'bg-primary/10 text-primary'
                                  : task.status === 'paused'
                                    ? 'bg-muted text-muted-foreground'
                                    : 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                              )}
                            >
                              {t(`scheduledTasks.status.${task.status}`)}
                            </span>
                          </button>
                        )
                      })
                    ) : (
                      <p className="py-6 text-center text-xs text-muted-foreground">
                        <Search aria-hidden="true" className="mr-1 inline size-3.5" />
                        {t('scheduledTasks.emptyTitle')}
                      </p>
                    )}
                  </div>
                </FadeScroll>
              </div>
              <div className={cn('min-h-0 flex-1 flex-col md:flex', mobileDetail ? 'flex' : 'hidden md:flex')}>{detail}</div>
            </div>
          )}

          {actionError ? (
            <p role="alert" className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-item border border-destructive/40 bg-background px-3 py-1.5 text-xs text-destructive shadow-overlay">
              <AlertCircle aria-hidden="true" className="size-3.5 shrink-0" />
              {actionError}
            </p>
          ) : null}

          {editorOpen ? <ScheduledTaskEditor
            key={editorTask?.id ?? editorDraft?.name ?? 'new'}
            open={editorOpen}
            onOpenChange={setEditorOpen}
            task={editorTask}
            draft={editorDraft}
            currentSessionId={currentSessionId}
            currentCwd={currentCwd}
            currentProjectless={currentProjectless}
            sessions={sessions}
            folders={folders}
            dedicatedRoot={snapshot?.dedicatedRoot ?? ''}
            models={models}
            onSaved={(saved) => setSelectedId(saved.id)}
          /> : null}

          <ConfirmDialog
            open={confirm?.kind === 'deleteTask'}
            title={t('scheduledTasks.deleteTitle')}
            message={confirm?.kind === 'deleteTask' ? t('scheduledTasks.deleteBody', { name: confirm.task.name }) : ''}
            confirmLabel={t('scheduledTasks.deleteConfirm')}
            onConfirm={() => {
              if (confirm?.kind === 'deleteTask') {
                void runAction(scheduledTaskActions.delete(confirm.task.id, confirm.task.revision))
                if (selectedId === confirm.task.id) setSelectedId(null)
              }
              setConfirm(null)
            }}
            onClose={() => setConfirm(null)}
          />
          <ConfirmDialog
            open={confirm?.kind === 'deleteRun'}
            title={t('scheduledTasks.run.deleteTitle')}
            message={t('scheduledTasks.run.deleteBody')}
            confirmLabel={t('scheduledTasks.deleteConfirm')}
            onConfirm={() => {
              if (confirm?.kind === 'deleteRun') void runAction(scheduledTaskActions.deleteRuns([confirm.run.id]))
              setConfirm(null)
            }}
            onClose={() => setConfirm(null)}
          />
          <ConfirmDialog
            open={confirm?.kind === 'cleanup'}
            title={t('scheduledTasks.runs.cleanupTitle')}
            message={confirm?.kind === 'cleanup' ? t('scheduledTasks.runs.cleanupBody', { count: confirm.ids.length }) : ''}
            confirmLabel={t('scheduledTasks.runs.cleanupConfirm')}
            onConfirm={() => {
              if (confirm?.kind === 'cleanup') void runAction(scheduledTaskActions.deleteRuns(confirm.ids))
              setConfirm(null)
            }}
            onClose={() => setConfirm(null)}
          />
        </motion.div>
      ) : null}
    </AnimatePresence>
  )
})
