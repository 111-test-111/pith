import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { ArrowDownWideNarrow, ArrowUpNarrowWide, Chat01, ChevronLeft, ChevronRight, Folder, Info, LoaderCircle, MessageSquare, Search, SearchX, X } from '@/lib/icons'
import { Input } from '@/components/motion/input'
import { Button } from '@/components/motion/button'
import { AgentDisclosure } from '@/components/agents/agent-disclosure'
import { CenterMorphModal, CenterMorphModalContent, CenterMorphModalTrigger } from '@/components/motion/center-morph-modal'
import { Checkbox } from '@/components/motion/checkbox'
import { Tooltip } from '@/components/motion/tooltip'
import { LabelTooltip } from './LabelTooltip'
import { useI18n } from '@/i18n'
import { basename } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useOverflowFade } from '@/lib/hooks/use-overflow-fade'
import type { SearchTextDTO, SessionSearchHitDTO, SessionSearchResultDTO, SessionSearchSort, SessionSummaryDTO } from '../../../../shared/types'

const SOURCE_LABELS = {
  user: 'sessionSearch.sourceUser', assistant: 'sessionSearch.sourceAssistant',
  summary: 'sessionSearch.sourceSummary', custom: 'sessionSearch.sourceCustom',
  tool: 'sessionSearch.sourceTool', thinking: 'sessionSearch.sourceThinking', attachment: 'sessionSearch.sourceAttachment'
} as const

function Highlight({ value }: { value: SearchTextDTO }) {
  const parts: ReactNode[] = []
  let end = 0
  for (const [start, next] of value.ranges) {
    parts.push(value.text.slice(end, start))
    parts.push(<mark key={start} className="rounded-sm bg-primary/15 text-foreground">{value.text.slice(start, next)}</mark>)
    end = next
  }
  parts.push(value.text.slice(end))
  return <>{parts}</>
}

function SessionTitle({ value }: { value: SearchTextDTO }) {
  const { t } = useI18n()
  const { viewportRef, textRef } = useOverflowFade()
  return (
    <span ref={viewportRef} data-search-title className="min-w-0 flex-1 overflow-hidden whitespace-nowrap text-sm text-foreground data-[overflow]:[mask-image:linear-gradient(to_right,black_calc(100%_-_1.5rem),transparent)]">
      <span ref={textRef} className="inline-block w-max align-top">{value.text ? <Highlight value={value} /> : t('workspace.newChat')}</span>
    </span>
  )
}

function SearchFolderGroup({ cwd, projectless, open, onToggle, count, children }: {
  cwd: string
  projectless: boolean
  open: boolean
  onToggle: () => void
  count?: number
  children: ReactNode
}) {
  const { t } = useI18n()
  const contentId = useId()
  const name = projectless ? t('workspace.projectlessSessions') : basename(cwd)
  return (
    <section aria-label={projectless ? name : cwd} data-search-folder={projectless ? 'projectless' : cwd}>
      <h3 className="sticky top-0 z-10 bg-background">
        <Button variant="ghost" onClick={onToggle}
          aria-expanded={open} aria-controls={contentId}
          aria-label={t(open ? 'sessionSearch.collapseGroup' : 'sessionSearch.expandGroup', { name: projectless ? name : cwd })}
          className="h-10 w-full min-w-0 justify-start gap-2 rounded-lg px-2 text-left focus-visible:ring-inset">
          <ChevronRight aria-hidden="true" className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none', open && 'rotate-90')} />
          {projectless ? <MessageSquare aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" /> : <Folder aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />}
          <span className="max-w-[45%] shrink-0 truncate text-base font-semibold text-foreground">{name}</span>
          <span className="min-w-0 truncate text-caption font-normal text-muted-foreground/70">{projectless ? null : cwd}</span>
          {count !== undefined ? <span className="ml-auto shrink-0 text-caption font-normal tabular-nums text-muted-foreground/70">{count}</span> : null}
        </Button>
      </h3>
      <AgentDisclosure id={contentId} open={open} className={cn('ml-8 border-l border-border/60 pl-3', !open && 'hidden')}>
        {children}
      </AgentDisclosure>
    </section>
  )
}

/** Keep whole-folder ordering consistent with the index, including on pages
 * beginning halfway through a folder. Full cwd is the identity, not basename. */
function groupHits(hits: SessionSearchHitDTO[]) {
  const groups = new Map<string, SessionSearchHitDTO[]>()
  for (const hit of hits) {
    const group = groups.get(hit.cwd) ?? []
    group.push(hit)
    groups.set(hit.cwd, group)
  }
  return [...groups].map(([cwd, items]) => ({ cwd, items, projectless: !!items[0]?.projectless }))
}

export function SessionSearchTrigger() {
  const { t } = useI18n()
  return (
    <Tooltip content={t('sessionSearch.label')}>
      {/* The trigger clones its own child, so the Tooltip has to sit outside it:
          `aria-describedby` lands on the trigger rather than the button, whose
          own `aria-label` already names it. */}
      <CenterMorphModalTrigger>
        <Button variant="ghost" size="icon" aria-label={t('sessionSearch.label')}>
          <Search aria-hidden="true" className="size-4" />
        </Button>
      </CenterMorphModalTrigger>
    </Tooltip>
  )
}

/** Mounted around the workspace, outside the responsive sidebar which swaps
 * trees at its mobile breakpoint. beUI owns the portal/focus/animation; only
 * the trigger lives in the sidebar. Stable children keep typing off the chat. */
export function SessionSearch({ sessions, activePath, runningPaths, onOpen, open: controlledOpen, onOpenChange, children }: {
  sessions: SessionSummaryDTO[]
  activePath: string | null
  runningPaths: ReadonlySet<string>
  onOpen: (path: string, cwd: string) => Promise<void>
  /** Controlled open state — the workspace holds it so the shortcut
   *  dispatcher owns the ⌘⇧F toggle; uncontrolled keeps the old behavior. */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  children: ReactNode
}) {
  const { t, locale } = useI18n()
  const descriptionId = useId()
  const [internalOpen, setInternalOpen] = useState(false)
  const isOpen = controlledOpen ?? internalOpen
  const [query, setQuery] = useState('')
  // The search runs on this throttled copy of the trimmed query: while typing
  // continues it commits on a fixed cadence, so the panel refreshes once per
  // interval instead of on every keystroke.
  const [committedQuery, setCommittedQuery] = useState('')
  // local patch (pi-app): the details control reads as an EXCLUSION and is on by
  // default, so the default search behaviour is unchanged — tools, attachments
  // and thinking are left out unless the user opts them in by unchecking it.
  const [excludeDetails, setExcludeDetails] = useState(true)
  /** The switch's own track carries this id; its label sits before it. */
  const detailsCheckboxId = useId()
  const [sort, setSort] = useState<SessionSearchSort>('newest')
  const [offset, setOffset] = useState(0)
  const [response, setResponse] = useState<{ key: string; value: SessionSearchResultDTO } | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)
  const [openingPath, setOpeningPath] = useState<string | null>(null)
  const [composing, setComposing] = useState(false)
  // Folder identity and collapse state survive query, sorting, polling and
  // pagination changes. No session in a collapsed folder remains interactive.
  const [collapsedFolders, setCollapsedFolders] = useState<ReadonlySet<string>>(() => new Set())
  const openingAttempt = useRef(0)
  const input = useRef<HTMLInputElement>(null)
  const results = useRef<HTMLDivElement>(null)
  /** A scheduled query commit. It deliberately survives further keystrokes,
   * so continuous typing refreshes on a cadence instead of per change. */
  const pendingCommit = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  /** The latest trimmed query, read by the scheduled commit when it fires. */
  const latestQuery = useRef('')
  const trimmed = query.trim()
  const active = Boolean(trimmed)
  const key = JSON.stringify([committedQuery, offset, sort, excludeDetails])
  const value = response?.key === key ? response.value : null
  const dateFormat = useMemo(() => new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }), [locale])
  // The first appearance of a folder in this global activity sort is its
  // newest/oldest session, so groupHits preserves the index's folder ordering.
  // Build the complete title-only list only while it is actually visible.
  const allSessions = useMemo<SessionSearchHitDTO[]>(() => !isOpen || active ? [] : [...sessions]
    .sort((a, b) => (sort === 'oldest' ? a.modified.localeCompare(b.modified) : b.modified.localeCompare(a.modified)) || a.cwd.localeCompare(b.cwd) || a.path.localeCompare(b.path))
    .map((session) => ({ ...session, title: { text: session.label ?? '', ranges: [] }, snippet: null })), [sessions, sort, isOpen, active])
  const hits = active ? value?.hits ?? [] : allSessions
  const groups = useMemo(() => groupHits(hits), [hits])
  const firstVisibleHit = hits.find((hit) => !collapsedFolders.has(hit.cwd))
  const toggleFolder = (cwd: string) => setCollapsedFolders((previous) => {
    const next = new Set(previous)
    if (next.has(cwd)) next.delete(cwd)
    else next.add(cwd)
    return next
  })

  // Stable identity is important: beUI's focus effect depends on its context.
  // Changing this callback on a keystroke would keep refocusing the input.
  const changeOpen = useCallback((next: boolean) => {
    setInternalOpen(next)
    onOpenChange?.(next)
    setComposing(false)
    if (!next) {
      ++openingAttempt.current
      setOpeningPath(null)
    }
  }, [onOpenChange])

  // Typing schedules ONE commit 200ms ahead; further keystrokes only feed it
  // (via latestQuery) without pushing it back, so continuous typing refreshes
  // the results every 200ms instead of on every change. Each commit restarts
  // from the first page of a fresh scroll.
  useEffect(() => {
    latestQuery.current = trimmed
    const cancelPending = () => {
      if (pendingCommit.current !== undefined) {
        clearTimeout(pendingCommit.current)
        pendingCommit.current = undefined
      }
    }
    // A scheduled commit only makes sense while the modal is open, the IME is
    // idle and the input still differs from the committed query.
    if (!isOpen || composing || trimmed === committedQuery) {
      cancelPending()
      return
    }
    // Clearing the input commits at once — there is no search to wait for.
    if (!trimmed) {
      cancelPending()
      setCommittedQuery('')
      setOffset(0)
      results.current?.scrollTo(0, 0)
      return
    }
    if (pendingCommit.current !== undefined) return
    pendingCommit.current = setTimeout(() => {
      pendingCommit.current = undefined
      setCommittedQuery(latestQuery.current)
      setOffset(0)
      results.current?.scrollTo(0, 0)
    }, 200)
  }, [trimmed, committedQuery, composing, isOpen])

  // Unmounting the panel drops a scheduled commit.
  useEffect(() => () => {
    if (pendingCommit.current !== undefined) clearTimeout(pendingCommit.current)
  }, [])

  useEffect(() => {
    if (!committedQuery || !isOpen) return
    let cancelled = false
    let reportedFailure = false
    let timer: ReturnType<typeof setTimeout> | undefined
    setError(false)
    setLoading(true)
    const search = async () => {
      try {
        const next = await window.pi.searchSessions({ query: committedQuery, sort, offset, includeDetails: !excludeDetails })
        if (cancelled) return
        if (offset > 0 && offset >= next.total) {
          setOffset(Math.max(0, Math.floor((next.total - 1) / 40) * 40))
          return
        }
        setResponse({ key, value: next })
        setError(false)
        reportedFailure = false
      } catch (cause) {
        if (!cancelled) {
          setError(true)
          // Keep diagnostics out of the panel, retain any successful results,
          // and retry below. Log once per failure streak, not on every poll.
          if (!reportedFailure) console.warn('[session-search] Search failed', cause)
          reportedFailure = true
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
          // Closing the modal cancels polling and drops in-flight responses.
          timer = setTimeout(() => { void search() }, 2500)
        }
      }
    }
    void search()
    return () => { cancelled = true; clearTimeout(timer) }
  }, [committedQuery, offset, sort, excludeDetails, key, sessions, isOpen])

  const changeQuery = (next: string) => {
    setQuery(next)
  }
  const openSession = async (path: string, cwd: string) => {
    if (openingPath) return
    const attempt = ++openingAttempt.current
    setOpeningPath(path)
    try {
      await onOpen(path, cwd)
      if (attempt === openingAttempt.current) changeOpen(false)
    } catch (cause) {
      if (attempt === openingAttempt.current) console.warn('[session-search] Could not open session', cause)
    } finally {
      if (attempt === openingAttempt.current) setOpeningPath(null)
    }
  }
  const busy = active && (composing || loading || (!value && !error))

  return (
    <CenterMorphModal open={isOpen} onOpenChange={changeOpen}>
      {children}
      <CenterMorphModalContent
        ariaLabel={t('sessionSearch.label')}
        ariaDescribedBy={descriptionId}
        closeButtonLabel={t('sessionSearch.close')}
        shortcutPassthrough="sessionSearch"
        className="max-w-3xl"
        backdropClassName="bg-background/40 backdrop-blur-sm"
      >
        <div className="flex max-h-[min(760px,calc(100dvh-96px))] min-h-[min(320px,calc(100dvh-96px))] flex-col" onKeyDown={(event) => {
          // The IME consumes Escape before beUI's window-level dismiss handler.
          if (event.key === 'Escape' && (event.nativeEvent.isComposing || composing)) event.stopPropagation()
        }}>
          <div className="flex h-14 shrink-0 items-center gap-2 px-5 pr-16">
            <Search aria-hidden="true" className="size-4 text-primary" />
            <h2 className="text-sm font-semibold text-foreground">{t('sessionSearch.label')}</h2>
            <p id={descriptionId} className="sr-only">{t('sessionSearch.description')}</p>
          </div>
          <div className="shrink-0 px-3 pb-1">
            <div className="p-1">
              <Input ref={input} value={query} onChange={changeQuery} maxLength={512} autoFocus autoComplete="off" spellCheck={false}
                aria-label={t('sessionSearch.label')} placeholder={t('sessionSearch.placeholder')}
                classNames={{ rightIcon: 'pr-2' }}
                leftIcon={<Search aria-hidden="true" />}
                rightIcon={query ? (
                  // The vendored input pins its right slot to a field-height
                  // square ([&_button]:size-11) so a bare icon keeps a 44px hit
                  // target. Inline size is the one override that beats that
                  // descendant selector, so the ghost hover box stays a small
                  // rounded button instead of filling the pill.
                  <Button variant="ghost" size="icon" style={{ width: 28, height: 28 }} aria-label={t('sessionSearch.clear')} onClick={() => {
                    changeQuery('')
                    input.current?.focus()
                  }}><X aria-hidden="true" className="size-3.5" /></Button>
                ) : undefined}
                onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing || composing) return
                  // Arrow keys are deliberately not wired to the result list:
                  // rows are mouse/touch targets, and the only keyboard shortcut
                  // the footer advertises is Esc. Enter still opens the top hit.
                  if (event.key === 'Enter' && firstVisibleHit && !busy) {
                    event.preventDefault()
                    void openSession(firstVisibleHit.path, firstVisibleHit.cwd)
                  }
                }}
              />
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-border px-4 pb-2">
            {/* Info, its text, then the mark — three equal gaps. The text is
                its own label (not the control's `label` slot) so it can sit
                between the two controls; the checkbox's `id` is what keeps the
                click-to-toggle association. The icon button's `-mr` cancels
                its own 7px inset so the gap the eye sees (glyph → text) equals
                the layout gap (text → box). */}
            <div className="flex items-center gap-2">
              {/* The vendored tooltip is whitespace-nowrap, and app classes
                  cannot override it (Tailwind emits whitespace-nowrap after
                  whitespace-normal), so the wrapping declaration lives on the
                  content itself — inheritance does what specificity won't. */}
              <Tooltip side="bottom" className="px-3 py-2 text-xs" content={
                <span className="block w-72 whitespace-normal text-left leading-relaxed">{t('sessionSearch.hint')}</span>
              }>
                <Button variant="ghost" size="icon" className="size-7 -mr-1.75" aria-label={t('sessionSearch.help')}>
                  <Info aria-hidden="true" className="size-3.5" />
                </Button>
              </Tooltip>
              <label htmlFor={detailsCheckboxId} className="cursor-pointer text-xs text-muted-foreground">
                {t('sessionSearch.excludeDetails')}
              </label>
              <Checkbox id={detailsCheckboxId} checked={excludeDetails} aria-label={t('sessionSearch.excludeDetails')}
                onCheckedChange={(checked) => {
                  setExcludeDetails(checked)
                  setOffset(0)
                  results.current?.scrollTo(0, 0)
                }} />
            </div>
            <LabelTooltip content={t('sessionSearch.sortHint')} wrap wrapperClassName="shrink-0">
              <Button variant="ghost" size="sm" className="h-7 shrink-0 rounded-lg px-2 text-xs font-normal"
                aria-label={t('sessionSearch.sortLabel')}
                onClick={() => {
                  setSort((current) => (current === 'newest' ? 'oldest' : 'newest'))
                  setOffset(0)
                  results.current?.scrollTo(0, 0)
                }}>
                {sort === 'newest'
                  ? <ArrowDownWideNarrow aria-hidden="true" className="size-3.5" />
                  : <ArrowUpNarrowWide aria-hidden="true" className="size-3.5" />}
                {t(sort === 'newest' ? 'sessionSearch.newest' : 'sessionSearch.oldest')}
              </Button>
            </LabelTooltip>
          </div>
          {/* `scroll-pt-10` clears the sticky group header, so scrolling a row
              into view (Tab focus, or a click) parks it below the header
              instead of underneath, where its top would be hidden. */}
          <div ref={results} role="region" className="min-h-0 flex-1 overflow-y-auto overscroll-contain scroll-pt-10 px-2 pb-2" aria-label={t('sessionSearch.results')} aria-busy={busy}>
            {/* A failed request must not be presented as a successful zero-hit search. */}
            {!hits.length && !(active && error) ? (
              <div className="flex h-full flex-col items-center justify-center gap-3 px-6 py-6 text-center">
                <div className="grid size-12 shrink-0 place-items-center rounded-2xl bg-muted/60 text-muted-foreground">
                  {busy ? <LoaderCircle aria-hidden="true" className="size-5 animate-spin" />
                    : active ? <SearchX aria-hidden="true" className="size-5" /> : <MessageSquare aria-hidden="true" className="size-5" />}
                </div>
                <div>
                  <p className="text-sm font-medium text-foreground">{t(busy ? 'sessionSearch.searching' : active ? 'sessionSearch.emptyTitle' : 'sessionSearch.startTitle')}</p>
                  <p className="mt-1 max-w-sm text-xs leading-relaxed text-muted-foreground">{t(busy ? 'sessionSearch.loadingHint' : active ? 'sessionSearch.empty' : 'sessionSearch.startHint')}</p>
                </div>
              </div>
            ) : null}
            {groups.map(({ cwd, items, projectless }) => (
              <SearchFolderGroup key={cwd} cwd={cwd} projectless={projectless} open={!collapsedFolders.has(cwd)}
                onToggle={() => toggleFolder(cwd)} count={active ? undefined : items.length}>
                {!collapsedFolders.has(cwd) ? items.map((hit) => {
                  const current = activePath === hit.path
                  const pending = openingPath === hit.path
                  const date = new Date(hit.modified)
                  // The focus ring is inset: the first row of each group is flush
                  // under the sticky, opaque group header, which paints over an
                  // outside ring's top edge (`ring-inset` keeps the ring on the
                  // row's own surface, fully visible).
                  return (
                    <Button key={hit.path} variant="ghost" 
                      aria-current={current ? 'page' : undefined} disabled={Boolean(openingPath)}
                      onClick={() => { void openSession(hit.path, hit.cwd) }}
                      className={cn('group h-auto min-h-9 w-full items-start justify-start gap-2 rounded-lg px-2 py-2 text-left font-normal focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset [content-visibility:auto] [contain-intrinsic-size:auto_20px]', active && '[contain-intrinsic-size:auto_62px]', current && 'bg-primary/5')}
                    >
                      <span className={cn('mt-0.5 grid size-4 shrink-0 place-items-center text-muted-foreground/70', current && 'text-primary')}>
                        {pending || runningPaths.has(hit.path) ? <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" /> : <Chat01 aria-hidden="true" className="size-3.5" />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          <SessionTitle value={hit.title} />
                          {current ? <span className="shrink-0 text-micro font-medium text-primary">{t('sessionSearch.current')}</span> : null}
                          {active && Number.isFinite(date.getTime()) ? <time className="hidden shrink-0 text-caption tabular-nums text-muted-foreground/70 sm:block" dateTime={hit.modified}>{dateFormat.format(date)}</time> : null}
                        </span>
                        {active && hit.snippet ? <span className="mt-0.5 line-clamp-2 break-words text-xs leading-ui text-muted-foreground [overflow-wrap:anywhere]">{hit.snippetSource ? <span className="mr-1.5 text-micro font-medium text-muted-foreground/70">{t(SOURCE_LABELS[hit.snippetSource])}{hit.snippetToolName ? ` · ${hit.snippetToolName}` : ''}</span> : null}<Highlight value={hit.snippet} /></span> : null}
                      </span>
                    </Button>
                  )
                }) : null}
              </SearchFolderGroup>
            ))}
          </div>
          <div className="flex min-h-9 shrink-0 items-center justify-between gap-3 border-t border-border bg-muted/20 px-4 py-1">
            <div role="status" aria-live="polite" className="flex items-center gap-2 text-caption text-muted-foreground">
              {busy ? <><LoaderCircle aria-hidden="true" className="size-3 animate-spin" />{t('sessionSearch.searching')}</>
                : !active ? t('sessionSearch.total', { count: sessions.length })
                  : !error && value ? t('sessionSearch.count', { count: value.total }) : null}
            </div>
            {active && value && value.total > 40 ? (
              <div className="flex items-center gap-1">
                <span className="mr-1 text-caption tabular-nums text-muted-foreground">{t('sessionSearch.page', { start: offset + 1, end: offset + value.hits.length, total: value.total })}</span>
                <Button variant="ghost" size="icon" className="size-7" aria-label={t('sessionSearch.previous')} disabled={offset === 0 || busy}
                  onClick={() => { setOffset((n) => Math.max(0, n - 40)); results.current?.scrollTo(0, 0) }}><ChevronLeft aria-hidden="true" className="size-4" /></Button>
                <Button variant="ghost" size="icon" className="size-7" aria-label={t('sessionSearch.next')} disabled={offset + value.hits.length >= value.total || busy}
                  onClick={() => { setOffset((n) => n + 40); results.current?.scrollTo(0, 0) }}><ChevronRight aria-hidden="true" className="size-4" /></Button>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-muted-foreground">
                <span><kbd className="mr-1 font-sans text-muted-foreground/70">{t('sessionSearch.escapeKey')}</kbd>{t('sessionSearch.close')}</span>
              </div>
            )}
          </div>
        </div>
      </CenterMorphModalContent>
    </CenterMorphModal>
  )
}
