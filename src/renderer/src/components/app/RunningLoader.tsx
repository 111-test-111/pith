import { Loader, type LoaderProps } from '@/components/motion/loader'
import { useRunningMotionClass } from '@/lib/reduce-motion'
import { cn } from '@/lib/utils'

/**
 * The app's running-state `Loader`: beUI's component, unchanged, except that it
 * keeps moving while reduced motion is on (Settings → Appearance).
 *
 * The vendored loader animates through `motion`, and that preference switches
 * motion off globally — which is right for every entrance, exit and hover, and
 * wrong for the one glyph whose motion IS the information ("this is still
 * running"). `useRunningMotionClass` re-adds the motion with Tailwind's own
 * keyframes on the loader's own box, so the artwork is still beUI's and the app
 * still carries no spinner keyframes of its own.
 *
 * Only the rotation-based variants need that: a dither grid's particles move
 * themselves under the switch (see `components/motion/loader.tsx`), so adding a
 * box-wide pulse on top would double-fade them.
 *
 * Phase is not preserved across the flip: the frozen motion element is static
 * from whichever frame it stopped on, and the CSS animation starts at 0. Only a
 * spinner is affected, so a restart reads as a restart in motion, not as a jump
 * in position.
 */
export function RunningLoader({ variant = 'spinner', className, ...props }: LoaderProps) {
  const spin = useRunningMotionClass()
  const keepAlive = variant?.includes('dither') ? '' : spin
  return <Loader variant={variant} className={cn(className, keepAlive)} {...props} />
}
