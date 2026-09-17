import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { JSX } from 'react'
import { Bot, Globe, Plus, X } from '@/lib/icons'
import { Button } from '@/components/motion/button'
import { Tabs, TabsList, TabsTrigger } from '@/components/motion/tabs'
import { Tooltip } from '@/components/motion/tooltip'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import { HUMAN_OWNER, buildMarkerUrl, parseMarkerUrl } from '../../../../shared/browser.ts'
import type { BrowserPanePage, BrowserStore } from '@/lib/browser/store'
import { BrowserPageView, type BrowserNavPatch, type LocalNavInfo } from './BrowserPageView'
import { LabelTooltip } from './LabelTooltip'
import { MiddleEllipsis } from './MiddleEllipsis'

/** Status poll cadence (pi-web BrowserTab parity). pendingCreates are enqueued
 *  WITHOUT a browser:state push, so this poll is what materializes pages the
 *  service is waiting on (agent page creation, the + button's createPage):
 *  rendering the pending row mounts its marker webview, which completes the
 *  registration. getStatus also kicks a best-effort reconcile each tick. */
const BROWSER_POLL_MS = 2_500

/** Marker URLs display as about:blank (they are the hosting convention, not a
 *  user-facing location). */
const displayPageUrl = (url: string): string => (parseMarkerUrl(url) ? 'about:blank' : url)

/**
 * The embedded browser pane: a page strip (beUI segment tabs) over one
 * always-mounted webview per page, with the consent gate in front. Data flows
 * in through the workspace-owned `BrowserStore` (`browser:state` pushes + the
 * poll below); display truth for titles/URLs/favicons is this pane's own
 * `localNav` map, fed by webview events (server meta is only the fallback).
 */
export function BrowserPane({ store, onEmpty }: { store: BrowserStore; onEmpty: () => void }): JSX.Element {
  const { t } = useI18n()
  const state = useSyncExternalStore((cb) => store.subscribe(cb), () => store.getState())
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

  const handleNavChange = useCallback((id: string, patch: BrowserNavPatch) => {
    setLocalNav((prev) => {
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
    })
  }, [])

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
    if (wasLast) onEmptyRef.current()
  }, [store])

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
                const url = nav?.url || displayPageUrl(page.url)
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
              onNavChange={handleNavChange}
            />
          ))}
        </div>
      )}
    </div>
  )
}
