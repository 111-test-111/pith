import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { join } from 'node:path'
import { copyFile } from 'node:fs/promises'
import type { LibraryKind, LibraryQuery, LibraryResult, LibrarySettingsUpdate } from '../../shared/library'
import type { FileActionResultDTO } from '../../shared/types'
import type { LibraryService } from './service'
import { captureLibraryHtml } from './html-thumbnail'

async function result<T>(work: () => Promise<T>): Promise<LibraryResult<T>> {
  try { return { ok: true, value: await work() } }
  catch (error) { const code = error instanceof Error ? error.message : ''
    return { ok: false, code: code === 'directory' || code === 'invalid' || code === 'missing' ? code : 'unavailable' } }
}

export function registerLibraryIpc(library: LibraryService): void {
  ipcMain.handle('library:status', () => result(() => library.status()))
  ipcMain.handle('library:page', (_event, query: LibraryQuery) => result(() => library.page(query)))
  ipcMain.handle('library:previewText', (_event, id: string) => result(() => {
    if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw new Error('invalid')
    return library.previewText(id)
  }))
  ipcMain.handle('library:htmlThumbnail', (_event, id: string) => result(() => {
    if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw new Error('invalid')
    return library.htmlThumbnail(id, captureLibraryHtml)
  }))
  ipcMain.handle('library:rescan', () => result(() => library.rescan()))
  ipcMain.handle('library:settings', (_event, update: LibrarySettingsUpdate) => result(() => library.configure(update)))
  ipcMain.handle('library:directory', (event, reset = false) => result(async () => {
    if (typeof reset !== 'boolean') throw new Error('invalid')
    if (reset) return library.configure({}, null)
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) throw new Error('unavailable')
    const chosen = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] })
    if (chosen.canceled || !chosen.filePaths[0]) return null
    return library.configure({}, join(chosen.filePaths[0], 'pith-library'))
  }))
  ipcMain.handle('library:delete', (_event, id: string) => result(() => library.remove(id)))
  ipcMain.handle('library:clear', (_event, kind: LibraryKind) => result(() => library.clear(kind)))
  ipcMain.handle('library:file', (_event, id: string) => result(async () => {
    if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw new Error('invalid')
    const path = await library.file(id)
    if (!path) throw new Error('missing')
    return path
  }))
  ipcMain.handle('library:saveCopy', async (event, id: string, name: string): Promise<FileActionResultDTO> => {
    try {
      if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id) || typeof name !== 'string') return { status: 'error' }
      const path = await library.file(id), win = BrowserWindow.fromWebContents(event.sender)
      if (!path || !win) return { status: 'error' }
      const filename = name.replace(/[\\/\0]/g, '_').slice(0, 200) || 'file'
      const chosen = await dialog.showSaveDialog(win, { defaultPath: join(app.getPath('downloads'), filename), properties: ['showOverwriteConfirmation', 'createDirectory'] })
      if (chosen.canceled || !chosen.filePath) return { status: 'cancelled' }
      if (chosen.filePath === path) return { status: 'ok' }
      await copyFile(path, chosen.filePath)
      return { status: 'ok' }
    } catch { return { status: 'error' } }
  })
}
