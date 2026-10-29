/** Wire window.pi.onBrowserDownload to store.pushDownload while Workspace owns the browser store. Node checks without window.pi receive a no-op subscription. Preserve payload errors; the pane renders the latest download indicator. */
import type { BrowserStore } from './store.ts'

export function subscribeBrowserDownloads(store: BrowserStore): () => void {
  const pi = typeof window !== 'undefined' ? window.pi : undefined
  if (!pi?.onBrowserDownload) return () => {}
  return pi.onBrowserDownload((payload) => store.pushDownload(payload))
}
