import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { AlertCircle, Chart, RefreshCw } from '@/lib/icons'
import { Button } from '@/components/motion/button'
import { Loader } from '@/components/motion/loader'
import { LabelTooltip } from './LabelTooltip'
import { cn } from '@/lib/utils'
import { useI18n } from '@/i18n'
import type { MessageKey } from '@/i18n/locales/en'
import type { ContextBreakdownDTO, ContextDetailDTO } from '../../../../shared/types'
import type { PiStore } from '@/state/pi-store'

/** The breakdown's four buckets, in bar order. Fixed tones (not theme tokens)
 * for the three sizes: an all-primary bar reads as one category, and the accent
 * is the user's choice of hue in Settings → Appearance. */
const BUCKETS: Array<{ key: keyof Omit<ContextBreakdownDTO, 'total'>; labelKey: MessageKey; dot: string; bar: string }> = [
  { key: 'user', labelKey: 'contextDetail.breakdownUser', dot: 'bg-primary', bar: 'bg-primary' },
  { key: 'assistant', labelKey: 'contextDetail.breakdownAssistant', dot: 'bg-sky-500', bar: 'bg-sky-500' },
  { key: 'toolResults', labelKey: 'contextDetail.breakdownTools', dot: 'bg-amber-500', bar: 'bg-amber-500' }
]

/** One label-over-value cell of the two-column grid. */
function Stat({ label, value, className }: { label: string; value: ReactNode; className?: string }) {
  return (
    <div data-context-stat={label} className={cn('min-w-0', className)}>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p data-context-stat-value className="mt-0.5 truncate text-sm tabular-nums text-foreground">
        {value}
      </p>
    </div>
  )
}

/** The grid cannot show a number it does not have; `—` keeps the row present so
 * the pane does not reflow as fields become known. */
const NONE = '—'

/** Exact, locale-grouped counts: this pane is where a reader comes for the real
 * number, so nothing here is abbreviated to `53.5k`. */
function formatCount(n: number, locale: string): string {
  return n.toLocaleString(locale)
}

/** One decimal — all an estimated percentage can honestly carry. */
function formatEstimatePercent(percent: number): string {
  return `${percent.toFixed(1)}%`
}

/** Two decimals: the cache hit rate is a ratio of two provider-reported
 * integers, so the second decimal is real information, not noise. */
function formatRate(rate: number): string {
  return `${(rate * 100).toFixed(2)}%`
}

/** Cost at the precision the provider priced it: two decimals for ordinary
 * amounts, and up to six for a session that has spent a fraction of a cent
 * (`$0.00` for money that was really spent would be worse than noise). `Intl`
 * also gets the currency's own placement right per locale (`US$` in zh-CN). */
function formatCost(cost: number, locale: string): string {
  const small = cost > 0 && cost < 0.01
  return cost.toLocaleString(locale, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: small ? 4 : 2,
    maximumFractionDigits: small ? 6 : 4
  })
}

function percentOf(value: number, total: number): number {
  return total > 0 ? (value / total) * 100 : 0
}

/**
 * Context tab of the right rail: what the composer's ring shows, in full.
 * Opened by clicking the ring (or from the rail's picker).
 *
 * It moves with the ring: main pushes `context_usage` on a 2s poll and on every
 * turn boundary, and each one re-reads this pane — so the numbers here are
 * never a stale snapshot of a session that has moved on. The readout itself is
 * a handful of in-memory numbers (the SDK's own stats plus one estimate pass
 * over the context), which is what makes following a 2s ping affordable.
 */
export function ContextDetailPane({ store }: { store: PiStore }) {
  const { t, locale } = useI18n()
  const sessionPath = useSyncExternalStore(store.subscribe, () => store.getShell().sessionPath)
  // Identity changes exactly when main emits a new readout, which is the signal
  // this pane refetches on (a turn in progress, or a turn boundary).
  const ringUsage = useSyncExternalStore(store.subscribe, () => store.getShell().contextUsage)
  const isStreaming = useSyncExternalStore(store.subscribe, () => store.getShell().isStreaming)
  const [detail, setDetail] = useState<ContextDetailDTO | null>(null)
  const [failed, setFailed] = useState(false)
  const [manualBusy, setManualBusy] = useState(false)
  // Load generations: an overlapping refresh must not be overwritten by the
  // answer to an older request.
  const generation = useRef(0)

  const load = useCallback(async () => {
    const path = store.getShell().sessionPath
    if (!path) return
    const id = ++generation.current
    try {
      const next = await window.pi.contextDetail(path)
      if (id !== generation.current) return
      setDetail(next)
      setFailed(false)
    } catch {
      if (id === generation.current) setFailed(true)
    }
  }, [store])

  // Mount, session switch, and every ring update. The turn boundary is included
  // on top because the counts and totals move there even when the ring's own
  // payload happens to be unchanged.
  useEffect(() => {
    void load()
  }, [load, sessionPath, ringUsage, isStreaming])

  const refresh = useCallback(async () => {
    setManualBusy(true)
    try {
      await load()
    } finally {
      setManualBusy(false)
    }
  }, [load])

  if (!detail && failed) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
        <AlertCircle aria-hidden="true" className="size-6 text-muted-foreground/70" />
        <p className="text-sm text-muted-foreground">{t('contextDetail.error')}</p>
        <Button variant="secondary" size="sm" onClick={() => void refresh()}>
          <RefreshCw aria-hidden="true" className="size-3.5" />
          {t('contextDetail.retry')}
        </Button>
      </div>
    )
  }

  if (!detail) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
        <Loader variant="spinner" size={20} label={t('contextDetail.loading')} className="text-primary" />
        <p className="text-sm text-muted-foreground">{t('contextDetail.loading')}</p>
      </div>
    )
  }

  const usage = detail.usage
  const breakdown = detail.breakdown
  const used = usage.tokens
  const reasoning = detail.tokens.reasoning

  return (
    <div className="h-full overflow-y-auto p-4">
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-2">
          <Chart aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate text-sm font-medium text-foreground">{t('contextDetail.title')}</span>
        </span>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t('contextDetail.refresh')}
          onClick={() => void refresh()}
        >
          <RefreshCw aria-hidden="true" className={cn('size-3.5', manualBusy && 'animate-spin')} />
        </Button>
      </div>

      {/* A refresh that failed keeps the readout the user is looking at and says
          so above it, instead of blanking the pane or failing silently. */}
      {failed ? (
        <div role="alert" data-context-error className="mt-2 flex items-center justify-between gap-2 rounded-item border border-destructive/40 bg-destructive/5 px-2.5 py-1.5">
          <span className="text-xs text-destructive">{t('contextDetail.error')}</span>
          <Button variant="ghost" size="sm" onClick={() => void refresh()}>
            {t('contextDetail.retry')}
          </Button>
        </div>
      ) : null}

      {/* Two columns of label-over-value cells, the recipe the rest of the app's
          readouts use. The session name spans both: it is the one field that can
          be long enough to wrap. */}
      <div className="mt-4 grid grid-cols-2 gap-x-6 gap-y-4">
        <Stat
          className="col-span-2"
          label={t('contextDetail.session')}
          value={
            detail.title ? (
              <LabelTooltip content={detail.title}>
                <span className="block truncate">{detail.title}</span>
              </LabelTooltip>
            ) : (
              t('contextDetail.untitled')
            )
          }
        />
        <Stat label={t('contextDetail.messages')} value={formatCount(detail.totalMessages, locale)} />
        <Stat label={t('contextDetail.thinking')} value={detail.thinkingLevel ?? NONE} />
        <Stat label={t('contextDetail.provider')} value={detail.provider ?? NONE} />
        <Stat label={t('contextDetail.model')} value={detail.model ?? NONE} />
        <Stat
          label={t('contextDetail.contextLimit')}
          value={usage.contextWindow > 0 ? formatCount(usage.contextWindow, locale) : NONE}
        />
        <Stat label={t('contextDetail.billedTokens')} value={formatCount(detail.tokens.total, locale)} />
        <Stat label={t('contextDetail.usage')} value={usage.percent !== null ? formatEstimatePercent(usage.percent) : NONE} />
        <Stat label={t('contextDetail.contextTokens')} value={used !== null ? `~${formatCount(used, locale)}` : NONE} />
        <Stat label={t('contextDetail.inputTokens')} value={formatCount(detail.tokens.input, locale)} />
        <Stat label={t('contextDetail.outputTokens')} value={formatCount(detail.tokens.output, locale)} />
        <Stat
          label={t('contextDetail.reasoningTokens')}
          value={reasoning !== null ? formatCount(reasoning, locale) : NONE}
        />
        <Stat
          label={t('contextDetail.cacheHitLabel')}
          value={usage.cacheHitRate !== null ? formatRate(usage.cacheHitRate) : NONE}
        />
        <Stat
          label={t('contextDetail.cachedTokens')}
          value={`${formatCount(detail.tokens.cacheRead, locale)} / ${formatCount(detail.tokens.cacheWrite, locale)}`}
        />
        <Stat label={t('contextDetail.cost')} value={formatCost(detail.cost, locale)} />
        <Stat label={t('contextDetail.userMessages')} value={formatCount(detail.userMessages, locale)} />
        <Stat label={t('contextDetail.assistantMessages')} value={formatCount(detail.assistantMessages, locale)} />
        <Stat label={t('contextDetail.toolCalls')} value={formatCount(detail.toolCalls, locale)} />
        <Stat label={t('contextDetail.toolResults')} value={formatCount(detail.toolResults, locale)} />
        <Stat label={t('contextDetail.createdAt')} value={detail.createdAt !== null ? formatStamp(detail.createdAt, locale) : NONE} />
        <Stat label={t('contextDetail.lastActivity')} value={detail.lastActivity !== null ? formatStamp(detail.lastActivity, locale) : NONE} />
      </div>

      {/* The counts, tokens and cost above are the SDK's own SESSION-WIDE totals:
          a resent, retried or forked session carries the abandoned branches in
          its file, and those were really billed. Saying so is cheaper than
          having a number quietly disagree with the transcript. */}
      <p data-context-note className="mt-3 text-xs leading-5 text-muted-foreground">
        {t('contextDetail.cumulativeNote')}
      </p>

      {/* Breakdown: the four buckets sum to the ring's own context size (the
          residue is the system prompt plus the tool schemas), so the bar and the
          ring can never disagree. Everything here is an estimate, and it says
          so. */}
      <section className="mt-6">
        <h3 className="text-xs font-medium text-muted-foreground">{t('contextDetail.breakdown')}</h3>
        <div data-context-breakdown className="mt-2 flex h-2 w-full overflow-hidden rounded-detail bg-muted">
          {BUCKETS.map((bucket) => (
            <span
              key={bucket.key}
              data-context-segment={bucket.key}
              className={bucket.bar}
              style={{ width: `${percentOf(breakdown[bucket.key], breakdown.total)}%` }}
            />
          ))}
          <span
            data-context-segment="other"
            className="bg-muted-foreground/40"
            style={{ width: `${percentOf(breakdown.other, breakdown.total)}%` }}
          />
        </div>
        <ul className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1.5">
          {[...BUCKETS, { key: 'other' as const, labelKey: 'contextDetail.breakdownOther' as MessageKey, dot: 'bg-muted-foreground/40', bar: '' }].map((bucket) => (
            <li key={bucket.key} className="flex items-center gap-1.5">
              <span aria-hidden="true" className={cn('size-2 rounded-full', bucket.dot)} />
              <span className="text-xs text-muted-foreground">{t(bucket.labelKey)}</span>
              <span className="text-xs tabular-nums text-foreground">
                {formatEstimatePercent(percentOf(breakdown[bucket.key], breakdown.total))}
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-xs leading-5 text-muted-foreground">{t('contextDetail.breakdownNote')}</p>
      </section>
    </div>
  )
}

/** Absolute session timestamps at minute precision — the pane answers "when",
 * not "how long ago", and a relative label would go stale under a pane that
 * re-reads on every ring update. */
function formatStamp(timestamp: number, locale: string): string {
  return new Date(timestamp).toLocaleString(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}
