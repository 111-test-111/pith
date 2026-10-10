import { useSyncExternalStore } from 'react'

/** Keep browser pages alive while the rail is folded: localStorage, default off; only true enables. SidebarPanel retains a zero-width/transparent aside with full-sized guests, preserving actions and layout. Disabling it unmounts and reconstructs from snapshots; explicit tab closure follows the separate restore-tabs preference. */

const KEEP_ALIVE_PREF_KEY = 'pi-app:browser-keep-alive'

// Use the same subscribed preference-store pattern as browser link routing.
const listeners = new Set<() => void>()

// Boolean snapshots are inherently stable; caching avoids repeated storage reads.
let cache: boolean | null = null

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

/** Cached synchronous reader used by SidebarPanel renders. */
export function getBrowserKeepAlivePref(): boolean {
  if (cache === null) {
    try {
      cache = window.localStorage.getItem(KEEP_ALIVE_PREF_KEY) === 'true'
    } catch {
      cache = false
    }
  }
  return cache
}

/** Apply immediately: persist with silent storage fallback, then notify subscribers. */
export function setBrowserKeepAlive(value: boolean): void {
  if (value === getBrowserKeepAlivePref()) return
  cache = value
  try {
    window.localStorage.setItem(KEEP_ALIVE_PREF_KEY, value ? 'true' : 'false')
  } catch {
    // ignore storage errors (private mode, quota, etc.)
  }
  for (const cb of listeners) cb()
}

/** Preference hook shared by Settings and SidebarPanel. */
export function useBrowserKeepAlivePref(): {
  browserKeepAlive: boolean
  setBrowserKeepAlive: (value: boolean) => void
} {
  const browserKeepAlive = useSyncExternalStore(subscribe, getBrowserKeepAlivePref)
  return { browserKeepAlive, setBrowserKeepAlive }
}
