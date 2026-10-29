/** Pure browser-page registry; Electron and Playwright objects live in service.ts.
 * Ownership, interaction generations and snapshots stay serializable. */
import type { BrowserPageMeta } from '../../shared/browser.ts'

export interface PageSnapshotState {
  refs: string[]
  interactionGeneration: number
}

export interface BrowserPageRecord extends BrowserPageMeta {
  interactionGeneration: number
  snapshot: PageSnapshotState | null

  webContentsId?: number

  pendingNavigate?: string
}

export interface BrowserPagesState {
  pages: BrowserPageRecord[]
  activeByOwner: Record<string, string>
}

export const EMPTY_BROWSER_PAGES: BrowserPagesState = { pages: [], activeByOwner: {} }

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

/** Switching active pages invalidates every snapshot owned by that session. */
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

/** Repeated reports of the same guest ID preserve the record identity. */
export function setPageWebContentsId(state: BrowserPagesState, id: string, webContentsId: number): BrowserPagesState {
  return mapPage(state, id, (p) => (p.webContentsId === webContentsId ? p : { ...p, webContentsId }))
}

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
