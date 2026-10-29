import { motion, useReducedMotion } from 'motion/react'
import type { ReactNode } from 'react'
import { DURATION, EASE_OUT, motionTransition } from '@/lib/ease'

/**
 * The single entrance for content that appears in the transcript: tool rows,
 * reasoning rows, summaries, bash executions, extension messages and notices.
 *
 * Deliberately opacity-only — no `y`, no `layout`, no `AnimatePresence`. A
 * growing stream mounts new rows many times a second, and any transform or
 * layout animation lets motion move rows on its own, which reads as jitter and
 * is worst for fast models that land several rows in one frame. The row still
 * takes its layout slot immediately; only its paint fades.
 *
 * `animate` is false for content that already existed when this component
 * mounted (an opened session), so switching sessions never replays the whole
 * transcript. Pass `true` only while the row is arriving in a live stream.
 */
export function RowReveal({
  animate = false,
  rowKind,
  className,
  children
}: {
  /** True only while the row is arriving in a live stream. */
  animate?: boolean
  /** Semantic row kind; text output alone keeps roomy spacing in compact mode. */
  rowKind?: 'process'
  className?: string
  children: ReactNode
}) {
  const reduce = useReducedMotion() ?? false
  return (
    <motion.div
      initial={animate && !reduce ? { opacity: 0 } : false}
      animate={{ opacity: 1 }}
      transition={motionTransition(reduce, { duration: DURATION.fast, ease: EASE_OUT })}
      data-row={rowKind}
      className={className}
    >
      {children}
    </motion.div>
  )
}
