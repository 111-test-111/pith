import { useEffect, useRef, useState, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

/** Height (px) of the mask ramp at a clipped edge — the same 12px ramp the
 * app's capped lists (`AgentActivity`, task panels) use. */
const FADE_SIZE = 12

interface FadeScrollProps {
  children: ReactNode
  /** Tailwind max-height utility for the viewport, e.g. `max-h-40`. */
  className?: string
  fadeSize?: number
  id?: string
}

/**
 * A bounded scroll viewport whose clipped edge fades instead of cutting a line:
 * the mask only appears on the side that actually hides content, so a
 * description shorter than the cap renders with no mask at all and the first
 * line stays crisp while the reader is at the top.
 */
export function FadeScroll({ children, className, fadeSize = FADE_SIZE, id }: FadeScrollProps) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const [edges, setEdges] = useState({ top: false, bottom: false })

  useEffect(() => {
    const viewport = viewportRef.current
    const content = contentRef.current
    if (!viewport) return
    const update = () => {
      const overflow = viewport.scrollHeight - viewport.clientHeight
      const next = {
        top: overflow > 1 && viewport.scrollTop > 1,
        bottom: overflow > 1 && viewport.scrollTop < overflow - 1
      }
      setEdges((prev) =>
        prev.top === next.top && prev.bottom === next.bottom ? prev : next
      )
    }
    update()
    viewport.addEventListener('scroll', update, { passive: true })
    // Width changes re-wrap the text and height changes arrive from a late
    // font/image — both move the scroll extent without a scroll event.
    const observer = new ResizeObserver(update)
    observer.observe(viewport)
    if (content) observer.observe(content)
    return () => {
      viewport.removeEventListener('scroll', update)
      observer.disconnect()
    }
  }, [])

  const ramp = `${fadeSize}px`
  const maskImage =
    edges.top && edges.bottom
      ? `linear-gradient(to bottom, transparent, black ${ramp}, black calc(100% - ${ramp}), transparent)`
      : edges.bottom
        ? `linear-gradient(to bottom, transparent, black ${ramp})`
        : edges.top
          ? `linear-gradient(to bottom, black calc(100% - ${ramp}), transparent)`
          : undefined

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
