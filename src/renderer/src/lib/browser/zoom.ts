/**
 * 内嵌浏览器页面缩放（仅 Electron 壳客户端）：全局单一 zoom 档（webview.setZoomFactor
 * 应用到每个 guest），localStorage 持久化。纯函数核心（阶梯/夹取）与 store 分离，
 * 便于 node 直测。移植自 pi-web lib/browser-zoom.ts：键名 pi-app:browser-zoom，
 * SSR 守卫删除（纯 SPA），读写失败仍静默降级为默认档。
 */

/** Chromium 同款缩放阶梯：+/− 控件与快捷键沿阶梯步进，避免任意小数档位。 */
export const BROWSER_ZOOM_STEPS: readonly number[] = [
  0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3,
]

const ZOOM_KEY = 'pi-app:browser-zoom'

/** 归一：NaN/非正值回退 100%；∞ 夹到端点档；阶梯外值就近吸附（平局取较低档）。 */
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

/** 沿阶梯步进；direction = +1 放大 / -1 缩小，端点处停住。 */
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

/**
 * webview.setZoomFactor() 接收绝对值，而工具条的页面缩放是相对宿主界面缩放的值。
 * 例如界面 105%、页面 100% 时，guest 也必须保持 1.05；写成 1 会让页面加载后闪缩。
 */
export function effectiveWebviewZoom(pageZoom: number, uiScale: number): number {
  const safeUiScale = Number.isFinite(uiScale) && uiScale > 0 ? uiScale : 1
  return normalizeBrowserZoom(pageZoom) * safeUiScale
}

/** host/webview 元素内的坐标 → guest CSS 视口坐标。界面缩放在两侧相消。 */
export function hostPointToGuest(point: BrowserPoint, pageZoom: number): BrowserPoint {
  const scale = normalizeBrowserZoom(pageZoom)
  return { x: point.x / scale, y: point.y / scale }
}

/** guest getBoundingClientRect() → host/webview 元素内的显示坐标。 */
export function guestBoxToHost(box: BrowserBox, pageZoom: number): BrowserBox {
  const scale = normalizeBrowserZoom(pageZoom)
  return {
    x: box.x * scale,
    y: box.y * scale,
    width: box.width * scale,
    height: box.height * scale,
  }
}

// ---- store（隐私模式等读写失败时静默降级为默认档） ----

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

// useSyncExternalStore 的 snapshot 要求身份稳定——模块级缓存
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
