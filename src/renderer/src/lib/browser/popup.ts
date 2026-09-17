/**
 * browser:popup 事件的默认接线：window.pi.onBrowserPopup → store.pushPopup。
 * 浏览器面板挂载时调用（Task 7），返回退订函数；node 直测环境没有 window.pi，
 * 安全降级为空操作订阅。onPopup（Task 15）：Workspace 的自动开面板钩子——先
 * pushPopup 再回调，回调抛错不丢 popup。
 */
import type { BrowserPopupInfo, BrowserStore } from './store.ts'

export function subscribeBrowserPopups(store: BrowserStore, onPopup?: (payload: BrowserPopupInfo) => void): () => void {
  const pi = typeof window !== 'undefined' ? window.pi : undefined
  if (!pi?.onBrowserPopup) return () => {}
  return pi.onBrowserPopup((payload) => {
    store.pushPopup(payload)
    onPopup?.(payload)
  })
}
