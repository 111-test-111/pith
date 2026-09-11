import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppInfoDTO,
  AuthPromptDTO,
  AuthNotifyDTO,
  CatalogRecommendationDTO,
  CustomModelDTO,
  DefaultModelDTO,
  DiscoveredModelDTO,
  FileHitDTO,
  FilePreviewDTO,
  ForkResultDTO,
  ImageContent,
  ModelConfigSourceDTO,
  ModelDTO,
  ModelsConfigDTO,
  PiEvent,
  PromptPayload,
  ProviderDTO,
  ProviderModelDTO,
  ResendPayload,
  SessionSnapshotDTO,
  SessionSummaryDTO,
  TestModelResultDTO,
  ThinkingLevel
} from '../shared/types'

const api = {
  appInfo: (): Promise<AppInfoDTO> => ipcRenderer.invoke('app:info'),
  pickDirectory: (): Promise<{ cwd: string } | { cancelled: true }> =>
    ipcRenderer.invoke('app:pickDirectory'),

  init: (cwd: string): Promise<SessionSnapshotDTO> => ipcRenderer.invoke('pi:init', cwd),
  newSession: (cwd?: string): Promise<SessionSnapshotDTO> => ipcRenderer.invoke('pi:newSession', cwd),
  openSession: (path: string, cwd?: string): Promise<SessionSnapshotDTO> =>
    ipcRenderer.invoke('pi:openSession', path, cwd),
  listSessions: (): Promise<SessionSummaryDTO[]> => ipcRenderer.invoke('pi:listSessions'),
  deleteSession: (path: string): Promise<SessionSnapshotDTO | null> =>
    ipcRenderer.invoke('pi:deleteSession', path),
  renameSession: (path: string, name: string): Promise<void> =>
    ipcRenderer.invoke('pi:renameSession', path, name),
  deleteFolder: (cwd: string): Promise<SessionSnapshotDTO | null> =>
    ipcRenderer.invoke('pi:deleteFolder', cwd),
  prompt: (payload: PromptPayload): Promise<{ accepted: boolean }> =>
    ipcRenderer.invoke('pi:prompt', payload),
  clearQueue: (): Promise<{ steering: string[]; followUp: string[] }> =>
    ipcRenderer.invoke('pi:clearQueue'),
  abort: (): Promise<{ accepted: boolean }> => ipcRenderer.invoke('pi:abort'),
  resendMessage: (payload: ResendPayload): Promise<SessionSnapshotDTO> =>
    ipcRenderer.invoke('pi:resendMessage', payload),
  forkFromMessage: (timestamp: number): Promise<ForkResultDTO> =>
    ipcRenderer.invoke('pi:forkFromMessage', timestamp),
  setModel: (providerId: string, modelId: string): Promise<SessionSnapshotDTO> =>
    ipcRenderer.invoke('pi:setModel', providerId, modelId),
  setThinkingLevel: (level: ThinkingLevel): Promise<SessionSnapshotDTO> =>
    ipcRenderer.invoke('pi:setThinkingLevel', level),
  providers: (): Promise<ProviderDTO[]> => ipcRenderer.invoke('pi:providers'),
  models: (): Promise<ModelDTO[]> => ipcRenderer.invoke('pi:models'),
  login: (providerId: string, kind: 'api_key' | 'oauth'): Promise<void> =>
    ipcRenderer.invoke('pi:login', providerId, kind),
  logout: (providerId: string): Promise<void> => ipcRenderer.invoke('pi:logout', providerId),

  modelsConfig: (): Promise<ModelsConfigDTO> => ipcRenderer.invoke('pi:modelsConfig'),
  saveModelsConfig: (config: ModelsConfigDTO): Promise<ModelsConfigDTO> =>
    ipcRenderer.invoke('pi:saveModelsConfig', config),
  providerModels: (providerId: string): Promise<ProviderModelDTO[]> =>
    ipcRenderer.invoke('pi:providerModels', providerId),
  discoverModels: (providerId: string): Promise<DiscoveredModelDTO[]> =>
    ipcRenderer.invoke('pi:discoverModels', providerId),
  testModel: (providerId: string, model: CustomModelDTO): Promise<TestModelResultDTO> =>
    ipcRenderer.invoke('pi:testModel', providerId, model),
  defaultModel: (): Promise<DefaultModelDTO | null> => ipcRenderer.invoke('pi:defaultModel'),
  setDefaultModel: (providerId: string, modelId: string): Promise<void> =>
    ipcRenderer.invoke('pi:setDefaultModel', providerId, modelId),
  catalogPreset: (providerId: string, modelId: string): Promise<CatalogRecommendationDTO> =>
    ipcRenderer.invoke('pi:catalogPreset', providerId, modelId),
  configuredModels: (): Promise<ModelConfigSourceDTO[]> =>
    ipcRenderer.invoke('pi:configuredModels'),

  searchFiles: (query: string): Promise<FileHitDTO[]> =>
    ipcRenderer.invoke('files:search', query),
  readFile: (path: string): Promise<FilePreviewDTO> => ipcRenderer.invoke('files:read', path),
  readImage: (path: string): Promise<ImageContent | null> =>
    ipcRenderer.invoke('files:readImage', path),

  openPath: (path: string): Promise<string> => ipcRenderer.invoke('shell:openPath', path),
  showInFolder: (path: string): Promise<void> => ipcRenderer.invoke('shell:showInFolder', path),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('shell:openExternal', url),

  onEvent: (listener: (event: PiEvent) => void) => subscribe('pi:event', listener),
  onAuthPrompt: (listener: (prompt: AuthPromptDTO) => void) =>
    subscribe('pi:auth-prompt', listener),
  onAuthDismiss: (listener: (payload: { requestId: string }) => void) =>
    subscribe('pi:auth-dismiss', listener),
  onAuthNotify: (listener: (notify: AuthNotifyDTO) => void) =>
    subscribe('pi:auth-notify', listener),
  replyAuth: (requestId: string, value: string | null) =>
    ipcRenderer.send('pi:auth-reply', { requestId, value })
}

function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const wrapped = (_event: unknown, payload: T) => listener(payload)
  ipcRenderer.on(channel, wrapped as never)
  return () => ipcRenderer.removeListener(channel, wrapped as never)
}

contextBridge.exposeInMainWorld('pi', api)

export type PiApi = typeof api
