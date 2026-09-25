import { useEffect, useRef, useState } from 'react'
import { FileText, LoaderCircle } from '@/lib/icons'
import { basename } from '@/lib/format'
import { requestBrowserOpenLink } from '@/lib/browser/open-link'
import { useI18n } from '@/i18n'
import type { FileTab } from '@/state/file-browser-store'
import type { HtmlPreviewDTO } from '../../../../shared/types'
import { HTML_PREVIEW_PARTITION } from '../../../../shared/html-preview'

/** No document text enters the shell DOM. The complete file loads as a normal
 * website in a sandboxed guest, with its own nonpersistent browser session. */
export function FileHtml({ tab, refresh, onFind }: { tab: FileTab; refresh: number; onFind: () => void }) {
  const { t } = useI18n()
  const [preview, setPreview] = useState<HtmlPreviewDTO | null>(null)
  useEffect(() => {
    let cancelled = false
    setPreview(null)
    void window.pi.htmlPreview({ cwd: tab.cwd, path: tab.path })
      .then(value => { if (!cancelled) setPreview(value) })
      .catch(() => { if (!cancelled) setPreview({ error: 'unreadable' }) })
    return () => { cancelled = true }
  }, [tab.cwd, tab.path, refresh])
  if (!preview || preview.error) return <div data-file-html role="status" className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-5 text-center text-xs text-muted-foreground">
    {!preview ? <LoaderCircle aria-hidden className="size-5 motion-safe:animate-spin" /> : <FileText aria-hidden className="size-5" />}
    {!preview ? t('files.loading') : t(`files.error.${preview.error ?? 'unreadable'}`)}
  </div>
  // The request effect unmounts the old guest while refreshing. Including the
  // generation in this key would spawn an extra guest just before that cleanup.
  return <HtmlGuest key={preview.url} url={preview.url} name={basename(tab.path)} onFind={onFind} />
}

function HtmlGuest({ url, name, onFind }: { url: string; name: string; onFind: () => void }) {
  const { t } = useI18n()
  const ref = useRef<HTMLWebViewElement>(null)
  const find = useRef(onFind)
  find.current = onFind
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    const guest = ref.current
    if (!guest) return
    const id = () => {
      try { return (guest as unknown as { getWebContentsId(): number }).getWebContentsId() } catch { return -1 }
    }
    const timeout = window.setTimeout(() => { setLoading(false); setFailed(true) }, 20_000)
    const ready = () => { window.clearTimeout(timeout); setLoading(false) }
    const fail = (event: Event) => {
      const detail = event as Event & { isMainFrame?: boolean; errorCode?: number }
      if (detail.isMainFrame === false || detail.errorCode === -3) return // aborted navigation
      window.clearTimeout(timeout)
      setLoading(false); setFailed(true)
    }
    const navigated = (event: Event) => {
      if (((event as Event & { httpResponseCode?: number }).httpResponseCode ?? 0) >= 400) fail(event)
    }
    guest.addEventListener('dom-ready', ready)
    guest.addEventListener('did-fail-load', fail)
    guest.addEventListener('render-process-gone', fail)
    guest.addEventListener('did-navigate', navigated)
    const offLink = window.pi.onHtmlPreviewLink(link => { if (link.webContentsId === id()) requestBrowserOpenLink(link.url) })
    const offFind = window.pi.onHtmlPreviewFind(contentsId => { if (contentsId === id()) find.current() })
    // Attach listeners before starting the first navigation (including cache hits).
    guest.setAttribute('src', url)
    return () => {
      window.clearTimeout(timeout)
      offLink(); offFind()
      guest.removeEventListener('dom-ready', ready)
      guest.removeEventListener('did-fail-load', fail)
      guest.removeEventListener('render-process-gone', fail)
      guest.removeEventListener('did-navigate', navigated)
    }
  }, [url])
  return <div data-file-html className="relative min-h-0 flex-1">
    <webview ref={ref} partition={HTML_PREVIEW_PARTITION}
      webpreferences="contextIsolation=yes,sandbox=yes,nodeIntegration=no,webSecurity=yes"
      {...{ allowpopups: 'true' } as Record<string, string>}
      // A transparent document needs the browser's default canvas, not the
      // app's dark background underneath its default black text.
      style={{ backgroundColor: 'Canvas', colorScheme: 'normal' }}
      aria-label={t('files.html.title', { name })} className="absolute inset-0 flex h-full w-full" />
    {loading || failed ? <div role="status" className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background p-5 text-center text-xs text-muted-foreground">
      {loading ? <LoaderCircle aria-hidden className="size-5 motion-safe:animate-spin" /> : <FileText aria-hidden className="size-5" />}
      {loading ? t('files.loading') : t('files.html.loadError')}
    </div> : null}
  </div>
}
