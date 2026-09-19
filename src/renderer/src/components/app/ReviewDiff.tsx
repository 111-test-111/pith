import { memo, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { ChevronDown, ChevronsDownUp, ChevronsUpDown, ExternalLink } from '@/lib/icons'
import { FileDiff } from '@/components/agents/file-diff'
import { Button } from '@/components/motion/button'
import { Tooltip } from '@/components/motion/tooltip'
import { parseUnifiedDiff } from '@/lib/diff'
import { cn } from '@/lib/utils'
import { useI18n } from '@/i18n'
import { LabelTooltip } from './LabelTooltip'

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
  const slash = displayPath.lastIndexOf('/')
  const dir = slash >= 0 ? displayPath.slice(0, slash) : ''
  const name = slash >= 0 ? displayPath.slice(slash + 1) : displayPath
  const disclosure = <Button variant="ghost" size="sm" aria-expanded={!collapsed} aria-controls={contentId} onClick={onToggle} className="h-8 min-w-0 flex-1 justify-start gap-2 rounded-none px-3 font-normal">
        <ChevronDown aria-hidden="true" className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', collapsed && '-rotate-90')} />
        <span className="min-w-0 flex-1 truncate text-left text-xs">{dir ? <span className="text-muted-foreground/60">{dir}/</span> : null}<span className="text-foreground">{name}</span></span>
        {detail}
        {statsLabel ? <span data-review-stats className="shrink-0 text-xs text-muted-foreground">{statsLabel}</span> : added || removed || showZeroStats ? <span data-review-stats className="flex shrink-0 items-center gap-1.5 font-mono text-xs tabular-nums">{added || showZeroStats ? <span className="text-emerald-600 dark:text-emerald-400">+{added}</span> : null}{removed || showZeroStats ? <span className="text-rose-600 dark:text-rose-400">−{removed}</span> : null}</span> : null}
      </Button>
  return <div data-review-file-header className="group/file sticky top-0 z-1 flex items-center gap-1 border-b border-border/60 bg-background pr-1.5">
    {pathTooltip ? <LabelTooltip content={fullPath ?? displayPath} wrap wrapperClassName="min-w-0 flex-1">{disclosure}</LabelTooltip> : disclosure}
    {action}
    {fullPath ? <Tooltip content={t('review.openFile', { name })} wrapperClassName="shrink-0"><Button variant="ghost" size="icon" className="size-6 shrink-0 opacity-0 focus-visible:opacity-100 group-hover/file:opacity-100" aria-label={t('review.openFile', { name })} onClick={() => void window.pi.openPath(fullPath)}><ExternalLink aria-hidden="true" className="size-3.5" /></Button></Tooltip> : null}
  </div>
}

const ROW_HEIGHT = 20
const OVERSCAN = 24
/** One page scrollport, even for a huge diff. Window rows against the owning
 * review's scroll position; no vendored edits and no nested vertical scroll. */
export const ReviewDiffBody = memo(function ReviewDiffBody({ patch, displayPath, scrollRootRef, layoutKey }: {
  patch: string; displayPath: string; scrollRootRef: RefObject<HTMLElement | null>; layoutKey?: unknown
}) {
  const lines = useMemo(() => parseUnifiedDiff(patch), [patch])
  const virtual = lines.length > 400
  const ref = useRef<HTMLDivElement>(null)
  const [range, setRange] = useState({ start: 0, end: 100 })
  const labelId = useId()
  const { t } = useI18n()
  useLayoutEffect(() => {
    if (!virtual) return
    const root = scrollRootRef.current, body = ref.current
    if (!root || !body) return
    let frame = 0
    const update = () => {
      frame = 0
      const first = Math.floor((root.getBoundingClientRect().top - body.getBoundingClientRect().top) / ROW_HEIGHT)
      const start = Math.min(lines.length, Math.max(0, first - OVERSCAN))
      const end = Math.min(lines.length, Math.max(start, first + Math.ceil(root.clientHeight / ROW_HEIGHT) + OVERSCAN))
      setRange(previous => previous.start === start && previous.end === end ? previous : { start, end })
    }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update) }
    update(); root.addEventListener('scroll', schedule, { passive: true })
    const observer = new ResizeObserver(schedule); observer.observe(root); observer.observe(body)
    return () => { cancelAnimationFrame(frame); root.removeEventListener('scroll', schedule); observer.disconnect() }
    // Collapsing an earlier file moves this body without resizing it or
    // scrolling. Recalculate before paint instead of leaving a stale window.
  }, [virtual, lines.length, scrollRootRef, layoutKey])
  // A stable width keeps distant long lines reachable without measuring DOM.
  const width = useMemo(() => virtual ? lines.reduce((max, line) => Math.max(max, Array.from(line.content).reduce((n, char) => char === '\t' ? n + 8 - n % 8 : n + (char.codePointAt(0)! > 127 ? 2 : 1), 0)), 0) : 0, [lines, virtual])
  const visible = useMemo(() => virtual ? lines.slice(range.start, range.end) : lines, [lines, virtual, range])
  return <div ref={ref} data-review-diff data-review-lines={lines.length} className="overflow-x-auto" aria-labelledby={labelId}>
    <span id={labelId} className="sr-only">{t('rewind.diffLabel', { path: displayPath })}</span>
    <div style={virtual ? { minWidth: `calc(6.5rem + ${width}ch)`, paddingTop: range.start * ROW_HEIGHT, paddingBottom: (lines.length - range.end) * ROW_HEIGHT } : undefined}>
      <FileDiff headerless open maxHeightOverride={null} bodyClassName="rounded-none" containRows file={displayPath} lines={visible} status="complete" highlight={!virtual && patch.length <= 32000} />
    </div>
  </div>
})
