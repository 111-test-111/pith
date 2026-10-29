import { useEffect, type RefObject } from 'react'
import { wheelPixels } from '@/lib/wheel-gesture'

/** Scroll both axes independently, including nested code/diff viewports.
 * Custom canvases that consume wheel (image previews) keep their own action. */
export function useWheelScroll(rootRef: RefObject<HTMLElement | null>, dependsOn?: unknown) {
  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const wheel = (event: WheelEvent) => {
      if (event.defaultPrevented) return
      // Preserve browser/pinch shortcuts instead of scrolling the document.
      if (event.ctrlKey || event.metaKey) return
      const ports: Array<{ node: HTMLElement; style: CSSStyleDeclaration; x: boolean; y: boolean }> = []
      for (let node = event.target instanceof Element ? event.target : null; node; node = node.parentElement) {
        if (!(node instanceof HTMLElement)) continue
        const style = getComputedStyle(node)
        const x = /^(auto|scroll)$/.test(style.overflowX) && node.scrollWidth > node.clientWidth + 1
        const y = /^(auto|scroll)$/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 1
        if (x || y) ports.push({ node, style, x, y })
      }
      if (!ports.length) return
      const input = wheelPixels(event, ports[0].node)
      if (!input.deltaX && !input.deltaY) return
      event.preventDefault()
      const scrollAxis = (axis: 'x' | 'y', delta: number) => {
        if (!delta) return
        for (const port of ports) {
          if (!port[axis]) continue
          const position = axis === 'x' ? port.node.scrollLeft : port.node.scrollTop
          const extent = axis === 'x' ? port.node.scrollWidth - port.node.clientWidth : port.node.scrollHeight - port.node.clientHeight
          if (delta < 0 ? position > 0 : position < extent - 0.5) {
            if (axis === 'x') port.node.scrollLeft += delta
            else port.node.scrollTop += delta
            return
          }
          const overscroll = axis === 'x' ? port.style.overscrollBehaviorX : port.style.overscrollBehaviorY
          if (overscroll === 'contain' || overscroll === 'none') return
        }
      }
      scrollAxis('x', input.deltaX)
      scrollAxis('y', input.deltaY)
    }
    root.addEventListener('wheel', wheel, { passive: false })
    return () => root.removeEventListener('wheel', wheel)
  }, [rootRef, dependsOn])
}
