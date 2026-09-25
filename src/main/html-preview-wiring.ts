import { app, session, type BrowserWindow } from 'electron'
import { HTML_PREVIEW_PARTITION } from '../shared/html-preview'
import { htmlPreviews } from './html-preview'
import { registerQuitShortcut } from './shutdown'

let sessionWired = false

/** File previews never join the browser registry or inherit its login session. */
export function installHtmlPreviewWiring(window: BrowserWindow): void {
  const previewSession = session.fromPartition(HTML_PREVIEW_PARTITION)
  if (!sessionWired) {
    sessionWired = true
    previewSession.setPermissionRequestHandler((_contents, _permission, done) => done(false))
    previewSession.setPermissionCheckHandler(() => false)
    previewSession.on('will-download', event => event.preventDefault())
    previewSession.webRequest.onBeforeRequest((details, done) => {
      // Neither file:// nor the shell's custom media protocol is a resource
      // loader for arbitrary page JS. Ordinary web requests keep web security.
      done({ cancel: !/^(https?:|wss?:|data:|blob:|about:blank(?:#|$))/.test(details.url) })
    })
  }
  window.webContents.on('will-attach-webview', (event, preferences, params) => {
    if (params.partition !== HTML_PREVIEW_PARTITION) return
    if (!htmlPreviews.owns(params.src)) { event.preventDefault(); return }
    delete preferences.preload
    preferences.nodeIntegration = false
    preferences.nodeIntegrationInWorker = false
    preferences.nodeIntegrationInSubFrames = false
    preferences.contextIsolation = true
    preferences.sandbox = true
    preferences.webSecurity = true
    preferences.webviewTag = false
    preferences.allowRunningInsecureContent = false
  })
  window.webContents.on('did-attach-webview', (_event, guest) => {
    if (guest.session !== previewSession) return
    registerQuitShortcut(guest, () => app.quit())
    const sendLink = (url: string) => {
      if (!/^https?:\/\//.test(url) || window.isDestroyed()) return
      window.webContents.send('files:htmlLink', { webContentsId: guest.id, url })
    }
    guest.on('will-navigate', (event, url) => {
      try {
        const next = new URL(url)
        // Initial navigation can precede did-attach-webview. Read the committed
        // document here; a did-start-navigation latch could capture the FIRST
        // clicked link as the original file and let it replace the preview.
        const current = new URL(guest.getURL())
        if (next.origin === current.origin && next.pathname === current.pathname) return
      } catch { /* malformed destinations are blocked as well */ }
      event.preventDefault()
      sendLink(url)
    })
    guest.on('will-redirect', (event, url, _inPlace, mainFrame) => {
      if (mainFrame && !htmlPreviews.owns(url)) event.preventDefault()
    })
    guest.setWindowOpenHandler(({ url }) => { sendLink(url); return { action: 'deny' } })
    guest.on('dom-ready', () => {
      // Page content retains its own layout/theme; only scrollbar chrome follows
      // the app-wide rule. User-origin CSS also covers page-owned scrollports.
      void guest.insertCSS('*{scrollbar-width:none!important}*::-webkit-scrollbar{display:none!important}', { cssOrigin: 'user' }).catch(() => {})
    })
    guest.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && (input.meta || input.control) && input.key.toLowerCase() === 'f') {
        event.preventDefault()
        window.webContents.send('files:htmlFind', guest.id)
      }
    })
  })
}
