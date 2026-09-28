import { app, BrowserWindow, ipcMain, screen, type Rectangle } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type {
  PictureInPictureFrameDTO,
  PictureInPictureOpenRequest,
  PictureInPicturePreferencesDTO,
  PictureInPictureSourceDTO,
  PictureInPictureStateDTO
} from '../shared/types'
import { guardExternalNavigation } from './navigation'
import { loadSettings, saveSettings, type AppSettings } from './settings'
import { registerQuitShortcut } from './shutdown'

const MIN_WIDTH = 260
const MIN_HEIGHT = 180
const MAX_WIDTH = 560
const MAX_HEIGHT = 520
const DISPLAY_MARGIN = 24
const MIN_VISIBLE_EDGE = 48
const FRAME_MAX_EDGE = 1100
const LAST_SAVE_DELAY_MS = 350

type SizeLimits = { minWidth: number; maxWidth: number; ratio: number }

function validSource(source: BrowserWindow, input: PictureInPictureSourceDTO): PictureInPictureSourceDTO | null {
  if (!input || (input.kind !== 'conversation' && input.kind !== 'sidebar')) return null
  const rect = input.rect
  if (!rect || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) return null
  const { width, height } = source.getContentBounds()
  const x = Math.max(0, Math.floor(rect.x))
  const y = Math.max(0, Math.floor(rect.y))
  const right = Math.min(width, Math.ceil(rect.x + rect.width))
  const bottom = Math.min(height, Math.ceil(rect.y + rect.height))
  if (x >= width || y >= height || right - x < 100 || bottom - y < 100) return null
  return { kind: input.kind, rect: { x, y, width: right - x, height: bottom - y } }
}

function sizeLimits(rect: Rectangle, source: BrowserWindow): SizeLimits {
  // Extreme source shapes get a bounded frame; the image is contained rather
  // than cropped again inside that frame.
  const ratio = Math.max(0.5, Math.min(3, rect.width / rect.height))
  const { workArea } = screen.getDisplayMatching(source.getBounds())
  const minWidth = Math.max(MIN_WIDTH, Math.ceil(MIN_HEIGHT * ratio))
  const maxWidth = Math.max(minWidth, Math.min(
    MAX_WIDTH, Math.floor(MAX_HEIGHT * ratio),
    workArea.width - DISPLAY_MARGIN * 2,
    Math.floor((workArea.height - DISPLAY_MARGIN * 2) * ratio)
  ))
  return { minWidth, maxWidth, ratio }
}

/** Captures only the selected part of the full renderer while its original
 * window is hidden. The original DOM stays mounted with drafts and live panes. */
class PictureInPictureController {
  constructor(private readonly paths: { preload?: string; documentUrl?: string } = {}) {}

  private window: BrowserWindow | null = null
  private owner: BrowserWindow | null = null
  private sessionPath: string | null = null
  private source: PictureInPictureSourceDTO | null = null
  private limits: SizeLimits | null = null
  private pinned = true
  private quitting = false
  private preferences = loadSettings().pictureInPicture
  private lastSaveTimer: ReturnType<typeof setTimeout> | null = null
  private backgroundThrottling: boolean | null = null
  private captureTimer: ReturnType<typeof setTimeout> | null = null
  private latestFrame: PictureInPictureFrameDTO | null = null
  private lastJpeg: Buffer | null = null
  private frameSequence = 0

  private state(): PictureInPictureStateDTO | null {
    if (!this.sessionPath || !this.source || !this.window || !this.limits) return null
    const width = this.window.getBounds().width
    return {
      sessionPath: this.sessionPath,
      pinned: this.pinned,
      frameRate: this.preferences.frameRate,
      source: this.source.kind,
      canZoomIn: width < this.limits.maxWidth - 1,
      canZoomOut: width > this.limits.minWidth + 1
    }
  }

  private publishState(): void {
    const state = this.state()
    if (state && this.window && !this.window.isDestroyed()) {
      this.window.webContents.send('window:pipStateChanged', state)
    }
  }

  private position(source: BrowserWindow, width: number, height: number, settings: AppSettings): { x: number; y: number } {
    const placement = settings.pictureInPicture.position
    const last = settings.pictureInPictureLast
    if (placement === 'last' && last) {
      const display = screen.getAllDisplays().find(({ workArea }) =>
        last.x + width > workArea.x + MIN_VISIBLE_EDGE &&
        last.x < workArea.x + workArea.width - MIN_VISIBLE_EDGE &&
        last.y + height > workArea.y + MIN_VISIBLE_EDGE &&
        last.y < workArea.y + workArea.height - MIN_VISIBLE_EDGE
      )
      if (display) {
        const { workArea } = display
        return {
          x: Math.max(workArea.x, Math.min(Math.round(last.x), workArea.x + workArea.width - width)),
          y: Math.max(workArea.y, Math.min(Math.round(last.y), workArea.y + workArea.height - height))
        }
      }
    }
    const { workArea } = screen.getDisplayMatching(source.getBounds())
    if (placement === 'center') return {
      x: Math.round(workArea.x + (workArea.width - width) / 2),
      y: Math.round(workArea.y + (workArea.height - height) / 2)
    }
    const left = placement === 'top-left' || placement === 'bottom-left'
    const top = placement === 'top-left' || placement === 'top-right'
    return {
      x: left ? workArea.x + DISPLAY_MARGIN : workArea.x + Math.max(0, workArea.width - width - DISPLAY_MARGIN),
      y: top ? workArea.y + DISPLAY_MARGIN : workArea.y + Math.max(0, workArea.height - height - DISPLAY_MARGIN)
    }
  }

  private persistLast(win: BrowserWindow): void {
    if (this.window !== win || !this.source || win.isDestroyed()) return
    const bounds = win.getBounds()
    saveSettings({
      ...loadSettings(),
      pictureInPictureLast: { x: bounds.x, y: bounds.y, scale: bounds.width / this.source.rect.width }
    })
  }

  private scheduleLastSave(win: BrowserWindow): void {
    if (this.lastSaveTimer) clearTimeout(this.lastSaveTimer)
    this.lastSaveTimer = setTimeout(() => {
      this.lastSaveTimer = null
      this.persistLast(win)
    }, LAST_SAVE_DELAY_MS)
  }

  private scheduleCapture(win: BrowserWindow, source: BrowserWindow, delay = Math.round(1000 / this.preferences.frameRate)): void {
    if (this.window !== win || win.isDestroyed() || source.isDestroyed() || this.quitting) return
    this.captureTimer = setTimeout(() => { void this.capture(win, source) }, delay)
  }

  private async capture(win: BrowserWindow, source: BrowserWindow): Promise<void> {
    if (this.window !== win || win.isDestroyed() || source.isDestroyed() || !this.source || this.quitting) return
    if (!win.isVisible() || win.isMinimized()) {
      this.scheduleCapture(win, source, 500)
      return
    }
    try {
      const image = await source.webContents.capturePage(this.source.rect, { stayHidden: true, stayAwake: true })
      if (this.window !== win || win.isDestroyed() || image.isEmpty()) return
      const natural = image.getSize()
      const factor = Math.min(1, FRAME_MAX_EDGE / Math.max(natural.width, natural.height))
      const frameImage = factor < 1 ? image.resize({
        width: Math.max(1, Math.round(natural.width * factor)),
        height: Math.max(1, Math.round(natural.height * factor))
      }) : image
      const jpeg = frameImage.toJPEG(78)
      if (this.lastJpeg?.equals(jpeg)) return
      this.lastJpeg = jpeg
      const size = frameImage.getSize()
      const frame: PictureInPictureFrameDTO = {
        sequence: ++this.frameSequence,
        width: size.width,
        height: size.height,
        dataUrl: `data:image/jpeg;base64,${jpeg.toString('base64')}`
      }
      this.latestFrame = frame
      win.webContents.send('window:pipFrame', frame)
    } catch {
      // Hide, display changes and navigation can transiently disrupt capture.
      // Keep the last frame and retry at the bounded cadence.
    } finally {
      this.scheduleCapture(win, source)
    }
  }

  async open(source: BrowserWindow | null, request: PictureInPictureOpenRequest): Promise<boolean> {
    if (!source || source.isDestroyed() || !request || typeof request.sessionPath !== 'string' ||
      !request.sessionPath || this.quitting || source === this.window) return false
    if (this.window && !this.window.isDestroyed()) {
      this.window.show()
      this.window.focus()
      return true
    }
    const selected = validSource(source, request.source)
    if (!selected) return false
    const settings = loadSettings()
    this.preferences = settings.pictureInPicture
    const limits = sizeLimits(selected.rect, source)
    const desiredScale = this.preferences.initialScale === 'last'
      ? settings.pictureInPictureLast?.scale ?? 0.5
      : Number(this.preferences.initialScale) / 100
    const width = Math.max(limits.minWidth, Math.min(limits.maxWidth, Math.round(selected.rect.width * desiredScale)))
    const height = Math.round(width / limits.ratio)
    const win = new BrowserWindow({
      ...this.position(source, width, height, settings),
      width,
      height,
      minWidth: limits.minWidth,
      minHeight: Math.round(limits.minWidth / limits.ratio),
      maxWidth: limits.maxWidth,
      maxHeight: Math.round(limits.maxWidth / limits.ratio),
      frame: false,
      transparent: true,
      hasShadow: true,
      resizable: true,
      maximizable: false,
      fullscreenable: false,
      show: false,
      alwaysOnTop: this.preferences.startPinned,
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
    win.setAspectRatio(limits.ratio)
    this.window = win
    this.owner = source
    this.sessionPath = request.sessionPath
    this.source = selected
    this.limits = limits
    this.pinned = this.preferences.startPinned
    this.latestFrame = null
    this.lastJpeg = null
    this.frameSequence = 0
    win.setAlwaysOnTop(this.pinned, 'floating')
    registerQuitShortcut(win.webContents, () => app.quit())
    const closeWithOwner = () => {
      if (this.window === win && !win.isDestroyed()) win.close()
    }
    source.once('closed', closeWithOwner)
    win.on('resize', () => { this.publishState(); this.scheduleLastSave(win) })
    win.on('move', () => this.scheduleLastSave(win))
    win.on('close', () => {
      if (this.lastSaveTimer) clearTimeout(this.lastSaveTimer)
      this.lastSaveTimer = null
      this.persistLast(win)
    })
    win.on('closed', () => {
      source.removeListener('closed', closeWithOwner)
      if (this.window !== win) return
      if (this.captureTimer) clearTimeout(this.captureTimer)
      this.captureTimer = null
      if (!source.isDestroyed() && this.backgroundThrottling !== null) {
        source.webContents.setBackgroundThrottling(this.backgroundThrottling)
      }
      this.backgroundThrottling = null
      this.window = null
      this.sessionPath = null
      this.source = null
      this.limits = null
      this.latestFrame = null
      this.lastJpeg = null
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
      this.backgroundThrottling = source.webContents.getBackgroundThrottling()
      source.webContents.setBackgroundThrottling(false)
      win.show()
      source.hide()
      win.focus()
      this.scheduleCapture(win, source, 0)
      return true
    } catch {
      if (!win.isDestroyed()) win.close()
      return false
    }
  }

  stateFor(sender: Electron.WebContents): PictureInPictureStateDTO | null {
    return this.window?.webContents === sender ? this.state() : null
  }

  frameFor(sender: Electron.WebContents): PictureInPictureFrameDTO | null {
    return this.window?.webContents === sender ? this.latestFrame : null
  }

  setPreferences(preferences: PictureInPicturePreferencesDTO): void {
    this.preferences = preferences
    this.publishState()
    if (this.captureTimer) {
      clearTimeout(this.captureTimer)
      this.captureTimer = null
      if (this.window && this.owner && !this.window.isDestroyed() && !this.owner.isDestroyed()) {
        this.scheduleCapture(this.window, this.owner)
      }
    }
  }

  setPinned(sender: Electron.WebContents, pinned: boolean): PictureInPictureStateDTO | null {
    if (this.window?.webContents !== sender || typeof pinned !== 'boolean') return null
    this.pinned = pinned
    this.window.setAlwaysOnTop(pinned, 'floating')
    this.publishState()
    return this.state()
  }

  zoom(sender: Electron.WebContents, direction: 'in' | 'out'): PictureInPictureStateDTO | null {
    if (this.window?.webContents !== sender || !this.limits || (direction !== 'in' && direction !== 'out')) return null
    const current = this.window.getBounds()
    const width = Math.max(this.limits.minWidth, Math.min(this.limits.maxWidth,
      Math.round(current.width * (direction === 'in' ? 1.2 : 1 / 1.2))))
    this.window.setSize(width, Math.round(width / this.limits.ratio))
    this.publishState()
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
  ipcMain.handle('window:pipOpen', (event, request: PictureInPictureOpenRequest) =>
    controller.open(BrowserWindow.fromWebContents(event.sender), request))
  ipcMain.handle('window:pipState', (event) => controller.stateFor(event.sender))
  ipcMain.handle('window:pipFrameSnapshot', (event) => controller.frameFor(event.sender))
  ipcMain.handle('window:pipPinned', (event, pinned: boolean) => controller.setPinned(event.sender, pinned))
  ipcMain.handle('window:pipZoom', (event, direction: 'in' | 'out') => controller.zoom(event.sender, direction))
  ipcMain.handle('window:pipRestore', (event) => controller.restore(event.sender))
  return controller
}
