import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { FocusEvent, JSX, MouseEvent } from 'react'
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Download, Globe, PencilLine, RefreshCw, X, ZoomIn, ZoomOut, type IconComponent } from '@/lib/icons'
import { Button } from '@/components/motion/button'
import { Input } from '@/components/motion/input'
import { Tooltip } from '@/components/motion/tooltip'
import { LoaderProgress } from '@/components/motion/loader'
import { useI18n } from '@/i18n'
import {
  BROWSER_PARTITION,
  HUMAN_OWNER,
  buildMarkerUrl,
  isAllowedNavigationUrl,
  resolveBrowserInput,
  parseMarkerUrl,
  type BrowserDownloadInfo
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
import { INITIAL_DEVICE_STATE, resolveDeviceSize, type DeviceEmulationState } from '@/lib/browser/device'
import {
  effectiveWebviewZoom,
  getBrowserZoom,
  nextBrowserZoom,
  setBrowserZoom,
  subscribeBrowserZoom
} from '@/lib/browser/zoom'
import { cn } from '@/lib/utils'
import { useBrowserSearchEngine } from '@/lib/browser/search-engine'
import { useBrowserLoadingProgress } from '@/lib/browser/use-loading-progress'
import { BrowserOverlays } from './BrowserOverlays'
import { BrowserAnnotate } from './BrowserAnnotate'

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
  clearHistory(): void
  reload(): void
  loadURL(url: string): Promise<void>
  setZoomFactor(factor: number): void
  /** In-page find + print (Task 12) — the webview's own DOM API. `findNext:
   *  true` is the only shape that reports `found-in-page` on a webview guest
   *  (measured: `false` yields no event at all, so the counter never renders),
   *  and it also continues the live session — a step moves the active match by
   *  exactly one. The ordinal it starts from follows Chromium's continuation
   *  rule (it can be >1 when the document carries a selection), so the UI never
   *  assumes a starting ordinal. */
  findInPage(text: string, options?: { forward?: boolean; findNext?: boolean; matchCase?: boolean }): number
  stopFindInPage(action: 'clearSelection' | 'keepSelection' | 'activateSelection'): void
  print(): Promise<void>
  /** Annotation mode (Task 16): runs the elementFromPoint resolver inside
   *  the LIVE guest document — the webview's execution channel always binds
   *  the current document, unlike a service-side Page (pi-web measured trap). */
  executeJavaScript(code: string): Promise<unknown>
  /** Annotation wheel forwarding: host-pixel mouseWheel with PURE pixel
   *  deltas — payloads carrying wheelTicks or precise-scrolling flags are
   *  silently swallowed by guests. Rejects (async) when the guest is not
   *  ready/destroyed; throws synchronously before dom-ready. */
  sendInputEvent(event: { type: 'mouseWheel'; x: number; y: number; deltaX: number; deltaY: number }): Promise<void>
  /** Live document title — the annotation payload's <title> prefers it over
   *  the pane's display meta. */
  getTitle(): string
  /** The element's box in the wrap (annotation coordinates are measured
   *  against it — device mode pins the element, so it is never assumed). */
  getBoundingClientRect(): DOMRect
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
  /** The toolbar's whitelist-gated navigation — the T13 history rows ride it
   *  so a history click lands on the CURRENT page through the same funnel. */
  loadUrl: (raw: string) => string | null
}

export interface BrowserPageViewProps {
  page: BrowserPanePage
  /** Whether the page strip has this page selected. */
  selected: boolean
  /** Display url of this page (localNav truth, markers shown as about:blank) —
   *  drives the URL input and the start-page overlay. */
  displayUrl: string
  onNavChange: (id: string, patch: BrowserNavPatch) => void
  /** Task 15: fired once from the dom-ready handshake with the guest's
   *  webContentsId, so the pane can keep its wcId → page-ownership map (popup
   *  owner inheritance). Optional; only the pane binds it. */
  onWebContentsId?: (webContentsId: number, id: string, owner: string) => void
  /** Marker-stall recovery generation: changing the key destroys the old CDP-invisible guest and creates a new target with a fresh marker handshake; re-reporting alone cannot fix an attach race. */
  restart?: number
  /** Restore spawn delay in ms. Mount the element/row chrome immediately, but delay src to avoid Invalid guestInstanceId races from simultaneous guest creation. */
  spawnDelay?: number
  /** Registers the SELECTED page's find/print surface with the pane, so the
   *  pane-level ⌘F/⌘P shortcuts (and the guest relay) act on the page on
   *  screen without reaching into any webview element. Called with null on
   *  deselect/unmount. */
  bindPageActions?: (actions: BrowserPageActions | null) => void
  /** Newest completed download (pane-store driven, toolbar-level — T14): it
   *  survives page switches because the pane owns the store ring, not this
   *  per-page view. */
  download?: BrowserDownloadInfo | null
  /** True only while the browser pane's rail tab is the active one (threaded
   *  from BrowserPane): the annotate mode's Esc exit listens only then, and
   *  losing activity exits the mode — a hidden keep-alive page must not hold
   *  a capture layer or consume keystrokes. */
  active: boolean
}

/** A queued find step waits this long for the previous request to report.
 *  Chromium's own find-next latency is ~3ms on a 3-match page and ~100ms on a
 *  3000-match one (measured in check-browser-ui), so this only matters when a
 *  payload never arrives at all. */
const FIND_STEP_SETTLE_MS = 250
/** Backlog cap for held-key repeats: queuing more than this would trail the
 *  user's intent by seconds (each step costs a guest round trip). */
const FIND_STEP_QUEUE_LIMIT = 10
/** Beat between a request's payload and the next queued request. Firing the
 *  next one in the same tick as the payload was measured to make one press in ~5
 *  report an unchanged ordinal (Chromium is still settling the match it just
 *  activated), so the queue waits before draining the next press. */
const FIND_STEP_GRACE_MS = 120

/** Icon-only toolbar button (the FilesPane ToolButton pattern). `className`
 *  lets a caller re-tint the glyph (the failed-download indicator). */
function ToolButton({ label, icon: Icon, onClick, className, pressed, disabled }: { label: string; icon: IconComponent; onClick: () => void; className?: string; pressed?: boolean; disabled?: boolean }) {
  return (
    <Tooltip content={label}>
      <Button variant="ghost" size="icon" className={cn('size-7 shrink-0', className)} aria-label={label} aria-pressed={pressed} onClick={onClick} disabled={disabled}>
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

/** Rest-state address-bar text: the scheme and a leading www. are noise to
 *  read (the omnibox convention). The FOCUSED field shows the full url. */
function prettyBrowserUrl(url: string): string {
  if (!url) return url
  const stripped = url.replace(/^https?:\/\/(?:www\.)?/i, '')
  return stripped.length > 0 ? stripped : url
}

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
            <p className="px-1 text-left text-caption font-medium uppercase tracking-wide text-muted-foreground/70">
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
export function BrowserPageView({ page, selected, displayUrl, onNavChange, onWebContentsId, bindPageActions, download, active, restart, spawnDelay }: BrowserPageViewProps) {
  const { t } = useI18n()
  const webviewRef = useRef<HTMLWebViewElement | null>(null)
  const { browserSearchEngine } = useBrowserSearchEngine()
  const loadingProgress = useBrowserLoadingProgress(webviewRef, restart)
  const wrapRef = useRef<HTMLDivElement>(null)
  // The device frame RING (T14): a sibling that draws the bezel AROUND the
  // pinned webview — never a border on the webview element itself, which
  // (border-box) would shrink the guest below the pinned size.
  const frameRef = useRef<HTMLDivElement | null>(null)
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
  // Guest remount (the pane's self-heal step two): a restarting row's webview
  // is REMOUNTED (key change below) because its old guest is invisible to the
  // service's CDP connection and can never register — the NEW guest must run
  // the marker handshake again (the latch is one-shot per guest, not per row).
  useEffect(() => {
    if ((restart ?? 0) > 0) handshakeCompleteRef.current = false
  }, [restart])
  // Deferred spawn (restore rows): the element exists immediately, its src lands
  // after spawnDelay — the strip paints at once while the guests are born one
  // after another instead of in a batch (the dead-guest trigger).
  const [srcReady, setSrcReady] = useState(!((spawnDelay ?? 0) > 0))
  useEffect(() => {
    if (srcReady || !((spawnDelay ?? 0) > 0)) return
    const timer = window.setTimeout(() => setSrcReady(true), spawnDelay ?? 0)
    return () => window.clearTimeout(timer)
  }, [spawnDelay, srcReady])
  // Most recent committed url on this guest (marker loads excluded): the
  // page-title / page-favicon history backfills attach to it.
  const lastNavUrlRef = useRef('')
  // Origin of the previous document. A REF, not an effect-local: the listener
  // effect re-registers when its props change (a popup row turning into its
  // server row changes `navigateTo`), and a reset local would classify the next
  // same-site navigation as cross-site and clear the favicon for one beat.
  const prevOriginRef = useRef('')
  // The strip's current display url (localNav truth): the did-navigate handler
  // reads it through this ref so its listener effect stays decoupled (the
  // pageZoomRef pattern). Used to detect "navigating to the url we already
  // show" — a snapshot-restore prewrite — whose title/favicon must survive.
  const displayUrlRef = useRef(displayUrl)
  useEffect(() => { displayUrlRef.current = displayUrl }, [displayUrl])
  // History enablement for the toolbar's Back/Forward: the element's own
  // canGoBack()/canGoForward(), refreshed on every committed navigation, so
  // the buttons are clickable only when they are meaningful. The spawn jump
  // (marker → first real url) would otherwise leave the marker as a history
  // entry: canGoBack() true on a fresh tab, and Back navigates INTO the blank
  // marker — the page empties and the title falls back to the raw url.
  const [navFlags, setNavFlags] = useState({ back: false, forward: false })
  // One-shot per guest (reset on remount): the FIRST committed real
  // navigation clears the spawn-marker history entry.
  const historyBaseClearedRef = useRef(false)
  useEffect(() => {
    if ((restart ?? 0) > 0) {
      historyBaseClearedRef.current = false
      setNavFlags({ back: false, forward: false })
    }
  }, [restart])
  // Draft semantics (Ruling I — binding): null = not editing, the input shows
  // the LIVE navigation url (displayUrl), so link clicks, redirects and
  // Back/Forward always flow through. A change (focus + typing) holds the
  // draft; blur releases it at once, a successful Enter submit holds it until
  // the live url catches up (the effect below) so the field never flashes the
  // previous url while the navigation commits.
  const [urlDraft, setUrlDraft] = useState<string | null>(null)
  const [urlError, setUrlError] = useState(false)
  const urlErrorTimerRef = useRef<number | null>(null)
  // Whether the address bar holds DOM focus: while FOCUSED the field keeps
  // the FULL url (the editing context — typing replaces it, selected); the
  // rest state (unfocused) shows the trimmed form.
  const urlFieldFocusedRef = useRef(false)
  // A submitted draft releases once the LIVE navigation url reaches it: the
  // field keeps showing the typed text through the load (blur releases at any
  // time). While focused it stays in the full-url form; after release the
  // unfocused field returns the trimmed display.
  useEffect(() => {
    if (urlDraft === null || displayUrl !== urlDraft) return
    if (urlFieldFocusedRef.current) return
    setUrlDraft(null)
  }, [displayUrl, urlDraft])

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

  // ---- device emulation (T14) ----
  // Selection-scoped view state (spec: lives in the component, NOT persisted;
  // switching the selected page resets to none): each page view resets whenever
  // it gains OR loses selection, so every newly selected page starts at
  // full-fill and no hidden background page keeps a stale pin.
  const [device, setDevice] = useState<DeviceEmulationState>(INITIAL_DEVICE_STATE)
  const wasSelectedRef = useRef(selected)
  useEffect(() => {
    if (wasSelectedRef.current === selected) return
    wasSelectedRef.current = selected
    setDevice(INITIAL_DEVICE_STATE)
  }, [selected])
  // The size the webview element is pinned to while a device is active; null
  // = full-fill. Guest zoom (setZoomFactor) keeps applying INSIDE the guest —
  // it is content zoom and does not interact with the element's box.
  const deviceSize = resolveDeviceSize(device)

  // ---- In-page find (Task 12) ----
  // The bar's state lives in THIS view's lifecycle: only the selected page
  // renders it, and losing selection closes it (effect below), so switching
  // pages never carries a bar or a stale counter across.
  const [findOpen, setFindOpen] = useState(false)
  const [findQuery, setFindQuery] = useState('')
  /** Last found-in-page payload; `final` marks the settled count. */
  const [findCount, setFindCount] = useState<{ ordinal: number; matches: number; final: boolean } | null>(null)
  const findInputRef = useRef<HTMLInputElement | null>(null)
  // Mirrors for the code that must not depend on fresh renders: the
  // found-in-page listener is attached once, and closeFind runs from effects.
  const findOpenRef = useRef(false)
  const lastFindTextRef = useRef('')
  const findQueryRef = useRef('')
  /** Step queue: one find request in flight, further presses accumulate. */
  const findQueueRef = useRef<{
    pending: number
    inFlight: boolean
    timer: number | null
  }>({ pending: 0, inFlight: false, timer: null })
  const settleTimeoutRef = useRef<() => void>(() => {})
  useEffect(() => { findQueryRef.current = findQuery }, [findQuery])

  const openFind = useCallback(() => {
    findOpenRef.current = true
    setFindOpen(true)
    // Already open (⌘F again): the field just takes focus. Freshly opened:
    // the mount-focus effect below runs once the bar exists.
    findInputRef.current?.focus()
  }, [])

  /** Drop queued steps and any pending settle: the query they belonged to is
   *  gone (bar closed, a new query replaced it, or the document navigated). */
  const resetFindQueue = useCallback(() => {
    const queue = findQueueRef.current
    queue.pending = 0
    queue.inFlight = false
    if (queue.timer !== null) { window.clearTimeout(queue.timer); queue.timer = null }
  }, [])

  const closeFind = useCallback(() => {
    findOpenRef.current = false
    setFindOpen(false)
    setFindCount(null)
    lastFindTextRef.current = ''
    resetFindQueue()
    const wv = webviewRef.current as unknown as BrowserWebviewElement | null
    try { wv?.stopFindInPage('clearSelection') } catch { /* guest not ready */ }
  }, [resetFindQueue])

  /** One find step against the guest. Changed query text tears the previous
   *  session down first, so the fresh find starts from the top instead of
   *  continuing the old one. */
  const runFind = useCallback((text: string, backward = false) => {
    const wv = webviewRef.current as unknown as BrowserWebviewElement | null
    if (!wv || text.length === 0) return
    const inputHadFocus = document.activeElement === findInputRef.current
    const startsSession = text !== lastFindTextRef.current
    try {
      // A changed query tears the previous session down so the fresh find does
      // not resume mid-document; a follow-up step keeps the live session.
      if (startsSession) {
        // A new query supersedes whatever is still queued for the old one.
        resetFindQueue()
        wv.stopFindInPage('clearSelection')
        // The old query's ordinal/total must not be read as this one's.
        setFindCount(null)
      }
      // findNext: true is the only shape that emits `found-in-page` on a webview
      // guest — measured in check-browser-ui: a session started with `false`
      // produces NO event at all (so the counter stays blank), while `true`
      // advances the live session and keeps reporting. Follow-up steps therefore
      // send `true` as well; they CONTINUE the session rather than restarting it
      // (the step ordinal is measured to move by exactly one).
      wv.findInPage(text, { forward: !backward, findNext: true })
      lastFindTextRef.current = text
    } catch { /* guest not ready — the next edit retries */ }
    // findInPage can hand keyboard focus to the guest; take it straight back
    // so typing in the field keeps flowing (only when the field had it).
    if (inputHadFocus) findInputRef.current?.focus()
  }, [resetFindQueue])

  /** Put ONE step on the wire (the queue's drain lands here). */
  const sendFindStep = useCallback((direction: 1 | -1) => {
    const queue = findQueueRef.current
    const wv = webviewRef.current as unknown as BrowserWebviewElement | null
    const text = findQueryRef.current
    if (!wv || text.length === 0) { queue.pending = 0; queue.inFlight = false; return }
    queue.inFlight = true
    if (queue.timer !== null) window.clearTimeout(queue.timer)
    queue.timer = window.setTimeout(() => { settleTimeoutRef.current() }, FIND_STEP_SETTLE_MS)
    const inputHadFocus = document.activeElement === findInputRef.current
    try {
      // findNext: true is the only shape that emits `found-in-page` on a webview
      // guest (measured: `false` produces no event at all, so the counter would
      // stay blank) and it continues the live session — one step, one match.
      wv.findInPage(text, { forward: direction === 1, findNext: true })
    } catch { queue.inFlight = false }
    if (inputHadFocus) findInputRef.current?.focus()
  }, [])

  /**
   * Drain one queued press. Only ONE request is ever in flight: Chromium drops
   * find-next requests that arrive while a search is running (measured in
   * check-browser-ui: a tight burst of 5 presses produced 3 payloads and
   * advanced 2 matches), so rapid presses are queued here and sent one at a
   * time rather than being silently coalesced away. Focus was never the cause —
   * it stays in the field, measured flat, 3000-match and subframe fixtures.
   */
  const runFindSteps = useCallback(() => {
    const queue = findQueueRef.current
    if (queue.inFlight || queue.pending === 0) return
    const direction = queue.pending > 0 ? 1 : -1
    queue.pending -= direction
    sendFindStep(direction)
  }, [sendFindStep])

  /**
   * A request settled: its payload arrived, or nothing came back in time. The
   * next queued press goes out after a beat — that gap is what keeps Chromium
   * from collapsing the request, and it is the ONLY protection the queue can
   * offer: the payload's ordinal is not a reliable liveness signal (measured: a
   * paced burst on a 3-match page repeats one ordinal, while the same burst on a
   * 3000-match page advances monotonically 3,4,5,6,7). Re-issuing on a repeated
   * ordinal would therefore double-step a press that had already landed, and the
   * highlight itself is not observable (Chromium paints find matches without
   * leaving a DOM selection; the guest's `window.getSelection()` stays empty).
   */
  const confirmFindStep = useCallback(() => {
    const queue = findQueueRef.current
    if (queue.timer !== null) { window.clearTimeout(queue.timer); queue.timer = null }
    if (!queue.inFlight) return
    queue.inFlight = false
    if (queue.pending === 0) return
    queue.timer = window.setTimeout(() => { queue.timer = null; runFindSteps() }, FIND_STEP_GRACE_MS)
  }, [runFindSteps])

  /** No payload inside the settle window: release the queue for the next press. */
  const settleTimeout = useCallback(() => { confirmFindStep() }, [confirmFindStep])
  useEffect(() => { settleTimeoutRef.current = settleTimeout }, [settleTimeout])

  /** A press on Enter/Shift+Enter or the △▽ buttons: queued, never dropped. */
  const findStep = useCallback((direction: 1 | -1) => {
    if (findQueryRef.current.length === 0) return
    const queue = findQueueRef.current
    queue.pending = Math.max(-FIND_STEP_QUEUE_LIMIT, Math.min(FIND_STEP_QUEUE_LIMIT, queue.pending + direction))
    runFindSteps()
  }, [runFindSteps])

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

  // ---- annotation mode (Task 16) ----
  // Per-page selection-scoped view state, like the device state above: only
  // the selected page renders the capture layer, and losing selection OR the
  // pane's active rail tab exits the mode, so every newly selected page
  // starts clean and a hidden keep-alive page never holds a capture layer.
  const [annotating, setAnnotating] = useState(false)
  const exitAnnotate = useCallback(() => setAnnotating(false), [])
  useEffect(() => {
    if (!selected || !active) setAnnotating(false)
  }, [active, selected])

  const printPage = useCallback(() => {
    const wv = webviewRef.current as unknown as BrowserWebviewElement | null
    if (!wv) return
    try { void wv.print().catch(() => { /* a failed print is the guest's to render */ }) } catch { /* guest not ready */ }
  }, [])

  // The guest follows the element layout, but under "display:none → visible"
  // and panel open/close animations it can end up stuck at a shrunken size
  // (measured in pi-web) — drive it explicitly in pixels. A display:none
  // wrapper reports 0×0: leave it alone; becoming visible re-fires this.
  // Device mode (T14) pins the element to min(device, container) instead —
  // ELEMENT-LEVEL VIEWPORT ONLY, deliberately NO CDP setDeviceMetricsOverride:
  // the annotation coordinate invariant "guest viewport == element" depends on
  // the element and the guest viewport staying the same surface (device.ts
  // header note), and CDP metrics would break it while changing the render
  // shape. The visible frame therefore lives on the ring SIBLING (frameRef),
  // not on the element's own border — with Tailwind's border-box preflight a
  // border here would make the pinned values the border box and hand the
  // guest pinned − 2px per axis. The applied size reaches this callback
  // through a ref so it stays dependency-free (the ResizeObserver below never
  // re-subscribes per edit).
  const deviceSizeRef = useRef<{ width: number; height: number } | null>(null)
  const syncSize = useCallback(() => {
    const wrap = wrapRef.current
    const wv = webviewRef.current
    if (!wrap || !wv) return
    const width = wrap.clientWidth
    const height = wrap.clientHeight
    if (width === 0 || height === 0) return
    const pinned = deviceSizeRef.current
    const frame = frameRef.current
    if (pinned) {
      const pinWidth = Math.min(pinned.width, width)
      const pinHeight = Math.min(pinned.height, height)
      wv.style.width = `${pinWidth}px`
      wv.style.height = `${pinHeight}px`
      // The ring is written to pinned + 2 per axis (border-box), so its 1px
      // border sits exactly outside the pinned element and the guest keeps
      // the exact preset size. It renders only while a device is active.
      if (frame) {
        frame.style.width = `${pinWidth + 2}px`
        frame.style.height = `${pinHeight + 2}px`
      }
    } else {
      wv.style.width = `${width}px`
      wv.style.height = `${height}px`
    }
  }, [])
  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return
    const observer = new ResizeObserver(() => syncSize())
    observer.observe(wrap)
    syncSize()
    return () => observer.disconnect()
  }, [syncSize])
  // A device change re-pins immediately (the ResizeObserver only fires on
  // container resizes, not on this state change). A LAYOUT effect: it must
  // size the freshly mounted frame ring before the first paint, or the ring
  // flashes stretched over the whole container for one frame.
  useLayoutEffect(() => {
    deviceSizeRef.current = deviceSize
    syncSize()
  }, [deviceSize, syncSize])

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
    // A queued step's settle timer must not outlive the pane.
    const queue = findQueueRef.current
    if (queue.timer !== null) window.clearTimeout(queue.timer)
  }, [])

  /** User-typed URL or query → resolved → whitelist-gated → guest loadURL. Returns
   *  the normalized url, or null when it does not parse OR the navigation
   *  whitelist rejects the scheme (file:/view-source:/data:/javascript: …).
   *  The URL bar is one of the entries shared/browser.ts funnels through that
   *  whitelist — the same gate the service applies to browser_navigate/goto —
   *  so no embedder-driven navigation can bypass it (both entry points here,
   *  toolbar Enter and the start-page input, route through this one call).
   *  The caller shows the error styling for null. */
  const loadUrl = useCallback((raw: string): string | null => {
    const url = resolveBrowserInput(raw, browserSearchEngine)
    const wv = webviewRef.current as unknown as BrowserWebviewElement | null
    if (!url || !isAllowedNavigationUrl(url) || !wv) return null
    void wv.loadURL(url).catch(() => { /* a failed load is the guest's to render */ })
    return url
  }, [browserSearchEngine])

  // Expose the selected page's find/print/navigation to the pane-level
  // shortcuts (⌘F/⌘P and the guest relay). Only the SELECTED view binds, so
  // the pane's actions always hit the page on screen. T13: the ⋮ menu's
  // find/print/history entries use these same callbacks directly
  // (BrowserOverlays receives the identical references).
  useEffect(() => {
    if (!selected) return
    bindPageActions?.({ openFind, print: printPage, loadUrl })
    return () => bindPageActions?.(null)
  }, [bindPageActions, loadUrl, openFind, printPage, selected])

  const navigate = useCallback((action: 'back' | 'forward' | 'reload') => {
    const wv = webviewRef.current as unknown as BrowserWebviewElement | null
    if (!wv) return
    if (action === 'back') {
      if (wv.canGoBack()) wv.goBack()
    } else if (action === 'forward') {
      if (wv.canGoForward()) wv.goForward()
    } else {
      // Reload is driven by the SERVICE for a page it owns: `goto(currentUrl)`,
      // the measured-safe shape (iron 6 — the CDP Page.reload command kills a
      // webview guest, or lands on the shell window). Only a row with no runtime
      // (a state-only registration the service never attached to) falls back to
      // the element's own reload, and that fallback is the service's answer.
      void window.pi.browserReload(page.id)
        .then((handled) => { if (!handled) wv.reload() })
        .catch(() => { try { wv.reload() } catch { /* guest gone */ } })
    }
  }, [page.id])

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
        webContentsId,
        // Task 15: only local popup rows carry one — the service stores it as
        // pendingNavigate and performs the goto itself after the reconcile
        // upgrade (the renderer never loadURLs a popup; it would lose the
        // marker race and the page would never register).
        navigateTo: page.navigateTo
      }).catch(() => { /* next reconcile pass re-registers by marker */ })
      if (webContentsId !== undefined) onWebContentsId?.(webContentsId, page.id, page.owner)
    }
    // Origin of the previous document: a cross-site navigation clears the old
    // site's favicon (the new one arrives via page-favicon-updated); a
    // same-site navigation keeps it — re-clearing would just flash a blank.
    const onNav = (event: Event) => {
      // Best-effort zoom re-apply: a committed navigation is the other moment
      // the guest may have reset its factor (applyZoom catches silently).
      applyZoom(wv as unknown as BrowserWebviewElement, pageZoomRef.current)
      const raw = (event as unknown as { url?: string }).url ?? ''
      // Loading the initial marker src is not a real navigation: keep it out
      // of localNav so the strip keeps its about:blank display semantics.
      if (parseMarkerUrl(raw)) return
      // A committed navigation tears down the annotate selection: the chosen
      // element belongs to the previous document, so keeping the highlight
      // would submit a payload mismatched with the live page.
      setAnnotating(false)
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
      const crossSite = origin !== prevOriginRef.current
      prevOriginRef.current = origin
      // The spawn jump (marker → this url) is the handshake, not user
      // history: clear it once so canGoBack()/canGoForward() describe real
      // pages only — a fresh tab's Back stays disabled instead of navigating
      // into the blank marker. Later navigations (links, address bar,
      // Back/Forward itself) keep their entries.
      try {
        const guest = wv as unknown as BrowserWebviewElement
        if (!historyBaseClearedRef.current) {
          historyBaseClearedRef.current = true
          guest.clearHistory()
        }
        setNavFlags({ back: guest.canGoBack(), forward: guest.canGoForward() })
      } catch { /* guest gone — a remount resets the latch and the flags */ }
      // The new document's title hasn't arrived: fall back to the URL first.
      // Snapshot-restore prewrite: the strip already shows this exact url's
      // title/favicon (carried through the fold) — navigating the guest there is
      // not a document change the chrome should blank them for. Without this the
      // favicon flickers (logo → generic → logo) and the title flashes to the raw
      // url while the page reloads. A redirect lands on a DIFFERENT url and keeps
      // the old reset semantics.
      const sameTarget = raw === displayUrlRef.current
      onNavChange(page.id, {
        url: raw,
        title: sameTarget ? undefined : '',
        favicon: sameTarget ? undefined : (crossSite ? null : undefined)
      })
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
      // An SPA route adds a history entry: Back to the previous route becomes
      // meaningful — refresh the enablement too.
      try {
        const guest = wv as unknown as BrowserWebviewElement
        setNavFlags({ back: guest.canGoBack(), forward: guest.canGoForward() })
      } catch { /* guest gone */ }
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
      // Only while the bar is open — a payload landing after close must not
      // resurrect it.
      if (!findOpenRef.current) return
      const result = (event as unknown as {
        result?: { finalUpdate?: boolean; activeMatchOrdinal?: number; matches?: number }
      }).result
      if (!result) return
      const ordinal = result.activeMatchOrdinal ?? 0
      const matches = result.matches ?? 0
      if (result.finalUpdate) {
        setFindCount({ ordinal, matches, final: true })
        // This request is done: a burst's next queued press may go out.
        confirmFindStep()
        return
      }
      // Intermediate payloads arrive while Chromium is still counting, so the
      // TOTAL is only trusted once settled — but the active ordinal is already
      // true at that point. Taking it immediately makes the readout track the
      // highlight instead of lagging a whole count behind each step.
      setFindCount((prev) => (prev ? { ...prev, ordinal, final: false } : { ordinal, matches, final: false }))
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
  }, [page.id, page.owner, page.navigateTo, restart, onNavChange, onWebContentsId, confirmFindStep])

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
        <div className="flex min-h-11 shrink-0 items-center gap-1 border-b border-border/40 px-2 py-0.5" data-browser-toolbar>
          <ToolButton label={t('browser.back')} icon={ArrowLeft} onClick={() => navigate('back')} disabled={!navFlags.back} />
          <ToolButton label={t('browser.forward')} icon={ArrowRight} onClick={() => navigate('forward')} disabled={!navFlags.forward} />
          <ToolButton label={t('browser.reload')} icon={RefreshCw} onClick={() => navigate('reload')} />
          {/* T16 annotate toggle: active tint follows the download indicator's
              re-tint convention; toggling off clears the selection because
              BrowserAnnotate (which owns it) unmounts. */}
          <ToolButton
            label={t('browser.annotateToggle')}
            icon={PencilLine}
            className={annotating ? 'text-primary hover:text-primary' : undefined}
            pressed={annotating}
            onClick={() => setAnnotating((v) => !v)}
          />
          <Input
            value={urlDraft ?? prettyBrowserUrl(displayUrl)}
            onChange={setUrlDraft}
            placeholder={t('browser.urlPlaceholder')}
            aria-label={t('browser.urlPlaceholder')}
            spellCheck={false}
            error={urlError}
            className="min-w-0 flex-1"

            onKeyDown={(event) => {
              if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
              const url = loadUrl(urlDraft ?? displayUrl)
              // Success KEEPS the draft: releasing it here would flash the
              // PREVIOUS live url (or about:blank) back into the field until
              // did-navigate commits — the typed text vanishing and
              // returning. The release effect above frees it the moment the
              // live url catches up, after which the field follows link
              // clicks / redirects / Back-Forward again. A failed parse keeps
              // the draft — the user is still editing.
              if (url === null) flashUrlError()
              else setUrlDraft(url)
            }}
            onFocus={() => {
              urlFieldFocusedRef.current = true
              // Focused = editing: swap to the FULL url (the rest state trims
              // the scheme/www). The swap re-renders the value, so the
              // select-all must land AFTER the commit — a synchronous select()
              // would run on the trimmed text.
              if (urlDraft === null) setUrlDraft(displayUrl)
              requestAnimationFrame(() => {
                const el = document.activeElement
                if (el instanceof HTMLInputElement) el.select()
              })
            }}
            onMouseDown={(e) => {
              if (document.activeElement !== e.currentTarget) {
                e.preventDefault()
                e.currentTarget.focus()
                e.currentTarget.select()
              }
            }}
            onBlur={() => {
              urlFieldFocusedRef.current = false
              setUrlDraft(null)
            }}
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
          {/* T14 download indicator: newest entry of the pane store's ring.
              A failed download keeps the destructive tint and its localized
              failure tooltip, and the click deliberately NO-OPS — revealing
              the folder would point at a file that never landed. */}
          {download ? (
            <ToolButton
              label={download.error ? t('browser.downloadFailed') : t('browser.downloadReveal')}
              icon={Download}
              className={download.error ? 'text-destructive hover:text-destructive' : undefined}
              onClick={() => {
                if (download.error) return
                void window.pi.showInFolder(download.path)
              }}
            />
          ) : null}
          {/* T13 ⋮ overflow menu + history panel. The callbacks are the same
              function references bound into BrowserPageActions above, so a
              menu entry and the pane-level shortcuts share one path. T14:
              device state lives here and the device sub-view edits it. */}
          <BrowserOverlays
            onFind={openFind}
            onPrint={printPage}
            onNavigate={loadUrl}
            device={device}
            onDeviceChange={setDevice}
          />
        </div>
      ) : null}
      <div ref={wrapRef} className="relative min-h-0 flex-1">
        <webview
          key={restart ?? 0}
          ref={webviewRef}
          src={srcReady ? initialSrcRef.current : undefined}
          partition={BROWSER_PARTITION}
          // allowpopups as a STRING spread (React strips boolean attributes on
          // unknown elements, so a `true` prop never reaches the DOM) — without
          // it Chromium swallows guest `window.open` before the main-process
          // popup handler ever sees it (pi-web electron-webview-spike finding).
          {...{ allowpopups: 'true' } as Record<string, string>}
          // Device mode (T14) swaps the full-fill layout for a pinned,
          // centered element inside the relative wrap (`absolute inset-0
          // m-auto` centres the explicit pixel box syncSize writes). The
          // visible device frame (bezel look, all theme tokens) lives on the
          // ring sibling below — a border ON THIS ELEMENT would shrink the
          // guest below the pinned size and dent the "guest viewport ==
          // element" invariant Task 16's annotation overlay builds on.
          className={cn(
            deviceSize
              ? 'absolute inset-0 m-auto rounded-card bg-background shadow-overlay'
              : 'h-full w-full'
          )}
        />
        {/* T14 device frame: a ring AROUND the pinned element, never a border
            on the webview itself — border-box sizing would hand the guest
            preset − 2px per axis. syncSize writes the ring to pinned + 2 per
            axis, so its border sits exactly outside the element;
            pointer-events-none keeps it click-transparent. */}
        {deviceSize ? (
          <div
            ref={frameRef}
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 m-auto rounded-card border border-border"
          />
        ) : null}
        {selected && displayUrl === 'about:blank' ? (
          <BrowserStartPage onOpen={(raw) => loadUrl(raw) !== null} />
        ) : null}
        {selected && loadingProgress !== null ? (
          <div data-browser-loading-progress className="pointer-events-none absolute inset-x-0 top-0 z-20">
            <LoaderProgress value={loadingProgress} label={t('browser.loading')} className="h-0.5 w-full text-primary" />
          </div>
        ) : null}
        {selected && annotating ? (
          <BrowserAnnotate
            wv={webviewRef.current as unknown as BrowserWebviewElement}
            wrapEl={wrapRef.current}
            pageZoom={pageZoom}
            active={active}
            onExit={exitAnnotate}
            page={{ id: page.id, url: displayUrl, title: page.title }}
          />
        ) : null}
        {findOpen ? (
          <div
            data-browser-find
            className="absolute right-2 top-2 z-10 flex min-h-9 items-center gap-0.5 rounded-control border border-border bg-background px-1 py-0.5 shadow-overlay"
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
              data-find-count
              data-find-final={findCount?.final ? 'true' : 'false'}
              className="w-16 shrink-0 text-center text-micro tabular-nums text-muted-foreground"
            >
              {findCount && findCount.matches > 0 ? t('browser.findCount', { x: findCount.ordinal, y: findCount.matches }) : ''}
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
