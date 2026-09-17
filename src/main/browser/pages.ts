/**
 * 浏览器页面注册表的纯模型（移植自 pi-web lib/browser-pages.ts）。
 * 不持有 Electron 运行期对象——webContents 等运行期对象由后续的 browser-service 另行索引。
 */
import type { BrowserPageMeta } from '../../shared/browser.ts'

export interface PageSnapshotState {
  refs: string[]
  interactionGeneration: number
}

export interface BrowserPageRecord extends BrowserPageMeta {
  interactionGeneration: number
  snapshot: PageSnapshotState | null
  /** renderer 上报的 guest webContents id（主进程 input-event 中继的映射键）。 */
  webContentsId?: number
  /** agent popup 页的待导航 URL：renderer 声明，运行期登记后由服务端 goto 消费。 */
  pendingNavigate?: string
}

export interface BrowserPagesState {
  pages: BrowserPageRecord[]
  activeByOwner: Record<string, string>
}

export const EMPTY_BROWSER_PAGES: BrowserPagesState = { pages: [], activeByOwner: {} }

// createBrowserPageId 从 shared/browser re-export（单一实现，渲染层 popup 物化同源）
export { createBrowserPageId } from '../../shared/browser.ts'

export function pageMeta(record: BrowserPageRecord): BrowserPageMeta {
  const { id, owner, url, title, agentBusy, crashed } = record
  return { id, owner, url, title, agentBusy, crashed }
}

export function pageById(state: BrowserPagesState, id: string): BrowserPageRecord | null {
  return state.pages.find((p) => p.id === id) ?? null
}

export function pagesForOwner(state: BrowserPagesState, owner: string): BrowserPageRecord[] {
  return state.pages.filter((p) => p.owner === owner)
}

export function activePageForOwner(state: BrowserPagesState, owner: string): BrowserPageRecord | null {
  const id = state.activeByOwner[owner]
  return id ? pageById(state, id) : null
}

function mapPage(state: BrowserPagesState, id: string, fn: (p: BrowserPageRecord) => BrowserPageRecord): BrowserPagesState {
  if (!state.pages.some((p) => p.id === id)) return state
  return { ...state, pages: state.pages.map((p) => (p.id === id ? fn(p) : p)) }
}

export function addPage(
  state: BrowserPagesState,
  page: { id: string; owner: string; url?: string; title?: string },
): BrowserPagesState {
  if (state.pages.some((p) => p.id === page.id)) return state
  const record: BrowserPageRecord = {
    id: page.id,
    owner: page.owner,
    url: page.url ?? 'about:blank',
    title: page.title ?? '',
    agentBusy: false,
    crashed: false,
    interactionGeneration: 0,
    snapshot: null,
  }
  return {
    pages: [...state.pages, record],
    activeByOwner: { ...state.activeByOwner, [page.owner]: page.id },
  }
}

export function removePage(state: BrowserPagesState, id: string): BrowserPagesState {
  const target = pageById(state, id)
  if (!target) return state
  const pages = state.pages.filter((p) => p.id !== id)
  const activeByOwner = { ...state.activeByOwner }
  if (activeByOwner[target.owner] === id) {
    const remaining = pagesForOwner({ pages, activeByOwner }, target.owner)
    const fallback = remaining[remaining.length - 1]
    if (fallback) activeByOwner[target.owner] = fallback.id
    else delete activeByOwner[target.owner]
  }
  return { pages, activeByOwner }
}

/** 切换 active；双方 snapshot 无条件清空（spec: active page 切换清空当前 snapshot）。 */
export function setActivePage(state: BrowserPagesState, owner: string, id: string): BrowserPagesState {
  const target = pageById(state, id)
  if (!target || target.owner !== owner) return state
  if (state.activeByOwner[owner] === id) return state
  return {
    pages: state.pages.map((p) => (p.owner === owner ? { ...p, snapshot: null } : p)),
    activeByOwner: { ...state.activeByOwner, [owner]: id },
  }
}

export function updatePageNav(state: BrowserPagesState, id: string, url: string, title: string): BrowserPagesState {
  return mapPage(state, id, (p) => ({
    ...p,
    url,
    title,
    snapshot: p.url === url ? p.snapshot : null,
  }))
}

export function setAgentBusy(state: BrowserPagesState, id: string, busy: boolean): BrowserPagesState {
  return mapPage(state, id, (p) => ({ ...p, agentBusy: busy }))
}

export function setCrashed(state: BrowserPagesState, id: string): BrowserPagesState {
  return mapPage(state, id, (p) => ({ ...p, crashed: true, snapshot: null }))
}

export function bumpInteraction(state: BrowserPagesState, id: string): BrowserPagesState {
  return mapPage(state, id, (p) => ({ ...p, interactionGeneration: p.interactionGeneration + 1 }))
}

/** renderer 上报 guest 的 webContents id（重复上报同值时状态不变）。 */
export function setPageWebContentsId(state: BrowserPagesState, id: string, webContentsId: number): BrowserPagesState {
  return mapPage(state, id, (p) => (p.webContentsId === webContentsId ? p : { ...p, webContentsId }))
}

/** 记录/清除待导航 URL（null 清除）。 */
export function setPendingNavigate(state: BrowserPagesState, id: string, url: string | null): BrowserPagesState {
  return mapPage(state, id, (p) => {
    if (url === null) {
      if (p.pendingNavigate === undefined) return p
      const next = { ...p }
      delete next.pendingNavigate
      return next
    }
    return { ...p, pendingNavigate: url }
  })
}

export function recordSnapshot(state: BrowserPagesState, id: string, refs: string[]): BrowserPagesState {
  return mapPage(state, id, (p) => ({
    ...p,
    snapshot: { refs, interactionGeneration: p.interactionGeneration },
  }))
}

export function clearAllPages(): BrowserPagesState {
  return EMPTY_BROWSER_PAGES
}
