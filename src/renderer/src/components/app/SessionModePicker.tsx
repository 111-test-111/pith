import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/motion/select'
import { useI18n } from '@/i18n'
import { LabelTooltip } from './LabelTooltip'
import { planErrorKey } from '@/lib/plan-submissions'
import type { PlanStateDTO, SessionMode } from '../../../../shared/types'
export function SessionModePicker({ state, disabled, onChange }: {
  state: PlanStateDTO | null; disabled?: boolean; onChange(mode: SessionMode): void
}) {
  const { t } = useI18n()
  const mode = state?.mode ?? 'normal'
  const blocker = state?.blockers.switch[0]
  return <LabelTooltip content={blocker ? t(planErrorKey(blocker)) : t('plan.modeHelp')}>
    <span data-session-mode={mode}>
      <Select value={mode} onValueChange={next => onChange(next as SessionMode)} disabled={disabled || !!blocker} className="w-auto">
        <SelectTrigger aria-label={t('plan.modeLabel')} className="h-8 w-auto rounded-control border-0 bg-transparent px-2.5 text-xs hover:bg-muted">
          {t(mode === 'plan' ? 'plan.plan' : 'plan.normal')}
        </SelectTrigger>
        <SelectContent className="w-64">
          <SelectItem value="normal">{t('plan.normal')}</SelectItem>
          <SelectItem value="plan">{t('plan.plan')}</SelectItem>
        </SelectContent>
      </Select>
    </span>
  </LabelTooltip>
}
