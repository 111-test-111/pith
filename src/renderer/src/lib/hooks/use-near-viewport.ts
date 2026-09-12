import { useEffect, useRef, useState, type RefObject } from 'react'

/** How far outside the scrollport a row starts preparing its body. */
const OVERSCAN_PX = 640

interface SharedObserver {
  observer: IntersectionObserver
  callbacks: Map<Element, () => void>
}

/**
 * One IntersectionObserver per scroll root, shared by every row that wants to
 * know when it comes near the viewport. A long review list would otherwise
 * create an observer per file, and each of those is a browser-level object that
 * has to be torn down again.
 */
const observers = new WeakMap<HTMLElement, SharedObserver>()

function observeOnce(root: HTMLElement, target: Element, onNear: () => void): () => void {
  let shared = observers.get(root)
  if (!shared) {
    const callbacks = new Map<Element, () => void>()
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          const callback = callbacks.get(entry.target)
          if (!callback) continue
          callbacks.delete(entry.target)
          observer.unobserve(entry.target)
          callback()
        }
        if (callbacks.size === 0) {
          observer.disconnect()
          observers.delete(root)
        }
      },
      { root, rootMargin: `${OVERSCAN_PX}px 0px` }
    )
    shared = { observer, callbacks }
    observers.set(root, shared)
  }
  shared.callbacks.set(target, onNear)
  shared.observer.observe(target)
  return () => {
    const current = observers.get(root)
    if (!current) return
    current.callbacks.delete(target)
    current.observer.unobserve(target)
    if (current.callbacks.size === 0) {
      current.observer.disconnect()
      observers.delete(root)
    }
  }
}

/**
 * True once the element has scrolled near its container's viewport — and
 * immediately when there is nothing to observe with (no IntersectionObserver,
 * or no scroll root yet), so a body is never withheld on a browser that cannot
 * tell us when to show it.
 *
 * This is what keeps a long list cheap: heavy row bodies (a parsed, highlighted
 * diff) are mounted only when they are about to be seen.
 */
export function useNearViewport<T extends HTMLElement>(
  rootRef: RefObject<HTMLElement | null>
): { ref: RefObject<T | null>; near: boolean } {
  const ref = useRef<T | null>(null)
  const [near, setNear] = useState(false)

  useEffect(() => {
    if (near) return
    const target = ref.current
    const root = rootRef.current
    if (!target) return
    if (typeof IntersectionObserver === 'undefined' || !root) {
      setNear(true)
      return
    }
    // IntersectionObserver only delivers while the window has rendering
    // opportunities, so a pane opened in a backgrounded/occluded window would
    // sit on placeholders until something forced a frame. One synchronous
    // geometry check mounts whatever was already on screen — and everything
    // above it — at mount time; the observer takes over for the rest.
    const rect = target.getBoundingClientRect()
    const rootRect = root.getBoundingClientRect()
    if (rect.bottom >= rootRect.top - OVERSCAN_PX && rect.top <= rootRect.bottom + OVERSCAN_PX) {
      setNear(true)
      return
    }
    return observeOnce(root, target, () => setNear(true))
  }, [near, rootRef])

  return { ref, near }
}
