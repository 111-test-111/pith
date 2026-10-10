import { useEffect, useId, useRef, useState } from 'react'
import { AgentDisclosure } from '@/components/agents/agent-disclosure'
import { Input } from '@/components/motion/input'
import { Button } from '@/components/motion/button'
import { ChevronDown, CircleCheck, CircleHelp } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { FORM_INPUT_LABEL } from '@/lib/form-standard'
import { useI18n } from '@/i18n'
import type { GoalUIState } from '@/state/pi-store'
import { FadeScroll } from './FadeScroll'
import { GOAL_MAX_CRITERIA, validGoalCriteria, validGoalLimits, type GoalCriterionInput, type GoalErrorCode, type GoalSnapshotDTO } from '../../../../shared/goal'

export function GoalPanel({ sessionPath, goal, seq, busy, restricted, visible, ui, onDraft, onEnd, onState }: {
  sessionPath: string; goal: GoalSnapshotDTO | null; seq: number; busy: boolean; restricted: boolean; visible: boolean; ui: GoalUIState
  onDraft: (draft: Pick<GoalUIState, 'limits' | 'acceptance'>) => void
  onEnd: () => void
  onState: (path: string, goal: GoalSnapshotDTO | null, seq: number) => void
}) {
  const { t } = useI18n()
  const baseId = useId()
  const [runs, setRuns] = useState(String(ui.limits.maxAutoRuns))
  const [tokens, setTokens] = useState(ui.limits.tokenBudget == null ? '' : String(ui.limits.tokenBudget))
  const [acting, setActing] = useState(false)
  const [error, setError] = useState<GoalErrorCode | null>(null)
  const [editing, setEditing] = useState(false)
  const [objective, setObjective] = useState('')
  const [draftRevision, setDraftRevision] = useState(0)
  const draftGoal = useRef<string | null>(null)
  const [criteria, setCriteria] = useState<Array<GoalCriterionInput & { key: string }>>([])
  const nextKey = useRef(0)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [objectiveExpanded, setObjectiveExpanded] = useState(false)
  const [limitsExpanded, setLimitsExpanded] = useState(false)
  const [inputExpanded, setInputExpanded] = useState(false)
  useEffect(() => {
    if (!visible || !goal) return
    let disposed = false
    void window.pi.goalAction({ sessionPath, expectedSeq: seq, goalId: goal.id, action: 'inspect' }).then(result => {
      if (!disposed && result.ok) onState(sessionPath, result.goal, result.seq)
    }).catch(() => {})
    return () => { disposed = true }
    // Opening refreshes disk observations; ordinary metadata must not loop IPC.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, sessionPath, goal?.id])
  useEffect(() => {
    setExpanded({}); setObjectiveExpanded(false); setLimitsExpanded(false); setInputExpanded(false)
  }, [goal?.id])
  useEffect(() => {
    if (editing && draftGoal.current === goal?.id) return
    draftGoal.current = goal?.id ?? null
    setObjective(goal?.objective ?? '')
    setDraftRevision(goal?.criteriaRevision ?? 0)
    setCriteria(goal?.criteria.map(c => ({ id: c.id, text: c.text, key: c.id })) ?? [])
    setEditing(false)
  }, [goal?.id, goal?.criteriaRevision, editing])
  useEffect(() => {
    if (!goal) return
    setRuns(String(goal.limits.maxAutoRuns))
    setTokens(goal.limits.tokenBudget == null ? '' : String(goal.limits.tokenBudget))
  }, [goal?.id, goal?.limits.maxAutoRuns, goal?.limits.tokenBudget])
  const pending = acting || ui.pending
  const terminal = !goal || goal.status === 'completed' || goal.status === 'cancelled'
  const active = goal?.status === 'active' || goal?.status === 'verifying'
  const canExpandObjective = !!goal && (goal.objective.length > 300 || goal.objective.split('\n').length > 4)
  const limits = { maxAutoRuns: Number(runs), tokenBudget: tokens.trim() ? Number(tokens) : null }
  const valid = validGoalLimits(limits)
  const editLimits = (nextRuns: string, nextTokens: string) => {
    setRuns(nextRuns); setTokens(nextTokens)
    onDraft({ acceptance: ui.acceptance, limits: { maxAutoRuns: Number(nextRuns), tokenBudget: nextTokens.trim() ? Number(nextTokens) : null } })
  }
  const canEdit = !!goal && goal.status !== 'cancelled' && !pending && goal.accountingAvailable
  const act = async (action: 'pause' | 'resume' | 'limits' | 'definition') => {
    if (pending || !goal) return
    setActing(true); setError(null)
    const identity = { sessionPath, expectedSeq: seq, goalId: goal.id }
    try {
      const result = await window.pi.goalAction(action === 'limits' ? { ...identity, action, limits } : action === 'definition' ?
        { ...identity, action, objective, criteriaRevision: draftRevision, criteria: criteria.map(({ id, text }) => ({ ...(id ? { id } : {}), text })) } : { ...identity, action })
      if (result.ok) { onState(sessionPath, result.goal, result.seq); if (action === 'definition') setEditing(false) }
      else setError(result.code)
    } catch { setError('unavailable') }
    finally { setActing(false) }
  }
  return <div data-goal-panel>
    <FadeScroll className="max-h-[min(55vh,25rem)] p-4">
      {goal ? <div className="flex flex-col gap-4 text-sm" data-goal-status={goal.status}>
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <span className="font-medium">{t(`goal.status.${goal.status}`)}</span>
          <span className="text-xs tabular-nums text-muted-foreground">{goal.accountingAvailable ? t(goal.limits.tokenBudget == null ? 'goal.usage' : 'goal.usageLimited', {
            runs: goal.autoRuns, max: goal.limits.maxAutoRuns, tokens: goal.tokens, budget: goal.limits.tokenBudget ?? ''
          }) : t('goal.accountingUnavailable')}</span>
        </div>
        {editing ? <div className="grid grid-cols-1 gap-5 md:grid-cols-2" data-form-items data-goal-criteria-editor>
          <Input className="md:col-span-2" multiline rows={3} maxLength={8000} classNames={FORM_INPUT_LABEL} label={t('goal.objective')}
            value={objective} disabled={!canEdit} onChange={setObjective} data-goal-objective-input />
          <div className="flex flex-col gap-3 md:col-span-2">
            <p className="text-xs font-medium" data-goal-acceptance-label>{t('goal.acceptance')}</p>
            {criteria.map((c, index) => <div key={c.key} className="flex items-start gap-2">
              <Input className="flex-1" multiline rows={2} maxLength={8000} classNames={FORM_INPUT_LABEL} label={t('goal.criterionLabel', { number: index + 1 })}
                value={c.text} disabled={!canEdit} onChange={text => setCriteria(rows => rows.map(row => row.key === c.key ? { ...row, text } : row))} data-goal-criterion-input={c.key} />
              <Button size="sm" variant="ghost" disabled={!canEdit || criteria.length === 1} onClick={() => setCriteria(rows => rows.filter(row => row.key !== c.key))} data-goal-criterion-remove={c.key}>{t('goal.removeCriterion')}</Button>
            </div>)}
          </div>
          <div className="flex flex-wrap gap-2 md:col-span-2">
            <Button size="sm" variant="secondary" disabled={!canEdit || criteria.length >= GOAL_MAX_CRITERIA} data-goal-action="addCriterion" onClick={() => setCriteria(rows => [...rows, { key: `new-${++nextKey.current}`, text: '' }])}>{t('goal.addCriterion')}</Button>
            <Button size="sm" disabled={!canEdit || !objective.trim() || !validGoalCriteria(criteria)} data-goal-action="saveCriteria" onClick={() => void act('definition')}>{t('goal.saveDefinition')}</Button>
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => setEditing(false)}>{t('goal.discardCriteria')}</Button>
          </div>
          <p className="text-xs text-muted-foreground md:col-span-2">{t('goal.criteriaHint')}</p>
        </div> : <>
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs font-medium">{t('goal.objective')}</p>
              <Button size="sm" variant="ghost" disabled={!canEdit} data-goal-action="editCriteria" onClick={() => setEditing(true)}>{t('goal.editDefinition')}</Button>
            </div>
            <p className={cn('whitespace-pre-wrap break-words', canExpandObjective && !objectiveExpanded && 'line-clamp-4')} data-goal-objective>{goal.objective}</p>
            {canExpandObjective ? <Button className="self-start" size="sm" variant="ghost" aria-expanded={objectiveExpanded}
              onClick={() => setObjectiveExpanded(value => !value)}>{t(objectiveExpanded ? 'goal.showLess' : 'goal.showMore')}</Button> : null}
          </div>
          <div className="flex flex-col gap-2" data-goal-criteria>
            <div className="flex items-baseline justify-between gap-3">
              <p className="text-xs font-medium" data-goal-acceptance-label>{t('goal.acceptance')}</p>
              <span className="text-xs tabular-nums text-muted-foreground">{t('goal.criteriaProgress', { verified: goal.criteria.filter(c => c.state === 'verified').length, total: goal.criteria.length })}</span>
            </div>
            {goal.criteria.map((c, index) => {
              const show = !!expanded[c.id], proofId = `${baseId}-proof-${index}`
              const canExpandText = c.text.length > 200 || c.text.split('\n').length > 3
              const Icon = c.state === 'verified' ? CircleCheck : CircleHelp
              return <div key={c.id} className="border-t border-border/60 pt-3" data-goal-criterion={c.id} data-criterion-state={c.state}>
                <div className="flex items-start gap-2">
                  <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <div className="min-w-0 flex-1">
                    <p className={cn('whitespace-pre-wrap break-words text-sm', canExpandText && !show && 'line-clamp-3')}>{c.text}</p>
                    <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
                      <span className="text-xs text-muted-foreground">{t(`goal.criterion.${c.state}`)}</span>
                      {c.proof || canExpandText ? <Button size="sm" variant="ghost" aria-expanded={show} aria-controls={c.proof ? proofId : undefined} data-goal-proof-toggle={c.id}
                        onClick={() => setExpanded(rows => ({ ...rows, [c.id]: !show }))}>
                        {t(c.proof ? 'goal.evidence' : show ? 'goal.showLess' : 'goal.showMore')}
                        <ChevronDown className={cn('size-3 text-muted-foreground transition-transform', show && 'rotate-180')} aria-hidden="true" />
                      </Button> : null}
                    </div>
                    {c.proof ? <AgentDisclosure open={show} id={proofId}>
                      <div className="flex flex-col gap-2 py-2 text-xs">
                        <p className="text-muted-foreground">{t('goal.criteriaVersion', { revision: goal.criteriaRevision })}</p>
                        <p className="whitespace-pre-wrap break-words" data-criterion-proof>{c.proof.summary}</p>
                        <p className="break-all text-muted-foreground">{t('goal.evidenceSources', { ids: c.proof.sources.map(s => s.id).join(', ') })}</p>
                        {Object.entries(c.files ?? {}).map(([path, version]) => <p key={path} className="truncate font-mono text-muted-foreground" title={`${path} · ${version}`} data-criterion-file={path}>{path} · {version.slice(0, 12)}</p>)}
                      </div>
                    </AgentDisclosure> : null}
                  </div>
                </div>
              </div>
            })}
          </div>
        </>}
        {goal.status === 'completed' ? <p className="text-xs text-muted-foreground" data-goal-completed>{t('goal.completedHint')}</p> : null}
        {goal.status === 'verifying' ? <p role="status" className="text-xs text-muted-foreground">{t('goal.finalizingHint')}</p> : null}
        {goal.evidenceBlocked ? <p role="status" className="text-xs text-destructive">{t('goal.failedChecks')}</p> : null}
        {goal.evidenceOmitted && Object.values(expanded).some(Boolean) ? <p className="text-xs text-muted-foreground">{t('goal.evidenceOmitted', { count: goal.evidenceOmitted })}</p> : null}
        {goal.reason ? <p role="status" className="text-xs text-muted-foreground">{t(`goal.reason.${goal.reason}`)}</p> : null}
        {goal.waiting && goal.status !== 'verifying' ? <p className="text-xs text-muted-foreground">{t('goal.waiting')}</p> : null}
        {goal.status === 'blocked' && goal.evidence ? <p className="whitespace-pre-wrap break-words text-xs" data-goal-evidence>{goal.evidence}</p> : null}
        {goal.pendingInput ? <div data-goal-pending-input className="flex flex-col gap-1.5 text-xs text-muted-foreground">
          <p>{t(goal.pendingInput.available ? 'goal.pendingInput' : 'goal.inputUnavailable', { files: goal.pendingInput.files.length, images: goal.pendingInput.imageCount })}</p>
          {goal.pendingInput.files.length ? <>
            <Button size="sm" variant="ghost" className="self-start" aria-expanded={inputExpanded} onClick={() => setInputExpanded(value => !value)}>{t('goal.attachments')}</Button>
            {inputExpanded ? goal.pendingInput.files.map((path, index) => <p key={`${index}:${path}`} className="truncate font-mono" title={path}>{path}</p>) : null}
          </> : null}
        </div> : null}
        {!terminal || goal.billing ? <div className="border-t border-border/60 pt-2">
          <Button size="sm" variant="ghost" aria-expanded={limitsExpanded} aria-controls={`${baseId}-limits`} data-goal-action="showLimits" onClick={() => setLimitsExpanded(value => !value)}>
            {t('goal.limits')}<ChevronDown className={cn('size-3 text-muted-foreground transition-transform', limitsExpanded && 'rotate-180')} aria-hidden="true" />
          </Button>
          <AgentDisclosure open={limitsExpanded} id={`${baseId}-limits`}>
            <div className="flex flex-col gap-3 pt-3">
              {goal.billing ? <div className="flex flex-col gap-1.5 text-xs text-muted-foreground" data-goal-billing>
                <p>{t('goal.billingBreakdown', { parent: goal.billing.parentTokens, subagents: goal.billing.subagentTokens, jev: goal.billing.jevTokens })}</p>
                {goal.billing.unresolved ? <p role="status">{t('goal.billingUnresolved', { count: goal.billing.unresolved })}</p> : null}
              </div> : null}
              {!terminal ? <div data-form-items className="grid grid-cols-1 gap-5 md:grid-cols-2">
                <Input type="number" min={1} max={1000} step={1} classNames={FORM_INPUT_LABEL} label={t('goal.maxRuns')} value={runs} onChange={value => editLimits(value, tokens)} disabled={pending || busy} data-goal-input="runs" />
                <Input type="number" min={1} max={1_000_000_000} step={1} classNames={FORM_INPUT_LABEL} label={t('goal.tokenBudget')} placeholder={t('goal.noTokenLimit')} value={tokens} onChange={value => editLimits(runs, value)} disabled={pending || busy} data-goal-input="tokens" />
              </div> : null}
              <p className="text-xs text-muted-foreground">{t('goal.budgetHint')}</p>
              {!terminal ? <Button className="self-start" size="sm" variant="secondary" disabled={pending || busy || !valid || goal.reason === 'storage'} data-goal-action="limits" onClick={() => void act('limits')}>{t('goal.saveLimits')}</Button> : null}
            </div>
          </AgentDisclosure>
        </div> : null}
        {restricted && !terminal && goal.reason !== 'plan' ? <p role="status" className="text-xs text-muted-foreground">{t('goal.reason.plan')}</p> : null}
        {error ? <p role="alert" className="text-xs text-destructive">{t(`goal.error.${error}`)}</p> : null}
      </div> : <p className="text-xs text-muted-foreground">{t('goal.intro')}</p>}
    </FadeScroll>
    <div className="flex items-center justify-between gap-2 border-t border-border/60 px-4 py-3">
      <div>{!terminal && !editing ? active ? <Button size="sm" variant="secondary" disabled={pending} onClick={() => void act('pause')} data-goal-action="pause">{t('goal.pause')}</Button> :
        <Button size="sm" disabled={pending || busy || restricted || !goal?.accountingAvailable || goal?.pendingInput?.available === false} onClick={() => void act('resume')} data-goal-action="resume">{t('goal.resume')}</Button> : null}</div>
      <Button size="sm" variant="secondary" disabled={pending} data-goal-action="end" onClick={onEnd}>{t('goal.end')}</Button>
    </div>
  </div>
}
