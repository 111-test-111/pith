import { useCallback, useEffect, useRef } from 'react'
import {
  BROWSER_PARTITION,
  HUMAN_OWNER,
  buildMarkerUrl,
  parseMarkerUrl
} from '../../../../shared/browser.ts'
import type { BrowserPanePage } from '@/lib/browser/store'
import { cn } from '@/lib/utils'

/** Electron guest queries the pane needs — declared here because the renderer
 *  must not import Electron. The JSX element itself is @types/react's built-in
 *  `webview` (global `HTMLWebViewElement`), which already carries `src` and
 *  `partition`; the ref holds that element and event/style access is plain DOM. */
export interface BrowserWebviewElement {
  getURL(): string
  getWebContentsId(): number
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

export interface BrowserPageViewProps {
  page: BrowserPanePage
  /** Whether the page strip has this page selected. */
  selected: boolean
  onNavChange: (id: string, patch: BrowserNavPatch) => void
}

/**
 * One embedded-browser page: ONE always-mounted `<webview>` whose initial src
 * is the page's marker URL (the main process discovers the guest through it
 * and registers ownership). All pages of the pane stay mounted — unmounting a
 * webview destroys the guest (page state and history are lost) — so the pane
 * hosts every page at full size and only the VISIBILITY differs:
 *
 * - selected page: normal;
 * - unselected HUMAN page: `display: none`;
 * - unselected AGENT page (`owner !== HUMAN_OWNER`): `opacity: 0` +
 *   `pointerEvents: none`, still full size — NEVER `display: none`. Under
 *   `display: none` the agent's click times out, screenshots hang and text
 *   input silently does nothing (pi-web's electron-webview-spike finding);
 *   background agent driving needs the opacity form.
 */
export function BrowserPageView({ page, selected, onNavChange }: BrowserPageViewProps) {
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

  useEffect(() => {
    const wv = webviewRef.current
    if (!wv) return
    const onDomReady = () => {
      // T9: re-apply zoom on every dom-ready (not latched)
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
      const raw = (event as unknown as { url?: string }).url ?? ''
      // Loading the initial marker src is not a real navigation: keep it out
      // of localNav so the strip keeps its about:blank display semantics.
      if (parseMarkerUrl(raw)) return
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
      // Same-document navigation does not reset the title — did-navigate /
      // page-title-updated arrive in either order and a reset here would drop
      // a title that got there first.
      onNavChange(page.id, { url: e.url })
    }
    const onTitle = (event: Event) => {
      const title = (event as unknown as { title?: string }).title ?? ''
      onNavChange(page.id, { title })
    }
    const onFavicon = (event: Event) => {
      // Candidates follow the site's declaration order; the last is usually
      // the largest / most refined one (e.g. apple-touch-icon).
      const favicons = (event as unknown as { favicons?: string[] }).favicons ?? []
      const favicon = favicons.length > 0 ? favicons[favicons.length - 1] : null
      onNavChange(page.id, { favicon })
    }
    wv.addEventListener('dom-ready', onDomReady)
    wv.addEventListener('did-navigate', onNav)
    wv.addEventListener('did-navigate-in-page', onNavInPage)
    wv.addEventListener('page-title-updated', onTitle)
    wv.addEventListener('page-favicon-updated', onFavicon)
    return () => {
      wv.removeEventListener('dom-ready', onDomReady)
      wv.removeEventListener('did-navigate', onNav)
      wv.removeEventListener('did-navigate-in-page', onNavInPage)
      wv.removeEventListener('page-title-updated', onTitle)
      wv.removeEventListener('page-favicon-updated', onFavicon)
    }
  }, [page.id, page.owner, onNavChange])

  // IRON RULE: an unselected agent page must never take `display: none` —
  // keep it hosted at full size, invisible and pointer-transparent.
  const backgroundAgent = !selected && page.owner !== HUMAN_OWNER
  return (
    <div
      data-browser-page={page.id}
      className={cn('absolute inset-0', !selected && !backgroundAgent && 'hidden')}
      style={backgroundAgent ? { opacity: 0, pointerEvents: 'none' } : undefined}
    >
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
    </div>
  )
}
