import type { JevWorkflowDTO } from '../../../../shared/types'
import { useI18n } from '@/i18n'

/** Compact facts inside the shared task overlay, never a transcript row. */
export function JevWorkflowStatus({ state }: { state: JevWorkflowDTO | null }) {
  const { t } = useI18n()
  if (!state) return null
  return <div data-jev-workflow={state.phase} className="space-y-1 px-2 py-2 text-xs text-muted-foreground">
    <p>{t(`jev.phase.${state.phase}`)}</p>
    <p>{t('jev.workflowDetail', { route: state.route ? t(`jev.route.${state.route}`) : '—', rounds: state.corrections, requests: state.requests })}</p>
    <p>{t('jev.workflowUsage', { input: state.mainInput, output: state.mainOutput, cacheRead: state.cacheRead, cacheWrite: state.cacheWrite, jev: state.jevInput + state.jevOutput })}</p>
    {state.phase === 'paused' ? <p>{state.reason ? t(state.reason === 'limit' || state.reason === 'uncertain' || state.reason === 'interrupted' || state.reason === 'no_progress' || state.reason === 'blocked' ? `jev.reason.${state.reason}` : `jev.error.${state.reason}`) : ''} {t('jev.workflowResume')}</p> : null}
  </div>
}
