import { ipcMain, shell } from 'electron'
import type { PiManager } from '../pi/manager'
import type { GitDiffRequest, GitGraphRequest, GitHistoryRequest, GitMutation, GitWorkspaceRequest } from '../../shared/git'
import { GitWorkbench } from './service'

export function registerGitIpc(pi: PiManager): GitWorkbench {
  const git = new GitWorkbench({ coordinator: pi.checkoutCoordinator, workspace: () => pi.gitWorkspace(), trash: path => shell.trashItem(path) })
  ipcMain.handle('git:status', (_event, request: GitWorkspaceRequest) => git.status(request))
  ipcMain.handle('git:diff', (_event, request: GitDiffRequest) => git.diff(request))
  ipcMain.handle('git:branches', (_event, request: GitWorkspaceRequest) => git.branches(request))
  ipcMain.handle('git:history', (_event, request: GitHistoryRequest) => git.history(request))
  ipcMain.handle('git:graph', (_event, request: GitGraphRequest) => git.graph(request))
  ipcMain.handle('git:commitDetails', (_event, request: GitWorkspaceRequest & { commit: string }) => git.commitDetails(request))
  ipcMain.handle('git:commitFiles', (_event, request: GitWorkspaceRequest & { commit: string }) => git.commitFiles(request))
  ipcMain.handle('git:prepareDiscard', (_event, request: GitWorkspaceRequest & { revision: string; paths: string[] }) => git.prepareDiscard(request))
  ipcMain.handle('git:execute', (_event, request: GitMutation) => git.execute(request))
  ipcMain.handle('git:cancel', (_event, request: GitWorkspaceRequest & { id: string }) => git.cancel(request))
  return git
}
