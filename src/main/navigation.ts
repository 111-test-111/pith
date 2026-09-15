import { shell, type WebContents } from 'electron'

/**
 * Compare our own document by origin and path instead of as a string.
 *
 * The dev server announces itself without a trailing slash
 * (`http://localhost:5173`) while the loaded page's `location.href` carries
 * one, so a page-initiated reload — Vite's full reload after a restored file
 * changes on disk, or any `location.reload()` — read as an external URL: the
 * old string comparison prevented the reload and opened the dev server in the
 * system browser instead. Query and hash never make it a different document.
 */
export function isOwnDocument(candidate: string, appDocument: string): boolean {
  const normalize = (value: string): string => {
    try {
      const url = new URL(value)
      url.hash = ''
      url.search = ''
      return url.href.replace(/\/$/, '')
    } catch {
      return value.split('#')[0]
    }
  }
  return normalize(candidate) === normalize(appDocument)
}

/**
 * The window is an application shell, never a document viewer. A link that
 * points at something the app cannot render in place — a PDF, a web page, a
 * file on disk — must not replace it: Chromium would navigate the whole window
 * and the only way back would be a restart. Anything that is not our own
 * document goes to the system browser, exactly like a window-open request.
 */
export function guardExternalNavigation(contents: WebContents, appDocument: string): void {
  contents.on('will-navigate', (event, url) => {
    if (isOwnDocument(url, appDocument)) return
    event.preventDefault()
    void shell.openExternal(url)
  })
}
