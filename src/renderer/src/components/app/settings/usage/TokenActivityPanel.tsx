import { useMemo } from 'react'
import { HeatCalendar, HeatCalendarGrid, HeatCalendarTooltip } from '@/components/charts/heat-calendar'
import { useI18n } from '@/i18n'
import {
  buildTokenActivity,
  formatCompactTokens,
  parseDay,
  type TokenActivity
} from '@/lib/usage-view'
import { formatTokenCount } from '@/lib/format'
import { cn } from '@/lib/utils'
import type { UsageStatsDTO } from '../../../../../../shared/types'

/**
 * Settings → Usage → Token activity: a contribution-graph heatmap of daily
 * token usage over the last year, ported from pi-web. beUI-native chrome — the
 * calendar geometry itself is data visualization, each day cell answers the
 * pointer with its exact count.
 *
 * The daily grid is the only view: pi-web's weekly block chart is gone, so the
 * panel carries no view switcher and the heat calendar is always mounted (see
 * usage-view's `TokenActivity`, which no longer builds weekly buckets).
 */

const DAY_MS = 86_400_000

function formatTooltipDate(date: Date, locale: string): string {
  return date.toLocaleDateString(locale, { timeZone: 'UTC', month: 'short', day: 'numeric' })
}

/** Monday-first week start in UTC, matching `heat-calendar`'s own geometry. */
function utcMonday(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - ((date.getUTCDay() + 6) % 7))
  )
}

/**
 * Fold the usage pipeline's Sunday-first, 365-day series into the Monday-first
 * week grid and 0..1 intensities `heat-calendar` expects. The window is the
 * same 364 days back from today, widened to whole weeks; intensities divide by
 * the visible peak, so the calendar's `maxCount` turns them back into tokens.
 */
function buildDailyGrid(activity: TokenActivity, today: string) {
  const byDay = new Map<string, number>()
  for (const week of activity.calendarWeeks) {
    for (const point of week) if (point) byDay.set(point.day, point.tokens)
  }
  const endDate = new Date(`${today}T00:00:00Z`)
  const monday = utcMonday(endDate)
  const start = utcMonday(new Date(endDate.getTime() - 364 * DAY_MS))
  const weeks = Math.round((monday.getTime() - start.getTime()) / (7 * DAY_MS)) + 1
  const peak = Math.max(1, activity.maxVisibleDailyTokens)
  const values: number[][] = []
  for (let week = 0; week < weeks; week++) {
    const column: number[] = []
    for (let day = 0; day < 7; day++) {
      const date = new Date(start.getTime() + (week * 7 + day) * DAY_MS)
      column.push((byDay.get(date.toISOString().slice(0, 10)) ?? 0) / peak)
    }
    values.push(column)
  }
  return { weeks, values, endDate }
}

function DailyActivity({
  activity,
  locale,
  today,
  tooltipUsed
}: {
  activity: TokenActivity
  locale: string
  today: string
  tooltipUsed: (date: string, tokens: string) => string
}) {
  const { t } = useI18n()
  const grid = useMemo(() => buildDailyGrid(activity, today), [activity, today])
  return (
    <div className="mt-4">
      <HeatCalendar
        weeks={grid.weeks}
        locale={locale}
        // Intensities are peak-relative, so this turns them back into tokens and
        // the tooltip reads the exact count the app used to show.
        maxCount={Math.max(1, activity.maxVisibleDailyTokens)}
        values={grid.values}
        endDate={grid.endDate}
        unit={t('settings.tokenActivity.tokens')}
        color="var(--primary)"
        // Read-only usage: a pinned span would have no meaning here.
        selection={null}
        onSelectionChange={() => {}}
      >
        <HeatCalendarGrid>
          <HeatCalendarTooltip>
            {(data) => tooltipUsed(formatTooltipDate(data.date, locale), formatCompactTokens(data.count, locale))}
          </HeatCalendarTooltip>
        </HeatCalendarGrid>
      </HeatCalendar>
    </div>
  )
}

export function TokenActivityPanel({ stats, today }: { stats: UsageStatsDTO; today: string }) {
  const { t, locale } = useI18n()
  const activity = useMemo(() => buildTokenActivity(stats, today), [stats, today])

  const metrics = [
    { label: t('settings.tokenActivity.total'), value: formatTokenCount(activity.summary.totalTokens) },
    { label: t('settings.tokenActivity.peak'), value: formatTokenCount(activity.summary.peakDailyTokens) },
    { label: t('settings.tokenActivity.activeDays'), value: activity.summary.activeDays === 1 ? t('settings.tokenActivity.oneDayValue') : t('settings.tokenActivity.daysValue', { count: activity.summary.activeDays }) },
    { label: t('settings.tokenActivity.currentStreak'), value: activity.summary.currentStreak === 1 ? t('settings.tokenActivity.oneDayValue') : t('settings.tokenActivity.daysValue', { count: activity.summary.currentStreak }) },
    { label: t('settings.tokenActivity.longestStreak'), value: activity.summary.longestStreak === 1 ? t('settings.tokenActivity.oneDayValue') : t('settings.tokenActivity.daysValue', { count: activity.summary.longestStreak }) }
  ]

  const tooltipUsed = (date: string, tokens: string) =>
    t('settings.tokenActivity.tooltip.used', { date, tokens })

  return (
    <section className="rounded-card border border-border/70 bg-card p-4 sm:p-5" aria-labelledby="token-activity-title">
      <div className="grid grid-cols-3 gap-x-2 gap-y-4 pb-1 sm:grid-cols-5">
        {metrics.map((metric, index) => (
          <div
            key={metric.label}
            className={cn(
              'min-w-0 px-3 text-center',
              index > 0 && 'sm:shadow-[-1px_0_0_color-mix(in_srgb,var(--foreground)_9%,transparent)]'
            )}
          >
            <div className="whitespace-nowrap text-base font-medium leading-tight tabular-nums text-foreground">
              {metric.value}
            </div>
            <div className="mt-1 min-h-[30px] text-caption leading-[1.35] text-muted-foreground">{metric.label}</div>
          </div>
        ))}
      </div>

      <div className="mt-4 border-t border-border/60 pt-4">
        <h3 id="token-activity-title" className="text-sm font-semibold text-foreground">
          {t('settings.tokenActivity.title')}
        </h3>
        <p className="mt-0.5 text-xs leading-ui-tight text-muted-foreground">
          {t('settings.tokenActivity.subtitle')}
        </p>
      </div>

      {activity.visibleTokens === 0 ? (
        <div className="flex min-h-[120px] items-center justify-center px-4 py-6 text-center text-sm text-muted-foreground">
          {t(activity.summary.totalTokens === 0 ? 'settings.tokenActivity.empty' : 'settings.tokenActivity.emptyYear')}
        </div>
      ) : (
        <DailyActivity
          activity={activity}
          locale={locale}
          today={today}
          tooltipUsed={tooltipUsed}
        />
      )}
    </section>
  )
}
