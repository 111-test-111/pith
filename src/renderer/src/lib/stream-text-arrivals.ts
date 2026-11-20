import type { Element, ElementContent, Root, Text } from 'hast'

export const STREAM_TEXT_FADE_MS = 160

export interface TextArrival {
  start: number
  end: number
  at: number
}

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/** Decorate parser text only. Source offsets keep an appended delimiter from
 * replaying the existing paragraph when Markdown changes its inline tree.
 * Code and parser-produced math retain their own rendering and baselines. */
export function rehypeTextArrivals({ source, arrivals, now }: {
  source: string
  arrivals: TextArrival[]
  now: number
}) {
  return (tree: Root) => {
    const visit = (parent: Root | Element) => {
      if (parent.type === 'element' &&
        (parent.tagName === 'pre' || parent.tagName === 'code' || parent.properties['data-math'])) return
      const children: ElementContent[] = []
      for (const node of parent.children) {
        if (node.type === 'element') visit(node)
        if (node.type !== 'text') { children.push(node as ElementContent); continue }
        const start = node.position?.start.offset
        const end = node.position?.end.offset
        // Escapes/entities and plugin-generated text can have different source
        // lengths. Leave them intact instead of guessing their text boundaries.
        if (start === undefined || end === undefined || source.slice(start, end) !== node.value) {
          children.push(node)
          continue
        }
        const recent = arrivals.filter((arrival) => arrival.end > start && arrival.start < end && now - arrival.at < STREAM_TEXT_FADE_MS)
        if (!recent.length) { children.push(node); continue }
        const boundaries = [...graphemes.segment(node.value)].map((part) => part.index)
        boundaries.push(node.value.length)
        const floor = (index: number) => boundaries.findLast((boundary) => boundary <= index) ?? 0
        const ceil = (index: number) => boundaries.find((boundary) => boundary >= index) ?? node.value.length
        let cursor = 0
        for (const arrival of recent) {
          const from = Math.max(cursor, floor(Math.max(0, arrival.start - start)))
          const to = ceil(Math.min(node.value.length, arrival.end - start))
          if (to <= from) continue
          if (from > cursor) children.push({ type: 'text', value: node.value.slice(cursor, from) })
          children.push({
            type: 'element', tagName: 'span',
            properties: { 'data-stream-text-at': arrival.at, 'data-stream-text-id': `${arrival.at}:${start + from}` },
            children: [{ type: 'text', value: node.value.slice(from, to) } as Text]
          })
          cursor = to
        }
        if (cursor < node.value.length) children.push({ type: 'text', value: node.value.slice(cursor) })
      }
      parent.children = children
    }
    visit(tree)
  }
}
