import { browserOwnerSessionId, isHumanBrowserOwner } from '../../../../shared/browser.ts'
import type { BrowserStatusDTO } from '../../../../shared/types.ts'
import { closeOpenBrowserPages } from './session'
import { BrowserStore } from './store'

/** Live guest hosts are retained when the visible conversation changes. The
 * state stream is app-wide, but each host materializes only its own pages. */
export class BrowserWorkspaces {
  private stores = new Map<string | null, BrowserStore>()
  private hosts: BrowserStore[] = []
  private listeners = new Set<() => void>()
  private lastStatus: BrowserStatusDTO | null = null
  private pending = new Set<string>()

  getSnapshot = () => this.hosts
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  private setHosts(hosts: BrowserStore[]): void {
    this.hosts = hosts
    for (const listener of this.listeners) listener()
  }
  get(sessionId: string | null): BrowserStore {
    let store = this.stores.get(sessionId)
    if (!store) {
      store = new BrowserStore(sessionId)
      this.stores.set(sessionId, store)
      if (this.lastStatus) store.applyStatus(this.lastStatus)
    }
    return store
  }
  host(store: BrowserStore): void {
    if (!this.hosts.includes(store)) this.setHosts([...this.hosts, store])
  }
  unhost(store: BrowserStore): void {
    if (this.hosts.includes(store)) this.setHosts(this.hosts.filter(host => host !== store))
  }
  applyStatus(status: BrowserStatusDTO, onAgentPage: (store: BrowserStore) => void): void {
    this.lastStatus = status
    for (const store of this.stores.values()) store.applyStatus(status)
    const previous = this.pending
    this.pending = new Set(status.pendingCreates.map(page => page.id))
    for (const page of status.pendingCreates) {
      if (previous.has(page.id) || isHumanBrowserOwner(page.owner)) continue
      const id = browserOwnerSessionId(page.owner)
      if (id) onAgentPage(this.get(id))
    }
  }
  close(store: BrowserStore, restore: boolean): void {
    closeOpenBrowserPages(restore, store.sessionId)
    this.unhost(store)
    store.drainPopups()
    store.drainLinks()
    const { status, optimistic } = store.getState()
    const ids = new Set([...(status?.pages ?? []), ...(status?.pendingCreates ?? []), ...optimistic].map(page => page.id))
    for (const id of ids) void window.pi.browserClosePage(id).catch(() => {})
  }
  forget(sessionId: string): void {
    this.close(this.get(sessionId), false)
    this.stores.delete(sessionId)
  }
}
