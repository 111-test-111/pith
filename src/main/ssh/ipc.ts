import { BrowserWindow, ipcMain } from 'electron'
import type { SshOutputDTO, SshOutputRequest, SshPanelRequest, SshPanelResult, SshSessionDTO } from '../../shared/ssh'

interface SshBridge {
  listSshSessions(): SshSessionDTO[]
  sshOutput(request: SshOutputRequest): Promise<SshOutputDTO>
  sshPanelAction(request: SshPanelRequest): Promise<SshPanelResult>
  watchSshViewer(id: number, active: boolean): void
  ackSshViewer(id: number, connectionId: string, chars: number): void
}
export function registerSshIpc(pi: SshBridge): void {
  const caller = (event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): boolean => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return !!win && win.webContents === event.sender && event.senderFrame === event.sender.mainFrame
  }
  ipcMain.handle('ssh:list', event => caller(event) ? pi.listSshSessions() : [])
  ipcMain.handle('ssh:output', (event, request: SshOutputRequest) => {
    if (!caller(event) || !request || typeof request.id !== 'string' || typeof request.sessionPath !== 'string' || (request.snapshot !== undefined && typeof request.snapshot !== 'boolean')) throw new Error('SSH output unavailable')
    return pi.sshOutput(request)
  })
  ipcMain.handle('ssh:action', (event, request: SshPanelRequest) => {
    if (!caller(event) || !request || typeof request.id !== 'string' || typeof request.sessionPath !== 'string' || !['write', 'resize', 'reconnect', 'close'].includes(request.action)) return { error: 'unavailable' }
    return pi.sshPanelAction(request)
  })
  const watched = new WeakSet<Electron.WebContents>()
  ipcMain.on('ssh:watch', (event, active: boolean) => {
    if (!caller(event) || typeof active !== 'boolean') return
    pi.watchSshViewer(event.sender.id, active)
    if (!watched.has(event.sender)) {
      watched.add(event.sender)
      event.sender.on('render-process-gone', () => pi.watchSshViewer(event.sender.id, false))
      event.sender.once('destroyed', () => pi.watchSshViewer(event.sender.id, false))
    }
  })
  ipcMain.on('ssh:ack', (event, id: string, chars: number) => {
    if (caller(event) && typeof id === 'string' && Number.isSafeInteger(chars) && chars > 0 && chars <= 65_536) pi.ackSshViewer(event.sender.id, id, chars)
  })
}
