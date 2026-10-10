import { useEffect, useState } from 'react'
import { Input } from '@/components/motion/input'
import { Button } from '@/components/motion/button'
import { FORM_INPUT_LABEL } from '@/lib/form-standard'
import { useI18n } from '@/i18n'
import { FadeScroll } from './FadeScroll'
import { DEFAULT_GOAL_LIMITS, validGoalLimits, type GoalActionRequest, type GoalErrorCode, type GoalSnapshotDTO } from '../../../../shared/goal'

export function GoalPanel({ sessionPath, goal, seq, busy, restricted, onState }: {
  sessionPath: string; goal: GoalSnapshotDTO | null; seq: number; busy: boolean; restricted: boolean
  onState: (path: string, goal: GoalSnapshotDTO | null, seq: number) => void
}) {
  const { t } = useI18n()
  const [objective, setObjective] = useState('')
  const [acceptance, setAcceptance] = useState('')
  const [runs, setRuns] = useState(String(goal?.limits.maxAutoRuns ?? DEFAULT_GOAL_LIMITS.maxAutoRuns))
  const [tokens, setTokens] = useState(goal?.limits.tokenBudget == null ? '' : String(goal.limits.tokenBudget))
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<GoalErrorCode | null>(null)
  useEffect(() => {
    setRuns(String(goal?.limits.maxAutoRuns ?? DEFAULT_GOAL_LIMITS.maxAutoRuns))
    setTokens(goal?.limits.tokenBudget == null ? '' : String(goal.limits.tokenBudget))
  }, [goal?.id, goal?.limits.maxAutoRuns, goal?.limits.tokenBudget])
  const terminal = !goal || goal.status === 'completed' || goal.status === 'cancelled'
  const active = goal?.status === 'active' || goal?.status === 'verifying'
  const limits = { maxAutoRuns: Number(runs), tokenBudget: tokens.trim() ? Number(tokens) : null }
  const valid = validGoalLimits(limits)
  const act = async (action: GoalActionRequest['action']) => {
    if (pending) return
    setPending(true); setError(null)
    const identity = { sessionPath, expectedSeq: seq, goalId: goal?.id ?? null }
    const request: GoalActionRequest = action === 'create' ? { ...identity, action, objective, acceptance, limits } :
      action === 'limits' ? { ...identity, action, limits } : { ...identity, action }
    try {
      const result = await window.pi.goalAction(request)
      if (result.ok) { onState(sessionPath, result.goal, result.seq); if (action === 'create') { setObjective(''); setAcceptance('') } }
      else setError(result.code)
    } catch { setError('unavailable') }
    finally { setPending(false) }
  }
  return <FadeScroll className="max-h-[min(60vh,28rem)] p-4" data-goal-panel>
    <div className="flex flex-col gap-4 text-sm">
      {goal ? <div className="flex flex-col gap-1.5" data-goal-status={goal.status}>
        <div className="flex flex-wrap items-center justify-between gap-2"><span className="font-medium">{t(`goal.status.${goal.status}`)}</span>
          <span className="text-xs tabular-nums text-muted-foreground">{goal.accountingAvailable ? t('goal.usage', { runs: goal.autoRuns, max: goal.limits.maxAutoRuns, tokens: goal.tokens }) : t('goal.accountingUnavailable')}</span></div>
        <p className="whitespace-pre-wrap break-words">{goal.objective}</p>
        <p className="mt-1 text-xs font-medium">{t('goal.acceptance')}</p>
        <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">{goal.acceptance}</p>
        {goal.reason ? <p role="status" className="text-xs text-muted-foreground">{t(`goal.reason.${goal.reason}`)}</p> : null}
        {goal.waiting ? <p className="text-xs text-muted-foreground">{t('goal.waiting')}</p> : null}
        {goal.evidence ? <p className="whitespace-pre-wrap break-words text-xs" data-goal-evidence>{goal.evidence}</p> : null}
        {!terminal ? <div className="mt-2 flex gap-2">
          {active ? <Button size="sm" variant="secondary" disabled={pending} onClick={() => void act('pause')} data-goal-action="pause">{t('goal.pause')}</Button> :
            <Button size="sm" disabled={pending || busy || restricted || goal.reason === 'storage'} onClick={() => void act('resume')} data-goal-action="resume">{t('goal.resume')}</Button>}
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => void act('cancel')} data-goal-action="cancel">{t('goal.cancel')}</Button>
        </div> : null}
      </div> : <p className="text-xs text-muted-foreground">{t('goal.intro')}</p>}
      <div data-form-items className="grid grid-cols-1 gap-5 md:grid-cols-2">
        {terminal ? <>
          <Input className="md:col-span-2" multiline rows={3} classNames={FORM_INPUT_LABEL} label={t('goal.objective')} value={objective} onChange={setObjective} maxLength={8000} disabled={pending} data-goal-input="objective" />
          <Input className="md:col-span-2" multiline rows={3} classNames={FORM_INPUT_LABEL} label={t('goal.acceptance')} value={acceptance} onChange={setAcceptance} maxLength={8000} disabled={pending} data-goal-input="acceptance" />
        </> : null}
        <Input type="number" min={1} max={1000} step={1} classNames={FORM_INPUT_LABEL} label={t('goal.maxRuns')} value={runs} onChange={setRuns} disabled={pending || busy} data-goal-input="runs" />
        <Input type="number" min={1} max={1_000_000_000} step={1} classNames={FORM_INPUT_LABEL} label={t('goal.tokenBudget')} placeholder={t('goal.noTokenLimit')} value={tokens} onChange={setTokens} disabled={pending || busy} data-goal-input="tokens" />
      </div>
      <p className="text-xs text-muted-foreground">{t('goal.budgetHint')}</p>
      {restricted ? <p role="status" className="text-xs text-muted-foreground">{t('goal.reason.plan')}</p> : null}
      {error ? <p role="alert" className="text-xs text-destructive">{t(`goal.error.${error}`)}</p> : null}
      <div className="flex justify-end">
        <Button size="sm" disabled={pending || busy || !valid || (terminal && (restricted || !objective.trim() || !acceptance.trim())) || goal?.reason === 'storage'}
          data-goal-action={terminal ? 'create' : 'limits'} onClick={() => void act(terminal ? 'create' : 'limits')}>
          {t(terminal ? 'goal.start' : 'goal.saveLimits')}
        </Button>
      </div>
    </div>
  </FadeScroll>
}
