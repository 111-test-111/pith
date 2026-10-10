import { useSyncExternalStore } from 'react'
import { DEFAULT_BROWSER_SEARCH_ENGINE, isBrowserSearchEngine, type BrowserSearchEngine } from '../../../../shared/browser'

// AppSettings owns persistence; this subscribed projection shares one read and
// one change listener across every browser page and Settings.
let current = DEFAULT_BROWSER_SEARCH_ENGINE
let revision = 0
let unsubscribe: (() => void) | null = null
const listeners = new Set<() => void>()

function apply(value: BrowserSearchEngine): void {
  revision++
  if (!isBrowserSearchEngine(value) || current === value) return
  current = value
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (listeners.size === 1) {
    unsubscribe = window.pi.onBrowserSearchEngineChanged(apply)
    const requestedRevision = revision
    void window.pi.appInfo().then((info) => {
      if (revision === requestedRevision) apply(info.browserSearchEngine)
    }).catch(() => {})
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      unsubscribe?.()
      unsubscribe = null
      revision++
    }
  }
}

async function setBrowserSearchEngine(engine: BrowserSearchEngine): Promise<void> {
  const requestedRevision = revision
  const saved = await window.pi.setBrowserSearchEngine(engine)
  if (revision === requestedRevision) apply(saved)
}

export function useBrowserSearchEngine() {
  const browserSearchEngine = useSyncExternalStore(subscribe, () => current)
  return { browserSearchEngine, setBrowserSearchEngine }
}
