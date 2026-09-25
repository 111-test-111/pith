import { useRef, type HTMLAttributes, type ReactNode } from 'react'
import { useScrollFade, SCROLL_FADE } from '@/lib/hooks/use-scroll-fade'
import { cn } from '@/lib/utils'

interface FadeScrollProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode
  fadeSize?: number
}

/**
 * A bounded scroll viewport whose clipped edge fades instead of cutting a line.
 * The measuring lives in `useScrollFade`, shared with the tool-output and diff
 * viewports in beUI's `ToolResult`/`FileDiff`.
 */
export function FadeScroll({ children, className, fadeSize = SCROLL_FADE, style, ...props }: FadeScrollProps) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const { edges, maskImage } = useScrollFade(viewportRef, { fadeSize, contentRef })

  return (
    <div
      {...props}
      ref={viewportRef}
      data-fade-scroll
      data-fade={edges.top && edges.bottom ? 'both' : edges.bottom ? 'bottom' : edges.top ? 'top' : 'none'}
      className={cn('overflow-y-auto', className)}
      style={{ ...style, maskImage, WebkitMaskImage: maskImage }}
    >
      <div ref={contentRef} className="pr-1">
        {children}
      </div>
    </div>
  )
}
