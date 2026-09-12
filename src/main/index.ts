import { app, BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { createPiManager, registerIpc } from './ipc'

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

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 760,
    minHeight: 560,
    show: false,
    title: 'Pith',
    icon: join(iconDirectory, process.platform === 'win32' ? 'icon.ico' : '512x512.png'),
    backgroundColor: '#0b0b0d',
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  })

  win.on('ready-to-show', () => win.show())

  // Open external links in the system browser instead of a new app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

app.whenReady().then(() => {
  // BrowserWindow.icon does not set the macOS Dock icon during development.
  if (process.platform === 'darwin') app.dock?.setIcon(join(iconDirectory, '512x512.png'))
  const pi = createPiManager()
  registerIpc(pi)
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })

  app.on('before-quit', () => pi.dispose())
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
