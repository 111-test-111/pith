import type { RewindPatchDTO, RewindStatsDTO, RewindStatsTargetDTO } from '../shared/types'
import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  AppInfoDTO,
  RewindResult,
  RewindListDTO,
  RewindPreviewDTO,
  RewindCommitDTO,
  RewindRequest,
  BashTaskDTO,
  BashTaskOutputDTO,
  BashTaskRequest,
  AppendPromptDTO,
  AuthPromptDTO,
  AuthNotifyDTO,
  CatalogRecommendationDTO,
  CustomModelDTO,
  DefaultModelDTO,
  DiscoveredModelDTO,
  FileHitDTO,
  FilePreviewDTO,
  FileBrowserRequest,
  FileActionResultDTO,
  FileDirectoryDTO,
  FileDocumentDTO,
  FileGitDiffDTO,
  FontDataDTO,
  PdfStatDTO,
  TableSliceDTO,
  TableStatDTO,
  ForkResultDTO,
  ImageContent,
  ModelConfigSourceDTO,
  ModelDTO,
  ModelsConfigDTO,
  PiEvent,
  PromptPayload,
  ProviderDTO,
  ProviderModelDTO,
  QueueActionPayload,
  RecalledItemDTO,
  ResendPayload,
  SessionSnapshotDTO,
  SessionSearchRequest,
  SessionSearchResultDTO,
  SessionSummaryDTO,
  SideChatAskPayload,
  SideChatEvent,
  SkillContentDTO,
  StartupSessionMode,
  SubagentActionPayload,
  SubagentRunDTO,
  TestModelResultDTO,
  ThinkingLevel,
  SandboxMode,
  TerminalCreatePayload,
  TerminalCreateResult,
  TerminalEvent,
  ToolCatalogDTO,
  UsageStatsDTO,
  WindowTheme
} from '../shared/types'

const api = {
  platform: process.platform,
  rewindList: (path: string): Promise<RewindResult<RewindListDTO>> => ipcRenderer.invoke('rewind:list', path),
  rewindPreview: (path: string, checkpoint: string, action?: 'undo' | 'redo'): Promise<RewindResult<RewindPreviewDTO>> => ipcRenderer.invoke('rewind:preview', path, checkpoint, action),
  rewindPreviewFile: (path: string, token: string, file: string): Promise<RewindResult<RewindPreviewDTO>> => ipcRenderer.invoke('rewind:preview-file', path, token, file),
  rewindStats: (path: string, token: string, file: string, area: 'worktree' | 'index', stage?: number): Promise<RewindResult<RewindStatsDTO>> => ipcRenderer.invoke('rewind:stats', path, token, file, area, stage),
  rewindStatsBatch: (path: string, token: string, targets: RewindStatsTargetDTO[]): Promise<RewindResult<RewindStatsDTO[]>> => ipcRenderer.invoke('rewind:stats-batch', path, token, targets),
  rewindPatch: (path: string, token: string, file: string, area: 'worktree' | 'index', stage?: number): Promise<RewindResult<RewindPatchDTO>> => ipcRenderer.invoke('rewind:patch', path, token, file, area, stage),
  rewindRestore: (request: RewindRequest): Promise<RewindResult<RewindCommitDTO>> => ipcRenderer.invoke('rewind:restore', request),
  rewindRecover: (path: string, operationId: string): Promise<RewindResult<RewindCommitDTO>> => ipcRenderer.invoke('rewind:recover', path, operationId),
  onRewind: (listener: (event: { sessionPath: string }) => void) => subscribe('pi:rewind', listener),
  setCheckpointsEnabled: (enabled: boolean): Promise<boolean> => ipcRenderer.invoke('app:setCheckpointsEnabled', enabled),
  setStartup: (mode: StartupSessionMode): Promise<StartupSessionMode> =>
    ipcRenderer.invoke('app:setStartup', mode),
  setWindowTheme: (theme: WindowTheme): void => ipcRenderer.send('window:setTheme', theme),
  terminalCreate: (payload: TerminalCreatePayload): Promise<TerminalCreateResult> =>
    ipcRenderer.invoke('terminal:create', payload),
  terminalInput: (id: string, data: string, binary = false): void =>
    ipcRenderer.send('terminal:command', { type: 'input', id, data, binary }),
  terminalResize: (id: string, cols: number, rows: number): void =>
    ipcRenderer.send('terminal:command', { type: 'resize', id, cols, rows }),
  terminalAck: (id: string, chars: number): void =>
    ipcRenderer.send('terminal:command', { type: 'ack', id, chars }),
  terminalClose: (id: string): void =>
    ipcRenderer.send('terminal:command', { type: 'close', id }),
  onTerminalEvent: (listener: (event: TerminalEvent) => void) => subscribe('terminal:event', listener),
  listBashTasks: (sessionPath: string): Promise<BashTaskDTO[]> => ipcRenderer.invoke('bash:list', sessionPath),
  bashTaskOutput: (request: BashTaskRequest): Promise<BashTaskOutputDTO> => ipcRenderer.invoke('bash:output', request),
  stopBashTask: (request: BashTaskRequest): Promise<BashTaskDTO> => ipcRenderer.invoke('bash:stop', request),
  onBashTask: (listener: (task: BashTaskDTO) => void) => subscribe('pi:bash-task', listener),
  setBashMaxWaitMs: (value: number): Promise<number> => ipcRenderer.invoke('app:setBashMaxWaitMs', value),
  setSandboxMode: (mode: SandboxMode): Promise<SandboxMode> => ipcRenderer.invoke('app:setSandboxMode', mode),
  /** Change one session's mode; resolves with that session's fresh snapshot. */
  setSessionSandboxMode: (sessionPath: string, mode: SandboxMode): Promise<SessionSnapshotDTO> =>
    ipcRenderer.invoke('sandbox:setMode', sessionPath, mode),
  /** Compact one session's context on demand (the CLI's `/compact`). */
  compactSession: (sessionPath: string): Promise<SessionSnapshotDTO> =>
    ipcRenderer.invoke('pi:compact', sessionPath),
  listSubagents: (sessionPath: string): Promise<SubagentRunDTO[]> => ipcRenderer.invoke('subagents:list', sessionPath),
  /** One session's transcript without making it the active session (the rail's
   * read-only subagent view). */
  peekSession: (path: string): Promise<SessionSnapshotDTO> => ipcRenderer.invoke('pi:peekSession', path),
  subagentAction: (payload: SubagentActionPayload): Promise<void> => ipcRenderer.invoke('subagents:action', payload),
  setSubagentsEnabled: (enabled: boolean): Promise<boolean> => ipcRenderer.invoke('subagents:setEnabled', enabled),
  appInfo: (): Promise<AppInfoDTO> => ipcRenderer.invoke('app:info'),
  setContextFiles: (enabled: boolean): Promise<boolean> =>
    ipcRenderer.invoke('app:setContextFiles', enabled),
  pickDirectory: (): Promise<{ cwd: string } | { cancelled: true }> =>
    ipcRenderer.invoke('app:pickDirectory'),

  init: (cwd?: string): Promise<SessionSnapshotDTO> => ipcRenderer.invoke('pi:init', cwd),
  newSession: (cwd?: string): Promise<SessionSnapshotDTO> => ipcRenderer.invoke('pi:newSession', cwd),
  openSession: (path: string, cwd?: string): Promise<SessionSnapshotDTO> =>
    ipcRenderer.invoke('pi:openSession', path, cwd),
  listSessions: (): Promise<SessionSummaryDTO[]> => ipcRenderer.invoke('pi:listSessions'),
  searchSessions: (request: SessionSearchRequest): Promise<SessionSearchResultDTO> =>
    ipcRenderer.invoke('pi:searchSessions', request),
  usageStats: (): Promise<UsageStatsDTO> => ipcRenderer.invoke('pi:usageStats'),
  deleteSession: (path: string): Promise<SessionSnapshotDTO | null> =>
    ipcRenderer.invoke('pi:deleteSession', path),
  renameSession: (path: string, name: string): Promise<void> =>
    ipcRenderer.invoke('pi:renameSession', path, name),
  deleteFolder: (cwd: string): Promise<SessionSnapshotDTO | null> =>
    ipcRenderer.invoke('pi:deleteFolder', cwd),
  prompt: (payload: PromptPayload): Promise<{ accepted: boolean }> =>
    ipcRenderer.invoke('pi:prompt', payload),
  /**
   * Side chat (`/btw`): one no-tools question per call, streamed back on
   * `pi:side-chat`. The exchange list lives in the renderer, so main holds no
   * side-chat state between questions.
   */
  sideChatAsk: (payload: SideChatAskPayload): Promise<{ exchangeId: string }> =>
    ipcRenderer.invoke('pi:sideChatAsk', payload),
  sideChatAbort: (exchangeId: string): Promise<{ accepted: boolean }> =>
    ipcRenderer.invoke('pi:sideChatAbort', exchangeId),
  clearQueue: (stopping = false): Promise<{ steering: RecalledItemDTO[]; followUp: RecalledItemDTO[] }> =>
    ipcRenderer.invoke('pi:clearQueue', stopping),
  queueAction: (payload: QueueActionPayload): Promise<{ accepted: boolean }> =>
    ipcRenderer.invoke('pi:queueAction', payload),
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
  cancelLogin: (providerId: string): Promise<void> =>
    ipcRenderer.invoke('pi:loginCancel', providerId),
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

  appendPrompt: (): Promise<AppendPromptDTO> => ipcRenderer.invoke('pi:appendPrompt'),
  setAppendPrompt: (text: string): Promise<AppendPromptDTO> =>
    ipcRenderer.invoke('pi:setAppendPrompt', text),

  toolsCatalog: (): Promise<ToolCatalogDTO> => ipcRenderer.invoke('pi:toolsCatalog'),
  setExtensionEnabled: (id: string, enabled: boolean): Promise<ToolCatalogDTO> =>
    ipcRenderer.invoke('pi:setExtensionEnabled', id, enabled),
  updateExtension: (source: string): Promise<ToolCatalogDTO> =>
    ipcRenderer.invoke('pi:updateExtension', source),
  removeExtension: (source: string): Promise<ToolCatalogDTO> =>
    ipcRenderer.invoke('pi:removeExtension', source),
  installExtension: (source: string): Promise<ToolCatalogDTO> =>
    ipcRenderer.invoke('pi:installExtension', source),
  setSkillModelInvocation: (filePath: string, disabled: boolean): Promise<ToolCatalogDTO> =>
    ipcRenderer.invoke('pi:setSkillModelInvocation', filePath, disabled),
  readSkill: (filePath: string): Promise<SkillContentDTO> =>
    ipcRenderer.invoke('pi:readSkill', filePath),

  searchFiles: (query: string): Promise<FileHitDTO[]> =>
    ipcRenderer.invoke('files:search', query),
  readFile: (path: string): Promise<FilePreviewDTO> => ipcRenderer.invoke('files:read', path),
  listFileDirectory: (request: FileBrowserRequest, offset?: number): Promise<FileDirectoryDTO> => ipcRenderer.invoke('files:directory', request, offset),
  readFileDocument: (request: FileBrowserRequest): Promise<FileDocumentDTO> => ipcRenderer.invoke('files:document', request),
  readFileGitDiff: (request: FileBrowserRequest): Promise<FileGitDiffDTO> => ipcRenderer.invoke('files:gitDiff', request),
  /** PDF preview reads: the size, then exactly the byte ranges pdf.js asks for
   * (`end` exclusive, see shared/pdf.ts). */
  pdfStat: (request: FileBrowserRequest): Promise<PdfStatDTO> => ipcRenderer.invoke('files:pdfStat', request),
  pdfRange: (request: FileBrowserRequest, begin: number, end: number): Promise<Uint8Array> => ipcRenderer.invoke('files:pdfRange', request, begin, end),
  /** The bytes of a font file, for `new FontFace(family, buffer)`. A font is
   * deliberately not served over `pith-media` (see main/font.ts). */
  fontData: (request: FileBrowserRequest): Promise<FontDataDTO> => ipcRenderer.invoke('files:fontData', request),
  /** Table preview reads: the format/delimiter, record-aligned text slices of a
   * delimited file, and raw byte ranges of a spreadsheet's ZIP (shared/table.ts). */
  tableStat: (request: FileBrowserRequest): Promise<TableStatDTO> => ipcRenderer.invoke('files:tableStat', request),
  tableSlice: (request: FileBrowserRequest, offset: number, maxBytes?: number): Promise<TableSliceDTO> => ipcRenderer.invoke('files:tableSlice', request, offset, maxBytes),
  tableRange: (request: FileBrowserRequest, begin: number, end: number): Promise<Uint8Array> => ipcRenderer.invoke('files:tableRange', request, begin, end),
  saveFileCopy: (path: string): Promise<FileActionResultDTO> => ipcRenderer.invoke('files:saveCopy', path),
  readImage: (path: string): Promise<ImageContent | null> =>
    ipcRenderer.invoke('files:readImage', path),
  /**
   * Absolute path backing a File from a file picker, drag-drop or paste.
   * Electron removed the old non-standard `File.path` in v32; `webUtils` is its
   * supported replacement and must run here in the preload. Returns '' for a
   * File with no local backing (e.g. dragged out of a browser page).
   */
  pathForFile: (file: Parameters<typeof webUtils.getPathForFile>[0]): string => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ''
    }
  },

  openPath: (path: string): Promise<string> => ipcRenderer.invoke('shell:openPath', path),
  showInFolder: (path: string): Promise<void> => ipcRenderer.invoke('shell:showInFolder', path),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('shell:openExternal', url),

  onEvent: (listener: (event: PiEvent) => void) => subscribe('pi:event', listener),
  /** Side-chat stream (deltas and the terminal status of one exchange). */
  onSideChatEvent: (listener: (event: SideChatEvent) => void) =>
    subscribe('pi:side-chat', listener),
  onAuthPrompt: (listener: (prompt: AuthPromptDTO) => void) =>
    subscribe('pi:auth-prompt', listener),
  onAuthDismiss: (listener: (payload: { requestId?: string; providerId?: string }) => void) =>
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
