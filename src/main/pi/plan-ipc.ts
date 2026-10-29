import { dialog, ipcMain } from 'electron'
import type { PlanDocumentRequest, PlanModeRequest } from '../../shared/types'
import type { PiManager } from './manager'
import { exportPlan } from './plan-export'

/** Same routes in the desktop app and the isolated Electron transport check. */
export function registerPlanIpc(pi: PiManager): void {
  ipcMain.handle('plan:export', (_e, request: PlanDocumentRequest) => exportPlan(request, r => pi.readPlanDocument(r), defaultPath => dialog.showSaveDialog({ defaultPath, filters: [{ name: 'Markdown', extensions: ['md'] }] })))
  ipcMain.handle('plan:setMode', (_e, request: PlanModeRequest) => pi.setSessionMode(request))
  ipcMain.handle('plan:state', (_e, path: string) => pi.getPlanState(path))
  ipcMain.handle('plan:document', (_e, request: PlanDocumentRequest) => pi.readPlanDocument(request))
  ipcMain.handle('plan:approve', (_e, request: PlanDocumentRequest) => pi.approvePlan(request))
  ipcMain.handle('plan:resetApproval', (_e, request: PlanDocumentRequest) => pi.resetPlanApproval(request))
}
