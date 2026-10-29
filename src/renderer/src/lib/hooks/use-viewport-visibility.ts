import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react'

interface Observer { observer: IntersectionObserver; callbacks: Map<Element, (visible: boolean) => void> }
const observers = new WeakMap<HTMLElement, Observer>()
function nearby(root: HTMLElement, target: Element): boolean {
  const bounds = root.getBoundingClientRect(), rect = target.getBoundingClientRect()
  return rect.bottom >= bounds.top - 1200 && rect.top <= bounds.bottom + 1200
}
export function refreshViewportVisibility(root: HTMLElement | null): void {
  if (!root) return
  const shared = observers.get(root)
  if (!shared) return
  const bounds = root.getBoundingClientRect()
  for (const [target, callback] of shared.callbacks) {
    const rect = target.getBoundingClientRect()
    callback(rect.bottom >= bounds.top - 1200 && rect.top <= bounds.bottom + 1200)
  }
}
/** Unlike the one-shot preparation hook, long remote previews release their
 * parsed bodies when leaving the nearby viewport. One observer per scrollport. */
export function useViewportVisibility<T extends HTMLElement>(rootRef: RefObject<HTMLElement | null>) {
  const ref = useRef<T>(null)
  const [visible, setVisible] = useState(false)
  const checkVisibility = useCallback(() => {
    const root = rootRef.current, target = ref.current
    const next = !!root && !!target && nearby(root, target)
    setVisible(next)
    return next
  }, [rootRef])
  useLayoutEffect(() => {
    const root = rootRef.current, target = ref.current
    if (!root || !target || typeof IntersectionObserver === 'undefined') { setVisible(true); return }
    const bounds = root.getBoundingClientRect(), rect = target.getBoundingClientRect()
    setVisible(rect.bottom >= bounds.top - 1200 && rect.top <= bounds.bottom + 1200)
    let shared = observers.get(root)
    if (!shared) {
      const callbacks: Observer['callbacks'] = new Map()
      const observer = new IntersectionObserver(entries => { for (const entry of entries) callbacks.get(entry.target)?.(entry.isIntersecting) }, { root, rootMargin: '1200px 0px' })
      shared = { observer, callbacks }; observers.set(root, shared)
    }
    shared.callbacks.set(target, setVisible); shared.observer.observe(target)
    return () => {
      shared.callbacks.delete(target); shared.observer.unobserve(target)
      if (!shared.callbacks.size) { shared.observer.disconnect(); observers.delete(root) }
    }
  }, [rootRef])
  return { ref, visible, checkVisibility }
}
