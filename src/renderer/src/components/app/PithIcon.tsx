import icon from '../../../../../resources/pith.svg'
import { cn } from '@/lib/utils'

/** Decorative brand artwork; the adjacent translated text supplies its name. */
export function PithIcon({ className }: { className?: string }) {
  return <img src={icon} alt="" aria-hidden="true" draggable={false} className={cn('shrink-0', className)} />
}
