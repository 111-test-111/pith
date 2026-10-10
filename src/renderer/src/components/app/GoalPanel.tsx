import { useEffect, useState } from 'react'
import { Input } from '@/components/motion/input'
import { Button } from '@/components/motion/button'
import { FORM_INPUT_LABEL } from '@/lib/form-standard'
import { useI18n } from '@/i18n'
import type { GoalUIState } from '@/state/pi-store'
import { FadeScroll } from './FadeScroll'
import { validGoalLimits, type GoalErrorCode, type GoalSnapshotDTO } from '../../../../shared/goal'

export function GoalPanel({ sessionPath, goal, seq, busy, restricted, ui, onDraft, onEnd, onState }: {
  sessionPath: string; goal: GoalSnapshotDTO | null; seq: number; busy: boolean; restricted: boolean; ui: GoalUIState
  onDraft: (draft: Pick<GoalUIState, 'limits' | 'acceptance'>) => void
  onEnd: () => void
  onState: (path: string, goal: GoalSnapshotDTO | null, seq: number) => void
}) {
  const { t } = useI18n()
  const [runs, setRuns] = useState(String(ui.limits.maxAutoRuns))
  const [tokens, setTokens] = useState(ui.limits.tokenBudget == null ? '' : String(ui.limits.tokenBudget))
  const [acting, setActing] = useState(false)
  const [error, setError] = useState<GoalErrorCode | null>(null)
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
  const act = async (action: 'pause' | 'resume' | 'limits') => {
    if (pending || !goal) return
    setActing(true); setError(null)
    const identity = { sessionPath, expectedSeq: seq, goalId: goal.id }
    try {
      const result = await window.pi.goalAction(action === 'limits' ? { ...identity, action, limits } : { ...identity, action })
      if (result.ok) onState(sessionPath, result.goal, result.seq)
      else setError(result.code)
    } catch { setError('unavailable') }
    finally { setActing(false) }
  }
  const shownError = error ?? ui.error
  return <div data-goal-panel>
    <FadeScroll className="max-h-[min(55vh,25rem)] p-4">
      <div className="flex flex-col gap-4 text-sm">
        {goal ? <div className="flex flex-col gap-1.5" data-goal-status={goal.status}>
          <div className="flex flex-wrap items-center justify-between gap-2"><span className="font-medium">{t(`goal.status.${goal.status}`)}</span>
            <span className="text-xs tabular-nums text-muted-foreground">{goal.accountingAvailable ? t('goal.usage', { runs: goal.autoRuns, max: goal.limits.maxAutoRuns, tokens: goal.tokens }) : t('goal.accountingUnavailable')}</span></div>
          <p className="whitespace-pre-wrap break-words">{goal.objective}</p>
          <p className="mt-1 text-xs font-medium">{t('goal.acceptance')}</p>
          <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">{goal.acceptance === goal.objective ? t('goal.acceptanceFromRequest') : goal.acceptance}</p>
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
        {shownError ? <p role="alert" className="text-xs text-destructive">{t(`goal.error.${shownError}`)}</p> : null}
      </div>
    </FadeScroll>
    <div className="flex justify-end gap-2 border-t border-border/60 px-4 py-3">
      {!terminal ? <Button size="sm" variant="secondary" disabled={pending || busy || !valid || goal?.reason === 'storage'}
        data-goal-action="limits" onClick={() => void act('limits')}>{t('goal.saveLimits')}</Button> : null}
      <Button size="sm" variant="secondary" disabled={pending} data-goal-action="end" onClick={onEnd}>{t('goal.end')}</Button>
    </div>
  </div>
}
