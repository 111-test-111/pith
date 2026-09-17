import { useRef, type ReactNode } from 'react'
import { useScrollFade, SCROLL_FADE } from '@/lib/hooks/use-scroll-fade'
import { cn } from '@/lib/utils'

interface FadeScrollProps {
  children: ReactNode
  /** Tailwind max-height utility for the viewport, e.g. `max-h-40`. */
  className?: string
  fadeSize?: number
  id?: string
}

/**
 * A bounded scroll viewport whose clipped edge fades instead of cutting a line.
 * The measuring lives in `useScrollFade`, shared with the tool-output and diff
 * viewports in beUI's `ToolResult`/`FileDiff`.
 */
export function FadeScroll({ children, className, fadeSize = SCROLL_FADE, id }: FadeScrollProps) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const { edges, maskImage } = useScrollFade(viewportRef, { fadeSize, contentRef })

  return (
    <div
      ref={viewportRef}
      id={id}
      data-fade-scroll
      data-fade={edges.top && edges.bottom ? 'both' : edges.bottom ? 'bottom' : edges.top ? 'top' : 'none'}
      className={cn('overflow-y-auto', className)}
      style={{ maskImage, WebkitMaskImage: maskImage }}
    >
      <div ref={contentRef} className="pr-1">
        {children}
      </div>
    </div>
  )
}
