import { memo, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { ChevronDown, ChevronsDownUp, ChevronsUpDown, ExternalLink } from '@/lib/icons'
import { FileDiff, type FileDiffLine } from '@/components/agents/file-diff'
import { Button } from '@/components/motion/button'
import { Tooltip } from '@/components/motion/tooltip'
import { diffContentLines, diffGutterColumns, diffGutterWidth, parseUnifiedDiff } from '@/lib/diff'
import { useDiffStyle } from '@/lib/diff-style'
import { diffDisplayRows, diffLineWidths, diffRowsInWindow, reanchorDiffRow, type DiffLayout, type DiffRow, type WrappedDiff } from '@/lib/diff-layout'
import { DiffWrapRuler, useDiffWrap } from '@/lib/hooks/use-diff-wrap'
import { cn } from '@/lib/utils'
import { useI18n } from '@/i18n'
import { useFileNavigation } from '@/lib/file-navigation'
import { LabelTooltip } from './LabelTooltip'
import { useWheelScroll } from '@/lib/hooks/use-wheel-scroll'
import { codeLineHeight, useCodeFontSize } from '@/lib/typography'

export function ReviewCollapseButton({ allCollapsed, onClick }: { allCollapsed: boolean; onClick: () => void }) {
  const { t } = useI18n()
  const label = t(allCollapsed ? 'review.expandAll' : 'review.collapseAll')
  return <Tooltip content={label}><Button variant="ghost" size="icon" aria-label={label} onClick={onClick}>
    {allCollapsed ? <ChevronsDownUp aria-hidden="true" className="size-4" /> : <ChevronsUpDown aria-hidden="true" className="size-4" />}
  </Button></Tooltip>
}

/** Shared owning header for Review and checkpoint previews. Area/stage labels
 * are extra context, while filename, disclosure, counts and geometry agree. */
export function ReviewFileHeader({ displayPath, fullPath, collapsed, onToggle, added = 0, removed = 0, detail, contentId, pathTooltip = true, action, statsLabel, showZeroStats = false }: {
  displayPath: string; fullPath?: string; collapsed: boolean; onToggle: () => void
  added?: number; removed?: number; detail?: ReactNode; contentId?: string
  pathTooltip?: boolean; action?: ReactNode; statsLabel?: string; showZeroStats?: boolean
}) {
  const { t } = useI18n()
  const fileNavigation = useFileNavigation()
  const slash = displayPath.lastIndexOf('/')
  const dir = slash >= 0 ? displayPath.slice(0, slash) : ''
  const name = slash >= 0 ? displayPath.slice(slash + 1) : displayPath
  const disclosure = <Button variant="ghost" size="sm" aria-expanded={!collapsed} aria-controls={contentId} onClick={onToggle} className="h-8 min-w-0 flex-1 justify-start gap-2 rounded-none px-3 font-normal hover:bg-transparent">
        <ChevronDown aria-hidden="true" className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', collapsed && '-rotate-90')} />
        <span className="min-w-0 truncate text-left text-xs">{dir ? <span className="text-muted-foreground/60">{dir}/</span> : null}<span className="text-foreground">{name}</span></span>
        {!statsLabel && (added || removed || showZeroStats) ? <span data-review-stats className="flex shrink-0 items-center gap-1.5 font-mono text-xs tabular-nums">{added || showZeroStats ? <span className="text-emerald-600 dark:text-emerald-400">+{added}</span> : null}{removed || showZeroStats ? <span className="text-rose-600 dark:text-rose-400">−{removed}</span> : null}</span> : null}
        {detail || statsLabel ? <span className="ml-auto flex shrink-0 items-center gap-2">
          {detail}
          {statsLabel ? <span data-review-stats className="text-xs text-muted-foreground">{statsLabel}</span> : null}
        </span> : null}
      </Button>
  return <div data-review-file-header className="group/file sticky top-0 z-1 flex items-center gap-1 border-b border-border/60 bg-background pr-1.5 transition-colors hover:bg-muted">
    {pathTooltip ? <LabelTooltip content={fullPath ?? displayPath} wrap wrapperClassName="min-w-0 flex-1">{disclosure}</LabelTooltip> : disclosure}
    {action}
    {fullPath ? <Tooltip content={t('review.openFile', { name })} wrapperClassName="shrink-0"><Button variant="ghost" size="icon" className="size-6 shrink-0 rounded-none hover:bg-transparent" aria-label={t('review.openFile', { name })} onClick={() => fileNavigation.openPath(fullPath)}><ExternalLink aria-hidden="true" className="size-3.5" /></Button></Tooltip> : null}
  </div>
}

const OVERSCAN = 24
const EMPTY_LINES: FileDiffLine[] = []

/** One page scrollport, even for a huge diff. Window rows against the owning
 * review's scroll position, including wrapped continuations. */
export const ReviewDiffBody = memo(function ReviewDiffBody({ patch, displayPath, scrollRootRef, scrollContentRef, layoutKey, wrap = true, layout = 'stacked' }: {
  patch: string; displayPath: string; scrollRootRef: RefObject<HTMLElement | null>; scrollContentRef?: RefObject<HTMLElement | null>; layoutKey?: unknown; wrap?: boolean; layout?: DiffLayout
}) {
  const detailed = useDiffStyle() === 'detailed'
  const parsed = useMemo(() => parseUnifiedDiff(patch), [patch])
  const contentLines = useMemo(() => diffContentLines(parsed), [parsed])
  const gutterColumns = useMemo(() => diffGutterColumns(contentLines), [contentLines])
  const gutterWidth = diffGutterWidth(gutterColumns)
  const virtual = contentLines.length > 400
  const split = layout === 'side-by-side'
  const rows = useMemo(() => virtual ? diffDisplayRows(parsed, layout, detailed) : EMPTY_LINES, [parsed, virtual, layout, detailed])
  const rowHeight = codeLineHeight(useCodeFontSize())
  const anchor = useRef<{ first: number; rowHeight: number; patch: string; rows: readonly DiffRow[]; wrapped: WrappedDiff | null } | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  useWheelScroll(ref)
  const [range, setRange] = useState({ start: 0, end: 100 })
  const { ruler, wrapped, tabSize } = useDiffWrap(rows, wrap && virtual, layout, gutterWidth, rowHeight)
  const rowCount = wrapped?.rows ?? rows.length
  const labelId = useId()
  const { t } = useI18n()

  useLayoutEffect(() => {
    if (!virtual) return
    let frame = 0
    let release = () => {}
    const attach = () => {
      frame = 0
      const root = scrollRootRef.current, body = ref.current
      if (!root || !body) return
      const previous = anchor.current
      if (previous && previous.patch === patch && (previous.rows !== rows || previous.rowHeight !== rowHeight || previous.wrapped !== wrapped) && previous.first > 0) {
        const next = reanchorDiffRow(previous.first, previous.rows, previous.wrapped, rows, wrapped)
        if (next !== undefined) root.scrollTop += body.getBoundingClientRect().top - root.getBoundingClientRect().top + next * rowHeight
      }
      const update = () => {
        frame = 0
        const position = (root.getBoundingClientRect().top - body.getBoundingClientRect().top) / rowHeight
        anchor.current = { first: position, rowHeight, patch, rows, wrapped }
        const first = Math.floor(position)
        const start = Math.min(rowCount, Math.max(0, first - OVERSCAN))
        const end = Math.min(rowCount, Math.max(start, first + Math.ceil(root.clientHeight / rowHeight) + OVERSCAN))
        setRange(previous => previous.start === start && previous.end === end ? previous : { start, end })
      }
      const schedule = () => { if (!frame) frame = requestAnimationFrame(update) }
      update(); root.addEventListener('scroll', schedule, { passive: true })
      const observer = new ResizeObserver(schedule); observer.observe(root); observer.observe(body)
      // A preceding patch in the same viewport can move this body when it reflows.
      const content = scrollContentRef?.current
      if (content) observer.observe(content)
      release = () => { root.removeEventListener('scroll', schedule); observer.disconnect() }
    }
    // A parent's DOM ref attaches after its children's layout effects. A cold
    // review mount gets one retry; later font/layout changes apply before paint.
    if (scrollRootRef.current) attach()
    else frame = requestAnimationFrame(attach)
    return () => { cancelAnimationFrame(frame); release() }
    // Collapsing an earlier file moves this body without resizing it or
    // scrolling. Recalculate before paint instead of leaving a stale window.
  }, [virtual, rows, rowCount, scrollRootRef, scrollContentRef, layoutKey, rowHeight, patch, wrapped])
  // A stable width keeps distant long lines reachable without measuring DOM.
  const widths = virtual && !wrap ? diffLineWidths(parsed) : undefined
  const start = Math.min(range.start, rowCount), end = Math.min(range.end, rowCount)
  const visible = useMemo(() => virtual ? diffRowsInWindow(rows, wrapped, start, end) : undefined, [rows, virtual, wrapped, start, end])
  return <div ref={ref} data-review-diff data-review-lines={contentLines.length} className="relative overflow-x-auto" aria-labelledby={labelId}>
    <span id={labelId} className="sr-only">{displayPath ? t('rewind.diffLabel', { path: displayPath }) : t('diff.changes')}</span>
    {wrap && virtual ? <DiffWrapRuler ruler={ruler} layout={layout} gutter={gutterWidth} /> : null}
    <div className="font-mono text-code" style={virtual ? {
      minWidth: !split && widths ? `calc(2 * ${gutterWidth} + 2rem + ${Math.max(widths.before, widths.after)}ch)` : undefined,
      tabSize: wrapped ? tabSize : undefined,
      paddingTop: start * rowHeight,
      paddingBottom: (rowCount - end) * rowHeight
    } : undefined}>
      <FileDiff headerless open maxHeightOverride={null} bodyClassName="rounded-none" containRows wrap={wrap}
        layout={layout} displayRows={visible} lineWidths={widths} gutterColumns={gutterColumns}
        file={displayPath} lines={virtual ? EMPTY_LINES : parsed} status="complete" highlight={!virtual && patch.length <= 32000} />
    </div>
  </div>
})
