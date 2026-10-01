/** Embedded-browser state for useSyncExternalStore. Components wire browser state/popup/download subscriptions on mount; this store only reduces state and preserves snapshot identity between updates. Optimistic rows represent createPage round trips and are removed when the server list covers them. Queues/state stay directly testable in Node; window access is lazy. */
import { buildMarkerUrl, HUMAN_OWNER } from '../../../../shared/browser.ts'
import type { BrowserPageMeta, BrowserPopupInfo, BrowserDownloadInfo } from '../../../../shared/browser.ts'
import type { BrowserStatusDTO } from '../../../../shared/types.ts'

/** Panel row: server metadata plus a local pending marker. Popup rows carry navigateTo into the dom-ready/browserSeen handshake; the service stores pendingNavigate and navigates after reconciliation. Renderer loadURL would race marker registration. */
export interface BrowserPanePage extends BrowserPageMeta { pending?: boolean; navigateTo?: string }

// BrowserPopupInfo/BrowserDownloadInfo belong to shared/browser.ts; do not duplicate their shapes in the renderer store.

export interface BrowserPaneState {
  status: BrowserStatusDTO | null
  popups: BrowserPopupInfo[]
  downloads: BrowserDownloadInfo[]
  /** Local optimistic placeholders during createPage round trips, absent from server state. */
  optimistic: BrowserPanePage[]
}

/** Bounded download history; the pane only needs recent completion notices. */
export const BROWSER_DOWNLOADS_LIMIT = 5

const EMPTY_STATE: BrowserPaneState = { status: null, popups: [], downloads: [], optimistic: [] }

function optimisticPage(id: string): BrowserPanePage {
  return {
    id,
    owner: HUMAN_OWNER,
    url: buildMarkerUrl(HUMAN_OWNER, id),
    title: '',
    agentBusy: false,
    crashed: false,
    pending: true,
  }
}

/** Shallowly compare browser:status DTOs, including ordered page/pending-create fields. Polling identical content must not notify subscribers. */
function sameBrowserStatus(a: BrowserStatusDTO | null, b: BrowserStatusDTO): boolean {
  if (a === b) return true
  if (!a) return false
  if (a.available !== b.available || a.consentRequired !== b.consentRequired) return false
  if (a.pages.length !== b.pages.length || a.pendingCreates.length !== b.pendingCreates.length) return false
  for (let index = 0; index < a.pages.length; index += 1) {
    const left = a.pages[index]
    const right = b.pages[index]
    if (left.id !== right.id || left.owner !== right.owner || left.url !== right.url
      || left.title !== right.title || left.agentBusy !== right.agentBusy || left.crashed !== right.crashed) return false
  }
  for (let index = 0; index < a.pendingCreates.length; index += 1) {
    if (a.pendingCreates[index].id !== b.pendingCreates[index].id
      || a.pendingCreates[index].owner !== b.pendingCreates[index].owner) return false
  }
  return true
}

export class BrowserStore {
  private state: BrowserPaneState = EMPTY_STATE
  private listeners = new Set<() => void>()

  // Stable bound class fields, as in TerminalStore: pass subscribe/getState directly to useSyncExternalStore so renders do not replace callbacks and resubscribe.
  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb)
    return () => {
      this.listeners.delete(cb)
    }
  }

  getState = (): BrowserPaneState => this.state

  /** Publish changed server state only. Identity-only comparison would rerender every webview for identical freshly polled DTOs. */
  applyStatus(status: BrowserStatusDTO): void {
    if (sameBrowserStatus(this.state.status, status)) return
    this.replace({ status })
  }

  pushPopup(p: BrowserPopupInfo): void {
    this.replace({ popups: [...this.state.popups, p] })
  }

  /** Drain popup events on pane mount and on delivery. */
  drainPopups(): BrowserPopupInfo[] {
    if (this.state.popups.length === 0) return []
    const drained = this.state.popups
    this.replace({ popups: [] })
    return drained
  }

  /** Retain only the latest BROWSER_DOWNLOADS_LIMIT downloads. */
  pushDownload(d: BrowserDownloadInfo): void {
    this.replace({ downloads: [...this.state.downloads, d].slice(-BROWSER_DOWNLOADS_LIMIT) })
  }

  // Local optimistic placeholders during createPage round trips.

  /** Add a placeholder; duplicate IDs preserve state without notifying. */
  addOptimistic(id: string): void {
    if (this.state.optimistic.some((p) => p.id === id)) return
    this.replace({ optimistic: [...this.state.optimistic, optimisticPage(id)] })
  }

  /** Clear the pending marker once the server registers the created page. */
  resolveOptimistic(id: string): void {
    const idx = this.state.optimistic.findIndex((p) => p.id === id)
    if (idx === -1 || !this.state.optimistic[idx].pending) return
    const next = [...this.state.optimistic]
    next[idx] = { ...next[idx], pending: false }
    this.replace({ optimistic: next })
  }

  /** Remove failed/closed placeholders; pane derivation removes server-covered rows. */
  removeOptimistic(id: string): void {
    if (!this.state.optimistic.some((p) => p.id === id)) return
    this.replace({ optimistic: this.state.optimistic.filter((p) => p.id !== id) })
  }

  /** Clear placeholders when remounting: createPage work belongs to the previous pane instance, while the longer-lived store could otherwise retain an uncovered row forever. */
  clearOptimistic(): void {
    if (this.state.optimistic.length === 0) return
    this.replace({ optimistic: [] })
  }

  private replace(patch: Partial<BrowserPaneState>): void {
    this.state = { ...this.state, ...patch }
    for (const cb of this.listeners) cb()
  }
}
