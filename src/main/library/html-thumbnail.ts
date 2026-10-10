import { BrowserWindow } from 'electron'
import { dirname } from 'node:path'
import { htmlPreviews } from '../html-preview'
import { installHtmlPreviewWiring } from '../html-preview-wiring'
import { HTML_PREVIEW_PARTITION } from '../../shared/html-preview'

/** Render through the same confined origin/partition as full HTML previews.
 * Virtual cards receive pixels, never a live guest or raw HTML in the shell. */
export async function captureLibraryHtml(path: string, windows: Set<BrowserWindow>, signal: AbortSignal): Promise<string | null> {
  if (signal.aborted || windows.size >= 2) return null
  const preview = await htmlPreviews.open({ cwd: dirname(path), path })
  if (!preview.url || signal.aborted || windows.size >= 2) return null
  const win = new BrowserWindow({ show: false, width: 480, height: 320, useContentSize: true, paintWhenInitiallyHidden: true,
    webPreferences: { offscreen: true, backgroundThrottling: false, disableDialogs: true,
      sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false, webSecurity: true, partition: HTML_PREVIEW_PARTITION } })
  windows.add(win)
  const cancel = () => { if (!win.isDestroyed()) win.destroy() }
  signal.addEventListener('abort', cancel, { once: true })
  installHtmlPreviewWiring(win)
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event, url) => { if (url !== preview.url) event.preventDefault() })
  win.webContents.on('will-redirect', (event, url) => { if (url !== preview.url) event.preventDefault() })
  const timeout = setTimeout(() => { if (!win.isDestroyed()) win.destroy() }, 12_000)
  try {
    await win.loadURL(preview.url)
    // Fonts and two paints settle the captured frame; subsequent page animation
    // cannot change a mounted card or create extra native guests while scrolling.
    await win.webContents.executeJavaScript('document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))')
    const image = await win.webContents.capturePage({ x: 0, y: 0, width: 480, height: 320 })
    if (image.isEmpty()) return null
    // A bounded raster regardless of the display's device scale factor.
    return image.resize({ width: 480, height: 320 }).toDataURL()
  } catch { return null }
  finally { clearTimeout(timeout); signal.removeEventListener('abort', cancel); windows.delete(win); if (!win.isDestroyed()) win.destroy() }
}
