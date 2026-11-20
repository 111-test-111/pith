import { useI18n } from '@/i18n'
import type { GitLineStats } from '../../../../../shared/git'

/** Totals count displayed layers; binary and unavailable entries stay explicit. */
export function GitLineCounts({ stats, summary = false, compact = false }: { stats: (GitLineStats | null | undefined)[]; summary?: boolean; compact?: boolean }) {
  const { t } = useI18n()
  if (!summary && stats.length === 1 && (!stats[0] || stats[0].binary)) return compact ? null : <span data-git-file-stats className="shrink-0 text-xs text-muted-foreground" title={t(stats[0]?.binary ? 'git.binary' : 'git.statsUnavailable')}>{stats[0]?.binary ? t('git.binaryShort') : '—'}</span>
  let added = 0, removed = 0, excluded = 0
  for (const item of stats) { if (!item || item.binary) excluded++; else { added += item.added; removed += item.removed } }
  if (compact && (excluded || (!added && !removed))) return null
  const description = summary ? t('git.statsSummary', { added, removed, excluded }) : t('git.lineCounts', { added, removed })
  return <span data-git-file-stats data-git-added={added} data-git-removed={removed} className={`inline-flex shrink-0 items-center gap-1.5 font-mono tabular-nums ${compact ? 'text-caption' : 'text-xs'}`} aria-label={description} title={description}>
    {!compact || added > 0 ? <span className={compact ? 'text-git-tree-added' : 'text-emerald-600 dark:text-emerald-400'}>+{added}</span> : null}
    {!compact || removed > 0 ? <span className={compact ? 'text-git-tree-removed' : 'text-rose-600 dark:text-rose-400'}>−{removed}</span> : null}
    {excluded ? <span className="text-muted-foreground">*</span> : null}
  </span>
}
