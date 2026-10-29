import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { AlertCircle, Chart, ChevronRight, RefreshCw } from '@/lib/icons'
import { Button } from '@/components/motion/button'
import { AgentDisclosure } from '@/components/agents/agent-disclosure'
import { cn } from '@/lib/utils'
import { useI18n } from '@/i18n'
import type { MessageKey } from '@/i18n/locales/en'
import type { ContextBreakdownDTO, ContextCategoryDTO, ContextCategoryKind, ContextDetailDTO } from '../../../../shared/types'
import type { PiStore } from '@/state/pi-store'
import { FadeScroll } from './FadeScroll'

/** The breakdown's four buckets, in bar order. Fixed tones (not theme tokens)
 * for the three sizes: an all-primary bar reads as one category, and the accent
 * is the user's choice of hue in Settings → Appearance. */
const BUCKETS: Array<{ key: keyof Omit<ContextBreakdownDTO, 'total'>; labelKey: MessageKey; dot: string; bar: string }> = [
  { key: 'user', labelKey: 'contextDetail.breakdownUser', dot: 'bg-primary', bar: 'bg-primary' },
  { key: 'assistant', labelKey: 'contextDetail.breakdownAssistant', dot: 'bg-sky-500', bar: 'bg-sky-500' },
  { key: 'toolResults', labelKey: 'contextDetail.breakdownTools', dot: 'bg-amber-500', bar: 'bg-amber-500' }
]

/** One label-over-value cell of the responsive statistics grid. */
function Stat({ label, value, emphasis = false, className }: { label: string; value: ReactNode; emphasis?: boolean; className?: string }) {
  return (
    <div data-context-stat={label} className={cn('flex min-w-0 flex-col', className)}>
      <p className="flex-1 text-xs text-muted-foreground">{label}</p>
      <p data-context-stat-value title={typeof value === 'string' ? value : undefined}
        className={cn('mt-0.5 truncate tabular-nums text-foreground', emphasis ? 'text-xl font-medium leading-7' : 'text-sm')}>
        {value}
      </p>
    </div>
  )
}

const CATEGORY_GROUPS: Array<{ key: string; labelKey: MessageKey; kinds: ContextCategoryKind[] }> = [
  { key: 'instructions', labelKey: 'contextDetail.instructions', kinds: ['system', 'projectFiles', 'skills', 'toolSchemas'] },
  { key: 'conversation', labelKey: 'contextDetail.conversation', kinds: ['userText', 'images', 'assistantText', 'thinking',
    'toolCalls', 'toolResults', 'summaries', 'extensions', 'bash', 'requestOnly', 'other'] }
]

/** Each category keeps its own expansion through polls and CSS-only resizing. */
function CategoryRow({ category, total }: { category: ContextCategoryDTO; total: number }) {
  const { t, locale } = useI18n()
  const [open, setOpen] = useState(false)
  const panelId = useId()
  const label = t(`contextDetail.category.${category.kind}`)
  const expandable = category.items.length > 0 || category.omittedItems > 0
  const cells = <>
    <span className="flex min-w-0 items-center gap-1.5 text-foreground">
      {expandable ? <ChevronRight aria-hidden="true" className={cn('size-3 shrink-0 text-muted-foreground', open && 'rotate-90')} />
        : <span aria-hidden="true" className="size-3 shrink-0" />}
      <span className="min-w-0">{label}</span>
    </span>
    <span className="text-right tabular-nums text-foreground">~{formatCount(category.tokens, locale)}</span>
    <span className="text-right tabular-nums text-muted-foreground">{formatEstimatePercent(percentOf(category.tokens, total))}</span>
  </>
  const rowClass = 'context-category-row grid h-auto min-h-9 w-full gap-2 px-1 py-2 text-left text-xs font-normal'
  return (
    <div data-context-category={category.kind} role="listitem" className="min-w-0 border-b border-border/50">
      {expandable ? (
        <Button variant="ghost" size="sm" className={rowClass} aria-expanded={open} aria-controls={panelId}
          onClick={() => setOpen(value => !value)}>{cells}</Button>
      ) : <div className={rowClass}>{cells}</div>}
      {expandable ? (
        <AgentDisclosure id={panelId} open={open} data-context-category-items>
          <dl className="context-category-items mb-2 ml-2.5 border-l border-border pl-3">
            {category.items.map(item => (
              <div key={item.name} className="flex min-w-0 justify-between gap-3 py-1 text-xs text-muted-foreground">
                <dt className="min-w-0 truncate" title={item.name}>{item.name}</dt>
                <dd className="shrink-0 tabular-nums">~{formatCount(item.tokens, locale)}</dd>
              </div>
            ))}
          </dl>
          {category.omittedItems ? <p className="mb-2 pl-6 text-xs text-muted-foreground">{t('contextDetail.moreItems', { count: String(category.omittedItems) })}</p> : null}
        </AgentDisclosure>
      ) : null}
    </div>
  )
}

function CompositionCategories({ detail }: { detail: ContextDetailDTO }) {
  const { t } = useI18n()
  return (
    <div className="context-category-grid mt-4" data-context-categories>
      {CATEGORY_GROUPS.map(group => {
        const categories = group.kinds.flatMap(kind => detail.categories.filter(category => category.kind === kind))
        if (!categories.length) return null
        return (
          <section key={group.key} data-context-category-group={group.key} className="min-w-0">
            <div className="context-category-row grid items-end gap-2 border-b border-border px-1 pb-2 text-caption text-muted-foreground">
              <h3 className="font-medium text-foreground">{t(group.labelKey)}</h3>
              <span className="text-right">{t('contextDetail.categoryTokens')}</span>
              <span className="text-right">{t('contextDetail.categoryShare')}</span>
            </div>
            <div role="list">
              {categories.map(category => <CategoryRow key={category.kind} category={category} total={detail.breakdown.total} />)}
            </div>
          </section>
        )
      })}
    </div>
  )
}

function EstimateNotes({ request }: { request: boolean }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const panelId = useId()
  return (
    <div className="mt-3">
      <Button variant="ghost" size="sm" className="h-auto min-h-8 justify-start px-1 py-1.5 font-normal"
        aria-expanded={open} aria-controls={panelId} data-context-estimate-toggle onClick={() => setOpen(value => !value)}>
        <ChevronRight aria-hidden="true" className={cn('size-3 shrink-0', open && 'rotate-90')} />
        {t('contextDetail.estimateDetails')}
      </Button>
      <AgentDisclosure id={panelId} open={open} data-context-estimate-notes>
        <div className="max-w-3xl space-y-1 pt-2 text-xs leading-ui text-muted-foreground">
          <p>{t(request ? 'contextDetail.requestNote' : 'contextDetail.projectionNote')}</p>
          <p>{t('contextDetail.breakdownNote')}</p>
        </div>
      </AgentDisclosure>
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

  // No loading state: the readout paints the pane in one step. The transitional
  // centered "reading…" row is what the owner is testing against the diagonal
  // reveal, so while `detail` is absent the pane stays empty.
  if (!detail) return null

  const usage = detail.usage
  const breakdown = detail.breakdown
  const used = usage.tokens
  const reasoning = detail.tokens.reasoning

  return (
    <div data-context-pane data-context-session={sessionPath ?? undefined} className="sidebar-pane-container h-full min-h-0 min-w-0">
    <FadeScroll className="h-full p-4">
    <div className="pane-data mx-auto">
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

      <section className="context-section" data-context-section="current">
        <h2 className="text-sm font-medium text-foreground">{t('contextDetail.current')}</h2>
        <div data-context-current className="pane-stat-grid context-primary-grid mt-3 rounded-item bg-muted/30 p-3">
          <Stat emphasis label={t('contextDetail.usage')} value={usage.percent !== null ? formatEstimatePercent(usage.percent) : NONE} />
          <Stat emphasis label={t('contextDetail.contextTokens')} value={used !== null ? `~${formatCount(used, locale)}` : NONE} />
          <Stat emphasis label={t('contextDetail.contextLimit')} value={usage.contextWindow > 0 ? formatCount(usage.contextWindow, locale) : NONE} />
          <Stat emphasis label={t('contextDetail.projectionEstimate')} value={`~${formatCount(detail.projectionEstimate, locale)}`} />
        </div>
        <div className="pane-stat-grid context-config-grid mt-4" data-context-config>
          <Stat label={t('contextDetail.provider')} value={detail.provider ?? NONE} />
          <Stat label={t('contextDetail.model')} value={detail.model ?? NONE} />
          <Stat label={t('contextDetail.thinking')} value={detail.thinkingLevel ?? NONE} />
        </div>
      </section>

      <section className="context-section" data-context-section="composition">
        <h2 className="text-sm font-medium text-foreground">{t('contextDetail.breakdown')}</h2>
        <div className="pane-stat-grid context-source-grid mt-3" data-context-source>
          <Stat label={t('contextDetail.source')} value={t(detail.request ? 'contextDetail.sourceRequest' : 'contextDetail.sourceProjection')} />
          <Stat emphasis label={t('contextDetail.estimatedTotal')} value={`~${formatCount(breakdown.total, locale)}`} />
        </div>
        <div data-context-breakdown className="mt-4 flex h-2 w-full overflow-hidden rounded-detail bg-muted">
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
        <CompositionCategories key={`categories:${sessionPath}`} detail={detail} />
        <EstimateNotes key={`notes:${sessionPath}`} request={!!detail.request} />
      </section>

      {detail.request ? (
        <section className="context-section" data-context-section="request">
          <h2 className="text-sm font-medium text-foreground">{t('contextDetail.request')}</h2>
          <div className="pane-stat-grid context-request-grid mt-3" data-context-request>
            <Stat label={t('contextDetail.capturedAt')} value={formatStamp(detail.request.startedAt, locale)} />
            <Stat label={t('contextDetail.requestModel')} value={`${detail.request.provider} / ${detail.request.model}`} />
            <Stat label={t('contextDetail.requestId')} value={detail.request.id} />
            <Stat label={t('contextDetail.reportedInput')} value={detail.request.inputTokens === null ? NONE : formatCount(detail.request.inputTokens, locale)} />
            <Stat label={t('contextDetail.estimateDifference')} value={detail.request.inputTokens === null ? NONE
              : `${breakdown.total > detail.request.inputTokens ? '+' : ''}${formatCount(breakdown.total - detail.request.inputTokens, locale)}`} />
            <Stat label={t('contextDetail.payloadObserved')} value={t(detail.request.payloadCaptured ? 'contextDetail.observed' : 'contextDetail.unavailable')} />
          </div>
        </section>
      ) : null}

      <section className="context-section" data-context-section="session">
        <h2 className="text-sm font-medium text-foreground">{t('contextDetail.session')}</h2>
        <p data-context-note className="mt-1 max-w-3xl text-xs leading-ui text-muted-foreground">{t('contextDetail.cumulativeNote')}</p>
        <div className="context-session-groups mt-4">
          <section className="min-w-0" data-context-section="billing">
            <h3 className="text-xs font-medium text-foreground">{t('contextDetail.billing')}</h3>
            <div data-context-billing className="pane-stat-grid context-session-grid mt-3">
              <Stat label={t('contextDetail.billedTokens')} value={formatCount(detail.tokens.total, locale)} />
              <Stat label={t('contextDetail.cost')} value={formatCost(detail.cost, locale)} />
              <Stat label={t('contextDetail.inputTokens')} value={formatCount(detail.tokens.input, locale)} />
              <Stat label={t('contextDetail.outputTokens')} value={formatCount(detail.tokens.output, locale)} />
              <Stat label={t('contextDetail.reasoningTokens')} value={reasoning !== null ? formatCount(reasoning, locale) : NONE} />
              <Stat label={t('contextDetail.cacheHitLabel')} value={usage.cacheHitRate !== null ? formatRate(usage.cacheHitRate) : NONE} />
              <Stat className="col-span-full" label={t('contextDetail.cachedTokens')} value={`${formatCount(detail.tokens.cacheRead, locale)} / ${formatCount(detail.tokens.cacheWrite, locale)}`} />
            </div>
          </section>
          <section className="min-w-0" data-context-section="activity">
            <h3 className="text-xs font-medium text-foreground">{t('contextDetail.activity')}</h3>
            <div data-context-activity className="pane-stat-grid context-session-grid mt-3">
              <Stat className="col-span-full" label={t('contextDetail.messages')} value={formatCount(detail.totalMessages, locale)} />
              <Stat label={t('contextDetail.userMessages')} value={formatCount(detail.userMessages, locale)} />
              <Stat label={t('contextDetail.assistantMessages')} value={formatCount(detail.assistantMessages, locale)} />
              <Stat label={t('contextDetail.toolCalls')} value={formatCount(detail.toolCalls, locale)} />
              <Stat label={t('contextDetail.toolResults')} value={formatCount(detail.toolResults, locale)} />
              <Stat label={t('contextDetail.createdAt')} value={detail.createdAt !== null ? formatStamp(detail.createdAt, locale) : NONE} />
              <Stat label={t('contextDetail.lastActivity')} value={detail.lastActivity !== null ? formatStamp(detail.lastActivity, locale) : NONE} />
            </div>
          </section>
        </div>
      </section>
    </div>
    </FadeScroll>
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
