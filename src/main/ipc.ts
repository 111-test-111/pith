import { ipcMain, dialog, shell, BrowserWindow } from 'electron'
import { PiManager } from './pi/manager'
import { loadSettings, saveSettings } from './settings'
import type { AppInfoDTO, PromptPayload, SessionSnapshotDTO, ThinkingLevel } from '../shared/types'

export function createPiManager(): PiManager {
  const emit = (channel: string, payload: unknown) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(channel, payload)
    }
  }
  const notifyError = (message: string) => emit('pi:event', { type: 'pi_error', message })
  return new PiManager(emit, notifyError)
}

export function registerIpc(pi: PiManager): void {
  ipcMain.handle('app:info', (): AppInfoDTO => {
    const settings = loadSettings()
    return {
      cwd: settings.cwd,
      folders: settings.folders.filter((f) => typeof f === 'string'),
      version: process.env.npm_package_version ?? '0.1.0'
    }
  })

  ipcMain.handle('app:pickDirectory', async (): Promise<{ cwd: string } | { cancelled: true }> => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const result = await dialog.showOpenDialog(win, {
      title: 'Choose a working directory for Pi',
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || !result.filePaths[0]) return { cancelled: true }
    const cwd = result.filePaths[0]
    saveSettings({ ...loadSettings(), cwd })
    return { cwd }
  })

  ipcMain.handle('pi:init', (_event, cwd: string): Promise<SessionSnapshotDTO> => pi.init(cwd))
  ipcMain.handle('pi:newSession', (): Promise<SessionSnapshotDTO> => pi.newSession())
  ipcMain.handle('pi:openSession', (_event, path: string, cwd?: string) => pi.openSession(path, cwd))
  ipcMain.handle('pi:listSessions', () => pi.listSessions())
  ipcMain.handle('pi:deleteSession', (_event, path: string) => pi.deleteSession(path))
  ipcMain.handle('pi:deleteFolder', (_event, cwd: string) => pi.deleteFolderSessions(cwd))
  ipcMain.handle('pi:prompt', (_event, payload: PromptPayload) => {
    pi.prompt(payload)
    return { accepted: true }
  })
  ipcMain.handle('pi:steer', (_event, text: string) => {
    pi.steer(text)
    return { accepted: true }
  })
  ipcMain.handle('pi:abort', () => {
    pi.abort()
    return { accepted: true }
  })
  ipcMain.handle('pi:setModel', (_event, providerId: string, modelId: string) =>
    pi.setModel(providerId, modelId)
  )
  ipcMain.handle('pi:setThinkingLevel', (_event, level: ThinkingLevel) =>
    pi.setThinkingLevel(level)
  )
  ipcMain.handle('pi:providers', () => pi.providers())
  ipcMain.handle('pi:models', () => pi.models())
  ipcMain.handle('pi:login', (_event, providerId: string, kind: 'api_key' | 'oauth') =>
    pi.login(providerId, kind)
  )
  ipcMain.handle('pi:logout', (_event, providerId: string) => pi.logout(providerId))

  ipcMain.handle('files:search', (_event, query: string) => pi.searchFiles(query))
  ipcMain.handle('files:read', (_event, path: string) => pi.readFile(path))
  ipcMain.handle('files:readImage', (_event, path: string) => pi.readImage(path))

  ipcMain.handle('shell:openPath', (_event, path: string) => shell.openPath(path))
  ipcMain.handle('shell:showInFolder', (_event, path: string) => shell.showItemInFolder(path))
  ipcMain.handle('shell:openExternal', (_event, url: string) => shell.openExternal(url))

  ipcMain.on('pi:auth-reply', (_event, payload: { requestId: string; value: string | null }) => {
    pi.resolveAuthPrompt(payload)
  })
}
