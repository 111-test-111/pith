import { Ban, CircleCheck, CircleX } from './icons'
import { cn } from './utils'

/**
 * The app's status marks: one small circle per outcome — waiting, done, failed,
 * cancelled.
 *
 * Settled marks use the adapter's active family: Remix Line filled outlines for
 * square interfaces, Hugeicons Stroke Rounded for squircle interfaces. Their
 * own native geometry/weight survives; no row introduces a private settled mark.
 *
 * Waiting stays drawn here, because it is the one status that moves: the same
 * r=9 / 1.5px circle as a 3/4 arc (`pathLength` 1 with a 0.75/0.25 dash) that
 * the todo rows and the sidebar's live spin also draw, spun with `animate-spin`
 * and held still under reduced motion. No glyph carries that arc.
 *
 * Sizing belongs to the call site's Tailwind class (`size-3` in a tool row,
 * `size-4` in a task-strip row); the glyph's 18px width/height are the fallback
 * and CSS wins over them.
 */
export type StatusRingStatus = 'running' | 'success' | 'error' | 'cancelled'

/** One shared adapter glyph per settled outcome. */
const SETTLED_GLYPHS = {
  success: CircleCheck,
  error: CircleX,
  cancelled: Ban
} as const

/** Stroke-family weight; the Remix Line adapter preserves its filled outlines. */
const SETTLED_STROKE = 1.5

/** The waiting arc's centerline radius in the 24 box the app's marks share. */
const RING_RADIUS = 9

export function StatusRing({
  status,
  reduce = false,
  className
}: {
  status: StatusRingStatus
  /** Reduced motion: the waiting arc holds still instead of spinning. */
  reduce?: boolean
  className?: string
}) {
  if (status !== 'running') {
    const Glyph = SETTLED_GLYPHS[status]
    return <Glyph data-status-ring={status} strokeWidth={SETTLED_STROKE} className={cn('shrink-0', className)} />
  }

  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 24 24"
      fill="none"
      data-status-ring={status}
      className={cn('shrink-0', !reduce && 'animate-spin', className)}
    >
      <circle
        cx="12"
        cy="12"
        r={RING_RADIUS}
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        // The waiting ring is the same 3/4 arc the todo rows and the sidebar's
        // live spin draw, so one glance reads all three panels as "running".
        pathLength={1}
        strokeDasharray="0.75 0.25"
      />
    </svg>
  )
}
