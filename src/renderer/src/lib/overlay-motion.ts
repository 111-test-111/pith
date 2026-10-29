import { type Variants } from 'motion/react'
import { useMemo } from 'react'
import { EASE_OUT } from './ease'
import { useReduceMotion, useSystemReducedMotion } from './reduce-motion'

export type OverlayPlacement = 'top' | 'right' | 'bottom' | 'left' | 'center' | 'backdrop'

export const OVERLAY_ENTER = { duration: 0.18, ease: EASE_OUT } as const
export const OVERLAY_EXIT = { duration: 0.12, ease: EASE_OUT } as const

const ORIGIN: Record<OverlayPlacement, string> = {
  top: 'bottom',
  right: 'left',
  bottom: 'top',
  left: 'right',
  center: 'center',
  backdrop: 'center'
}

/**
 * Every floating surface arrives as one piece: a short fade and a small scale
 * from its anchor, with a faster exit. Layout, gaps, corners and list rows stay
 * at their final geometry throughout; list length cannot change the timing.
 * Backdrops share the fade without transforming the viewport.
 */
export function useOverlayMotion(placement: OverlayPlacement = 'center', instant = false) {
  const systemReduced = useSystemReducedMotion()
  const appReduced = useReduceMotion()
  const still = instant || systemReduced || appReduced

  return useMemo(() => {
    const variants: Variants = {
      closed: {
        // Single-frame targets replace an active tween when reduced motion
        // turns on. Updating only its duration leaves an unchanged target's
        // existing animation running in Motion.
        opacity: still ? [0] : 0,
        scale: still ? [1] : placement === 'backdrop' ? 1 : 0.98,
        x: 0,
        y: 0,
        transition: still ? { duration: 0 } : OVERLAY_EXIT
      },
      open: {
        opacity: still ? [1] : 1,
        scale: still ? [1] : 1,
        x: 0,
        y: 0,
        transition: still ? { duration: 0 } : OVERLAY_ENTER
      }
    }
    return {
      variants,
      initial: still ? false as const : 'closed' as const,
      animate: 'open' as const,
      exit: 'closed' as const,
      style: { transformOrigin: ORIGIN[placement] },
      transition: still ? { duration: 0 } : OVERLAY_ENTER
    }
  }, [placement, still])
}
