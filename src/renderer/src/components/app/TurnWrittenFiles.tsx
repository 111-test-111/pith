import { memo, useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { ChevronDown, Diff, Undo2 } from 'lucide-react'
import { prefetchAgentCodeTokens } from '@/components/agents/agent-code'
import { FileDiff } from '@/components/agents/file-diff'
import { Button } from '@/components/motion/button'
import {
  MorphPopover,
  MorphPopoverContent,
  MorphPopoverTrigger
} from '@/components/motion/popover-morph'
import { parseUnifiedDiff } from '@/lib/diff'
import { useHoverGesture } from '@/lib/hooks/use-hover-gesture'
import { sumWrittenFileStats, type WrittenFile } from '@/lib/turn-written-files'
import { cn } from '@/lib/utils'
import { useI18n } from '@/i18n'

/**
 * The files one turn wrote, listed under the turn's answer: a path per row with
 * the turn's +/- counts, and the file's diff on hover (the panel can also be
 * pinned by clicking a row, which is how keyboard and touch users reach it).
 *
 * beUI-native: each row is a button inside one bordered, hairline-divided list;
 * the preview is a controlled `MorphPopover` anchored to that button, and the
 * diff inside it is the vendored `FileDiff` (headerless, since the row already
 * names the file).
 */
const VISIBLE_FILE_LIMIT = 5
/** Long enough that sweeping the pointer across a turn never opens a panel. */
const PREVIEW_OPEN_DELAY_MS = 600
/** Grace after leaving a row or its panel, so crossing the gap doesn't flicker. */
const PREVIEW_CLOSE_DELAY_MS = 160
/** Slightly wider than any row, so the panel never has to fight the viewport. */
const PREVIEW_MAX_HEIGHT = 320
/** Room the panel needs below the list before it is placed below it. */
const PREVIEW_FLIP_MARGIN = 24
/**
 * The strip left free on each side of the row. It is the corridor the pointer
 * travels to switch previews by moving along the list, while the panel itself is
 * what you move up into to read a diff — so the panel is the row's full width
 * minus one strip on each side.
 */
const PREVIEW_SIDE_MARGIN = 30
/** Diff rows are highlighted as TypeScript, like every other diff in the app. */
const PREVIEW_LANGUAGE = 'typescript' as const
/**
 * Above this many rows the preview drops Shiki and shows plain text (the +/-
 * tint still carries the meaning). Tokenizing a long `write` diff costs tens of
 * ms of main-thread work and adds a span per token to an already huge subtree —
 * the two together are what made a fast sweep across big diffs stutter. The
 * transcript's own diff stays highlighted either way.
 */
const PREVIEW_HIGHLIGHT_MAX_LINES = 400

/**
 * Only one preview is open at a time, across every turn's list: the closer of
 * whichever row owns it. The slot is module-level because rows live in several
 * lists (one per turn), and a hover must not stack a panel on the one the user
 * just asked to keep by clicking.
 */
let closeActivePreview: ((handOver?: boolean) => void) | null = null

/** True while some row's preview is on screen — the hand-over fast path. */
function previewIsOpen(): boolean {
  return closeActivePreview !== null
}

function claimPreview(close: (handOver?: boolean) => void, handOver: boolean): void {
  // Release-then-assign: the outgoing owner clears the slot on its way out, so
  // this row has to take it afterwards. `handOver` tells it to disappear without
  // its exit morph.
  if (closeActivePreview && closeActivePreview !== close) closeActivePreview(handOver)
  closeActivePreview = close
}

function releasePreview(close: (handOver?: boolean) => void): void {
  if (closeActivePreview === close) closeActivePreview = null
}

/** Mirrors FileDiff's own header counts, so every +/- in the app reads alike. */
function LineStats({ added, removed, className }: { added: number; removed: number; className?: string }) {
  if (!added && !removed) return null
  return (
    <span
      className={cn('flex shrink-0 items-center gap-1.5 font-mono text-sm tabular-nums', className)}
    >
      {added ? <span className="text-emerald-600 dark:text-emerald-400">+{added}</span> : null}
      {removed ? <span className="text-rose-600 dark:text-rose-400">−{removed}</span> : null}
    </span>
  )
}

/** The turn's diff for one file, mounted with the preview panel it lives in. */
function WrittenFileDiff({ file }: { file: WrittenFile }) {
  const lines = useMemo(() => (file.patch ? parseUnifiedDiff(file.patch) : []), [file.patch])
  return (
    <FileDiff
      headerless
      open
      highlight={lines.length > 0 && lines.length <= PREVIEW_HIGHLIGHT_MAX_LINES}
      containRows
      lazyContent
      file={file.displayPath}
      lines={lines}
      additions={file.added}
      deletions={file.removed}
      status="complete"
      maxHeight={PREVIEW_MAX_HEIGHT}
    />
  )
}

/**
 * The exact string `FileDiff` tokenizes for a patch: it rebuilds the diff body
 * from the parsed lines, so the prefetch must key its cache entry the same way —
 * warming the raw patch text would warm a key the panel never reads.
 */
function previewCode(patch: string): string {
  return parseUnifiedDiff(patch)
    .map((line) => line.content)
    .join('\n')
}

function WrittenFileRow({
  file,
  resolveLayout,
  onHoverStart
}: {
  file: WrittenFile
  /**
   * Where the preview should sit for this open — resolved from the *list*, not
   * the row, so every row in a sweep agrees on the side and the panel never
   * flips across its anchor between files.
   */
  resolveLayout: () => { side: 'top' | 'bottom'; width: number }
  /** Warms the rendered diffs' token caches — see the list's prefetch. */
  onHoverStart?: () => void
}) {
  const { t } = useI18n()
  const hover = useHoverGesture()
  const openTimer = useRef<number | null>(null)
  const closeTimer = useRef<number | null>(null)
  // Pointer on the row, and separately on its panel, plus "the click that just
  // arrived was this row's" — all three only gate timers and one decision, so
  // they stay refs instead of re-rendering on every pointer move.
  //
  // The two hover flags are deliberately separate. The panel is portalled out
  // of the row, so crossing between them is one enter and one leave, and React
  // synthesises those for a portal in its own order — whichever lands last would
  // win a single shared flag. With two, moving onto the panel and back leaves
  // the row's flag set, so the close timer below can no longer fire under a
  // pointer that is still on the row.
  const rowOverRef = useRef(false)
  const panelOverRef = useRef(false)
  const clickRef = useRef(false)

  /** True while the pointer sits on the row or on its panel. */
  const pointerIsOver = useCallback(
    () => rowOverRef.current || panelOverRef.current,
    []
  )
  const [open, setOpen] = useState(false)
  const [pinned, setPinned] = useState(false)
  const [side, setSide] = useState<'top' | 'bottom'>('bottom')
  // The panel is narrower than its row and centred: the strips on either side
  // stay free for moving along the list, and the panel itself is the target when
  // moving up into a diff.
  const [panelWidth, setPanelWidth] = useState<number | undefined>(undefined)
  // A preview that hands over from another file must swap in the same frame:
  // `unmountNow` drops this row's panel without its exit morph, `instant` mounts
  // the incoming one at rest (see the `instant` local patch in popover-morph).
  const [unmountNow, setUnmountNow] = useState(false)
  const [instant, setInstant] = useState(false)

  const clearTimers = useCallback(() => {
    if (openTimer.current !== null) window.clearTimeout(openTimer.current)
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current)
    openTimer.current = null
    closeTimer.current = null
  }, [])

  /**
   * Closes this row's preview whatever state it is in — including pinned. Called
   * with `handOver` by whichever row takes the preview slot next.
   *
   * Every close unmounts the panel instead of playing a vendored exit: a panel
   * that animates out parks a fixed, invisible overlay over the list until
   * AnimatePresence decides the spring settled — which it does not always do —
   * and that leftover overlay both swallows hovers and delays the next open.
   */
  const forceClose = useCallback(
    (handOver = false) => {
      void handOver
      clearTimers()
      releasePreview(forceClose)
      setPinned(false)
      setOpen(false)
      setUnmountNow(true)
    },
    [clearTimers]
  )

  // A pending timer must not outlive the row (a session switch unmounts the
  // list), and a closed row must not leave the preview slot holding its closer.
  useEffect(
    () => () => {
      clearTimers()
      releasePreview(forceClose)
    },
    [clearTimers, forceClose]
  )

  const show = useCallback(() => {
    // MorphPopover has no collision handling of its own, so the side is picked
    // here — but from the list, once for all its rows: where the list sits in
    // the viewport is what decides whether the panel fits below it, and a side
    // that is a property of the row is exactly what made sweeping the rows
    // teleport the panel from one side of the pointer to the other.
    const layout = resolveLayout()
    setSide(layout.side)
    setPanelWidth(layout.width)
    // Whether this replaces a preview that is already up decides both the enter
    // animation and how the outgoing panel goes away.
    const handOver = previewIsOpen()
    setUnmountNow(false)
    setInstant(handOver)
    claimPreview(forceClose, handOver)
    setOpen(true)
  }, [forceClose, resolveLayout])

  const scheduleOpen = useCallback(() => {
    clearTimers()
    if (open) return
    // Moving the pointer from one file to the next is the one case with no dwell
    // delay: the preview is already up, so the swap must feel like one gesture.
    const delay = previewIsOpen() ? 0 : PREVIEW_OPEN_DELAY_MS
    openTimer.current = window.setTimeout(() => {
      openTimer.current = null
      show()
    }, delay)
  }, [clearTimers, open, show])

  const scheduleClose = useCallback(() => {
    clearTimers()
    if (pinned) return
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null
      if (pointerIsOver()) return
      setUnmountNow(true)
      setOpen(false)
      // Free the slot so a later hover is a fresh (animated, delayed) open, not
      // a hand-over from a panel that is already gone.
      releasePreview(forceClose)
    }, PREVIEW_CLOSE_DELAY_MS)
  }, [clearTimers, forceClose, pinned, pointerIsOver])

  /** Every open/close request: the row's click, Escape, and outside presses. */
  const handleOpenChange = useCallback(
    (next: boolean) => {
      clearTimers()
      const fromThisRow = clickRef.current
      clickRef.current = false
      // The trigger's click toggles, so a click on a row that is already
      // previewing arrives here as `false` — it means "keep this open", not
      // "close it". Escape and outside presses never set the flag.
      if (next || (fromThisRow && pointerIsOver() && !pinned)) {
        setPinned(true)
        // Through `show` so a click that opens a closed row also claims the
        // preview slot (and picks its side) like a hover would.
        show()
        return
      }
      setPinned(false)
      setUnmountNow(true)
      setOpen(false)
      releasePreview(forceClose)
    },
    [clearTimers, forceClose, pinned, pointerIsOver, show]
  )

  const onRowEnter = (event: ReactPointerEvent<HTMLLIElement>) => {
    if (!hover.enter(event)) return
    rowOverRef.current = true
    onHoverStart?.()
    scheduleOpen()
  }

  const onRowLeave = (event: ReactPointerEvent<HTMLLIElement>) => {
    if (!hover.leave(event)) return
    rowOverRef.current = false
    scheduleClose()
  }

  const filePath = file.displayPath
  const slash = filePath.lastIndexOf('/')
  const dir = slash >= 0 ? filePath.slice(0, slash) : ''
  const name = slash >= 0 ? filePath.slice(slash + 1) : filePath
  const previewable = Boolean(file.patch)

  return (
    <li className="min-w-0" onPointerEnter={onRowEnter} onPointerLeave={onRowLeave}>
      <MorphPopover open={open} onOpenChange={handleOpenChange} className="w-full">
        <MorphPopoverTrigger>
          <Button
            variant="ghost"
            size="sm"
            // A full-width row must not scale on hover or press.
            whileHover={undefined}
            pressScale={1}
            className="h-8 w-full justify-start gap-2 rounded-none px-3 font-normal"
            // The row highlight must land on the row the pointer is on *now*:
            // beUI's Button carries `transition-colors`, and its 150ms fade is
            // what made the highlight trail a fast sweep (the diff pane already
            // switched instantly, so the two read as out of step). An inline
            // shorthand is used because the Tailwind utilities that could cancel
            // it sort before `transition-colors` and would lose to it.
            style={{ transition: 'none' }}
            onClick={() => {
              clickRef.current = true
            }}
            onFocus={() => {
              rowOverRef.current = true
              clearTimers()
              show()
            }}
            onBlur={() => {
              rowOverRef.current = false
              scheduleClose()
            }}
          >
            <span className="min-w-0 flex-1 truncate text-left text-sm">
              {dir ? <span className="text-muted-foreground/60">{dir}/</span> : null}
              <span className="text-foreground">{name}</span>
            </span>
            <LineStats added={file.added ?? 0} removed={file.removed ?? 0} />
          </Button>
        </MorphPopoverTrigger>
        {unmountNow ? null : (
          <MorphPopoverContent
            side={side}
            align="center"
            // Flush against the row: a gap here would put the row above under the
            // pointer while it travels up into the panel.
            sideOffset={0}
            radius={12}
            instant={instant}
          >
            <div
              style={{ width: panelWidth }}
              onPointerEnter={() => {
                panelOverRef.current = true
                clearTimers()
              }}
              onPointerLeave={() => {
                panelOverRef.current = false
                scheduleClose()
              }}
            >
              {previewable ? (
                <WrittenFileDiff file={file} />
              ) : (
                <p className="px-3 py-2 text-xs text-muted-foreground">{t('tool.noDiff')}</p>
              )}
            </div>
          </MorphPopoverContent>
        )}
      </MorphPopover>
    </li>
  )
}

/**
 * The turn's written files. Rows beyond `VISIBLE_FILE_LIMIT` fold behind a
 * toggle so one large turn can't push the conversation off screen.
 */
export const TurnWrittenFiles = memo(function TurnWrittenFiles({ files }: { files: WrittenFile[] }) {
  const { t } = useI18n()
  const [expanded, setExpanded] = useState(false)
  const visible = expanded ? files : files.slice(0, VISIBLE_FILE_LIMIT)

  /**
   * Shiki is the one part of the preview that cannot keep up with an instant
   * hand-over: its tokens land tens of ms after the panel mounts, repainting the
   * whole diff. So the diffs on screen are tokenized ahead of time — one per idle
   * slice, starting at the row the pointer just entered — and the panel then
   * mounts already highlighted.
   */
  const prefetchQueue = useRef<string[]>([])
  prefetchQueue.current = visible.flatMap((file) => {
    if (!file.patch) return []
    const code = previewCode(file.patch)
    // Only a diff the panel will actually highlight is worth tokenizing: over
    // the cap `WrittenFileDiff` renders plain, so warming it would be pure cost.
    return code.split('\n').length <= PREVIEW_HIGHLIGHT_MAX_LINES ? [code] : []
  })
  const prefetchKey = prefetchQueue.current.join('\u0000')
  const prefetch = useRef<{
    order: number[]
    index: number
    handle: number | null
    idle: boolean
    cancelled: boolean
  }>({
    order: [],
    index: 0,
    handle: null,
    idle: false,
    cancelled: false
  })

  const cancelPrefetch = useCallback(() => {
    const state = prefetch.current
    state.cancelled = true
    if (state.handle === null) return
    if (state.idle) window.cancelIdleCallback(state.handle)
    else window.clearTimeout(state.handle)
    state.handle = null
  }, [])

  const startPrefetch = useCallback(
    (from: number) => {
      const state = prefetch.current
      cancelPrefetch()
      const queue = prefetchQueue.current
      if (queue.length === 0) return
      state.cancelled = false
      // Outward from the hovered row: the row the pointer moves to next is its
      // neighbour, so those are the diffs worth having warm first.
      const start = Math.min(Math.max(from, 0), queue.length - 1)
      const order: number[] = []
      for (let step = 0; step < queue.length; step++) {
        if (step === 0) order.push(start)
        else {
          if (start + step < queue.length) order.push(start + step)
          if (start - step >= 0) order.push(start - step)
        }
      }
      state.order = order
      state.index = 0

      const step = () => {
        state.handle = null
        if (state.cancelled || state.index >= state.order.length) return
        const code = queue[state.order[state.index++]]
        void prefetchAgentCodeTokens(code, PREVIEW_LANGUAGE).finally(() => {
          if (state.cancelled) return
          // One diff per idle slice, and only in genuine idle time: a tokenize is
          // tens of ms of main-thread work, and a `timeout` here made the queue
          // run back to back — starving timers (a preview took ~700ms to close)
          // instead of warming anything.
          if (typeof window.requestIdleCallback === 'function') {
            state.idle = true
            state.handle = window.requestIdleCallback(step)
          } else {
            state.idle = false
            state.handle = window.setTimeout(step, 600)
          }
        })
      }
      step()
    },
    [cancelPrefetch]
  )

  useEffect(() => {
    startPrefetch(0)
    return cancelPrefetch
  }, [prefetchKey, startPrefetch, cancelPrefetch])

  const listRef = useRef<HTMLUListElement | null>(null)

  /**
   * Where the preview sits, resolved from the list each time one opens.
   *
   * The side answers one question — is there room below the list for a panel —
   * and the answer is the same for every row, so a sweep down the rows never
   * flips the panel from one side of the pointer to the other. The width is the
   * list's minus a corridor on each side (the strips the pointer travels along
   * to change rows while a panel is up).
   */
  const resolveLayout = useCallback(() => {
    const rect = listRef.current?.getBoundingClientRect()
    // The row's full width minus a strip on each side; the viewport is the only
    // other limit, so on a wide row the panel is just short of edge to edge.
    const width = Math.max(
      280,
      Math.min(
        (rect?.width ?? window.innerWidth) - PREVIEW_SIDE_MARGIN * 2,
        window.innerWidth - 24
      )
    )
    const side: 'top' | 'bottom' =
      rect && window.innerHeight - rect.bottom >= PREVIEW_MAX_HEIGHT + PREVIEW_FLIP_MARGIN
        ? 'bottom'
        : 'top'
    return { side, width }
  }, [])

  if (files.length === 0) return null
  const stats = sumWrittenFileStats(files)
  const hidden = Math.max(0, files.length - VISIBLE_FILE_LIMIT)

  return (
    <div className="w-full text-sm">
      {/* One frame for the whole list: the summary is its first (taller) row and
          the only divider, so the file rows below read as one set. */}
      {/* Frame radius matches the composer input (`rounded-2xl`), the surface a
          turn's answer sits in. */}
      <div className="overflow-hidden rounded-2xl border border-border/70">
        {/* Two lines: what changed, then the totals under it — with the turn's
            actions on the right (undo/review are placeholders for now). */}
        <div className="flex items-center gap-3 border-b border-border/60 px-3 py-2.5">
          <span
            aria-hidden="true"
            className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground"
          >
            <Diff className="size-5" />
          </span>
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate text-sm font-medium text-foreground">
              {t(files.length === 1 ? 'tool.filesChangedOne' : 'tool.filesChangedMany', {
                count: files.length
              })}
            </span>
            {stats ? <LineStats added={stats.added} removed={stats.removed} className="font-normal" /> : null}
          </span>
          <span className="flex shrink-0 items-center gap-1.5">
            {hidden > 0 ? (
              <Button
                variant="ghost"
                size="sm"
                aria-expanded={expanded}
                onClick={() => setExpanded((value) => !value)}
              >
                {expanded ? t('tool.filesShowLess') : t('tool.filesShowMore')}
                <ChevronDown
                  aria-hidden="true"
                  className={cn('size-3.5 transition-transform', expanded && 'rotate-180')}
                />
              </Button>
            ) : null}
            <Button variant="ghost" size="sm">
              {t('tool.filesUndo')}
              <Undo2 aria-hidden="true" className="size-3.5" />
            </Button>
            <Button variant="ghost" size="sm">
              {t('tool.filesReview')}
            </Button>
          </span>
        </div>

        <ul
          ref={listRef}
          // `data-plain-list` keeps the bubble's markdown list styling (bullets,
          // 20px indent) off this list — see the local patch in message-bubble.tsx.
          data-plain-list
        >
          {visible.map((file, index) => (
            <WrittenFileRow
              key={file.filePath}
              file={file}
              resolveLayout={resolveLayout}
              onHoverStart={() => startPrefetch(index)}
            />
          ))}
        </ul>
      </div>
    </div>
  )
})
