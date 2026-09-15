import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Tooltip } from '@/components/motion/tooltip'
import { Tabs, TabsList, TabsTrigger } from '@/components/motion/tabs'
import { useI18n } from '@/i18n'
import {
  buildTokenActivity,
  formatCompactTokens,
  parseDay,
  tokenActivityLevel,
  type TokenActivity,
  type TokenActivityPoint
} from '@/lib/usage-view'
import { formatTokenCount } from '@/lib/format'
import { cn } from '@/lib/utils'
import type { UsageStatsDTO } from '../../../../../../shared/types'

/**
 * Settings → Usage → Token activity: a contribution-graph heatmap of daily
 * token usage over the last year, ported from pi-web. beUI-native chrome —
 * the daily/weekly switcher is a segment Tabs, and each day cell is a beUI
 * Tooltip trigger; the calendar geometry itself is data visualization.
 */

type ActivityView = 'daily' | 'weekly'

const CELL_GAP_PX = 3
/** Cell floor: below this the year no longer fits fluidly and the calendar
 * scrolls instead of shrinking further (only at very narrow windows). */
const CELL_MIN_PX = 7

function formatDay(day: string, locale: string): string {
  return parseDay(day).toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric' })
}

function monthName(day: string, locale: string): string {
  return parseDay(day).toLocaleDateString(locale, { month: 'short' })
}

function formatTooltipDay(day: string, locale: string): string {
  return parseDay(day).toLocaleDateString(locale, { month: 'short', day: 'numeric' })
}

function formatExactTokens(tokens: number, locale: string): string {
  return new Intl.NumberFormat(locale).format(tokens)
}

function monthLabels(weeks: Array<Array<TokenActivityPoint | null>>, locale: string): Array<string | null> {
  let previous = ''
  return weeks.map((week) => {
    const point = week.find((day) => day !== null)
    if (!point) return null
    const month = point.day.slice(0, 7)
    if (month === previous) return null
    previous = month
    return monthName(point.day, locale)
  })
}

/** Scroll the calendar to its right edge (the latest weeks) on view switch. */
function ActivityScroll({ viewKey, columns, children }: {
  viewKey: ActivityView
  columns: number
  children: React.ReactNode
}) {
  const scrollRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const element = scrollRef.current
    if (element) element.scrollLeft = Math.max(0, element.scrollWidth - element.clientWidth)
  }, [viewKey, columns])

  return (
    <div
      ref={scrollRef}
      className="mt-4 overflow-x-auto py-0.5"
      style={{ containerType: 'inline-size' }}
    >
      {children}
    </div>
  )
}

function dayCellClasses(level: 0 | 1 | 2 | 3 | 4, weekHover: boolean): string {
  return cn(
    'size-[var(--activity-cell-size)] rounded-full transition-shadow',
    level === 0 && 'bg-muted',
    level === 1 && 'bg-primary/25',
    level === 2 && 'bg-primary/45',
    level === 3 && 'bg-primary/70',
    level === 4 && 'bg-primary',
    (weekHover) && 'ring-1 ring-inset ring-border'
  )
}

function DayCell({
  day,
  level,
  weekKey,
  tooltip,
  ariaLabel,
  hidden,
  weekHover
}: {
  day: string
  level: 0 | 1 | 2 | 3 | 4
  weekKey?: string
  tooltip?: string
  ariaLabel?: string
  hidden?: boolean
  weekHover: boolean
}) {
  const cell = (
    <span
      data-activity-week={weekKey}
      aria-label={ariaLabel}
      role={ariaLabel ? 'listitem' : undefined}
      aria-hidden={hidden || undefined}
      className={cn(
        dayCellClasses(level, weekHover),
        tooltip && 'hover:ring-1 hover:ring-inset hover:ring-border'
      )}
    />
  )
  if (hidden || !tooltip) return cell
  return (
    <Tooltip content={tooltip} side="top" delay={80} wrapperClassName="rounded-full">
      {cell}
    </Tooltip>
  )
}

function DailyActivity({
  activity,
  locale,
  ariaLabel,
  tooltipUsed
}: {
  activity: TokenActivity
  locale: string
  ariaLabel: string
  tooltipUsed: (date: string, tokens: string) => string
}) {
  const labels = monthLabels(activity.calendarWeeks, locale)
  const columns = activity.calendarWeeks.length
  return (
    <ActivityScroll viewKey="daily" columns={columns}>
      <div
        className="min-w-full w-max"
        style={{
          '--activity-columns': columns,
          '--activity-cell-size': `max(${CELL_MIN_PX}px, calc((100cqw - ${(columns - 1) * CELL_GAP_PX}px) / ${columns}))`
        } as React.CSSProperties}
      >
        <div
          aria-hidden="true"
          className="grid h-[18px] text-[11px] leading-[12px] text-muted-foreground"
          style={{
            gridTemplateColumns: `repeat(${columns}, var(--activity-cell-size))`,
            columnGap: `${CELL_GAP_PX}px`
          }}
        >
          {labels.map((label, index) => (
            <span key={index} className="min-w-0 whitespace-nowrap">{label}</span>
          ))}
        </div>
        <div
          role="list"
          aria-label={ariaLabel}
          className="mt-1 grid w-max"
          style={{
            gridTemplateRows: 'repeat(7, var(--activity-cell-size))',
            gridAutoFlow: 'column',
            gridAutoColumns: 'var(--activity-cell-size)',
            gap: `${CELL_GAP_PX}px`
          }}
        >
          {activity.calendarWeeks.flat().map((point, index) => {
            if (!point) {
              return <DayCell key={`future-${index}`} day="" level={0} hidden weekHover={false} />
            }
            const exact = formatExactTokens(point.tokens, locale)
            return (
              <DayCell
                key={point.day}
                day={point.day}
                level={tokenActivityLevel(point.tokens, activity.maxVisibleDailyTokens)}
                tooltip={tooltipUsed(
                  formatTooltipDay(point.day, locale),
                  formatCompactTokens(point.tokens, locale)
                )}
                ariaLabel={point.tokens > 0 ? `${formatDay(point.day, locale)}: ${exact}` : undefined}
                hidden={point.tokens === 0}
                weekHover={false}
              />
            )
          })}
        </div>
      </div>
    </ActivityScroll>
  )
}

function WeeklyBlockActivity({
  activity,
  locale,
  ariaLabel,
  tooltipUsed
}: {
  activity: TokenActivity
  locale: string
  ariaLabel: string
  tooltipUsed: (date: string, tokens: string) => string
}) {
  const weeks = activity.weekly
  const columns = weeks.length
  const max = Math.max(0, ...weeks.map((week) => week.tokens))
  const labels = monthLabels(activity.calendarWeeks, locale)
  // Hovering any block highlights the whole week column.
  const [hoverWeek, setHoverWeek] = useState<string | null>(null)
  const applyWeekHover = (event: React.PointerEvent<HTMLDivElement>, hovering: boolean) => {
    const target = event.target instanceof Element
      ? event.target.closest<HTMLElement>('[data-activity-week]')
      : null
    setHoverWeek(hovering && target ? target.dataset.activityWeek ?? null : null)
  }

  return (
    <ActivityScroll viewKey="weekly" columns={columns}>
      <div
        className="min-w-full w-max"
        style={{
          '--activity-columns': columns,
          '--activity-cell-size': `max(${CELL_MIN_PX}px, calc((100cqw - ${(columns - 1) * CELL_GAP_PX}px) / ${columns}))`
        } as React.CSSProperties}
        onPointerOver={(event) => applyWeekHover(event, true)}
        onPointerOut={(event) => applyWeekHover(event, false)}
        onPointerLeave={() => setHoverWeek(null)}
      >
        <div
          aria-hidden="true"
          className="grid h-[18px] text-[11px] leading-[12px] text-muted-foreground"
          style={{
            gridTemplateColumns: `repeat(${columns}, var(--activity-cell-size))`,
            columnGap: `${CELL_GAP_PX}px`
          }}
        >
          {labels.map((label, index) => (
            <span key={index} className="min-w-0 whitespace-nowrap">{label}</span>
          ))}
        </div>
        <div
          role="list"
          aria-label={ariaLabel}
          className="mt-1 grid w-max"
          style={{
            gridTemplateRows: 'repeat(7, var(--activity-cell-size))',
            gridAutoFlow: 'column',
            gridAutoColumns: 'var(--activity-cell-size)',
            gap: `${CELL_GAP_PX}px`
          }}
        >
          {weeks.flatMap((week) => {
            const description = `${formatDay(week.startDay, locale)} – ${formatDay(week.endDay, locale)}: ${formatExactTokens(week.tokens, locale)}`
            const compact = formatCompactTokens(week.tokens, locale)
            const tooltip = tooltipUsed(
              `${formatTooltipDay(week.startDay, locale)}–${formatTooltipDay(week.endDay, locale)}`,
              compact
            )
            const level = tokenActivityLevel(week.tokens, max)
            return Array.from({ length: 7 }, (_, row) => (
              <DayCell
                key={`${week.startDay}-${row}`}
                day={week.startDay}
                level={level}
                weekKey={week.startDay}
                tooltip={tooltip}
                ariaLabel={row === 0 && week.tokens > 0 ? description : undefined}
                hidden={row !== 0 || week.tokens === 0}
                weekHover={hoverWeek === week.startDay}
              />
            ))
          })}
        </div>
      </div>
    </ActivityScroll>
  )
}

export function TokenActivityPanel({ stats, today }: { stats: UsageStatsDTO; today: string }) {
  const { t, locale } = useI18n()
  const [view, setView] = useState<ActivityView>('daily')
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
            <div className="whitespace-nowrap text-[15px] font-medium leading-tight tabular-nums text-foreground">
              {metric.value}
            </div>
            <div className="mt-1 min-h-[30px] text-[11px] leading-[1.35] text-muted-foreground">{metric.label}</div>
          </div>
        ))}
      </div>

      <div className="mt-4 flex flex-wrap items-start justify-between gap-3 border-t border-border/60 pt-4">
        <div>
          <h3 id="token-activity-title" className="text-sm font-semibold text-foreground">
            {t('settings.tokenActivity.title')}
          </h3>
          <p className="mt-0.5 text-xs leading-4 text-muted-foreground">
            {t('settings.tokenActivity.subtitle')}
          </p>
        </div>
        <Tabs
          value={view}
          onValueChange={(value) => setView(value as ActivityView)}
          variant="segment"
          className="shrink-0"
        >
          <TabsList className="h-7 bg-transparent p-0">
            <TabsTrigger value="daily" className="min-h-0 px-2.5 py-1 text-[11px]">
              {t('settings.tokenActivity.daily')}
            </TabsTrigger>
            <TabsTrigger value="weekly" className="min-h-0 px-2.5 py-1 text-[11px]">
              {t('settings.tokenActivity.weekly')}
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {activity.visibleTokens === 0 ? (
        <div className="flex min-h-[120px] items-center justify-center px-4 py-6 text-center text-sm text-muted-foreground">
          {t(activity.summary.totalTokens === 0 ? 'settings.tokenActivity.empty' : 'settings.tokenActivity.emptyYear')}
        </div>
      ) : view === 'daily' ? (
        <DailyActivity
          activity={activity}
          locale={locale}
          ariaLabel={t('settings.tokenActivity.tokens')}
          tooltipUsed={tooltipUsed}
        />
      ) : (
        <WeeklyBlockActivity
          activity={activity}
          locale={locale}
          ariaLabel={t('settings.tokenActivity.weekly')}
          tooltipUsed={tooltipUsed}
        />
      )}
    </section>
  )
}
