import { useCallback, useEffect, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import { Button } from '@/components/motion/button'
import { Input } from '@/components/motion/input'
import { useI18n } from '@/i18n'
import { guestBoxToHost, hostPointToGuest } from '@/lib/browser/zoom'
import { wheelPixels } from '@/lib/wheel-gesture'
import { isEditableTarget, type BrowserWebviewElement } from './BrowserPageView'

/**
 * Annotation mode— ported from pi-web BrowserTab.tsx's annotate
 * surface onto this app's beUI primitives. A capture layer covers the guest
 * for the WHOLE mode (even after a target is selected — unmounting it would
 * hand hover/clicks back to the page and the page would really interact), so
 * wheel scrolling must be forwarded by hand, and element resolution runs in
 * the LIVE guest document via webview.executeJavaScript.
 *
 * The measured traps this implementation honors (docs/architecture/embedded-browser.md):
 *  1. capture layer stays mounted for the whole mode (guest gets no pointer events);
 *  2. wheel forwarding: sendInputEvent mouseWheel with PURE PIXEL deltas and an
 *     INVERTED sign — payloads carrying wheelTicks or precise-scrolling flags
 *     are silently swallowed by guests;
 *  3. both axes are forwarded so diagonal swipes and direction changes reach
 *     the guest without losing either component;
 *  4. hover highlight is suppressed while scrolling and re-resolved once,
 *     250ms after the LAST wheel event (inertia keeps extending it);
 *  5. element resolution goes through the renderer-side executeJavaScript —
 *     a service-side Page lags renderer-driven navigations;
 *  6. hover resolution throttles ~80ms trailing with a sequence guard, and a
 *     click within 3px of the last hover point reuses that answer;
 *  7. host↔guest mapping: event point ÷ pageZoom in, guest rect × pageZoom
 *     out, plus the webview element's offset inside the wrap (device mode
 *     pins the element, so it is measured, never assumed);
 *  8. click inside the selected highlight = deselect; outside = re-select;
 *     the submit bubble sits above the capture layer and stays interactive;
 *  9. Esc exits — window capture + stopPropagation so the app's Esc-to-stop
 *     does not fire, only while the browser pane is the active rail tab, and
 *     a focused input/textarea/contentEditable keeps its own Esc.
 */

/** Renderer-side window event the annotation submit dispatches; Workspace
 *  subscribes and appends the composed text into the chat composer draft. */
export const BROWSER_ANNOTATION_EVENT = 'pith:browser-annotation'

/** Element resolved inside the guest document. `box` is guest CSS viewport
 *  coordinates (getBoundingClientRect) — guestBoxToHost maps it back. */
export interface BrowserElementInfo {
  tag: string
  text: string
  path: string
  box: { x: number; y: number; width: number; height: number }
}

function isElementInfo(value: unknown): value is BrowserElementInfo {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.tag === 'string' &&
    typeof v.text === 'string' &&
    typeof v.path === 'string' &&
    typeof v.box === 'object' &&
    v.box !== null
  )
}

/** In-page elementFromPoint resolver, matching pi-web/server resolveElementAt tag/text/path/box fields. Coordinates must use the guest CSS viewport. */
function buildElementAtScript(x: number, y: number): string {
  return `(() => {
    const el = document.elementFromPoint(${Math.round(x)}, ${Math.round(y)});
    if (!el || el.nodeType !== 1) return null;
    const rect = el.getBoundingClientRect();
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && parts.length < 6) {
      let part = cur.tagName.toLowerCase();
      if (cur.id) { parts.unshift(part + "#" + CSS.escape(cur.id)); break; }
      const cls = Array.from(cur.classList).slice(0, 2).map((c) => "." + CSS.escape(c)).join("");
      const parent = cur.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter((c) => c.tagName === cur.tagName);
        if (same.length > 1) part += ":nth-of-type(" + (same.indexOf(cur) + 1) + ")";
      }
      parts.unshift(part + cls);
      cur = cur.parentElement;
    }
    const raw = (el).innerText || el.getAttribute("aria-label") || el.getAttribute("alt") || el.getAttribute("href") || "";
    return {
      tag: el.tagName.toLowerCase(),
      text: String(raw).trim().slice(0, 120),
      path: parts.join(" > "),
      box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    };
  })()`
}

const HOVER_THROTTLE_MS = 80
const WHEEL_HOVER_SETTLE_MS = 250
/** A click within this distance of the last resolved hover point reuses it. */
const CLICK_REUSE_PX = 3
/** Degenerate elements (zero-area inline nodes) still get a visible box. */
const MIN_BOX_PX = 4
const BUBBLE_WIDTH = 288 // w-72
/** Placement-only estimate (label + 2-row note + buttons); the real bubble
 *  sizes to its content — this only decides above/below the highlight. */
const BUBBLE_HEIGHT_ESTIMATE = 176

export interface BrowserAnnotateProps {
  /** The guest webview element (always mounted once the toolbar exists — see
   *  BrowserPageView). Nullable in the type because it arrives through a
   *  ref; every access guards. */
  wv: BrowserWebviewElement | null
  /** The relative wrap that hosts the webview; capture/highlight/bubble are
   *  positioned inside it. Nullable for the same reason. */
  wrapEl: HTMLDivElement | null
  /** Shared page zoom (the toolbar ladder value, relative to the host UI).
   *  ÷ in for elementFromPoint points, × out for guest boxes. */
  pageZoom: number
  /** True only while the browser pane's rail tab is the active one: the Esc
   *  exit listens only then, so a hidden keep-alive layer never consumes it. */
  active: boolean
  /** Leave annotate mode entirely (toolbar toggle off / submit / Esc). */
  onExit: () => void
  /** Display truth for the composed annotation text. */
  page: { id: string; url: string; title: string }
}

export function BrowserAnnotate({ wv, wrapEl, pageZoom, active, onExit, page }: BrowserAnnotateProps) {
  const { t } = useI18n()
  const [annotation, setAnnotation] = useState<BrowserElementInfo | null>(null)
  const [comment, setComment] = useState('')
  const [hover, setHover] = useState<BrowserElementInfo | null>(null)
  const noteRef = useRef<HTMLDivElement | null>(null)
  const captureRef = useRef<HTMLDivElement | null>(null)

  // High-frequency paths (mousemove/wheel handlers and the async resolution
  // answers) read these refs instead of closing over render values.
  const wvRef = useRef(wv)
  const wrapRef = useRef(wrapEl)
  const pageZoomRef = useRef(pageZoom)
  useEffect(() => {
    wvRef.current = wv
    wrapRef.current = wrapEl
    pageZoomRef.current = pageZoom
  }, [wv, wrapEl, pageZoom])

  // ---- hover throttle / race state (refs: no re-render per mousemove) ----
  // Last mousemove point, in guest CSS coordinates.
  const hoverPointRef = useRef<{ x: number; y: number } | null>(null)
  // The point the LATEST request was fired for (written on request — earlier
  // than its answer — so click-reuse judges against the request's point).
  const hoverResolvedRef = useRef<{ x: number; y: number } | null>(null)
  // The point `hover` actually corresponds to.
  const hoverInfoPointRef = useRef<{ x: number; y: number } | null>(null)
  const hoverTimerRef = useRef<number | null>(null)
  // Post-scroll settle timer (scrolling suppresses the hover highlight).
  const wheelSettleTimerRef = useRef<number | null>(null)
  // Sequence guard: only the newest request's answer may render.
  const hoverSeqRef = useRef(0)

  const resetHover = useCallback(() => {
    if (hoverTimerRef.current !== null) {
      window.clearTimeout(hoverTimerRef.current)
      hoverTimerRef.current = null
    }
    // A pending post-scroll settle resolve is stale for every reset path
    // (mouseleave, deselect, exit) — cancel it with the rest.
    if (wheelSettleTimerRef.current !== null) {
      window.clearTimeout(wheelSettleTimerRef.current)
      wheelSettleTimerRef.current = null
    }
    hoverPointRef.current = null
    hoverResolvedRef.current = null
    hoverInfoPointRef.current = null
    setHover(null)
  }, [])

  // Clear the trailing timers when the mode leaves (unmount). The refs' other
  // state dies with the component.
  useEffect(
    () => () => {
      if (hoverTimerRef.current !== null) window.clearTimeout(hoverTimerRef.current)
      if (wheelSettleTimerRef.current !== null) window.clearTimeout(wheelSettleTimerRef.current)
    },
    []
  )

  /** Resolve an element at guest CSS viewport coordinates through the live
   *  guest document (renderer-side executeJavaScript — never a service-side
   *  Page, which lags renderer-driven navigations). */
  const resolveElementAt = useCallback(
    async (guestX: number, guestY: number): Promise<BrowserElementInfo | null> => {
      const guest = wvRef.current
      if (guest) {
        try {
          const result: unknown = await guest.executeJavaScript(buildElementAtScript(guestX, guestY))
          if (isElementInfo(result)) return result
        } catch {
          /* guest not ready / destroyed / mid-navigation — fall through */
        }
      }
      // Fallback: the service resolves through its own CDP runtime. It can lag a
      // renderer-driven navigation (which is why the live-document path above is
      // primary), but it is the only channel left when the guest's own is
      // unusable — and it is the reason `browser:elementAt` exists.
      try {
        const info = await window.pi.browserElementAt(page.id, Math.round(guestX), Math.round(guestY))
        return info && isElementInfo(info) ? info : null
      } catch {
        return null
      }
    },
    [page.id]
  )

  const resolveHover = useCallback(async () => {
    const pt = hoverPointRef.current
    if (!pt) return
    const last = hoverResolvedRef.current
    if (last && Math.hypot(pt.x - last.x, pt.y - last.y) < CLICK_REUSE_PX) return // sub-jitter, keep the current answer
    const seq = ++hoverSeqRef.current
    hoverResolvedRef.current = pt
    const info = await resolveElementAt(pt.x, pt.y)
    if (seq !== hoverSeqRef.current) return // a newer round (or a click/exit) superseded this one
    if (!info) {
      hoverInfoPointRef.current = null
      setHover(null)
      return
    }
    hoverInfoPointRef.current = pt
    setHover(info)
  }, [resolveElementAt])

  const scheduleHover = useCallback(() => {
    if (hoverTimerRef.current !== null) return
    hoverTimerRef.current = window.setTimeout(() => {
      hoverTimerRef.current = null
      void resolveHover()
    }, HOVER_THROTTLE_MS)
  }, [resolveHover])

  const cancelSelection = useCallback(() => {
    setAnnotation(null)
    setComment('')
    resetHover()
  }, [resetHover])

  const exit = useCallback(() => {
    cancelSelection()
    onExit()
  }, [cancelSelection, onExit])

  // Esc exits annotate mode — window CAPTURE phase + stopPropagation, so the
  // app's Esc-to-stop never fires for the same keystroke. Bound only while
  // the browser pane is the active rail tab; a focused text field (the note
  // input, the URL bar, the composer) keeps its own Esc semantics.
  useEffect(() => {
    if (!active) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      // An open modal owns Escape: CenterMorphModal's own handler bails on
      // `defaultPrevented`, so fencing the keystroke here would leave the dialog
      // open while annotate mode exited underneath it (Esc-to-stop reserves
      // [aria-modal="true"] the same way). Let the overlay close first.
      if (document.querySelector('[aria-modal="true"]')) return
      if (isEditableTarget(event.target)) return
      event.preventDefault()
      event.stopPropagation()
      // A focused button would keep its :focus-visible ring after exit — move
      // focus off with it.
      ;(document.activeElement as HTMLElement | null)?.blur?.()
      exit()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [active, exit])

  // Wheel forwarding for the whole annotate mode. The capture layer swallows
  // every pointer event, so without this the page could not scroll at all.
  // Pure pixel deltas, INVERTED sign, retaining both axes (see header).
  useEffect(() => {
    const capture = captureRef.current
    const guest = wvRef.current
    const wrap = wrapRef.current
    if (!capture || !guest || !wrap) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault() // the host has no scroll container; also stops ctrl+wheel shell zoom
      // Wheel coordinates stay in webview-element space (host pixels) — the
      // guest hit-tests them as rendered; only elementFromPoint ÷ pageZoom.
      const rect = guest.getBoundingClientRect()
      const x = e.clientX - rect.left
      const y = e.clientY - rect.top
      const input = wheelPixels(e, wrap, 40)
      if (!input.deltaX && !input.deltaY) return
      try {
        // The real webview API returns a promise — a wheel on a not-ready or
        // destroyed guest rejects asynchronously, which a bare try/catch
        // cannot see (pi-web caught it; so do we).
        void guest.sendInputEvent({ type: 'mouseWheel', x, y, deltaX: -input.deltaX, deltaY: -input.deltaY }).catch(() => {
          /* guest not ready / destroyed — drop the event (async rejection) */
        })
      } catch {
        /* guest not ready / destroyed — drop the event (sync throw) */
      }
      // Scrolling hides the hover highlight (a box jumping with the scroll is
      // flicker); the resting point is resolved once, 250ms after the LAST
      // event — macOS inertia keeps extending the timer.
      setHover(null)
      hoverResolvedRef.current = null
      hoverInfoPointRef.current = null
      hoverPointRef.current = hostPointToGuest({ x, y }, pageZoomRef.current)
      if (wheelSettleTimerRef.current !== null) window.clearTimeout(wheelSettleTimerRef.current)
      wheelSettleTimerRef.current = window.setTimeout(() => {
        wheelSettleTimerRef.current = null
        void resolveHover()
      }, WHEEL_HOVER_SETTLE_MS)
    }
    capture.addEventListener('wheel', onWheel, { passive: false })
    return () => capture.removeEventListener('wheel', onWheel)
  }, [resolveHover])

  // Click semantics (trap 8): inside the current highlight = deselect back to
  // picking; outside = select the element at the click. A click <3px from the
  // point the current hover answer was resolved for applies it immediately.
  const pickElementAt = useCallback(
    (e: ReactMouseEvent) => {
      const guest = wvRef.current
      if (!guest) return
      const rect = guest.getBoundingClientRect()
      const { x, y } = hostPointToGuest(
        { x: e.clientX - rect.left, y: e.clientY - rect.top },
        pageZoomRef.current
      )
      if (annotation) {
        const b = annotation.box
        const inside = x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height
        if (inside) {
          cancelSelection()
          return
        }
      }
      const apply = (info: BrowserElementInfo) => {
        hoverSeqRef.current++ // invalidate any in-flight hover answer
        hoverInfoPointRef.current = null
        setHover(null)
        setAnnotation(info)
        setComment('')
      }
      const infoAt = hoverInfoPointRef.current
      if (!annotation && infoAt && hover && Math.hypot(x - infoAt.x, y - infoAt.y) < CLICK_REUSE_PX) {
        apply(hover)
        return
      }
      void (async () => {
        const info = await resolveElementAt(x, y)
        if (info) apply(info)
      })()
    },
    [annotation, hover, resolveElementAt, cancelSelection]
  )

  // Submit: compose the annotation text, dispatch it to the composer, and
  // leave annotate mode with the selection cleared. Lines with empty values
  // are omitted (the note is optional by definition) — the `[Page annotation]`
  // header, the element line and the page identity are the stable format.
  const submit = useCallback(() => {
    if (!annotation) return
    const note = comment.trim()
    let title = page.title
    try {
      const live = wvRef.current?.getTitle()
      if (live) title = live
    } catch {
      /* guest not ready — the display fallbacks carry the payload */
    }
    if (!title) title = page.url
    // The payload becomes the user's own message, so every label is localized
    // (hard-coded prose here shipped a Chinese block to English users).
    const lines = [
      t('browser.annotateHeader', { title, url: page.url }),
      t('browser.annotateElement', { tag: annotation.tag, path: annotation.path }),
    ]
    if (annotation.text) lines.push(t('browser.annotateText', { text: annotation.text }))
    if (note) lines.push(t('browser.annotateNote', { note }))
    window.dispatchEvent(new CustomEvent(BROWSER_ANNOTATION_EVENT, { detail: { text: lines.join('\n') } }))
    exit()
  }, [annotation, comment, page.title, page.url, exit, t])

  // Mount focus for the note field (after selection exists) — the vendored
  // Input renders the field inside a wrapper, so focus it like selectStarter.
  useEffect(() => {
    if (!annotation) return
    const field = noteRef.current?.querySelector('textarea, input')
    if (field instanceof HTMLElement) field.focus()
  }, [annotation])

  /** guest box → absolute position inside the wrap (guestOffset + ×pageZoom). */
  const boxInWrap = (info: BrowserElementInfo) => {
    const wrap = wrapRef.current
    const guest = wvRef.current
    if (!wrap || !guest) return null
    const wrapRect = wrap.getBoundingClientRect()
    const guestRect = guest.getBoundingClientRect()
    const box = guestBoxToHost(info.box, pageZoom)
    return {
      left: guestRect.left - wrapRect.left + box.x,
      top: guestRect.top - wrapRect.top + box.y,
      width: Math.max(box.width, MIN_BOX_PX),
      height: Math.max(box.height, MIN_BOX_PX),
    }
  }

  const highlight = annotation ? boxInWrap(annotation) : null
  const hoverBox = !annotation && hover ? boxInWrap(hover) : null
  // The bubble prefers the space below the highlight and flips above when it
  // would not fit; horizontally it is clamped inside the wrap.
  const bubble = (() => {
    if (!highlight) return null
    const wrap = wrapRef.current
    if (!wrap) return null
    const left = Math.min(
      Math.max(highlight.left, 4),
      Math.max(wrap.clientWidth - BUBBLE_WIDTH - 4, 4)
    )
    const below = highlight.top + highlight.height + 8
    const top =
      below + BUBBLE_HEIGHT_ESTIMATE < wrap.clientHeight
        ? below
        : Math.max(highlight.top - BUBBLE_HEIGHT_ESTIMATE - 8, 4)
    return { left, top }
  })()

  return (
    <>
      {annotation && highlight ? (
        <>
          {/* Selected-target highlight: data-visualization red (pi-web
              #e53935 semantics), click-transparent — clicks land on the
              capture layer, which owns the in-box deselect. */}
          <div
            aria-hidden="true"
            data-browser-annotate-highlight
            className="pointer-events-none absolute z-30 rounded-detail border border-destructive"
            style={{ left: highlight.left, top: highlight.top, width: highlight.width, height: highlight.height }}
          />
          {bubble ? (
            <div
              data-browser-annotate-bubble
              className="absolute z-30 flex w-72 flex-col gap-1.5 rounded-card border border-border bg-background p-2 shadow-overlay"
              style={{ left: bubble.left, top: bubble.top }}
            >
              <p className="truncate font-mono text-xs text-muted-foreground" title={annotation.path}>
                {annotation.path}
                {annotation.text ? `："${annotation.text}"` : ''}
              </p>
              <div ref={noteRef}>
                <Input
                  multiline
                  rows={2}
                  value={comment}
                  onChange={setComment}
                  placeholder={t('browser.annotateNotePlaceholder')}
                  aria-label={t('browser.annotateNotePlaceholder')}
                  spellCheck={false}
                  className="w-full"
                  onKeyDown={(event) => {
                    if (event.nativeEvent.isComposing) return
                    if (event.key === 'Escape') {
                      event.preventDefault()
                      cancelSelection()
                    } else if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault()
                      submit()
                    }
                  }}
                />
              </div>
              <div className="flex justify-end gap-1.5">
                <Button variant="ghost" size="sm" onClick={cancelSelection}>
                  {t('browser.annotateCancel')}
                </Button>
                <Button variant="primary" size="sm" onClick={submit}>
                  {t('browser.annotateSubmit')}
                </Button>
              </div>
            </div>
          ) : null}
        </>
      ) : null}
      {!annotation && hoverBox ? (
        <div
          aria-hidden="true"
          data-browser-annotate-hover
          className="pointer-events-none absolute z-30 rounded-detail border border-destructive/70"
          style={{ left: hoverBox.left, top: hoverBox.top, width: hoverBox.width, height: hoverBox.height }}
        />
      ) : null}
      {/* Mode hint: picking instructions + the Esc exit, pointer-transparent. */}
      <div
        aria-hidden="true"
        data-browser-annotate-hint
        className="pointer-events-none absolute inset-x-0 top-2 z-30 flex justify-center"
      >
        <span className="rounded-control border border-border/60 bg-background/90 px-2.5 py-1 text-xs text-muted-foreground shadow-overlay">
          {t('browser.annotateHint')}
          <span className="ml-1.5 text-muted-foreground/70">{t('browser.annotateExit')}</span>
        </span>
      </div>
      {/* The capture layer: mounted for the WHOLE mode (trap 1) — the guest
          receives no pointer events while annotating, so the page never
          really interacts (hover states, click navigation). */}
      <div
        ref={captureRef}
        data-browser-annotate-capture
        className="absolute inset-0 z-20 cursor-crosshair"
        onMouseDown={(e) => {
          if (e.button !== 0) return
          pickElementAt(e)
        }}
        onMouseMove={(e) => {
          if (annotation) return // no hover preview while a target is selected
          const guest = wvRef.current
          if (!guest) return
          const rect = guest.getBoundingClientRect()
          hoverPointRef.current = hostPointToGuest(
            { x: e.clientX - rect.left, y: e.clientY - rect.top },
            pageZoomRef.current
          )
          scheduleHover()
        }}
        onMouseLeave={() => {
          if (annotation) return
          hoverPointRef.current = null
          hoverResolvedRef.current = null
          hoverInfoPointRef.current = null
          setHover(null)
        }}
      />
    </>
  )
}
