import { useEffect, useRef, useState } from 'react'

/** BeUI's capped-list edge fade: the same 12px ramp AgentActivity puts on its
 * scrolling viewport, applied to whichever end actually cuts a row. Whole rows
 * at the cap's boundaries stay crisp; a row that is only half in view fades out
 * instead of ending in a hard chop. */
const SCROLL_FADE = 12

export function fadeMask(top: boolean, bottom: boolean): string | undefined {
  if (!top && !bottom) return undefined
  const stops = [
    ...(top ? ['transparent', `black ${SCROLL_FADE}px`] : ['black']),
    ...(bottom ? [`black calc(100% - ${SCROLL_FADE}px)`, 'transparent'] : []),
  ]
  return `linear-gradient(to bottom, ${stops.join(', ')})`
}

/**
 * Watches one of the task drawer's capped lists (todo, bash, subagents, Q&A
 * records — they all share the 16.5rem frame) and reports which end hides
 * content, so the ramp is painted only where a row is actually cut.
 *
 * `key` re-measures when the rows themselves change (a row growing taller
 * cuts a different one); resize and scroll keep it honest without a render
 * per frame.
 */
export function useCappedListFade(key: string) {
  const list = useRef<HTMLDivElement>(null)
  const [cut, setCut] = useState({ top: false, bottom: false })
  useEffect(() => {
    const node = list.current
    if (!node) return
    let frame = 0
    const measure = () => {
      frame = 0
      const box = node.getBoundingClientRect()
      const pad = parseFloat(getComputedStyle(node).paddingTop) || 0
      const top = box.top + pad
      const bottom = box.bottom - pad
      let cutTop = false
      let cutBottom = false
      for (const row of node.children) {
        const rect = row.getBoundingClientRect()
        if (rect.top < top - 0.5 && rect.bottom > top + 0.5) cutTop = true
        if (rect.top < bottom - 0.5 && rect.bottom > bottom + 0.5) cutBottom = true
      }
      setCut((prev) => (prev.top === cutTop && prev.bottom === cutBottom ? prev : { top: cutTop, bottom: cutBottom }))
    }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure) }
    const observer = new ResizeObserver(schedule)
    observer.observe(node)
    for (const row of node.children) observer.observe(row)
    node.addEventListener('scroll', schedule, { passive: true })
    schedule()
    return () => {
      if (frame) cancelAnimationFrame(frame)
      observer.disconnect()
      node.removeEventListener('scroll', schedule)
    }
  }, [key])
  return { list, mask: fadeMask(cut.top, cut.bottom) }
}
