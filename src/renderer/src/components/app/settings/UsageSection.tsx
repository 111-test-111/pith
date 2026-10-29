import { RefreshCw } from '@/lib/icons'
import { Button } from '@/components/motion/button'
import { RunningLoader } from '@/components/app/RunningLoader'
import { useI18n } from '@/i18n'
import { loadUsageStats, useUsageStats } from '@/lib/usage-stats-store'
import { dayKey } from '@/lib/usage-view'
import { TokenActivityPanel } from './usage/TokenActivityPanel'
import { UsageTrendsPanel } from './usage/UsageTrendsPanel'

/**
 * Settings → Usage: one tab holding both ported pi-web views — the Token
 * activity heatmap on top, then the usage trends chart and per-request
 * records. Both panels read the same shared usage snapshot (module cache +
 * background revalidate), so opening the section draws the first frame from
 * whatever is already in memory.
 */
export function UsageSection() {
  const { t } = useI18n()
  const { stats, error, loading } = useUsageStats()

  if (error && !stats) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">{t('settings.usage.loadError')}</p>
        <Button variant="outline" size="sm" onClick={() => loadUsageStats()}>
          <RefreshCw className="size-3.5" />
          {t('settings.usage.retry')}
        </Button>
      </div>
    )
  }
  if (!stats) {
    return (
      <div className="flex min-h-40 flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
        <RunningLoader size={20} label={t('settings.usage.loading')} />
        {loading ? t('settings.usage.loading') : t('settings.usage.loadError')}
      </div>
    )
  }

  // Anchor every "today" to the snapshot itself so the heatmap, the ranges
  // and the records always agree with the data they were built from.
  const today = dayKey(new Date(stats.generatedAt))

  return (
    <div className="space-y-4">
      <TokenActivityPanel stats={stats} today={today} />
      <UsageTrendsPanel stats={stats} today={today} />
    </div>
  )
}
