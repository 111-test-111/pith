import { app, BrowserWindow, dialog, screen } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { appendCdpSwitches, pickCdpPort } from './browser/cdp-port.ts'
import { installBrowserWiring } from './browser/wiring.ts'
import { broadcast, createPiManager, registerIpc } from './ipc'
import { installMediaProtocol, registerMediaScheme } from './media-protocol'
import { installHtmlPreviewWiring } from './html-preview-wiring'
import { guardExternalNavigation } from './navigation'
import { loadSettings, saveSettings, type WindowBounds } from './settings'
import { registerPictureInPictureIpc } from './picture-in-picture'
import { registerQuitShortcut } from './shutdown'
import { windowChromeOptions } from './window-chrome'
import { getLibraryService, startLibraryService } from './library/service'
import { registerLibraryIpc } from './library/ipc'
import { acquireRuntimeLock } from './runtime-lock'

// A privileged scheme has to be declared before the app is ready.
registerMediaScheme()
// Same for the embedded browser's CDP endpoint: the port must be picked and its
// Chromium switches appended before the app is ready.
appendCdpSwitches(pickCdpPort())

// Keep existing settings and Chromium storage through the product rename.
app.setPath('userData', join(app.getPath('appData'), 'pi-app'))
app.setName('Pith')
if (process.platform === 'win32') app.setAppUserModelId('app.pith.desktop')

const iconDirectory = app.isPackaged
  ? join(process.resourcesPath, 'icons')
  : join(app.getAppPath(), 'resources/icons')

process.on('unhandledRejection', (reason) => {
  console.error('[Pith] Unhandled rejection:', reason)
})

const DEFAULT_WIDTH = 1320
const DEFAULT_HEIGHT = 880
const MIN_WIDTH = 760
const MIN_HEIGHT = 560
/** Resize/move fire per frame; one write per gesture is enough. */
const BOUNDS_SAVE_DELAY_MS = 400
/** How much of the window must still land on a display to reuse its position. */
const MIN_VISIBLE_EDGE = 48

/**
 * The size/position to open with: the saved normal bounds when a window has
 * been sized before, otherwise the built-in default. A saved position is reused
 * only while it still lands on a connected display — a monitor that was
 * unplugged since must not put the window off-screen — and the size is clamped
 * to the window minimums.
 */
function restoredWindowBounds(saved: WindowBounds | null): { x?: number; y?: number; width: number; height: number } {
  if (!saved) return { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT }
  const width = Math.max(MIN_WIDTH, Math.round(saved.width) || DEFAULT_WIDTH)
  const height = Math.max(MIN_HEIGHT, Math.round(saved.height) || DEFAULT_HEIGHT)
  const x = typeof saved.x === 'number' ? Math.round(saved.x) : undefined
  const y = typeof saved.y === 'number' ? Math.round(saved.y) : undefined
  if (x === undefined || y === undefined) return { width, height }
  const onScreen = screen.getAllDisplays().some(({ workArea }) => {
    return (
      x + width > workArea.x + MIN_VISIBLE_EDGE &&
      x < workArea.x + workArea.width - MIN_VISIBLE_EDGE &&
      y + height > workArea.y + MIN_VISIBLE_EDGE &&
      y < workArea.y + workArea.height - MIN_VISIBLE_EDGE
    )
  })
  return onScreen ? { x, y, width, height } : { width, height }
}

function createWindow(): BrowserWindow {
  const saved = loadSettings().windowBounds
  const win = new BrowserWindow({
    ...restoredWindowBounds(saved),
    ...windowChromeOptions(),
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    show: false,
    title: 'Pith',
    icon: join(iconDirectory, process.platform === 'win32' ? 'icon.ico' : '512x512.png'),
    // A vibrancy window (macOS, window-chrome.ts) must not paint an opaque
    // backing — the material itself is what shows behind the page.
    backgroundColor: process.platform === 'darwin' ? '#00000000' : '#1e1e1e',
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      // The embedded browser's pages are <webview> guests hosted by the renderer.
      webviewTag: true
    }
  })

  registerQuitShortcut(win.webContents, () => app.quit())

  // Embedded browser wiring: per-contents window-open routing (this replaces the
  // window-level open-external handler that used to live below), guest input relay,
  // download takeover and the permission allowlist for the browser partition. The
  // wiring installs unconditionally; only the input relay is service-aware, and it
  // looks the singleton up lazily via getBrowserService() — a designed no-op until
  // the service initializes in ipc.ts (registerIpc).
  installBrowserWiring(win, broadcast, (owner) => {
    const library = getLibraryService()
    if (!library) return undefined
    const source = library.downloadSession(owner)
    return (path, url) => library.download(path, url, source)
  })
  installHtmlPreviewWiring(win)

  // Restore the maximized state the window was closed in. Reading bounds while
  // maximized or full screen yields the maximized rect, so persistence always
  // goes through `getNormalBounds` (below) to keep the size to return to.
  if (saved?.maximized) win.maximize()

  let boundsSaveTimer: NodeJS.Timeout | undefined
  const persistBounds = (): void => {
    clearTimeout(boundsSaveTimer)
    boundsSaveTimer = undefined
    const bounds = win.isMaximized() || win.isFullScreen() ? win.getNormalBounds() : win.getBounds()
    saveSettings({
      ...loadSettings(),
      windowBounds: {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        maximized: win.isMaximized(),
        fullscreen: win.isFullScreen()
      }
    })
  }
  const scheduleBoundsSave = (): void => {
    clearTimeout(boundsSaveTimer)
    boundsSaveTimer = setTimeout(persistBounds, BOUNDS_SAVE_DELAY_MS)
  }
  win.on('resize', scheduleBoundsSave)
  win.on('move', scheduleBoundsSave)
  win.on('maximize', scheduleBoundsSave)
  win.on('unmaximize', scheduleBoundsSave)
  win.on('enter-full-screen', scheduleBoundsSave)
  win.on('leave-full-screen', scheduleBoundsSave)
  // Flush the pending write so a resize in the last 400ms before quitting is
  // not lost.
  win.on('close', persistBounds)

  win.on('ready-to-show', () => {
    win.show()
    // macOS ignores setFullScreen before the window is visible, so restore the
    // full-screen state only once it is on screen.
    if (saved?.fullscreen) win.setFullScreen(true)
  })

  // The window is an application shell, never a document viewer; see
  // `navigation.ts` for the document comparison and why it is not a string one.
  const appDocument = process.env.ELECTRON_RENDERER_URL ?? pathToFileURL(join(__dirname, '../renderer/index.html')).toString()
  guardExternalNavigation(win.webContents, appDocument)

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

app.whenReady().then(async () => {
  try {
    const release = await acquireRuntimeLock()
    app.once('quit', () => { void release().catch(error => console.error('[Pith] Runtime unlock failed:', error)) })
  } catch (error) {
    dialog.showErrorBox('Pith', error instanceof Error ? error.message : String(error))
    app.quit()
    return
  }
  // BrowserWindow.icon does not set the macOS Dock icon during development.
  if (process.platform === 'darwin') app.dock?.setIcon(join(iconDirectory, '512x512.png'))
  const pi = createPiManager()
  const library = startLibraryService(broadcast, (id) => pi.librarySession(id))
  registerLibraryIpc(library)
  const pictureInPicture = registerPictureInPictureIpc()
  const isQuitting = registerIpc(pi, () => pictureInPicture.mainWindow(), (preferences) => pictureInPicture.setPreferences(preferences))
  app.on('before-quit', () => pictureInPicture.dispose())
  // The scheduler boots with the app: cheap when no tasks are saved (the
  // first tick short-circuits before touching storage or the agent engine).
  pi.startScheduledTasks()
  installMediaProtocol()
  createWindow()

  app.on('activate', () => {
    if (isQuitting()) return
    if (pictureInPicture.focus()) return
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
