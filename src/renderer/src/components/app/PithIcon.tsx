import roundedIcon from '../../../../../resources/pith.svg'
import squareIcon from '../../../../../resources/pith-square.svg'
import { cn } from '@/lib/utils'

/** Decorative brand artwork; the adjacent translated text supplies its name.
 *
 * Two variants exist: `rounded` (the packaging master, matching the Dock icon
 * and the welcome screen) and `square`, the renderer-only hard-edge mark the
 * square-style UI uses on the new-session landing. The Dock icon is generated
 * from `resources/pith.svg` by `scripts/generate-icons.mjs`, so it always stays
 * rounded — never point that master at the square file. */
export function PithIcon({
  className,
  variant = 'rounded'
}: {
  className?: string
  variant?: 'rounded' | 'square'
}) {
  return (
    <img
      src={variant === 'square' ? squareIcon : roundedIcon}
      alt=""
      aria-hidden="true"
      draggable={false}
      className={cn('shrink-0', className)}
    />
  )
}
