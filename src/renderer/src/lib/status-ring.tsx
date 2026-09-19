import { cn } from './utils'

/**
 * The app's own status rings: one small circle per outcome — waiting, done,
 * failed, cancelled.
 *
 * These are deliberately NOT part of the pack table in `lib/icons.tsx`. A pack
 * glyph answers "what does this style's artwork look like", which is right for
 * a tool's kind, a toolbar button or a settings control, but wrong for a status
 * ring: the square pack draws Carbon's square `CheckboxChecked` and
 * `SquareSlash` for the two marks that must stay circular, so the same row read
 * as a checkbox in 直角 mode and as a circle in 圆角 mode. A status ring is
 * geometry, not a style choice — it is the task strip's shared vocabulary
 * (todo rows and the sidebar's live spin already draw this exact r=9 / 1.5
 * stroke circle app-side, see `lib/animated-icons.tsx` for the marks it reuses),
 * so it draws here, once, and every pack renders it identically.
 *
 * Geometry is fixed to the 24 box the app's other stroke marks use:
 *   ring    r=9 at 12,12, 1.5 stroke — spans 3…21, the box the todo rows use
 *   marks   24-box paths mapped by `translate(3 3) scale(0.75)`, so a 2 stroke
 *           lands at the ring's own 1.5 weight
 *   slash   the ring's inscribed 45° chord, so a cancel ends ON the circle
 */
export type StatusRingStatus = 'running' | 'success' | 'error' | 'cancelled'

const RING_RADIUS = 9
/** 12 − r/√2: where a 45° chord meets the ring, so the slash touches it. */
const CHORD = Number((12 - RING_RADIUS / Math.SQRT2).toFixed(2))

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
  const running = status === 'running'
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 24 24"
      fill="none"
      data-status-ring={status}
      className={cn('shrink-0', running && !reduce && 'animate-spin', className)}
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
        {...(running ? { pathLength: 1, strokeDasharray: '0.75 0.25' } : {})}
      />
      {status === 'success' || status === 'error' ? (
        <g
          transform="translate(3 3) scale(0.75)"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          {status === 'success' ? (
            <path d="M20 6 9 17l-5-5" />
          ) : (
            <>
              <path d="M18 6 6 18" />
              <path d="m6 6 12 12" />
            </>
          )}
        </g>
      ) : null}
      {status === 'cancelled' ? (
        <path
          d={`M${CHORD} ${CHORD} ${24 - CHORD} ${24 - CHORD}`}
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      ) : null}
    </svg>
  )
}
