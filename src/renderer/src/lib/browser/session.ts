/** Embedded-browser persistence in localStorage: real human navigation feeds recent URLs; open-page snapshots restore guests destroyed by pane unmount. Pure transformations are separate from storage for Node checks. Ported from pi-web with pi-app keys and shared HUMAN_OWNER; storage failures fall back to empty state. */
import { HUMAN_OWNER } from '../../../../shared/browser.ts'

export const BROWSER_RECENTS_LIMIT = 8
export const OPEN_BROWSER_PAGES_LIMIT = 12
/** Full human-navigation history capacity, separate from the eight-entry recent list. */
export const BROWSER_HISTORY_LIMIT = 500

const RECENTS_KEY = 'pi-app:browser-recents'
const OPEN_PAGES_KEY = 'pi-app:browser-open-pages'
const HISTORY_KEY = 'pi-app:browser-history'

export function isRecordableUrl(url: string): boolean {
  return url.startsWith('http://') || url.startsWith('https://')
}

// Browsing history: pure transformations.

export interface BrowserHistoryEntry {
  url: string
  /** Titles may arrive after did-navigate; page-title-updated fills them in. */
  title: string
  /** page-favicon-updated fills this URL; older entries fall back to /favicon.ico. */
  favicon?: string
  at: number
}

/** Append HTTP(S) navigation; repeated newest URLs only update the title. */
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

/** Update the newest matching title; preserve identity when absent or unchanged. */
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

/** Update the newest matching favicon; preserve identity when absent or unchanged. */
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

/** Record HTTP(S) URLs, deduplicate to the front and enforce the limit; otherwise retain identity. */
export function upsertRecentUrl(list: string[], url: string, cap = BROWSER_RECENTS_LIMIT): string[] {
  if (!isRecordableUrl(url) || list[0] === url) return list
  return [url, ...list.filter((u) => u !== url)].slice(0, cap)
}

/** Open-page snapshot retains owner, including agent:<sessionId>, so restoration registers the same owner and tools rediscover it. Saved title/favicon populate tab chrome immediately; page events refresh them. An absent URL means a blank page, preserving count/order. */
export interface OpenBrowserPageEntry {
  owner: string
  /** Optional HTTP(S) target, matching the restore navigateTo allowlist; blank pages omit it. */
  url?: string
  title?: string
  favicon?: string
  /** Marks the active page for restoration; without a marker, select the first row. */
  selected?: true
}

/** Bounded ordered snapshot of all owners/pages, including blank pages. Human/agent guests share the engine and differ only by owner; unrecordable URLs restore blank without changing count. */
export function snapshotOpenPages(
  pages: readonly { owner: string, url: string, id?: string, title?: string, favicon?: string }[],
  selectedId?: string | null,
  limit = OPEN_BROWSER_PAGES_LIMIT,
): OpenBrowserPageEntry[] {
  return pages
    .map((p) => {
      const entry: OpenBrowserPageEntry = { owner: p.owner }
      if (isRecordableUrl(p.url)) entry.url = p.url
      if (p.title) entry.title = p.title
      if (p.favicon) entry.favicon = p.favicon
      if (selectedId && p.id === selectedId) entry.selected = true
      return entry
    })
    .slice(0, limit)
}

// localStorage adapter: storage failures silently fall back to empty state.

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
  // Avoid writes when repeated status polls produce identical values.
  if (lastWritten[key] === raw) return
  lastWritten[key] = raw
  try {
    window.localStorage.setItem(key, raw)
  } catch {
    // ignore storage errors (private mode, quota, etc.)
  }
}

// Subscribe recent-page views to new navigation.
const recentsListeners = new Set<() => void>()

export function subscribeBrowserRecents(cb: () => void): () => void {
  recentsListeners.add(cb)
  return () => {
    recentsListeners.delete(cb)
  }
}

// Cache stable useSyncExternalStore snapshots at module scope.
let recentsCache: string[] | null = null

export function getRecentUrls(): string[] {
  if (recentsCache === null) recentsCache = readList(RECENTS_KEY)
  return recentsCache
}

/** Record real human did-navigate events; an unchanged newest URL does not notify. */
export function recordRecentUrl(url: string): void {
  const next = upsertRecentUrl(getRecentUrls(), url)
  if (next === recentsCache) return
  recentsCache = next
  writeList(RECENTS_KEY, next)
  for (const cb of recentsListeners) cb()
}

/** Read legacy URL arrays as human pages and current entries with optional blank URLs. Preserve selected/title/favicon; invalid entries/JSON fall back silently. */
function readOpenPagesList(): OpenBrowserPageEntry[] {
  try {
    const raw = window.localStorage.getItem(OPEN_PAGES_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const entries: OpenBrowserPageEntry[] = []
    for (const item of parsed) {
      if (typeof item === 'string') {
        entries.push({ owner: HUMAN_OWNER, url: item })
        continue
      }
      if (!item || typeof item !== 'object') continue
      const record = item as { owner?: unknown; url?: unknown; title?: unknown; favicon?: unknown; selected?: unknown }
      const hasUrl = typeof record.url === 'string'
      const hasOwner = typeof record.owner === 'string' && record.owner.length > 0
      if (!hasUrl && !hasOwner) continue
      const entry: OpenBrowserPageEntry = { owner: hasOwner ? (record.owner as string) : HUMAN_OWNER }
      if (hasUrl) entry.url = record.url as string
      if (typeof record.title === 'string' && record.title) entry.title = record.title
      if (typeof record.favicon === 'string' && record.favicon) entry.favicon = record.favicon
      if (record.selected === true) entry.selected = true
      entries.push(entry)
    }
    return entries
  } catch {
    return []
  }
}

export function readOpenBrowserPages(): OpenBrowserPageEntry[] {
  return readOpenPagesList()
}

// Explicit tab closure ends this snapshot writer's lifetime. Rail folds do
// not: the next pane still reconstructs the pages from the same snapshot.
let openPagesRevision = 0

export function getOpenBrowserPagesRevision(): number {
  return openPagesRevision
}

/** Fence outgoing pane effects before teardown, retaining pages only when
 * close/reopen restoration is enabled. */
export function closeOpenBrowserPages(restoreTabs: boolean): void {
  openPagesRevision += 1
  if (!restoreTabs) writeOpenBrowserPages([])
}

export function writeOpenBrowserPages(entries: readonly OpenBrowserPageEntry[], revision = openPagesRevision): void {
  if (revision !== openPagesRevision) return
  writeList(OPEN_PAGES_KEY, entries.slice(0, OPEN_BROWSER_PAGES_LIMIT))
}

// Browsing history: localStorage adapter and subscriptions.

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

/** Record real human did-navigate events. */
export function recordBrowserHistory(url: string, at: number = Date.now()): void {
  const next = pushBrowserHistory(getBrowserHistory(), { url, at })
  if (next === historyCache) return
  historyCache = next
  writeList(HISTORY_KEY, next)
  for (const cb of historyListeners) cb()
}

/** Fill the newest matching title from page-title-updated. */
export function updateBrowserHistoryTitleFor(url: string, title: string): void {
  const next = updateBrowserHistoryTitle(getBrowserHistory(), url, title)
  if (next === historyCache) return
  historyCache = next
  writeList(HISTORY_KEY, next)
  for (const cb of historyListeners) cb()
}

/** Fill the newest matching favicon from page-favicon-updated. */
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
