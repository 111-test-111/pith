/** Embedded-browser zoom: one persisted zoom level applies to every guest through webview.setZoomFactor. Pure stepping/clamping functions remain separate from the store for Node checks. Ported from pi-web with the pi-app:browser-zoom key; this SPA needs no SSR guard, and storage failures fall back silently. */

/** Chromium zoom steps for controls/shortcuts, avoiding arbitrary fractional levels. */
export const BROWSER_ZOOM_STEPS: readonly number[] = [
  0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3,
]

const ZOOM_KEY = 'pi-app:browser-zoom'

/** Normalize: NaN/nonpositive values use 100%; infinities clamp; other values snap to the nearest step, preferring the lower step on ties. */
export function normalizeBrowserZoom(value: number): number {
  if (Number.isNaN(value) || value <= 0) return 1
  const lo = BROWSER_ZOOM_STEPS[0]
  const hi = BROWSER_ZOOM_STEPS[BROWSER_ZOOM_STEPS.length - 1]
  const clamped = Math.min(Math.max(value, lo), hi)
  let best = lo
  for (const step of BROWSER_ZOOM_STEPS) {
    if (Math.abs(step - clamped) < Math.abs(best - clamped)) best = step
  }
  return best
}

/** Step along the scale: +1 zooms in, -1 out; stop at endpoints. */
export function nextBrowserZoom(current: number, direction: 1 | -1): number {
  const cur = normalizeBrowserZoom(current)
  const idx = BROWSER_ZOOM_STEPS.indexOf(cur)
  const nextIdx = Math.min(Math.max(idx + direction, 0), BROWSER_ZOOM_STEPS.length - 1)
  return BROWSER_ZOOM_STEPS[nextIdx]
}

interface BrowserPoint {
  x: number
  y: number
}

interface BrowserBox extends BrowserPoint {
  width: number
  height: number
}

/** webview.setZoomFactor takes an absolute value; page zoom is relative to host UI zoom. At host 105% and page 100%, keep the guest at 1.05 to avoid shrinking after load. */
export function effectiveWebviewZoom(pageZoom: number, uiScale: number): number {
  const safeUiScale = Number.isFinite(uiScale) && uiScale > 0 ? uiScale : 1
  return normalizeBrowserZoom(pageZoom) * safeUiScale
}

/** Convert host/webview coordinates to guest CSS viewport coordinates; host zoom cancels on both sides. */
export function hostPointToGuest(point: BrowserPoint, pageZoom: number): BrowserPoint {
  const scale = normalizeBrowserZoom(pageZoom)
  return { x: point.x / scale, y: point.y / scale }
}

/** Convert guest getBoundingClientRect to host/webview display coordinates. */
export function guestBoxToHost(box: BrowserBox, pageZoom: number): BrowserBox {
  const scale = normalizeBrowserZoom(pageZoom)
  return {
    x: box.x * scale,
    y: box.y * scale,
    width: box.width * scale,
    height: box.height * scale,
  }
}

// Store: storage failures silently use the default level.

const listeners = new Set<() => void>()
let cache: number | null = null

function readStoredZoom(): number {
  try {
    const raw = window.localStorage.getItem(ZOOM_KEY)
    if (raw === null) return 1
    return normalizeBrowserZoom(Number(raw))
  } catch {
    return 1
  }
}

export function subscribeBrowserZoom(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

// Cache stable useSyncExternalStore snapshots at module scope.
export function getBrowserZoom(): number {
  if (cache === null) cache = readStoredZoom()
  return cache
}

export function setBrowserZoom(value: number): void {
  const next = normalizeBrowserZoom(value)
  if (next === getBrowserZoom()) return
  cache = next
  try {
    window.localStorage.setItem(ZOOM_KEY, String(next))
  } catch {
    // ignore storage errors (private mode, quota, etc.)
  }
  for (const cb of listeners) cb()
}
