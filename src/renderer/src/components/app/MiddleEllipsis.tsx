import { cn } from '@/lib/utils'

/** CSS alone elides the middle, so resizing hundreds of tree labels needs no
 * measurements, observers or React updates. Text/accessibility retain the name. */
export function MiddleEllipsis({ name, className }: { name: string; className?: string }) {
  const extension = name.lastIndexOf('.') > 0 ? name.length - name.lastIndexOf('.') : 0
  const tail = Math.min(Math.floor(name.length / 2), Math.max(4, Math.min(extension, 8)))
  return <span data-middle-ellipsis className={cn('inline-flex min-w-0 max-w-full overflow-hidden whitespace-nowrap align-bottom', className)}>
    <span className="min-w-0 truncate">{name.slice(0, name.length - tail)}</span><span className="shrink-0">{name.slice(name.length - tail)}</span>
  </span>
}
