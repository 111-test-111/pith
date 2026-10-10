import roundedIcon from '../../../../../resources/pith.svg'
import squareIcon from '../../../../../resources/pith-square.svg'
import markIcon from '../../../../../resources/pith-mark.svg'
import { cn } from '@/lib/utils'

/** Decorative brand artwork; the adjacent translated text supplies its name.
 *
 * `rounded` is the packaging master used by the welcome screen and Dock;
 * `square` is its hard-edge tile variant. The background-free `mark` inherits
 * currentColor through an alpha mask, so the new-session header can use the
 * live app accent in either UI style. Native icons are generated from the
 * rounded master by `scripts/generate-icons.mjs`. */
export function PithIcon({
  className,
  variant = 'rounded'
}: {
  className?: string
  variant?: 'rounded' | 'square' | 'mark'
}) {
  if (variant === 'mark') {
    return (
      <span
        aria-hidden="true"
        className={cn('inline-block shrink-0 bg-current', className)}
        style={{
          maskImage: `url("${markIcon}")`,
          maskMode: 'alpha',
          maskSize: 'contain',
          maskRepeat: 'no-repeat',
          maskPosition: 'center'
        }}
      />
    )
  }

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
