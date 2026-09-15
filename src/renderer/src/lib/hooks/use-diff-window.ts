import { useCallback, useLayoutEffect, useState, type RefObject } from 'react'

/** Preview rows never wrap; bound DOM work by the scrollport, not the file size. */
export const DIFF_ROW_HEIGHT = 20
const OVERSCAN = 8

export function useDiffWindow(
  viewportRef: RefObject<HTMLDivElement | null>,
  count: number,
  enabled: boolean,
  maxHeight: number,
  // The table grid shares this window with its own (zoom-dependent) row height.
  rowHeight: number = DIFF_ROW_HEIGHT
) {
  const [range, setRange] = useState({ first: 0, size: Math.ceil(maxHeight / rowHeight) })
  const onScroll = useCallback(() => {
    const viewport = viewportRef.current
    if (!enabled || !viewport) return
    const first = Math.floor(viewport.scrollTop / rowHeight)
    const size = Math.ceil(viewport.clientHeight / rowHeight)
    setRange((previous) => previous.first === first && previous.size === size ? previous : { first, size })
  }, [enabled, viewportRef, rowHeight])

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
