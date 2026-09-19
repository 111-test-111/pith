import { useSyncExternalStore } from 'react'

/**
 * 「侧栏收起时保持浏览器页面活跃」偏好（localStorage 承载，默认关；仅 'true' 视为开）。
 * 开启后，右侧 rail 收起不再卸载浏览器面板——SidebarPanel 让 `motion.aside`
 * 以 width 0 / opacity 0 保持挂载（与切 rail 标签的 opacity-0 保活层同一形态），
 * webview 全尺寸不重排，页面正在进行的动作不中断；展开后与收起前完全一致。
 * 关闭浏览器标签、关闭本开关仍走原有的卸载路径（快照恢复）。
 */

const KEEP_ALIVE_PREF_KEY = 'pi-app:browser-keep-alive'

// 与「在内置浏览器打开链接」偏好共用同一 store 模式（useSyncExternalStore 订阅）
const listeners = new Set<() => void>()

// useSyncExternalStore 的 snapshot 要求身份稳定——布尔值天然稳定，缓存只为避免每次读盘
let cache: boolean | null = null

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

/** 同步读偏好（SidebarPanel 每次渲染都会读，走缓存）。 */
export function getBrowserKeepAlivePref(): boolean {
  if (cache === null) {
    try {
      cache = window.localStorage.getItem(KEEP_ALIVE_PREF_KEY) === 'true'
    } catch {
      cache = false
    }
  }
  return cache
}

/** 即时生效：写盘（隐私模式等失败静默降级）+ 通知订阅者。 */
export function setBrowserKeepAlive(value: boolean): void {
  if (value === getBrowserKeepAlivePref()) return
  cache = value
  try {
    window.localStorage.setItem(KEEP_ALIVE_PREF_KEY, value ? 'true' : 'false')
  } catch {
    // ignore storage errors (private mode, quota, etc.)
  }
  for (const cb of listeners) cb()
}

/** 偏好 hook（设置行与 SidebarPanel 共用）。 */
export function useBrowserKeepAlivePref(): {
  browserKeepAlive: boolean
  setBrowserKeepAlive: (value: boolean) => void
} {
  const browserKeepAlive = useSyncExternalStore(subscribe, getBrowserKeepAlivePref)
  return { browserKeepAlive, setBrowserKeepAlive }
}
