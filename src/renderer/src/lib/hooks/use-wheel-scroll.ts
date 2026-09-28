import { useEffect, type RefObject } from 'react'
import { createWheelGesture, wheelPixels } from '@/lib/wheel-gesture'

/** Axis-locked native scroll surfaces, including nested code/diff viewports.
 * Custom canvases that consume wheel (images/timeline) keep their own action;
 * this adapter supplies the same direction policy to ordinary DOM scrollers. */
export function useWheelScroll(rootRef: RefObject<HTMLElement | null>, dependsOn?: unknown) {
  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const gesture = createWheelGesture(() => 'scroll')
    const wheel = (event: WheelEvent) => {
      if (event.defaultPrevented) return
      // Preserve browser/pinch shortcuts, rather than converting them into
      // document scrolling; releasing the modifier begins a fresh gesture.
      if (event.ctrlKey || event.metaKey) { gesture.reset(); return }
      const ports: Array<{ node: HTMLElement; style: CSSStyleDeclaration; x: boolean; y: boolean }> = []
      for (let node = event.target instanceof Element ? event.target : null; node; node = node.parentElement) {
        if (!(node instanceof HTMLElement)) continue
        const style = getComputedStyle(node)
        const x = /^(auto|scroll)$/.test(style.overflowX) && node.scrollWidth > node.clientWidth + 1
        const y = /^(auto|scroll)$/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 1
        if (x || y) ports.push({ node, style, x, y })
      }
      if (!ports.length) return
      const input = gesture.read(wheelPixels(event, ports[0].node))
      if (!input) return
      event.preventDefault()
      const delta = input.axis === 'x' ? input.deltaX : input.deltaY
      if (!delta) return
      for (const port of ports) {
        if (!port[input.axis]) continue
        const position = input.axis === 'x' ? port.node.scrollLeft : port.node.scrollTop
        const extent = input.axis === 'x' ? port.node.scrollWidth - port.node.clientWidth : port.node.scrollHeight - port.node.clientHeight
        if (delta < 0 ? position > 0 : position < extent - 0.5) {
          if (input.axis === 'x') port.node.scrollLeft += delta
          else port.node.scrollTop += delta
          return
        }
        const overscroll = input.axis === 'x' ? port.style.overscrollBehaviorX : port.style.overscrollBehaviorY
        if (overscroll === 'contain' || overscroll === 'none') return
      }
    }
    root.addEventListener('wheel', wheel, { passive: false })
    return () => root.removeEventListener('wheel', wheel)
  }, [rootRef, dependsOn])
}
