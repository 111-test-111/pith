/** Wire window.pi.onBrowserPopup to store.pushPopup for tab dispositions only; window dispositions are real main-owned BrowserWindows. Mounting returns an unsubscribe function and is a no-op without window.pi in Node checks. Push before the optional pane-opening callback so callback failure cannot lose the popup. */
import type { BrowserPopupInfo } from '../../../../shared/browser.ts'
import type { BrowserStore } from './store.ts'

export function subscribeBrowserPopups(store: BrowserStore, onPopup?: (payload: BrowserPopupInfo) => void): () => void {
  const pi = typeof window !== 'undefined' ? window.pi : undefined
  if (!pi?.onBrowserPopup) return () => {}
  return pi.onBrowserPopup((payload) => {
    store.pushPopup(payload)
    onPopup?.(payload)
  })
}
