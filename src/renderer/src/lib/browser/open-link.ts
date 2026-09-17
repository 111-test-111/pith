import { useSyncExternalStore } from 'react'

/**
 * 聊天等处的网页链接 → 内置浏览器打开的 window CustomEvent + 待处理队列。
 * detail 不带 URL：浏览器标签页可能尚未挂载（Workspace 听到事件才去开标签），迟到者
 * 错过同步派发的事件——队列让浏览器面板挂载时 drain 兜底；已挂载时事件触发即 drain。
 * 移植自 pi-web lib/browser-open-link.ts：事件名换成壳侧的 pith 命名空间。
 */
export const BROWSER_OPEN_LINK_EVENT = 'pith:browser-open-link'

const pendingUrls: string[] = []

export function requestBrowserOpenLink(url: string): void {
  pendingUrls.push(url)
  window.dispatchEvent(new CustomEvent(BROWSER_OPEN_LINK_EVENT))
}

/** 取走并清空待打开队列（浏览器面板挂载时与事件触发时各 drain 一次）。 */
export function drainPendingBrowserOpenLinks(): string[] {
  return pendingUrls.splice(0, pendingUrls.length)
}

// ---- 「链接在内置浏览器打开」偏好（localStorage 承载，默认开；仅 'false' 视为关） ----

const OPEN_LINKS_PREF_KEY = 'pi-app:open-links-in-browser'

// markdown 链接路由与设置行共用同一 store（useSyncExternalStore 订阅）
const openLinksListeners = new Set<() => void>()

// useSyncExternalStore 的 snapshot 要求身份稳定——布尔值天然稳定，缓存只为避免每次读盘
let openLinksCache: boolean | null = null

export function subscribeOpenLinksInBrowser(cb: () => void): () => void {
  openLinksListeners.add(cb)
  return () => {
    openLinksListeners.delete(cb)
  }
}

/** 同步读偏好（非 React 上下文用——markdown 链接路由在事件回调里读，拿不到 hook）。 */
export function getOpenLinksInBrowserPref(): boolean {
  if (openLinksCache === null) {
    try {
      openLinksCache = window.localStorage.getItem(OPEN_LINKS_PREF_KEY) !== 'false'
    } catch {
      openLinksCache = true
    }
  }
  return openLinksCache
}

/** 即时生效：写盘（隐私模式等失败静默降级）+ 通知订阅者。 */
export function setOpenLinksInBrowser(value: boolean): void {
  if (value === getOpenLinksInBrowserPref()) return
  openLinksCache = value
  try {
    window.localStorage.setItem(OPEN_LINKS_PREF_KEY, value ? 'true' : 'false')
  } catch {
    // ignore storage errors (private mode, quota, etc.)
  }
  for (const cb of openLinksListeners) cb()
}

/** 「链接在内置浏览器打开」偏好 hook（设置行与 markdown 链接路由共用）。 */
export function useOpenLinksInBrowserPref(): {
  openLinksInBrowser: boolean
  setOpenLinksInBrowser: (value: boolean) => void
} {
  const openLinksInBrowser = useSyncExternalStore(
    subscribeOpenLinksInBrowser,
    getOpenLinksInBrowserPref,
  )
  return { openLinksInBrowser, setOpenLinksInBrowser }
}
