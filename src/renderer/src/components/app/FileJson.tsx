import { useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Button } from '@/components/motion/button'
import { Tooltip } from '@/components/motion/tooltip'
import { useI18n } from '@/i18n'
import { ChevronRight, ChevronsDownUp, ChevronsUpDown } from '@/lib/icons'
import { cn } from '@/lib/utils'
import type { StructuredValue } from '../../../../shared/file-preview'

/**
 * Preview for a `.json` file: the document as a collapsible tree — keys,
 * values and container counts at a glance, instead of a wall of source text.
 *
 * The document is the file's JSON. `files:document` reads it whole (the JSON
 * cap in shared/preview.ts) because the tree can only be built from a complete
 * parse — a file cut at the cap is reported as "too large", never as a syntax
 * error the user cannot act on.
 *
 * Huge documents are the design constraint, not an afterthought:
 *  - the visible tree is FLATTENED into a row list (iteratively, so a deeply
 *    nested document overflows nothing), and fold state lives in the root —
 *    React never nests deeper than one row component;
 *  - past `FULL_LIMIT` rows the window takes over: the DOM holds only what is
 *    on screen, however large the document;
 *  - "expand all" cannot turn a pathological document into an unbounded row
 *    list — the walk stops at `ROW_BUDGET` and says so;
 *  - one container shows a page of children at a time, and a long string
 *    folds until asked for.
 */

/** Children one container shows per page; "show more" adds another page. */
const PAGE = 100
/** Characters of one string before the value folds behind a button. */
const MAX_STRING = 300
/** Containers below this depth start open: the root and its own children. */
const OPEN_DEPTH = 2
/** Rows rendered directly; beyond this the virtual window renders them. */
const FULL_LIMIT = 2000
/** Rows the flattened tree may hold: the honest cap for "expand all". */
const ROW_BUDGET = 50_000
/** Pixels one row is estimated to take before it is measured. */
const ROW_ESTIMATE = 20
/** Indent per depth level, in pixels. */
const INDENT = 14

/** What `JSON.parse` can produce, named so the tree's props are checkable. */
type JsonValue = StructuredValue
type JsonContainer = JsonValue[] | { [key: string]: JsonValue }

/** One JSON document: the parsed value, or the one failure mode there is. */
type JsonDocument = { ok: true; value: JsonValue } | { ok: false }

const isContainer = (value: JsonValue): value is JsonContainer => value !== null && typeof value === 'object'

function parseJson(text: string): JsonDocument {
  // An editor's UTF-8 BOM survives the text decode and kills `JSON.parse`;
  // it is file metadata, not document content.
  try { return { ok: true, value: JSON.parse(text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text) as JsonValue } } catch { return { ok: false } }
}

/** Paths join a child's key to its parent's with a separator no key can carry. */
const SEP = ''

type Row =
  | { type: 'container'; path: string; name: string | null; indexed: boolean; depth: number; isArray: boolean; count: number; open: boolean }
  | { type: 'primitive'; path: string; name: string; indexed: boolean; depth: number; value: JsonValue }
  | { type: 'empty'; path: string; name: string | null; indexed: boolean; depth: number; isArray: boolean }
  | { type: 'more'; path: string; depth: number; remaining: number }
  | { type: 'closing'; path: string; depth: number; brace: string }
  | { type: 'cutoff' }

/** Keys must be unique per row: a container and its own closing brace share
 * a path, so the full type name is the prefix — never an abbreviation. */
function rowKey(row: Row): string {
  return row.type === 'cutoff' ? 'cutoff' : `${row.type}:${row.path}`
}

/** Children of one container, as [name, value] pairs — positions for an array. */
function childrenOf(value: JsonContainer, isArray: boolean): [string, JsonValue][] {
  return isArray ? (value as JsonValue[]).map((item, index) => [String(index), item]) : Object.entries(value)
}

/**
 * The visible tree as a flat row list. Fold state comes from the caller:
 * an explicit toggle wins, then the expand/collapse-all signal, then the
 * depth rule. The walk is iterative and stops at `budget` rows — "expand all"
 * on a bushy document must not be able to allocate without bound.
 */
function flatten(root: JsonContainer, explicit: Record<string, boolean>, force: boolean | null, pages: Record<string, number>, budget: number): Row[] {
  const rows: Row[] = []
  const open = (path: string, depth: number) => explicit[path] ?? force ?? depth < OPEN_DEPTH
  interface Frame { path: string; depth: number; isArray: boolean; entries: [string, JsonValue][]; next: number }
  const pushFrame = (value: JsonContainer, path: string, depth: number): Frame => {
    const isArray = Array.isArray(value)
    return { path, depth, isArray, entries: childrenOf(value, isArray), next: 0 }
  }
  const rootIsArray = Array.isArray(root)
  const rootCount = rootIsArray ? (root as JsonValue[]).length : Object.keys(root).length
  if (rootCount === 0) {
    rows.push({ type: 'empty', path: '', name: null, indexed: false, depth: 0, isArray: rootIsArray })
    return rows
  }
  rows.push({ type: 'container', path: '', name: null, indexed: false, depth: 0, isArray: rootIsArray, count: rootCount, open: open('', 0) })
  const stack: Frame[] = rows[0].type === 'container' && rows[0].open ? [pushFrame(root, '', 0)] : []
  while (stack.length) {
    if (rows.length >= budget) { rows.push({ type: 'cutoff' }); break }
    const frame = stack[stack.length - 1]
    const shown = pages[frame.path] ?? PAGE
    const limit = Math.min(shown, frame.entries.length)
    if (frame.next >= limit) {
      if (limit < frame.entries.length) rows.push({ type: 'more', path: frame.path, depth: frame.depth + 1, remaining: frame.entries.length - limit })
      rows.push({ type: 'closing', path: frame.path, depth: frame.depth, brace: frame.isArray ? ']' : '}' })
      stack.pop()
      continue
    }
    const [name, child] = frame.entries[frame.next++]
    const childPath = frame.path + SEP + name
    const depth = frame.depth + 1
    if (!isContainer(child)) {
      rows.push({ type: 'primitive', path: childPath, name, indexed: frame.isArray, depth, value: child })
      continue
    }
    const childIsArray = Array.isArray(child)
    const count = childIsArray ? (child as JsonValue[]).length : Object.keys(child).length
    if (count === 0) {
      rows.push({ type: 'empty', path: childPath, name, indexed: frame.isArray, depth, isArray: childIsArray })
      continue
    }
    const childOpen = open(childPath, depth)
    rows.push({ type: 'container', path: childPath, name, indexed: frame.isArray, depth, isArray: childIsArray, count, open: childOpen })
    if (childOpen) stack.push(pushFrame(child, childPath, depth))
  }
  return rows
}

/** The name a child carries: an object's key, or an array's position. A key
 * never shrinks or wraps — a long value folds below it, not through it. */
function Key({ name, indexed }: { name: string; indexed: boolean }) {
  return <>
    {indexed
      ? <span data-json-index className="shrink-0 tabular-nums text-muted-foreground/70">{name}</span>
      : <span data-json-key className="shrink-0 whitespace-nowrap">{name}</span>}
    <span aria-hidden className="shrink-0 text-muted-foreground">:</span>
  </>
}

function StringValue({ value }: { value: string }) {
  const { t } = useI18n()
  const [full, setFull] = useState(false)
  const long = value.length > MAX_STRING
  const folded = long && !full
  return <span data-json-value="string" className="min-w-0 whitespace-pre-wrap break-words">
    &quot;{folded ? value.slice(0, MAX_STRING) + '…' : value}&quot;
    {long ? <button data-json-string type="button" onClick={() => setFull(!full)}
      className="ms-1 whitespace-nowrap text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground">
      {t(full ? 'files.json.showLess' : 'files.json.showAll')}
    </button> : null}
  </span>
}

function Primitive({ value }: { value: JsonValue }) {
  if (value === null) return <span data-json-value="null" className="italic text-muted-foreground">null</span>
  if (typeof value === 'string') return <StringValue value={value} />
  if (typeof value === 'number') return <span data-json-value="number" className="tabular-nums">{String(value)}</span>
  return <span data-json-value="boolean">{String(value)}</span>
}

/** The chevron slot: every row aligns, whether or not it has a toggle. */
function Slot() {
  return <span aria-hidden className="inline-block size-3 shrink-0 self-center" />
}

function RowView({ row, onToggle, onMore }: { row: Row; onToggle: (path: string, open: boolean) => void; onMore: (path: string) => void }) {
  const { t } = useI18n()
  const indent = 4 + ('depth' in row ? row.depth : 0) * INDENT
  if (row.type === 'container') {
    const label = t(row.isArray ? 'files.json.items' : 'files.json.keys', { count: row.count })
    // The root is the document itself, not a child of anything: no entry marker.
    const entry = row.name !== null ? { 'data-json-entry': '' } : {}
    return <button {...entry} data-json-toggle type="button" aria-expanded={row.open} onClick={() => onToggle(row.path, row.open)}
      className="flex w-full min-w-0 items-baseline gap-1 rounded-detail py-px pe-1 text-start hover:bg-muted/50" style={{ paddingInlineStart: indent }}>
      <ChevronRight aria-hidden className={cn('size-3 shrink-0 self-center text-muted-foreground transition-transform motion-safe:duration-150', row.open && 'rotate-90')} />
      {row.name !== null ? <Key name={row.name} indexed={row.indexed} /> : null}
      <span className="text-muted-foreground">{row.isArray ? '[' : '{'}</span>
      {row.open
        ? <span data-json-count className="shrink-0 rounded-detail bg-muted/70 px-1 text-micro leading-ui-tight text-muted-foreground">{label}</span>
        : <span className="shrink-0 text-muted-foreground/70">… {label} {row.isArray ? ']' : '}'}</span>}
    </button>
  }
  if (row.type === 'primitive') return <div data-json-entry className="flex min-w-0 items-baseline gap-1 py-px pe-1" style={{ paddingInlineStart: indent }}>
    <Slot />
    <Key name={row.name} indexed={row.indexed} />
    <Primitive value={row.value} />
  </div>
  if (row.type === 'empty') return <div data-json-entry className="flex min-w-0 items-baseline gap-1 py-px pe-1" style={{ paddingInlineStart: indent }}>
    <Slot />
    {row.name !== null ? <Key name={row.name} indexed={row.indexed} /> : null}
    <span className="text-muted-foreground">{row.isArray ? '[]' : '{}'}</span>
  </div>
  if (row.type === 'more') return <button data-json-more type="button" onClick={() => onMore(row.path)}
    className="flex w-full min-w-0 items-baseline gap-1 rounded-detail py-px pe-1 text-start text-muted-foreground hover:bg-muted/50 hover:text-foreground" style={{ paddingInlineStart: indent }}>
    <Slot />
    {t('files.json.more', { count: Math.min(PAGE, row.remaining) })}
  </button>
  if (row.type === 'closing') return <div aria-hidden className="flex py-px pe-1 text-muted-foreground" style={{ paddingInlineStart: indent }}>
    <Slot />
    {row.brace}
  </div>
  return <div role="status" data-json-cutoff className="py-2 text-center text-xs leading-ui text-muted-foreground">{t('files.json.capped', { count: ROW_BUDGET })}</div>
}

export function FileJson({ text, truncated }: { text: string; truncated: boolean }) {
  const { t } = useI18n()
  const parsed = useMemo(() => parseJson(text), [text])
  if (!parsed.ok) return <div role="status" data-file-json-invalid className="flex min-h-0 flex-1 items-center justify-center p-5 text-center text-xs leading-ui text-muted-foreground">{t(truncated ? 'files.json.tooLarge' : 'files.json.invalid')}</div>
  return <JsonTree key={text} value={parsed.value} />
}

export function JsonTree({ value }: { value: StructuredValue }) {
  const { t } = useI18n()
  // Fold state, lifted: flattening reads it, rows only report clicks. An
  // explicit toggle wins over the expand/collapse-all signal, which wins over
  // the depth rule; either "all" action starts the maps over.
  const [explicit, setExplicit] = useState<Record<string, boolean>>({})
  const [force, setForce] = useState<boolean | null>(null)
  const [pages, setPages] = useState<Record<string, number>>({})
  const root = isContainer(value) ? value : null
  const rows = useMemo(() => root ? flatten(root, explicit, force, pages, ROW_BUDGET) : [], [root, explicit, force, pages])
  const scroll = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroll.current,
    getItemKey: index => rowKey(rows[index]),
    estimateSize: () => ROW_ESTIMATE,
    overscan: 12
  })
  // A truncated document is JSON cut mid-token: `JSON.parse` cannot read it,
  // so the honest answer is "this one is too large to render here" rather
  // than a parse error the user cannot act on.
  const onToggle = (path: string, open: boolean) => setExplicit(current => ({ ...current, [path]: !open }))
  const onMore = (path: string) => setPages(current => ({ ...current, [path]: (current[path] ?? PAGE) + PAGE }))
  const foldAll = (open: boolean) => { setExplicit({}); setPages({}); setForce(open) }
  return <div data-file-json className="flex min-h-0 flex-1 flex-col">
    {root ? <div data-file-json-bar className="flex h-9 shrink-0 items-center gap-2 border-b border-border/40 px-3">
      <span data-json-summary className="text-xs text-muted-foreground">
        {t(Array.isArray(root) ? 'files.json.items' : 'files.json.keys', { count: Array.isArray(root) ? root.length : Object.keys(root).length })}
      </span>
      <div className="ms-auto flex items-center gap-0.5">
        <Tooltip content={t('files.json.expandAll')}><Button variant="ghost" size="icon" className="size-7 shrink-0" aria-label={t('files.json.expandAll')} data-json-expand-all onClick={() => foldAll(true)}><ChevronsUpDown aria-hidden className="size-3.5" /></Button></Tooltip>
        <Tooltip content={t('files.json.collapseAll')}><Button variant="ghost" size="icon" className="size-7 shrink-0" aria-label={t('files.json.collapseAll')} data-json-collapse-all onClick={() => foldAll(false)}><ChevronsDownUp aria-hidden className="size-3.5" /></Button></Tooltip>
      </div>
    </div> : null}
    <div ref={scroll} data-file-json-tree className="min-h-0 flex-1 overflow-auto p-3 font-mono text-code">
      {root
        ? rows.length <= FULL_LIMIT
          ? rows.map(row => <RowView key={rowKey(row)} row={row} onToggle={onToggle} onMore={onMore} />)
          : <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
              {virtualizer.getVirtualItems().map(item => <div key={item.key} ref={virtualizer.measureElement} data-index={item.index} className="absolute left-0 top-0 w-full" style={{ transform: `translateY(${item.start}px)` }}>
                <RowView row={rows[item.index]} onToggle={onToggle} onMore={onMore} />
              </div>)}
            </div>
        : <Primitive value={value} />}
    </div>
  </div>
}
