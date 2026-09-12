import { useEffect, useRef } from 'react'

// Share one observer across the session list. Its delivered widths avoid
// synchronous scrollWidth reads that would lay out offscreen session rows.
const listeners = new Map<Element, (width: number) => void>()
let observer: ResizeObserver | null = null

function observeWidth(element: Element, onWidth: (width: number) => void) {
  observer ??= new ResizeObserver((entries) => {
    for (const entry of entries) listeners.get(entry.target)?.(entry.contentRect.width)
  })
  listeners.set(element, onWidth)
  observer.observe(element)
  return () => {
    observer?.unobserve(element)
    listeners.delete(element)
    if (!listeners.size) { observer?.disconnect(); observer = null }
  }
}

/** Mark only genuinely clipped text for a CSS mask. Font, text and container
 * changes arrive through ResizeObserver without a React render per title. */
export function useOverflowFade() {
  const viewportRef = useRef<HTMLSpanElement>(null)
  const textRef = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    const viewport = viewportRef.current
    const text = textRef.current
    if (!viewport || !text) return
    let available = 0
    let needed = 0
    const update = () => viewport.toggleAttribute('data-overflow', available > 0 && needed > available + 0.5)
    const stopViewport = observeWidth(viewport, (width) => { available = width; update() })
    const stopText = observeWidth(text, (width) => { needed = width; update() })
    return () => { stopViewport(); stopText(); viewport.removeAttribute('data-overflow') }
  }, [])
  return { viewportRef, textRef }
}
