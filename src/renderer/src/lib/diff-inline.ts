import { diffWordsWithSpace } from 'diff'
import type { FileDiffLine } from '@/components/agents/file-diff'

export interface DiffLinePair { before: string; after: string }
export interface DiffRange { start: number; end: number }

const MAX_PAIR_CHARS = 1_000
const MAX_PAIR_ATTEMPTS = 100
const WINDOW_BUDGET_MS = 8

/** Pair adjacent replacements before either side gets sliced by a scroll window. */
export function pairDiffLines(lines: FileDiffLine[]): void {
  let index = 0
  while (index < lines.length) {
    if (lines[index].type !== 'removed') { index++; continue }
    const beforeStart = index
    while (lines[index]?.type === 'removed') index++
    const afterStart = index
    while (lines[index]?.type === 'added') index++
    const count = Math.min(afterStart - beforeStart, index - afterStart)
    for (let offset = 0; offset < count; offset++) {
      const before = lines[beforeStart + offset], after = lines[afterStart + offset]
      if (before.content && after.content && before.content !== after.content && before.content.length + after.content.length <= MAX_PAIR_CHARS) {
        before.pair = after.pair = { before: before.content, after: after.content }
      }
    }
  }
}

type PairedRanges = { before: DiffRange[]; after: DiffRange[] }
const rangeCache = new WeakMap<DiffLinePair, PairedRanges | null>()

function comparePair(pair: DiffLinePair): PairedRanges | null {
  const parts = diffWordsWithSpace(pair.before, pair.after, { maxEditLength: 48, timeout: 2 })
  if (!parts) return null
  const ranges: PairedRanges = { before: [], after: [] }
  let before = 0, after = 0, shared = 0
  for (const part of parts) {
    const length = part.value.length
    if (part.removed) ranges.before.push({ start: before, end: before + length })
    if (part.added) ranges.after.push({ start: after, end: after + length })
    if (!part.added) before += length
    if (!part.removed) after += length
    if (!part.added && !part.removed) shared += part.value.trim().length
  }
  // Unrelated neighbors can occupy the same position in an add/remove run.
  return shared >= Math.max(pair.before.trim().length, pair.after.trim().length) / 3 ? ranges : null
}

/** Compute marks for rendered rows. Wrapped segments retain offsets into the original line. */
export function diffInlineRanges(lines: readonly FileDiffLine[]): Map<FileDiffLine, readonly DiffRange[]> {
  const marks = new Map<FileDiffLine, readonly DiffRange[]>()
  const deadline = performance.now() + WINDOW_BUDGET_MS
  let attempts = 0
  for (const line of lines) {
    const pair = line.pair
    if (!pair) continue
    let ranges = rangeCache.get(pair)
    if (ranges === undefined) {
      if (attempts >= MAX_PAIR_ATTEMPTS || performance.now() >= deadline) continue
      attempts++
      ranges = comparePair(pair)
      rangeCache.set(pair, ranges)
    }
    if (!ranges) continue
    const side = line.type === 'removed' ? 'before' : 'after'
    const offset = line.sourceOffset ?? 0
    const end = offset + line.content.length
    const visible = offset === 0 && end === pair[side].length ? ranges[side] : ranges[side].flatMap(range => {
      const start = Math.max(range.start, offset)
      const stop = Math.min(range.end, end)
      return start < stop ? [{ start: start - offset, end: stop - offset }] : []
    })
    if (visible.length > 0) marks.set(line, visible)
  }
  return marks
}
