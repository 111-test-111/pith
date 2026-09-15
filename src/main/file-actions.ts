import { dialog, type BrowserWindow } from 'electron'
import { copyFile, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type { FileActionResultDTO } from '../shared/types'

const validPath = (path: string) => typeof path === 'string' && isAbsolute(path) && !path.includes('\0')

export async function saveFileCopy(win: BrowserWindow, path: string): Promise<FileActionResultDTO> {
  try {
    if (!validPath(path)) return { status: 'error' }
    const source = await stat(path)
    if (!source.isFile()) return { status: 'error' }
    const result = await dialog.showSaveDialog(win, { defaultPath: path, properties: ['showOverwriteConfirmation', 'createDirectory'] })
    if (result.canceled || !result.filePath) return { status: 'cancelled' }
    const target = await stat(result.filePath).catch(() => null)
    if (target?.dev === source.dev && target?.ino === source.ino) return { status: 'ok' }
    await copyFile(path, result.filePath)
    return { status: 'ok' }
  } catch { return { status: 'error' } }
}
