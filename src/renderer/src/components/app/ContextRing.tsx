import type { ReactNode } from 'react'

import { AnimatedNumber } from '@/components/motion/animated-number'
import { Button } from '@/components/motion/button'
import { NumberTicker } from '@/components/motion/number-ticker'
import { Tooltip } from '@/components/motion/tooltip'
import { useI18n } from '@/i18n'
import type { ContextUsageDTO } from '../../../../shared/types'

/** Hover-open delay mirrors the reference ring: brief pauses don't flicker. */
const HOVER_DELAY_MS = 350

/**
 * Placeholder a translated sentence marks, then has swapped for a live number
 * node. `t()` interpolates strings only, so the slot is written as a sentinel
 * and split back out — the sentence stays one i18n key, which keeps word order
 * (and `%` / `~` placement) the translator's call.
 */
const NUMBER_SLOT = '\u0000'

function fillSlot(template: string, node: ReactNode): ReactNode {
  const [before, after] = template.split(NUMBER_SLOT)
  return (
    <>
      {before}
      {node}
      {after ?? ''}
    </>
  )
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1000).toFixed(1)}K`
  return String(n)
}

function formatCost(cost: number): string | null {
  if (!(cost > 0)) return null
  return `$${cost.toFixed(4)}`
}

/**
 * Composer context-usage ring (bottom-right of the input box): a 14px arc of
 * the context window that fills as the session grows. Hovering opens a beUI
 * Tooltip with the full readout — percent used, estimated tokens of the window
 * (the in-flight message included), cache hit rate and session cost — all
 * straight from the SDK's AgentSession.getContextUsage() plus the session's
 * accumulated usage. The value is refreshed by the main process' 2s poll and on
 * every turn boundary, so hovering just reveals a readout that is already
 * current.
 *
 * Clicking opens the rail's context tab, which is the same readout plus the
 * fields the bubble has no room for. The trigger is therefore a real button
 * when a caller wires one up (the tooltip's own press rule then takes the
 * bubble away on the click that opened the pane) and stays a plain `status`
 * readout in a view with no rail to open, like an opened subagent child.
 *
 * The numbers are printed at full precision (exact token count, one decimal of
 * percent) on purpose: on a large window a coarse readout moves so rarely that a
 * live ring reads as frozen.
 */
export function ContextRing({ usage, onOpen }: { usage: ContextUsageDTO | null; onOpen?: () => void }) {
  const { t } = useI18n()

  if (!usage || !usage.contextWindow) return null

  const percent = usage.percent
  const radius = 5.5
  const circumference = 2 * Math.PI * radius
  const used = percent !== null ? Math.min(Math.max(percent, 0), 100) / 100 : 0
  // Tokens are an estimate; fall back to a percent-derived count when the SDK
  // cannot anchor one yet (e.g. right after compaction).
  const usedTokens =
    usage.tokens ?? (percent !== null ? Math.round((usage.contextWindow * percent) / 100) : null)
  const cost = formatCost(usage.sessionCost)
  // One decimal: high-hit sessions sit near the ceiling and integer rounding
  // reports a misleading 100%.
  const cacheHit =
    usage.cacheHitRate !== null ? `${(usage.cacheHitRate * 100).toFixed(1)}%` : null

  return (
    <Tooltip
      side="top"
      delay={HOVER_DELAY_MS}
      className="w-56 whitespace-normal rounded-xl px-3.5 py-3 text-left font-normal"
      content={
        <div>
          <p className="text-sm font-medium tabular-nums text-foreground">
            {percent !== null
              ? fillSlot(
                  t('context.used', { percent: NUMBER_SLOT }),
                  <AnimatedNumber value={percent} format={(n) => n.toFixed(1)} duration={0.7} />
                )
              : '—'}
          </p>
          <p className="mt-0.5 text-xs tabular-nums text-muted-foreground">
            {usedTokens !== null
              ? fillSlot(
                  t('context.tokens', {
                    used: NUMBER_SLOT,
                    total: formatTokens(usage.contextWindow)
                  }),
                  <NumberTicker value={usedTokens} prefix="~" locale duration={0.7} />
                )
              : '—'}
          </p>
          <div className="mt-2.5 grid grid-cols-2 gap-3 border-t border-border pt-2.5">
            <div className="min-w-0">
              <p className="truncate text-micro font-medium uppercase tracking-wide text-muted-foreground/70">
                {t('context.cacheHitLabel')}
              </p>
              <p
                className={`mt-0.5 text-xs font-medium tabular-nums ${
                  cacheHit !== null && usage.cacheHitRate! >= 0.8
                    ? 'text-emerald-600 dark:text-emerald-400'
                    : 'text-foreground'
                }`}
              >
                {cacheHit ?? '—'}
              </p>
            </div>
            <div className="min-w-0">
              <p className="truncate text-micro font-medium uppercase tracking-wide text-muted-foreground/70">
                {t('context.costLabel')}
              </p>
              <p className="mt-0.5 truncate text-xs font-medium tabular-nums text-foreground">
                {cost ?? '—'}
              </p>
            </div>
          </div>
        </div>
      }
    >
      <Button
        variant="ghost"
        size="icon"
        aria-label={t('context.label')}
        onClick={onOpen}
      >
        <svg width={14} height={14} viewBox="0 0 16 16" style={{ transform: 'rotate(-90deg)' }} aria-hidden="true">
          <circle cx={8} cy={8} r={radius} fill="none" strokeWidth={2.4} className="stroke-muted-foreground/30" />
          {used > 0 ? (
            <circle
              cx={8}
              cy={8}
              r={radius}
              fill="none"
              strokeWidth={2.4}
              strokeLinecap="round"
              strokeDasharray={`${used * circumference} ${circumference}`}
              className="stroke-primary transition-[stroke-dasharray] duration-500"
            />
          ) : null}
        </svg>
      </Button>
    </Tooltip>
  )
}
