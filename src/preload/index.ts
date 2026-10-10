import type { TrajectoryQuery, TrajectoryPage, TrajectoryDetail, TrajectoryNodeRequest, TrajectoryNodePage } from '../shared/types'
import type { ImageReplayRequest, ImageReplaySnapshot } from '../shared/image-replay'
import type { GoalActionRequest, GoalActionResult } from '../shared/goal'
import type { GitBranch, GitCommitDetails, GitCommitFile, GitDiff, GitDiffRequest, GitDiscardPreview, GitGraph, GitGraphRequest, GitHistory, GitHistoryRequest, GitMutation, GitMutationReceipt, GitRepository, GitResult, GitWorkspaceRequest } from '../shared/git'
import type { LibraryKind, LibraryPage, LibraryQuery, LibraryResult, LibrarySettingsUpdate, LibraryStatus, LibraryTextPreview } from '../shared/library'
import type { AskUserAnswer } from '../shared/ask-user'
import type { ResourceResult, ResourceRuntimeDTO, ResourceStorageDTO } from '../shared/resources'
import type { BinaryPreviewRequest, PreviewResult } from '../shared/file-preview'
import type { JevSettingsDTO, JevSettingsUpdate, JevActionResult, JevEvaluationDTO, JevTraceDTO, JevTracePageDTO } from '../shared/types'
import type {
  BrowserDownloadInfo,
  BrowserFocusGuestPayload,
  BrowserGuestAppShortcutInfo,
  BrowserGuestShortcutInfo,
  BrowserPageMeta,
  BrowserPopupInfo,
  BrowserSeenPayload,
  BrowserSearchEngine,
  ElementAtInfo
} from '../shared/browser'
import type { RewindPatchDTO, RewindStatsDTO, RewindStatsTargetDTO } from '../shared/types'
import type { ScheduledTasksSnapshotDTO, ScheduledRunOutputDTO, ScheduledTaskResult } from '../shared/types'
import type { ScheduledTask, ScheduledTaskRun } from '../shared/scheduled-tasks'
import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  AppInfoDTO,
  PlanModeRequest, PlanDocumentRequest, PlanStateDTO, PlanDocumentDTO, PlanApprovalDTO, PlanActionResult,
  BrowserImportDiscoveryDTO,
  BrowserImportResultDTO,
  BrowserImportStatusDTO,
  BrowserStatusDTO,
  RewindResult,
  RewindListDTO,
  RewindPreviewDTO,
  RewindCommitDTO,
  RewindRequest,
  BashTaskDTO,
  BashTaskOutputDTO,
  DebugPanelRequest,
  DebugSourceRequest,
  DebugSourceContentDTO,
  DebugSessionDTO,
  DebugTerminalRequest,
  DebugTerminalResult,
  BashTaskRequest,
  AppendPromptDTO,
  AuthPromptDTO,
  AuthNotifyDTO,
  CatalogRecommendationDTO,
  ContextDetailDTO,
  CustomModelDTO,
  DefaultModelDTO,
  DiscoveredModelDTO,
  FileHitDTO,
  FilePreviewDTO,
  FileBrowserRequest,
  FileActionResultDTO,
  FileDirectoryDTO,
  FileDocumentDTO,
  HtmlPreviewDTO,
  HtmlPreviewLinkDTO,
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
  McpConfigScope,
  McpServerDetailDTO,
  McpStateDTO,
  McpStatusPushDTO,
  McpUpsertServerPayload,
  PiEvent,
  PictureInPictureFrameDTO,
  PictureInPictureOpenRequest,
  PictureInPicturePreferencesDTO,
  PictureInPictureStateDTO,
  PromptPayload,
  ProviderDTO,
  ProviderModelDTO,
  QueueActionPayload,
  RecalledItemDTO,
  ResendPayload,
  ContinuePayload,
  SessionSnapshotDTO,
  SessionSearchRequest,
  SessionSearchResultDTO,
  SessionSummaryDTO,
  SideChatAskPayload,
  SideChatEvent,
  SkillContentDTO,
  StartupSessionMode,
  SubagentActionPayload,
  SubagentProfileCreatePayload,
  SubagentProfileDefaultsPayload,
  SubagentProfilesDTO,
  SubagentRunDTO,
  TestModelResultDTO,
  ThinkingLevel,
  SandboxEscalationDecision,
  SandboxMode,
  TerminalCreatePayload,
  TerminalCreateResult,
  TerminalEvent,
  ToolCatalogDTO,
  UsageStatsDTO,
  WindowTheme
} from '../shared/types'

const api = {
  gitStatus: (request: GitWorkspaceRequest): Promise<GitResult<GitRepository>> => ipcRenderer.invoke('git:status', request),
  gitDiff: (request: GitDiffRequest): Promise<GitResult<GitDiff>> => ipcRenderer.invoke('git:diff', request),
  gitBranches: (request: GitWorkspaceRequest): Promise<GitResult<GitBranch[]>> => ipcRenderer.invoke('git:branches', request),
  gitHistory: (request: GitHistoryRequest): Promise<GitResult<GitHistory>> => ipcRenderer.invoke('git:history', request),
  gitGraph: (request: GitGraphRequest): Promise<GitResult<GitGraph>> => ipcRenderer.invoke('git:graph', request),
  gitCommitDetails: (request: GitWorkspaceRequest & { commit: string }): Promise<GitResult<GitCommitDetails>> => ipcRenderer.invoke('git:commitDetails', request),
  gitCommitFiles: (request: GitWorkspaceRequest & { commit: string }): Promise<GitResult<GitCommitFile[]>> => ipcRenderer.invoke('git:commitFiles', request),
  gitPrepareDiscard: (request: GitWorkspaceRequest & { revision: string; paths: string[] }): Promise<GitResult<GitDiscardPreview>> => ipcRenderer.invoke('git:prepareDiscard', request),
  gitExecute: (request: GitMutation): Promise<GitResult<GitMutationReceipt>> => ipcRenderer.invoke('git:execute', request),
  gitCancel: (request: GitWorkspaceRequest & { id: string }): Promise<GitResult<void>> => ipcRenderer.invoke('git:cancel', request),
  libraryStatus: (): Promise<LibraryResult<LibraryStatus>> => ipcRenderer.invoke('library:status'),
  libraryPage: (query: LibraryQuery): Promise<LibraryResult<LibraryPage>> => ipcRenderer.invoke('library:page', query),
  libraryRescan: (): Promise<LibraryResult<LibraryStatus>> => ipcRenderer.invoke('library:rescan'),
  setLibraryPreferences: (update: LibrarySettingsUpdate): Promise<LibraryResult<LibraryStatus>> => ipcRenderer.invoke('library:settings', update),
  libraryChooseDirectory: (reset = false): Promise<LibraryResult<LibraryStatus | null>> => ipcRenderer.invoke('library:directory', reset),
  libraryDelete: (id: string): Promise<LibraryResult<void>> => ipcRenderer.invoke('library:delete', id),
  libraryClear: (kind: LibraryKind): Promise<LibraryResult<number>> => ipcRenderer.invoke('library:clear', kind),
  libraryFile: (id: string): Promise<LibraryResult<string>> => ipcRenderer.invoke('library:file', id),
  libraryPreviewText: (id: string): Promise<LibraryResult<LibraryTextPreview | null>> => ipcRenderer.invoke('library:previewText', id),
  libraryHtmlThumbnail: (id: string): Promise<LibraryResult<string | null>> => ipcRenderer.invoke('library:htmlThumbnail', id),
  librarySaveCopy: (id: string, name: string): Promise<FileActionResultDTO> => ipcRenderer.invoke('library:saveCopy', id, name),
  onLibraryChanged: (listener: () => void) => subscribe('library:changed', listener),
  platform: process.platform,
  rewindList: (path: string): Promise<RewindResult<RewindListDTO>> => ipcRenderer.invoke('rewind:list', path),
  rewindPreview: (path: string, checkpoint: string, action?: 'undo' | 'redo'): Promise<RewindResult<RewindPreviewDTO>> => ipcRenderer.invoke('rewind:preview', path, checkpoint, action),
  rewindPreviewFile: (path: string, token: string, file: string): Promise<RewindResult<RewindPreviewDTO>> => ipcRenderer.invoke('rewind:preview-file', path, token, file),
  rewindStats: (path: string, token: string, file: string, area: 'worktree' | 'index', stage?: number): Promise<RewindResult<RewindStatsDTO>> => ipcRenderer.invoke('rewind:stats', path, token, file, area, stage),
  rewindStatsBatch: (path: string, token: string, targets: RewindStatsTargetDTO[]): Promise<RewindResult<RewindStatsDTO[]>> => ipcRenderer.invoke('rewind:stats-batch', path, token, targets),
  rewindPatch: (path: string, token: string, file: string, area: 'worktree' | 'index', stage?: number): Promise<RewindResult<RewindPatchDTO>> => ipcRenderer.invoke('rewind:patch', path, token, file, area, stage),
  rewindRestore: (request: RewindRequest): Promise<RewindResult<RewindCommitDTO>> => ipcRenderer.invoke('rewind:restore', request),
  rewindRecover: (path: string, operationId: string): Promise<RewindResult<RewindCommitDTO>> => ipcRenderer.invoke('rewind:recover', path, operationId),

  // Scheduled tasks: preload unwraps ScheduledTaskResult so call sites catch
  // ordinary Errors (with .status preserved for conflict handling).
  scheduledSnapshot: (): Promise<ScheduledTasksSnapshotDTO> => ipcRenderer.invoke('scheduled:snapshot').then(scheduledUnwrap<ScheduledTasksSnapshotDTO>),
  scheduledRunOutput: (runId: string): Promise<ScheduledRunOutputDTO> =>
    ipcRenderer.invoke('scheduled:runOutput', runId).then(scheduledUnwrap<ScheduledRunOutputDTO>),
  scheduledGet: (id: string): Promise<{ task: ScheduledTask; runs: ScheduledTaskRun[] }> =>
    ipcRenderer.invoke('scheduled:get', id).then(scheduledUnwrap<{ task: ScheduledTask; runs: ScheduledTaskRun[] }>),
  scheduledCreate: (input: unknown): Promise<ScheduledTask> => ipcRenderer.invoke('scheduled:create', input).then(scheduledUnwrap<ScheduledTask>),
  scheduledUpdate: (id: string, patch: Record<string, unknown>, revision?: number): Promise<ScheduledTask> =>
    ipcRenderer.invoke('scheduled:update', id, patch, revision).then(scheduledUnwrap<ScheduledTask>),
  scheduledDelete: (id: string, revision?: number): Promise<void> =>
    ipcRenderer.invoke('scheduled:delete', id, revision).then(scheduledUnwrap<void>),
  scheduledRunNow: (id: string, revision?: number): Promise<ScheduledTaskRun> =>
    ipcRenderer.invoke('scheduled:runNow', id, revision).then(scheduledUnwrap<ScheduledTaskRun>),
  scheduledCancelRun: (runId: string): Promise<ScheduledTaskRun> =>
    ipcRenderer.invoke('scheduled:cancelRun', runId).then(scheduledUnwrap<ScheduledTaskRun>),
  scheduledMarkRead: (runId: string): Promise<ScheduledTaskRun> =>
    ipcRenderer.invoke('scheduled:markRead', runId).then(scheduledUnwrap<ScheduledTaskRun>),
  scheduledDeleteRuns: (ids: string[]): Promise<{ deleted: number }> =>
    ipcRenderer.invoke('scheduled:deleteRuns', ids).then(scheduledUnwrap<{ deleted: number }>),
  /** Folder dialog for the scheduled-task editor; unlike pickDirectory it never
   * rewrites the app's current folder, so its result is not a task envelope. */
  scheduledPickDirectory: (): Promise<{ path: string } | { cancelled: true }> =>
    ipcRenderer.invoke('scheduled:pickDirectory'),
  onRewind: (listener: (event: { sessionPath: string }) => void) => subscribe('pi:rewind', listener),
  setCheckpointsEnabled: (enabled: boolean): Promise<boolean> => ipcRenderer.invoke('app:setCheckpointsEnabled', enabled),
  /** Toggles the browser_* agent tools for sessions (Settings → Browser). The
   * preference persists app-wide; main applies it to new sessions and live
   * reloads. */
  setBrowserAgentTools: (enabled: boolean): Promise<void> =>
    ipcRenderer.invoke('app:setBrowserAgentTools', enabled),
  setBrowserSearchEngine: (engine: BrowserSearchEngine): Promise<BrowserSearchEngine> =>
    ipcRenderer.invoke('app:setBrowserSearchEngine', engine),
  onBrowserSearchEngineChanged: (cb: (engine: BrowserSearchEngine) => void) =>
    subscribe('browser:searchEngineChanged', cb),
  jevSettings: (): Promise<JevSettingsDTO> => ipcRenderer.invoke('jev:settings'),
  updateJevSettings: (update: JevSettingsUpdate): Promise<JevActionResult<JevSettingsDTO>> => ipcRenderer.invoke('jev:updateSettings', update),
  testJev: (): Promise<JevActionResult<JevEvaluationDTO>> => ipcRenderer.invoke('jev:test'),
  trajectoryPage: (query: TrajectoryQuery): Promise<TrajectoryPage> => ipcRenderer.invoke('trajectory:page', query),
  trajectoryDetail: (path: string, id: string): Promise<TrajectoryDetail> => ipcRenderer.invoke('trajectory:detail', path, id),
  trajectoryNode: (request: TrajectoryNodeRequest): Promise<TrajectoryNodePage> => ipcRenderer.invoke('trajectory:node', request),
  exportTrajectory: (path: string, id: string): Promise<FileActionResultDTO> => ipcRenderer.invoke('trajectory:export', path, id),
  onTrajectoryChanged: (listener: (value: { sessionPath: string }) => void) => subscribe('pi:trajectory', listener),
  jevTraces: (path: string, cursor?: string): Promise<JevTracePageDTO> => ipcRenderer.invoke('jev:traces', path, cursor),
  jevTrace: (path: string, id: string): Promise<JevTraceDTO | null> => ipcRenderer.invoke('jev:trace', path, id),
  setStartup: (mode: StartupSessionMode): Promise<StartupSessionMode> =>
    ipcRenderer.invoke('app:setStartup', mode),
  setWindowTheme: (theme: WindowTheme): void => ipcRenderer.send('window:setTheme', theme),
setAlwaysOnTop: (flag: boolean): Promise<boolean> => ipcRenderer.invoke('window:setAlwaysOnTop', flag),
  openPictureInPicture: (request: PictureInPictureOpenRequest): Promise<boolean> => ipcRenderer.invoke('window:pipOpen', request),
  pictureInPicturePreferences: (): Promise<PictureInPicturePreferencesDTO> => ipcRenderer.invoke('window:pipPreferences'),
  setPictureInPicturePreferences: (update: Partial<PictureInPicturePreferencesDTO>): Promise<PictureInPicturePreferencesDTO> =>
    ipcRenderer.invoke('window:pipSetPreferences', update),
  pictureInPictureState: (): Promise<PictureInPictureStateDTO | null> => ipcRenderer.invoke('window:pipState'),
  pictureInPictureFrame: (): Promise<PictureInPictureFrameDTO | null> => ipcRenderer.invoke('window:pipFrameSnapshot'),
  onPictureInPictureFrame: (listener: (frame: PictureInPictureFrameDTO) => void) => subscribe('window:pipFrame', listener),
  onPictureInPictureState: (listener: (state: PictureInPictureStateDTO) => void) => subscribe('window:pipStateChanged', listener),
  setPictureInPicturePinned: (pinned: boolean): Promise<PictureInPictureStateDTO | null> =>
    ipcRenderer.invoke('window:pipPinned', pinned),
  zoomPictureInPicture: (direction: 'in' | 'out'): Promise<PictureInPictureStateDTO | null> =>
    ipcRenderer.invoke('window:pipZoom', direction),
  restoreFromPictureInPicture: (): Promise<boolean> => ipcRenderer.invoke('window:pipRestore'),
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
  /** Settings → General: enable/disable the DAP debugger tool. */
  setDebugEnabled: (enabled: boolean): Promise<void> =>
    ipcRenderer.invoke('app:setDebugEnabled', enabled),
  debugList: (sessionPath: string): Promise<DebugSessionDTO[]> =>
    ipcRenderer.invoke('debug:list', sessionPath),
  /** Panel-driven debug actions (step buttons, variable expansion, console
   * paging); shares the live session with the model's debug tool. */
  debugAction: (request: DebugPanelRequest): Promise<unknown> =>
    ipcRenderer.invoke('debug:action', request),
  debugSource: (request: DebugSourceRequest): Promise<DebugSourceContentDTO> => ipcRenderer.invoke('debug:source', request),
  onDebugEvent: (listener: (session: DebugSessionDTO) => void) => subscribe('debug:event', listener),
  /** DAP runInTerminal relay: main asks the renderer to host the debuggee in a
   * sidebar terminal tab; answer with debugTerminalResponse. */
  onDebugTerminalRequest: (listener: (request: DebugTerminalRequest) => void) => subscribe('debug:terminal-request', listener),
  debugTerminalResponse: (result: DebugTerminalResult): void =>
    ipcRenderer.send('debug:terminal-response', result),
  setBashMaxWaitMs: (value: number): Promise<number> => ipcRenderer.invoke('app:setBashMaxWaitMs', value),
  /** Auto-settle deadline for an unanswered ask_user_question panel, in seconds. */
  setAskUserTimeoutSeconds: (value: number): Promise<number> =>
    ipcRenderer.invoke('app:setAskUserTimeoutSeconds', value),
  /** Provider request timeout for an unanswered model request, in seconds. */
  setResponseTimeoutSeconds: (value: number): Promise<number> =>
    ipcRenderer.invoke('app:setResponseTimeoutSeconds', value),
  /** Settings → General: allow the composer's model and permission selectors to
   * change while a run is streaming. */
  setAllowMidRunChanges: (enabled: boolean): Promise<boolean> =>
    ipcRenderer.invoke('app:setAllowMidRunChanges', enabled),
  setSandboxMode: (mode: SandboxMode): Promise<SandboxMode> => ipcRenderer.invoke('app:setSandboxMode', mode),
  /** Change one session's mode; resolves with that session's fresh snapshot. */
  exportPlan: (request: PlanDocumentRequest): Promise<PlanActionResult<{ cancelled: boolean }>> => ipcRenderer.invoke('plan:export', request),
  setSessionMode: (request: PlanModeRequest): Promise<PlanActionResult<PlanStateDTO>> => ipcRenderer.invoke('plan:setMode', request),
  goalAction: (request: GoalActionRequest): Promise<GoalActionResult> => ipcRenderer.invoke('goal:action', request),
  getPlanState: (path: string): Promise<PlanStateDTO> => ipcRenderer.invoke('plan:state', path),
  readPlanDocument: (request: PlanDocumentRequest): Promise<PlanActionResult<PlanDocumentDTO>> => ipcRenderer.invoke('plan:document', request),
  approvePlan: (request: PlanDocumentRequest): Promise<PlanActionResult<PlanApprovalDTO>> => ipcRenderer.invoke('plan:approve', request),
  resetPlanApproval: (request: PlanDocumentRequest): Promise<PlanActionResult<PlanStateDTO>> => ipcRenderer.invoke('plan:resetApproval', request),
  setSessionSandboxMode: (sessionPath: string, mode: SandboxMode): Promise<SessionSnapshotDTO> =>
    ipcRenderer.invoke('sandbox:setMode', sessionPath, mode),
  /** Compact this session now or at its next complete response/tool boundary. */
  compactSession: (sessionPath: string): Promise<SessionSnapshotDTO> =>
    ipcRenderer.invoke('pi:compact', sessionPath),
  /** Re-read extensions/skills/prompts/context files on demand (the CLI's
   * `/reload`). Refused while that session runs. */
  reloadSession: (sessionPath: string): Promise<SessionSnapshotDTO> =>
    ipcRenderer.invoke('pi:reload', sessionPath),
  /** The session's current effective system prompt, read live off the SDK on
   * every call; the active session answers when no path is given. */
  systemPrompt: (sessionPath?: string): Promise<string> =>
    ipcRenderer.invoke('pi:systemPrompt', sessionPath),
  /** Answer one pending sandbox escalation for a session. */
  respondEscalation: (requestId: string, sessionPath: string, decision: SandboxEscalationDecision): Promise<boolean> =>
    ipcRenderer.invoke('sandbox:respondEscalation', requestId, sessionPath, decision),
  /** Answer (or dismiss) one pending ask_user_question set for a session. */
  respondAskUser: (requestId: string, ownerPath: string, payload: { answers?: AskUserAnswer[]; cancelled?: boolean }): Promise<boolean> =>
    ipcRenderer.invoke('askUser:respond', requestId, ownerPath, payload),
  /** The user touched the panel: main cancels the auto-settle countdown. */
  askUserEngage: (requestId: string, ownerPath: string): Promise<boolean> =>
    ipcRenderer.invoke('askUser:engage', requestId, ownerPath),
  listSubagents: (sessionPath: string): Promise<SubagentRunDTO[]> => ipcRenderer.invoke('subagents:list', sessionPath),
  /** One session's transcript without making it the active session (the rail's
   * read-only subagent view). */
  peekSession: (path: string): Promise<SessionSnapshotDTO> => ipcRenderer.invoke('pi:peekSession', path),
  subagentAction: (payload: SubagentActionPayload): Promise<void> => ipcRenderer.invoke('subagents:action', payload),
  setSubagentsEnabled: (enabled: boolean): Promise<boolean> => ipcRenderer.invoke('subagents:setEnabled', enabled),
  setSubagentReuseEnabled: (enabled: boolean): Promise<boolean> => ipcRenderer.invoke('subagents:setReuseEnabled', enabled),
  setSubagentCommsEnabled: (enabled: boolean): Promise<boolean> => ipcRenderer.invoke('subagents:setCommsEnabled', enabled),
  setSubagentTurnLimitOverrideEnabled: (enabled: boolean): Promise<boolean> => ipcRenderer.invoke('subagents:setTurnLimitOverrideEnabled', enabled),
  setSubagentMaxTurns: (value: number | null): Promise<number | null> => ipcRenderer.invoke('subagents:setMaxTurns', value),
  setSubagentMaxConcurrent: (value: number): Promise<number> =>
    ipcRenderer.invoke('subagents:setMaxConcurrent', value),
  /** Every subagent profile visible in the active workspace (Settings →
   * Subagents), plus the directories a new file can land in. Each profile is
   * an ordinary Markdown file; there is no builtin split. */
  subagentProfiles: (): Promise<SubagentProfilesDTO> => ipcRenderer.invoke('subagents:profiles'),
  /** Create one new profile file; resolves with the fresh list/dirs (live
   * sessions reload so the agent tool roster picks it up). */
  createSubagentProfile: (payload: SubagentProfileCreatePayload): Promise<SubagentProfilesDTO> =>
    ipcRenderer.invoke('subagents:createProfile', payload),
  /** Rewrite one profile's `tools:` frontmatter line; resolves with the fresh
   * list/dirs (live sessions reload so the agent tool roster updates). */
  setSubagentProfileTools: (filePath: string, tools: 'all' | string[]): Promise<SubagentProfilesDTO> =>
    ipcRenderer.invoke('subagents:setProfileTools', filePath, tools),
  setSubagentProfileDefaults: (filePath: string, defaults: SubagentProfileDefaultsPayload): Promise<SubagentProfilesDTO> =>
    ipcRenderer.invoke('subagents:setProfileDefaults', filePath, defaults),
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
  resourceRuntime: (): Promise<ResourceResult<ResourceRuntimeDTO>> => ipcRenderer.invoke('resources:runtime'),
  resourceStorage: (): Promise<ResourceResult<ResourceStorageDTO>> => ipcRenderer.invoke('resources:storage'),
  contextDetail: (sessionPath?: string): Promise<ContextDetailDTO> =>
    ipcRenderer.invoke('pi:contextDetail', sessionPath),
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
  continueMessage: (payload: ContinuePayload): Promise<void> =>
    ipcRenderer.invoke('pi:continueMessage', payload),
  imageReplays: (sessionPath: string): Promise<ImageReplaySnapshot> => ipcRenderer.invoke('pi:imageReplays', sessionPath),
  retryPresentedImage: (request: ImageReplayRequest): Promise<void> => ipcRenderer.invoke('pi:retryPresentedImage', request),
  cancelImageReplay: (sessionPath: string, id: string): Promise<void> => ipcRenderer.invoke('pi:cancelImageReplay', sessionPath, id),
  onImageReplays: (listener: (snapshot: ImageReplaySnapshot) => void) => subscribe('pi:image-replays', listener),
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
  // ---- Settings → MCP (Pi native config files and observed SDK tools) ----
  mcpState: (): Promise<McpStateDTO> => ipcRenderer.invoke('pi:mcpState'),
  mcpWriteConfig: (scope: McpConfigScope, content: string): Promise<McpStateDTO> =>
    ipcRenderer.invoke('pi:mcpWriteConfig', scope, content),
  mcpSetServerDisabled: (name: string, disabled: boolean): Promise<McpStateDTO> =>
    ipcRenderer.invoke('pi:mcpSetServerDisabled', name, disabled),
  mcpServerDetail: (name: string): Promise<McpServerDetailDTO> =>
    ipcRenderer.invoke('pi:mcpServerDetail', name),
  mcpUpsertServer: (payload: McpUpsertServerPayload): Promise<McpStateDTO> =>
    ipcRenderer.invoke('pi:mcpUpsertServer', payload),
  mcpDeleteServer: (path: string, name: string): Promise<McpStateDTO> =>
    ipcRenderer.invoke('pi:mcpDeleteServer', path, name),
  /** Sequence-free live status snapshots from the adapter's extension bus. */
  onMcpStatus: (listener: (push: McpStatusPushDTO) => void) => subscribe('pi:mcp-status', listener),
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
  resolveFilePath: (request: FileBrowserRequest): Promise<string> => ipcRenderer.invoke('files:resolvePath', request),
  readFile: (path: string): Promise<FilePreviewDTO> => ipcRenderer.invoke('files:read', path),
  listFileDirectory: (request: FileBrowserRequest, offset?: number): Promise<FileDirectoryDTO> => ipcRenderer.invoke('files:directory', request, offset),
  readFileDocument: (request: FileBrowserRequest): Promise<FileDocumentDTO> => ipcRenderer.invoke('files:document', request),
  htmlPreview: (request: FileBrowserRequest): Promise<HtmlPreviewDTO> => ipcRenderer.invoke('files:htmlPreview', request),
  onHtmlPreviewLink: (listener: (link: HtmlPreviewLinkDTO) => void) => subscribe('files:htmlLink', listener),
  onHtmlPreviewFind: (listener: (webContentsId: number) => void) => subscribe('files:htmlFind', listener),
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
  binaryPreview: (request: BinaryPreviewRequest): Promise<PreviewResult> => ipcRenderer.invoke('files:binaryPreview', request),
  cancelBinaryPreview: (id: string): void => ipcRenderer.send('files:cancelBinaryPreview', id),
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

  // ---- Embedded browser (shared/browser.ts; the service lives in main) ----
  browserStatus: (): Promise<BrowserStatusDTO> => ipcRenderer.invoke('browser:status'),
  /** Ensures the browser service's CDP connection exists (idempotent, cheap
   *  once connected). Local-row restore must await this BEFORE materializing
   *  marker webviews — a guest that predates the connection can never be
   *  runtime-registered (iron 7). */
  browserEnsureService: (): Promise<void> => ipcRenderer.invoke('browser:ensureService'),
  /** Grants the one-time consent, then resolves with the fresh status. */
  browserConsent: (): Promise<BrowserStatusDTO> => ipcRenderer.invoke('browser:consent'),
  browserCreatePage: (url?: string): Promise<BrowserPageMeta> =>
    ipcRenderer.invoke('browser:createPage', url),
  browserClosePage: (id: string): Promise<void> => ipcRenderer.invoke('browser:closePage', id),
  /** Toolbar reload, driven by the service (`goto(currentUrl)` — the CDP
   *  Page.reload command kills the guest). Resolves false only for a row the
   *  service does not drive, where the caller falls back to the element API. */
  browserReload: (id: string): Promise<boolean> => ipcRenderer.invoke('browser:reload', id),
  /** Registers a guest the service does not know yet (state-only until a
   * reconcile upgrades it to a full registration). */
  browserSeen: (payload: BrowserSeenPayload): Promise<void> =>
    ipcRenderer.invoke('browser:seen', payload),
  /** Resolves the element under viewport coordinates (human annotation). */
  browserElementAt: (id: string, x: number, y: number): Promise<ElementAtInfo | null> =>
    ipcRenderer.invoke('browser:elementAt', id, x, y),
  /** All guest pages follow the app theme (errors are swallowed in main). */
  browserTheme: (colorScheme: 'dark' | 'light'): Promise<void> =>
    ipcRenderer.invoke('browser:theme', colorScheme),
  /** Wipes the browser partition's storage (login states included); the
   * renderer menu confirms twice. */
  browserClearData: (): Promise<void> => ipcRenderer.invoke('browser:clearData'),
  /** Chrome login-state import: profile discovery, import, inventory and removal. Main alone decrypts; the renderer receives counts/error codes, never cookie values. */
  browserImportSources: (): Promise<BrowserImportDiscoveryDTO> => ipcRenderer.invoke('browser:importSources'),
  browserOpenPrivacySettings: (): Promise<void> => ipcRenderer.invoke('browser:openPrivacySettings'),
  browserImportCookies: (profileId: string): Promise<BrowserImportResultDTO> =>
    ipcRenderer.invoke('browser:importCookies', profileId),
  browserImportStatus: (): Promise<BrowserImportStatusDTO> => ipcRenderer.invoke('browser:importStatus'),
  browserClearImported: (): Promise<{ removed: number; failed: number }> =>
    ipcRenderer.invoke('browser:clearImported'),
  onBrowserState: (cb: (status: BrowserStatusDTO) => void) => subscribe('browser:state', cb),
  onBrowserPopup: (cb: (payload: BrowserPopupInfo) => void) =>
    subscribe('browser:popup', cb),
  onBrowserDownload: (cb: (payload: BrowserDownloadInfo) => void) =>
    subscribe('browser:download', cb),
  /** Guest-focused browser-owned keys (⌘±/0 zoom, ⌘F find, ⌘P print), intercepted
   *  by main before the guest acts on them (before-input-event); the pane routes
   *  zoom through the app ladder and f/p to the selected page's find/print. */
  onBrowserGuestShortcut: (cb: (payload: BrowserGuestShortcutInfo) => void) =>
    subscribe('browser:guest-shortcut', cb),
  /** Renderer shortcut identities let main intercept guest keys and forward browser:guest-app-shortcut to the app dispatcher. send needs no reply and is a no-op when fixture handlers are absent. */
  setBrowserAppShortcuts: (identities: string[]): void => {
    ipcRenderer.send('browser:setAppShortcuts', identities)
  },
  onBrowserGuestAppShortcut: (cb: (payload: BrowserGuestAppShortcutInfo) => void) =>
    subscribe('browser:guest-app-shortcut', cb),
  /** A pointer press inside a webview guest, relayed by main: guest input never
   *  reaches the host DOM, so host-side overlays use this as their outside-press
   *  (the ⋮ popover closes when the user clicks the page). */
  onBrowserGuestPointer: (cb: () => void) => subscribe('browser:guest-pointer', () => cb()),
  /** Before agent keyboard input, focus the requested guest <webview> and acknowledge it. Main waits for the acknowledgement (BrowserService.focusGuestForKeys). */
  onBrowserFocusGuest: (cb: (payload: BrowserFocusGuestPayload) => void) =>
    subscribe('browser:focus-guest', cb),
  browserFocusGuestDone: (requestId: number): Promise<void> =>
    ipcRenderer.invoke('browser:focus-guest-done', requestId),

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

/** Unwrap the scheduled tasks IPC result; the error keeps its status code. */
function scheduledUnwrap<T>(result: ScheduledTaskResult<T>): T {
  if (!result.ok) throw Object.assign(new Error(result.error), { status: result.status })
  return result.value
}

contextBridge.exposeInMainWorld('pi', api)

export type PiApi = typeof api
