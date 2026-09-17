import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { FocusEvent, JSX, MouseEvent } from 'react'
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Globe, RefreshCw, X, ZoomIn, ZoomOut, type IconComponent } from '@/lib/icons'
import { Button } from '@/components/motion/button'
import { Input } from '@/components/motion/input'
import { Tooltip } from '@/components/motion/tooltip'
import { useI18n } from '@/i18n'
import {
  BROWSER_PARTITION,
  HUMAN_OWNER,
  buildMarkerUrl,
  isAllowedNavigationUrl,
  normalizeNavigationUrl,
  parseMarkerUrl
} from '../../../../shared/browser.ts'
import {
  getRecentUrls,
  isRecordableUrl,
  recordBrowserHistory,
  recordRecentUrl,
  subscribeBrowserRecents,
  updateBrowserHistoryFaviconFor,
  updateBrowserHistoryTitleFor
} from '@/lib/browser/session'
import type { BrowserPanePage } from '@/lib/browser/store'
import {
  effectiveWebviewZoom,
  getBrowserZoom,
  nextBrowserZoom,
  setBrowserZoom,
  subscribeBrowserZoom
} from '@/lib/browser/zoom'
import { cn } from '@/lib/utils'

/** Electron guest queries the pane needs — declared here because the renderer
 *  must not import Electron. The JSX element itself is @types/react's built-in
 *  `webview` (global `HTMLWebViewElement`), which already carries `src` and
 *  `partition`; the ref holds that element and event/style access is plain DOM.
 *  The navigation methods are the webview's own DOM API — safe on the guest
 *  (the forbidden reload is the CDP `Page.reload` command, which the service
 *  avoids; `webview.reload()`/`loadURL()` are ordinary element calls). */
export interface BrowserWebviewElement {
  getURL(): string
  getWebContentsId(): number
  canGoBack(): boolean
  canGoForward(): boolean
  goBack(): void
  goForward(): void
  reload(): void
  loadURL(url: string): Promise<void>
  setZoomFactor(factor: number): void
  /** In-page find + print (Task 12) — the webview's own DOM API. `findNext:
   *  true` is the reliable shape on webview guests: it continues an active
   *  session (adjacent match) and starts one when none is active; the default
   *  `findNext: false` can silently skip the found-in-page event. */
  findInPage(text: string, options?: { forward?: boolean; findNext?: boolean; matchCase?: boolean }): number
  stopFindInPage(action: 'clearSelection' | 'keepSelection' | 'activateSelection'): void
  print(): Promise<void>
}

/** One webview event's display patch, folded into the pane's localNav map. */
export interface BrowserNavPatch {
  url?: string
  title?: string
  favicon?: string | null
}

/** UI-side display truth for one page (webview events win over server meta). */
export interface LocalNavInfo {
  url: string
  title: string
  favicon?: string
}

/** What the pane's browser-owned shortcuts can ask of the selected page. */
export interface BrowserPageActions {
  openFind: () => void
  print: () => void
}

export interface BrowserPageViewProps {
  page: BrowserPanePage
  /** Whether the page strip has this page selected. */
  selected: boolean
  /** Display url of this page (localNav truth, markers shown as about:blank) —
   *  drives the URL input and the start-page overlay. */
  displayUrl: string
  onNavChange: (id: string, patch: BrowserNavPatch) => void
  /** Registers the SELECTED page's find/print surface with the pane, so the
   *  pane-level ⌘F/⌘P shortcuts (and the guest relay) act on the page on
   *  screen without reaching into any webview element. Called with null on
   *  deselect/unmount. */
  bindPageActions?: (actions: BrowserPageActions | null) => void
}

/** Icon-only toolbar button (the FilesPane ToolButton pattern). */
function ToolButton({ label, icon: Icon, onClick }: { label: string; icon: IconComponent; onClick: () => void }) {
  return (
    <Tooltip content={label}>
      <Button variant="ghost" size="icon" className="size-7 shrink-0" aria-label={label} onClick={onClick}>
        <Icon aria-hidden className="size-3.5" />
      </Button>
    </Tooltip>
  )
}

/** Push the shared page zoom to one guest. The store keeps the ladder value
 *  relative to the host UI (the pane hosts at 1× UI scale today), so the
 *  absolute factor is `effectiveWebviewZoom`. `setZoomFactor` throws while
 *  the guest document is not ready — silent by design: every dom-ready and
 *  committed navigation re-applies, so an early failure needs no retry. */
function applyZoom(wv: BrowserWebviewElement | null, pageZoom: number): void {
  if (!wv) return
  try {
    wv.setZoomFactor(effectiveWebviewZoom(pageZoom, 1))
  } catch {
    /* guest not ready — re-applied on the next dom-ready / navigation */
  }
}

/** True when the keydown target is a text-entry surface (input, textarea,
 *  contentEditable host or child): the browser zoom shortcuts must not steal
 *  keystrokes a field owns. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  if (target.closest('input, textarea')) return true
  let node: Element | null = target
  while (node) {
    if ((node as HTMLElement).isContentEditable) return true
    node = node.parentElement
  }
  return false
}

/** URL input's click-select-all (pi-web parity): after onFocus selects all,
 *  the browser's default mousedown drops the caret at the click point ("select
 *  then suddenly release"); intercept the default when unfocused and complete
 *  focus+select by hand; leave a focused field alone so drag-selection and
 *  caret placement keep working. */
const urlSelectAllProps = {
  onFocus: (e: FocusEvent<HTMLInputElement>) => e.target.select(),
  onMouseDown: (e: MouseEvent<HTMLInputElement>) => {
    if (document.activeElement !== e.currentTarget) {
      e.preventDefault()
      e.currentTarget.focus()
      e.currentTarget.select()
    }
  }
} as const

/** Recents row label: hostname emphasized, path/search muted. */
function recentUrlParts(url: string): { host: string; rest: string } {
  try {
    const parsed = new URL(url)
    const rest = `${parsed.pathname === '/' ? '' : parsed.pathname}${parsed.search}`
    return { host: parsed.host, rest }
  } catch {
    return { host: url, rest: '' }
  }
}

/**
 * Start-page overlay: shown where a page exists but is blank (display url is
 * about:blank). Paints over the still-mounted guest (unmounting it would
 * destroy it — the iron rule below) with a large URL input that navigates the
 * CURRENT page and the recent-addresses list. The T7 no-pages empty state is
 * a different surface and stays.
 */
function BrowserStartPage({ onOpen }: { onOpen: (raw: string) => boolean }): JSX.Element {
  const { t } = useI18n()
  const [draft, setDraft] = useState('')
  const recents = useSyncExternalStore(subscribeBrowserRecents, getRecentUrls)
  const submit = () => {
    if (onOpen(draft)) setDraft('')
  }
  return (
    <div className="absolute inset-0 z-10 overflow-y-auto bg-background" data-browser-start-page>
      <div className="flex min-h-full flex-col items-center justify-center gap-5 p-6 text-center">
        <div className="flex flex-col items-center gap-1.5">
          <Globe aria-hidden="true" className="size-6 text-muted-foreground/70" />
          <p className="text-sm font-medium text-foreground">{t('browser.startTitle')}</p>
          <p className="text-xs text-muted-foreground">{t('browser.startHint')}</p>
        </div>
        <Input
          value={draft}
          onChange={setDraft}
          placeholder={t('browser.urlPlaceholder')}
          aria-label={t('browser.urlPlaceholder')}
          spellCheck={false}
          className="w-full max-w-md"
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
            submit()
          }}
          {...urlSelectAllProps}
        />
        {recents.length > 0 ? (
          <div className="flex w-full max-w-md flex-col gap-1" role="list" aria-label={t('browser.openRecents')} data-browser-recents>
            <p className="px-1 text-left text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
              {t('browser.recents')}
            </p>
            {recents.map((url) => {
              const parts = recentUrlParts(url)
              return (
                <Button
                  key={url}
                  variant="ghost"
                  size="sm"
                  className="w-full justify-start gap-2 px-2 font-normal"
                  onClick={() => onOpen(url)}
                >
                  <Globe aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground/70" />
                  <span className="min-w-0 truncate text-xs">
                    <span className="font-medium text-foreground">{parts.host}</span>
                    <span className="text-muted-foreground">{parts.rest}</span>
                  </span>
                </Button>
              )
            })}
          </div>
        ) : null}
      </div>
    </div>
  )
}

/**
 * One embedded-browser page: ONE always-mounted `<webview>` whose initial src
 * is the page's marker URL (the main process discovers the guest through it
 * and registers ownership). All pages of the pane stay mounted — unmounting a
 * webview destroys the guest (page state and history are lost) — so the pane
 * hosts every page at full size and only the VISIBILITY differs:
 *
 * - selected page: normal (plus its toolbar above the guest);
 * - unselected HUMAN page: `display: none`;
 * - unselected AGENT page (`owner !== HUMAN_OWNER`): `opacity: 0` +
 *   `pointerEvents: none`, still full size — NEVER `display: none`. Under
 *   `display: none` the agent's click times out, screenshots hang and text
 *   input silently does nothing (pi-web's electron-webview-spike finding);
 *   background agent driving needs the opacity form.
 */
export function BrowserPageView({ page, selected, displayUrl, onNavChange, bindPageActions }: BrowserPageViewProps) {
  const { t } = useI18n()
  const webviewRef = useRef<HTMLWebViewElement | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  // Initial src is taken once at mount: new pages / pendingCreates carry a
  // marker URL; a server page restored with its real URL re-mounts at the
  // marker so the guest registers under the SAME id again (the real URL is
  // re-derived by the service after registration).
  const initialSrcRef = useRef(
    parseMarkerUrl(page.url) ? page.url : buildMarkerUrl(page.owner, page.id),
  )
  // The marker registration handshake is one-shot; re-apply-zoom (Task 9)
  // must NOT share this latch — every real document fires its own dom-ready.
  const handshakeCompleteRef = useRef(false)
  // Most recent committed url on this guest (marker loads excluded): the
  // page-title / page-favicon history backfills attach to it.
  const lastNavUrlRef = useRef('')
  // Draft semantics (Ruling I — binding): null = not editing, the input shows
  // the LIVE navigation url (displayUrl), so link clicks, redirects and
  // Back/Forward always flow through. A change (focus + typing) holds the
  // draft; blur and a successful Enter submit both release it back to null.
  const [urlDraft, setUrlDraft] = useState<string | null>(null)
  const [urlError, setUrlError] = useState(false)
  const urlErrorTimerRef = useRef<number | null>(null)

  // Shared page zoom (pane-wide ladder state, persisted in localStorage): the
  // selected toolbar reads it here and every page view re-applies it to its
  // own guest, so one change covers all pages.
  const pageZoom = useSyncExternalStore(subscribeBrowserZoom, getBrowserZoom)
  // Event handlers (dom-ready / did-navigate) read the zoom through this ref
  // so their listener effect stays decoupled from zoom changes.
  const pageZoomRef = useRef(pageZoom)
  useEffect(() => {
    pageZoomRef.current = pageZoom
    // Live re-apply on every change (dom-ready re-applies anyway; this makes
    // toolbar/shortcut feedback instant on the already-loaded guest).
    applyZoom(webviewRef.current as unknown as BrowserWebviewElement | null, pageZoom)
  }, [pageZoom])

  const zoomIn = useCallback(() => {
    setBrowserZoom(nextBrowserZoom(getBrowserZoom(), 1))
  }, [])
  const zoomOut = useCallback(() => {
    setBrowserZoom(nextBrowserZoom(getBrowserZoom(), -1))
  }, [])

  // ---- In-page find (Task 12) ----
  // The bar's state lives in THIS view's lifecycle: only the selected page
  // renders it, and losing selection closes it (effect below), so switching
  // pages never carries a bar or a stale counter across.
  const [findOpen, setFindOpen] = useState(false)
  const [findQuery, setFindQuery] = useState('')
  /** Last finalUpdate counter from found-in-page (null = nothing to show). */
  const [findCount, setFindCount] = useState<{ ordinal: number; matches: number } | null>(null)
  const findInputRef = useRef<HTMLInputElement | null>(null)
  // Mirrors for the code that must not depend on fresh renders: the
  // found-in-page listener is attached once, and closeFind runs from effects.
  const findOpenRef = useRef(false)
  const lastFindTextRef = useRef('')

  const openFind = useCallback(() => {
    findOpenRef.current = true
    setFindOpen(true)
    // Already open (⌘F again): the field just takes focus. Freshly opened:
    // the mount-focus effect below runs once the bar exists.
    findInputRef.current?.focus()
  }, [])

  const closeFind = useCallback(() => {
    findOpenRef.current = false
    setFindOpen(false)
    setFindCount(null)
    lastFindTextRef.current = ''
    const wv = webviewRef.current as unknown as BrowserWebviewElement | null
    try { wv?.stopFindInPage('clearSelection') } catch { /* guest not ready */ }
  }, [])

  /** One find step against the guest. Changed query text tears the previous
   *  session down first, so the fresh find starts from the top instead of
   *  continuing the old one. */
  const runFind = useCallback((text: string, backward = false) => {
    const wv = webviewRef.current as unknown as BrowserWebviewElement | null
    if (!wv || text.length === 0) return
    const inputHadFocus = document.activeElement === findInputRef.current
    try {
      if (text !== lastFindTextRef.current) wv.stopFindInPage('clearSelection')
      // findNext: true = continue-or-start (see BrowserWebviewElement above).
      wv.findInPage(text, { forward: !backward, findNext: true })
      lastFindTextRef.current = text
    } catch { /* guest not ready — the next edit retries */ }
    // findInPage can hand keyboard focus to the guest; take it straight back
    // so typing in the field keeps flowing (only when the field had it).
    if (inputHadFocus) findInputRef.current?.focus()
  }, [])

  const findStep = useCallback((direction: 1 | -1) => {
    if (findQuery.length === 0) return
    runFind(findQuery, direction === -1)
  }, [findQuery, runFind])

  // Debounced find (200ms after the last edit): non-empty runs findInPage,
  // empty clears the selection and the counter. The timer cleanup means a
  // close/query change can never leave a trailing findInPage behind, and a
  // query Enter/⌘F already searched suppresses the still-pending timer.
  useEffect(() => {
    if (!findOpen) return
    const text = findQuery
    if (text.length === 0) {
      const wv = webviewRef.current as unknown as BrowserWebviewElement | null
      try { wv?.stopFindInPage('clearSelection') } catch { /* guest not ready */ }
      lastFindTextRef.current = ''
      setFindCount(null)
      return
    }
    const timer = window.setTimeout(() => {
      if (text === lastFindTextRef.current) return
      runFind(text)
    }, 200)
    return () => window.clearTimeout(timer)
  }, [findOpen, findQuery, runFind])

  // Focus the field when the bar appears (⌘F / T13 menu) — after the mount,
  // since openFind's direct focus() finds no field yet on the first frame.
  useEffect(() => {
    if (findOpen) findInputRef.current?.focus()
  }, [findOpen])

  // The bar belongs to the selected page: losing selection closes it (the
  // guest's highlight is cleared with it).
  useEffect(() => {
    if (!selected) closeFind()
  }, [closeFind, selected])

  const printPage = useCallback(() => {
    const wv = webviewRef.current as unknown as BrowserWebviewElement | null
    if (!wv) return
    try { void wv.print().catch(() => { /* a failed print is the guest's to render */ }) } catch { /* guest not ready */ }
  }, [])

  // Expose the selected page's find/print to the pane-level shortcuts (⌘F/⌘P
  // and the guest relay). Only the SELECTED view binds, so the pane's actions
  // always hit the page on screen. T13: menu opens find via this path.
  useEffect(() => {
    if (!selected) return
    bindPageActions?.({ openFind, print: printPage })
    return () => bindPageActions?.(null)
  }, [bindPageActions, openFind, printPage, selected])

  // The guest follows the element layout, but under "display:none → visible"
  // and panel open/close animations it can end up stuck at a shrunken size
  // (measured in pi-web) — drive it explicitly in pixels. A display:none
  // wrapper reports 0×0: leave it alone; becoming visible re-fires this.
  const syncSize = useCallback(() => {
    const wrap = wrapRef.current
    const wv = webviewRef.current
    if (!wrap || !wv) return
    const width = wrap.clientWidth
    const height = wrap.clientHeight
    if (width === 0 || height === 0) return
    wv.style.width = `${width}px`
    wv.style.height = `${height}px`
  }, [])
  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return
    const observer = new ResizeObserver(() => syncSize())
    observer.observe(wrap)
    syncSize()
    return () => observer.disconnect()
  }, [syncSize])

  const flashUrlError = useCallback(() => {
    setUrlError(true)
    if (urlErrorTimerRef.current !== null) window.clearTimeout(urlErrorTimerRef.current)
    urlErrorTimerRef.current = window.setTimeout(() => {
      urlErrorTimerRef.current = null
      setUrlError(false)
    }, 700)
  }, [])
  useEffect(() => () => {
    if (urlErrorTimerRef.current !== null) window.clearTimeout(urlErrorTimerRef.current)
  }, [])

  /** User-typed url → normalized → whitelist-gated → guest loadURL. Returns
   *  the normalized url, or null when it does not parse OR the navigation
   *  whitelist rejects the scheme (file:/view-source:/data:/javascript: …).
   *  The URL bar is one of the entries shared/browser.ts funnels through that
   *  whitelist — the same gate the service applies to browser_navigate/goto —
   *  so no embedder-driven navigation can bypass it (both entry points here,
   *  toolbar Enter and the start-page input, route through this one call).
   *  The caller shows the error styling for null. */
  const loadUrl = useCallback((raw: string): string | null => {
    const url = normalizeNavigationUrl(raw)
    const wv = webviewRef.current as unknown as BrowserWebviewElement | null
    if (!url || !isAllowedNavigationUrl(url) || !wv) return null
    void wv.loadURL(url).catch(() => { /* a failed load is the guest's to render */ })
    return url
  }, [])

  const navigate = useCallback((action: 'back' | 'forward' | 'reload') => {
    const wv = webviewRef.current as unknown as BrowserWebviewElement | null
    if (!wv) return
    if (action === 'back') {
      if (wv.canGoBack()) wv.goBack()
    } else if (action === 'forward') {
      if (wv.canGoForward()) wv.goForward()
    } else {
      wv.reload()
    }
  }, [])

  useEffect(() => {
    const wv = webviewRef.current
    if (!wv) return
    const onDomReady = () => {
      // Re-apply zoom on EVERY dom-ready — deliberately OUTSIDE the one-shot
      // handshake latch below: the first marker→site navigation and later
      // cross-origin navigations can reset the guest's zoom factor.
      applyZoom(wv as unknown as BrowserWebviewElement, pageZoomRef.current)
      if (handshakeCompleteRef.current) return
      handshakeCompleteRef.current = true
      // Register the guest with the service (state-only until a reconcile
      // upgrades it): ownership, current URL, and the webContentsId the
      // main-process input-event relay keys on.
      const guest = wv as unknown as BrowserWebviewElement
      let webContentsId: number | undefined
      try {
        const wcId = guest.getWebContentsId()
        if (Number.isFinite(wcId) && wcId > 0) webContentsId = wcId
      } catch {
        /* guest not ready — reconcile still registers ownership by marker */
      }
      void window.pi.browserSeen({
        id: page.id,
        owner: page.owner,
        url: guest.getURL(),
        webContentsId
      }).catch(() => { /* next reconcile pass re-registers by marker */ })
    }
    // Origin of the previous document: a cross-site navigation clears the old
    // site's favicon (the new one arrives via page-favicon-updated); a
    // same-site navigation keeps it — re-clearing would just flash a blank.
    let prevOrigin = ''
    const onNav = (event: Event) => {
      // Best-effort zoom re-apply: a committed navigation is the other moment
      // the guest may have reset its factor (applyZoom catches silently).
      applyZoom(wv as unknown as BrowserWebviewElement, pageZoomRef.current)
      const raw = (event as unknown as { url?: string }).url ?? ''
      // Loading the initial marker src is not a real navigation: keep it out
      // of localNav so the strip keeps its about:blank display semantics.
      if (parseMarkerUrl(raw)) return
      lastNavUrlRef.current = raw
      // History/recents record REAL human navigation only (markers and
      // agent-driven pages stay out; SPA routes arrive as in-page navigations
      // and are excluded there).
      if (page.owner === HUMAN_OWNER && isRecordableUrl(raw)) {
        recordRecentUrl(raw)
        recordBrowserHistory(raw)
      }
      let origin = ''
      try { origin = new URL(raw).origin } catch { /* about:blank & friends */ }
      const crossSite = origin !== prevOrigin
      prevOrigin = origin
      // The new document's title hasn't arrived: fall back to the URL first.
      onNavChange(page.id, { url: raw, title: '', favicon: crossSite ? null : undefined })
    }
    const onNavInPage = (event: Event) => {
      const e = event as unknown as { url?: string; isMainFrame?: boolean }
      if (e.isMainFrame === false) return // same-document subframe noise
      if (typeof e.url !== 'string') return
      lastNavUrlRef.current = e.url
      // Same-document navigation does not reset the title — did-navigate /
      // page-title-updated arrive in either order and a reset here would drop
      // a title that got there first. Deliberately NOT recorded: an SPA route
      // is not a real navigation.
      onNavChange(page.id, { url: e.url })
    }
    const onTitle = (event: Event) => {
      const title = (event as unknown as { title?: string }).title ?? ''
      onNavChange(page.id, { title })
      if (page.owner === HUMAN_OWNER) updateBrowserHistoryTitleFor(lastNavUrlRef.current, title)
    }
    const onFavicon = (event: Event) => {
      // Candidates follow the site's declaration order; the last is usually
      // the largest / most refined one (e.g. apple-touch-icon).
      const favicons = (event as unknown as { favicons?: string[] }).favicons ?? []
      const favicon = favicons.length > 0 ? favicons[favicons.length - 1] : null
      onNavChange(page.id, { favicon })
      if (page.owner === HUMAN_OWNER && favicon) {
        updateBrowserHistoryFaviconFor(lastNavUrlRef.current, favicon)
      }
    }
    const onFoundInPage = (event: Event) => {
      // The counter follows the FINAL payload of a request only (intermediate
      // updates arrive while Chromium is still counting), and only while the
      // bar is open — a payload landing after close must not resurrect it.
      if (!findOpenRef.current) return
      const result = (event as unknown as {
        result?: { finalUpdate?: boolean; activeMatchOrdinal?: number; matches?: number }
      }).result
      if (!result?.finalUpdate) return
      setFindCount({ ordinal: result.activeMatchOrdinal ?? 0, matches: result.matches ?? 0 })
    }
    wv.addEventListener('dom-ready', onDomReady)
    wv.addEventListener('did-navigate', onNav)
    wv.addEventListener('did-navigate-in-page', onNavInPage)
    wv.addEventListener('page-title-updated', onTitle)
    wv.addEventListener('page-favicon-updated', onFavicon)
    wv.addEventListener('found-in-page', onFoundInPage)
    return () => {
      wv.removeEventListener('dom-ready', onDomReady)
      wv.removeEventListener('did-navigate', onNav)
      wv.removeEventListener('did-navigate-in-page', onNavInPage)
      wv.removeEventListener('page-title-updated', onTitle)
      wv.removeEventListener('page-favicon-updated', onFavicon)
      wv.removeEventListener('found-in-page', onFoundInPage)
    }
  }, [page.id, page.owner, onNavChange])

  // IRON RULE: an unselected agent page must never take `display: none` —
  // keep it hosted at full size, invisible and pointer-transparent.
  const backgroundAgent = !selected && page.owner !== HUMAN_OWNER
  return (
    <div
      data-browser-page={page.id}
      className={cn('absolute inset-0 flex min-h-0 flex-col', !selected && !backgroundAgent && 'hidden')}
      style={backgroundAgent ? { opacity: 0, pointerEvents: 'none' } : undefined}
    >
      {selected ? (
        <div className="flex h-11 shrink-0 items-center gap-1 border-b border-border/40 px-2" data-browser-toolbar>
          <ToolButton label={t('browser.back')} icon={ArrowLeft} onClick={() => navigate('back')} />
          <ToolButton label={t('browser.forward')} icon={ArrowRight} onClick={() => navigate('forward')} />
          <ToolButton label={t('browser.reload')} icon={RefreshCw} onClick={() => navigate('reload')} />
          <Input
            value={urlDraft ?? displayUrl}
            onChange={setUrlDraft}
            placeholder={t('browser.urlPlaceholder')}
            spellCheck={false}
            error={urlError}
            className="min-w-0 flex-1"
            classNames={{ field: 'h-8', input: 'h-full px-2.5 font-mono text-xs' }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
              const url = loadUrl(urlDraft ?? displayUrl)
              // Success RELEASES the draft: the field returns to the live
              // navigation url (did-navigate updates it) instead of pinning
              // the typed text over link clicks / redirects / Back-Forward.
              // A failed parse keeps the draft — the user is still editing.
              if (url !== null) setUrlDraft(null)
              else flashUrlError()
            }}
            onBlur={() => setUrlDraft(null)}
            {...urlSelectAllProps}
          />
          <div className="flex shrink-0 items-center" data-browser-zoom>
            <ToolButton label={t('browser.zoomOut')} icon={ZoomOut} onClick={zoomOut} />
            {/* Read-only percent: a Tooltip (not dead text) gives ⌘0 its one
                discoverability point — the label is the zoomReset copy. */}
            <Tooltip content={t('browser.zoomReset')}>
              <span className="w-10 shrink-0 cursor-default text-center text-xs tabular-nums text-muted-foreground">
                {Math.round(pageZoom * 100)}%
              </span>
            </Tooltip>
            <ToolButton label={t('browser.zoomIn')} icon={ZoomIn} onClick={zoomIn} />
          </div>
        </div>
      ) : null}
      <div ref={wrapRef} className="relative min-h-0 flex-1">
        <webview
          ref={webviewRef}
          src={initialSrcRef.current}
          partition={BROWSER_PARTITION}
          // allowpopups as a STRING spread (React strips boolean attributes on
          // unknown elements, so a `true` prop never reaches the DOM) — without
          // it Chromium swallows guest `window.open` before the main-process
          // popup handler ever sees it (pi-web electron-webview-spike finding).
          {...{ allowpopups: 'true' } as Record<string, string>}
          className="h-full w-full"
        />
        {selected && displayUrl === 'about:blank' ? (
          <BrowserStartPage onOpen={(raw) => loadUrl(raw) !== null} />
        ) : null}
        {findOpen ? (
          <div
            data-browser-find
            className="absolute right-2 top-2 z-10 flex h-9 items-center gap-0.5 rounded-control border border-border bg-background px-1 shadow-overlay"
            onKeyDown={(event) => {
              // Esc anywhere in the bar closes it; stopPropagation keeps the
              // window-level Esc handling (Esc-to-stop) out of the same
              // keystroke.
              if (event.key !== 'Escape' || event.nativeEvent.isComposing) return
              event.preventDefault()
              event.stopPropagation()
              closeFind()
            }}
          >
            <Input
              ref={findInputRef}
              value={findQuery}
              onChange={setFindQuery}
              placeholder={t('browser.findPlaceholder')}
              aria-label={t('browser.findPlaceholder')}
              spellCheck={false}
              autoComplete="off"
              className="w-44 shrink-0"
              classNames={{ field: 'h-7', input: 'h-full px-2 text-xs' }}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return
                if (event.key === 'Enter') {
                  event.preventDefault()
                  findStep(event.shiftKey ? -1 : 1)
                } else if ((event.metaKey || event.ctrlKey) && event.key === 'f') {
                  // ⌘F with the field focused = next match (the window-level
                  // ⌘F yields to this editable target by design).
                  event.preventDefault()
                  event.stopPropagation()
                  findStep(1)
                }
              }}
            />
            <span
              role="status"
              aria-live="polite"
              className="w-16 shrink-0 text-center text-[10px] tabular-nums text-muted-foreground"
            >
              {findCount ? t('browser.findCount', { x: findCount.ordinal, y: findCount.matches }) : ''}
            </span>
            <ToolButton label={t('browser.findPrev')} icon={ArrowUp} onClick={() => findStep(-1)} />
            <ToolButton label={t('browser.findNext')} icon={ArrowDown} onClick={() => findStep(1)} />
            <ToolButton label={t('browser.findClose')} icon={X} onClick={closeFind} />
          </div>
        ) : null}
      </div>
    </div>
  )
}
