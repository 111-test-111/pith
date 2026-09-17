import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { JSX } from 'react'
import { useTheme } from 'next-themes'
import { Bot, Globe, Plus, X } from '@/lib/icons'
import { Button } from '@/components/motion/button'
import { Tabs, TabsList, TabsTrigger } from '@/components/motion/tabs'
import { Tooltip } from '@/components/motion/tooltip'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import { HUMAN_OWNER, buildMarkerUrl, parseMarkerUrl } from '../../../../shared/browser.ts'
import { readOpenBrowserPages, snapshotOpenPages, writeOpenBrowserPages } from '@/lib/browser/session'
import { getBrowserZoom, nextBrowserZoom, setBrowserZoom } from '@/lib/browser/zoom'
import type { BrowserPanePage, BrowserStore } from '@/lib/browser/store'
import { BrowserPageView, isEditableTarget, type BrowserNavPatch, type LocalNavInfo } from './BrowserPageView'
import { LabelTooltip } from './LabelTooltip'
import { MiddleEllipsis } from './MiddleEllipsis'

/** Status poll cadence (pi-web BrowserTab parity). pendingCreates are enqueued
 *  WITHOUT a browser:state push, so this poll is what materializes pages the
 *  service is waiting on (agent page creation, the + button's createPage):
 *  rendering the pending row mounts its marker webview, which completes the
 *  registration. getStatus also kicks a best-effort reconcile each tick. */
const BROWSER_POLL_MS = 2_500

/** Display url of a page row: localNav truth first, server meta as fallback;
 *  markers (the hosting convention, not a user-facing location) read as
 *  about:blank. */
const displayUrlOf = (page: Pick<BrowserPanePage, 'url'>, nav?: LocalNavInfo): string => {
  const raw = nav?.url || page.url
  return parseMarkerUrl(raw) ? 'about:blank' : raw
}

/** Fold one webview event patch into the localNav map (pure; returns the same
 *  reference when nothing changed so setLocalNav skips the render). */
function applyNavPatch(
  prev: Record<string, LocalNavInfo>,
  id: string,
  patch: BrowserNavPatch
): Record<string, LocalNavInfo> {
  const current = prev[id]
  const next: LocalNavInfo = {
    url: patch.url ?? current?.url ?? '',
    title: patch.title ?? current?.title ?? '',
    favicon: patch.favicon === undefined ? current?.favicon : (patch.favicon ?? undefined)
  }
  if (
    current &&
    current.url === next.url &&
    current.title === next.title &&
    current.favicon === next.favicon
  ) return prev
  return { ...prev, [id]: next }
}

/**
 * The embedded browser pane: a page strip (beUI segment tabs) over one
 * always-mounted webview per page, with the consent gate in front. Data flows
 * in through the workspace-owned `BrowserStore` (`browser:state` pushes + the
 * poll below); display truth for titles/URLs/favicons is this pane's own
 * `localNav` map, fed by webview events (server meta is only the fallback).
 *
 * `active` (threaded by SidebarPanel's keep-alive layer) is true only while
 * this pane's rail tab is the one on screen: the pane-wide ⌘±/0 zoom
 * shortcuts register only then, so the hidden keep-alive layer never
 * consumes them.
 */
export function BrowserPane({
  store,
  onEmpty,
  active
}: {
  store: BrowserStore
  onEmpty: () => void
  active: boolean
}): JSX.Element {
  const { t } = useI18n()
  const state = useSyncExternalStore(store.subscribe, store.getState)
  const status = state.status
  const [selectedPageId, setSelectedPageId] = useState<string | null>(null)
  /** Pages with a close round-trip in flight: their rows (and webviews) go
   *  away immediately instead of waiting for the next status push. */
  const [closedIds, setClosedIds] = useState<ReadonlySet<string>>(() => new Set())
  /** UI-side nav truth per page id (webview events; server meta falls back). */
  const [localNav, setLocalNav] = useState<Record<string, LocalNavInfo>>({})
  /** Set while our createPage round trip is in flight: the first fresh
   *  pendingCreate row that shows up is ours to select. */
  const awaitingCreateRef = useRef(false)
  // ---- Task 8: first-status latch / open-pages restore / empty transition ----
  // Status snapshot that predates THIS mount: the workspace-owned store keeps
  // its last value across a rail collapse (which unmounts this pane and kills
  // its webviews). The latch, the empty transition and the snapshot write
  // consume only statuses that arrived after the mount — a stale snapshot
  // reading as non-empty must never suppress a restore.
  const staleStatusRef = useRef(status)
  /** First-status latch: fired (or deliberately skipped) once per mount. */
  const autoFilledRef = useRef(false)
  /** The latch's createPage round trips are filling an empty model: the
   *  emptiness they own must not trip onEmpty mid-restore. */
  const autoFillInFlightRef = useRef(false)
  /** A post-mount status has shown a non-empty merged model. */
  const sawPagesRef = useRef(false)
  /** onEmpty at most once per mount (closePage and the transition share it). */
  const emptyFiredRef = useRef(false)

  const { resolvedTheme } = useTheme()
  // Guest pages follow the app theme: main injects Emulation.setEmulatedMedia
  // per registered page and replays it on every registration, so this one
  // call — on mount and on each resolvedTheme change — covers every current
  // and future guest. Errors are swallowed across the bridge.
  useEffect(() => {
    void window.pi.browserTheme(resolvedTheme === 'dark' ? 'dark' : 'light')
  }, [resolvedTheme])

  // ⌘= (also ⌘+) / ⌘- / ⌘0 page zoom, Chromium parity. Registered ONLY while
  // this pane's rail tab is the active one: the keep-alive layer stays
  // mounted under every other tab and must not consume the shortcuts, and
  // capture-phase preventDefault + stopPropagation keep the app's own ⌘
  // handlers (and the composer's fields) out of the same keystroke. Fields
  // keep their keys: isEditableTarget skips text-entry targets.
  useEffect(() => {
    if (!active) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return
      let next: number | null = null
      if (event.key === '=' || event.key === '+') next = nextBrowserZoom(getBrowserZoom(), 1)
      else if (event.key === '-') next = nextBrowserZoom(getBrowserZoom(), -1)
      else if (event.key === '0') next = 1 // reset → 100%
      if (next === null) return
      if (isEditableTarget(event.target)) return
      event.preventDefault()
      event.stopPropagation()
      setBrowserZoom(next)
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [active])

  // Workspace wiring keeps the store fed; this pane owns the poll (a closed
  // tab has no webviews to host, so pendingCreates may simply time out).
  useEffect(() => {
    void window.pi.browserStatus().then((next) => store.applyStatus(next)).catch(() => {})
    const timer = setInterval(() => {
      void window.pi.browserStatus().then((next) => store.applyStatus(next)).catch(() => {})
    }, BROWSER_POLL_MS)
    return () => clearInterval(timer)
  }, [store])

  // Merged page model (pi-web BrowserTab semantics): serverPages ∪
  // pendingCreates(物化为 pending 行) ∪ optimistic − closedIds. Identify
  // optimistic pages by MEMBERSHIP in state.optimistic (T6-①), never by
  // reading `pending === false` as "materialized".
  const pages = useMemo<BrowserPanePage[]>(() => {
    if (!status) return []
    const serverPages = status.pages
    const known = new Set(serverPages.map((page) => page.id))
    // ONE materialization branch (Ruling D): server pendingCreates become
    // pending rows that render the marker webview which completes their
    // registration. Task 15's local popup rows join this union the same way —
    // no refactor, one render path for every "pending page → marker webview".
    const pending = status.pendingCreates
      .filter((entry) => !known.has(entry.id))
      .map((entry): BrowserPanePage => ({
        id: entry.id,
        owner: entry.owner,
        url: buildMarkerUrl(entry.owner, entry.id),
        title: '',
        agentBusy: false,
        crashed: false,
        pending: true
      }))
    for (const page of pending) known.add(page.id)
    return [...serverPages, ...pending, ...state.optimistic.filter((page) => !known.has(page.id))]
      .filter((page) => !closedIds.has(page.id))
  }, [state, status, closedIds])

  // Selection falls back to the first page during render (a selected page was
  // closed/vanished): deriving here avoids an effect-chasing empty frame.
  const effectiveSelectedId =
    selectedPageId && pages.some((page) => page.id === selectedPageId)
      ? selectedPageId
      : (pages[0]?.id ?? null)

  // pages mirror for event handlers (close reads it without a stale closure).
  const pagesRef = useRef(pages)
  useEffect(() => { pagesRef.current = pages }, [pages])
  // onEmpty through a ref: the pane's callbacks keep stable identities.
  const onEmptyRef = useRef(onEmpty)
  useEffect(() => { onEmptyRef.current = onEmpty }, [onEmpty])

  // Self-heal the optimistic rows (T6-②): once the server list covers an
  // optimistic id, the placeholder's job is done — pi-web's refresh prunes
  // its localPages the same way. The same pass prunes close tombstones for
  // ids that fully left the registry (pages AND pendingCreates — a pending
  // row stays hidden until its waiter resolves).
  useEffect(() => {
    if (!status) return
    const known = new Set(status.pages.map((page) => page.id))
    for (const page of state.optimistic) {
      if (known.has(page.id)) store.removeOptimistic(page.id)
    }
    const pendingIds = new Set(status.pendingCreates.map((entry) => entry.id))
    setClosedIds((prev) => {
      const remaining = [...prev].filter((id) => known.has(id) || pendingIds.has(id))
      return remaining.length === prev.size ? prev : new Set(remaining)
    })
  }, [state, status, store])

  useEffect(() => {
    setLocalNav((prev) => {
      const ids = new Set(pages.map((page) => page.id))
      const stale = Object.keys(prev).filter((id) => !ids.has(id))
      if (stale.length === 0) return prev
      const next = { ...prev }
      for (const id of stale) delete next[id]
      return next
    })
  }, [pages])

  // First fresh pendingCreate after our + click is ours: select the row as
  // soon as it materializes (createPage's own resolution re-selects the same
  // id a moment later — the reconcile upgrade needs a beat).
  useEffect(() => {
    if (!awaitingCreateRef.current || !status) return
    const fresh = status.pendingCreates.find((entry) => !closedIds.has(entry.id))
    if (!fresh) return
    awaitingCreateRef.current = false
    setSelectedPageId(fresh.id)
  }, [state, status, closedIds])

  // onEmpty at most once per pane mount: closePage's direct call and the
  // empty-after-first-status transition share this guard.
  const fireEmpty = useCallback(() => {
    if (emptyFiredRef.current) return
    emptyFiredRef.current = true
    onEmptyRef.current()
  }, [])

  const handleNavChange = useCallback((id: string, patch: BrowserNavPatch) => {
    setLocalNav((prev) => applyNavPatch(prev, id, patch))
  }, [])

  // First-status latch (once per mount): a FRESH status (never the stale
  // pre-mount one — pointer T7-①: EVERY pane remount on zero pages is a
  // restore candidate, be it tab close→reopen or rail collapse→reopen) with
  // zero pages, no pendingCreates/optimistic and consent past → restore the
  // open-pages snapshot, else open one blank page. Live arrivals win: pages
  // or pendingCreates on that first status skip the restore entirely. A
  // consent-required status stays armed — the grant's own status fires it.
  useEffect(() => {
    if (autoFilledRef.current) return
    if (!status || status === staleStatusRef.current) return
    if (status.consentRequired) return
    autoFilledRef.current = true
    if (pages.length > 0 || status.pendingCreates.length > 0 || store.getState().optimistic.length > 0) return
    const saved = readOpenBrowserPages()
    const restores: Array<string | undefined> = saved.length > 0 ? [...saved] : [undefined]
    autoFillInFlightRef.current = true
    let remaining = restores.length
    for (const url of restores) {
      void window.pi.browserCreatePage(url)
        .then((meta) => {
          // Prewrite the row's target url while it still shows about:blank or
          // a marker — the strip and the snapshot show the destination before
          // the guest's did-navigate lands (did-navigate usually wins the
          // race since the service's goto precedes resolution; the guard
          // keeps this a no-op then).
          setLocalNav((prev) => {
            const shown = prev[meta.id]?.url ?? ''
            if (shown && shown !== 'about:blank' && !parseMarkerUrl(shown)) return prev
            return applyNavPatch(prev, meta.id, { url })
          })
        })
        .catch(() => { /* once per mount — the empty state's New-page button is the fallback */ })
        .finally(() => {
          remaining -= 1
          if (remaining === 0) autoFillInFlightRef.current = false
        })
    }
  }, [pages, status, store])

  // Empty after the first real status (pointer T7-④): once the merged model
  // HAS been non-empty post-mount, it going empty for ANY reason — server-side
  // removal, crash sweep — closes the tab, exactly like the close button.
  // Boot (no status, or the stale pre-mount snapshot) never counts, and the
  // latch's own in-flight fill is skipped — the restore owns that emptiness.
  useEffect(() => {
    if (!status || status === staleStatusRef.current || status.consentRequired) return
    if (autoFillInFlightRef.current) return
    if (pages.length > 0) {
      sawPagesRef.current = true
      return
    }
    if (!sawPagesRef.current || emptyFiredRef.current) return
    fireEmpty()
  }, [fireEmpty, pages, status])

  // Continuous open-pages snapshot (Task 8): every merged-model/localNav
  // change rewrites the snapshot from the human pages' display urls
  // (snapshotOpenPages filters non-recordable urls; the write inside
  // session.ts skips same-value writes). Skipped before the first FRESH
  // status so this effect can never blank the snapshot the restore latch is
  // about to read.
  useEffect(() => {
    if (!status || status === staleStatusRef.current) return
    // The auto-blank/restore fill is in flight: the model is legitimately
    // empty until the restored pages round-trip — writing now would blank
    // the snapshot the latch just read. The fill's own completion re-runs
    // this effect and writes the restored urls.
    if (autoFillInFlightRef.current) return
    writeOpenBrowserPages(
      snapshotOpenPages(pages.map((page) => ({ owner: page.owner, url: displayUrlOf(page, localNav[page.id]) })))
    )
  }, [localNav, pages, status])

  const newPage = useCallback(() => {
    awaitingCreateRef.current = true
    // Pull once right away: the pendingCreate enqueue does not push state, so
    // the poll alone would add up to one BROWSER_POLL_MS of dead air.
    void window.pi.browserStatus().then((next) => store.applyStatus(next)).catch(() => {})
    void window.pi.browserCreatePage()
      .then((meta) => {
        awaitingCreateRef.current = false
        setSelectedPageId(meta.id)
        // Round trip done — the registry has the page. If the push is still
        // in flight, an optimistic row keeps the strip from flashing; the
        // self-heal above drops it once the server list covers the id.
        if (!store.getState().status?.pages.some((page) => page.id === meta.id)) {
          store.addOptimistic(meta.id)
          store.resolveOptimistic(meta.id)
        }
      })
      .catch(() => { awaitingCreateRef.current = false })
  }, [store])

  const grantConsent = useCallback(() => {
    void window.pi.browserConsent()
      .then((next) => store.applyStatus(next))
      .catch(() => { /* the next push carries the granted state */ })
  }, [store])

  const closePage = useCallback((id: string) => {
    // Closing the last page closes the whole browser tab (terminal-tab
    // behaviour); the server close is idempotent either way.
    const wasLast = pagesRef.current.length <= 1
    setClosedIds((prev) => (prev.has(id) ? prev : new Set(prev).add(id)))
    setLocalNav((prev) => {
      if (!(id in prev)) return prev
      const next = { ...prev }
      delete next[id]
      return next
    })
    store.removeOptimistic(id)
    void window.pi.browserClosePage(id).catch(() => { /* idempotent cleanup */ })
    if (wasLast) fireEmpty()
  }, [fireEmpty, store])

  const consentRequired = status?.consentRequired ?? true

  return (
    <div className="flex h-full min-h-0 flex-col bg-background" data-browser-pane>
      <div className="flex shrink-0 items-center gap-1 px-2 py-1.5">
        <div className="min-w-0 flex-1 overflow-x-auto p-1">
          <Tabs
            value={effectiveSelectedId ?? ''}
            onValueChange={setSelectedPageId}
            variant="segment"
            className="w-max"
          >
            <TabsList className="gap-1 bg-muted/60 p-0.5">
              {pages.map((page) => {
                const nav = localNav[page.id]
                const url = displayUrlOf(page, nav)
                const label =
                  page.pending && !nav
                    ? t('browser.pageLoading')
                    : (nav?.title || page.title || url || 'about:blank')
                const isActive = page.id === effectiveSelectedId
                return (
                  <div key={page.id} className="group/browser-page relative flex items-center" data-browser-tab={page.id}>
                    <LabelTooltip content={url || undefined} wrap>
                      <TabsTrigger
                        value={page.id}
                        indicatorClassName="bg-background shadow-xs ring-1 ring-border"
                        className={cn('h-7 min-h-0 pl-2.5 pr-7', isActive && 'text-foreground')}
                      >
                        {nav?.favicon ? (
                          <img
                            src={nav.favicon}
                            alt=""
                            aria-hidden="true"
                            className="size-3.5 shrink-0 rounded-detail object-contain"
                          />
                        ) : page.owner !== HUMAN_OWNER ? (
                          <Bot aria-hidden="true" className="size-3.5 shrink-0" />
                        ) : (
                          <Globe aria-hidden="true" className="size-3.5 shrink-0" />
                        )}
                        <MiddleEllipsis name={label} className="max-w-28 text-xs" />
                      </TabsTrigger>
                    </LabelTooltip>
                    <Tooltip content={t('browser.closePage')} wrapperClassName="absolute right-0.5 z-10">
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={t('browser.closePage')}
                        onClick={() => closePage(page.id)}
                        className={cn(
                          'size-5 rounded-md group-hover/browser-page:opacity-100 focus-visible:opacity-100',
                          isActive ? 'opacity-100' : 'opacity-0'
                        )}
                      >
                        <X aria-hidden="true" className="size-3" />
                      </Button>
                    </Tooltip>
                  </div>
                )
              })}
            </TabsList>
          </Tabs>
        </div>
        {!consentRequired ? (
          <Tooltip content={t('browser.newPage')}>
            <Button variant="ghost" size="icon" className="size-7 shrink-0" aria-label={t('browser.newPage')} onClick={newPage}>
              <Plus aria-hidden="true" className="size-4" />
            </Button>
          </Tooltip>
        ) : null}
      </div>
      {status === null ? null : consentRequired ? (
        <div className="flex min-h-0 flex-1 items-center justify-center p-6">
          <div className="w-full max-w-sm rounded-card border border-border p-5 text-center" data-browser-consent>
            <p className="text-sm font-medium text-foreground">{t('browser.consentTitle')}</p>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">{t('browser.consentBody')}</p>
            <Button className="mt-4" onClick={grantConsent}>{t('browser.consentGrant')}</Button>
          </div>
        </div>
      ) : pages.length === 0 ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
          <Globe aria-hidden="true" className="size-6 text-muted-foreground/70" />
          <p className="text-sm text-muted-foreground">{t('browser.emptyHint')}</p>
          <Button variant="outline" size="sm" onClick={newPage}>{t('browser.newPage')}</Button>
        </div>
      ) : (
        <div className="relative min-h-0 flex-1">
          {pages.map((page) => (
            <BrowserPageView
              key={page.id}
              page={page}
              selected={page.id === effectiveSelectedId}
              displayUrl={displayUrlOf(page, localNav[page.id])}
              onNavChange={handleNavChange}
            />
          ))}
        </div>
      )}
    </div>
  )
}
