import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import { GitHistoryList } from './GitHistoryList'
import { GitDiffPreview } from './GitDiffPreview'
import type { GitState, GitStore } from '@/state/git-store'

/** History and graph share one commit inspector; width only changes its CSS layout. */
export function GitCommitDetail({ state, store, view }: { state: GitState; store: GitStore; view: 'history' | 'graph' }) {
  const { t } = useI18n()
  return <section data-git-commit-details data-git-graph-details={view === 'graph' ? true : undefined} data-has-diff={!!state.selection} className={cn('git-commit-detail min-h-0 min-w-0 border-t border-border/60', view === 'graph' && 'git-graph-details')}>
    <div className="flex min-h-0 min-w-0 flex-col"><GitHistoryList state={state} store={store} detail backLabel={view === 'graph' ? t('git.backGraph') : undefined} /></div>
    {state.selection ? <GitDiffPreview state={state} store={store} /> : null}
  </section>
}
