/**
 * browser:download 事件的默认接线：window.pi.onBrowserDownload → store.pushDownload。
 * Workspace 挂载浏览器 store 时调用（与 popup.ts 同款）；node 直测环境没有 window.pi，
 * 安全降级为空操作订阅。payload 的 error 字段（T11 预加载层已放宽）原样入队，
 * 面板按「最新一条」渲染下载指示。
 */
import type { BrowserStore } from './store.ts'

export function subscribeBrowserDownloads(store: BrowserStore): () => void {
  const pi = typeof window !== 'undefined' ? window.pi : undefined
  if (!pi?.onBrowserDownload) return () => {}
  return pi.onBrowserDownload((payload) => store.pushDownload(payload))
}
