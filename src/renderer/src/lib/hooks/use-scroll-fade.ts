import { useEffect, useState, type RefObject } from 'react'

/** Height (px) of the mask ramp at a clipped edge — the same 12px ramp the
 * app's capped lists (`AgentActivity`, the task panels, the tool-description
 * card) use. */
export const SCROLL_FADE = 12

export interface ScrollFadeEdges {
  top: boolean
  bottom: boolean
}

export interface ScrollFadeOptions {
  /** Ramp height in px; defaults to `SCROLL_FADE`. */
  fadeSize?: number
  /** Content wrapper whose growth moves the extent without a scroll event. */
  contentRef?: RefObject<HTMLElement | null>
  /**
   * Re-measure when this changes. A caller whose viewport mounts later than the
   * hook (a lazy disclosure body) passes the flag that mounts it; without it
   * the effect would run once against a null ref and never look again.
   */
  dependsOn?: unknown
}

/**
 * Which ends of a bounded scroll viewport actually hide content, expressed as a
 * CSS `mask-image` for that viewport.
 *
 * The point is the line the cap cuts in half: without a mask it just stops, and
 * because the app hides every scrollbar the reader has no other cue that more
 * content exists. The mask is `undefined` while nothing is hidden, so a short
 * body renders with no mask at all and the first line stays crisp while the
 * reader sits at the top.
 *
 * Without an explicit `contentRef` the viewport's first element child is
 * observed as well: content that grows while the viewport is already at its cap
 * moves the scroll extent without resizing the viewport or firing a scroll
 * event, which is exactly the streaming tool-output case.
 */
export function useScrollFade(
  viewportRef: RefObject<HTMLElement | null>,
  { fadeSize = SCROLL_FADE, contentRef, dependsOn }: ScrollFadeOptions = {}
): { edges: ScrollFadeEdges; maskImage: string | undefined } {
  const [edges, setEdges] = useState<ScrollFadeEdges>({ top: false, bottom: false })

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const update = () => {
      const overflow = viewport.scrollHeight - viewport.clientHeight
      const next: ScrollFadeEdges = {
        top: overflow > 1 && viewport.scrollTop > 1,
        bottom: overflow > 1 && viewport.scrollTop < overflow - 1
      }
      setEdges((prev) => (prev.top === next.top && prev.bottom === next.bottom ? prev : next))
    }
    update()
    viewport.addEventListener('scroll', update, { passive: true })
    // Width changes re-wrap the text and late font/image layout changes height:
    // both move the scroll extent without a scroll event.
    const observer = new ResizeObserver(update)
    observer.observe(viewport)
    const content = contentRef?.current ?? viewport.firstElementChild
    if (content) observer.observe(content)
    return () => {
      viewport.removeEventListener('scroll', update)
      observer.disconnect()
    }
  }, [viewportRef, contentRef, fadeSize, dependsOn])

  const ramp = `${fadeSize}px`
  const maskImage =
    edges.top && edges.bottom
      ? `linear-gradient(to bottom, transparent, black ${ramp}, black calc(100% - ${ramp}), transparent)`
      : edges.bottom
        ? `linear-gradient(to bottom, transparent, black ${ramp})`
        : edges.top
          ? `linear-gradient(to bottom, black calc(100% - ${ramp}), transparent)`
          : undefined

  return { edges, maskImage }
}
