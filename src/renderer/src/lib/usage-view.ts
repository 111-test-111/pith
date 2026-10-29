import type {
  UsageStatsDTO
} from '../../../shared/types'

/**
 * Pure view-model builders for Settings → Usage, ported from pi-web's
 * lib/token-activity.ts and the chart shaping in components/UsageConfig.tsx.
 * No React, no DOM — everything here is derivable from a UsageStatsDTO
 * snapshot plus the snapshot's own "today".
 */

// ---------------------------------------------------------------------------
// Token activity (contribution-graph view model)
// ---------------------------------------------------------------------------

export interface TokenActivityPoint {
  day: string
  tokens: number
}

export interface TokenActivitySummary {
  totalTokens: number
  peakDailyTokens: number
  activeDays: number
  currentStreak: number
  longestStreak: number
}

export interface TokenActivity {
  summary: TokenActivitySummary
  daily: TokenActivityPoint[]
  calendarWeeks: Array<Array<TokenActivityPoint | null>>
  /** Tokens inside the visible 365-day window — what the grid draws. */
  visibleTokens: number
  maxVisibleDailyTokens: number
}

/** Midday anchor keeps pure day arithmetic clear of DST boundary shifts. */
export function parseDay(day: string): Date {
  const [year, month, date] = day.split('-').map(Number)
  return new Date(year, month - 1, date, 12)
}

export function dayKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

export function shiftDay(day: string, amount: number): string {
  const date = parseDay(day)
  date.setDate(date.getDate() + amount)
  return dayKey(date)
}

function aggregateDays(stats: UsageStatsDTO): Map<string, number> {
  const totals = new Map<string, number>()
  for (const model of stats.models) {
    for (const [day, point] of Object.entries(model.days)) {
      totals.set(day, (totals.get(day) ?? 0) + point.tokens)
    }
  }
  return totals
}

function streaks(activeDayKeys: string[], today: string): { current: number; longest: number } {
  const active = new Set(activeDayKeys)
  let current = 0
  for (let day = today; active.has(day); day = shiftDay(day, -1)) current += 1

  let longest = 0
  let run = 0
  let previous: string | null = null
  for (const day of activeDayKeys) {
    run = previous !== null && shiftDay(previous, 1) === day ? run + 1 : 1
    if (run > longest) longest = run
    previous = day
  }
  return { current, longest }
}

function dailySeries(totals: Map<string, number>, today: string): TokenActivityPoint[] {
  const start = shiftDay(today, -364)
  const points: TokenActivityPoint[] = []
  for (let day = start; day <= today; day = shiftDay(day, 1)) {
    points.push({ day, tokens: totals.get(day) ?? 0 })
  }
  return points
}

function calendarWeeks(daily: TokenActivityPoint[], today: string): Array<Array<TokenActivityPoint | null>> {
  const visible = new Map(daily.map((point) => [point.day, point.tokens]))
  const visibleStart = daily[0].day
  const startDate = parseDay(visibleStart)
  startDate.setDate(startDate.getDate() - startDate.getDay())
  const endDate = parseDay(today)
  endDate.setDate(endDate.getDate() + (6 - endDate.getDay()))

  const weeks: Array<Array<TokenActivityPoint | null>> = []
  let week: Array<TokenActivityPoint | null> = []
  for (let cursor = dayKey(startDate); cursor <= dayKey(endDate); cursor = shiftDay(cursor, 1)) {
    week.push(cursor < visibleStart || cursor > today ? null : { day: cursor, tokens: visible.get(cursor) ?? 0 })
    if (week.length === 7) {
      weeks.push(week)
      week = []
    }
  }
  return weeks
}

export function buildTokenActivity(stats: UsageStatsDTO, today: string): TokenActivity {
  const totals = aggregateDays(stats)
  const activeDayKeys = [...totals.entries()]
    .filter(([, tokens]) => tokens > 0)
    .map(([day]) => day)
    .sort()
  const { current, longest } = streaks(activeDayKeys, today)
  const daily = dailySeries(totals, today)
  const weeks = calendarWeeks(daily, today)

  return {
    summary: {
      totalTokens: stats.totalTokens,
      peakDailyTokens: Math.max(0, ...totals.values()),
      activeDays: activeDayKeys.length,
      currentStreak: current,
      longestStreak: longest
    },
    daily,
    calendarWeeks: weeks,
    visibleTokens: daily.reduce((sum, point) => sum + point.tokens, 0),
    maxVisibleDailyTokens: Math.max(0, ...daily.map((point) => point.tokens))
  }
}

/** Log-scaled 0–4 level like GitHub's contribution graph. */
export function tokenActivityLevel(tokens: number, maxTokens: number): 0 | 1 | 2 | 3 | 4 {
  if (tokens <= 0 || maxTokens <= 0) return 0
  if (maxTokens <= 1) return 4
  const level = Math.ceil((Math.log10(tokens) / Math.log10(maxTokens)) * 4)
  return Math.max(1, Math.min(4, level)) as 1 | 2 | 3 | 4
}

// ---------------------------------------------------------------------------
// Usage trends (stacked cumulative area chart view model)
// ---------------------------------------------------------------------------

export type UsageRangeKey = '7d' | '30d' | 'mtd' | 'lastMonth' | 'all'
export type UsageGroupBy = 'model' | 'provider'

/** Continuous local YYYY-MM-DD list covered by the range (inclusive). */
export function usageRangeDays(range: UsageRangeKey, today: string, firstDay: string | null): string[] {
  let start: string
  let end = today
  switch (range) {
    case '7d':
      start = shiftDay(today, -6)
      break
    case '30d':
      start = shiftDay(today, -29)
      break
    case 'mtd':
      start = `${today.slice(0, 8)}01`
      break
    case 'lastMonth': {
      const prevEnd = shiftDay(`${today.slice(0, 8)}01`, -1)
      start = `${prevEnd.slice(0, 8)}01`
      end = prevEnd
      break
    }
    case 'all': {
      const floor = shiftDay(today, -364)
      start = firstDay ?? today
      if (start < floor) start = floor
      if (start > end) start = today
      break
    }
  }
  const days: string[] = []
  for (let d = start; d <= end; d = shiftDay(d, 1)) days.push(d)
  return days
}

export interface UsageLayer {
  /** Group key (provider/model id, not the label — labels can collide). */
  key: string
  label: string
  color: string
  /** Tokens per range day. */
  daily: number[]
  /** Running sum of daily within the range. */
  cum: number[]
  /** Stack boundaries: bottom/top edge per day (cumulative across layers). */
  bottom: number[]
  top: number[]
  /** Range totals. */
  total: number
  cost: number
  requests: number
}

export interface UsageChartModel {
  days: string[]
  /** Bottom→top stacking order (Other and the smallest series at the bottom). */
  layers: UsageLayer[]
  /** Top→bottom (largest first) for legend/tooltip. */
  legend: UsageLayer[]
  maxTotal: number
  totalTokens: number
  totalCost: number
  totalRequests: number
  todayIndex: number
}

export const MAX_USAGE_SERIES = 8

/**
 * Catppuccin-latte hues — medium saturation, readable on both light and dark
 * panels. Chart series colors are data, not chrome: they deliberately do not
 * follow the accent presets (a stacked chart needs distinguishable hues).
 */
export const USAGE_PALETTE = ['#40a02b', '#1e66f5', '#8839ef', '#fe640b', '#179299', '#df8e1d', '#d20f39', '#04a5e5']
export const USAGE_OTHER_COLOR = '#6c6f85'

export function buildUsageChartModel(
  stats: UsageStatsDTO,
  range: UsageRangeKey,
  groupBy: UsageGroupBy,
  today: string,
  otherLabel: string
): UsageChartModel {
  const days = usageRangeDays(range, today, stats.firstDay)
  const dayIndex = new Map(days.map((d, i) => [d, i]))

  interface Group { label: string; daily: number[]; cost: number; requests: number; total: number }
  const groups = new Map<string, Group>()
  for (const m of stats.models) {
    const gkey = groupBy === 'model' ? m.key : m.provider
    const label = groupBy === 'model' ? m.model : m.provider
    let g = groups.get(gkey)
    if (!g) {
      g = { label, daily: new Array(days.length).fill(0), cost: 0, requests: 0, total: 0 }
      groups.set(gkey, g)
    }
    for (const [day, p] of Object.entries(m.days)) {
      if (!p) continue
      const i = dayIndex.get(day)
      if (i === undefined) continue
      g.daily[i] += p.tokens
      g.cost += p.cost
      g.requests += p.requests
      g.total += p.tokens
    }
  }

  let totalTokens = 0
  let totalCost = 0
  let totalRequests = 0
  for (const g of groups.values()) {
    totalTokens += g.total
    totalCost += g.cost
    totalRequests += g.requests
  }

  const sorted = [...groups.entries()]
    .filter(([, g]) => g.total > 0)
    .sort((a, b) => b[1].total - a[1].total)
  const top = sorted.slice(0, MAX_USAGE_SERIES)
  const rest = sorted.slice(MAX_USAGE_SERIES)

  const legendOrder: Array<Group & { key: string; color: string }> = top.map(([gkey, g], i) => ({
    ...g,
    key: gkey,
    color: USAGE_PALETTE[i % USAGE_PALETTE.length]
  }))
  if (rest.length > 0) {
    const other: Group & { key: string; color: string } = {
      key: '__other__',
      label: otherLabel,
      color: USAGE_OTHER_COLOR,
      daily: new Array(days.length).fill(0),
      cost: 0,
      requests: 0,
      total: 0
    }
    for (const [, g] of rest) {
      for (let i = 0; i < days.length; i++) other.daily[i] += g.daily[i]
      other.cost += g.cost
      other.requests += g.requests
      other.total += g.total
    }
    legendOrder.push(other)
  }

  // Stack bottom→top = reverse legend: Other/smallest at the bottom, largest on top.
  let running = new Array(days.length).fill(0) as number[]
  const layers: UsageLayer[] = [...legendOrder].reverse().map((g) => {
    const cum: number[] = []
    let acc = 0
    for (let i = 0; i < days.length; i++) {
      acc += g.daily[i]
      cum.push(acc)
    }
    const bottom = running
    const topB = cum.map((v, i) => v + bottom[i])
    running = topB
    return { key: g.key, label: g.label, color: g.color, daily: g.daily, cum, bottom, top: topB, total: g.total, cost: g.cost, requests: g.requests }
  })

  return {
    days,
    layers,
    legend: [...layers].reverse(),
    maxTotal: running.reduce((a, b) => Math.max(a, b), 0),
    totalTokens,
    totalCost,
    totalRequests,
    todayIndex: days.indexOf(today)
  }
}

/** Locale-aware compact token counts for axes and tooltips. */
export function formatCompactTokens(tokens: number, locale: string): string {
  return new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(tokens)
}

// ---------------------------------------------------------------------------
// SVG path helpers
// ---------------------------------------------------------------------------

/** Round to 2 decimals — keeps path strings small without visible jaggies. */
function r2(n: number): number {
  return Math.round(n * 100) / 100
}

/** "Nice" axis maximum (1/2/2.5/5 × 10^n). */
export function niceMax(v: number): number {
  if (v <= 0) return 1
  const exp = Math.floor(Math.log10(v))
  const base = 10 ** exp
  const f = v / base
  const nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10
  return nf * base
}

function polyline(xs: number[], ys: number[]): string {
  return xs.map((x, i) => `${i === 0 ? 'M' : 'L'} ${r2(x)} ${r2(ys[i])}`).join(' ')
}

/**
 * Smooth cubic through EVERY point (Fritsch–Carlson monotone tangents).
 *
 * A quadratic-midpoint spline (the previous shape) only touches the midpoints
 * between samples, so the curve at a day's x is not that day's value — and the
 * crosshair dot, anchored to the day's value, floated above or below the line
 * it was supposed to mark. Interpolating with monotone tangents keeps the
 * curve exactly through each vertex, refuses overshoot (no dip below the
 * previous day's cumulative total), and still reads as one smooth line.
 * `xs` may be ascending or descending: the tangent weights flip sign together,
 * so the result is the same curve either way (`areaPath` walks the bottom edge
 * backwards).
 */
export function smoothLine(xs: number[], ys: number[]): string {
  const n = xs.length
  if (n === 0) return ''
  if (n === 1) return `M ${r2(xs[0])} ${r2(ys[0])} L ${r2(xs[0] + 0.01)} ${r2(ys[0])}`

  const dx: number[] = []
  const slope: number[] = []
  for (let i = 0; i < n - 1; i++) {
    const d = xs[i + 1] - xs[i]
    // Two samples on one x cannot be interpolated — fall back to the plain
    // polyline rather than dividing by zero.
    if (d === 0) return polyline(xs, ys)
    dx.push(d)
    slope.push((ys[i + 1] - ys[i]) / d)
  }

  const m: number[] = new Array(n)
  m[0] = slope[0]
  m[n - 1] = slope[n - 2]
  for (let i = 1; i < n - 1; i++) {
    if (slope[i - 1] * slope[i] <= 0) {
      m[i] = 0
      continue
    }
    const w1 = 2 * dx[i] + dx[i - 1]
    const w2 = dx[i] + 2 * dx[i - 1]
    m[i] = (w1 + w2) / (w1 / slope[i - 1] + w2 / slope[i])
  }

  // Fritsch–Carlson: pull the tangents back inside the monotone region.
  for (let i = 0; i < n - 1; i++) {
    if (slope[i] === 0) {
      m[i] = 0
      m[i + 1] = 0
      continue
    }
    const a = m[i] / slope[i]
    const b = m[i + 1] / slope[i]
    const s = a * a + b * b
    if (s > 9) {
      const t = 3 / Math.sqrt(s)
      m[i] = t * a * slope[i]
      m[i + 1] = t * b * slope[i]
    }
  }

  let d = `M ${r2(xs[0])} ${r2(ys[0])}`
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i] / 3
    d += ` C ${r2(xs[i] + h)} ${r2(ys[i] + m[i] * h)} ${r2(xs[i + 1] - h)} ${r2(ys[i + 1] - m[i + 1] * h)} ${r2(xs[i + 1])} ${r2(ys[i + 1])}`
  }
  return d
}

export function areaPath(xs: number[], topYs: number[], bottomYs: number[]): string {
  const top = smoothLine(xs, topYs)
  const bottom = smoothLine([...xs].reverse(), [...bottomYs].reverse()).replace(/^M/, 'L')
  return `${top} ${bottom} Z`
}
