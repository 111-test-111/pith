import { ipcMain, BrowserWindow, dialog } from 'electron'
import type { PiManager } from '../manager'
import type { TrajectoryQuery, TrajectoryNodeRequest, FileActionResultDTO } from '../../../shared/types'

export function registerTrajectoryIpc(pi: PiManager): void {
  ipcMain.handle('trajectory:page', (_event, query: TrajectoryQuery) => pi.trajectoryPage(query))
  ipcMain.handle('trajectory:detail', (_event, path: string, id: string) => pi.trajectoryDetail(path, id))
  ipcMain.handle('trajectory:node', (_event, request: TrajectoryNodeRequest) => pi.trajectoryNode(request))
  ipcMain.handle('trajectory:export', async (event, path: string, id: string): Promise<FileActionResultDTO> => {
    try {
      await pi.trajectoryDetail(path, id)
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win) return { status: 'error' }
      const result = await dialog.showSaveDialog(win, { defaultPath: 'request.json', filters: [{ name: 'JSON', extensions: ['json'] }], properties: ['showOverwriteConfirmation', 'createDirectory'] })
      if (result.canceled || !result.filePath) return { status: 'cancelled' }
      await pi.exportTrajectory(path, id, result.filePath)
      return { status: 'ok' }
    } catch { return { status: 'error' } }
  })
}
