import { app, ipcMain, dialog, shell, BrowserWindow } from 'electron'
import { PiManager } from './pi/manager'
import { TerminalManager } from './terminal/manager'
import { isDefaultWorkspace } from './pi/default-workspace'
import { loadSettings, saveSettings } from './settings'
import type {
  AppInfoDTO,
  CustomModelDTO,
  ModelsConfigDTO,
  PromptPayload,
  QueueActionPayload,
  ResendPayload,
  SessionSnapshotDTO,
  SessionSearchRequest,
  SideChatAskPayload,
  ThinkingLevel
} from '../shared/types'

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
  const terminals = new TerminalManager()
  ipcMain.handle('terminal:create', (event, payload) => terminals.create(event.sender, payload))
  ipcMain.on('terminal:command', (event, command) => terminals.command(event.sender, command))
  let quitting = false
  app.on('before-quit', (event) => {
    if (quitting) return
    event.preventDefault()
    quitting = true
    void terminals.dispose().finally(() => app.quit())
  })

  ipcMain.handle('app:info', (): AppInfoDTO => {
    const settings = loadSettings()
    return {
      cwd: settings.cwd && !isDefaultWorkspace(settings.cwd) ? settings.cwd : null,
      folders: settings.folders.filter((f) => typeof f === 'string' && !isDefaultWorkspace(f)),
      contextFiles: settings.contextFiles !== false,
      version: app.getVersion()
    }
  })

  ipcMain.handle('app:setContextFiles', (_event, enabled: boolean): Promise<boolean> =>
    pi.setContextFilesEnabled(enabled)
  )

  ipcMain.handle('app:pickDirectory', async (): Promise<{ cwd: string } | { cancelled: true }> => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || !result.filePaths[0]) return { cancelled: true }
    const cwd = result.filePaths[0]
    saveSettings({ ...loadSettings(), cwd })
    return { cwd }
  })

  ipcMain.handle('pi:init', (_event, cwd?: string): Promise<SessionSnapshotDTO> => pi.init(cwd))
  ipcMain.handle('pi:newSession', (_event, cwd?: string): Promise<SessionSnapshotDTO> => pi.newSession(cwd))
  ipcMain.handle('pi:openSession', (_event, path: string, cwd?: string) => pi.openSession(path, cwd))
  ipcMain.handle('pi:listSessions', () => pi.listSessions())
  ipcMain.handle('pi:searchSessions', (_event, request: SessionSearchRequest) => pi.searchSessions(request))
  ipcMain.handle('pi:deleteSession', (_event, path: string) => pi.deleteSession(path))
  ipcMain.handle('pi:renameSession', (_event, path: string, name: string) =>
    pi.renameSession(path, name)
  )
  ipcMain.handle('pi:deleteFolder', (_event, cwd: string) => pi.deleteFolderSessions(cwd))
  ipcMain.handle('pi:prompt', (_event, payload: PromptPayload) => {
    pi.prompt(payload)
    return { accepted: true }
  })
  ipcMain.handle('pi:sideChatAsk', (_event, payload: SideChatAskPayload) => pi.sideChatAsk(payload))
  ipcMain.handle('pi:sideChatAbort', (_event, exchangeId: string) => {
    pi.sideChatAbort(exchangeId)
    return { accepted: true }
  })
  ipcMain.handle('pi:clearQueue', () => pi.clearQueue())
  ipcMain.handle('pi:queueAction', (_event, payload: QueueActionPayload) => {
    pi.queueAction(payload)
    return { accepted: true }
  })
  ipcMain.handle('pi:abort', () => {
    pi.abort()
    return { accepted: true }
  })
  ipcMain.handle('pi:resendMessage', (_event, payload: ResendPayload) => pi.resendMessage(payload))
  ipcMain.handle('pi:forkFromMessage', (_event, timestamp: number) => pi.forkFromMessage(timestamp))
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
  ipcMain.handle('pi:loginCancel', (_event, providerId: string) => pi.cancelLogin(providerId))
  ipcMain.handle('pi:logout', (_event, providerId: string) => pi.logout(providerId))

  ipcMain.handle('pi:modelsConfig', () => pi.modelsConfig())
  ipcMain.handle('pi:saveModelsConfig', (_event, config: ModelsConfigDTO) =>
    pi.saveModelsConfig(config)
  )
  ipcMain.handle('pi:providerModels', (_event, providerId: string) => pi.providerModels(providerId))
  ipcMain.handle('pi:discoverModels', (_event, providerId: string) =>
    pi.discoverProviderModels(providerId)
  )
  ipcMain.handle('pi:testModel', (_event, providerId: string, model: CustomModelDTO) =>
    pi.testProviderModel(providerId, model)
  )
  ipcMain.handle('pi:defaultModel', () => pi.defaultModel())
  ipcMain.handle('pi:setDefaultModel', (_event, providerId: string, modelId: string) =>
    pi.setDefaultModel(providerId, modelId)
  )
  ipcMain.handle('pi:catalogPreset', (_event, providerId: string, modelId: string) =>
    pi.catalogPreset(providerId, modelId)
  )
  ipcMain.handle('pi:configuredModels', () => pi.configuredModelSources())

  ipcMain.handle('pi:appendPrompt', () => pi.appendPrompt())
  ipcMain.handle('pi:setAppendPrompt', (_event, text: string) => pi.setAppendPrompt(text))

  ipcMain.handle('pi:toolsCatalog', () => pi.catalog())
  ipcMain.handle('pi:setExtensionEnabled', (_event, id: string, enabled: boolean) =>
    pi.setExtensionEnabled(id, enabled)
  )
  ipcMain.handle('pi:updateExtension', (_event, source: string) => pi.updateExtension(source))
  ipcMain.handle('pi:removeExtension', (_event, source: string) => pi.removeExtension(source))
  ipcMain.handle('pi:installExtension', (_event, source: string) => pi.installExtension(source))
  ipcMain.handle(
    'pi:setSkillModelInvocation',
    (_event, filePath: string, disableModelInvocation: boolean) =>
      pi.setSkillModelInvocation(filePath, disableModelInvocation)
  )
  ipcMain.handle('pi:readSkill', (_event, filePath: string) => pi.readSkill(filePath))

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
