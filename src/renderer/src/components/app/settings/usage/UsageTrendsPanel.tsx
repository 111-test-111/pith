import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { computePosition, flip, offset, shift } from '@floating-ui/react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { createPortal } from 'react-dom'
import { Button } from '@/components/motion/button'
import { NumberTicker } from '@/components/motion/number-ticker'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/motion/select'
import { Tabs, TabsList, TabsTrigger } from '@/components/motion/tabs'
import { TooltipSurface } from '@/components/motion/tooltip-surface'
import { useI18n } from '@/i18n'
import { ChevronLeft, ChevronRight, Download } from '@/lib/icons'
import { EASE_OUT, SPRING_GLIDE } from '@/lib/ease'
import {
  areaPath,
  buildUsageChartModel,
  formatCompactTokens,
  niceMax,
  parseDay,
  shiftDay,
  smoothLine,
  type UsageChartModel,
  type UsageGroupBy,
  type UsageRangeKey
} from '@/lib/usage-view'
import { formatCost, formatTokenCount } from '@/lib/format'
import { cn } from '@/lib/utils'
import type { MessageKey } from '@/i18n/locales/en'
import type { UsageStatsDTO, UsageTurnRecordDTO } from '../../../../../../shared/types'

/**
 * Settings → Usage → trends: summary stat cards, a stacked cumulative area
 * chart per model/provider and the per-request records table, ported from
 * pi-web. beUI-native chrome (Select, segment Tabs, Buttons); the chart SVG
 * and its crosshair readout are data visualization.
 */

const RANGE_KEYS: UsageRangeKey[] = ['7d', '30d', 'mtd', 'lastMonth', 'all']

const RANGE_LABELS: Record<UsageRangeKey, MessageKey> = {
  '7d': 'settings.usage.range.7d',
  '30d': 'settings.usage.range.30d',
  mtd: 'settings.usage.range.mtd',
  lastMonth: 'settings.usage.range.lastMonth',
  all: 'settings.usage.range.all'
}

const CHART_HEIGHT = 260
const MARGIN = { top: 24, right: 16, bottom: 26, left: 56 }

function formatUsd(cost: number): string {
  if (!(cost > 0)) return '$0.00'
  if (cost >= 1) return `$${cost.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  return `$${cost.toFixed(4)}`
}

/** Locale-aware date/time label without seconds. */
function formatRecordTime(ts: number, locale: string): string {
  return new Date(ts).toLocaleString(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/** First/last ticks hug the plot edge so long date labels aren't clipped. */
function xTickTextAnchor(i: number, last: number): 'start' | 'middle' | 'end' {
  if (last <= 0) return 'middle'
  if (i === 0) return 'start'
  if (i === last) return 'end'
  return 'middle'
}

/**
 * Crosshair readout for the chart. beUI's Tooltip is trigger-driven (it wraps
 * one element and opens on its hover), which cannot express "follow the
 * pointer across the plot", so this composes the same @floating-ui primitives
 * beUI's tooltip uses (virtual anchor + offset/flip/shift) over the shared
 * `TooltipSurface` — the same bubble the heat-calendar readout wears, one
 * readout surface for every chart in the app. The anchor is the live pointer
 * position, so the bubble tracks the cursor instead of hanging off one fixed
 * spot above the plot.
 */
function ChartReadout({
  anchor,
  show,
  children
}: {
  anchor: { x: number; y: number }
  show: boolean
  children: React.ReactNode
}) {
  const ref = useRef<HTMLSpanElement>(null)
  const [positioned, setPositioned] = useState(false)

  useEffect(() => {
    const element = ref.current
    if (!element || !show) {
      // Re-show starts hidden until placed, so a stale position from the last
      // open can never flash for a frame.
      if (!show) setPositioned(false)
      return
    }
    // A zero-size virtual element under the cursor; flip/shift keep the
    // readout inside the window exactly like a beUI tooltip bubble. The last
    // position stays visible while a pointer move repositions — no flicker.
    const virtual = {
      getBoundingClientRect: () => ({ x: anchor.x, y: anchor.y, top: anchor.y, bottom: anchor.y, left: anchor.x, right: anchor.x, width: 0, height: 0 })
    }
    let cancelled = false
    void computePosition(virtual, element, {
      placement: 'top',
      strategy: 'fixed',
      middleware: [offset(8), flip({ padding: 8 }), shift({ padding: 8 })]
    }).then(({ x, y }) => {
      if (cancelled) return
      element.style.left = `${x}px`
      element.style.top = `${y}px`
      setPositioned(true)
    })
    return () => {
      cancelled = true
    }
  }, [anchor, show])

  if (typeof document === 'undefined') return null
  return createPortal(
    <AnimatePresence>
      {show ? (
        <span
          ref={ref}
          className={cn('pointer-events-none fixed z-[9999] block', positioned ? 'visible' : 'invisible')}
        >
          <TooltipSurface
            side="top"
            style={{ transformOrigin: 'center bottom', maxWidth: 'calc(100vw - 16px)', whiteSpace: 'normal' }}
            className="text-left"
          >
            {children}
          </TooltipSurface>
        </span>
      ) : null}
    </AnimatePresence>,
    document.body
  )
}

function UsageAreaChart({
  model,
  locale,
  todayLabel,
  totalLabel
}: {
  model: UsageChartModel
  locale: string
  todayLabel: string
  totalLabel: string
}) {
  const reduce = useReducedMotion()
  const wrapRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [hover, setHover] = useState<number | null>(null)
  const [readoutShown, setReadoutShown] = useState(false)
  // The readout follows the pointer. Its position is committed at most once per
  // animation frame: a `setState` per mousemove would re-render the whole SVG
  // several times inside one frame on a high-rate pointer.
  const [anchor, setAnchor] = useState({ x: 0, y: 0 })
  const pointerRef = useRef({ x: 0, y: 0 })
  const frameRef = useRef(0)
  const gradBase = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  // The stacked body draws itself in from the left through this clip, like the
  // fan chart's projection reveal — the whole stack reads as one gesture.
  const clipId = useId().replace(/[^a-zA-Z0-9_-]/g, '')

  useLayoutEffect(() => {
    const el = wrapRef.current
    if (!el) return
    // Measure synchronously on mount so the very first frame already carries a
    // fully-sized SVG; the ResizeObserver only tracks later container changes.
    setWidth(Math.floor(el.getBoundingClientRect().width))
    const ro = new ResizeObserver((entries) => {
      setWidth(Math.floor(entries[0].contentRect.width))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => () => {
    if (frameRef.current) cancelAnimationFrame(frameRef.current)
  }, [])

  // Rest the pointer briefly before the readout appears — sweeping the chart
  // must not strobe a tooltip per day.
  useEffect(() => {
    if (hover === null) {
      setReadoutShown(false)
      return
    }
    const timer = setTimeout(() => setReadoutShown(true), 80)
    return () => clearTimeout(timer)
  }, [hover])

  const { days, layers, maxTotal } = model
  const innerW = Math.max(1, width - MARGIN.left - MARGIN.right)
  const innerH = CHART_HEIGHT - MARGIN.top - MARGIN.bottom
  const stepX = days.length > 1 ? innerW / (days.length - 1) : 0
  const x = (i: number) => (days.length > 1 ? MARGIN.left + stepX * i : MARGIN.left + innerW / 2)
  const yMax = niceMax(maxTotal)
  const y = (v: number) => MARGIN.top + innerH * (1 - v / yMax)

  const xs = days.map((_, i) => x(i))
  const yTicks = [0.25, 0.5, 0.75, 1].map((f) => yMax * f)

  const crossYear = parseDay(days[0]).getFullYear() !== parseDay(days[days.length - 1]).getFullYear()
  const formatDay = (day: string) =>
    parseDay(day).toLocaleDateString(locale, crossYear
      ? { year: 'numeric', month: 'short', day: 'numeric' }
      : { month: 'short', day: 'numeric' })

  const tickCount = Math.min(6, days.length)
  const xTickIdx = new Set(
    Array.from({ length: tickCount }, (_, k) => Math.round((k * (days.length - 1)) / Math.max(1, tickCount - 1)))
  )

  const onMove = (e: React.MouseEvent<SVGRectElement>) => {
    const rect = e.currentTarget.ownerSVGElement?.getBoundingClientRect()
    if (!rect || days.length === 0) return
    const i = days.length > 1 ? Math.round((e.clientX - rect.left - MARGIN.left) / stepX) : 0
    setHover(Math.max(0, Math.min(days.length - 1, i)))
    pointerRef.current = { x: e.clientX, y: e.clientY }
    if (frameRef.current) return
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = 0
      setAnchor(pointerRef.current)
    })
  }

  const hoverX = hover !== null ? x(hover) : 0
  const todayIdx = model.todayIndex

  return (
    <div ref={wrapRef} className="relative">
      {width > 0 && (
        <svg width={width} height={CHART_HEIGHT} className="block" onMouseLeave={() => setHover(null)}>
          <defs>
            {layers.map((l, i) => (
              <linearGradient key={l.key} id={`${gradBase}-${i}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={l.color} stopOpacity={0.3} />
                <stop offset="100%" stopColor={l.color} stopOpacity={0.04} />
              </linearGradient>
            ))}
            <clipPath id={clipId}>
              <motion.rect
                x={0}
                y={0}
                height={CHART_HEIGHT}
                initial={{ width: reduce ? width : 0 }}
                animate={{ width }}
                transition={reduce ? { duration: 0 } : { duration: 0.8, ease: EASE_OUT }}
              />
            </clipPath>
          </defs>

          {/* horizontal gridlines + y labels */}
          {yTicks.map((v) => (
            <g key={v}>
              <line className="stroke-border/50" x1={MARGIN.left} x2={width - MARGIN.right} y1={y(v)} y2={y(v)} strokeWidth={1} />
              <text className="fill-muted-foreground text-micro" x={MARGIN.left - 8} y={y(v) + 3} textAnchor="end">
                {formatCompactTokens(Math.round(v), locale)}
              </text>
            </g>
          ))}
          <line className="stroke-border" x1={MARGIN.left} x2={width - MARGIN.right} y1={y(0)} y2={y(0)} strokeWidth={1} />
          <text className="fill-muted-foreground text-micro" x={MARGIN.left - 8} y={y(0) + 3} textAnchor="end">0</text>

          {/* x labels */}
          {days.map((day, i) =>
            xTickIdx.has(i) ? (
              <text key={day} className="fill-muted-foreground text-micro" x={x(i)} y={CHART_HEIGHT - 8} textAnchor={xTickTextAnchor(i, days.length - 1)}>
                {formatDay(day)}
              </text>
            ) : null
          )}

          {/* stacked areas — the clip above reveals them left to right on
              mount and on every range/group switch (the chart remounts per key) */}
          <g clipPath={`url(#${clipId})`}>
            {layers.map((l, i) => (
              <g key={l.key}>
                <path d={areaPath(xs, l.top.map(y), l.bottom.map(y))} fill={`url(#${gradBase}-${i})`} />
                <path d={smoothLine(xs, l.top.map(y))} fill="none" stroke={l.color} strokeWidth={1.5} strokeLinejoin="round" />
              </g>
            ))}
          </g>

          {/* today marker */}
          {todayIdx >= 0 && (
            <g>
              <line className="stroke-muted-foreground/70" x1={x(todayIdx)} x2={x(todayIdx)} y1={MARGIN.top - 6} y2={y(0)} strokeWidth={1} strokeDasharray="4 3" />
              <text className="fill-muted-foreground text-micro" x={x(todayIdx)} y={11.5} textAnchor="middle">
                {todayLabel}
              </text>
            </g>
          )}

          {/* hover crosshair + boundary dots — they flow along the series on a
              spring instead of stepping day to day, like the fan chart's cursor */}
          {hover !== null && (
            <g pointerEvents="none">
              <motion.line
                className="stroke-muted-foreground"
                y1={MARGIN.top - 6}
                y2={y(0)}
                strokeWidth={1}
                strokeDasharray="3 3"
                initial={false}
                animate={{ x1: hoverX, x2: hoverX }}
                transition={reduce ? { duration: 0 } : { type: 'spring', ...SPRING_GLIDE }}
              />
              {layers.map((l) =>
                l.top[hover] > 0 ? (
                  <motion.circle
                    key={l.key}
                    r={3}
                    fill={l.color}
                    stroke="var(--card)"
                    strokeWidth={1.5}
                    initial={false}
                    animate={{ cx: hoverX, cy: y(l.top[hover]) }}
                    transition={reduce ? { duration: 0 } : { type: 'spring', ...SPRING_GLIDE }}
                  />
                ) : null
              )}
            </g>
          )}

          {/* event overlay (kept last so it sits on top) */}
          <rect
            x={MARGIN.left}
            y={MARGIN.top - 6}
            width={innerW}
            height={innerH + 6}
            fill="transparent"
            onMouseMove={onMove}
          />
        </svg>
      )}

      {hover !== null && (
        <ChartReadout anchor={anchor} show={readoutShown}>
          <div className="mb-1 text-caption text-muted-foreground">{formatDay(days[hover])}</div>
          {model.legend.map((l) =>
            l.cum[hover] > 0 ? (
              <div key={l.key} className="flex items-center gap-2 py-px">
                <span className="size-2 shrink-0 rounded-full" style={{ background: l.color }} />
                <span className="max-w-44 truncate">{l.label}</span>
                <span className="ml-auto pl-3 tabular-nums">{formatTokenCount(l.cum[hover])}</span>
              </div>
            ) : null
          )}
          <div className="mt-1 flex items-center gap-2 border-t border-border/60 pt-1 text-foreground">
            <span>{totalLabel}</span>
            <span className="ml-auto pl-3 tabular-nums">
              {formatTokenCount(model.legend.reduce((s, l) => s + l.cum[hover], 0))}
            </span>
          </div>
        </ChartReadout>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Per-turn records table (below the chart) — one row per conversation turn,
// paged, not scrolled.
// ---------------------------------------------------------------------------

const RECORDS_PAGE_SIZE = 10

function csvCell(value: string | number): string {
  const s = String(value)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** "glm-5.3" or "glm-5.3 +2" — the dominant model plus a hidden count. */
function turnModelLabel(turn: UsageTurnRecordDTO): { label: string; title: string } {
  const title = turn.models.map((m) => `${m.provider}/${m.model}`).join(' · ')
  const primary = turn.models[0].model
  return { label: turn.models.length > 1 ? `${primary} +${turn.models.length - 1}` : primary, title }
}

function UsageRecordsTable({
  records,
  locale,
  rangeLabel,
  prevLabel,
  nextLabel,
  emptyLabel
}: {
  records: UsageTurnRecordDTO[]
  locale: string
  rangeLabel: (from: number, to: number, total: number) => string
  prevLabel: string
  nextLabel: string
  emptyLabel: string
}) {
  const { t } = useI18n()
  const [page, setPage] = useState(0)

  if (records.length === 0) {
    return <div className="flex min-h-[72px] items-center justify-center text-sm text-muted-foreground">{emptyLabel}</div>
  }

  const pages = Math.ceil(records.length / RECORDS_PAGE_SIZE)
  const current = Math.min(page, pages - 1) // clamp if the range shrank the list
  const from = current * RECORDS_PAGE_SIZE
  const visible = records.slice(from, from + RECORDS_PAGE_SIZE)

  return (
    <div>
      <table className="w-full table-fixed border-collapse text-xs">
        <colgroup>
          <col className="w-[38%]" />
          <col />
          <col className="w-[18%]" />
          <col className="w-[14%]" />
        </colgroup>
        <thead>
          <tr className="border-b border-border/70 text-left text-caption font-medium text-muted-foreground">
            <th className="px-1 py-1.5">{t('settings.usage.col.date')}</th>
            <th className="px-1 py-1.5">{t('settings.usage.col.model')}</th>
            <th className="px-1 py-1.5 text-right">{t('settings.usage.col.tokens')}</th>
            <th className="px-1 py-1.5 text-right">{t('settings.usage.col.cost')}</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((r, i) => {
            const model = turnModelLabel(r)
            const rangeTitle = `${formatRecordTime(r.startTs, locale)} – ${formatRecordTime(r.endTs, locale)} · ${r.requests}`
            return (
              <tr key={`${r.startTs}-${r.endTs}-${from + i}`} className="border-b border-border/40 last:border-0">
                <td className="truncate px-1 py-1.5 tabular-nums text-muted-foreground" title={rangeTitle}>
                  {formatRecordTime(r.startTs, locale)}
                </td>
                <td className="truncate px-1 py-1.5" title={model.title}>
                  {model.label}
                </td>
                <td className="px-1 py-1.5 text-right tabular-nums">{formatTokenCount(r.tokens)}</td>
                <td className="px-1 py-1.5 text-right tabular-nums">{formatCost(r.cost)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <div className="mt-2 flex items-center justify-end gap-2">
        <span className="mr-auto text-caption tabular-nums text-muted-foreground">
          {rangeLabel(from + 1, from + visible.length, records.length)}
        </span>
        <RecordsPageButton label={prevLabel} direction="prev" disabled={current === 0} onClick={() => setPage(current - 1)} />
        <RecordsPageButton label={nextLabel} direction="next" disabled={current >= pages - 1} onClick={() => setPage(current + 1)} />
      </div>
    </div>
  )
}

function RecordsPageButton({
  label,
  direction,
  disabled,
  onClick
}: {
  label: string
  direction: 'prev' | 'next'
  disabled: boolean
  onClick: () => void
}) {
  const Icon = direction === 'prev' ? ChevronLeft : ChevronRight
  return (
    <Button variant="ghost" size="icon" aria-label={label} title={label} disabled={disabled} onClick={onClick} className="size-6">
      <Icon className="size-3.5" />
    </Button>
  )
}

export function UsageTrendsPanel({ stats, today }: { stats: UsageStatsDTO; today: string }) {
  const { t, locale } = useI18n()
  const [range, setRange] = useState<UsageRangeKey>('30d')
  const [groupBy, setGroupBy] = useState<UsageGroupBy>('model')

  const model = useMemo(
    () => buildUsageChartModel(stats, range, groupBy, today, t('settings.usage.other')),
    [stats, range, groupBy, today, t]
  )

  // Turns filtered into the selected range by their last request (records are
  // already newest-first).
  const rangeRecords = useMemo(() => {
    if (model.days.length === 0) return []
    const startTs = parseDay(model.days[0]).getTime()
    const endTs = parseDay(shiftDay(model.days[model.days.length - 1], 1)).getTime()
    return stats.records.filter((r) => r.endTs >= startTs && r.endTs < endTs)
  }, [stats, model])

  const exportCsv = () => {
    const header = ['Started', 'Ended', 'Models', 'Requests', 'Tokens', 'Cost (USD)'].join(',')
    const rows = rangeRecords.map((r) =>
      [
        new Date(r.startTs).toISOString(),
        new Date(r.endTs).toISOString(),
        r.models.map((m) => `${m.provider}/${m.model}`).join('; '),
        r.requests,
        r.tokens,
        r.cost
      ].map(csvCell).join(',')
    )
    // BOM so Excel opens UTF-8 correctly.
    const blob = new Blob(['\uFEFF' + [header, ...rows].join('\n')], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `pi-usage-${range}-${today}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  // Range-scoped summary. The token total deliberately lives only in the
  // Token activity panel above (the all-time headline); these cards carry what
  // the chart itself does not draw — requests and cost per selected range.
  const statCards = [
    { label: t('settings.usage.requests'), value: model.totalRequests, format: (v: number) => v.toLocaleString(locale) },
    { label: t('settings.usage.cost'), value: Math.round(model.totalCost * 10000), format: (v: number) => formatUsd(v / 10000) }
  ]

  return (
    <div className="flex flex-col gap-4">
      {/* summary cards */}
      <div className="grid grid-cols-1 gap-3 min-[560px]:grid-cols-2">
        {statCards.map((card) => (
          <div key={card.label} data-usage-stat={card.label} className="rounded-card border border-border/70 bg-card px-4 py-3.5">
            <div className="text-xs text-muted-foreground">{card.label}</div>
            <div className="mt-1 text-base font-semibold tabular-nums text-foreground">
              <NumberTicker
                value={card.value}
                format={card.format}
                duration={0.5}
                className="text-base font-semibold text-foreground"
              />
            </div>
          </div>
        ))}
      </div>

      {/* chart card */}
      <section className="rounded-card border border-border/70 bg-card p-4 sm:p-5">
        <div className="mb-3 flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
          <div>
            <div className="text-sm font-semibold text-foreground">{t('settings.usage.chart.title')}</div>
            <div className="mt-0.5 text-xs text-muted-foreground">{t('settings.usage.chart.subtitle')}</div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Select value={groupBy} onValueChange={(value) => setGroupBy(value as UsageGroupBy)}>
              <SelectTrigger
                aria-label={t('settings.usage.groupBy')}
                className="h-7 gap-1.5 rounded-control px-2.5 text-caption"
              >
                {groupBy === 'model' ? t('settings.usage.groupBy.model') : t('settings.usage.groupBy.provider')}
              </SelectTrigger>
              <SelectContent className="left-0 right-auto w-40">
                <SelectItem value="model" className="py-1.5">{t('settings.usage.groupBy.model')}</SelectItem>
                <SelectItem value="provider" className="py-1.5">{t('settings.usage.groupBy.provider')}</SelectItem>
              </SelectContent>
            </Select>
            <Tabs value={range} onValueChange={(value) => setRange(value as UsageRangeKey)} variant="segment" className="min-w-0">
              <TabsList className="h-7 bg-transparent p-0">
                {RANGE_KEYS.map((key) => (
                  <TabsTrigger key={key} value={key} className="min-h-0 px-2.5 py-1 text-caption">
                    {t(RANGE_LABELS[key])}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          </div>
        </div>

        {model.layers.length === 0 ? (
          <div className="flex min-h-[120px] items-center justify-center text-sm text-muted-foreground">
            {t('settings.usage.empty')}
          </div>
        ) : (
          <>
            <UsageAreaChart
              key={`${range}-${groupBy}`}
              model={model}
              locale={locale}
              todayLabel={t('settings.usage.today')}
              totalLabel={t('settings.usage.total')}
            />
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1.5">
              {model.legend.map((l) => (
                <div key={l.key} className="flex min-w-0 items-center gap-1.5 text-caption text-muted-foreground" title={`${l.label} · ${formatTokenCount(l.total)}`}>
                  <span className="size-2 shrink-0 rounded-full" style={{ background: l.color }} />
                  <span className="max-w-40 truncate">{l.label}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </section>

      {/* per-request records */}
      <section className="rounded-card border border-border/70 bg-card p-4 sm:p-5">
        <div className="mb-3 flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
          <div>
            <div className="text-sm font-semibold text-foreground">{t('settings.usage.records.title')}</div>
            {stats.recordsTruncated ? (
              <div className="mt-0.5 text-xs text-muted-foreground">
                {t('settings.usage.records.truncated', { count: stats.records.length })}
              </div>
            ) : null}
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={rangeRecords.length === 0}
            onClick={exportCsv}
            className="h-7 gap-1.5 px-2.5 text-caption"
          >
            <Download className="size-3.5" />
            {t('settings.usage.exportCsv')}
          </Button>
        </div>
        <UsageRecordsTable
          key={range}
          records={rangeRecords}
          locale={locale}
          rangeLabel={(from, to, total) => t('settings.usage.rowsRange', { from, to, total })}
          prevLabel={t('settings.usage.prevPage')}
          nextLabel={t('settings.usage.nextPage')}
          emptyLabel={t('settings.usage.empty')}
        />
      </section>
    </div>
  )
}
