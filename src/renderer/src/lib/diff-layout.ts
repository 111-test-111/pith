import type { FileDiffLine } from '@/components/agents/file-diff'
import { displayRow, lineAtRow, wrapCodeLines, type WrappedCode } from './code-wrap'
import { diffContentLines } from './diff'

export type DiffLayout = 'stacked' | 'side-by-side'
export type DiffSide = 'before' | 'after'
export type DiffRow = FileDiffLine | { id: string; before?: FileDiffLine; after?: FileDiffLine }

/** Context lines appear on both sides. Keep each change run in its own hunk,
 * with blanks opposite insertions or deletions that have no counterpart. */
function sideBySideRows(lines: readonly FileDiffLine[]): DiffRow[] {
  const rows: DiffRow[] = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    if (line.type === 'hunk' || (line.type !== 'added' && line.type !== 'removed')) {
      rows.push(line.type === 'hunk' ? line : { id: line.id, before: line, after: line })
      index++
      continue
    }
    const before: FileDiffLine[] = [], after: FileDiffLine[] = []
    while (lines[index]?.type === 'added' || lines[index]?.type === 'removed') {
      const change = lines[index++]
      if (change.type === 'removed') before.push(change)
      else after.push(change)
    }
    for (let offset = 0; offset < Math.max(before.length, after.length); offset++) {
      rows.push({ id: (before[offset] ?? after[offset]).id, before: before[offset], after: after[offset] })
    }
  }
  return rows
}

export function diffDisplayRows(lines: FileDiffLine[], layout: DiffLayout, detailed: boolean): readonly DiffRow[] {
  if (layout === 'stacked') return detailed ? lines : diffContentLines(lines)
  const rows = sideBySideRows(lines)
  return detailed ? rows : rows.filter(row => !('content' in row) || row.type !== 'hunk')
}

export type DiffLineWidths = Record<DiffSide, number>
const widthCache = new WeakMap<readonly FileDiffLine[], DiffLineWidths>()

/** The longest row can be outside a virtual window. Count monospace columns
 * once for the whole patch to keep its horizontal range stable. */
export function diffLineWidths(lines: readonly FileDiffLine[]): DiffLineWidths {
  const cached = widthCache.get(lines)
  if (cached) return cached
  const widths = { before: 0, after: 0 }
  for (const { type, content } of lines) {
    if (type === 'hunk') continue
    let columns = content.length
    if (/[\t\u0080-\uFFFF]/.test(content)) {
      columns = 0
      for (const char of content) columns += char === '\t' ? 8 - columns % 8 : char.codePointAt(0)! > 127 ? 2 : 1
    }
    if (type !== 'added') widths.before = Math.max(widths.before, columns)
    if (type !== 'removed') widths.after = Math.max(widths.after, columns)
  }
  widthCache.set(lines, widths)
  return widths
}

export interface WrappedDiff {
  prefix: Uint32Array
  before: WrappedCode
  after?: WrappedCode
  rows: number
}

/** One display row is as tall as the longer of its two sides. This lets the
 * virtualizer share height and scroll position across both code columns. */
export function wrapDiffRows(rows: readonly DiffRow[], columns: number, tabSize: number, layout: DiffLayout): WrappedDiff {
  const before = wrapCodeLines(rows.map(row => 'content' in row ? row.type === 'hunk' ? '' : row.content : row.before?.content ?? ''), columns, tabSize)
  if (layout === 'stacked') return { prefix: before.prefix, before, rows: before.rows }
  const after = wrapCodeLines(rows.map(row => 'content' in row ? '' : row.after?.content ?? ''), columns, tabSize)
  const prefix = new Uint32Array(rows.length + 1)
  for (let index = 0; index < rows.length; index++) {
    prefix[index + 1] = prefix[index] + Math.max(before.prefix[index + 1] - before.prefix[index], after.prefix[index + 1] - after.prefix[index])
  }
  return { prefix, before, after, rows: prefix[rows.length] }
}

function wrapSegment(line: FileDiffLine | undefined, wrap: WrappedCode, index: number, part: number): FileDiffLine | undefined {
  const row = wrap.prefix[index] + part
  if (!line || row >= wrap.prefix[index + 1]) return undefined
  const from = wrap.boundaries[row * 2], to = wrap.boundaries[row * 2 + 1]
  if (from === 0 && to === line.content.length) return line
  const content = line.content.slice(from, to)
  return from === 0 ? { ...line, content, source: line } : {
    id: `${line.id}:${from}`, type: line.type, content, continuation: true, pair: line.pair, sourceOffset: from, source: line
  }
}

export function diffRowsInWindow(rows: readonly DiffRow[], wrapped: WrappedDiff | null, start: number, end: number): readonly DiffRow[] {
  if (!wrapped) return rows.slice(start, end)
  const visible: DiffRow[] = []
  let index = lineAtRow(wrapped.prefix, start)
  for (let display = start; display < end; display++) {
    if (display === wrapped.prefix[index + 1]) index++
    const row = rows[index], part = display - wrapped.prefix[index]
    if ('content' in row) {
      visible.push(row.type === 'hunk' ? row : wrapSegment(row, wrapped.before, index, part)!)
    } else {
      visible.push({
        id: part === 0 ? row.id : `${row.id}:${part}`,
        before: wrapSegment(row.before, wrapped.before, index, part),
        after: wrapSegment(row.after, wrapped.after!, index, part)
      })
    }
  }
  return visible
}

/** Locate the same source line after changing the layout, font, or wrap. */
export function reanchorDiffRow(first: number, previousRows: readonly DiffRow[], previousWrap: WrappedDiff | null, rows: readonly DiffRow[], wrapped: WrappedDiff | null): number | undefined {
  if (first < 0 || first >= (previousWrap?.rows ?? previousRows.length)) return undefined
  const display = Math.floor(first)
  const index = previousWrap ? lineAtRow(previousWrap.prefix, display) : display
  const previous = previousRows[index]
  const part = previousWrap ? display - previousWrap.prefix[index] : 0
  const beforeParts = previousWrap ? previousWrap.before.prefix[index + 1] - previousWrap.before.prefix[index] : 1
  const useAfter = !('content' in previous) && (!previous.before || (part >= beforeParts && previous.after))
  const line = 'content' in previous ? previous : (useAfter ? previous.after : previous.before)!
  const sourceWrap = useAfter ? previousWrap?.after : previousWrap?.before
  const offset = sourceWrap?.boundaries[Math.min(sourceWrap.prefix[index] + part, sourceWrap.prefix[index + 1] - 1) * 2] ?? 0
  const find = (id: string) => rows.findIndex(row => row.id === id || (!('content' in row) && (row.before?.id === id || row.after?.id === id)))
  let next = previousRows === rows ? index : find(line.id)
  // Simplified style omits headings. Resume at the next source row.
  if (next < 0 && line.type === 'hunk' && previousRows[index + 1]) next = find(previousRows[index + 1].id)
  if (next < 0) return undefined
  if (!wrapped) return next + first - display
  const target = rows[next]
  const targetWrap = !('content' in target) && target.before?.id !== line.id ? wrapped.after! : wrapped.before
  return wrapped.prefix[next] + displayRow(targetWrap, next, offset) - targetWrap.prefix[next] + first - display
}
