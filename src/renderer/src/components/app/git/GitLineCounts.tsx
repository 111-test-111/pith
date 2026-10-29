import { useI18n } from '@/i18n'
import type { GitLineStats } from '../../../../../shared/git'

/** Totals count displayed layers; binary and unavailable entries stay explicit. */
export function GitLineCounts({ stats, summary = false }: { stats: (GitLineStats | null | undefined)[]; summary?: boolean }) {
  const { t } = useI18n()
  if (!summary && stats.length === 1 && (!stats[0] || stats[0].binary)) return <span data-git-file-stats className="shrink-0 text-xs text-muted-foreground" title={t(stats[0]?.binary ? 'git.binary' : 'git.statsUnavailable')}>{stats[0]?.binary ? t('git.binaryShort') : '—'}</span>
  let added = 0, removed = 0, excluded = 0
  for (const item of stats) { if (!item || item.binary) excluded++; else { added += item.added; removed += item.removed } }
  const description = summary ? t('git.statsSummary', { added, removed, excluded }) : t('git.lineCounts', { added, removed })
  return <span data-git-file-stats data-git-added={added} data-git-removed={removed} className="inline-flex shrink-0 items-center gap-1.5 font-mono text-xs tabular-nums" aria-label={description} title={description}>
    <span className="text-emerald-600 dark:text-emerald-400">+{added}</span><span className="text-rose-600 dark:text-rose-400">−{removed}</span>{excluded ? <span className="text-muted-foreground">*</span> : null}
  </span>
}
