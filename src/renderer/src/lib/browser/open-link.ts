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
