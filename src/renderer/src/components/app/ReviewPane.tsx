import { memo, useEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from 'react'
import { ChevronLeft, ChevronRight, Diff } from '@/lib/icons'
import { Button } from '@/components/motion/button'
import { Tooltip } from '@/components/motion/tooltip'
import { useNearViewport } from '@/lib/hooks/use-near-viewport'
import {
  extractReviewTurns,
  sumWrittenFileStats,
  type WrittenFile
} from '@/lib/turn-written-files'
import type { PiStore } from '@/state/pi-store'
import { useI18n } from '@/i18n'
import { ReviewCollapseButton, ReviewFileHeader, ReviewDiffBody } from './ReviewDiff'

/** Diff row height, matching `FileDiff`'s own 20px line box. */
const DIFF_LINE_PX = 20
/** Placeholder cap: a pathological diff must not create a huge scroll range. */
const PLACEHOLDER_MAX_PX = 16_000
const PLACEHOLDER_MIN_PX = 64

/**
 * Height reserved for a diff body that has not mounted yet. Changed lines plus
 * the hunk headers and context around them (~1.35×) is close enough that the
 * scrollbar barely moves when the real body replaces it.
 */
function placeholderHeight(file: WrittenFile): number {
  const changed = Math.max(0, (file.added ?? 0) + (file.removed ?? 0))
  const lines = Math.max(3, Math.ceil(changed * 1.35) + 1)
  return Math.min(PLACEHOLDER_MAX_PX, Math.max(PLACEHOLDER_MIN_PX, lines * DIFF_LINE_PX))
}

interface ReviewPaneProps {
  store: PiStore
  /** Turn the pane should select — set when the transcript's Review action
   * opens the tab, so it lands on the turn the user asked about. */
  focusTurnId: number | null
}

/**
 * Review tab: every turn that changed files, one turn at a time, with each
 * file's diff under a sticky header.
 *
 * Data comes from the same derivation the transcript's changed-files card uses
 * (`extractReviewTurns`), so a turn that lists 3 files there lists exactly 3
 * here — and the turn identity is its first assistant message, which is what
 * that card's Review action hands over.
 *
 * Deliberately only review: no source/git toggle, no editing. Diffs mount as
 * they scroll near the viewport, so a long session's worth of changes opens
 * instantly and only pays for what is being looked at.
 */
export const ReviewPane = memo(function ReviewPane({ store, focusTurnId }: ReviewPaneProps) {
  const { t } = useI18n()
  // Select the message log itself, not the whole state: its identity only
  // changes at message boundaries, so an answer streaming in the background
  // never re-renders (or re-derives) the review.
  const messages = useSyncExternalStore(store.subscribe, () => store.getState().messages)
  const cwd = useSyncExternalStore(store.subscribe, () => store.getState().cwd)
  /** The plan-approval opening prompt the transcript hides: its turn keeps its
   *  files here, but the switcher labels it by number instead of quoting the
   *  protocol message. */
  const approvalOpeningEntryId = useSyncExternalStore(store.subscribe, () => {
    const plan = store.getState().plan
    return plan?.approval?.status === 'started' ? plan.approval.executionEntryId ?? null : null
  })
  const turns = useMemo(
    () => extractReviewTurns(messages, cwd, approvalOpeningEntryId),
    [messages, cwd, approvalOpeningEntryId]
  )

  const [selectedId, setSelectedId] = useState<number | null>(focusTurnId)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const bodyRef = useRef<HTMLDivElement | null>(null)

  // Re-anchor whenever the transcript asks for a turn (a Review click while the
  // tab is already open), and whenever the list itself is rebuilt.
  useEffect(() => {
    if (focusTurnId !== null) setSelectedId(focusTurnId)
  }, [focusTurnId, turns])

  // A selection that no longer exists (session switch, rewind) falls back to the
  // newest turn rather than showing nothing.
  const index = useMemo(() => {
    const found = turns.findIndex((turn) => turn.id === selectedId)
    return found >= 0 ? found : turns.length - 1
  }, [turns, selectedId])
  const turn = index >= 0 ? turns[index] : null
  const turnId = turn?.id ?? null

  // Switching turns starts at the top of the new review.
  useEffect(() => {
    bodyRef.current?.scrollTo({ top: 0 })
  }, [turnId])

  if (!turn) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
        <Diff aria-hidden="true" className="size-5 text-muted-foreground/70" />
        <p className="text-sm font-medium text-foreground">{t('review.emptyTitle')}</p>
        <p className="text-xs leading-ui text-muted-foreground">{t('review.emptyBody')}</p>
      </div>
    )
  }

  const stats = sumWrittenFileStats(turn.files)
  const collapseKey = (file: WrittenFile) => `${turn.id}:${file.filePath}`
  const allCollapsed = turn.files.every((file) => collapsed[collapseKey(file)])

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Turn switcher: which turn is being reviewed, its totals, and one
          collapse-all for its files. */}
      <div className="flex h-11 shrink-0 items-center gap-1 border-b border-border px-1.5">
        <Tooltip content={t('review.prevTurn')}>
          <Button
            variant="ghost"
            size="icon"
            disabled={index <= 0}
            aria-label={t('review.prevTurn')}
            onClick={() => setSelectedId(turns[index - 1].id)}
          >
            <ChevronLeft aria-hidden="true" className="size-4" />
          </Button>
        </Tooltip>
        <span className="min-w-0 flex-1 truncate px-0.5 text-xs text-foreground">
          <span className="text-muted-foreground">
            {t('review.turnCounter', { n: index + 1, total: turns.length })}
          </span>
          {turn.prompt ? <span className="text-muted-foreground/50"> · </span> : null}
          {turn.prompt ?? t('review.noPrompt', { n: index + 1 })}
        </span>
        {stats ? (
          <span className="flex shrink-0 items-center gap-1.5 font-mono text-xs tabular-nums">
            {stats.added ? (
              <span className="text-emerald-600 dark:text-emerald-400">+{stats.added}</span>
            ) : null}
            {stats.removed ? (
              <span className="text-rose-600 dark:text-rose-400">−{stats.removed}</span>
            ) : null}
          </span>
        ) : null}
        <Tooltip content={t('review.nextTurn')}>
          <Button
            variant="ghost"
            size="icon"
            disabled={index >= turns.length - 1}
            aria-label={t('review.nextTurn')}
            onClick={() => setSelectedId(turns[index + 1].id)}
          >
            <ChevronRight aria-hidden="true" className="size-4" />
          </Button>
        </Tooltip>
        <ReviewCollapseButton allCollapsed={allCollapsed} onClick={() => setCollapsed(previous => {
          const next = { ...previous }
          for (const file of turn.files) next[collapseKey(file)] = !allCollapsed
          return next
        })} />
      </div>

      {/* One scroll container for the whole review, vertical only: the file
          headers stick to its top so the current path stays visible until the
          next file pushes it off. Horizontal scrolling belongs to each diff
          body (a wide row scrolls inside its own frame) — never here, or the
          sticky headers would slide sideways with it. */}
      <div
        ref={bodyRef}
        className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain"
      >
        {turn.files.map((file) => (
          <ReviewFile
            key={`${turn.id}:${file.filePath}`}
            file={file}
            scrollRootRef={bodyRef}
            collapsed={Boolean(collapsed[collapseKey(file)])}
            onToggle={() =>
              setCollapsed((previous) => ({ ...previous, [collapseKey(file)]: !previous[collapseKey(file)] }))
            }
          />
        ))}
      </div>
    </div>
  )
})

/** One file: sticky header, then its diff (mounted once it nears the viewport). */
function ReviewFile({
  file,
  collapsed,
  onToggle,
  scrollRootRef
}: {
  file: WrittenFile
  collapsed: boolean
  onToggle: () => void
  scrollRootRef: RefObject<HTMLElement | null>
}) {
  const { t } = useI18n()
  const { ref, near } = useNearViewport<HTMLElement>(scrollRootRef)
  return (
    <section ref={ref}>
      <ReviewFileHeader displayPath={file.displayPath} fullPath={file.filePath} collapsed={collapsed} onToggle={onToggle} added={file.added} removed={file.removed} />

      {collapsed ? null : file.patch ? (
        near ? (
          <ReviewDiffBody patch={file.patch} displayPath={file.displayPath} scrollRootRef={scrollRootRef} />
        ) : (
          <div aria-hidden="true" style={{ height: placeholderHeight(file) }} />
        )
      ) : (
        <p className="px-3 py-2 text-xs text-muted-foreground">{t('tool.noDiff')}</p>
      )}
    </section>
  )
}
