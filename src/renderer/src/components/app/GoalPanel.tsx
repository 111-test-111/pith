import { useEffect, useRef, useState } from 'react'
import { Input } from '@/components/motion/input'
import { Button } from '@/components/motion/button'
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
  const [runs, setRuns] = useState(String(ui.limits.maxAutoRuns))
  const [tokens, setTokens] = useState(ui.limits.tokenBudget == null ? '' : String(ui.limits.tokenBudget))
  const [acting, setActing] = useState(false)
  const [error, setError] = useState<GoalErrorCode | null>(null)
  const [editing, setEditing] = useState(false)
  const [criteria, setCriteria] = useState<Array<GoalCriterionInput & { key: string }>>([])
  const nextKey = useRef(0)
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
    setCriteria(goal?.criteria.map(c => ({ id: c.id, text: c.text, key: c.id })) ?? [])
    setEditing(false)
  }, [goal?.id, goal?.criteriaRevision])
  useEffect(() => {
    if (!goal) return
    setRuns(String(goal.limits.maxAutoRuns))
    setTokens(goal.limits.tokenBudget == null ? '' : String(goal.limits.tokenBudget))
  }, [goal?.id, goal?.limits.maxAutoRuns, goal?.limits.tokenBudget])
  const pending = acting || ui.pending
  const terminal = !goal || goal.status === 'completed' || goal.status === 'cancelled'
  const active = goal?.status === 'active' || goal?.status === 'verifying'
  const limits = { maxAutoRuns: Number(runs), tokenBudget: tokens.trim() ? Number(tokens) : null }
  const valid = validGoalLimits(limits)
  const editLimits = (nextRuns: string, nextTokens: string) => {
    setRuns(nextRuns); setTokens(nextTokens)
    onDraft({ acceptance: ui.acceptance, limits: { maxAutoRuns: Number(nextRuns), tokenBudget: nextTokens.trim() ? Number(nextTokens) : null } })
  }
  const canEdit = !!goal && goal.status !== 'cancelled' && !busy && !pending && !restricted && !goal.waiting && goal.accountingAvailable
  const act = async (action: 'pause' | 'resume' | 'limits' | 'criteria') => {
    if (pending || !goal) return
    setActing(true); setError(null)
    const identity = { sessionPath, expectedSeq: seq, goalId: goal.id }
    try {
      const result = await window.pi.goalAction(action === 'limits' ? { ...identity, action, limits } : action === 'criteria' ?
        { ...identity, action, criteriaRevision: goal.criteriaRevision, criteria: criteria.map(({ id, text }) => ({ ...(id ? { id } : {}), text })) } : { ...identity, action })
      if (result.ok) { onState(sessionPath, result.goal, result.seq); if (action === 'criteria') setEditing(false) }
      else setError(result.code)
    } catch { setError('unavailable') }
    finally { setActing(false) }
  }
  return <div data-goal-panel>
    <FadeScroll className="max-h-[min(55vh,25rem)] p-4">
      <div className="flex flex-col gap-4 text-sm">
        {goal ? <div className="flex flex-col gap-1.5" data-goal-status={goal.status}>
          <div className="flex flex-wrap items-center justify-between gap-2"><span className="font-medium">{t(`goal.status.${goal.status}`)}</span>
            <span className="text-xs tabular-nums text-muted-foreground">{goal.accountingAvailable ? t('goal.usage', { runs: goal.autoRuns, max: goal.limits.maxAutoRuns, tokens: goal.tokens }) : t('goal.accountingUnavailable')}</span></div>
          <p className="mt-1 text-xs font-medium">{t('goal.objective')}</p>
          <p className="whitespace-pre-wrap break-words" data-goal-objective>{goal.objective}</p>
          <p className="mt-1 text-xs font-medium">{t('goal.acceptance')}</p>
          <p className="text-xs text-muted-foreground">{t('goal.criteriaProgress', { verified: goal.criteria.filter(c => c.state === 'verified').length, total: goal.criteria.length, revision: goal.criteriaRevision })}</p>
          <div className="flex flex-col gap-3" data-goal-criteria>
            {goal.criteria.map(c => <div key={c.id} className="flex flex-col gap-1.5 border-l border-border pl-3" data-goal-criterion={c.id} data-criterion-state={c.state}>
              <p className="whitespace-pre-wrap break-words text-xs">{c.text}</p>
              <span className="text-xs text-muted-foreground">{t(`goal.criterion.${c.state}`)}</span>
              {c.proof ? <>
                <p className="whitespace-pre-wrap break-words text-xs" data-criterion-proof>{c.proof.summary}</p>
                <p className="break-all text-xs text-muted-foreground">{t('goal.evidenceSources', { ids: c.proof.sources.map(s => s.id).join(', ') })}</p>
                {Object.entries(c.files ?? {}).map(([path, version]) => <p key={path} className="break-all font-mono text-xs text-muted-foreground" title={version} data-criterion-file={path}>{path} · {version.slice(0, 12)}</p>)}
              </> : null}
            </div>)}
          </div>
          {goal.evidenceBlocked ? <p role="status" className="text-xs text-destructive">{t('goal.failedChecks')}</p> : null}
          {goal.evidenceOmitted ? <p className="text-xs text-muted-foreground">{t('goal.evidenceOmitted', { count: goal.evidenceOmitted })}</p> : null}
          {!editing ? <Button className="self-start" size="sm" variant="secondary" disabled={!canEdit} data-goal-action="editCriteria" onClick={() => setEditing(true)}>{t('goal.editCriteria')}</Button> :
            <div className="flex flex-col gap-3" data-goal-criteria-editor>
              {criteria.map((c, index) => <div key={c.key} className="flex items-start gap-2">
                <Input className="flex-1" multiline rows={2} maxLength={8000} classNames={FORM_INPUT_LABEL} label={t('goal.criterionLabel', { number: index + 1 })}
                  value={c.text} disabled={!canEdit} onChange={text => setCriteria(rows => rows.map(row => row.key === c.key ? { ...row, text } : row))} data-goal-criterion-input={c.key} />
                <Button size="sm" variant="ghost" disabled={!canEdit || criteria.length === 1} onClick={() => setCriteria(rows => rows.filter(row => row.key !== c.key))} data-goal-criterion-remove={c.key}>{t('goal.removeCriterion')}</Button>
              </div>)}
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="secondary" disabled={!canEdit || criteria.length >= GOAL_MAX_CRITERIA} data-goal-action="addCriterion" onClick={() => setCriteria(rows => [...rows, { key: `new-${++nextKey.current}`, text: '' }])}>{t('goal.addCriterion')}</Button>
                <Button size="sm" disabled={!canEdit || !validGoalCriteria(criteria)} data-goal-action="saveCriteria" onClick={() => void act('criteria')}>{t('goal.saveCriteria')}</Button>
                <Button size="sm" variant="ghost" disabled={pending} onClick={() => { setEditing(false); setCriteria(goal.criteria.map(c => ({ id: c.id, text: c.text, key: c.id }))) }}>{t('goal.discardCriteria')}</Button>
              </div>
              <p className="text-xs text-muted-foreground">{t('goal.criteriaHint')}</p>
            </div>}
          {goal.reason ? <p role="status" className="text-xs text-muted-foreground">{t(`goal.reason.${goal.reason}`)}</p> : null}
          {goal.waiting ? <p className="text-xs text-muted-foreground">{t('goal.waiting')}</p> : null}
          {goal.evidence ? <p className="whitespace-pre-wrap break-words text-xs" data-goal-evidence>{goal.evidence}</p> : null}
          {!terminal ? <div className="mt-2 flex gap-2">
            {active ? <Button size="sm" variant="secondary" disabled={pending} onClick={() => void act('pause')} data-goal-action="pause">{t('goal.pause')}</Button> :
              <Button size="sm" disabled={pending || busy || restricted || goal.reason === 'storage'} onClick={() => void act('resume')} data-goal-action="resume">{t('goal.resume')}</Button>}
          </div> : null}
        </div> : <p className="text-xs text-muted-foreground">{t('goal.intro')}</p>}
        <div data-form-items className="grid grid-cols-1 gap-5 md:grid-cols-2">
          {terminal ? <Input className="md:col-span-2" multiline rows={2} classNames={FORM_INPUT_LABEL} label={t('goal.acceptanceOptional')}
            placeholder={t('goal.acceptanceFromRequest')} value={ui.acceptance} onChange={acceptance => onDraft({ acceptance, limits })}
            maxLength={8000} disabled={pending} data-goal-input="acceptance" /> : null}
          <Input type="number" min={1} max={1000} step={1} classNames={FORM_INPUT_LABEL} label={t('goal.maxRuns')} value={runs} onChange={value => editLimits(value, tokens)} disabled={pending || (!terminal && busy)} data-goal-input="runs" />
          <Input type="number" min={1} max={1_000_000_000} step={1} classNames={FORM_INPUT_LABEL} label={t('goal.tokenBudget')} placeholder={t('goal.noTokenLimit')} value={tokens} onChange={value => editLimits(runs, value)} disabled={pending || (!terminal && busy)} data-goal-input="tokens" />
        </div>
        <p className="text-xs text-muted-foreground">{t('goal.budgetHint')}</p>
        {restricted ? <p role="status" className="text-xs text-muted-foreground">{t('goal.reason.plan')}</p> : null}
        {error ? <p role="alert" className="text-xs text-destructive">{t(`goal.error.${error}`)}</p> : null}
      </div>
    </FadeScroll>
    <div className="flex justify-end gap-2 border-t border-border/60 px-4 py-3">
      {!terminal ? <Button size="sm" variant="secondary" disabled={pending || busy || !valid || goal?.reason === 'storage'}
        data-goal-action="limits" onClick={() => void act('limits')}>{t('goal.saveLimits')}</Button> : null}
      <Button size="sm" variant="secondary" disabled={pending} data-goal-action="end" onClick={onEnd}>{t('goal.end')}</Button>
    </div>
  </div>
}
