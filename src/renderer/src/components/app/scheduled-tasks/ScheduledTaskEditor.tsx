import { memo, useMemo, useState } from 'react'
import { AlertCircle, FolderOpen } from '@/lib/icons'
import { Button } from '@/components/motion/button'
import { Input } from '@/components/motion/input'
import { Checkbox } from '@/components/motion/checkbox'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/motion/select'
import { CenterMorphModal, CenterMorphModalContent } from '@/components/motion/center-morph-modal'
import { useI18n } from '@/i18n'
import { DateTimeField } from './DateTimeField'
import { TimeOfDayField } from './TimePicker'
import { TimeZoneField, isValidTimeZone } from './TimeZoneField'
import { ScheduledSearchSelect } from './ScheduledSearchSelect'
import { refreshScheduledTasks, scheduledErrorStatus } from '@/state/scheduled-tasks-store'
import { ModelPicker } from '../ModelPicker'
import { SandboxModePicker } from '../SandboxModePicker'
import { FadeScroll } from '../FadeScroll'
import { FORM_FIELD_TITLE, FORM_PANEL_TITLE } from '@/lib/form-standard'
import type { ModelDTO, SandboxMode, SessionSummaryDTO, ThinkingLevel } from '../../../../../shared/types'
import type { ScheduledTask, ScheduledTaskInput, ScheduledTaskThinkingLevel } from '../../../../../shared/scheduled-tasks'

/**
 * New/edit editor on the app's modal family (CenterMorphModal). All validation
 * is app-side (no native bubbles): each failing field gets a semantic error
 * icon + message below it and focus moves to the first one. Saves carry the
 * task revision; a 409 surfaces the conflict line.
 */

export interface ScheduledTaskEditorProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** null = create. */
  task: ScheduledTask | null
  /** Create-mode prefill (the empty state's examples); never a saved record. */
  draft?: Partial<ScheduledTask> | null
  /** The conversation manual creation initially targets. */
  currentSessionId: string | null
  currentCwd: string | null
  currentProjectless: boolean
  sessions: readonly SessionSummaryDTO[]
  /** Known project folders for the directory dropdown. */
  folders: readonly string[]
  dedicatedRoot: string
  models: readonly ModelDTO[]
  onSaved: (task: ScheduledTask) => void
}

type ScheduleKind = ScheduledTaskInput['schedule']['type']

type Errors = Partial<Record<'name' | 'prompt' | 'project' | 'session' | 'at' | 'minutes' | 'time' | 'timeZone' | 'weekdays' | 'form', string>>

const THINKING_LEVELS: readonly ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/**
 * The folder picker sits in the project list as its own row, kept apart from
 * the known folders: a SelectItem value is what the trigger would echo, so a
 * sentinel intercepts the choice and opens the dialog without ever becoming
 * the field's value. No absolute path equals it.
 */
const BROWSE_PROJECT_DIRECTORY = '\u0000browse'

export const ScheduledTaskEditor = memo(function ScheduledTaskEditor({
  open,
  onOpenChange,
  task,
  draft,
  currentSessionId,
  currentCwd,
  currentProjectless,
  sessions,
  folders,
  dedicatedRoot,
  models,
  onSaved
}: ScheduledTaskEditorProps) {
  const { t } = useI18n()
  const editing = task !== null
  const seed = task ?? draft ?? null
  const [name, setName] = useState(seed?.name ?? '')
  const [prompt, setPrompt] = useState(seed?.prompt ?? '')
  const [targetKind, setTargetKind] = useState<'existing_session' | 'new_session'>(seed?.target?.type ?? 'new_session')
  const [project, setProject] = useState(seed?.target?.type === 'new_session' ? seed.target.cwd : (dedicatedRoot || (!currentProjectless && currentCwd) || folders[0] || ''))
  const [sessionId, setSessionId] = useState(seed?.target?.type === 'existing_session' ? seed.target.sessionId : (currentSessionId ?? ''))
  const [environment, setEnvironment] = useState<'local' | 'worktree'>(seed?.target?.type === 'new_session' ? seed.target.environment : 'local')
  // Existing weekly tasks keep their rule for editing, but new drafts cannot add one.
  const [scheduleKind, setScheduleKind] = useState<ScheduleKind>(!editing && seed?.schedule?.type === 'weekly' ? 'daily' : seed?.schedule?.type ?? 'daily')
  const [at, setAt] = useState<string | null>(() => {
    if (seed?.schedule?.type === 'once') return seed.schedule.at
    const date = new Date(Date.now() + 3600_000)
    date.setSeconds(0, 0)
    return date.toISOString()
  })
  const [minutes, setMinutes] = useState(seed?.schedule?.type === 'interval' ? String(seed.schedule.minutes) : '60')
  const [time, setTime] = useState(seed?.schedule?.type === 'daily' || seed?.schedule?.type === 'weekly' ? seed.schedule.time : '09:00')
  const [timeZone, setTimeZone] = useState(seed?.schedule?.type === 'daily' || seed?.schedule?.type === 'weekly' ? seed.schedule.timeZone : Intl.DateTimeFormat().resolvedOptions().timeZone)
  const [weekdays, setWeekdays] = useState<number[]>(seed?.schedule?.type === 'weekly' ? [...seed.schedule.weekdays] : [1, 2, 3, 4, 5])
  const [model, setModel] = useState(seed?.model ? `${seed.model.provider}/${seed.model.modelId}` : '')
  const [thinking, setThinking] = useState<ThinkingLevel | null>(seed?.thinkingLevel ?? null)
  const [permissionMode, setPermissionMode] = useState<SandboxMode | null>(seed?.permissionMode ?? null)
  const [status, setStatus] = useState<'active' | 'paused'>(seed?.status === 'paused' ? 'paused' : 'active')
  const [errors, setErrors] = useState<Errors>({})
  const [saving, setSaving] = useState(false)

  const projects = useMemo(() => {
    const datedRoot = `${dedicatedRoot}/`
    const all = [...folders, ...sessions.filter((session) => !session.projectless).map((session) => session.cwd)]
      .filter((value, index, values) => value && values.indexOf(value) === index)
      .filter((value) => !/^\d{4}-\d{2}-\d{2}$/.test(value.startsWith(datedRoot) ? value.slice(datedRoot.length) : ''))
    if (currentCwd && !currentProjectless && !all.includes(currentCwd)) all.unshift(currentCwd)
    if (project && !all.includes(project)) all.unshift(project)
    return all
  }, [folders, sessions, currentCwd, currentProjectless, project, dedicatedRoot])
  const selectedModel = useMemo(() => models.find((item) => `${item.providerId}/${item.id}` === model) ?? null, [models, model])
  const thinkingOptions = selectedModel?.thinkingLevels ?? (!selectedModel || selectedModel.reasoning ? THINKING_LEVELS : (['off'] as const))
  const projectOptions = useMemo(() => [
    ...(dedicatedRoot ? [{ value: dedicatedRoot, label: t('scheduledTasks.editor.projectDedicated') }] : []),
    ...projects.filter((value) => value !== dedicatedRoot).map((value) => ({ value, label: value }))
  ], [projects, dedicatedRoot, t])
  const sessionOptions = useMemo(() => {
    const options = sessions.map((item) => ({ value: item.id, label: `${item.label ?? item.id} · ${item.cwd}` }))
    if (sessionId && !options.some((item) => item.value === sessionId)) options.unshift({ value: sessionId, label: sessionId })
    return options
  }, [sessions, sessionId])

  const browseProjectDirectory = async () => {
    const result = await window.pi.scheduledPickDirectory()
    // A cancelled dialog keeps the current folder; there is nothing to undo.
    if ('path' in result) setProject(result.path)
  }

  const validate = (): Errors => {
    const next: Errors = {}
    if (!name.trim()) next.name = t('scheduledTasks.editor.nameRequired')
    if (!prompt.trim()) next.prompt = t('scheduledTasks.editor.promptRequired')
    if (targetKind === 'new_session' && !project.trim()) next.project = t('scheduledTasks.editor.projectRequired')
    if (targetKind === 'existing_session' && !sessionId) next.session = t('scheduledTasks.editor.sessionRequired')
    if (scheduleKind === 'once' && (!at || !Number.isFinite(Date.parse(at)) || Date.parse(at) <= Date.now())) next.at = t('scheduledTasks.editor.atRequired')
    if (scheduleKind === 'interval') {
      const value = Number(minutes)
      if (!Number.isSafeInteger(value) || value < 1 || value > 525600) next.minutes = t('scheduledTasks.editor.minutesInvalid')
    }
    if ((scheduleKind === 'daily' || scheduleKind === 'weekly') && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) next.time = t('scheduledTasks.editor.timeInvalid')
    if ((scheduleKind === 'daily' || scheduleKind === 'weekly') && !isValidTimeZone(timeZone.trim())) next.timeZone = t('scheduledTasks.editor.timeZoneInvalid')
    if (scheduleKind === 'weekly' && !weekdays.length) next.weekdays = t('scheduledTasks.editor.weekdaysRequired')
    return next
  }

  const save = async () => {
    const next = validate()
    setErrors(next)
    if (Object.keys(next).length) return
    const schedule: ScheduledTaskInput['schedule'] =
      scheduleKind === 'once'
        ? { type: 'once', at: new Date(at!).toISOString() }
        : scheduleKind === 'interval'
          ? { type: 'interval', minutes: Number(minutes) }
          : scheduleKind === 'daily'
            ? { type: 'daily', time, timeZone: timeZone.trim() }
            : { type: 'weekly', time, timeZone: timeZone.trim(), weekdays: [...weekdays].sort() }
    const target: ScheduledTaskInput['target'] =
      targetKind === 'existing_session'
        ? { type: 'existing_session', sessionId }
        : { type: 'new_session', cwd: project, environment: project === dedicatedRoot ? 'local' : environment }
    const input: ScheduledTaskInput = {
      name: name.trim(),
      prompt: prompt.trim(),
      target,
      schedule,
      status,
      ...(targetKind === 'new_session' && model ? { model: { provider: model.split('/')[0], modelId: model.slice(model.indexOf('/') + 1) } } : {}),
      ...(targetKind === 'new_session' && thinking ? { thinkingLevel: thinking as ScheduledTaskThinkingLevel } : {}),
      ...(targetKind === 'new_session' && permissionMode ? { permissionMode } : {})
    }
    setSaving(true)
    try {
      // Both IPC calls return the durable record; the store then refreshes so
      // the list/detail read the authoritative snapshot.
      const saved = editing
        ? await window.pi.scheduledUpdate(task.id, {
            ...input,
            // Updates merge with the saved record before normalization. Nulls
            // explicitly clear overrides when the target or picker changes.
            model: input.model ?? null,
            thinkingLevel: input.thinkingLevel ?? null,
            permissionMode: input.permissionMode ?? null
          }, task.revision)
        : await window.pi.scheduledCreate(input)
      await refreshScheduledTasks()
      onSaved(saved)
      onOpenChange(false)
    } catch (error) {
      setErrors({
        form:
          scheduledErrorStatus(error) === 409
            ? t('scheduledTasks.conflict')
            : error instanceof Error
              ? error.message
              : String(error)
      })
    } finally {
      setSaving(false)
    }
  }

  const field = (
    label: string,
    error: string | undefined,
    content: React.ReactNode,
    extra?: React.ReactNode
  ) => (
    <div className="flex flex-col gap-1.5">
      <span data-scheduled-field-title className={FORM_FIELD_TITLE}>{label}</span>
      {content}
      {error ? (
        <p role="alert" className="flex items-center gap-1 text-caption text-destructive">
          <AlertCircle aria-hidden="true" className="size-3 shrink-0" />
          {error}
        </p>
      ) : null}
      {extra}
    </div>
  )

  return (
    <CenterMorphModal open={open} onOpenChange={onOpenChange}>
      <CenterMorphModalContent ariaLabel={t(editing ? 'scheduledTasks.editor.editTitle' : 'scheduledTasks.editor.newTitle')} className="flex max-h-[min(43rem,calc(100vh-3rem))] w-[min(58rem,calc(100vw-3rem))] max-w-none flex-col gap-3 p-5">
        <h2 className={`shrink-0 pr-10 ${FORM_PANEL_TITLE}`}>
          {t(editing ? 'scheduledTasks.editor.editTitle' : 'scheduledTasks.editor.newTitle')}
        </h2>

        <FadeScroll className="min-h-0 flex-1 p-1">
          <div className="grid gap-5 md:grid-cols-2 md:grid-rows-[auto_auto_auto_auto_auto]">
            <div className="grid min-w-0 md:col-start-1 md:row-start-1 md:row-span-5 md:grid-rows-subgrid">

              {field(t('scheduledTasks.editor.name'), errors.name, (
                <Input value={name} onChange={setName} placeholder={t('scheduledTasks.editor.namePlaceholder')} aria-invalid={!!errors.name || undefined}  />
              ))}

              {field(t('scheduledTasks.editor.prompt'), errors.prompt, (
                <Input multiline rows={4} value={prompt} onChange={setPrompt} placeholder={t('scheduledTasks.editor.promptPlaceholder')} aria-invalid={!!errors.prompt || undefined} classNames={{ input: 'text-sm' }} />
              ))}

              {field(t('scheduledTasks.editor.target'), undefined, (
                <Select value={targetKind} onValueChange={(value) => setTargetKind(value as typeof targetKind)}>
                  <SelectTrigger aria-label={t('scheduledTasks.editor.target')} className="h-9 text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent portal>
                    <SelectItem value="new_session" className="text-sm">{t('scheduledTasks.editor.targetNew')}</SelectItem>
                    {sessions.length || sessionId ? <SelectItem value="existing_session" className="text-sm">{t('scheduledTasks.editor.targetCurrent')}</SelectItem> : null}
                  </SelectContent>
                </Select>
              ))}

              {targetKind === 'new_session'
                ? field(t('scheduledTasks.editor.project'), errors.project, (
                    <Select
                      value={project}
                      onValueChange={(value) => (value === BROWSE_PROJECT_DIRECTORY ? void browseProjectDirectory() : setProject(value))}
                    >
                      <SelectTrigger
                        aria-label={t('scheduledTasks.editor.project')}
                        className={`h-9 text-sm ${errors.project ? 'text-destructive hover:bg-destructive/10' : ''}`}
                      >
                        <SelectValue className={`truncate ${errors.project ? 'text-destructive' : ''}`} placeholder={t('scheduledTasks.editor.projectPlaceholder')} />
                      </SelectTrigger>
                      <SelectContent portal>
                        {projectOptions.map((option) => (
                          <SelectItem key={option.value} value={option.value} className="text-sm">{option.label}</SelectItem>
                        ))}
                        {/* The browse row is a different kind of choice, so it is set apart from the folder list. */}
                        <div role="separator" className="mx-1 my-1 border-t border-border/60" />
                        <SelectItem value={BROWSE_PROJECT_DIRECTORY} className="text-sm">
                          <span className="flex min-w-0 items-center gap-2">
                            <FolderOpen aria-hidden="true" className="size-3.5 shrink-0" />
                            <span className="truncate">{t('scheduledTasks.editor.projectBrowse')}</span>
                          </span>
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  ))
                : field(t('scheduledTasks.editor.session'), errors.session, (
                    <ScheduledSearchSelect value={sessionId} onChange={setSessionId} options={sessionOptions} label={t('scheduledTasks.editor.session')} invalid={!!errors.session} />
                  ))}

              {targetKind === 'new_session' && project !== dedicatedRoot ? field(t('scheduledTasks.editor.environment'), undefined, (
                <Select value={environment} onValueChange={(value) => setEnvironment(value as typeof environment)}>
                  <SelectTrigger aria-label={t('scheduledTasks.editor.environment')} className="h-9 text-sm"><SelectValue /></SelectTrigger>
                  <SelectContent portal>
                    <SelectItem value="local" className="text-sm">{t('scheduledTasks.editor.environmentLocal')}</SelectItem>
                    <SelectItem value="worktree" className="text-sm">{t('scheduledTasks.editor.environmentWorktree')}</SelectItem>
                  </SelectContent>
                </Select>
              ), <p className="text-caption leading-ui-tight text-muted-foreground">{t('scheduledTasks.editor.environmentHint')}</p>) : null}

            </div>
            <div className="grid min-w-0 md:col-start-2 md:row-start-1 md:row-span-5 md:grid-rows-subgrid">

              {field(t('scheduledTasks.editor.scheduleType'), undefined, (
                <Select value={scheduleKind} onValueChange={(value) => setScheduleKind(value as ScheduleKind)}>
                  <SelectTrigger aria-label={t('scheduledTasks.editor.scheduleType')} className="h-9 text-sm">
                    {scheduleKind === 'weekly' ? t('scheduledTasks.editor.schedule.weekly') : <SelectValue />}
                  </SelectTrigger>
                  <SelectContent portal>
                    <SelectItem value="once" className="text-sm">{t('scheduledTasks.editor.schedule.once')}</SelectItem>
                    <SelectItem value="interval" className="text-sm">{t('scheduledTasks.editor.schedule.interval')}</SelectItem>
                    <SelectItem value="daily" className="text-sm">{t('scheduledTasks.editor.schedule.daily')}</SelectItem>
                  </SelectContent>
                </Select>
              ))}

              <div className="flex min-w-0 flex-col gap-5">
                {scheduleKind === 'once' ? field(t('scheduledTasks.editor.at'), errors.at, <DateTimeField value={at} onChange={setAt} invalid={!!errors.at} />) : null}

                {scheduleKind === 'interval'
                  ? field(t('scheduledTasks.editor.minutes'), errors.minutes, (
                      <Input value={minutes} onChange={setMinutes} inputMode="numeric" aria-invalid={!!errors.minutes || undefined}  />
                    ))
                  : null}

                {scheduleKind === 'daily' || scheduleKind === 'weekly' ? (
                  <>
                    <div className="grid grid-cols-2 gap-5">
                      {field(t('scheduledTasks.editor.time'), errors.time, (
                        <TimeOfDayField value={time} onChange={setTime} invalid={!!errors.time} />
                      ))}
                      {field(t('scheduledTasks.editor.timeZone'), errors.timeZone, (
                        <TimeZoneField value={timeZone} onChange={setTimeZone} invalid={!!errors.timeZone} />
                      ))}
                    </div>
                    {scheduleKind === 'weekly'
                      ? field(t('scheduledTasks.editor.weekdays'), errors.weekdays, (
                          <div className="flex flex-wrap gap-3">
                            {([0, 1, 2, 3, 4, 5, 6] as const).map((day) => (
                              <label key={day} className="flex items-center gap-1.5 text-sm text-foreground">
                                <Checkbox
                                  checked={weekdays.includes(day)}
                                  onCheckedChange={(checked) =>
                                    setWeekdays((previous) => (checked === true ? [...previous, day] : previous.filter((item) => item !== day)))
                                  }
                                  aria-label={t(`scheduledTasks.weekday.full.${day}`)}
                                />
                                {t(`scheduledTasks.weekday.${day}`)}
                              </label>
                            ))}
                          </div>
                        ))
                      : null}
                  </>
                ) : null}

                {targetKind === 'new_session' ? (
                  <div className="border-t border-border/60 pt-3">
                    {field(t('scheduledTasks.editor.model'), undefined, (
                      <div className="w-fit max-w-full">
                        <ModelPicker
                          models={models}
                          value={model || null}
                          thinkingLevel={thinking}
                          availableThinkingLevels={thinkingOptions}
                          onChange={(item) => { setModel(`${item.providerId}/${item.id}`); setThinking(null) }}
                          onThinkingLevelChange={setThinking}
                          onInheritModel={() => { setModel(''); setThinking(null) }}
                          onInheritThinking={() => setThinking(null)}
                          inheritLabel={t('scheduledTasks.editor.modelDefault')}
                          portal
                          panelId="scheduled-model-picker-panel"
                          textClassName="text-sm"
                          disabled={saving}
                        />
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>

              {targetKind === 'new_session' ? field(t('scheduledTasks.editor.permission'), undefined, (
                <div className="w-fit max-w-full">
                  <SandboxModePicker mode={permissionMode} status={null} sessionPath={null} onModeChange={setPermissionMode} inheritLabel={t('scheduledTasks.editor.modelDefault')} portal textClassName="text-sm" disabled={saving} />
                </div>
              )) : null}

              {field(t('scheduledTasks.editor.status'), undefined, (
                <Select value={status} onValueChange={(value) => setStatus(value as typeof status)} disabled={saving}>
                  <SelectTrigger aria-label={t('scheduledTasks.editor.status')} className="h-9 text-sm"><SelectValue /></SelectTrigger>
                  <SelectContent portal>
                    <SelectItem value="active" className="text-sm">{t('scheduledTasks.status.active')}</SelectItem>
                    <SelectItem value="paused" className="text-sm">{t('scheduledTasks.status.paused')}</SelectItem>
                  </SelectContent>
                </Select>
              ))}

            </div>
          </div>
        </FadeScroll>

        {errors.form ? (
          <p role="alert" className="flex items-center gap-1.5 text-xs text-destructive">
            <AlertCircle aria-hidden="true" className="size-3.5 shrink-0" />
            {errors.form}
          </p>
        ) : null}

        <div className="mt-auto flex items-center justify-between gap-3 border-t border-border/60 pt-3">
          <p className="text-caption leading-ui-tight text-muted-foreground">{t('scheduledTasks.editor.environmentNote')}</p>
          <div className="flex shrink-0 gap-2">
            <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
              {t('scheduledTasks.editor.cancel')}
            </Button>
            <Button variant="primary" size="sm" disabled={saving} onClick={() => void save()}>
              {t(saving ? 'scheduledTasks.editor.saving' : 'scheduledTasks.editor.save')}
            </Button>
          </div>
        </div>
      </CenterMorphModalContent>
    </CenterMorphModal>
  )
})
