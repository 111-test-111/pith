import { useCallback, useLayoutEffect, useState, type RefObject } from 'react'

/** Preview rows never wrap; bound DOM work by the scrollport, not the file size. */
export const DIFF_ROW_HEIGHT = 20
const OVERSCAN = 8

export function useDiffWindow(
  viewportRef: RefObject<HTMLDivElement | null>,
  count: number,
  enabled: boolean,
  maxHeight: number
) {
  const [range, setRange] = useState({ first: 0, size: Math.ceil(maxHeight / DIFF_ROW_HEIGHT) })
  const onScroll = useCallback(() => {
    const viewport = viewportRef.current
    if (!enabled || !viewport) return
    const first = Math.floor(viewport.scrollTop / DIFF_ROW_HEIGHT)
    const size = Math.ceil(viewport.clientHeight / DIFF_ROW_HEIGHT)
    setRange((previous) => previous.first === first && previous.size === size ? previous : { first, size })
  }, [enabled, viewportRef])

  useLayoutEffect(() => {
    if (!enabled) return
    onScroll()
    const viewport = viewportRef.current
    if (!viewport) return
    const observer = new ResizeObserver(onScroll)
    observer.observe(viewport)
    return () => observer.disconnect()
  }, [enabled, onScroll])

  const start = enabled ? Math.max(0, Math.min(range.first, count) - OVERSCAN) : 0
  const end = enabled ? Math.min(count, range.first + range.size + OVERSCAN) : count
  return { start, end, onScroll }
}
