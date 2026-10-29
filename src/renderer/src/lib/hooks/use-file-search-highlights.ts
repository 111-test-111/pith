import { useLayoutEffect, type RefObject } from 'react'
import type { FileMatch } from '../file-search'

const allName = 'file-search-matches', activeName = 'file-search-active'

/** Paint matches over beUI's token text with native CSS Highlights. Neither
 * searching nor resizing replaces syntax spans or introduces overlay geometry. */
export function useFileSearchHighlights(viewport: RefObject<HTMLDivElement | null>, lineStarts: number[], matches: FileMatch[], current: number, renderVersion: unknown, start: number, end: number) {
  useLayoutEffect(() => {
    const element = viewport.current
    if (!element || !matches.length) return
    const all = new Highlight(), active = new Highlight()
    active.priority = 1
    let selectedRange: Range | undefined
    for (const row of element.querySelectorAll<HTMLElement>('[data-source-line]')) {
      const text = row.lastElementChild!
      // A long wrapped line may mount only a slice of its display rows.
      const lineStart = lineStarts[Number(row.dataset.sourceLine) - 1] + Number(row.dataset.sourceOffset ?? 0), lineEnd = lineStart + (text.textContent?.length ?? 0)
      let low = 0, high = matches.length
      while (low < high) { const mid = (low + high) >>> 1; if (matches[mid].end <= lineStart) low = mid + 1; else high = mid }
      if (low >= matches.length || matches[low].start >= lineEnd) continue
      const walker = document.createTreeWalker(text, NodeFilter.SHOW_TEXT)
      const nodes: { node: Text; start: number; end: number }[] = []
      let node: Node | null, offset = 0
      while ((node = walker.nextNode())) { const end = offset + node.textContent!.length; nodes.push({ node: node as Text, start: offset, end }); offset = end }
      const point = (offset: number) => nodes.find(item => offset <= item.end)
      let adjacent: Range | undefined, previousEnd = -1
      for (let index = low; index < matches.length && matches[index].start < lineEnd; index++) {
        const match = matches[index], from = Math.max(lineStart, match.start) - lineStart, to = Math.min(lineEnd, match.end) - lineStart
        const first = point(from), last = point(to)
        if (!first || !last || from === to) continue
        // A query such as "." can match every character. Adjacent background
        // ranges paint as one while the active occurrence retains its bounds.
        if (!adjacent || previousEnd !== from) {
          adjacent = new Range(); adjacent.setStart(first.node, from - first.start); all.add(adjacent)
        }
        adjacent.setEnd(last.node, to - last.start); previousEnd = to
        if (index === current) {
          const selected = new Range()
          selected.setStart(first.node, from - first.start); selected.setEnd(last.node, to - last.start)
          active.add(selected); selectedRange ??= selected
        }
      }
    }
    CSS.highlights.set(allName, all); CSS.highlights.set(activeName, active)
    if (selectedRange) {
      const bounds = element.getBoundingClientRect(), target = selectedRange.getBoundingClientRect()
      const row = selectedRange.startContainer.parentElement?.closest('[data-source-line]')
      const gutter = row?.firstElementChild?.getBoundingClientRect().width ?? 0
      const padding = Math.min(gutter + 12, bounds.width / 3)
      // Returning from a far-right match to column zero also restores the line
      // gutter; scrolling only to the text's edge would leave it cropped away.
      if (target.left < bounds.left + padding || target.width > bounds.width - padding - 12) element.scrollLeft += target.left - bounds.left - padding
      else if (target.right > bounds.right - 12) element.scrollLeft += target.right - bounds.right + 12
    }
    return () => {
      if (CSS.highlights.get(allName) === all) CSS.highlights.delete(allName)
      if (CSS.highlights.get(activeName) === active) CSS.highlights.delete(activeName)
    }
  }, [viewport, lineStarts, matches, current, renderVersion, start, end])
}
