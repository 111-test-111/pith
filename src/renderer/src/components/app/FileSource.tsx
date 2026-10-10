import { useCallback, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { AgentCodeLine, type AgentCodeToken } from '@/components/agents/agent-code'
import { Button } from '@/components/motion/button'
import { useFileTokens } from '@/lib/hooks/use-file-tokens'
import { useDiffWindow } from '@/lib/hooks/use-diff-window'
import { fileLanguage } from '@/lib/file-language'
import { cn } from '@/lib/utils'
import { codeLineHeight, useCodeFontSize } from '@/lib/typography'
import { useI18n } from '@/i18n'
import { EMPTY_FILE_SEARCH, type FileSearchResult } from '@/lib/file-search'
import { useFileSearchHighlights } from '@/lib/hooks/use-file-search-highlights'
import type { FileBrowserStore, FileTab } from '@/state/file-browser-store'
import type { DebugBreakpointDTO } from '../../../../shared/types'

/** 3.5rem gutter + 1rem row padding: the horizontal inset around code text. */
const CODE_INSET = 72
/** Re-segment once the resize settles, keeping source DOM stable mid-drag. */
const WRAP_SETTLE_MS = 120

/** Break one line at `columns` display columns. The metric mirrors the
 * unwrapped width calculation (tab → next 8-column stop, wide code point →
 * 2ch), so a segment rendered with whitespace-pre never exceeds the measured
 * width and its row is exactly one code line tall. */
function segmentLine(line: string, columns: number, out: number[]) {
  let column = 0, start = 0, index = 0
  while (index < line.length) {
    const codePoint = line.codePointAt(index)!
    let advance = codePoint === 9 ? 8 - column % 8 : codePoint > 127 ? 2 : 1
    if (column > 0 && column + advance > columns) {
      out.push(start, index)
      start = index
      column = 0
      advance = codePoint === 9 ? 8 : codePoint > 127 ? 2 : 1
    }
    column += advance
    index += codePoint >= 0x10000 ? 2 : 1
  }
  out.push(start, index)
}

/** Shiki offsets are absolute UTF-16 positions in the FILE, including newlines.
 * Find just the tokens intersecting this absolute segment, rather than scanning
 * every token in a minified line again for each display row. */
function sliceTokens(tokens: AgentCodeToken[] | undefined, from: number, to: number) {
  if (!tokens) return undefined
  let low = 0, high = tokens.length
  while (low < high) {
    const mid = (low + high) >>> 1
    if (tokens[mid].offset + tokens[mid].content.length <= from) low = mid + 1
    else high = mid
  }
  const sliced: AgentCodeToken[] = []
  let length = 0
  for (let index = low; index < tokens.length && tokens[index].offset < to; index++) {
    const token = tokens[index]
    const start = Math.max(token.offset, from), end = Math.min(token.offset + token.content.length, to)
    if (start >= end) continue
    length += end - start
    sliced.push({ ...token, content: token.content.slice(start - token.offset, end - token.offset), offset: start - from })
  }
  // An incomplete highlight (e.g. a CR stripped by the grammar) must never
  // remove source characters: AgentCodeLine can paint the original segment.
  return length === to - from ? sliced : undefined
}

/** Largest line index whose first display row is at or above `row`. */
function lineAtRow(prefix: Uint32Array, row: number) {
  let low = 0, high = prefix.length - 2
  while (low < high) {
    const mid = (low + high + 1) >> 1
    if (prefix[mid] <= row) low = mid
    else high = mid - 1
  }
  return low
}

interface WrappedSource { prefix: Uint32Array; boundaries: number[]; rows: number }

/** A character anchor also locates a match deep inside a single wrapped line. */
function displayRow(wrapped: WrappedSource | null, line: number, offset = 0) {
  if (!wrapped) return line
  let low = wrapped.prefix[line], high = wrapped.prefix[line + 1] - 1
  while (low < high) {
    const mid = (low + high + 1) >>> 1
    if (wrapped.boundaries[mid * 2] <= offset) low = mid
    else high = mid - 1
  }
  return low
}

/** BeUI token rows composed into a full-height, windowed source viewport.
 * Soft wrap re-segments lines into display rows at the configured code height, so the fixed-row
 * virtualizer, line anchors and search Highlights stay exact with no DOM
 * measurement. Even one huge logical line mounts only its visible segments. */
export function FileSource({ text, tab, store, search, wrap, debugBreakpoints, onToggleBreakpoint }: { text: string; tab: FileTab; store: FileBrowserStore; search?: { result: FileSearchResult; current: number }; wrap: boolean; debugBreakpoints?: DebugBreakpointDTO[]; onToggleBreakpoint?: (line: number) => void }) {
  const { t } = useI18n()
  const rowHeight = codeLineHeight(useCodeFontSize())
  const ref = useRef<HTMLDivElement>(null)
  const ruler = useRef<HTMLSpanElement>(null)
  const [columns, setColumns] = useState(0)
  const scrollTop = useRef(0)
  const previousLayout = useRef<{ wrapped: WrappedSource | null; lines: string[]; path: string; rowHeight: number } | null>(null)
  const positioned = useRef<{ store: FileBrowserStore; path: string; visit: number; line?: number } | null>(null)
  const lines = useMemo(() => text.split('\n'), [text])
  const gutterColumns = Math.max(3, String(lines.length).length)
  const tokens = useFileTokens(text, fileLanguage(tab.path))
  const lineStarts = useMemo(() => { let offset = 0; return lines.map(line => { const start = offset; offset += line.length + 1; return start }) }, [lines])
  const active = search?.result.matches[search.current]
  const wrapped = useMemo(() => {
    if (!wrap || columns < 8) return null
    const prefix = new Uint32Array(lines.length + 1)
    const boundaries: number[] = []
    for (let index = 0; index < lines.length; index++) {
      segmentLine(lines[index], columns, boundaries)
      prefix[index + 1] = boundaries.length >> 1
    }
    return { prefix, boundaries, rows: boundaries.length >> 1 }
  }, [wrap, columns, lines])
  const rowTop = (line: number, offset = 0) => displayRow(wrapped, line - 1, offset) * rowHeight
  const { start, end, onScroll: measureWindow } = useDiffWindow(ref, wrapped ? wrapped.rows : lines.length, true, 800, rowHeight, false)
  const onScroll = useCallback(() => {
    if (ref.current) scrollTop.current = ref.current.scrollTop
    measureWindow()
  }, [measureWindow])
  const firstLine = wrapped ? lineAtRow(wrapped.prefix, start) : start
  const lastLine = wrapped ? lineAtRow(wrapped.prefix, Math.max(0, end - 1)) : end - 1
  const width = useMemo(() => Math.min(1000000, lines.reduce((longest, line) => Math.max(longest, Array.from(line).reduce((n, char) => char === '\t' ? n + 8 - n % 8 : n + (char.codePointAt(0)! > 127 ? 2 : 1), 0)), 0)), [lines])
  useLayoutEffect(() => {
    const viewport = ref.current, probe = ruler.current
    if (!wrap || !viewport || !probe) return
    const measure = () => {
      const chWidth = probe.getBoundingClientRect().width / 100
      const inset = Math.max(CODE_INSET, gutterColumns * chWidth + 40)
      if (chWidth > 0 && viewport.clientWidth > 0) setColumns(Math.max(8, Math.floor((viewport.clientWidth - inset - 1) / chWidth)))
    }
    measure()
    let timer: ReturnType<typeof setTimeout> | undefined
    const observer = new ResizeObserver(() => {
      clearTimeout(timer)
      timer = setTimeout(measure, WRAP_SETTLE_MS)
    })
    observer.observe(viewport)
    observer.observe(probe)
    return () => { observer.disconnect(); clearTimeout(timer) }
  }, [wrap, rowHeight, gutterColumns])
  // Preserve the reading position across wrap/width changes, using the old
  // character anchor rather than a pixel offset in a different row layout.
  useLayoutEffect(() => {
    const previous = previousLayout.current
    if (previous && previous.lines === lines && previous.path === tab.path && (previous.wrapped !== wrapped || previous.rowHeight !== rowHeight)) {
      const top = Math.max(0, scrollTop.current - 8), row = Math.floor(top / previous.rowHeight)
      const line = previous.wrapped ? lineAtRow(previous.wrapped.prefix, row) : Math.min(row, lines.length - 1)
      const offset = previous.wrapped ? previous.wrapped.boundaries[Math.min(row, previous.wrapped.rows - 1) * 2] : 0
      ref.current!.scrollTop = displayRow(wrapped, line, offset) * rowHeight + (top % previous.rowHeight) / previous.rowHeight * rowHeight + (scrollTop.current > 0 ? 8 : 0)
      if (wrapped) ref.current!.scrollLeft = 0
    }
    previousLayout.current = { wrapped, lines, path: tab.path, rowHeight }
    onScroll()
  }, [wrapped, lines, tab.path, rowHeight, onScroll])
  useLayoutEffect(() => {
    // A cold wrapped mount first measures its columns. Consume the navigation
    // only when its actual display rows exist, then leave later reflows alone.
    if (wrap && !wrapped) return
    const previous = positioned.current
    if (previous?.store === store && previous.path === tab.path && previous.visit === tab.visit && previous.line === tab.line) return
    positioned.current = { store, path: tab.path, visit: tab.visit, line: tab.line }
    const viewport = ref.current!
    const saved = store.getScroll(tab.path, 'source')
    const line = store.takeNavigationLine(tab)
    viewport.scrollTop = line ? Math.max(0, rowTop(Math.min(line, lines.length)) - viewport.clientHeight / 3) : saved?.top ?? 0
    viewport.scrollLeft = saved?.left ?? 0
    onScroll()
    store.saveScroll(tab.path, 'source', viewport.scrollTop, viewport.scrollLeft)
  }, [store, tab.path, tab.visit, tab.line, wrap, wrapped, rowHeight, onScroll])
  useLayoutEffect(() => {
    if (!active) return
    ref.current!.scrollTop = Math.max(0, rowTop(active.line, active.start - lineStarts[active.line - 1]) - ref.current!.clientHeight / 3)
    onScroll()
  }, [active, wrapped, lineStarts, rowHeight, onScroll])
  const highlightVersion = useMemo(() => ({ tokens, wrapped, rowHeight }), [tokens, wrapped, rowHeight])
  useFileSearchHighlights(ref, lineStarts, search?.result.matches ?? EMPTY_FILE_SEARCH.matches, search?.current ?? 0, highlightVersion, start, end)
  /** The gutter cell: a red dot for a bound breakpoint (hollow when unbound),
   * and the line number as a toggle button while a debug session is live. */
  const gutterCell = (number: number, showNumber: boolean) => {
    const breakpoint = debugBreakpoints?.find((item) => item.line === number)
    return (
      <span className="relative select-none pr-4 text-right tabular-nums text-muted-foreground/45">
        {breakpoint ? (
          <span aria-hidden className={cn(
            'absolute left-1.5 top-1/2 size-2 -translate-y-1/2 rounded-full',
            breakpoint.verified ? 'bg-destructive' : 'border border-muted-foreground/60'
          )} />
        ) : null}
        {onToggleBreakpoint && showNumber ? (
          <Button variant="ghost"
            type="button"
            aria-pressed={!!breakpoint}
            aria-label={t('debug.toggleBreakpoint', { line: number })}
            onClick={() => onToggleBreakpoint(number)}
            className={cn('h-[var(--app-line-code)] min-w-0 rounded-control px-1 py-0 align-top font-mono text-code hover:text-foreground focus-visible:ring-inset', breakpoint && 'text-foreground/80')}
          >
            {number}
          </Button>
        ) : showNumber ? number : null}
      </span>
    )
  }
  return <div ref={ref} data-file-source role="region" aria-label={t('files.source')} tabIndex={0} className="min-h-0 flex-1 overflow-auto outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
    style={{ overflowAnchor: 'none', '--source-gutter': `max(3.5rem, calc(${gutterColumns}ch + 1.5rem))` } as CSSProperties}
    onScroll={() => { onScroll(); if (ref.current) store.saveScroll(tab.path, 'source', ref.current.scrollTop, ref.current.scrollLeft) }}>
    <span ref={ruler} aria-hidden className="pointer-events-none invisible fixed m-0 font-mono text-code-inline" style={{ width: '100ch' }} />
    <pre className="m-0 min-w-full py-2 font-mono text-code text-foreground/85" style={wrapped ? undefined : { width: `calc(var(--source-gutter) + 1rem + ${width}ch)` }}>
      <code className="block" style={{ paddingTop: start * rowHeight, paddingBottom: ((wrapped?.rows ?? lines.length) - end) * rowHeight }}>
        {wrapped
          ? lines.slice(firstLine, lastLine + 1).map((line, index) => {
              const number = firstLine + index + 1
              const firstSegment = Math.max(start, wrapped.prefix[number - 1])
              const lastSegment = Math.min(end, wrapped.prefix[number])
              const offset = wrapped.boundaries[firstSegment * 2]
              const lineTokens = tokens?.[firstLine + index]
              return <span key={number} data-source-line={number} data-source-offset={offset} className={cn('grid grid-cols-[var(--source-gutter)_minmax(0,1fr)]', !search && tab.line === number && 'bg-primary/10')}>
                {gutterCell(number, firstSegment === wrapped.prefix[number - 1])}
                <span className="min-w-0 pr-4">
                  {Array.from({ length: lastSegment - firstSegment }, (_, segment) => {
                    const from = wrapped.boundaries[(firstSegment + segment) * 2], to = wrapped.boundaries[(firstSegment + segment) * 2 + 1]
                    return <AgentCodeLine key={from} code={line.slice(from, to)} tokens={sliceTokens(lineTokens, lineStarts[number - 1] + from, lineStarts[number - 1] + to)} className="block h-[var(--app-line-code)] whitespace-pre" />
                  })}
                </span>
              </span>
            })
          : lines.slice(start, end).map((line, index) => <span key={start + index} data-source-line={start + index + 1} className={cn('grid h-[var(--app-line-code)] grid-cols-[var(--source-gutter)_minmax(0,1fr)]', !search && tab.line === start + index + 1 && 'bg-primary/10')}>
              {gutterCell(start + index + 1, true)}
              <AgentCodeLine code={line} tokens={tokens?.[start + index]} className="whitespace-pre pr-4" />
            </span>)}
      </code>
    </pre>
  </div>
}
