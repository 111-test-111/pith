/**
 * 浏览器标签页的会话持久化（仅 Electron 壳客户端；localStorage 承载）：
 * - 最近打开的 URL：起始页「最近打开」列表的数据源（human 页真实导航时记录）
 * - 打开页快照：当前打开着的 human 页 URL，持续写入——浏览器标签页关闭即卸载
 *   webview（guest 随之销毁、服务端注册表随之清扫），重开时按快照恢复各页
 * 纯函数核心与 localStorage 适配分离，便于 node 直测。
 * 移植自 pi-web lib/browser-session.ts：键名 pi-app:browser-*，HUMAN_OWNER 来自
 * shared/browser；SSR 守卫删除（纯 SPA），读写失败仍静默降级为空。
 */
import { HUMAN_OWNER } from '../../../../shared/browser.ts'

export const BROWSER_RECENTS_LIMIT = 8
export const OPEN_BROWSER_PAGES_LIMIT = 12
/** 浏览历史容量（human 页真实导航的全量流水，区别于最近打开的 8 条热列表）。 */
export const BROWSER_HISTORY_LIMIT = 500

const RECENTS_KEY = 'pi-app:browser-recents'
const OPEN_PAGES_KEY = 'pi-app:browser-open-pages'
const HISTORY_KEY = 'pi-app:browser-history'

export function isRecordableUrl(url: string): boolean {
  return url.startsWith('http://') || url.startsWith('https://')
}

// ---- 浏览历史（纯函数核心）----

export interface BrowserHistoryEntry {
  url: string
  /** 页面标题：did-navigate 时往往未至，由 page-title-updated 回填。 */
  title: string
  /** 站点图标 URL：由 page-favicon-updated 回填；旧条目缺失时面板回落站点根 /favicon.ico。 */
  favicon?: string
  at: number
}

/** 追加一条历史：非 http(s) 不入列；与队首同 URL 不重复（刷新/同页导航），只回填标题。 */
export function pushBrowserHistory(
  list: readonly BrowserHistoryEntry[],
  entry: { url: string, title?: string, at: number },
  cap = BROWSER_HISTORY_LIMIT,
): BrowserHistoryEntry[] {
  if (!isRecordableUrl(entry.url)) return list as BrowserHistoryEntry[]
  if (list[0]?.url === entry.url) {
    const title = entry.title ?? ''
    if (!title || list[0].title === title) return list as BrowserHistoryEntry[]
    return [{ ...list[0], title }, ...list.slice(1)]
  }
  return [{ url: entry.url, title: entry.title ?? '', at: entry.at }, ...list].slice(0, cap)
}

/** 标题回填：更新最新一条同 URL 条目的标题（未找到/无变化时保持引用）。 */
export function updateBrowserHistoryTitle(
  list: readonly BrowserHistoryEntry[],
  url: string,
  title: string,
): BrowserHistoryEntry[] {
  if (!title) return list as BrowserHistoryEntry[]
  const idx = list.findIndex((e) => e.url === url)
  if (idx === -1 || list[idx].title === title) return list as BrowserHistoryEntry[]
  const next = [...list]
  next[idx] = { ...next[idx], title }
  return next
}

/** 站点图标回填：更新最新一条同 URL 条目的图标（未找到/无图标/无变化时保持引用）。 */
export function updateBrowserHistoryFavicon(
  list: readonly BrowserHistoryEntry[],
  url: string,
  favicon: string,
): BrowserHistoryEntry[] {
  if (!favicon) return list as BrowserHistoryEntry[]
  const idx = list.findIndex((e) => e.url === url)
  if (idx === -1 || list[idx].favicon === favicon) return list as BrowserHistoryEntry[]
  const next = [...list]
  next[idx] = { ...next[idx], favicon }
  return next
}

/** 记录一次 URL：非 http(s) 不入列（返回原引用）；同 URL 去重置顶；超量截断。 */
export function upsertRecentUrl(list: string[], url: string, cap = BROWSER_RECENTS_LIMIT): string[] {
  if (!isRecordableUrl(url) || list[0] === url) return list
  return [url, ...list.filter((u) => u !== url)].slice(0, cap)
}

/** 打开页快照：仅 human 页、仅可记录 URL，保持打开顺序（限量）。 */
export function snapshotOpenPages(
  pages: readonly { owner: string, url: string }[],
  limit = OPEN_BROWSER_PAGES_LIMIT,
): string[] {
  return pages
    .filter((p) => p.owner === HUMAN_OWNER && isRecordableUrl(p.url))
    .map((p) => p.url)
    .slice(0, limit)
}

// ---- localStorage 适配（隐私模式等读写失败时静默降级为空） ----

function readList(key: string): string[] {
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((u): u is string => typeof u === 'string')
  } catch {
    return []
  }
}

const lastWritten: Record<string, string> = {}

function writeList<T>(key: string, list: readonly T[]): void {
  const raw = JSON.stringify(list)
  // status 轮询反复派生同值时不写盘
  if (lastWritten[key] === raw) return
  lastWritten[key] = raw
  try {
    window.localStorage.setItem(key, raw)
  } catch {
    // ignore storage errors (private mode, quota, etc.)
  }
}

// 最近打开列表的订阅（起始页挂载期间有新导航时即时刷新）
const recentsListeners = new Set<() => void>()

export function subscribeBrowserRecents(cb: () => void): () => void {
  recentsListeners.add(cb)
  return () => {
    recentsListeners.delete(cb)
  }
}

// useSyncExternalStore 的 snapshot 要求身份稳定——模块级缓存
let recentsCache: string[] | null = null

export function getRecentUrls(): string[] {
  if (recentsCache === null) recentsCache = readList(RECENTS_KEY)
  return recentsCache
}

/** human 页发生真实导航（did-navigate）时记录；已在顶则无变化不通知。 */
export function recordRecentUrl(url: string): void {
  const next = upsertRecentUrl(getRecentUrls(), url)
  if (next === recentsCache) return
  recentsCache = next
  writeList(RECENTS_KEY, next)
  for (const cb of recentsListeners) cb()
}

export function readOpenBrowserPages(): string[] {
  return readList(OPEN_PAGES_KEY)
}

export function writeOpenBrowserPages(urls: readonly string[]): void {
  writeList(OPEN_PAGES_KEY, urls.slice(0, OPEN_BROWSER_PAGES_LIMIT))
}

// ---- 浏览历史（localStorage 适配 + 订阅）----

const historyListeners = new Set<() => void>()
let historyCache: BrowserHistoryEntry[] | null = null

function readHistoryList(): BrowserHistoryEntry[] {
  try {
    const raw = window.localStorage.getItem(HISTORY_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((e): e is BrowserHistoryEntry =>
      !!e && typeof e === 'object' && typeof (e as BrowserHistoryEntry).url === 'string')
  } catch {
    return []
  }
}

export function subscribeBrowserHistory(cb: () => void): () => void {
  historyListeners.add(cb)
  return () => {
    historyListeners.delete(cb)
  }
}

export function getBrowserHistory(): BrowserHistoryEntry[] {
  if (historyCache === null) historyCache = readHistoryList()
  return historyCache
}

/** human 页真实导航（did-navigate）时记录。 */
export function recordBrowserHistory(url: string, at: number = Date.now()): void {
  const next = pushBrowserHistory(getBrowserHistory(), { url, at })
  if (next === historyCache) return
  historyCache = next
  writeList(HISTORY_KEY, next)
  for (const cb of historyListeners) cb()
}

/** page-title-updated 回填最新一条同 URL 条目的标题。 */
export function updateBrowserHistoryTitleFor(url: string, title: string): void {
  const next = updateBrowserHistoryTitle(getBrowserHistory(), url, title)
  if (next === historyCache) return
  historyCache = next
  writeList(HISTORY_KEY, next)
  for (const cb of historyListeners) cb()
}

/** page-favicon-updated 回填最新一条同 URL 条目的站点图标。 */
export function updateBrowserHistoryFaviconFor(url: string, favicon: string): void {
  const next = updateBrowserHistoryFavicon(getBrowserHistory(), url, favicon)
  if (next === historyCache) return
  historyCache = next
  writeList(HISTORY_KEY, next)
  for (const cb of historyListeners) cb()
}

export function clearBrowserHistory(): void {
  if (historyCache !== null && historyCache.length === 0) return
  historyCache = []
  writeList(HISTORY_KEY, [])
  for (const cb of historyListeners) cb()
}
