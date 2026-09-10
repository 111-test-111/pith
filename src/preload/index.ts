import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppInfoDTO,
  AuthPromptDTO,
  AuthNotifyDTO,
  FileHitDTO,
  FilePreviewDTO,
  ImageContent,
  ModelDTO,
  PiEvent,
  PromptPayload,
  ProviderDTO,
  SessionSnapshotDTO,
  SessionSummaryDTO,
  ThinkingLevel
} from '../shared/types'

const api = {
  appInfo: (): Promise<AppInfoDTO> => ipcRenderer.invoke('app:info'),
  pickDirectory: (): Promise<{ cwd: string } | { cancelled: true }> =>
    ipcRenderer.invoke('app:pickDirectory'),

  init: (cwd: string): Promise<SessionSnapshotDTO> => ipcRenderer.invoke('pi:init', cwd),
  newSession: (): Promise<SessionSnapshotDTO> => ipcRenderer.invoke('pi:newSession'),
  openSession: (path: string, cwd?: string): Promise<SessionSnapshotDTO> =>
    ipcRenderer.invoke('pi:openSession', path, cwd),
  listSessions: (): Promise<SessionSummaryDTO[]> => ipcRenderer.invoke('pi:listSessions'),
  deleteSession: (path: string): Promise<SessionSnapshotDTO | null> =>
    ipcRenderer.invoke('pi:deleteSession', path),
  deleteFolder: (cwd: string): Promise<SessionSnapshotDTO | null> =>
    ipcRenderer.invoke('pi:deleteFolder', cwd),
  prompt: (payload: PromptPayload): Promise<{ accepted: boolean }> =>
    ipcRenderer.invoke('pi:prompt', payload),
  steer: (text: string): Promise<{ accepted: boolean }> => ipcRenderer.invoke('pi:steer', text),
  abort: (): Promise<{ accepted: boolean }> => ipcRenderer.invoke('pi:abort'),
  setModel: (providerId: string, modelId: string): Promise<SessionSnapshotDTO> =>
    ipcRenderer.invoke('pi:setModel', providerId, modelId),
  setThinkingLevel: (level: ThinkingLevel): Promise<SessionSnapshotDTO> =>
    ipcRenderer.invoke('pi:setThinkingLevel', level),
  providers: (): Promise<ProviderDTO[]> => ipcRenderer.invoke('pi:providers'),
  models: (): Promise<ModelDTO[]> => ipcRenderer.invoke('pi:models'),
  login: (providerId: string, kind: 'api_key' | 'oauth'): Promise<void> =>
    ipcRenderer.invoke('pi:login', providerId, kind),
  logout: (providerId: string): Promise<void> => ipcRenderer.invoke('pi:logout', providerId),

  searchFiles: (query: string): Promise<FileHitDTO[]> =>
    ipcRenderer.invoke('files:search', query),
  readFile: (path: string): Promise<FilePreviewDTO> => ipcRenderer.invoke('files:read', path),
  readImage: (path: string): Promise<ImageContent | null> =>
    ipcRenderer.invoke('files:readImage', path),

  openPath: (path: string): Promise<string> => ipcRenderer.invoke('shell:openPath', path),
  showInFolder: (path: string): Promise<void> => ipcRenderer.invoke('shell:showInFolder', path),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('shell:openExternal', url),

  onEvent: (listener: (event: PiEvent) => void) => subscribe('pi:event', listener),
  onSnapshot: (listener: (snapshot: SessionSnapshotDTO) => void) =>
    subscribe('pi:snapshot', listener),
  onAuthPrompt: (listener: (prompt: AuthPromptDTO) => void) =>
    subscribe('pi:auth-prompt', listener),
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
