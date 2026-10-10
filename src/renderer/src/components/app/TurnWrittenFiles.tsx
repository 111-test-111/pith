import { memo, useCallback, useEffect, useId, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { ChevronDown, Diff } from '@/lib/icons'
import { getCachedAgentCodeTokens, prefetchAgentCodeTokens } from '@/components/agents/agent-code'
import { useCodeThemes } from '@/lib/code-theme-settings'
import { FileDiff, type FileDiffLine } from '@/components/agents/file-diff'
import { Button } from '@/components/motion/button'
import { MorphPopover, MorphPopoverContent } from '@/components/motion/popover-morph'
import { NumberTicker } from '@/components/motion/number-ticker'
import { parseUnifiedDiff } from '@/lib/diff'
import { useHoverGesture } from '@/lib/hooks/use-hover-gesture'
import { sumWrittenFileStats, type WrittenFile } from '@/lib/turn-written-files'
import { cn } from '@/lib/utils'
import { useI18n } from '@/i18n'

const VISIBLE_FILE_LIMIT = 5
const PREVIEW_OPEN_DELAY_MS = 600
const PREVIEW_CLOSE_DELAY_MS = 160
const PREVIEW_PREFETCH_DELAY_MS = 160
const PREVIEW_MAX_HEIGHT = 320
const PREVIEW_FLIP_MARGIN = 24
/** Free strips beside the panel let the pointer sweep along adjacent rows. */
const PREVIEW_SIDE_MARGIN = 30
const PREVIEW_LANGUAGE = 'typescript' as const
const PREVIEW_HIGHLIGHT_MAX_LINES = 400
/** A one-line generated file can cost more to tokenize than hundreds of normal lines. */
const PREVIEW_HIGHLIGHT_MAX_CHARS = 32_000

/** One owner across all turns; a hand-over between rows of one list keeps its portal. */
let closeActivePreview: (() => void) | null = null

type PreviewData = { lines: FileDiffLine[]; code: string | null }
const previewCache = new WeakMap<WrittenFile, PreviewData>()

function previewData(file: WrittenFile): PreviewData {
  const cached = previewCache.get(file)
  if (cached) return cached
  const lines = file.patch ? parseUnifiedDiff(file.patch) : []
  const code = lines.length <= PREVIEW_HIGHLIGHT_MAX_LINES &&
    (file.patch?.length ?? 0) <= PREVIEW_HIGHLIGHT_MAX_CHARS
    ? lines.map((line) => line.content).join('\n')
    : null
  const data = { lines, code }
  previewCache.set(file, data)
  return data
}

/** Resolve on interaction, keeping full patch parsing out of collapsed rows. */
function hasPreview(file: WrittenFile): boolean {
  return Boolean(file.patch?.trim() && previewData(file).lines.length)
}

/**
 * A diff stat whose digits roll: file edits stream in one call at a time, so
 * the turn's +N/−N counts grow while the user watches them.
 *
 * `startOnView` stays on — a turn restored from a snapshot or scrolled back
 * into view reveals its counts instead of appearing pre-settled — and the
 * stagger is shortened so a live update never reads as lag.
 */
function LineStat({ value, sign }: { value: number; sign: '+' | '−' }) {
  return <NumberTicker value={value} prefix={sign} duration={0.5} stagger={0.02} />
}

function LineStats({ added, removed, className }: { added: number; removed: number; className?: string }) {
  if (!added && !removed) return null
  return (
    <span className={cn('flex shrink-0 items-center gap-1.5 font-mono text-sm tabular-nums', className)}>
      {added ? (
        <span className="text-emerald-600 dark:text-emerald-400">
          <LineStat value={added} sign="+" />
        </span>
      ) : null}
      {removed ? (
        <span className="text-rose-600 dark:text-rose-400">
          <LineStat value={removed} sign="−" />
        </span>
      ) : null}
    </span>
  )
}

/** Snapshot ready tokens on entry: a cold preview stays plain for this visit. */
const WrittenFileDiff = memo(function WrittenFileDiff({ file }: { file: WrittenFile }) {
  const [{ lines, code }] = useState(() => previewData(file))
  const [themes] = useCodeThemes()
  // A theme change starts a new snapshot; a cold visit still stays plain.
  const tokens = useMemo(() => code ? getCachedAgentCodeTokens(code, PREVIEW_LANGUAGE, themes) ?? null : null, [code, themes])
  if (!lines.length) return null
  return (
    <FileDiff
      headerless
      open
      highlight={false}
      tokenLines={tokens}
      virtualize
      edgeFade={false}
      file={file.displayPath}
      lines={lines}
      additions={file.added}
      deletions={file.removed}
      status="complete"
      maxHeight={PREVIEW_MAX_HEIGHT}
      bodyClassName="rounded-none"
    />
  )
})

type Preview = {
  file: WrittenFile
  anchor: HTMLButtonElement
  side: 'top' | 'bottom'
  width: number
}

/** A row supplies the anchor; the list owns one persistent beUI popover. */
const WrittenFileRow = memo(function WrittenFileRow({
  file, active, contentId, onEnter, onLeave, onFocus, onBlur, onClick
}: {
  file: WrittenFile
  active: boolean
  contentId: string
  onEnter: (file: WrittenFile, anchor: HTMLButtonElement) => void
  onLeave: () => void
  onFocus: (file: WrittenFile, anchor: HTMLButtonElement) => void
  onBlur: () => void
  onClick: (file: WrittenFile, anchor: HTMLButtonElement) => void
}) {
  const id = useId()
  const hover = useHoverGesture()
  const buttonRef = useRef<HTMLButtonElement>(null)
  const slash = file.displayPath.lastIndexOf('/')
  const dir = slash >= 0 ? file.displayPath.slice(0, slash) : ''
  const name = file.displayPath.slice(slash + 1)
  const canPreview = Boolean(file.patch?.trim())
  return (
    <li
      className="min-w-0"
      onPointerEnter={(event: ReactPointerEvent<HTMLLIElement>) => {
        if (hover.enter(event) && buttonRef.current) onEnter(file, buttonRef.current)
      }}
      onPointerLeave={(event: ReactPointerEvent<HTMLLIElement>) => {
        if (hover.leave(event)) onLeave()
      }}
    >
      <Button
        id={id}
        ref={buttonRef}
        variant="ghost"
        size="sm"
        className="h-8 w-full justify-start gap-2 rounded-none px-3 font-normal"
        // beUI's transition-colors otherwise trails an instant preview swap.
        style={{ transition: 'none' }}
        aria-haspopup={canPreview ? 'dialog' : undefined}
        aria-expanded={canPreview ? active : undefined}
        aria-controls={active ? contentId : undefined}
        onClick={(event) => onClick(file, event.currentTarget)}
        onFocus={(event) => onFocus(file, event.currentTarget)}
        onBlur={onBlur}
      >
        <span className="min-w-0 flex-1 truncate text-left text-sm">
          {dir ? <span className="text-muted-foreground/60">{dir}/</span> : null}
          <span className="text-foreground">{name}</span>
        </span>
        <LineStats added={file.added ?? 0} removed={file.removed ?? 0} />
      </Button>
    </li>
  )
})

export const TurnWrittenFiles = memo(function TurnWrittenFiles({
  files, onReview, onUndo
}: {
  files: WrittenFile[]
  onReview?: () => void
  /** Opens Rewind on the scope's opening user message, preselected files-only.
   * Absent in read-only views (or when the anchor was compacted away). */
  onUndo?: () => void
}) {
  const { t } = useI18n()
  const contentId = useId()
  const [expanded, setExpanded] = useState(false)
  const visible = useMemo(() => expanded ? files : files.slice(0, VISIBLE_FILE_LIMIT), [expanded, files])
  const listRef = useRef<HTMLUListElement>(null)
  const [preview, setPreview] = useState<Preview | null>(null)
  const previewRef = useRef<Preview | null>(null)
  const pinned = useRef(false)
  // Portal boundary events can arrive in either order; never merge these flags.
  const rowOver = useRef(false)
  const panelOver = useRef(false)
  const openTimer = useRef<number | undefined>(undefined)
  const closeTimer = useRef<number | undefined>(undefined)
  const prefetchCancel = useRef<(() => void) | null>(null)

  const clearTimers = useCallback(() => {
    window.clearTimeout(openTimer.current)
    window.clearTimeout(closeTimer.current)
    openTimer.current = closeTimer.current = undefined
  }, [])

  const close = useCallback(() => {
    clearTimers()
    prefetchCancel.current?.()
    previewRef.current = null
    pinned.current = false
    panelOver.current = false
    setPreview(null)
    if (closeActivePreview === close) closeActivePreview = null
  }, [clearTimers])

  const show = useCallback((file: WrittenFile, anchor: HTMLButtonElement) => {
    clearTimers()
    if (!hasPreview(file)) {
      closeActivePreview?.()
      close()
      return false
    }
    const current = previewRef.current
    if (current?.file.filePath === file.filePath && current.file.patch === file.patch && current.anchor === anchor) return true
    if (closeActivePreview && closeActivePreview !== close) closeActivePreview()
    closeActivePreview = close
    const rect = listRef.current?.getBoundingClientRect()
    // Latch the side for the whole sweep using the largest allowed preview.
    // Short diffs shrink naturally; the shared popover measures the new anchor
    // and content together before paint, keeping its row-facing edge flush.
    const side = previewRef.current?.side ?? (
      rect && window.innerHeight - rect.bottom >= PREVIEW_MAX_HEIGHT + PREVIEW_FLIP_MARGIN
        ? 'bottom' : 'top'
    )
    const width = Math.max(1, Math.min(
      (rect?.width ?? window.innerWidth) - PREVIEW_SIDE_MARGIN * 2,
      window.innerWidth - 24
    ))
    const next = { file, anchor, side, width }
    pinned.current = false
    previewRef.current = next
    setPreview(next)
    return true
  }, [clearTimers, close])

  const scheduleClose = useCallback(() => {
    clearTimers()
    if (pinned.current) return
    closeTimer.current = window.setTimeout(() => {
      const focused = document.activeElement
      const anchor = previewRef.current?.anchor
      const keyboardOnRow = focused === anchor && anchor?.matches(':focus-visible')
      const focusInPanel = focused && document.getElementById(contentId)?.contains(focused)
      if (!rowOver.current && !panelOver.current && !keyboardOnRow && !focusInPanel) close()
    }, PREVIEW_CLOSE_DELAY_MS)
  }, [clearTimers, close, contentId])

  /** One cancellable idle job per list. No Shiki work starts in a pointer event. */
  const warm = useCallback((file: WrittenFile) => {
    prefetchCancel.current?.()
    let cancelled = false
    let handle: number | undefined
    let timer: number | undefined
    const start = visible.indexOf(file)
    const queue: WrittenFile[] = []
    for (let distance = 0; distance < visible.length; distance++) {
      if (visible[start + distance]) queue.push(visible[start + distance])
      if (distance && visible[start - distance]) queue.push(visible[start - distance])
    }
    const cancel = () => {
      cancelled = true
      window.clearTimeout(timer)
      if (handle !== undefined) window.cancelIdleCallback(handle)
    }
    prefetchCancel.current = cancel
    if (typeof window.requestIdleCallback !== 'function') return
    const step = () => {
      if (cancelled) return
      const next = queue.shift()
      if (!next) return
      const { code } = previewData(next)
      // Each chain owns its cancellation flag: a previous asynchronous tokenize
      // cannot resurrect a cancelled queue when the next hover starts a new one.
      const work = code ? prefetchAgentCodeTokens(code, PREVIEW_LANGUAGE) : Promise.resolve()
      void work.catch(() => {}).finally(() => {
        if (!cancelled && queue.length) handle = window.requestIdleCallback(step)
      })
    }
    // Even idle tokenization can consume a frame. Wait for the pointer to rest
    // before warming neighbours; a rapid sweep cancels this timer each time.
    timer = window.setTimeout(() => {
      handle = window.requestIdleCallback(step)
    }, PREVIEW_PREFETCH_DELAY_MS)
  }, [visible])

  const onEnter = useCallback((file: WrittenFile, anchor: HTMLButtonElement) => {
    rowOver.current = true
    clearTimers()
    if (!hasPreview(file)) {
      closeActivePreview?.()
      close()
      return
    }
    warm(file)
    if (closeActivePreview) show(file, anchor)
    else openTimer.current = window.setTimeout(() => show(file, anchor), PREVIEW_OPEN_DELAY_MS)
  }, [clearTimers, close, show, warm])
  const onLeave = useCallback(() => {
    rowOver.current = false
    scheduleClose()
  }, [scheduleClose])
  const onFocus = useCallback((file: WrittenFile, anchor: HTMLButtonElement) => {
    // Pointer focus is followed by click; keyboard focus opens immediately.
    if (anchor.matches(':focus-visible')) {
      if (show(file, anchor)) warm(file)
    }
  }, [show, warm])
  const onBlur = useCallback(() => {
    scheduleClose()
  }, [scheduleClose])
  const onClick = useCallback((file: WrittenFile, anchor: HTMLButtonElement) => {
    if (previewRef.current?.file.filePath === file.filePath && pinned.current) close()
    else if (show(file, anchor)) pinned.current = true
  }, [close, show])

  useEffect(() => () => {
    clearTimers()
    prefetchCancel.current?.()
    if (closeActivePreview === close) closeActivePreview = null
  }, [clearTimers, close])
  useEffect(() => {
    // Collapsing the list or replacing its files cannot leave an orphan anchor.
    // Equivalent files can be re-derived when another turn updates; object
    // identity must not dismiss a preview the user is still reading.
    const current = previewRef.current?.file
    if (current && !visible.some((file) => file.filePath === current.filePath && file.patch === current.patch)) close()
    return () => prefetchCancel.current?.()
  }, [visible, close])

  if (files.length === 0) return null
  const stats = sumWrittenFileStats(files)
  const hidden = Math.max(0, files.length - VISIBLE_FILE_LIMIT)
  return (
    <MorphPopover
      open={preview !== null}
      onOpenChange={(next) => { if (!next) close() }}
      anchor={preview?.anchor}
      contentId={contentId}
      className="w-full text-sm"
    >
      <div className="w-full overflow-hidden rounded-2xl border border-border/70">
        <div className="flex items-center gap-3 border-b border-border/60 px-3 py-2.5" onPointerDown={close}>
          <span aria-hidden="true" className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
            <Diff className="size-5" />
          </span>
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate text-sm font-medium text-foreground">
              {t(files.length === 1 ? 'tool.filesChangedOne' : 'tool.filesChangedMany', { count: files.length })}
            </span>
            {stats ? <LineStats added={stats.added} removed={stats.removed} className="font-normal" /> : null}
          </span>
          <span className="flex shrink-0 items-center gap-1.5">
            {hidden > 0 ? (
              <Button variant="ghost" size="sm" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
                {expanded ? t('tool.filesShowLess') : t('tool.filesShowMore')}
                <ChevronDown aria-hidden="true" className={cn('size-3.5 transition-transform', expanded && 'rotate-180')} />
              </Button>
            ) : null}
            {onUndo ? (
              <Button variant="ghost" size="sm" onClick={onUndo}>{t('tool.filesUndo')}</Button>
            ) : null}
            <Button variant="ghost" size="sm" onClick={onReview}>{t('tool.filesReview')}</Button>
          </span>
        </div>
        <ul ref={listRef} data-plain-list>
          {visible.map((file) => (
            <WrittenFileRow
              key={file.filePath}
              file={file}
              active={preview?.file.filePath === file.filePath}
              contentId={contentId}
              onEnter={onEnter}
              onLeave={onLeave}
              onFocus={onFocus}
              onBlur={onBlur}
              onClick={onClick}
            />
          ))}
        </ul>
      </div>
      {/* Keep the content component mounted while closed so its client-only
          portal gate is ready before the first hover. The exiting portal is
          inert immediately. Changing the active row reuses the open surface. */}
      <MorphPopoverContent side={preview?.side ?? 'bottom'} align="center" sideOffset={0} radius="var(--app-radius-card)">
        {preview ? (
          <div
            className="bg-muted/80"
            // FileDiff owns the height cap; a short diff must not inherit a
            // full-height empty frame from this wrapper.
            style={{ width: preview.width }}
            onPointerEnter={() => { panelOver.current = true; clearTimers() }}
            onPointerLeave={() => { panelOver.current = false; scheduleClose() }}
            onFocusCapture={clearTimers}
            onBlurCapture={scheduleClose}
          >
            <WrittenFileDiff key={preview.file.filePath} file={preview.file} />
          </div>
        ) : null}
      </MorphPopoverContent>
    </MorphPopover>
  )
})
