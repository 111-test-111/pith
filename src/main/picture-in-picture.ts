import { app, BrowserWindow, ipcMain, screen, type Rectangle } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { PictureInPictureStateDTO } from '../shared/types'
import { guardExternalNavigation } from './navigation'
import { registerQuitShortcut } from './shutdown'

const WIDTH = 380
const HEIGHT = 320
const DISPLAY_MARGIN = 24
const MIN_VISIBLE_EDGE = 48

/** One compact view of the current session. The full renderer stays mounted in
 * its hidden window, so browser tabs, terminals and unsent drafts survive. */
class PictureInPictureController {
  constructor(private readonly paths: { preload?: string; documentUrl?: string } = {}) {}

  private window: BrowserWindow | null = null
  private owner: BrowserWindow | null = null
  private sessionPath: string | null = null
  private pinned = true
  private quitting = false
  private lastBounds: Rectangle | null = null

  private state(): PictureInPictureStateDTO | null {
    return this.sessionPath ? { sessionPath: this.sessionPath, pinned: this.pinned } : null
  }

  private position(source: BrowserWindow): { x: number; y: number } {
    if (this.lastBounds) {
      const { x, y } = this.lastBounds
      const visible = screen.getAllDisplays().some(({ workArea }) =>
        x + WIDTH > workArea.x + MIN_VISIBLE_EDGE &&
        x < workArea.x + workArea.width - MIN_VISIBLE_EDGE &&
        y + HEIGHT > workArea.y + MIN_VISIBLE_EDGE &&
        y < workArea.y + workArea.height - MIN_VISIBLE_EDGE
      )
      if (visible) return { x, y }
    }
    const { workArea } = screen.getDisplayMatching(source.getBounds())
    return {
      x: workArea.x + Math.max(0, workArea.width - WIDTH - DISPLAY_MARGIN),
      y: workArea.y + Math.max(0, workArea.height - HEIGHT - DISPLAY_MARGIN)
    }
  }

  async open(source: BrowserWindow | null, sessionPath: string): Promise<boolean> {
    if (!source || source.isDestroyed() || !sessionPath || this.quitting) return false
    if (this.window && !this.window.isDestroyed()) {
      this.window.show()
      this.window.focus()
      return true
    }

    const win = new BrowserWindow({
      ...this.position(source),
      width: WIDTH,
      height: HEIGHT,
      frame: false,
      transparent: true,
      hasShadow: true,
      resizable: false,
      maximizable: false,
      fullscreenable: false,
      show: false,
      alwaysOnTop: true,
      title: 'Pith',
      backgroundColor: '#00000000',
      webPreferences: {
        preload: this.paths.preload ?? join(__dirname, '../preload/index.mjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        spellcheck: false,
        backgroundThrottling: false
      }
    })
    this.window = win
    this.owner = source
    this.sessionPath = sessionPath
    this.pinned = true
    win.setAlwaysOnTop(true, 'floating')
    registerQuitShortcut(win.webContents, () => app.quit())
    const closeWithOwner = () => {
      if (this.window === win && !win.isDestroyed()) win.close()
    }
    source.once('closed', closeWithOwner)
    win.on('close', () => { this.lastBounds = win.getBounds() })
    win.on('closed', () => {
      source.removeListener('closed', closeWithOwner)
      if (this.window !== win) return
      this.window = null
      this.sessionPath = null
      const owner = this.owner
      this.owner = null
      if (!this.quitting && owner && !owner.isDestroyed()) {
        owner.show()
        owner.focus()
      }
    })
    const documentUrl = this.paths.documentUrl ?? process.env.ELECTRON_RENDERER_URL
      ?? pathToFileURL(join(__dirname, '../renderer/index.html')).toString()
    guardExternalNavigation(win.webContents, documentUrl)
    const url = new URL(documentUrl)
    url.searchParams.set('view', 'pip')
    try {
      await win.loadURL(url.toString())
      if (win.isDestroyed() || source.isDestroyed() || this.quitting) {
        if (!win.isDestroyed()) win.close()
        return false
      }
      win.show()
      source.hide()
      win.focus()
      return true
    } catch {
      if (!win.isDestroyed()) win.close()
      return false
    }
  }

  stateFor(sender: Electron.WebContents): PictureInPictureStateDTO | null {
    return this.window?.webContents === sender ? this.state() : null
  }

  setPinned(sender: Electron.WebContents, pinned: boolean): PictureInPictureStateDTO | null {
    if (this.window?.webContents !== sender || typeof pinned !== 'boolean') return null
    this.pinned = pinned
    this.window.setAlwaysOnTop(pinned, 'floating')
    return this.state()
  }

  restore(sender: Electron.WebContents): boolean {
    if (this.window?.webContents !== sender) return false
    this.window.close()
    return true
  }

  focus(): boolean {
    if (!this.window || this.window.isDestroyed()) return false
    this.window.show()
    this.window.focus()
    return true
  }

  /** IPC bridges that need the full renderer must never pick the compact view. */
  mainWindow(): BrowserWindow | null {
    if (this.owner && !this.owner.isDestroyed()) return this.owner
    const focused = BrowserWindow.getFocusedWindow()
    if (focused && focused !== this.window) return focused
    return BrowserWindow.getAllWindows().find((window) => window !== this.window && !window.isDestroyed()) ?? null
  }

  dispose(): void {
    this.quitting = true
    if (this.window && !this.window.isDestroyed()) this.window.close()
  }
}

export function registerPictureInPictureIpc(paths?: { preload?: string; documentUrl?: string }): PictureInPictureController {
  const controller = new PictureInPictureController(paths)
  ipcMain.handle('window:pipOpen', (event, sessionPath: string) =>
    controller.open(BrowserWindow.fromWebContents(event.sender), sessionPath))
  ipcMain.handle('window:pipState', (event) => controller.stateFor(event.sender))
  ipcMain.handle('window:pipPinned', (event, pinned: boolean) => controller.setPinned(event.sender, pinned))
  ipcMain.handle('window:pipRestore', (event) => controller.restore(event.sender))
  return controller
}
