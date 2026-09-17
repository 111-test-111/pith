/**
 * browser:popup 事件的默认接线：window.pi.onBrowserPopup → store.pushPopup。
 * 浏览器面板挂载时调用（Task 7），返回退订函数；node 直测环境没有 window.pi，
 * 安全降级为空操作订阅。
 */
import type { BrowserStore } from './store.ts'

export function subscribeBrowserPopups(store: BrowserStore): () => void {
  const pi = typeof window !== 'undefined' ? window.pi : undefined
  if (!pi?.onBrowserPopup) return () => {}
  return pi.onBrowserPopup((payload) => store.pushPopup(payload))
}
