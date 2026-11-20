import { useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { wrapDiffRows, type DiffLayout, type DiffRow } from '@/lib/diff-layout'

const WRAP_SETTLE_MS = 120

/** The paired view measures one code column. The two-pane divider is covered
 * by the same one-pixel allowance that keeps a segment off the scroll edge. */
export function DiffWrapRuler({ ruler, layout, gutter }: {
  ruler: RefObject<HTMLSpanElement | null>; layout: DiffLayout; gutter: string
}) {
  const width = layout === 'side-by-side' ? `calc(50% - ${gutter} - 1.75rem)` : `calc(100% - 2 * ${gutter} - 1.75rem)`
  return <span ref={ruler} aria-hidden className="pointer-events-none invisible absolute left-0 top-0 h-0 overflow-hidden font-mono text-code" style={{ width }}>
    <span className="block w-[100ch]" />
  </span>
}

/** Windowed wraps measure once at mount and after resizing settles. */
export function useDiffWrap(rows: readonly DiffRow[], enabled: boolean, layout: DiffLayout, gutter: string, rowHeight: number) {
  const ruler = useRef<HTMLSpanElement>(null)
  const [columns, setColumns] = useState(0)
  useLayoutEffect(() => {
    const probe = ruler.current, glyphs = probe?.firstElementChild
    if (!enabled || !probe || !(glyphs instanceof HTMLElement)) return
    const measure = () => {
      const ch = glyphs.offsetWidth / 100
      if (ch > 0 && probe.clientWidth > 0) setColumns(Math.max(1, Math.floor((probe.clientWidth - 1) / ch)))
    }
    measure()
    let timer: ReturnType<typeof setTimeout> | undefined
    const observer = new ResizeObserver(() => {
      clearTimeout(timer)
      timer = setTimeout(measure, WRAP_SETTLE_MS)
    })
    observer.observe(probe)
    observer.observe(glyphs)
    return () => { observer.disconnect(); clearTimeout(timer) }
  }, [enabled, layout, gutter, rowHeight])
  const tabSize = Math.min(4, columns)
  const wrapped = useMemo(() => enabled && columns > 0 ? wrapDiffRows(rows, columns, tabSize, layout) : null, [rows, columns, tabSize, enabled, layout])
  return { ruler, wrapped, tabSize }
}
