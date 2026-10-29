import { useSyncExternalStore } from 'react'

/** Restore pages after explicitly closing the browser rail tab. Folding the
 * rail always keeps its snapshot, independently of this preference. Default
 * on preserves the existing close/reopen behavior. */
const RESTORE_TABS_PREF_KEY = 'pi-app:browser-restore-tabs'
const listeners = new Set<() => void>()
let cache: boolean | null = null

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

export function getBrowserRestoreTabsPref(): boolean {
  if (cache === null) {
    try {
      cache = window.localStorage.getItem(RESTORE_TABS_PREF_KEY) !== 'false'
    } catch {
      cache = true
    }
  }
  return cache
}

export function setBrowserRestoreTabs(value: boolean): void {
  if (value === getBrowserRestoreTabsPref()) return
  cache = value
  try {
    window.localStorage.setItem(RESTORE_TABS_PREF_KEY, value ? 'true' : 'false')
  } catch {
    // ignore storage errors (private mode, quota, etc.)
  }
  for (const cb of listeners) cb()
}

export function useBrowserRestoreTabsPref(): {
  browserRestoreTabs: boolean
  setBrowserRestoreTabs: (value: boolean) => void
} {
  const browserRestoreTabs = useSyncExternalStore(subscribe, getBrowserRestoreTabsPref)
  return { browserRestoreTabs, setBrowserRestoreTabs }
}
