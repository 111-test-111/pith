import { useSyncExternalStore } from 'react'

/** A window CustomEvent and pending queue route web links from chat/Markdown into the embedded browser. Events carry no URL: an unmounted pane can miss synchronous dispatch, then drain the queue on mount; mounted panes drain on delivery. Ported from pi-web under the pith event namespace. */
export const BROWSER_OPEN_LINK_EVENT = 'pith:browser-open-link'

const pendingUrls: string[] = []

export function requestBrowserOpenLink(url: string): void {
  pendingUrls.push(url)
  window.dispatchEvent(new CustomEvent(BROWSER_OPEN_LINK_EVENT))
}

/** Drain queued links on pane mount and event delivery. */
export function drainPendingBrowserOpenLinks(): string[] {
  return pendingUrls.splice(0, pendingUrls.length)
}

// Open-links-in-browser preference: localStorage, default enabled; only false disables.

const OPEN_LINKS_PREF_KEY = 'pi-app:open-links-in-browser'

// Markdown routing and Settings share one subscribed store.
const openLinksListeners = new Set<() => void>()

// Boolean snapshots are inherently stable; cache them to avoid repeated storage reads.
let openLinksCache: boolean | null = null

export function subscribeOpenLinksInBrowser(cb: () => void): () => void {
  openLinksListeners.add(cb)
  return () => {
    openLinksListeners.delete(cb)
  }
}

/** Synchronous preference reader for non-React Markdown click callbacks. */
export function getOpenLinksInBrowserPref(): boolean {
  if (openLinksCache === null) {
    try {
      openLinksCache = window.localStorage.getItem(OPEN_LINKS_PREF_KEY) !== 'false'
    } catch {
      openLinksCache = true
    }
  }
  return openLinksCache
}

/** Apply immediately: persist with silent storage fallback, then notify subscribers. */
export function setOpenLinksInBrowser(value: boolean): void {
  if (value === getOpenLinksInBrowserPref()) return
  openLinksCache = value
  try {
    window.localStorage.setItem(OPEN_LINKS_PREF_KEY, value ? 'true' : 'false')
  } catch {
    // ignore storage errors (private mode, quota, etc.)
  }
  for (const cb of openLinksListeners) cb()
}

/** Shared open-links-in-browser hook for Settings and Markdown routing. */
export function useOpenLinksInBrowserPref(): {
  openLinksInBrowser: boolean
  setOpenLinksInBrowser: (value: boolean) => void
} {
  const openLinksInBrowser = useSyncExternalStore(
    subscribeOpenLinksInBrowser,
    getOpenLinksInBrowserPref,
  )
  return { openLinksInBrowser, setOpenLinksInBrowser }
}
