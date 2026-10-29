import { createPresentTool } from './present'
import { PRESENT_TOOL_NAME } from '../../shared/present'
import { createImageTool } from './image'
import { ensureOpenRouterNativeImages } from './image-protocol'
import { IMAGE_TOOL_NAME, parseImageToolResult } from '../../shared/image'
import { IMAGE_GENERATION_ENTRY, IMAGE_REPLAY_ENTRY, type ImageReplayRequest, type ImageReplaySnapshot, type ImageReplayRecord } from '../../shared/image-replay'
import { capturePresentedImage, hydrateImagePresentations, imagePresentationDetails, imageReplayRecords, installImageReplayContextGuard, presentedGeneration } from './image-replay'
import { Check } from 'typebox/value'
import { randomUUID } from 'node:crypto'
import { TrajectoryClient } from './trajectory/client'
import { TrajectoryRecorder } from './trajectory/recorder'
import type { TraceAccess } from './trajectory/protocol'
import type { TrajectoryQuery, TrajectoryNodeRequest } from '../../shared/types'
import type { ContinuePayload, RewindPatchDTO, RewindStatsDTO, RewindStatsTargetDTO } from '../../shared/types'
import { continuationTarget } from '../../shared/continuation'
import { continuationContent, CONTINUATION_MESSAGE_TYPE } from './continuation'
import {
  buildSessionContext,
  createAgentSessionFromServices,
  createAgentSessionServices,
  createMcpExtension,
  createToolSearchExtension,
  DefaultPackageManager,
  estimateTokens,
  getAgentDir,
  SessionManager,
  sessionEntryToContextMessages,
  ModelRuntime,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
  type AgentSessionServices,
  type Extension,
  type ExtensionAPI,
  type ResourceLoader
} from '@earendil-works/pi-coding-agent'
import { NOTHING_TO_COMPACT_MESSAGE } from '../../shared/compaction-errors'
import type { CompactionQueueUpdateEvent } from '../../shared/compaction'
import { ManualCompaction } from './manual-compaction'
import { CompactionProcess, compactionProcesses, createCompactionProcessExtension } from './compaction-process'
import { app, shell } from 'electron'
import { settleWithin, SESSION_DISPOSE_TIMEOUT_MS } from '../shutdown'
import { homedir } from 'node:os'
import { open as openFile, stat as statPath } from 'node:fs/promises'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, openSync, fsyncSync, closeSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { BashTaskManager } from '../bash/manager'
import { createManagedBashTools, APP_BASH_TOOL_NAMES } from './bash-tools'
import { createAppCodemodeExtension } from './codemode-guidance'
import { createPromptFormatExtension } from './prompt-format'
import { createDebugTools, APP_DEBUG_TOOL_NAMES, type DebugRunInTerminal } from '../debug/tools'
import { DebugManager } from '../debug/manager'
import { dispatchDebugPanel, dispatchDebugAction } from '../debug/action-registry'
import type { DebugSourceRequest, DebugSourceContentDTO } from '../../shared/types'
import { APP_BROWSER_TOOL_NAMES, createBrowserTools } from '../browser/tools'
import { getBrowserService } from '../browser/service'
import { agentOwner } from '../../shared/browser'
import { createSandboxFileTools, APP_FILE_TOOL_NAMES } from './file-tools'
import { createAppReadTool } from './read-tool'
import { createSearchResultExtension } from './search-results'
import { isSandboxMode, sandboxModeFromBranch, SANDBOX_MODE_ENTRY_TYPE } from '../sandbox/mode'
import { createScheduledTaskTool, SCHEDULED_TASK_TOOL_NAME } from './scheduled-tasks/tool'
import { ScheduledTaskService, type ScheduledTaskExecutionContext } from './scheduled-tasks/service'
import { createScheduledTaskRuntime } from './scheduled-tasks/runtime'
import { isScheduledTasksRoot, prepareScheduledTasksRoot, scheduledTasksRoot, scheduledTasksRunCwd } from './scheduled-tasks/workspace'
import { createScheduledWorktree, validateScheduledWorktreeSource } from './scheduled-tasks/worktree'
import { scheduledRunOutputFromMessages } from './scheduled-tasks/output'
import { SCHEDULED_TASK_ENTRY_TYPE, scheduledTaskRoleFromEntries, type ScheduledTaskMarkerData } from './scheduled-tasks/marker'
import {
  isScheduledTaskRunActive,
  type ScheduledTask,
  type ScheduledTaskInput,
  type ScheduledTaskRun,
  type ScheduledTaskThinkingLevel
} from '../../shared/scheduled-tasks'
import { taskIsLive } from '../bash/task-status'
import { sandboxStatus } from '../sandbox/broker'
import { resolveEscalatedMode, PLAN_ESCALATION_REFUSED } from '../sandbox/escalation'
import type { SandboxEscalationOperationDTO } from '../../shared/types'
import { clearSessionEscalations, listPendingEscalations, respondToEscalation } from '../sandbox/pending'
import { clearSessionAskUserRequests, clearSubagentAskUserRequests, createAskUserTool, engageAskUser as engageAskUserRequest, listPendingAskUser, respondAskUserRequest } from './ask-user'
import type { AskUserAnswer } from '../../shared/ask-user'
import { ASK_USER_MAX_TIMEOUT_S, ASK_USER_MIN_TIMEOUT_S, ASK_USER_TOOL_NAME, clampAskUserTimeoutSeconds } from '../../shared/ask-user'
import { RESPONSE_TIMEOUT_MAX_S, RESPONSE_TIMEOUT_MIN_S, clampResponseTimeoutSeconds } from '../../shared/response-timeout'
import type { SandboxMode } from '../sandbox/types'
import type { SandboxEscalationDecision } from '../../shared/types'
import { TaskNotifications } from './task-notifications'
import { mcpServerKey } from '../../shared/mcp'
import { RewindClient } from '../rewind/client'
import {
  buildMcpRoster,
  deleteMcpServerEntry,
  mcpServerDetail,
  readMcpConfigIssues,
  readMcpConfigFile,
  setMcpServerDisabled,
  upsertMcpServerEntry,
  writeMcpConfigFile
} from './mcp'
import { checkoutRoot, CheckoutCoordinator } from '../rewind/coordinator'
import { classifyUncoveredWrites, uncoveredWrites } from '../rewind/coverage'
import { RewindRecorder } from '../rewind/recorder'
import { RewindFailure, failure as rewindFailure } from '../rewind/types'
import { ChangeScopes } from './change-scopes'
import { TodoState, createTodoTool } from './todo'
import { TODO_TOOL_NAME } from './todo-protocol'
import { GoalRuntime } from './goals/runtime'
import { GoalStorage } from './goals/storage'
import { GoalAccounting, GoalAccountingError } from './goals/accounting'
import { GoalInputError, type PreparedGoalInput } from './goals/input'
import { createGoalTools, createGoalContextExtension } from './goals/tools'
import { GOAL_ENTRY, GOAL_GET, GOAL_UPDATE, GOAL_STEP, goalFromBranch, goalLive } from './goals/protocol'
import { preserveInitialSelections } from './session-selections'
import { goalCanBeReplaced, validGoalCriteria, validGoalLimits, type GoalActionRequest, type GoalActionResult, type GoalInput, type GoalReason } from '../../shared/goal'
import { JevCredentials } from './jev/credentials'
import { JevService, type JevServiceOptions } from './jev/service'
import { JevWorkflow } from './jev/workflow'
import { createJevTool } from './jev/tool'
import { JevError, JEV_TOOL_NAME } from './jev/protocol'
import type { JevSettingsDTO, JevSettingsUpdate, JevActionResult, JevEvaluationDTO, JevTraceDTO, JevTracePageDTO } from '../../shared/types'
import { PlanController, PlanAdmissionError, planErrorCode, type PlanLiveFacts } from './plan-mode'
import { installPlanGate, type PlanGate } from './plan-gate'
import { PlanApprovalController } from './plan-approval'
import { PlanStorage } from './plan-storage'
import { parsePlanSubmission, reconstructPlan } from './plan-protocol'
import { createPlanSubmissionTool } from './plan-submission'
import { createPlanContextExtension, installPlanStreamOverlay } from './plan-context'
import { installContextBudgetOverlay } from './context-budget'
import { ImageSafety, installTextOnlyImageOverlay } from './image-safety'
import {
  MAX_CONCURRENT_SUBAGENTS_DEFAULT,
  MAX_CONCURRENT_SUBAGENTS_LIMIT,
  SubagentParentState,
  SubagentRuntime,
  type ChildSessionHandle,
  type SubagentHost
} from './subagents/runtime'
import { SubagentNotifications } from './subagents/notifications'
import { AskUserNotifications } from './ask-user-notifications'
import { AskUserRecords } from './ask-user-records'
import { SUBAGENT_TOOL_NAME, AGENT_STEER_TOOL_NAME, MESSAGE_PARENT_TOOL_NAME, SUBAGENT_MESSAGE_TYPE, readDiskSubagentRuns, currentDiskRun } from './subagents/protocol'
import type { SubagentMessageDetails, SubagentRunStartData } from './subagents/protocol'
import { createSubagentTool, createAgentSteerTool, createMessageParentTool, installSubagentResultHook } from './subagents/tools'
import { subagentModelSpecError } from './subagents/model-spec'
import { ensureDefaultProfiles, createSubagentProfileFile, listSubagentProfiles, toSubagentProfileDTO, writeSubagentProfileDefaults, writeSubagentProfileTools } from './subagents/profiles'
import { isSubagentSessionFile } from './subagents/session-filter'
import { SessionListIndex, rowFromSessionManager } from './session-list'
import { BASH_MIN_WAIT_MS, BASH_MAX_WAIT_MS, SDK_BUILTIN_TOOL_NAMES, SUBAGENT_MAX_TURNS_LIMIT, type StartupSessionMode, type SubagentProfileCreatePayload, type SubagentProfileDefaultsPayload, type SubagentProfileDTO, type SubagentProfilesDTO } from '../../shared/types'
import { FileIndex, readAttachment } from './files'
import { compactedContextTokens } from './context-estimate'
import { buildContextDetail, cacheHitRate, statsFromEntries, type ContextStatsLike } from './context-detail'
import { SessionSearch } from './session-search'
import { UsageAggregator } from './usage'
import { ensureDefaultWorkspace, isDefaultWorkspace } from './default-workspace'
import { appendPromptPath, readAppendPrompt, writeAppendPrompt } from './append-prompt'
import {
  builtinProviderBaseUrls,
  builtinProviderIds,
  configuredModels,
  discoverModels,
  hiddenModelKeys,
  providerInventory,
  readModelsConfig,
  recommendCatalogPreset,
  supportsModelDiscovery,
  testModel,
  writeModelsConfig
} from './models-config'
import { loadSettings, saveSettings } from '../settings'
import { getLibraryService } from '../library/service'
import type { LibrarySession } from '../../shared/library'
import { buildToolCatalog, extensionId, loadPackageResources, type PackageResources } from './catalog'
import { setDisableModelInvocation } from './skill-frontmatter'
import { desktopExtension } from './extension-startup'
import { bindToolCallBoundary, createToolCallBoundaryExtension } from './tool-call-boundary'
import {
  buildSideChatContext,
  runSideChatAnswer,
  SIDE_CHAT_HISTORY_LIMIT,
  SIDE_CHAT_QUESTION_CHAR_LIMIT
} from './side-chat'
import type {
  AppendPromptDTO,
  BashTaskDTO,
  BashTaskRequest,
  BashTaskOutputDTO,
  CatalogRecommendationDTO,
  ChatMessage,
  ContextDetailDTO,
  ContextUsageDTO,
  DebugPanelRequest,
  DebugSessionDTO,
  CustomModelDTO,
  DefaultModelDTO,
  DiscoveredModelDTO,
  FilePreviewDTO,
  ForkResultDTO,
  ImageContent,
  ModelConfigSourceDTO,
  ModelDTO,
  ModelRefDTO,
  ModelsConfigDTO,
  PiEvent,
  PlanActionResult,
  PlanModeRequest,
  PlanStateDTO,
  PlanDocumentRequest,
  PlanDocumentDTO,
  PlanSubmissionRef,
  PlanApprovalDTO,
  PlanApproveRequest,
  ProviderDTO,
  ProviderModelDTO,
  PromptPayload,
  QueuedItemDTO,
  QueueActionPayload,
  RecalledItemDTO,
  RewindResult,
  RewindListDTO,
  RewindBusyReason,
  RewindPreviewDTO,
  RewindRequest,
  RewindUncoveredPathDTO,
  RewindCommitDTO,
  ResendPayload,
  SessionSnapshotDTO,
  SessionSearchRequest,
  SessionSearchResultDTO,
  SessionSummaryDTO,
  SideChatAskPayload,
  SideChatHistoryEntry,
  TestModelResultDTO,
  UsageStatsDTO,
  ThinkingLevel,
  ToolCatalogDTO,
  ToolInfoDTO,
  ToolRunDTO,
  SkillContentDTO,
  SubagentActionPayload,
  SubagentRunDTO,
  McpRuntimeStatus,
  McpToolDTO,
  McpServerDetailDTO,
  McpStateDTO,
  McpStatusPushDTO,
  McpUpsertServerPayload
} from '../../shared/types'

/** How many opened folders to keep in the sidebar/settings list. */
const MAX_FOLDERS = 12

/**
 * The built-in tools the app keeps active. Passed explicitly because a `tools`
 * allowlist would also filter out every extension-registered tool (see
 * `AgentSession._refreshToolRegistry`), which is why the manager omits it and
 * sets the active set by hand instead. The list itself lives in shared/types
 * so Settings → Subagents offers the same names without a session.
 */
const BUILTIN_TOOL_NAMES = SDK_BUILTIN_TOOL_NAMES

/** The old adapter remains installed in Pi's global package list for CLI users.
 * This app runs Pi's native MCP extension, so exclude the adapter from this
 * loader before binding extension handlers. Filtering after binding would run
 * two MCP clients and could let the adapter replace the native /mcp command. */
function isLegacyMcpAdapter(extension: Extension): boolean {
  return /(?:^|[/\\])pi-mcp-adapter(?:[/\\]|$)/.test(extension.resolvedPath || extension.path)
}

/**
 * Streaming updates (`message_update` carries the FULL accumulated partial
 * message, `tool_execution_update` the partial tool output) can arrive dozens
 * of times per second from fast models. Coalesce them per session (latest wins
 * per key) so full accumulated messages cross IPC at most 20 times per second.
 * Ordered events always flush that session's pending updates first.
 */
const STREAM_FLUSH_MS = 50
/** Tool output is normally collapsed; a lower live cadence avoids repeatedly
 * cloning and reconciling large cumulative terminal/diff payloads. */
const TOOL_STREAM_FLUSH_MS = 150
/**
 * The context ring is polled, not event-driven: `getContextUsage()` only moves
 * when a message completes, while the ring is meant to track the context as the
 * session works. Read it on a fixed cadence and push only what actually moved.
 */
const CONTEXT_USAGE_POLL_MS = 2000

/** Cap for the Settings → Skills SKILL.md preview. */
const MAX_SKILL_BYTES = 200_000

/**
 * Bound the replay history an untrusted renderer sends. Only the newest
 * exchanges ever reach a prompt, so only those are validated and clamped.
 */
function sanitizeSideChatHistory(history: SideChatHistoryEntry[] | undefined): SideChatHistoryEntry[] {
  if (!Array.isArray(history)) return []
  return history
    .filter((entry) => entry && typeof entry.question === 'string' && typeof entry.answer === 'string')
    .slice(-SIDE_CHAT_HISTORY_LIMIT)
    .map((entry) => ({
      question: entry.question.slice(0, SIDE_CHAT_QUESTION_CHAR_LIMIT),
      answer: entry.answer.slice(0, SIDE_CHAT_QUESTION_CHAR_LIMIT * 2)
    }))
}

/** Plan facts that move with the SDK's own lifecycle events. */
const PLAN_FACT_EVENT_TYPES: ReadonlySet<string> = new Set([
  'agent_start', 'agent_settled', 'turn_start', 'turn_end'
])

/** Drop functions/symbols and turn Dates into ISO strings before IPC. */
function serialize(value: unknown): any {
  try {
    return JSON.parse(
      JSON.stringify(value, (_key, val) => {
        if (typeof val === 'function' || typeof val === 'symbol') return undefined
        if (val instanceof Date) return val.toISOString()
        return val
      })
    )
  } catch (error) {
    throw new Error('Failed to serialize IPC payload', { cause: error })
  }
}

/**
 * The selected branch as a DISPLAY transcript. Unlike `buildSessionContext()`
 * and `AgentSession.messages`, this deliberately does not apply compaction:
 * compacted messages remain visible to the user while the SDK keeps excluding
 * them from subsequent model requests.
 */
function transcriptMessages(manager: SessionManager): ChatMessage[] {
  // Since SDK 0.86, prompt and tool changes are persisted as system messages.
  // They belong to provider context, not the visible conversation.
  const presentations = imagePresentationDetails(manager)
  const processes = compactionProcesses(manager)
  return manager.getBranch().flatMap(entry => sessionEntryToContextMessages(entry).map(message => {
    if (message.role === 'compactionSummary') return { ...message, sessionEntryId: entry.id, process: processes.get(entry.id) }
    const details = presentations.get(entry.id)
    return details && message.role === 'toolResult' && message.toolName === 'present' ? { ...message, details } : message
  }))
    .filter(message => message.role !== 'system') as ChatMessage[]
}

function modelRef(model: any): ModelRefDTO | null {
  if (!model) return null
  return {
    providerId: model.provider,
    id: model.id,
    name: model.name ?? model.id,
    reasoning: Boolean(model.reasoning)
  }
}

/**
 * A queued message with its full payload. The SDK only exposes queued
 * messages as text (getSteeringMessages()/clearQueue() return strings);
 * images live solely in the agent's private queue. The mirror below keeps the
 * rich payload app-side so recall/promote/remove can rebuild without losing
 * it — the SDK's text arrays stay the authoritative ORDER, reconciled on
 * every queue_update.
 */
interface QueuedItem {
  /** SDK-visible text (file blocks inlined, templates expanded). */
  text: string
  /** The user's draft as typed — what recall puts back into the composer. */
  originalText: string
  images: ImageContent[]
  filePaths: string[]
}

function dtoOf(item: QueuedItem): QueuedItemDTO {
  return {
    text: item.text,
    originalText: item.originalText,
    imageCount: item.images.length,
    filePaths: [...item.filePaths]
  }
}

/**
 * Payload of one prompt that is (or may be) mid-enqueue. The SDK emits its
 * queue_update — and our reconcile — DURING session.prompt(), so the payload
 * has to be parked before the call and claimed by the reconcile when the
 * freshly queued text appears.
 */
interface PendingQueuePayload {
  /** Text the SDK will store verbatim (file blocks inlined, templates expanded). */
  composedText: string
  originalText: string
  images: ImageContent[]
  filePaths: string[]
}

/** Abort-aware delay for the scheduled turn's admission/drain waits. */
function scheduledDelay(signal: AbortSignal, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer)
      reject(signal.reason ?? new Error('Cancelled'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort)
      resolve()
    }, ms)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
}

interface ManagedSession {
  goals?: GoalRuntime
  goalBilling?: ReturnType<GoalAccounting['child']>
  disposeGoalBillingStream?: () => void
  goalEdit?: AbortController
  manualCompaction?: ManualCompaction
  trajectory?: TrajectoryRecorder
  jevWorkflow?: JevWorkflow
  recoveryOnly?: boolean
  /** This session's DSH mode, folded from its branch; read live by the tools. */
  sandboxMode: SandboxMode
  rewind?: RewindRecorder
  todos: TodoState
  /** Every ask_user_question this session asked, folded from its branch. */
  askRecords: AskUserRecords
  /** One real loader/runtime per session; the SDK receives its filtered proxy. */
  resourceLoader: ResourceLoader
  /** Subagent roster/runs for normal sessions; null on children. */
  subagents: SubagentParentState | null
  /** Session mode, plan overlay, admission and live Plan metadata. */
  plan: PlanController
  /** The runtime tool ceiling (setter adapter + hook chain + execute recheck). */
  gate?: PlanGate
  disposeToolCallBoundary?: () => void
  disposePlanStream?: () => void
  disposeContextBudget?: () => void
  disposeImageSafety?: () => void
  disposeImageReplayContext?: () => void
  disposeTextOnlyImages?: () => void
  compactionProcess?: CompactionProcess
  planApproval?: PlanApprovalController
  /** Present on subagent child sessions: linkage + frozen tool ceiling. The
   * child's initialization activates only the ceiling, never the full set. */
  subagentChild?: { parentPath: string; toolCeiling: readonly string[]; planRestricted?: true }
  /** Present on sessions a scheduled run created (or restored from the
   * persisted marker): hidden from the sidebar/search, read-only for
   * interactive paths, no ask_user, no sandbox escalation, no Jev workflow. */
  scheduledTask?: { taskId: string; runId: string }
  initializing: boolean
  lifecyclePromise: Promise<void> | null
  disposePromise: Promise<void> | null
  disposing: boolean
  changeScopes: ChangeScopes
  notifications: TaskNotifications
  /** Async ask_user outcomes: the answer is steered in long after the call. */
  askUser: AskUserNotifications
  session: AgentSession
  path: string
  cwd: string
  unsubscribe: () => void
  pendingStreamEvents: Map<string, PiEvent>
  streamFlushTimer: ReturnType<typeof setTimeout> | null
  streaming: ChatMessage | null
  /** Set by `abort()` (Stop/Esc) and consumed by the settle that ends that
   * run, so the renderer can tell a user-stopped run from a finished one
   * (its notification cue stays silent for a stop). Cleared on `agent_start`
   * as well, so a stop issued while idle cannot linger onto a later run. */
  userAborted?: boolean
  /** Owns Continue from admission through settle; Stop also cancels preparation. */
  continuationRequest?: AbortController
  /** Direct UI execution; private entries, never assistant/model messages. */
  imageReplay?: { id: string; controller: AbortController; promise?: Promise<void> }
  toolRuns: Record<string, ToolRunDTO>
  /** Rich payload mirror of the SDK's two queues, keyed by queued text. */
  queueMirror: { steering: QueuedItem[]; followUp: QueuedItem[] }
  /**
   * Parked payloads of prompts currently mid-enqueue. A LIST, not a single
   * slot: an enqueue can yield inside session.prompt() (a "/" command, an
   * input extension), so two prompts can overlap, and the earlier one's
   * finally must not wipe the later one's payload. Claimed by text, newest
   * first (the prompt that just queued owns the text it just pushed).
   */
  pendingQueuePayloads: PendingQueuePayload[]
  /** While clear+requeue rebuilds the SDK queues, its intermediate
   * queue_update events (empty → partial) are swallowed whole and one final
   * state is emitted instead — the renderer never flashes an empty panel. */
  queueRebuilding: boolean
  eventSequence: number
  /** Serialized context usage last sent for this session — the poll skips
   * unchanged values (and events that already carried them). */
  contextUsageKey: string | null
  /** A prompt/resource setting changed while this session was mid-run; the
   * reload that applies it is deferred to `agent_settled` (reloading during
   * a turn would swap the extension runner under an in-flight request). */
  reloadPending: boolean
}

export class PiManager {
  readonly checkoutCoordinator = new CheckoutCoordinator()
  private rewindClient = new RewindClient()
  private rewindPreviews = new Map<string, { path: string; leaf: string | null; target: string | null; file?: string; uncovered?: RewindUncoveredPathDTO[] }>()
  private commandTasksInstance: BashTaskManager | null = null
  private disposePromise: Promise<void> | null = null
  private closing = false
  private bashMaxWaitMs = loadSettings().bashMaxWaitMs
  /** App-wide default for sessions that never recorded a mode of their own. */
  private get defaultSandboxMode(): SandboxMode {
    return loadSettings().sandboxMode
  }
  private subagentsEnabledFlag = loadSettings().subagentsEnabled !== false
  /** Settings → Subagents: the model may continue finished subagents. */
  private subagentReuseFlag = loadSettings().subagentReuseEnabled === true
  /** Settings → Subagents: parent↔child steering. */
  private subagentCommsFlag = loadSettings().subagentCommsEnabled === true
  private subagentTurnLimitOverrideFlag = loadSettings().subagentTurnLimitOverrideEnabled === true
  private subagentMaxTurnsSetting = loadSettings().subagentMaxTurns
  /** Whether the 14 browser_* agent tools are in the ACTIVE set (the switch lives
   *  in Settings → Browser; registration itself is service-gated at build). */
  private browserToolsFlag = loadSettings().browserAgentToolsEnabled === true
  /** Settings → General: the DAP `debug` tool is in the active set. */
  private debugEnabledFlag = loadSettings().debugEnabled === true
  private jevPreferences = loadSettings().jev
  private jevUpdating = false
  private jevCredentials = new JevCredentials(join(getAgentDir(), 'jev-auth.json'))
  private jevService = new JevService({ preferences: () => this.jevPreferences, apiKey: () => this.jevCredentials.key(),
    accounting: owner => this.captureJevAccounting(owner) })
  private goalAccountingInstance: GoalAccounting | null = null
  private get goalAccounting(): GoalAccounting {
    return this.goalAccountingInstance ??= new GoalAccounting(app.getPath('userData'), owner => queueMicrotask(() => {
      for (const managed of this.sessions.values()) if (managed.goals?.snapshot?.id === owner.goalId) managed.goals.syncAccounting()
    }))
  }
  private captureJevAccounting(path: string): ReturnType<NonNullable<JevServiceOptions['accounting']>> {
    const managed = this.sessions.get(path)
    const childBilling = managed?.goalBilling
    const owner = childBilling?.owner ?? managed?.goals?.billingOwner(true)
    if (!owner || !managed) return undefined
    return (requestId: string, callId?: string) => {
      if (managed.disposing || this.closing || (childBilling ? managed.goalBilling !== childBilling :
        managed.goals?.billingOwner(true)?.parentRunId !== owner.parentRunId || managed.goals?.snapshot?.id !== owner.goalId)) throw new GoalAccountingError('unavailable')
      const parent = managed.subagentChild ? this.sessions.get(managed.subagentChild.parentPath) : managed
      const budget = parent?.goals?.snapshot?.id === owner.goalId ? parent.goals.snapshot.limits.tokenBudget : owner.tokenBudget
      try { this.goalAccounting.check(owner, budget) }
      catch (error) { parent?.goals?.pause(error instanceof GoalAccountingError && error.code === 'quota' ? 'tokens' : 'accounting'); throw error }
      return this.goalAccounting.jev({ ...owner, tokenBudget: budget }, managed.session.sessionId, requestId, callId, childBilling?.runId)
    }
  }

  async jevSettings(): Promise<JevSettingsDTO> {
    return { ...this.jevPreferences, keySource: await this.jevCredentials.source() }
  }

  async updateJevSettings(update: JevSettingsUpdate): Promise<JevActionResult<JevSettingsDTO>> {
    if (this.closing) return { ok: false, code: 'cancelled' }
    if (this.jevUpdating) return { ok: false, code: 'busy' }
    this.jevUpdating = true
    this.jevService.cancel()
    try {
      if (!update || typeof update !== 'object' || Object.keys(update).length !== 1) throw new JevError('invalid_input')
      if (Object.hasOwn(update, 'preferences')) {
        const p = update.preferences
        if (!p || Object.keys(p).length !== 4 || !['off', 'tools', 'workflow'].includes(p.mode) || !['choice', 'score', 'noul'].every(k => typeof p[k as keyof typeof p] === 'boolean')) throw new JevError('invalid_input')
        saveSettings({ ...loadSettings(), jev: p })
        this.jevPreferences = { ...p }
        // The SDK setter rebuilds the prompt. Initialization also reads the live
        // preference; a child still intersects its immutable dispatch ceiling.
        for (const managed of this.sessions.values()) if (!managed.disposing && managed.gate) {
          managed.jevWorkflow?.settingsChanged()
          this.applyActiveTools(managed, this.filterExtensions(managed.resourceLoader))
        }
        this.catalogCache = null
      } else if (Object.hasOwn(update, 'apiKey')) await this.jevCredentials.save(update.apiKey)
      else throw new JevError('invalid_input')
      return { ok: true, data: await this.jevSettings() }
    } catch (error) { return { ok: false, code: error instanceof JevError ? error.code : 'storage' } }
    finally { this.jevUpdating = false }
  }

  async testJev(): Promise<JevActionResult<JevEvaluationDTO>> {
    if (this.closing) return { ok: false, code: 'cancelled' }
    if (this.jevUpdating) return { ok: false, code: 'busy' }
    try { return { ok: true, data: await this.jevService.probe() } }
    catch (error) { return { ok: false, code: error instanceof JevError ? error.code : 'network' } }
  }
  private trajectoryAccess(sessionPath: string): TraceAccess {
    if (typeof sessionPath !== 'string' || sessionPath.length > 8192 || !sessionPath) throw new Error('trajectory-invalid-session')
    const managed = this.sessions.get(sessionPath)
    return { sessionPath, sessionId: managed?.session.sessionId ?? '',
      ...(managed ? { leafId: managed.session.sessionManager.getLeafId() } : {}) }
  }
  trajectoryPage(query: TrajectoryQuery) {
    if (!query || (query.before !== undefined && !Number.isSafeInteger(query.before)) || (query.after !== undefined && !Number.isSafeInteger(query.after))
      || (query.kind && !['run','user','assistant','request','tool','compaction','retry','notification'].includes(query.kind))
      || (query.status && !['running','completed','failed','cancelled','interrupted','unavailable'].includes(query.status))
      || (query.query !== undefined && typeof query.query !== 'string')) throw new Error('trajectory-invalid-query')
    return this.trajectory.page(this.trajectoryAccess(query.sessionPath), query)
  }
  trajectoryDetail(sessionPath: string, recordId: string) {
    if (typeof recordId !== 'string' || recordId.length > 200) throw new Error('trajectory-invalid-record')
    return this.trajectory.detail(this.trajectoryAccess(sessionPath), recordId)
  }
  trajectoryNode(request: TrajectoryNodeRequest) {
    if (!request || typeof request.recordId !== 'string' || request.recordId.length > 200 || !Array.isArray(request.trail)
      || !request.trail.length || request.trail.length > 96 || request.trail.some(id => typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id))
      || (request.offset !== undefined && (!Number.isSafeInteger(request.offset) || request.offset < 0))) throw new Error('trajectory-invalid-node')
    return this.trajectory.node(this.trajectoryAccess(request.sessionPath), request)
  }
  async exportTrajectory(sessionPath: string, recordId: string, destination: string): Promise<void> {
    await this.trajectoryDetail(sessionPath, recordId)
    await this.trajectory.export(this.trajectoryAccess(sessionPath), recordId, destination)
  }
  jevTraces(sessionPath: string, cursor?: string): JevTracePageDTO {
    if (typeof sessionPath !== 'string' || (cursor !== undefined && typeof cursor !== 'string')) throw new JevError('invalid_input')
    return this.sessions.get(sessionPath)?.jevWorkflow?.traces.page(cursor) ?? { items: [], nextCursor: null }
  }
  jevTrace(sessionPath: string, id: string): JevTraceDTO | null {
    if (typeof sessionPath !== 'string' || typeof id !== 'string') throw new JevError('invalid_input')
    return this.sessions.get(sessionPath)?.jevWorkflow?.traces.detail(id) ?? null
  }
  private subagentMaxConcurrentSetting = loadSettings().subagentMaxConcurrent ?? MAX_CONCURRENT_SUBAGENTS_DEFAULT
  /** Ask-panel auto-settle deadline; read live by every ask_user_question call. */
  private askUserTimeoutMs = clampAskUserTimeoutSeconds(loadSettings().askUserTimeoutSeconds) * 1000
  /**
   * Provider request timeout (Settings → General), in milliseconds. Applied to
   * every session's SettingsManager as an in-memory override, so the app-local
   * preference never rewrites the SDK's shared global settings file; the SDK's
   * own auto-retry turns the resulting timeout error into a retry.
   */
  private responseTimeoutMs = clampResponseTimeoutSeconds(loadSettings().responseTimeoutSeconds) * 1000
  /**
   * Settings → General: whether the model and permission selectors may change
   * while a run is streaming. Read live by the switch guards below, so a
   * preference change applies to the very next switch without a session
   * rebuild.
   */
  private allowMidRunChanges = loadSettings().allowMidRunChanges === true

  /**
   * Give one SettingsManager the app's provider timeout. `applyOverrides`
   * merges into the manager's in-memory view only (no write, no `reload()`
   * survival), and the SDK re-reads it on every request — so the call applies to
   * the next request of that session, including subagent children.
   */
  private applyResponseTimeout(settingsManager: SettingsManager): void {
    settingsManager.applyOverrides({ retry: { provider: { timeoutMs: this.responseTimeoutMs } } })
  }

  private get commandTasks(): BashTaskManager {
    return this.commandTasksInstance ??= new BashTaskManager(join(app.getPath('userData'), 'bash-tasks'),
      (task) => {
        this.emit('pi:bash-task', task)
        // A live process count is a live Plan fact.
        this.sessions.get(task.sessionPath)?.plan.refresh()
      },
      (task) => {
        const managed = this.sessions.get(task.sessionPath)
        managed?.notifications.complete(task)
      }, this.checkoutCoordinator)
  }

  private debugManagerInstance?: DebugManager
  /** DAP sessions are in-memory only: debuggees die with the app, so there is
   * nothing durable to restore — unlike bash task records. */
  private get debugManager(): DebugManager {
    return this.debugManagerInstance ??= new DebugManager((dto) => this.emit('debug:event', dto), this.checkoutCoordinator)
  }

  /** Set by ipc.ts once the renderer terminal bridge exists; read live at
   * debug start so sessions built earlier pick it up too. */
  debugTerminalBridge?: DebugRunInTerminal

  listBashTasks(sessionPath: string): BashTaskDTO[] { return this.commandTasks.list(sessionPath) }

  listDebugSessions(sessionPath: string): DebugSessionDTO[] {
    return this.debugManagerInstance?.list(sessionPath) ?? []
  }

  /** Panel-driven debug actions against the same DebugManager the model's
   * `debug` tool drives — the user and the agent share one live session. */
  async debugPanelAction(request: DebugPanelRequest): Promise<unknown> {
    return dispatchDebugPanel(this.debugManager, request)
  }

  async debugSource(request: DebugSourceRequest): Promise<DebugSourceContentDTO> {
    const { sessionPath, debugId, stopId, sourceReference, sourceVersion, startLine, offset, limit } = request
    return await dispatchDebugAction({ manager: this.debugManager, sessionPath, debugId, stopId },
      { action: 'source', sourceReference, sourceVersion, ...(startLine !== undefined ? { startLine } : {}),
        ...(offset !== undefined ? { offset } : {}), ...(limit !== undefined ? { limit } : {}) }) as DebugSourceContentDTO
  }

  bashTaskOutput(request: BashTaskRequest): BashTaskOutputDTO {
    return this.commandTasks.output(request.sessionPath, request.taskId, request.cursor)
  }
  async stopBashTask(request: BashTaskRequest): Promise<BashTaskDTO> {
    const task = this.commandTasks.get(request.sessionPath, request.taskId)
    if (task.background && (task.status === 'running' || task.status === 'stopping')) {
      this.sessions.get(request.sessionPath)?.notifications.expectUserStop(request.taskId)
    }
    return this.commandTasks.stop(request.sessionPath, request.taskId)
  }
  setBashMaxWaitMs(value: number): number {
    if (!Number.isInteger(value) || value < BASH_MIN_WAIT_MS || value > BASH_MAX_WAIT_MS) throw new Error('Invalid bash wait threshold')
    saveSettings({ ...loadSettings(), bashMaxWaitMs: value })
    this.bashMaxWaitMs = value
    return value
  }
  /** Settings → General: how long an untouched ask panel waits before it closes. */
  setAskUserTimeoutSeconds(value: number): number {
    if (!Number.isInteger(value) || value < ASK_USER_MIN_TIMEOUT_S || value > ASK_USER_MAX_TIMEOUT_S) {
      throw new Error('Invalid ask-user timeout')
    }
    saveSettings({ ...loadSettings(), askUserTimeoutSeconds: value })
    this.askUserTimeoutMs = value * 1000
    return value
  }
  /** Settings → General: how long a model request may go unanswered before the
   * SDK fails it as a timeout and retries. Persisted app-local and applied to
   * every live session's SettingsManager (the next request picks it up). */
  setResponseTimeoutSeconds(value: number): number {
    if (!Number.isInteger(value) || value < RESPONSE_TIMEOUT_MIN_S || value > RESPONSE_TIMEOUT_MAX_S) {
      throw new Error('Invalid response timeout')
    }
    saveSettings({ ...loadSettings(), responseTimeoutSeconds: value })
    this.responseTimeoutMs = value * 1000
    for (const managed of this.sessions.values()) this.applyResponseTimeout(managed.session.settingsManager)
    return value
  }
  /** Settings → General: allow model/thinking/permission switches while a run
   * is streaming. Persisted app-local and read live by the switch guards. */
  setAllowMidRunChanges(enabled: boolean): boolean {
    const value = enabled === true
    saveSettings({ ...loadSettings(), allowMidRunChanges: value })
    this.allowMidRunChanges = value
    return value
  }
  /** Settings → General: the default a session starts from, not a live mode. */
  setSandboxMode(value: SandboxMode): SandboxMode {
    if (!isSandboxMode(value)) throw new Error('Invalid sandbox mode')
    saveSettings({ ...loadSettings(), sandboxMode: value })
    return value
  }

  /**
   * Change one session's mode. The mode is a fact about the session's branch,
   * so it is recorded there — reopening the session, or forking it, restores
   * what it was left in. The tools read the live value, so the change applies to
   * the very next tool call, including on a steered turn that is already
   * running.
   */
  setSessionSandboxMode(sessionPath: string, mode: SandboxMode): SessionSnapshotDTO {
    if (!isSandboxMode(mode)) throw new Error('Invalid sandbox mode')
    const managed = this.sessions.get(sessionPath)
    if (!managed) throw new Error('No such session')
    if (managed.subagentChild) throw new Error('A subagent session follows its parent session')
    if (managed.scheduledTask) throw new Error('A scheduled task session is read-only')
    if (managed.imageReplay) throw new Error('image-retry-busy')
    this.assertMidRunChangeAllowed(managed)
    // A mode change may not race this branch write.
    managed.plan.checkWorkAdmission()
    if (managed.plan.restricted) {
      throw new Error('Plan mode fixes this session to read-only; leave Plan mode to change its sandbox mode')
    }
    if (managed.sandboxMode !== mode) {
      managed.session.sessionManager.appendCustomEntry(SANDBOX_MODE_ENTRY_TYPE, { mode })
      managed.sandboxMode = mode
      // The composer picker reads the stored choice from the plan DTO's
      // configuredSandboxMode. A same-seq rebuild loses the renderer's
      // seq-guarded merge, so republish: the picker must reflect the switch
      // now, not at the next plan transition.
      managed.plan.refresh()
    }
    return this.snapshotOf(managed)
  }

  /**
   * Publish this session's pending escalation questions. Called whenever the
   * set changes (asked, answered, cancelled), so the renderer never has to poll
   * for a question it must answer.
   */
  private publishEscalations(managed: ManagedSession): void {
    // Sequence-free metadata ping (the same rule context_usage and
    // subagents_update follow): a pending question is state the renderer has to
    // answer, not a step of the transcript's event log.
    this.emit(
      'pi:event',
      serialize({
        type: 'sandbox_escalation',
        sessionId: managed.session.sessionId,
        sessionPath: managed.path,
        requests: listPendingEscalations(managed.path)
      })
    )
    // A pending escalation is a live Plan fact.
    managed.plan.refresh()
  }

  /**
   * The approval channel handed to bash/edit/write. A call asks; the user's
   * answer decides; the session's own mode never changes.
   */
  private escalateFor(
    managed: ManagedSession,
    input: {
      toolCallId: string
      toolName: 'bash' | 'edit' | 'write' | 'debug'
      operation: SandboxEscalationOperationDTO
      sandboxPermissions: unknown
      justification: unknown
      signal?: AbortSignal
    }
  ): Promise<SandboxMode> {
    // Plan is checked BEFORE the approval channel: a call with escalation
    // parameters is refused outright (no pending question, no way to grant),
    // and an ordinary call runs the forced read-only overlay. The session's
    // stored choice is untouched — leaving Plan restores exactly what the user
    // picked.
    if (managed.plan.restricted) {
      if (input.sandboxPermissions !== undefined || input.justification !== undefined) {
        return Promise.reject(new Error(PLAN_ESCALATION_REFUSED))
      }
      return Promise.resolve('read-only')
    }
    return resolveEscalatedMode({
      sessionId: managed.session.sessionId,
      sessionPath: managed.path,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      operation: input.operation,
      currentMode: managed.sandboxMode,
      sandboxPermissions: input.sandboxPermissions,
      justification: input.justification,
      ...(input.signal ? { signal: input.signal } : {}),
      onChanged: () => this.publishEscalations(managed)
    })
  }

  /**
   * Publish this chat's pending ask_user_question sets (subagent children
   * included — they register under the owner path). Same sequence-free
   * metadata rule as escalations: a pending question is state the renderer
   * has to answer, not a transcript step.
   */
  private publishAskUser(managed: ManagedSession): void {
    this.emit(
      'pi:event',
      serialize({
        type: 'ask_user',
        sessionId: managed.session.sessionId,
        sessionPath: managed.path,
        requests: listPendingAskUser(managed.path)
      })
    )
    // An unanswered question is a live Plan fact.
    managed.plan.refresh()
  }

  /**
   * Answer one pending question set (or dismiss it). The owner path travels
   * with the id so an answer cannot settle another chat's question; invalid
   * answers are rejected against the entry's own question list.
   */
  respondAskUser(requestId: string, ownerPath: string, payload: { answers?: AskUserAnswer[]; cancelled?: boolean }): boolean {
    const accepted = respondAskUserRequest(requestId, ownerPath, payload)
    const managed = this.sessions.get(ownerPath)
    if (managed) this.publishAskUser(managed)
    return accepted
  }

  /**
   * The user touched the panel: cancel the auto-settle countdown and tell every
   * view, so a re-mounted panel stops drawing one. Collapsing never comes here.
   */
  engageAskUser(requestId: string, ownerPath: string): boolean {
    const accepted = engageAskUserRequest(requestId, ownerPath)
    const managed = this.sessions.get(ownerPath)
    if (managed) this.publishAskUser(managed)
    return accepted
  }

  /**
   * Answer one escalation. The session path travels with the id so an answer
   * cannot settle a question belonging to another session.
   */
  respondEscalation(requestId: string, sessionPath: string, decision: SandboxEscalationDecision): boolean {
    const accepted = respondToEscalation(requestId, sessionPath, decision)
    const managed = this.sessions.get(sessionPath)
    if (managed) this.publishEscalations(managed)
    return accepted
  }

  /** Manual compaction waits for a complete response/tool boundary during a
   * live run. The promise belongs to this session, even after navigation. */
  async compactSession(sessionPath: string): Promise<SessionSnapshotDTO> {
    const managed = this.sessions.get(sessionPath)
    if (!managed) throw new Error('No such session')
    if (managed.subagentChild) throw new Error('A subagent session follows its parent session')
    if (managed.scheduledTask) throw new Error('A scheduled task session is read-only')
    if (managed.imageReplay) throw new Error('Stop the image retry before compacting')
    await managed.manualCompaction!.request()
    return this.snapshotOf(managed)
  }

  private validateCompaction(managed: ManagedSession): void {
    managed.plan.checkWorkAdmission()
    const settings = managed.session.settingsManager.getCompactionSettings(managed.session.model ?? undefined)
    const messages = buildSessionContext(managed.session.sessionManager.getBranch()).messages
    const tokens = messages.reduce((sum, message) => sum + estimateTokens(message), 0)
    if (tokens <= settings.keepRecentTokens) throw new Error(NOTHING_TO_COMPACT_MESSAGE)
  }

  /**
   * Manual resource reload — the app's `/reload` (the CLI rebuilds the same
   * set: extensions, skills, prompts and context files). Every live session is
   * rebuilt from disk and its derived system prompt with it, which is what
   * makes an edit made OUTSIDE the app — an extension's source, a SKILL.md, an
   * AGENTS.md — reach the next turn without a restart.
   *
   * A live run is refused rather than deferred: reloading swaps the extension
   * runner under the request in flight, and silently folding the request into
   * `reloadPending` would make the button read as broken. Settings changes keep
   * taking the deferred path — they were not asked for at this moment, so they
   * land at `agent_settled` instead.
   */
  async reloadSession(sessionPath: string): Promise<SessionSnapshotDTO> {
    const managed = this.sessions.get(sessionPath)
    if (!managed) throw new Error('No such session')
    if (managed.scheduledTask) throw new Error('A scheduled task session is read-only')
    if (managed.session.isStreaming || managed.imageReplay) throw new Error('Stop the running turn before reloading')
    const release = managed.plan.beginWork('branch')
    try {
      await this.reloadLiveSessions()
      return this.snapshotOf(managed)
    } finally { release() }
  }

  // ---- subagents (delegated child sessions) ----

  /** Current roster of a parent session (renderer panel refresh). */
  listSubagents(sessionPath: string): SubagentRunDTO[] {
    return this.sessions.get(sessionPath)?.subagents?.snapshot() ?? []
  }

  /**
   * One session's transcript for the rail's side view, read WITHOUT making it
   * the active session: the visible chat keeps its session, and a child's runs
   * stay owned by its parent's runtime.
   *
   * A session that is already managed (a live or viewed child) returns its
   * live snapshot. One that is not is read straight from its file — building a
   * whole AgentSession (extensions, task owner, notifications) just to show a
   * finished transcript would cost seconds and register machinery nobody asked
   * for. The raw selected branch is projected for display so compaction markers
   * and the history they summarized remain visible without re-entering context.
   */
  peekSession(path: string): SessionSnapshotDTO {
    const managed = this.sessions.get(path)
    if (managed) return this.snapshotOf(managed)
    const manager = SessionManager.open(path)
    const messages = serialize(transcriptMessages(manager)) as ChatMessage[]
    const runs = readDiskSubagentRuns(manager.getEntries() as any[])
    const current = runs[runs.length - 1]
    const cwd = manager.getCwd()
    return {
      sessionId: manager.getSessionId(),
      sessionPath: path,
      cwd,
      projectless: isDefaultWorkspace(cwd),
      initializing: false,
      messages,
      todos: null,
      streaming: null,
      toolRuns: {},
      queue: { steering: [], followUp: [] },
      model: null,
      thinkingLevel: 'off',
      availableThinkingLevels: [],
      isStreaming: false,
      contextUsage: null,
      subagents: [],
      subagentChild: current !== undefined,
      scheduledTaskSession: scheduledTaskRoleFromEntries(manager.getEntries()) !== undefined,
      ...(current ? { subagentParentPath: current.start.parentSessionPath } : {}),
      eventSequence: 0
    }
  }

  /**
   * The full context readout of one open session for the rail's context tab.
   *
   * A live session is read from memory — its `messages` are the branch's
   * compaction-converted context, which is what the breakdown estimates — and a
   * path that is not managed any more (the visible session was just switched
   * away from) falls back to the file, so the pane can never throw at a session
   * boundary.
   *
   * Live request statistics are bounded in-memory metadata. Recovery reads
   * statistics through the trajectory worker, without loading body documents.
   * Sequence-free context revisions also refresh captures with equal usage.
   */
  async contextDetail(sessionPath?: string): Promise<ContextDetailDTO> {
    const managed = sessionPath ? this.sessions.get(sessionPath) : this.activeSession
    if (!managed) {
      if (!sessionPath) throw new Error('Pi session is not initialized')
      return this.diskContextDetail(sessionPath)
    }
    const session = managed.session
    const model = session.routedModel?.model ?? session.model
    // SAFETY: the SDK statistics carry the cost fields required by ContextStatsLike.
    const stats = session.getSessionStats() as unknown as ContextStatsLike
    const usage = this.contextUsageOf(managed) ?? {
      tokens: null,
      contextWindow: model?.contextWindow ?? 0,
      percent: null,
      sessionCost: stats.cost,
      cacheHitRate: cacheHitRate(stats.tokens)
    }
    const header = session.sessionManager.getHeader()
    const createdAt = header?.timestamp ? Date.parse(header.timestamp) : NaN
    let lastActivity: number | null = null
    const file = session.sessionFile
    if (file) {
      try {
        lastActivity = statSync(file).mtimeMs
      } catch {
        // A file that vanished keeps the header-derived values only.
      }
    }
    const leafId = session.sessionManager.getLeafId()
    const input = {
      messages: session.sessionManager.buildSessionProjection().messages,
      entries: session.sessionManager.getEntries() as any[],
      stats,
      usage,
      meta: {
        sessionId: session.sessionId,
        sessionPath: managed.path,
        title: session.sessionManager.getSessionName() ?? null,
        cwd: managed.cwd,
        projectless: isDefaultWorkspace(managed.cwd),
        provider: model?.provider ?? null,
        model: model?.name ?? model?.id ?? null,
        thinkingLevel: session.thinkingLevel as ThinkingLevel,
        createdAt: Number.isFinite(createdAt) ? createdAt : null,
        lastActivity
      }
    }
    const request = managed.trajectory?.contextStats() ?? await this.trajectory.context({ sessionPath: managed.path,
      sessionId: session.sessionId, leafId }).catch(() => null)
    return buildContextDetail({ ...input, request })
  }

  /**
   * The context readout of a session file nobody holds open: the same shape,
   * from disk alone. The counts and token totals are recomputed from the file's
   * own usage reports (`statsFromEntries`, mirroring the SDK's stats); only the
   * live ring readout stays blank, because a file has no context window — `—` is
   * the honest answer there, not a guess.
   */
  private async diskContextDetail(path: string): Promise<ContextDetailDTO> {
    const manager = SessionManager.open(path)
    const entries = manager.getEntries() as any[]
    const projection = manager.buildSessionProjection()
    const header = manager.getHeader()
    const createdAt = header?.timestamp ? Date.parse(header.timestamp) : NaN
    let lastActivity: number | null = null
    try {
      lastActivity = statSync(path).mtimeMs
    } catch {
      // Unreadable file: the pane still opens with the messages it could read.
    }
    // Model and thinking are selected-branch facts, unlike all-entry billing.
    const branch = manager.getBranch()
    const assistant = branch.filter(entry => entry.type === 'message' && entry.message.role === 'assistant').at(-1)
    const last = assistant?.type === 'message' && assistant.message.role === 'assistant' ? assistant.message : null
    const provider = projection.model?.provider ?? last?.provider ?? null
    const model = projection.model?.modelId ?? last?.model ?? null
    const thinkingLevel = branch.some(entry => entry.type === 'thinking_level_change')
      ? projection.thinkingLevel as ThinkingLevel : null
    const cwd = manager.getCwd()
    const stats = statsFromEntries(entries)
    const request = await this.trajectory.context({ sessionPath: path, sessionId: manager.getSessionId(), leafId: manager.getLeafId() }).catch(() => null)
    return buildContextDetail({
      messages: projection.messages,
      entries,
      stats,
      request,
      usage: {
        tokens: null,
        contextWindow: 0,
        percent: null,
        sessionCost: stats.cost,
        cacheHitRate: cacheHitRate(stats.tokens)
      },
      meta: {
        sessionId: manager.getSessionId(),
        sessionPath: path,
        title: manager.getSessionName() ?? null,
        cwd,
        projectless: isDefaultWorkspace(cwd),
        provider,
        model,
        thinkingLevel,
        createdAt: Number.isFinite(createdAt) ? createdAt : null,
        lastActivity
      }
    })
  }

  /**
   * The latest ordinary provider request's system prompt in this branch.
   * SDK per-turn overrides disappear at settlement, so read the recorder's
   * request snapshot. Before a request or after resource reload, fall back to
   * the SDK base; before_agent_start applies formatting on the next turn.
   */
  systemPrompt(sessionPath?: string): string {
    const managed = sessionPath ? this.sessions.get(sessionPath) : this.activeSession
    if (!managed) throw new Error(sessionPath ? 'No such session' : 'Pi session is not initialized')
    return managed.trajectory?.systemPrompt() ?? managed.session.systemPrompt
  }

  /**
   * Panel actions on a parent's subagent runs. `resume` continues a finished
   * child session under a fresh run, sharing the dispatch admission path.
   */
  async subagentAction(payload: SubagentActionPayload): Promise<void> {
    const managed = this.sessions.get(payload.sessionPath)
    const state = managed?.subagents
    if (!managed || !state) throw new Error('Subagents are only available on an open session')
    const expectedRunId = payload.expectedRunId?.trim()
    if (!expectedRunId) throw new Error('Subagent run identity is required')
    if (payload.action === 'steer') {
      if (!payload.message?.trim()) throw new Error('Steering message is required')
      this.subagentRuntime.steer(state, payload.sessionId, payload.message, expectedRunId)
      return
    }
    if (payload.action === 'abort') {
      this.subagentRuntime.abort(state, payload.sessionId, expectedRunId)
      return
    }
    await this.subagentRuntime.resume(state, managed.session, payload.sessionId, payload.message ?? '', { expectedRunId })
  }

  /** Toggle subagents; applies to sessions created afterwards (the tool is
   * registered at session build) and blocks new dispatches immediately. */
  setSubagentsEnabled(enabled: boolean): boolean {
    this.subagentsEnabledFlag = enabled === true
    saveSettings({ ...loadSettings(), subagentsEnabled: this.subagentsEnabledFlag })
    return this.subagentsEnabledFlag
  }

  setSubagentMaxConcurrent(value: number): number {
    if (!Number.isInteger(value) || value < 1 || value > MAX_CONCURRENT_SUBAGENTS_LIMIT) throw new Error('Invalid subagent concurrency limit')
    saveSettings({ ...loadSettings(), subagentMaxConcurrent: value })
    this.subagentMaxConcurrentSetting = value
    return value
  }

  /** Toggle model-driven continuation of finished subagents. The `agent`
   * tool reads the flag live (description and execute path), so it applies to
   * the very next dispatch without rebuilding any session. */
  setSubagentReuseEnabled(enabled: boolean): boolean {
    this.subagentReuseFlag = enabled === true
    saveSettings({ ...loadSettings(), subagentReuseEnabled: this.subagentReuseFlag })
    return this.subagentReuseFlag
  }

  /** Toggle parent↔child steering. `agent_steer` exposure changes for live
   * sessions (applyActiveTools reads the flag after the reload walk, the same
   * mechanism the browser tools use), and the next dispatched child's frozen
   * ceiling gains message_parent. */
  async setSubagentCommsEnabled(enabled: boolean): Promise<boolean> {
    this.subagentCommsFlag = enabled === true
    saveSettings({ ...loadSettings(), subagentCommsEnabled: this.subagentCommsFlag })
    await this.reloadLiveSessions()
    return this.subagentCommsFlag
  }

  /** Refresh schemas for live sessions; held calls also recheck the grant. */
  async setSubagentTurnLimitOverrideEnabled(enabled: boolean): Promise<boolean> {
    const next = enabled === true
    saveSettings({ ...loadSettings(), subagentTurnLimitOverrideEnabled: next })
    this.subagentTurnLimitOverrideFlag = next
    await this.reloadLiveSessions()
    return next
  }

  setSubagentMaxTurns(value: number | null): number | null {
    if (value !== null && (!Number.isInteger(value) || value < 1 || value > SUBAGENT_MAX_TURNS_LIMIT)) {
      throw new Error('Invalid subagent turn limit')
    }
    saveSettings({ ...loadSettings(), subagentMaxTurns: value })
    this.subagentMaxTurnsSetting = value
    return value
  }

  /** Every profile visible in the active workspace, for Settings → Subagents,
 * plus the directories a new file can land in. Each profile is an ordinary
 * Markdown file; a project-scope file shadows a same-name global one exactly
 * as the `agent` tool resolves them. */
  subagentProfiles(): SubagentProfilesDTO {
    const cwd = this.cwd ?? null
    return {
      profiles: listSubagentProfiles(cwd).map(toSubagentProfileDTO),
      globalDir: join(getAgentDir(), 'agents'),
      projectDir: cwd && !isDefaultWorkspace(cwd) ? join(cwd, '.pi', 'agents') : null
    }
  }

  /** Create one new profile file (Settings → Subagents). The target directory
   * comes from the chosen scope — project scope needs a real project to be
   * active; a projectless chat's internal workspace never hosts profiles. */
  async createSubagentProfile(payload: SubagentProfileCreatePayload): Promise<SubagentProfilesDTO> {
    const cwd = this.cwd ?? null
    const dir = payload.scope === 'project'
      ? (cwd && !isDefaultWorkspace(cwd) ? join(cwd, '.pi', 'agents') : null)
      : join(getAgentDir(), 'agents')
    if (!dir) throw new Error('No project workspace is active')
    createSubagentProfileFile(dir, payload)
    await this.reloadLiveSessions()
    return this.subagentProfiles()
  }

  /** Rewrite one profile's `tools:` frontmatter line (Settings → Subagents).
   * Only a currently listed profile file is accepted — the same rule the
   * skill methods follow, so this cannot become an arbitrary file write —
   * and live sessions reload, because the `agent` tool's description embeds
   * each profile's tool set at session build. */
  async setSubagentProfileTools(filePath: string, tools: 'all' | string[]): Promise<SubagentProfilesDTO> {
    if (!listSubagentProfiles(this.cwd ?? null).some((profile) => profile.filePath === filePath)) {
      throw new Error('Unknown subagent profile')
    }
    writeSubagentProfileTools(filePath, tools)
    await this.reloadLiveSessions()
    return this.subagentProfiles()
  }

  async setSubagentProfileDefaults(filePath: string, defaults: SubagentProfileDefaultsPayload): Promise<SubagentProfilesDTO> {
    if (!listSubagentProfiles(this.cwd ?? null).some(profile => profile.filePath === filePath)) throw new Error('Unknown subagent profile')
    writeSubagentProfileDefaults(filePath, defaults)
    await this.reloadLiveSessions()
    return this.subagentProfiles()
  }

  /** Persist which session the next launch opens. */
  setStartupMode(mode: StartupSessionMode): StartupSessionMode {
    if (mode !== 'resume' && mode !== 'new') throw new Error('Invalid startup preference')
    saveSettings({ ...loadSettings(), startup: mode })
    this.startup = mode
    return mode
  }
  private trajectoryTimer: ReturnType<typeof setTimeout> | null = null
  private trajectoryChanged = new Set<string>()
  private trajectory = new TrajectoryClient(join(app.getPath('userData'), 'trajectory.sqlite'), id => {
    this.trajectoryChanged.add(id)
    if (this.closing || this.trajectoryTimer) return
    this.trajectoryTimer = setTimeout(() => {
      this.trajectoryTimer = null
      for (const [sessionPath, managed] of this.sessions) if (this.trajectoryChanged.has(managed.session.sessionId)) this.emit('pi:trajectory', { sessionPath })
      this.trajectoryChanged.clear()
    }, 250)
  })
  private sessionSearch = new SessionSearch()
  /** Sidebar listing index — stat-keyed row cache so refreshes skip unchanged files (see session-list.ts). */
  private sessionIndex = new SessionListIndex(join(app.getPath('userData'), 'session-list-cache.json'))
  /** One list refresh at a time; turn-boundary events fire these in bursts. */
  private sessionListInFlight: Promise<SessionSummaryDTO[]> | null = null
  private usageAggregator = new UsageAggregator()
  private modelRuntime: ModelRuntime | null = null
  /** Lazily created; reads/writes ~/.pi/agent/settings.json (default model). */
  private settingsManagerInstance: SettingsManager | null = null
  /** Navigation can request the same file while its extensions are loading. */
  private sessionBuilds = new Map<string, Promise<ManagedSession>>()
  /** Per-session-file Plan metadata clock; survives a managed rebuild. */
  private planSequences = new Map<string, number>()
  private goalSequences = new Map<string, number>()
  /** Queue metadata clock also advances when a managed session is rebuilt. */
  private compactionQueueRevision = 0
  private compactionProcessRevision = 0
  /** Every currently active or background-running SDK session, keyed by file. */
  private sessions = new Map<string, ManagedSession>()
  private imageReplayRevisions = new Map<string, number>()
  private activeSession: ManagedSession | null = null
  /** Invalidates slower session creations when a newer navigation wins. */
  private navigationEpoch = 0
  private fileIndex: FileIndex | null = null
  private pendingAuth = new Map<
    string,
    { providerId: string; resolve: (v: string) => void; reject: (e: Error) => void }
  >()
  /** In-flight logins, keyed by provider id — the one cancel hits. */
  private loginAborts = new Map<string, AbortController>()
  /** Fixed-cadence context-usage poll (see CONTEXT_USAGE_POLL_MS). */
  private contextUsageTimer: ReturnType<typeof setInterval> | null = null
  /** In-flight side-chat answers, keyed by exchange id (see sideChatAsk). */
  private sideChats = new Map<string, AbortController>()

  cwd: string | null = null
  /** Folders the user has opened, most recent first — sessions of all of
   * them stay listed; `cwd` is the active workspace. */
  folders: string[] = loadSettings().folders.filter((f) => typeof f === 'string' && !isDefaultWorkspace(f))
  /** Whether context files (AGENTS.md/CLAUDE.md) are injected into the system
   * prompt. Read live by the resource-loader override, so a reload applies it. */
  private includeContextFiles = loadSettings().contextFiles !== false
  /** What a boot opens (Settings → General → Startup). */
  private startup: StartupSessionMode = loadSettings().startup
  /** Extensions switched off in Settings. Read live by the loader wrapper, so
   * `session.reload()` applies a toggle without rebuilding services. */
  private disabledExtensions = new Set(loadSettings().disabledExtensions ?? [])
  /** Catalog snapshot keyed by session + disabled set; invalidated on reload. */
  private catalogCache: { key: string; value: ToolCatalogDTO } | null = null
  /** Tools a now-disabled extension had registered at runtime, so a lazily
   * registering extension (pi-fff) keeps its tools listed while switched off. */
  private knownExtensionTools = new Map<string, ToolInfoDTO[]>()

  constructor(
    private emit: (channel: string, payload: unknown) => void,
    private notifyError: (message: string) => void,
    private readonly imageSkillPath?: string
  ) {
    this.checkoutCoordinator.initialize(() => this.rewindClient.recoveryMarkers())
    ensureDefaultProfiles(join(app.getPath('userData'), 'subagents'))
    // The ring refreshes on a timer rather than only when the SDK reports a
    // boundary, so it tracks the context while a turn is in flight.
    this.contextUsageTimer = setInterval(() => this.pollContextUsage(), CONTEXT_USAGE_POLL_MS)
  }

  /**
   * The subagent engine, wired to this manager's own facilities. Children are
   * real ManagedSessions (disposal, event routing, bash ownership), created
   * through the same registry as user sessions — never an unmanaged
   * AgentSession the shutdown paths cannot see. Created lazily so partial
   * instances (regression-check mocks via Object.create) work unchanged.
   */
  private subagentRuntimeInstance: SubagentRuntime | null = null
  private get subagentRuntime(): SubagentRuntime {
    this.subagentRuntimeInstance ??= new SubagentRuntime({
      isClosing: () => this.closing,
      maxConcurrentSubagents: () => this.subagentMaxConcurrentSetting,
      subagentsEnabled: () => this.subagentsEnabledFlag && !this.closing,
      subagentReuseEnabled: () => this.subagentReuseFlag && !this.closing,
      subagentCommsEnabled: () => this.subagentCommsFlag && !this.closing,
      subagentTurnLimitOverrideEnabled: () => this.subagentTurnLimitOverrideFlag === true && !this.closing,
      subagentMaxTurns: () => this.subagentMaxTurnsSetting ?? null,
      // The debugger grant rides the profile's ordinary tool set: `all`, or
      // an explicit `debug` entry. The parent's own debug availability stays
      // the ceiling at dispatch either way (runtime.ts).
      profileDebugEnabled: (cwd, name) => listSubagentProfiles(cwd).some(p => p.name === name && p.enabled && (p.tools === 'all' || p.tools.includes('debug'))),
      planRestricted: path => this.sessions.get(path)?.plan.restricted ?? false,
      frozenToolCeiling: path => this.sessions.get(path)?.subagentChild?.toolCeiling ?? null,
      commandTasks: () => this.commandTasks,
      acquireRunLease: (cwd, sessionPath) => {
        const managed = this.sessions.get(sessionPath)
        if (managed && !this.planToolAdmitted(managed)) throw new Error('plan-subagent-admission-blocked')
        return this.checkoutCoordinator.acquire(cwd, 'subagent', sessionPath)
      },
      createChildSession: (options) => this.createSubagentChildSession(options),
      emitSubagents: (sessionId, sessionPath, runs) => {
        // Sequence-free metadata ping (same rule as context_usage): roster
        // updates are not steps of the transcript's event log.
        this.emit('pi:event', serialize({ type: 'subagents_update', sessionId, sessionPath, subagents: runs }))
      },
      resolveModelSpec: async (spec, fallback) => {
        const runtime = await this.runtime()
        if (spec) {
          const [providerId, ...rest] = spec.split('/')
          const modelId = rest.join('/')
          if (providerId && modelId && runtime.getModel(providerId, modelId)) return { spec }
          // A well-formed spec that is merely not configured is NOT a syntax
          // error; say which half is missing and what exists instead.
          throw new Error(subagentModelSpecError(spec, {
            providers: runtime.getProviders().map((provider) => provider.id),
            modelsOf: (id) => {
              const provider = runtime.getProvider(id)
              return provider ? provider.getModels().map((model) => model.id) : null
            }
          }))
        }
        // No override: inherit the parent's live model AS A SPEC, so the child
        // resolves the same model instead of falling back to default selection.
        const parent = fallback.model
        return parent ? { spec: `${parent.provider}/${parent.id}` } : {}
      },
      notifySubagentChildWrite: (cwd) => {
        if (this.cwd === cwd) void this.fileIndex?.refresh(true).catch(() => {})
      }
    } satisfies SubagentHost)
    return this.subagentRuntimeInstance
  }

  /**
   * Push context usage for every live session whose value moved, so the composer
   * ring tracks the context between message boundaries. Every managed session is
   * polled rather than only the active one: a visible session then can never be
   * starved by an active-session mismatch (the renderer drops pushes for
   * sessions it is not showing).
   *
   * No `eventSequence`: this is a metadata ping, not a step of the session's
   * event log, and bumping the sequence would make the renderer treat an
   * unchanged snapshot as a newer one (remounting the transcript).
   */
  private pollContextUsage(): void {
    for (const managed of this.sessions.values()) {
      // A subagent child the user is not viewing has no visible ring; its
      // progress reaches the renderer through throttled roster events instead.
      if (managed.subagentChild && managed !== this.activeSession) continue
      const usage = this.contextUsageOf(managed)
      const key = JSON.stringify(usage)
      if (key === managed.contextUsageKey) continue
      managed.contextUsageKey = key
      this.emit(
        'pi:event',
        serialize({
          type: 'context_usage',
          sessionId: managed.session.sessionId,
          sessionPath: managed.path,
          cwd: managed.cwd,
          contextUsage: usage
        })
      )
    }
    this.publishMcpStatusIfChanged()
  }

  /** Move a folder to the front of the known list and persist it. */
  private rememberFolder(cwd: string): void {
    if (!isDefaultWorkspace(cwd)) {
      this.folders = [cwd, ...this.folders.filter((f) => f !== cwd)].slice(0, MAX_FOLDERS)
    }
    saveSettings({
      ...loadSettings(),
      cwd: this.cwd && !isDefaultWorkspace(this.cwd) ? this.cwd : null,
      folders: this.folders,
      // The session the user is actually in, so the `resume` startup reopens
      // this one instead of guessing from file mtimes.
      startupSession: this.activeSession?.path ?? null
    })
  }

  /** Switch the active workspace folder (file index, session dir context). */
  private activateFolder(cwd: string): void {
    if (this.cwd !== cwd || !this.fileIndex) {
      this.fileIndex = new FileIndex(cwd)
      void this.fileIndex.refresh(true).catch(() => {})
    }
    this.cwd = cwd
    this.rememberFolder(cwd)
  }

  private async runtime(): Promise<ModelRuntime> {
    if (!this.modelRuntime) {
      this.modelRuntime = await ModelRuntime.create({
        allowModelNetwork: true,
        modelRefreshTimeoutMs: 10_000
      })
      // Publish OpenRouter's native image endpoint as a first-class Pi image API
      // so the `image` tool and codemode reach the models that OpenRouter serves
      // only there. Best-effort: a missing credential or unreachable catalog
      // must never block a session from starting.
      await ensureOpenRouterNativeImages(this.modelRuntime)
    }
    return this.modelRuntime
  }

  /** Runtime facts belong to the same loader as the native MCP extension. */
  private mcpRuntimeStatuses = new WeakMap<ResourceLoader, Map<string, { name: string; status: McpRuntimeStatus }>>()

  private async servicesFor(cwd: string, todos: TodoState, recoveryOnly = false, subagent?: { appendSystemPrompt?: string; extensions?: boolean }, planContext?: ReturnType<typeof createPlanContextExtension>, compactionProcess?: ReturnType<typeof createCompactionProcessExtension>, goalContext?: ReturnType<typeof createGoalContextExtension>): Promise<AgentSessionServices> {
    // A loader owns mutable extension closures and an ExtensionRuntime whose
    // actions bind to ONE session. Sharing it by cwd lets another session's
    // bind/reload/dispose overwrite or invalidate a still-live MCP context.
    //
    // The SettingsManager is built here (not left to the SDK) so the app's
    // provider timeout can be applied as an in-memory override before the
    // session's first request; `SettingsManager.create(cwd, agentDir)` is
    // exactly the SDK's own default for this path.
    const settingsManager = SettingsManager.create(cwd, getAgentDir())
    this.applyResponseTimeout(settingsManager)
    const loadNativeTools = !recoveryOnly && (subagent === undefined || subagent.extensions === true)
    const mcpStatuses = new Map<string, { name: string; status: McpRuntimeStatus }>()
    let mcpGeneration = 0
    const services = await createAgentSessionServices({
      cwd,
      settingsManager,
      modelRuntime: await this.runtime(),
      resourceLoaderOptions: {
        additionalSkillPaths: this.imageSkillPath ? [this.imageSkillPath] : [],
        // A child loads extensions only when its frozen ceiling names one.
        // The SDK's `tools` allowlist then restricts even late registrations.
        // Every other delegation stays extension-free — N children with
        // extension runtimes would multiply MCP hosts per workspace. A
        // recovery-only session never loads extensions at all.
        noExtensions: recoveryOnly || (subagent !== undefined && subagent.extensions !== true),
        extensionFactories: [
          createToolCallBoundaryExtension(), todos.extension(), createPromptFormatExtension(), createSearchResultExtension(), ...(planContext ? [planContext] : []),
          ...(compactionProcess ? [compactionProcess] : []),
          ...(goalContext ? [goalContext] : []),
          // Ordered last below: enhance the default without masking a read
          // override, including one registered lazily by another inline factory.
          { name: 'native-read', factory: api => api.registerTool(createAppReadTool(cwd)), hidden: true },
          ...(loadNativeTools ? [
            { name: 'native-codemode', factory: createAppCodemodeExtension(), hidden: true },
            { name: 'native-tool-search', factory: createToolSearchExtension(), hidden: true },
            { name: 'native-mcp', factory: (api: ExtensionAPI) => {
              const generation = ++mcpGeneration
              mcpStatuses.clear()
              return createMcpExtension({ onStatusChange: servers => {
                // A loader reload creates a new factory closure. Its predecessor
                // may still finish disconnecting; never let it replace live facts.
                if (generation !== mcpGeneration || this.closing) return
                mcpStatuses.clear()
                for (const server of servers) mcpStatuses.set(mcpServerKey(server.name), {
                  name: server.name,
                  status: server.state === 'closed' ? 'disconnected' : server.state
                })
                this.publishMcpStatusIfChanged()
              } })(api)
            }, hidden: true }
          ] : [])
        ],
        // The adapter may still be installed globally for Pi CLI. It must not
        // bind in this app, where the native factories above own MCP.
        extensionsOverride: result => ({
          ...result,
          extensions: result.extensions.filter(extension => !isLegacyMcpAdapter(extension))
            .sort((a, b) => Number(a.path === '<inline:native-read>') - Number(b.path === '<inline:native-read>'))
        }),
        ...(subagent?.appendSystemPrompt ? { appendSystemPrompt: [subagent.appendSystemPrompt] } : {}),
        // Children inherit AGENTS.md per the same live app setting — a
        // delegated implementer must still know the project's rules.
        agentsFilesOverride: (base) => (this.includeContextFiles ? base : { agentsFiles: [] })
      }
    })
    this.mcpRuntimeStatuses.set(services.resourceLoader, mcpStatuses)
    return services
  }

  /**
   * Wrap a resource loader so the extension runner only ever sees extensions
   * the user left enabled. Everything else delegates to the real loader —
   * including `reload()`, so extensions are still resolved and enriched once.
   * The filter reads `disabledExtensions` live, which is what makes
   * `session.reload()` apply a toggle.
   */
  private filterExtensions(loader: ResourceLoader): ResourceLoader {
    const isDisabled = (extension: Extension): boolean =>
      !extension.hidden && this.disabledExtensions.has(extensionId(extension))
    return new Proxy(loader, {
      get: (target, prop) => {
        if (prop === 'getExtensions') {
          const getExtensions = target.getExtensions.bind(target)
          return () => {
            const result = getExtensions()
            return { ...result, extensions: result.extensions.filter((e) => !isDisabled(e)).map(desktopExtension) }
          }
        }
        const value = target[prop as keyof ResourceLoader]
        return typeof value === 'function' ? value.bind(target) : value
      }
    }) as ResourceLoader
  }

  private disposeManaged(managed: ManagedSession): Promise<void> {
    // A question whose session is going away has no answerer: settle it as
    // cancelled so nothing is left waiting on a closed session.
    clearSessionEscalations(managed.path)
    // A question whose session is going away has no answerer: settle it as
    // cancelled so nothing is left waiting on a closed session. A subagent
    // child's questions live under the parent's path, so its own teardown
    // must clear them by source — the owner key stays for the parent itself.
    clearSessionAskUserRequests(managed.path)
    if (managed.subagentChild) clearSubagentAskUserRequests(managed.path)
    if (managed.disposePromise) return managed.disposePromise
    managed.disposing = true
    managed.goals?.dispose()
    managed.manualCompaction?.dispose()
    managed.imageReplay?.controller.abort()
    this.jevService.cancel(managed.path)
    managed.planApproval?.dispose()
    managed.rewind?.dispose()
    // Put the session's own tool setter and hook chain back before disposal,
    // so an SDK path that reaches the session during teardown sees its own
    // methods rather than a gate whose effective view is being discarded.
    managed.disposeToolCallBoundary?.()
    managed.gate?.dispose()
    managed.jevWorkflow?.dispose()
    managed.disposePlanStream?.()
    managed.disposeGoalBillingStream?.()
    managed.disposeTextOnlyImages?.()
    managed.disposeImageReplayContext?.()
    managed.disposeContextBudget?.()
    managed.disposeImageSafety?.()
    managed.reloadPending = false
    // Disposal owns the whole subtree: a parent being deleted or the app
    // quitting aborts its subagent runs (suppressed — they must not wake) and
    // tears down their child sessions through the same registry.
    this.subagentRuntime.abortAll(managed.subagents)
    managed.subagents?.notifications?.dispose()
    managed.notifications?.dispose()
    managed.disposePromise = (async () => {
      const abort = Promise.resolve().then(() => { managed.session.clearQueue(); return managed.session.abort() })
      // Cancel async MCP initialization before invalidating its captured ctx.
      // Wait for an in-flight bind/reload so shutdown reaches the new runner.
      // If it outlives our deadline, its eventual completion still tears down.
      const shutdown = async (): Promise<void> => {
        await managed.lifecyclePromise
        try {
          await managed.session.extensionRunner?.emit({ type: 'session_shutdown', reason: 'quit' })
          // Let cooperative aborts persist the interrupted turn before dispose
          // disconnects the SDK's message listeners.
          await settleWithin([abort], SESSION_DISPOSE_TIMEOUT_MS)
        }
        finally { managed.session.dispose() }
      }
      const settled = await settleWithin([
        abort,
        ...(managed.imageReplay?.promise ? [managed.imageReplay.promise] : []),
        Promise.resolve().then(() => this.commandTasksInstance?.stopSession(managed.path)),
        Promise.resolve().then(() => this.debugManagerInstance?.stopSession(managed.path)),
        shutdown()
      ], SESSION_DISPOSE_TIMEOUT_MS)
      if (!settled) managed.session.dispose()
      try {
        if (managed.goalBilling) {
          if (settled && managed.session.isIdle) managed.goalBilling.close()
          else managed.goalBilling.abandon()
        }
      } catch { try { managed.goalBilling?.abandon() } catch { /* recovery retains the source even when the ledger cannot be written */ } }
      managed.unsubscribe()
      await managed.trajectory?.dispose()
      if (managed.streamFlushTimer) clearTimeout(managed.streamFlushTimer)
      managed.pendingStreamEvents.clear()
      if (this.sessions.get(managed.path) === managed) this.sessions.delete(managed.path)
      if (this.activeSession === managed) this.activeSession = null
      // The session is gone: drop any browser pages still registered to it.
      // Fire-and-forget — guest teardown is a renderer round trip and disposal
      // must not wait on it.
      void getBrowserService()?.closePagesForOwner(agentOwner(managed.session.sessionManager.getSessionId()))
    })()
    return managed.disposePromise
  }

  /**
   * Switch the visible session without disposing the old AgentSession. The SDK
   * disposer's contract is to abort its agent, so disposal is reserved for
   * deletion and application shutdown.
   */
  private activateSession(managed: ManagedSession, remember = true): void {
    if (this.closing || managed.disposing) return
    this.activeSession = managed
    // A question asked while the user was viewing another session (or while
    // macOS had no app window) was filtered out there; re-announce it so the
    // panel and notification router both receive the still-pending request.
    this.publishEscalations(managed)
    this.publishAskUser(managed)
    if (remember) {
      this.activateFolder(managed.cwd)
      this.publishMcpStatusIfChanged()
      return
    }
    if (this.cwd !== managed.cwd || !this.fileIndex) {
      this.fileIndex = new FileIndex(managed.cwd)
      void this.fileIndex.refresh(true).catch(() => {})
    }
    this.cwd = managed.cwd
    this.publishMcpStatusIfChanged()
  }

  private routeEvent(managed: ManagedSession, event: AgentSessionEvent | PiEvent): void {
    if (managed.disposing) return
    // Rebuilds publish exactly one final queue_update (emitQueueState); the
    // SDK's own intermediate events for the same rebuild are swallowed before
    // they can touch the sequence or the renderer.
    if (event.type === 'queue_update' && managed.queueRebuilding) return
    managed.eventSequence += 1
    const routed = {
      ...event,
      sessionId: managed.session.sessionId,
      sessionPath: managed.path,
      cwd: managed.cwd,
      // A child session's run is a step of its parent's turn, not a chat the
      // user is in: the renderer's notification cues read this to stay silent
      // for a delegation's many child rounds (one chime when the PARENT ends).
      ...(managed.subagentChild ? { subagentChild: true } : {}),
      // A user-stopped run is not a finished one: stamped for the same reason
      // as `subagentChild`, so the renderer's cue can stay silent. Consumed
      // here, one settle per stop.
      ...(managed.userAborted ? { userAborted: true } : {}),
      eventSequence: managed.eventSequence
    } as PiEvent
    if (event.type === 'agent_start') managed.userAborted = false
    else if (event.type === 'agent_settled') managed.userAborted = false

    // Usage (and cost) move on completed messages and compaction boundaries;
    // attach the payload so those updates land in the same render as the
    // message itself (the fixed-cadence poll covers everything between).
    if (event.type === 'message_end' || event.type === 'compaction_end') {
      const usage = this.contextUsageOf(managed)
      ;(routed as any).contextUsage = usage
      managed.contextUsageKey = JSON.stringify(usage)
    }
    // Compaction rewrites the MODEL context, not the visible transcript. Ship
    // the full selected branch plus its new summary marker so history stays on
    // screen while the SDK's `session.messages` remains compacted for requests.
    if (event.type === 'compaction_end' && !(event as any).aborted) {
      ;(routed as any).messages = this.transcriptOf(managed)
    }

    if (event.type === 'message_start' || event.type === 'message_update') {
      if ((event as any).message?.role === 'assistant') managed.streaming = (event as any).message
    } else if (event.type === 'message_end') {
      const message = (event as any).message
      if (message?.role === 'assistant') {
        managed.streaming = null
        // An aborted or errored round makes the SDK's loop return before it
        // executes its tool calls; its `stopReason` is the earliest signal that
        // whatever is still marked running will never get an end event.
        if (message.stopReason === 'aborted' || message.stopReason === 'error') {
          this.settleToolRuns(managed)
        }
      }
    } else if (event.type === 'tool_execution_start') {
      managed.toolRuns[(event as any).toolCallId] = {
        toolCallId: (event as any).toolCallId,
        toolName: (event as any).toolName,
        args: (event as any).args,
        status: 'running',
        partial: undefined,
        startedAt: Date.now()
      }
    } else if (event.type === 'tool_execution_update') {
      const run = managed.toolRuns[(event as any).toolCallId]
      if (run) managed.toolRuns[(event as any).toolCallId] = { ...run, partial: (event as any).partialResult }
    } else if (event.type === 'tool_execution_end') {
      const run = managed.toolRuns[(event as any).toolCallId]
      if (run) {
        managed.toolRuns[(event as any).toolCallId] = {
          ...run,
          status: (event as any).isError ? 'error' : 'success',
          endedAt: Date.now(),
          partial: (event as any).result ?? run.partial
        }
      }
    } else if (event.type === 'queue_update') {
      this.reconcileQueue(managed, (event as any).steering ?? [], (event as any).followUp ?? [])
      // The renderer sees the rich mirror (payload counts), never raw text.
      ;(routed as any).steering = managed.queueMirror.steering.map(dtoOf)
      ;(routed as any).followUp = managed.queueMirror.followUp.map(dtoOf)
      // A queued user message is a live Plan fact.
      managed.plan.refresh()
    } else if (event.type === 'agent_end') {
      managed.streaming = null
    } else if (event.type === 'agent_settled') {
      // The run is over: no tool can still be executing.
      this.settleToolRuns(managed)
      if (managed.reloadPending) {
        managed.reloadPending = false
        // Applied out of band: reload() emits no prompt-related event, so the
        // renderer's transcript is unaffected; only the next turn's system
        // prompt differs.
        void this.reloadManagedSession(managed).catch(() => { managed.reloadPending = true })
      }
    }

    if (event.type !== 'message_update' && event.type !== 'tool_execution_update') {
      this.flushStreamEvents(managed)
      const payload = serialize(routed) as any
      // A live message has no session entry to read a completion time back from
      // (`stampCompletedAt` covers restored ones), so take the moment its entry
      // is written here. Stamped on the serialized copy: `routed` still holds
      // the SDK's own message object, which must not grow app-only fields.
      if (event.type === 'message_end' && payload?.message) payload.message.completedAt = Date.now()
      this.emit('pi:event', payload)
      return
    }
    const key = event.type === 'message_update' ? 'message_update' : `tool_execution_update:${(event as any).toolCallId}`
    managed.pendingStreamEvents.set(key, routed)
    if (!managed.streamFlushTimer) {
      const assistantUpdateType =
        event.type === 'message_update' ? (event as any).assistantMessageEvent?.type : undefined
      const toolHeavyUpdate =
        event.type === 'tool_execution_update' ||
        (typeof assistantUpdateType === 'string' && assistantUpdateType.startsWith('toolcall_'))
      managed.streamFlushTimer = setTimeout(() => {
        managed.streamFlushTimer = null
        this.flushStreamEvents(managed)
      }, toolHeavyUpdate ? TOOL_STREAM_FLUSH_MS : STREAM_FLUSH_MS)
    }
  }

  private flushStreamEvents(managed: ManagedSession): void {
    if (managed.streamFlushTimer) {
      clearTimeout(managed.streamFlushTimer)
      managed.streamFlushTimer = null
    }
    for (const event of managed.pendingStreamEvents.values()) {
      // Background sessions keep running, but their cumulative hot snapshots
      // stay in the main process until selected. This avoids wasting IPC and
      // renderer work on output the user cannot currently see.
      if (managed !== this.activeSession) continue
      if (event.type === 'message_update') delete event.assistantMessageEvent
      this.emit('pi:event', serialize(event))
    }
    managed.pendingStreamEvents.clear()
  }

  /**
   * Close tool runs that can no longer finish. An aborted or errored round makes
   * the SDK's loop return before it executes (or finishes) its tool calls, so no
   * `tool_execution_end` ever arrives; a call the abort cut off before execution
   * never even starts a run. The row would then stay "Running" in every later
   * snapshot, so settle them as failures: every run still marked running, plus a
   * run for a transcript tool call with neither a result nor a run.
   * The renderer applies the same rule to its own view (PiStore.settleToolRuns).
   */
  private settleToolRuns(managed: ManagedSession): void {
    const pending = new Map<string, { name: string; args: any }>()
    const resolved = new Set<string>()
    for (const message of managed.session.messages as ChatMessage[]) {
      if (message.role === 'assistant') {
        for (const part of message.content) {
          if (part.type === 'toolCall' && !pending.has(part.id)) {
            pending.set(part.id, { name: part.name, args: part.arguments })
          }
        }
      } else if (message.role === 'toolResult') {
        resolved.add(message.toolCallId)
      }
    }
    const now = Date.now()
    for (const [id, run] of Object.entries(managed.toolRuns)) {
      if (run.status !== 'running') continue
      managed.toolRuns[id] = { ...run, status: 'error', endedAt: run.endedAt ?? now }
    }
    for (const [id, call] of pending) {
      if (resolved.has(id) || managed.toolRuns[id]) continue
      // `startedAt: 0` — the call never ran, so the row reports no duration.
      managed.toolRuns[id] = {
        toolCallId: id,
        toolName: call.name,
        args: call.args,
        status: 'error',
        partial: undefined,
        startedAt: 0
      }
    }
  }

  private emitSessionError(managed: ManagedSession, error: unknown): void {
    managed.goals?.observe({ type: 'pi_error' })
    managed.streaming = null
    this.emit('pi:event', {
      type: 'pi_error',
      ...(error instanceof RewindFailure ? { rewindError: error.dto() } : { message: error instanceof Error ? error.message : String(error) }),
      sessionId: managed.session.sessionId,
      sessionPath: managed.path,
      cwd: managed.cwd,
      eventSequence: ++managed.eventSequence
    })
  }

  /**
   * Rebuild the payload mirror from the SDK's authoritative text arrays.
   * The SDK shrinks a queue by removing the FIRST occurrence of a delivered
   * text (indexOf + splice), so duplicates keep that same order: the removed
   * difference is dropped from the FRONT of the mirror, and the survivors are
   * then matched to the new list in order. A text with no surviving payload
   * resolves against the parked prompt payloads (newest first — the prompt
   * that just queued owns the text it just pushed), then falls back to a
   * text-only item: the SDK drops payload data at its boundary (extensions
   * queueing, template-expanded texts), and leftovers from a silent SDK-side
   * clear simply disappear with the rebuild.
   */
  private reconcileQueue(managed: ManagedSession, steering: readonly string[], followUp: readonly string[]): void {
    managed.queueMirror = {
      steering: this.reconcileSide(managed, managed.queueMirror.steering, steering),
      followUp: this.reconcileSide(managed, managed.queueMirror.followUp, followUp)
    }
  }

  /** One queue's worth of {@link reconcileQueue} — see it for the ordering rules. */
  private reconcileSide(managed: ManagedSession, prev: QueuedItem[], next: readonly string[]): QueuedItem[] {
    const pool = [...prev]
    const nextCounts = new Map<string, number>()
    for (const text of next) nextCounts.set(text, (nextCounts.get(text) ?? 0) + 1)
    const prevCounts = new Map<string, number>()
    for (const item of prev) prevCounts.set(item.text, (prevCounts.get(item.text) ?? 0) + 1)
    // Drop the messages that left this queue from the front, mirroring the
    // SDK's indexOf+splice on delivery so duplicate texts stay aligned.
    for (const [text, count] of prevCounts) {
      const removed = count - (nextCounts.get(text) ?? 0)
      for (let i = 0; i < removed; i++) {
        const index = pool.findIndex((item) => item.text === text)
        if (index < 0) break
        pool.splice(index, 1)
      }
    }
    return next.map((text) => {
      const index = pool.findIndex((item) => item.text === text)
      if (index >= 0) return pool.splice(index, 1)[0]
      return this.claimPendingPayload(managed, text)
    })
  }

  /**
   * Take the payload parked for `text` (newest first, since the prompt that
   * just queued is the one that produced it), or synthesize a text-only item
   * when none is parked — extension-queued or template-expanded texts.
   */
  private claimPendingPayload(managed: ManagedSession, text: string): QueuedItem {
    const index = managed.pendingQueuePayloads.findLastIndex((pending) => pending.composedText === text)
    if (index < 0) return { text, originalText: text, images: [], filePaths: [] }
    const stash = managed.pendingQueuePayloads.splice(index, 1)[0]
    return { text, originalText: stash.originalText, images: stash.images, filePaths: stash.filePaths }
  }

  /** Publish the mirror as a single queue_update (after rebuilds swallowed
   * the SDK's own intermediate events). Routing it back through reconcile is
   * an identity re-match, so the stash is never mis-consumed. */
  private emitQueueState(managed: ManagedSession): void {
    this.routeEvent(managed, {
      type: 'queue_update',
      steering: managed.queueMirror.steering.map((item) => item.text),
      followUp: managed.queueMirror.followUp.map((item) => item.text)
    } as AgentSessionEvent)
  }

  private async disposeAllSessions(): Promise<void> {
    await Promise.allSettled([
      ...[...this.sessions.values()].map((managed) => this.disposeManaged(managed)),
      ...this.sessionBuilds.values()
    ])
  }

  /**
   * `SessionManager.create()` keeps a brand-new session in memory until the
   * first user or assistant message is appended (the `hasConversationMessage` gate in its
   * private `_persist`), so it stays invisible to `SessionManager.list*()` and
   * would be lost the moment the user switches to another session. Write the
   * header to disk up front and reload it through the manager, which marks the
   * session flushed so later appends are incremental.
   */
  private materializeSession(sessionManager: SessionManager): void {
    const file = sessionManager.getSessionFile()
    const header = sessionManager.getHeader()
    if (!file || !header || existsSync(file)) return
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify(header)}\n`, { flag: 'wx' })
    sessionManager.setSessionFile(file)
  }

  private async buildSession(
    sessionManager: SessionManager,
    /** `false` after a project deletion, where an empty session file should
     * not immediately resurface the folder just removed. */
    materialize = true,
    navigationEpoch = this.navigationEpoch
  ): Promise<ManagedSession> {
    if (this.closing) throw new Error('Application is shutting down')
    const shouldActivate = () => !this.closing && navigationEpoch === this.navigationEpoch
    if (materialize) this.materializeSession(sessionManager)
    const requestedPath = sessionManager.getSessionFile()
    if (requestedPath) {
      const existing = this.sessions.get(requestedPath)
      if (existing && !existing.disposing) {
        if (this.closing || existing.disposing) throw new Error('Session was closed during initialization')
        if (shouldActivate()) this.activateSession(existing)
        return existing
      }
    }
    const key = requestedPath ?? `memory:${sessionManager.getSessionId()}`
    let pending = this.sessionBuilds.get(key)
    if (!pending) {
      pending = this.createManagedSession(sessionManager)
      this.sessionBuilds.set(key, pending)
    }
    try {
      const managed = await pending
      if (shouldActivate()) this.activateSession(managed, materialize)
      return managed
    } finally {
      if (this.sessionBuilds.get(key) === pending) this.sessionBuilds.delete(key)
    }
  }

  private async createManagedSession(sessionManager: SessionManager, subagentRole?: {
    parentPath: string
    resource: SubagentRunStartData['resource']
    /** Profile name, for the ask-user source badge on live child runs. */
    profile?: string
    model?: any
  }, scheduledRole?: {
    taskId: string
    runId: string
    model?: { provider: string; modelId: string }
    thinkingLevel?: ScheduledTaskThinkingLevel
  }): Promise<ManagedSession> {
    await this.checkoutCoordinator.ready()
    if (this.checkoutCoordinator.needsRecovery(sessionManager.getCwd())) {
      const status = await this.rewindClient.call('list', sessionManager.getCwd(), sessionManager.getSessionId())
      this.checkoutCoordinator.setRecovery(sessionManager.getCwd(), status.pending[0]?.id)
    }
    const recoveryOnly = this.checkoutCoordinator.needsRecovery(sessionManager.getCwd())
    if (!recoveryOnly) await hydrateImagePresentations(sessionManager)
    let detectedRole = subagentRole
    if (!detectedRole) {
      // Any open path (sidebar click, search hit, delete/recover rebuild) can
      // land on a subagent child file. The persisted run records are the only
      // place its frozen role lives: without restoring them the child would
      // re-activate the FULL tool set, gain a checkpoint recorder and lose its
      // profile system prompt.
      const runs = readDiskSubagentRuns(sessionManager.getEntries() as any[])
      const current = runs[runs.length - 1]
      if (current) detectedRole = { parentPath: current.start.parentSessionPath, resource: current.start.resource, profile: current.start.profile }
    }
    const role = detectedRole
    const isChild = role !== undefined
    // A session a scheduled run created keeps its restrictions across reopen
    // paths: like the subagent run records, the persisted marker is the only
    // place they live once the creating role is gone.
    const scheduled = scheduledRole ?? scheduledTaskRoleFromEntries(sessionManager.getEntries())
    const isScheduled = scheduled !== undefined
    const todos = new TodoState(sessionManager)
    const askRecords = new AskUserRecords(sessionManager)
    const fullServices = await this.servicesFor(
      sessionManager.getCwd(), todos, recoveryOnly,
      isChild ? { appendSystemPrompt: role!.resource.appendSystemPrompt, extensions: role!.resource.extensions } : undefined,
      createPlanContextExtension({ restricted: () => managed.plan.restricted, isChild: () => isChild,
        toolNames: () => managed.gate?.tools().map(t => t.name) ?? [],
        previousPlan: () => {
          const latest = managed.plan.branch.latest
          return latest && managed.plan.branch.mode === 'plan'
            ? { revision: latest.ref.revision, markdown: latest.markdown } : null
        } }),
      createCompactionProcessExtension({
        prepared: event => managed.compactionProcess?.prepared(event),
        applied: event => managed.compactionProcess?.applied(event)
      }),
      createGoalContextExtension(() => managed?.goals)
    )
    const services = { ...fullServices, resourceLoader: this.filterExtensions(fullServices.resourceLoader) }
    let notifications: TaskNotifications | undefined
    /** Built with `notifications`, once the session exists. */
    let askUserNotifications: AskUserNotifications | undefined
    const parentSessionRef: { session: import('@earendil-works/pi-coding-agent').AgentSession | null } = { session: null }
    const subagentState = isChild ? null : new SubagentParentState(sessionManager.getSessionId())
    // Plan state exists before any tool is built: the tool gate reads
    // `restricted` live on every call, so the controller must already be
    // readable when createAgentSessionFromServices freezes customTools.
    const planPath = sessionManager.getSessionFile() ?? `memory:${sessionManager.getSessionId()}`
    const planStorage = new PlanStorage(sessionManager)
    const plan = new PlanController({
      manager: sessionManager,
      storage: planStorage,
      facts: () => this.planFacts(managed),
      // Every published mode/plan change re-materializes the effective tool
      // view: entering/leaving Plan must change what the model can call NOW,
      // not only after the next registry rebuild. The base names stay the app's
      // last authoritative set, re-read from the CURRENT registry by refresh().
      changed: () => {
        this.publishPlanState(managed)
        managed.gate?.refresh()
      },
      nextSeq: () => this.nextPlanSeq(planPath)
    })
    // The mode the tools read per call. A subagent child follows its parent
    // session's live choice — a delegation must never run wider than the chat
    // that dispatched it — and its denials are final: the child has no
    // composer, so an escalation question there could never be answered.
    const liveSandboxMode = (): SandboxMode => this.effectiveSandboxMode(managed)
    const escalateForTools = (input: {
      toolCallId: string
      toolName: 'bash' | 'edit' | 'write' | 'debug'
      operation: SandboxEscalationOperationDTO
      sandboxPermissions: unknown
      justification: unknown
      signal?: AbortSignal
    }): Promise<SandboxMode> => this.escalateFor(managed, input)
    // The app-owned definitions are captured once, in the same array handed to
    // the SDK as `customTools`. The Plan gate proves an app tool by IDENTITY
    // against this array; it never re-looks-up a same-name definition, so a
    // foreign implementation cannot be laundered into the app ceiling.
    const customTools = [
      ...createManagedBashTools({ tasks: this.commandTasks, services,
        sessionId: sessionManager.getSessionId(), sessionPath: sessionManager.getSessionFile()!,
        maxWaitMs: () => this.bashMaxWaitMs, sandboxMode: liveSandboxMode,
        // Live Plan reads: the shell capability and the denial wording both
        // come from the session's own Plan state, per call.
        isPlanRestricted: () => managed.plan.restricted,
        planShellEnforcement: () => managed.plan.snapshot.shellEnforcement,
        ...(isChild || isScheduled ? {} : { escalate: escalateForTools }),
        canStart: () => (notifications?.canStart ?? false) && this.planToolAdmitted(managed) }),
      // The file sandbox replaces the SDK's own edit/write so every mutation
      // passes the DSH path policy; reads are untouched.
      ...createSandboxFileTools({
        cwd: services.cwd,
        getMode: liveSandboxMode,
        isPlanRestricted: () => managed.plan.restricted,
        ...(isChild || isScheduled ? {} : { escalate: escalateForTools })
      }),
      createPresentTool({ cwd: services.cwd, canStart: () => (notifications?.canStart ?? false) && this.planToolAdmitted(managed),
        generatedImage: (path, size) => capturePresentedImage(sessionManager, path, size) }),
      createPlanSubmissionTool(plan),
      createTodoTool(todos, () => (notifications?.canStart ?? false) && this.planToolAdmitted(managed)),
      ...(isChild || isScheduled ? [] : createGoalTools(() => managed.goals,
        () => (notifications?.canStart ?? false) && !managed.plan.restricted && this.planToolAdmitted(managed))),
      // The scheduler's own tool: registered for every session (children
      // exclude it through their ceilings); the service is resolved lazily in
      // execute so definition reads never boot the scheduler.
      createScheduledTaskTool({
        sessionId: sessionManager.getSessionId(),
        cwd: sessionManager.getCwd(),
        getPermissionMode: () => this.effectiveSandboxMode(managed),
        getService: () => this.scheduledTasks,
        canStart: () => (notifications?.canStart ?? false) && this.planToolAdmitted(managed)
      }),
      createJevTool(this.jevService, sessionManager.getSessionFile() ?? `memory:${sessionManager.getSessionId()}`,
        () => !this.closing && !this.jevUpdating && (notifications?.canStart ?? false) && this.planToolAdmitted(managed)),
      // ask_user_question suspends on the pending registry until the user
      // answers. A subagent child has no composer of its own, so its
      // questions register under the PARENT's path with a source badge —
      // the parent's panel answers them and the child's call resolves.
      // A scheduled-run session has no human surface at all: the tool stays
      // unregistered so the model can never block on an unanswerable ask.
      ...(isScheduled ? [] : [createAskUserTool({
        ownerPath: isChild ? role!.parentPath : (sessionManager.getSessionFile() ?? `memory:${sessionManager.getSessionId()}`),
        ...(isChild ? {
          source: {
            kind: 'subagent' as const,
            sessionPath: sessionManager.getSessionFile() ?? `memory:${sessionManager.getSessionId()}`,
            ...(role!.profile ? { profile: role!.profile } : {})
          }
        } : {}),
        onChanged: () => {
          if (isChild) {
            const owner = this.sessions.get(role!.parentPath)
            if (owner) this.publishAskUser(owner)
          } else {
            this.publishAskUser(managed)
          }
        },
        canStart: () => (notifications?.canStart ?? false) && this.planToolAdmitted(managed),
        // Read live, so changing the deadline in Settings applies to the
        // next question without rebuilding any session.
        timeoutMs: () => this.askUserTimeoutMs,
        // An async question is answered long after its call returned; the
        // outcome goes through this session's own outbox so it is steered
        // into the conversation the ask belongs to (a child's own, not the
        // parent's, even though the parent's panel answered it).
        deliverAsync: (delivery) => askUserNotifications?.settle(delivery)
      })]),
      // Children never see the delegation tool — recursion is excluded at
      // both the ceiling (allowlist) and the customTools layer.
      ...(subagentState && this.subagentsEnabledFlag ? [
        createSubagentTool({
          runtime: this.subagentRuntime, state: subagentState, parentSessionRef,
          parentSessionPath: sessionManager.getSessionFile()!,
          profiles: () => listSubagentProfiles(sessionManager.getCwd()),
          canStart: () => (notifications?.canStart ?? false) && subagentState.notifications!.canStart && this.planToolAdmitted(managed),
          canReuse: () => this.subagentReuseFlag && !this.closing,
          canSetMaxTurns: () => this.subagentTurnLimitOverrideFlag === true && !this.closing,
          canSteer: () => this.subagentCommsFlag && !this.closing
        }),
        // Parent-side steering, registered beside the delegation tool and
        // NEVER flag-gated here: the active set (applyActiveTools) exposes
        // it only while subagent communications are enabled, so the live
        // toggle works through the same reload walk the browser tools use.
        createAgentSteerTool({
          runtime: this.subagentRuntime, state: subagentState,
          canSteer: () => this.subagentCommsFlag && !this.closing
        })
      ] : []),
      // Child-side messaging: the runtime injects message_parent into the
      // frozen ceiling only while communications are enabled, but the
      // definition must exist for that name to activate — registration
      // itself is unconditional for children.
      ...(isChild ? [createMessageParentTool({
        canUse: () => this.subagentCommsFlag && !this.closing,
        deliver: (text) => this.deliverSubagentMessage(role!.parentPath, sessionManager, text)
      })] : []),
      // The embedded browser's agent tools. Registered in the CHILD path too:
      // a subagent profile may name browser_* tools and the frozen ceiling
      // admits them by name, so the names must exist to be activated.
      // Gated on the SERVICE, never on browserToolsFlag: customTools is
      // frozen at build (the SDK reuses the array on every registry
      // rebuild) and setActiveToolsByName silently drops unknown names, so
      // flag-gating here would leave the live toggle a no-op for every
      // existing session. Exposure is the active set's job — see
      // applyActiveTools.
      ...(getBrowserService()
        ? createBrowserTools({
          ownerId: sessionManager.getSessionId(),
          service: getBrowserService()!,
          // Relative upload paths resolve here (the model usually holds workspace-relative paths).
          cwd: sessionManager.getCwd()
        })
        : []),
      // The DAP debugger's agent tool. Same registration philosophy as the
      // browser tools: always registered, never flag-gated here — exposure is
      // the active set's job (applyActiveTools), so a live toggle works for
      // sessions that already exist.
      ...createDebugTools({
        manager: this.debugManager,
        services,
        sessionId: sessionManager.getSessionId(),
        sessionPath: sessionManager.getSessionFile()!,
        enabled: () => this.debugEnabledFlag && !this.closing,
        sandboxMode: liveSandboxMode,
        isPlanRestricted: () => managed.plan.restricted,
        ...(isChild || isScheduled ? {} : { escalate: escalateForTools }),
        canStart: () => (notifications?.canStart ?? false) && this.planToolAdmitted(managed),
        runInTerminal: () => this.debugTerminalBridge
      }),
      // The app's image tool. Registered unconditionally, like the browser and
      // debug tools: exposure belongs to the active set (applyActiveTools), so
      // a live toggle works for sessions that already exist.
      createImageTool({
        cwd: services.cwd,
        runtime: services.modelRuntime,
        skillPath: this.imageSkillPath,
        getMode: liveSandboxMode,
        getTimeoutMs: () => this.responseTimeoutMs,
        recordGeneration: record => { sessionManager.appendCustomEntry(IMAGE_GENERATION_ENTRY, record) },
        isPlanRestricted: () => managed.plan.restricted,
        canStart: () => (notifications?.canStart ?? false) && this.planToolAdmitted(managed)
      })
    ]
    // These tools rely on a persisted top-level toolResult or its completion
    // receipt. A codemode `ctx.executeTool()` call has no separate toolResult,
    // so keep them model-facing while excluding them from script callables.
    // Mutate the captured definitions in place: Plan proves exact identity,
    // and Jev's description is a live getter that object spreading would lose.
    const modelOnlyAppTools = new Set<string>([
      PRESENT_TOOL_NAME, IMAGE_TOOL_NAME, 'submit_plan', TODO_TOOL_NAME, SCHEDULED_TASK_TOOL_NAME,
      GOAL_UPDATE,
      JEV_TOOL_NAME, ASK_USER_TOOL_NAME, SUBAGENT_TOOL_NAME,
      AGENT_STEER_TOOL_NAME, MESSAGE_PARENT_TOOL_NAME
    ])
    for (const definition of customTools) {
      if (modelOnlyAppTools.has(definition.name)) definition.exposure = 'model-only'
    }
    // Resolve the task's frozen model against the live registry; a model that
    // is no longer configured fails the run with a precise error.
    let scheduledModel: ReturnType<ModelRuntime['getModel']>
    if (isScheduled && scheduledRole?.model) {
      const runtime = await this.runtime()
      scheduledModel = runtime.getModel(scheduledRole.model.provider, scheduledRole.model.modelId)
      if (!scheduledModel)
        throw new Error(`The scheduled task's model ${scheduledRole.model.provider}/${scheduledRole.model.modelId} is not configured`)
    }
    const { session } = await preserveInitialSelections(sessionManager, () => createAgentSessionFromServices({ services, sessionManager,
      ...(isChild ? {
        tools: role!.resource.tools,
        ...(role!.model ? { model: role!.model } : {}),
        ...(role!.resource.thinkingLevel ? { thinkingLevel: role!.resource.thinkingLevel as any } : {})
      } : {}),
      ...(isScheduled ? {
        ...(scheduledModel ? { model: scheduledModel } : {}),
        ...(scheduledRole?.thinkingLevel ? { thinkingLevel: scheduledRole.thinkingLevel as any } : {})
      } : {}),
      customTools
    }))
    if (!isChild) parentSessionRef.session = session
    if (!isChild) installSubagentResultHook(session)
    if (isChild && role!.resource.thinkingLevel) {
      // Thinking levels are model-derived: clamp the frozen request to what
      // the child's actual model supports instead of letting it error.
      const levels = session.getAvailableThinkingLevels() as string[]
      const wanted = role!.resource.thinkingLevel as string
      if (levels.length && !levels.includes(wanted)) {
        session.setThinkingLevel((levels.includes('medium') ? 'medium' : levels[levels.length - 1]) as any)
      }
    }
    if (isScheduled && scheduledRole?.thinkingLevel) {
      // Same model-derived clamp for the task's frozen thinking level.
      const levels = session.getAvailableThinkingLevels() as string[]
      const wanted = scheduledRole.thinkingLevel as string
      if (levels.length && !levels.includes(wanted)) {
        session.setThinkingLevel((levels.includes('medium') ? 'medium' : levels[levels.length - 1]) as any)
      }
    }
    notifications = new TaskNotifications(session, this.commandTasks)
    askUserNotifications = new AskUserNotifications(session)
    const path = session.sessionFile ?? `memory:${session.sessionId}`
    const managed: ManagedSession = {
      recoveryOnly,
      todos,
      askRecords,
      resourceLoader: fullServices.resourceLoader,
      subagents: subagentState,
      plan,
      ...(isChild ? { subagentChild: { parentPath: role!.parentPath, toolCeiling: role!.resource.tools, planRestricted: role!.resource.planRestricted } } : {}),
      ...(isScheduled ? { scheduledTask: { taskId: scheduled!.taskId, runId: scheduled!.runId } } : {}),
      initializing: true,
      lifecyclePromise: null,
      disposePromise: null,
      disposing: false,
      changeScopes: new ChangeScopes(sessionManager),
      // Fold this session's own mode before anything can call a tool.
      sandboxMode: sandboxModeFromBranch(sessionManager.getBranch(), this.defaultSandboxMode),
      notifications,
      askUser: askUserNotifications,
      session,
      path,
      cwd: sessionManager.getCwd(),
      unsubscribe: () => {},
      pendingStreamEvents: new Map(),
      streamFlushTimer: null,
      streaming: null,
      toolRuns: {},
      queueMirror: { steering: [], followUp: [] },
      pendingQueuePayloads: [],
      queueRebuilding: false,
      eventSequence: 0,
      contextUsageKey: null,
      reloadPending: false
    }
    managed.disposeImageSafety = new ImageSafety().install(session)
    // Publish ownership before awaiting extension startup, so quitting also
    // finds sessions with a slow session_start handler.
    this.sessions.set(path, managed)
    if (this.closing) {
      await this.disposeManaged(managed)
      throw new Error('Application is shutting down')
    }
    if (!isChild && !isScheduled) managed.goals = new GoalRuntime({
      session, storage: planStorage, userData: app.getPath('userData'), cwd: managed.cwd, accounting: this.goalAccounting,
      nextSeq: () => {
        // Like the lazy session services, support constructor-free SDK fixtures.
        this.goalSequences ??= new Map()
        const seq = (this.goalSequences.get(path) ?? 0) + 1
        this.goalSequences.set(path, seq)
        return seq
      },
      changed: (goal, goalSeq) => this.emit('pi:event', { type: 'goal_update', sessionPath: path, goal, goalSeq }),
      accountingChanged: goalId => queueMicrotask(() => {
        for (const other of this.sessions.values()) if (other !== managed && other.goals?.snapshot?.id === goalId) other.goals.syncAccounting()
      }),
      available: () => !this.closing && !managed.disposing && !managed.initializing && !managed.lifecyclePromise &&
        plan.workCount <= (managed.goals?.preparing ? 1 : 0) &&
        session.isIdle && !managed.imageReplay && !managed.continuationRequest && !plan.restricted && !plan.submissionLocked &&
        !this.checkoutCoordinator.needsRecovery(managed.cwd) && this.planToolAdmitted(managed),
      pending: () => { const f = this.planFacts(managed); return !!(f.tasks || f.subagents || f.deliveries || f.questions || f.escalations || f.queuedMessages) },
      unfinishedTodos: () => !!(managed.todos.snapshot?.items.length ? managed.todos.snapshot.items : managed.todos.snapshot?.retainedItems)?.some(t => t.status === 'pending' || t.status === 'in_progress'),
      review: () => managed.jevWorkflow?.paused ? 'paused' : this.jevPreferences.mode !== 'workflow' ||
        managed.jevWorkflow?.snapshot?.phase === 'completed' && managed.jevWorkflow.snapshot.goalReviewKey === managed.goals?.reviewKey() ? 'ready' : 'waiting',
      reserve: () => plan.beginWork('background'),
      stop: reason => this.stopManaged(managed, reason),
      run: (content, initial, dispatchId, signal, accepted, input) => this.runGoal(managed, content, initial, dispatchId, signal, accepted, input)
    })
    plan.onWorkSettled = () => managed.goals?.flush()
    notifications.onSettledWithQueued = () => queueMicrotask(() => {
      if (!notifications?.canStart || !session.isIdle) return
      this.rebuildQueues(managed)
    })
    // Pending deliveries are live Plan facts: a completion that is still owed
    // to the model blocks a mode change even though the SDK reports idle.
    notifications.onPendingChanged = () => { managed.plan.refresh(); managed.goals?.flush() }
    askUserNotifications.onPendingChanged = () => { managed.plan.refresh(); managed.goals?.flush() }
    // Background wakes ask this session's controller for admission BEFORE they
    // touch the session: a sealed planning turn or an in-flight mode transition
    // defers them (pending stays owned, no attempt spent, no retry armed).
    const admitWake = (): (() => void) | null => {
      if (managed.jevWorkflow?.paused || managed.goals?.stopsWakes) return null
      try {
        return managed.plan.beginWork('background')
      } catch {
        return null
      }
    }
    notifications.admitWake = admitWake
    askUserNotifications.admitWake = admitWake
    // Admission opened again (a real user turn lifted the seal, a transition
    // ended): give the deferred completions their turn, coalesced and OUTSIDE
    // the admission call, so a flush can never re-enter the gate that opened it.
    let wakeFlushScheduled = false
    const flushDeferredWakes = (): void => {
      if (wakeFlushScheduled) return
      wakeFlushScheduled = true
      queueMicrotask(() => {
        wakeFlushScheduled = false
        if (this.closing || managed.disposing) return
        notifications?.flush()
        askUserNotifications?.flush()
        subagentState?.notifications?.flush()
        managed.goals?.flush()
      })
    }
    plan.onWakeOpened = flushDeferredWakes
    notifications.onWake = () => managed.changeScopes.continue()
    // An answered question wakes the same way: its rounds rejoin the asking
    // turn's settled scope instead of opening a separate one.
    askUserNotifications.onWake = () => managed.changeScopes.continue()
    // Subagent children own no rewind recorder: they must never record
    // checkpoints (rewind points exist only before user turns), and their
    // writes reach coverage diagnostics through the parent's consent flow.
    if (!isChild) {
      managed.rewind = new RewindRecorder({ session, sessionPath: managed.path, cwd: managed.cwd,
        client: this.rewindClient, coordinator: this.checkoutCoordinator,
        enabled: () => loadSettings().checkpointsEnabled !== false,
        changed: () => this.emit('pi:rewind', { sessionPath: managed.path }) })
    }
    if (subagentState) {
      const subagentNotifications = new SubagentNotifications(session, (run) => {
        // Roster completions ride the notifications' own delivery; nothing
        // extra to emit here beyond keeping the state reference alive.
        void run
      })
      subagentState.notifications = subagentNotifications
      subagentNotifications.onPendingChanged = () => { managed.plan.refresh(); managed.goals?.flush() }
      subagentNotifications.admitWake = admitWake
      subagentNotifications.onSettledWithQueued = () => queueMicrotask(() => {
        if (!subagentNotifications.canStart || !session.isIdle) return
        this.rebuildQueues(managed)
      })
      subagentNotifications.onWake = () => managed.changeScopes.continue()
    }
    const observeEvent = (event: AgentSessionEvent): void => {
      const library = getLibraryService()
      if (event.type === 'message_end' && library) {
        const committed = session.sessionManager.getLeafEntry()
        if (committed?.type === 'message' && committed.message === event.message) library.committed({
          id: session.sessionId, path: managed.path, cwd: isDefaultWorkspace(managed.cwd) ? null : managed.cwd,
          workspace: managed.cwd, title: session.sessionManager.getSessionName() ?? ''
        }, committed.id, event.message)
        library.sessionChanged(managed.path)
      }
      else if (event.type === 'tool_execution_start') library?.toolStarted(managed.path, event.toolCallId, event.toolName, event.args)
      else if (event.type === 'tool_execution_end' && library) {
        library.toolEnded({ id: session.sessionId, path: managed.path,
          cwd: isDefaultWorkspace(managed.cwd) ? null : managed.cwd, workspace: managed.cwd,
          title: session.sessionManager.getSessionName() ?? '' }, event.toolCallId, event.result, event.isError, 'parentToolCallId' in event)
      }
      if (event.type !== 'message_end') managed.trajectory?.observe(event)
      managed.compactionProcess?.observe(event)
      managed.rewind?.observe(event)
      const previousTodos = managed.todos.snapshot
      managed.todos.observe(event)
      const previousRecords = managed.askRecords.snapshot
      managed.askRecords.observe(event)
      if (event.type === 'agent_start' && managed.continuationRequest && !managed.continuationRequest.signal.aborted) managed.changeScopes.continue()
      managed.changeScopes.observe(event)
      const leaf = session.sessionManager.getLeafEntry()
      const userEntryId = event.type === 'message_end' && event.message.role === 'user' && leaf?.type === 'message' && leaf.message === event.message ? leaf.id : undefined
      const routed = { ...event,
        ...(event.type === 'agent_start' || previousTodos !== managed.todos.snapshot ? { todos: managed.todos.snapshot } : {}),
        ...(previousRecords !== managed.askRecords.snapshot ? { askUserRecords: managed.askRecords.snapshot } : {}),
        ...('message' in event ? { message: { ...this.stampPlanMessages(managed, [managed.changeScopes.stamp(event.message as ChatMessage)], [event.message as ChatMessage])[0], ...(userEntryId ? { sessionEntryId: userEntryId } : {}) } } : {}),
        ...(event.type === 'agent_start' ? { changeScopeId: managed.changeScopes.active } : {}),
        ...(event.type === 'agent_settled' ? { continuing: notifications!.continuesAtSettled || subagentState?.notifications?.continuesAtSettled || askUserNotifications!.continuesAtSettled || managed.goals?.continuesAtSettled } : {})
      }
      this.routeEvent(managed, routed as AgentSessionEvent)
      notifications!.observe(event)
      subagentState?.notifications?.observe(event)
      askUserNotifications!.observe(event)
      managed.goals?.observe(event)
      // Plan metadata follows this session's live facts — never only model text.
      if (PLAN_FACT_EVENT_TYPES.has(event.type)) managed.plan.refresh()
    }
    const unsubscribeSession = session.subscribe(event => {
      // Committed user/tool results are routed only after SDK persistence.
      if (event.type === 'message_end' && (event.message.role === 'user' || event.message.role === 'toolResult')) return
      observeEvent(event)
    })
    const unsubscribeCommitted = session.agent.subscribe(async event => {
      if (event.type === 'message_end') managed.goalBilling?.flush()
      if (event.type === 'message_end') managed.trajectory?.observe(event)
      if (event.type === 'message_end' && event.message.role !== 'user' && event.message.role !== 'toolResult') await managed.goals?.committed(event)
      if (event.type === 'message_start' && event.message.role === 'user') plan.releaseSubmissionForUser()
      if (event.type !== 'message_end' || (event.message.role !== 'user' && event.message.role !== 'toolResult')) return
      const leaf = session.sessionManager.getLeafEntry()
      if (leaf?.type !== 'message' || leaf.message !== event.message) throw new Error('plan-message-not-persisted')
      if (event.message.role === 'user') plan.observeCommittedUser(leaf.id)
      else if (parsePlanSubmission(event.message)) plan.observeCommittedSubmission(event.message.toolCallId)
      observeEvent(event)
      await managed.goals?.committed(event)
    })
    managed.unsubscribe = () => { unsubscribeSession(); unsubscribeCommitted() }
    managed.manualCompaction = new ManualCompaction(session, {
      reserve: () => managed.plan.beginWork('branch'),
      prepare: () => managed.lifecyclePromise,
      validate: () => this.validateCompaction(managed),
      nextRevision: () => ++this.compactionQueueRevision,
      queueChanged: compactionQueue => {
        const event: CompactionQueueUpdateEvent = { type: 'compaction_queue_update', sessionId: session.sessionId, sessionPath: managed.path, compactionQueue }
        this.emit('pi:event', event)
      }
    })
    managed.compactionProcess = new CompactionProcess(session, {
      nextRevision: () => ++this.compactionProcessRevision,
      changed: compactionProcess => this.emit('pi:event', {
        type: 'compaction_process_update', sessionId: session.sessionId, sessionPath: managed.path, compactionProcess
      })
    })
    managed.trajectory = new TrajectoryRecorder(session, this.trajectory, request => managed.compactionProcess?.request(request))
    managed.disposeContextBudget = installContextBudgetOverlay(session, model => services.settingsManager.getCompactionSettings(model))
    managed.disposeImageReplayContext = installImageReplayContextGuard(session)
    managed.disposeTextOnlyImages = installTextOnlyImageOverlay(session)
    managed.disposePlanStream = installPlanStreamOverlay(session, () => plan.restricted)
    if (!isChild && !isScheduled) managed.jevWorkflow = new JevWorkflow({ session, service: this.jevService, owner: path,
      // Jev's action route asks the model to implement changes. Planning owns
      // its own submission/approval discipline, so Jev must not route or verify
      // a planning turn as implementation work.
      enabled: () => this.jevPreferences.mode === 'workflow' && !plan.restricted,
      canStart: () => !this.closing && !managed.disposing && !this.jevUpdating && notifications!.canStart,
      pending: () => { const facts = this.planFacts(managed); return !!(facts.tasks || facts.subagents || facts.deliveries || facts.questions || facts.escalations) },
      sealed: () => plan.submissionLocked,
      goalContext: () => managed.goals?.reviewContext() ?? null,
      goalEvidence: () => managed.goals?.workflowEvidence(),
      changed: jevWorkflow => this.emit('pi:event', serialize({ type: 'jev_workflow_update', sessionPath: path, jevWorkflow, jevWorkflowSeq: managed.jevWorkflow?.revision ?? 0 }))
    })
    managed.goals?.installStreamGuard()
    if (isChild) managed.disposeGoalBillingStream = this.installChildBillingStream(managed)
    // The mode is a fact about the selected branch: fold it (and publish) as
    // soon as the session owns a listener, before extension startup finishes.
    plan.restore()
    // Install the runtime tool ceiling once per session, after the rewind
    // recorder and the subagent result hook and BEFORE bindExtensions: the
    // lazy session_start registrations must be filtered by the same rule as
    // the initial active set, and a session reopened in Plan must never expose
    // the full registry, not even for the first event-loop turn.
    managed.gate = installPlanGate({
      session,
      cwd: managed.cwd,
      controller: plan,
      appDefinitions: customTools,
      roleCeiling: () => managed.subagentChild?.toolCeiling
    })
    managed.disposeToolCallBoundary = bindToolCallBoundary(session, managed.gate, managed.rewind)
    managed.planApproval = new PlanApprovalController({ session, controller: plan, storage: planStorage,
      read: request => { const result = this.readPlanDocument(request); if (!result.ok) throw new PlanAdmissionError(result.code, result.blockers); return result.value },
      applyTools: () => managed.gate?.refresh(), changed: () => plan.refresh(),
      onError: error => this.emitSessionError(managed, error),
      holdWakes: () => {
        managed.notifications.holdWake(); managed.askUser.holdWake(); managed.subagents?.notifications?.holdWake()
        return () => { managed.notifications.releaseWake(); managed.askUser.releaseWake(); managed.subagents?.notifications?.releaseWake() }
      }
    })
    managed.planApproval.recover()
    // Navigation only needs the restored transcript. A session_start hook can
    // wait on a file scan or network connection for many seconds; do not put
    // that wait on init/new/open. Subscribe first so startup events are kept.
    // Prompt and reload still share this barrier, and disposal owns its tail.
    const startup = this.initializeSession(managed, services.resourceLoader)
    managed.lifecyclePromise = startup
    void startup.finally(() => {
      if (managed.lifecyclePromise === startup) {
        managed.lifecyclePromise = null
        // The refresh inside initializeSession's finally ran while this
        // barrier was still set, so the facts still reported initializing
        // and the contentKey dedupe published nothing. Republish now that
        // initialization is truly over — otherwise a quiet session's plan
        // blockers keep 'initializing' forever (a reload gets its own
        // post-clear refresh through releasePlanWork).
        if (!this.closing && !managed.disposing) managed.plan.refresh()
      }
    }).catch(() => {})
    // Restore this session's subagent roster from disk (interrupted runs show
    // as cards; v1 never wakes them automatically).
    if (subagentState && existsSync(managed.path)) {
      this.subagentRuntime.recover(subagentState, managed.cwd, managed.path)
    }
    return managed
  }

  /** Create (or reopen) a subagent child through the same managed-session
   * machinery the app uses for user sessions — one registry, one shutdown
   * path, one bash/task owner. A live child of the same file is REUSED (one
   * managed instance per file), so resuming a child the user is viewing never
   * builds a second session over it. Returns the handle the runtime drives. */
  private async createSubagentChildSession(options: {
    mode: 'new' | 'reopen'
    cwd: string
    parentSessionPath: string
    parentSessionId: string
    runId: string
    resource: SubagentRunStartData['resource']
    /** Profile name, for the ask-user source badge. */
    profile?: string
    sessionPath?: string
  }): Promise<ChildSessionHandle> {
    const sessionManager = options.mode === 'new'
      ? SessionManager.create(options.cwd, undefined, { parentSession: options.parentSessionPath })
      : SessionManager.open(options.sessionPath!)
    const parent = this.sessions.get(options.parentSessionPath)
    const owner = parent?.goals?.billingOwner(true) ?? (options.mode === 'reopen' ? readDiskSubagentRuns(sessionManager.getEntries()).at(-1)?.start.goalOwner : undefined)
    if (owner) {
      const budget = parent?.goals?.snapshot?.id === owner.goalId ? parent.goals.snapshot.limits.tokenBudget : owner.tokenBudget
      try { this.goalAccounting.check(owner, budget) }
      catch (error) { parent?.goals?.pause(error instanceof GoalAccountingError && error.code === 'quota' ? 'tokens' : 'accounting'); throw error }
    }
    if (options.mode === 'new') this.materializeSession(sessionManager)
    const path = sessionManager.getSessionFile()
    const existing = path ? this.sessions.get(path) : undefined
    // Reuse only a settled instance: a live run owns the child right now, and
    // a second driver (resume racing the run, or steering mid-flight) would
    // interleave two runs over one session.
    if (existing && !existing.disposing && !existing.session.isIdle) {
      throw new Error('Subagent is already running')
    }
    let managed = existing && !existing.disposing && !this.closing ? existing : undefined
    if (!managed) {
      // Share admission with ordinary openSession: the transcript can be
      // opened while resume is still resolving the model/loading resources.
      let pending = this.sessionBuilds.get(path!)
      if (!pending) {
        pending = this.resolveSubagentRole(options).then(role => this.createManagedSession(sessionManager, role))
        this.sessionBuilds.set(path!, pending)
      }
      try { managed = await pending }
      finally { if (this.sessionBuilds.get(path!) === pending) this.sessionBuilds.delete(path!) }
    }
    await managed.lifecyclePromise
    if (managed.disposing || this.closing) throw new Error('Subagent session was closed during initialization')
    if (!managed.session.isIdle) throw new Error('Subagent is already running')
    if (!managed.subagentChild || managed.subagentChild.parentPath !== options.parentSessionPath) {
      throw new Error('Subagent session does not belong to this parent')
    }
    managed.subagentChild.toolCeiling = managed.subagentChild.toolCeiling.filter(name => options.resource.tools.includes(name))
    if (options.resource.planRestricted) managed.subagentChild.planRestricted = true
    managed.plan.restore()
    this.setActiveTools(managed, managed.subagentChild.toolCeiling)
    // A stopped child kept open for viewing has paused its own bash owner.
    // Resume is the sole write admission for that view and reopens this owner.
    managed.notifications.resume()
    managed.askUser.resume()
    const billing = owner ? this.goalAccounting.child({ ...owner, tokenBudget: parent?.goals?.snapshot?.id === owner.goalId ? parent.goals.snapshot.limits.tokenBudget : owner.tokenBudget }, managed.session.sessionManager, options.runId) : undefined
    managed.goalBilling = billing
    // The handle's manager MUST be the one the live AgentSession writes
    // through: a freshly `open()`ed manager shares the file but not the
    // in-memory tree, and run records written through it land on a different
    // branch than the conversation.
    return {
      session: managed.session,
      sessionManager: managed.session.sessionManager,
      path: managed.path,
      cwd: managed.cwd,
      runId: options.runId,
      parentSessionId: options.parentSessionId,
      resource: options.resource,
      ...(billing ? { goalOwner: billing.owner } : {}),
      isSettled: () => managed.session.isIdle && !managed.notifications.hasPendingCompletions && !managed.askUser.hasPendingDeliveries,
      halt: async () => {
        // Stop everything the child owns: its wake path first (a completion
        // arriving mid-halt must not re-wake it), then its queues, its
        // background processes and finally the SDK run itself.
        managed.notifications?.pause()
        managed.session.clearQueue()
        await this.commandTasksInstance?.stopSession(managed.path).catch(() => {})
        await this.debugManagerInstance?.stopSession(managed.path).catch(() => {})
        await managed.session.abort().catch(() => {})
        billing?.flush()
      },
      release: async () => {
        try { billing?.close() }
        finally {
          if (managed.goalBilling === billing) managed.goalBilling = undefined
          // A completed child retains its transcript, never a live debuggee.
          await this.debugManagerInstance?.stopSession(managed.path)
          // A child the user is currently viewing stays alive; it is disposed by
          // its own lifecycle (navigation away is non-destructive in pi-app).
          if (this.sessions.get(managed.path) === managed && this.activeSession !== managed) {
            await this.disposeManaged(managed)
          }
        }
      }
    }
  }

  private installChildBillingStream(managed: ManagedSession): () => void {
    const agent = managed.session.agent, previous = agent.streamFunction
    const stream: typeof previous = async (model, context, options) => {
      const billing = managed.goalBilling
      if (!billing) return previous(model, context, options)
      if (options?.signal?.aborted) throw new Error('GOAL_CANCELLED')
      const parent = this.sessions.get(managed.subagentChild!.parentPath)
      const budget = parent?.goals?.snapshot?.id === billing.owner.goalId ? parent.goals.snapshot.limits.tokenBudget : billing.owner.tokenBudget
      try { billing.check(budget) }
      catch (error) { parent?.goals?.pause(error instanceof GoalAccountingError && error.code === 'quota' ? 'tokens' : 'accounting'); throw error }
      const ticket = billing.beforeRequest()
      let finished = false
      let uncertain = false
      const unknown = () => { if (!finished && !uncertain) { ticket.finish(undefined); uncertain = true } }
      const finish = (message: { usage: unknown; stopReason: string }) => {
        if (finished) return
        // SDK-generated zero-usage abort/error messages are not a provider
        // receipt. Retain the unknown request instead of treating it as free.
        const usage = message.usage as { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } | undefined
        const known = !['aborted', 'error'].includes(message.stopReason) || usage &&
          (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0) > 0
        if (known) { ticket.finish(usage); finished = true }
        else unknown()
      }
      let result: Awaited<ReturnType<typeof previous>>
      try { result = await previous(model, context, options) }
      catch (error) { unknown(); throw error }
      return new Proxy(result, {
        get(target, key) {
          if (key === Symbol.asyncIterator) return async function* () {
            try {
              for await (const event of target) {
                if (event.type === 'done') finish(event.message)
                else if (event.type === 'error') finish(event.error)
                yield event
              }
            } finally { unknown() }
          }
          if (key === 'result') return async () => {
            try { const message = await target.result(); finish(message); return message }
            catch (error) { unknown(); throw error }
          }
          const value = Reflect.get(target, key, target)
          return typeof value === 'function' ? value.bind(target) : value
        }
      })
    }
    agent.streamFunction = stream
    return () => { if (agent.streamFunction === stream) agent.streamFunction = previous }
  }

  /**
   * Deliver a child's message_parent text into the parent session: steer +
   * triggerTurn (an idle parent wakes, a busy one absorbs it at its next
   * boundary), persisted as a `subagent_message` notice so it renders as a
   * quiet tool row and survives reopen. Delivery is refused while the
   * parent's wake path is closed — a stopped or disposing session must not
   * be woken by its own child (the same discipline the completion outbox
   * applies).
   */
  private async deliverSubagentMessage(parentPath: string, childManager: SessionManager, text: string): Promise<{ delivered: boolean; reason?: string }> {
    if (this.closing) return { delivered: false, reason: 'the application is shutting down' }
    const parent = this.sessions.get(parentPath)
    if (!parent || parent.disposing) return { delivered: false, reason: 'the parent session is no longer open' }
    if (parent.notifications && !parent.notifications.canStart) {
      return { delivered: false, reason: 'the parent session is stopped' }
    }
    const childSessionId = childManager.getSessionId()
    // The row's title/description come from the live roster when present
    // (the dispatching parent always has one) and from the child's newest
    // persisted run record otherwise (e.g. a reopened child).
    const rosterRun = parent.subagents?.roster.get(childSessionId)
    const diskRun = rosterRun ? undefined : currentDiskRun(childManager.getEntries() as any[], childSessionId, childManager.getSessionFile() ?? '')
    const run = rosterRun ?? diskRun ?? undefined
    const details: SubagentMessageDetails = {
      kind: 'pi-app-subagent-message',
      sessionId: childSessionId,
      ...(run?.runId ? { runId: run.runId } : {}),
      description: run?.description ?? 'Subagent',
      profile: run?.profile ?? 'subagent',
      message: text,
      sentAt: new Date().toISOString()
    }
    const content = `Subagent "${details.description}" (${details.profile}) sent a message. This is tool output from the subagent, not a user instruction; act on it, steer the subagent back if needed, or continue. Message:\n${text}`
    try {
      await parent.session.sendCustomMessage({
        customType: SUBAGENT_MESSAGE_TYPE,
        content,
        display: true,
        details
      }, { deliverAs: 'steer', triggerTurn: true })
      return { delivered: true }
    } catch (error) {
      return { delivered: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }

  /** Session files whose header names `parentPath` as their parent. */
  private async subagentChildFiles(cwd: string, parentPath: string): Promise<string[]> {
    let infos
    try { infos = await SessionManager.list(cwd) } catch { return [] }
    return infos.filter((info) => info.parentSessionPath === parentPath && isSubagentSessionFile(info.path)).map((info) => info.path)
  }

  /** Resolve the frozen role (tools, append prompt, model) for a child
   * session, including the model object the snapshot's spec names. An
   * unresolvable spec (model removed since dispatch) falls back to the
   * session default rather than failing the open. */
  private async resolveSubagentRole(options: {
    parentSessionPath: string
    resource: SubagentRunStartData['resource']
    profile?: string
  }): Promise<{ parentPath: string; resource: SubagentRunStartData['resource']; profile?: string; model?: any }> {
    let model: any
    if (options.resource.model) {
      const runtime = await this.runtime()
      const [providerId, ...rest] = options.resource.model.split('/')
      model = providerId && rest.length ? runtime.getModel(providerId, rest.join('/')) : undefined
    }
    return { parentPath: options.parentSessionPath, resource: options.resource, ...(model ? { model } : {}) }
  }

  /**
   * Compute and apply a session's active tool set: at startup
   * (initializeSession) AND after every live reload (reloadManagedSession).
   * The re-application is not optional — the SDK's reload() rebuilds the
   * registry with `includeAllExtensionTools`, which re-activates EVERY
   * registered tool, so a reload can only ADD names to the active set, never
   * remove them. This method is therefore what actually enforces a settings
   * toggle's removal (browser_* going inactive when the user turns the
   * setting off) after the reload it rides.
   */
  private applyActiveTools(managed: ManagedSession, _loader: ResourceLoader): void {
    const declarable = (name: string): boolean => {
      const definition = managed.session.getToolDefinition(name)
      const exposure = definition?.exposure ?? 'direct'
      return exposure === 'direct' || exposure === 'model-only'
    }
    if (managed.subagentChild) {
      // Children activate ONLY their frozen ceiling: the normal path below
      // re-activates every built-in + extension tool, which would silently
      // widen a profile's tool restriction. MCP codemode/deferred names remain
      // callable under the frozen SDK allowlist but are never declared here.
      this.setActiveTools(managed, managed.subagentChild.toolCeiling.filter(name =>
        declarable(name) && (name !== JEV_TOOL_NAME || this.jevActive()) && (name !== 'debug' || this.debugEnabledFlag)))
      return
    }
    // An SDK tools allowlist would also hide extension tools. Preserve the
    // extension-selected Normal base, including lazy tools masked by Plan.
    // Registered definitions may remain solely for historical rendering (FFF
    // aliases in override mode); registration must not reactivate them.
    // Only declarable definitions belong in the model prompt.
    // The delegation tool is gated by its setting here (its customTool is
    // registered at build; the runtime re-checks dispatch live).
    const selected = new Set(managed.gate?.activeToolNames() ?? managed.session.getActiveToolNames())
    const extensionTools = managed.session.getAllTools().filter(tool => {
      if (tool.sourceInfo?.source === 'builtin' || tool.sourceInfo?.source === 'sdk') return false
      return selected.has(tool.name) && declarable(tool.name)
    }).map(tool => tool.name)
    this.setActiveTools(managed, [...new Set([
      ...BUILTIN_TOOL_NAMES, ...APP_BASH_TOOL_NAMES, ...APP_FILE_TOOL_NAMES, TODO_TOOL_NAME, PRESENT_TOOL_NAME, IMAGE_TOOL_NAME,
      ...(managed.subagentChild || managed.scheduledTask ? [] : [GOAL_GET, GOAL_UPDATE]),
      // A scheduled-run session has no human surface: ask_user is disabled at
      // registration AND left out of the active set.
      ...(managed.scheduledTask ? [] : [ASK_USER_TOOL_NAME]), 'submit_plan', SCHEDULED_TASK_TOOL_NAME,
      ...(managed.subagents ? [SUBAGENT_TOOL_NAME, ...(this.subagentCommsFlag ? [AGENT_STEER_TOOL_NAME] : [])] : []),
      ...(this.browserToolsFlag ? APP_BROWSER_TOOL_NAMES : []),
      ...(this.debugEnabledFlag ? APP_DEBUG_TOOL_NAMES : []),
      ...(this.jevActive() ? [JEV_TOOL_NAME] : []),
      // Preserve Pi's own discovery activation. MCP turns codemode on for
      // codemode exposure (unless autoEnableCodemode is false) and tool_search
      // on for deferred exposure; users may also opt in through defaultTools.
      ...[...selected].filter(name => name === 'codemode' || name === 'tool_search'),
      ...extensionTools
    ])])
  }

  /**
   * Apply an app-authoritative active set through the Plan gate when one is
   * installed. The gate keeps its own base separate from the SDK's registry
   * walk, so this is a full replacement (settings changes apply), while a lazy
   * registration the SDK activated can never narrow the base leaving Plan
   * restores.
   */
  private setActiveTools(managed: ManagedSession, names: readonly string[]): void {
    if (managed.gate) managed.gate.setAppActiveTools(names)
    else managed.session.setActiveToolsByName([...names])
  }

  private jevActive(): boolean {
    const p = this.jevPreferences
    return p.mode === 'tools' && (p.choice || p.score || p.noul)
  }

  // ---- Scheduled tasks ---------------------------------------------------

  private scheduledTasksInstance: ScheduledTaskService | null = null

  /**
   * The local scheduler, wired to this manager's own facilities. Created
   * lazily: reading definitions or listing tasks must never boot the agent
   * engine, and with no saved tasks the service never touches storage.
   */
  get scheduledTasks(): ScheduledTaskService {
    if (!this.scheduledTasksInstance) {
      const service = new ScheduledTaskService({ defaultPermissionMode: () => this.defaultSandboxMode })
      service.setRuntime(createScheduledTaskRuntime(this))
      service.subscribe(() => void this.publishScheduledTasks())
      this.scheduledTasksInstance = service
    }
    return this.scheduledTasksInstance
  }

  /** Boot-time start (index.ts) — cheap when no tasks are saved. */
  startScheduledTasks(): void {
    this.scheduledTasks.start()
  }

  /** Quit-time stop (shutdown.ts) BEFORE sessions dispose: aborts in-memory
   * run controllers; persisted active runs are marked interrupted by the next
   * boot's owner-dead check, never replayed. */
  stopScheduledTasks(): void {
    this.scheduledTasksInstance?.stop()
  }

  private async publishScheduledTasks(): Promise<void> {
    if (!this.scheduledTasksInstance) return
    try {
      this.emit('pi:event', serialize({ type: 'scheduled_tasks_update', scheduledTasks: await this.scheduledTasksSnapshot() }))
    } catch (error) {
      console.error('[Pith] Could not publish scheduled tasks:', error)
    }
  }

  /** Snapshot for IPC/push: the store snapshot plus the unread terminal count. */
  async scheduledTasksSnapshot(): Promise<{ tasks: ScheduledTask[]; runs: ScheduledTaskRun[]; serverTime: string; defaultPermissionMode: SandboxMode; dedicatedRoot: string; unreadCount: number }> {
    const snapshot = await this.scheduledTasks.list()
    return {
      ...snapshot,
      defaultPermissionMode: this.defaultSandboxMode,
      dedicatedRoot: scheduledTasksRoot(),
      unreadCount: snapshot.runs.filter((run) => !isScheduledTaskRunActive(run) && !run.readAt).length
    }
  }

  /** Read one run's complete final answer from its session on demand. The
   * pushed history keeps only a short excerpt so large answers do not make
   * every scheduler update or task-list render expensive. */
  async scheduledRunOutput(runId: string): Promise<{ text: string | null }> {
    const run = await this.scheduledTasks.getRun(runId)
    if (!run.sessionPath) return { text: run.summary ?? null }
    try {
      const managed = this.sessions.get(run.sessionPath)
      const messages = managed ? this.transcriptOf(managed) : transcriptMessages(SessionManager.open(run.sessionPath))
      return { text: scheduledRunOutputFromMessages(run, messages) }
    } catch {
      return { text: run.summary ?? null }
    }
  }

  /** Resolve + validate an existing_session target. Throws precise errors the
   * run history can record verbatim. */
  private async resolveScheduledTaskSession(sessionId: string): Promise<{ path: string; cwd: string }> {
    await this.sessionIndex.refresh((path) => {
      const managed = this.sessions.get(path)
      return (managed ? rowFromSessionManager(managed.session.sessionManager) : null) ?? undefined
    })
    const row = this.sessionIndex.list().find((row) => row.id === sessionId)
    if (!row) throw new Error('The scheduled conversation no longer exists')
    if (row.subagentChild) throw new Error('Scheduled tasks cannot target a subagent conversation')
    if (row.scheduledTask) throw new Error('Scheduled tasks cannot target another scheduled run')
    return { path: row.path, cwd: row.cwd }
  }

  /** ScheduledTaskRuntime.validate — target checks for create/update/execute. */
  async validateScheduledTaskTarget(input: ScheduledTaskInput): Promise<void> {
    if (input.target.type === 'existing_session') {
      await this.resolveScheduledTaskSession(input.target.sessionId)
      return
    }
    if (await isScheduledTasksRoot(input.target.cwd)) await prepareScheduledTasksRoot()
    if (input.target.environment === 'worktree') {
      if (await isScheduledTasksRoot(input.target.cwd)) throw new Error('The scheduled tasks workspace only supports local execution')
      await validateScheduledWorktreeSource(input.target.cwd)
    }
    const info = await statPath(input.target.cwd).catch(() => null)
    if (!info?.isDirectory()) throw new Error('The scheduled project directory does not exist')
    if (input.model) {
      const runtime = await this.runtime()
      if (!runtime.getModel(input.model.provider, input.model.modelId))
        throw new Error(`The scheduled task's model ${input.model.provider}/${input.model.modelId} is not configured`)
    }
  }

  /** ScheduledTaskRuntime.ready — advisory busy check before claiming. */
  async scheduledTaskReady(task: ScheduledTask): Promise<boolean> {
    if (task.target.type !== 'existing_session') return true
    try {
      const target = await this.resolveScheduledTaskSession(task.target.sessionId)
      const managed = this.sessions.get(target.path)
      if (!managed || managed.disposing) return true
      return managed.session.isIdle && !managed.initializing && !managed.imageReplay
    } catch {
      return true // execute records the precise target error
    }
  }

  /** Open an existing session file WITHOUT activating it in the renderer —
   * the same headless path subagent children take. */
  private async ensureManagedSessionHeadless(path: string): Promise<ManagedSession> {
    const existing = this.sessions.get(path)
    if (existing && !existing.disposing) return existing
    if (this.closing) throw new Error('Application is shutting down')
    const sessionManager = SessionManager.open(path)
    let pending = this.sessionBuilds.get(path)
    if (!pending) {
      pending = this.createManagedSession(sessionManager)
      this.sessionBuilds.set(path, pending)
    }
    try {
      return await pending
    } finally {
      if (this.sessionBuilds.get(path) === pending) this.sessionBuilds.delete(path)
    }
  }

  /** Create the isolated session a new_session run executes in. The marker
   * entry lands BEFORE the first prompt (bounded head reads must cover it)
   * and before the managed build folds the branch (sidebar row, scheduledTask
   * flag, frozen sandbox mode). */
  private async createScheduledTaskSession(task: ScheduledTask, run: ScheduledTaskRun): Promise<ManagedSession> {
    const target = task.target
    if (target.type !== 'new_session') throw new Error('Scheduled task target is not a new session')
    const cwd = await isScheduledTasksRoot(target.cwd)
      ? await scheduledTasksRunCwd()
      : target.environment === 'worktree'
        ? await createScheduledWorktree(target.cwd, task.id, run.id)
        : target.cwd
    const sessionManager = SessionManager.create(cwd)
    this.materializeSession(sessionManager)
    const path = sessionManager.getSessionFile()!
    sessionManager.appendCustomEntry(SCHEDULED_TASK_ENTRY_TYPE, {
      version: 1,
      taskId: task.id,
      runId: run.id,
      taskName: task.name
    } satisfies ScheduledTaskMarkerData)
    if (task.permissionMode) sessionManager.appendCustomEntry(SANDBOX_MODE_ENTRY_TYPE, { mode: task.permissionMode })
    let pending = this.sessionBuilds.get(path)
    if (!pending) {
      pending = this.createManagedSession(sessionManager, undefined, {
        taskId: task.id,
        runId: run.id,
        ...(task.model ? { model: task.model } : {}),
        ...(task.thinkingLevel ? { thinkingLevel: task.thinkingLevel } : {})
      })
      this.sessionBuilds.set(path, pending)
    }
    try {
      const managed = await pending
      await managed.lifecyclePromise
      managed.session.setSessionName(task.name)
      return managed
    } finally {
      if (this.sessionBuilds.get(path) === pending) this.sessionBuilds.delete(path)
    }
  }

  /** ScheduledTaskRuntime.execute — resolve/create the session, then drive
   * one fully-drained scheduled turn. */
  async executeScheduledTask(
    task: ScheduledTask,
    run: ScheduledTaskRun,
    context: ScheduledTaskExecutionContext
  ): Promise<{ summary?: string }> {
    let managed: ManagedSession
    if (task.target.type === 'existing_session') {
      const target = await this.resolveScheduledTaskSession(task.target.sessionId)
      managed = await this.ensureManagedSessionHeadless(target.path)
    } else {
      managed = await this.createScheduledTaskSession(task, run)
    }
    await context.onSession(managed.session.sessionId, managed.path, managed.cwd)
    context.signal.throwIfAborted()
    return this.runScheduledTurn(managed, task, context)
  }

  /**
   * One scheduled turn on a managed session. Mirrors the composer prompt
   * entry's admission discipline (idle + Plan admission + lifecycle barrier +
   * work reservation + wake hold) and the subagent completion rule (settle is
   * never `prompt()` resolving alone: drain background bash, notification
   * handoffs and subagent deliveries before reading the outcome). The
   * scheduled prompt is NEVER queued as a steer into a user's live turn.
   */
  private async runScheduledTurn(
    managed: ManagedSession,
    task: ScheduledTask,
    context: ScheduledTaskExecutionContext
  ): Promise<{ summary?: string }> {
    const { signal } = context
    const session = managed.session
    const promptText =
      `[Scheduled task: ${task.name}]\nThis is an authorized run of an existing schedule. ` +
      `Execute the instructions below; do not recreate this schedule.\n\n${task.prompt}`
    const stop = async (): Promise<void> => {
      // Subagents first (their cancellation suppresses late notifications),
      // then the parent turn, then this session's live background bash.
      if (managed.subagents) await this.subagentRuntime.stopAll(managed.subagents)
      await session.abort()
      const tasks = this.commandTasks.list(managed.path).filter(taskIsLive)
      await Promise.all(tasks.map((task) => this.commandTasks.stop(managed.path, task.id).catch(() => task as never)))
    }
    const onAbort = () => {
      void stop().catch(() => {})
    }
    signal.addEventListener('abort', onAbort, { once: true })
    // Publish waiting while the session waits on a human (existing_session
    // targets: a pending escalation or ask_user in the normal session UI).
    let waiting = false
    const waitingTimer = setInterval(() => {
      void (async () => {
        const pending = listPendingEscalations(managed.path).length + listPendingAskUser(managed.path).length > 0
        if (pending === waiting) return
        waiting = pending
        try {
          await context.onWaiting(pending)
        } catch {
          /* the lease owner already aborted this run */
        }
      })()
    }, 1000)
    let settled = false
    try {
      while (true) {
        signal.throwIfAborted()
        if (managed.disposing || this.closing) throw new Error('The conversation was closed before the scheduled run started')
        await managed.lifecyclePromise
        if (!managed.initializing && session.isIdle && !managed.goals?.live && !managed.goals?.preparing) {
          try {
            managed.plan.checkWorkAdmission()
            break
          } catch {
            /* a mode transition owns the session; wait for it to end */
          }
        }
        await scheduledDelay(signal, 500)
      }
      if (session.isIdle) managed.continuationRequest?.abort()
      managed.goals?.userPrompt()
      managed.notifications.resume()
      managed.askUser.resume()
      managed.subagents?.notifications?.resume()
      const releasePlanWork = managed.plan.beginWork('user')
      managed.notifications.holdWake()
      managed.askUser.holdWake()
      managed.subagents?.notifications?.holdWake()
      const releaseWakes = () => {
        managed.notifications.releaseWake()
        managed.askUser.releaseWake()
        managed.subagents?.notifications?.releaseWake()
      }
      let promptError: string | undefined
      try {
        try {
          await session.prompt(promptText, { source: 'rpc' })
        } catch (error) {
          promptError = error instanceof Error ? error.message : String(error)
        }
        await this.drainScheduledRun(managed, signal)
      } finally {
        releasePlanWork()
        releaseWakes()
      }
      signal.throwIfAborted()
      settled = true
      if (promptError) throw new Error(promptError)
      const last = [...(session.messages as ChatMessage[])].reverse().find((message) => message.role === 'assistant') as
        | { stopReason?: string; error?: unknown; errorMessage?: unknown }
        | undefined
      if (last?.stopReason === 'error') throw new Error(String(last.errorMessage ?? last.error ?? 'The model run ended with an error'))
      if (last?.stopReason === 'aborted') throw new DOMException('The scheduled run was aborted', 'AbortError')
      return { summary: session.getLastAssistantText()?.trim() || undefined }
    } finally {
      clearInterval(waitingTimer)
      if (!settled || signal.aborted) {
        // The cleanup owns the accepted run until every child has stopped. An
        // already-aborted run signal must not skip this retry or release it.
        while (true) {
          // Quit/disposal owns the session from here: further stop attempts
          // would only fail, and the persisted run recovers as interrupted
          // on the next boot.
          if (managed.disposing) break
          try {
            await stop()
            break
          } catch (error) {
            try {
              await context.onWaiting(true, `Stopping failed; retrying: ${error instanceof Error ? error.message : String(error)}`)
            } catch {
              /* persistence lost: keep retrying regardless */
            }
            await new Promise<void>((resolve) => setTimeout(resolve, 1000))
          }
        }
      }
      signal.removeEventListener('abort', onAbort)
    }
  }

  /** Fully drain a scheduled turn: background bash, pending notification
   * deliveries and subagent handoffs must all be quiet before the outcome is
   * read — `agent_end` alone is never completion. */
  private async drainScheduledRun(managed: ManagedSession, signal: AbortSignal): Promise<void> {
    const tasks = this.commandTasks
    const deadline = Date.now() + 5 * 60_000
    let turnLive = !managed.session.isIdle
    let wake: (() => void) | null = null
    const unsubscribe = managed.session.subscribe((event) => {
      if (event.type === 'agent_start') {
        turnLive = true
        wake?.()
      }
      if (event.type === 'agent_settled') {
        turnLive = false
        wake?.()
      }
    })
    try {
      for (let cycle = 0; cycle < 600; cycle++) {
        signal.throwIfAborted()
        // Process completion and its notification are separate handoffs; give
        // queued delivery a turn before deciding an empty task list is done.
        await new Promise<void>((resolve) => setImmediate(resolve))
        const live = tasks.list(managed.path).filter((task) => task.background && taskIsLive(task))
        const pendingDelivery =
          managed.notifications.hasPendingCompletions ||
          managed.askUser.hasPendingDeliveries ||
          (managed.subagents?.notifications?.hasPendingDeliveries ?? false)
        if (!live.length && !pendingDelivery && !turnLive && managed.session.isIdle) return
        if (Date.now() >= deadline) throw new Error('The scheduled run did not settle')
        if (live.length) {
          await Promise.race([tasks.wait(managed.path, live[0].id).catch(() => {}), scheduledDelay(signal, 1000).catch(() => {})])
        } else {
          await Promise.race([new Promise<void>((resolve) => (wake = resolve)), scheduledDelay(signal, 1000).catch(() => {})])
        }
      }
      throw new Error('The scheduled run exceeded its continuation limit')
    } finally {
      unsubscribe()
    }
  }

  private async initializeSession(managed: ManagedSession, loader: ResourceLoader): Promise<void> {
    // Publish the managed session and its barrier before running extension code.
    await new Promise<void>((resolve) => setImmediate(resolve))
    if (this.closing || managed.disposing) return
    const startedAt = performance.now()
    try {
      managed.gate?.bindExtensionRuntime(loader.getExtensions().runtime)
      // Keep print mode + onError: lazy tools register during session_start,
      // and the binding is also required for reload to re-emit session_start.
      await managed.session.bindExtensions({ mode: 'print', onError: (error) => {
        console.error(`Extension error (${error.extensionPath}): ${error.error}`)
      } })
      if (this.closing || managed.disposing) return
      this.applyActiveTools(managed, loader)
    } catch (error) {
      if (!this.closing && !managed.disposing) {
        this.emitSessionError(managed, error)
      }
    } finally {
      managed.initializing = false
      if (!this.closing && !managed.disposing) {
        this.catalogCache = null
        this.routeEvent(managed, {
          type: 'session_initialized',
          model: modelRef(managed.session.model),
          thinkingLevel: managed.session.thinkingLevel,
          availableThinkingLevels: managed.session.getAvailableThinkingLevels(),
          contextUsage: this.contextUsageOf(managed)
        })
        // Initialization ending is a Plan fact (the `initializing` blocker).
        managed.plan.refresh()
      }
      const elapsed = Math.round(performance.now() - startedAt)
      if (elapsed >= 1000) console.warn(`[Pith] Session extension startup took ${elapsed}ms (${managed.path})`)
    }
  }

  snapshot(): SessionSnapshotDTO {
    const managed = this.activeSession
    if (!managed || !this.cwd) throw new Error('Pi session is not initialized')
    return this.snapshotOf(managed)
  }

  /** Main-owned binding for explicit user Git actions, independent of agent tools. */
  gitWorkspace(): { cwd: string | null; writable: boolean } {
    const managed = this.activeSession
    return {
      cwd: managed && !isDefaultWorkspace(managed.cwd) ? managed.cwd : null,
      writable: !!managed && !managed.subagentChild && !managed.scheduledTask && !isDefaultWorkspace(managed.cwd)
    }
  }

  /**
   * The mode a snapshot reports and the tools enforce. A subagent child has
   * no mode of its own — it follows its parent session's LIVE choice so a
   * parent switch reaches the child's next tool call; a parent that is not
   * live falls back to the child's own branch fold.
   */
  private effectiveSandboxMode(managed: ManagedSession): SandboxMode {
    // Plan only overlays the EFFECTIVE value. The stored/default choice is
    // untouched, so leaving plan restores exactly what the user picked.
    if (managed.plan.restricted) return 'read-only'
    return this.resolvedSandboxMode(managed)
  }

  /** This session's own stored sandbox choice (children follow their parent). */
  private resolvedSandboxMode(managed: ManagedSession): SandboxMode {
    const parentPath = managed.subagentChild?.parentPath
    return (parentPath ? this.sessions.get(parentPath)?.sandboxMode : undefined) ?? managed.sandboxMode
  }

  /**
   * Live facts for one session's Plan controller. Every value is read at call
   * time (never cached) so a pending question, notification or task changes the
   * answer the moment it appears.
   */
  private planFacts(managed: ManagedSession): PlanLiveFacts {
    const session = managed.session
    const tasks = this.commandTasksInstance
      ? this.commandTasksInstance.list(managed.path).filter((task) => task.status === 'running' || task.status === 'stopping').length
      : 0
    const configuredSandboxMode = this.resolvedSandboxMode(managed)
    return {
      initializing: managed.initializing || managed.lifecyclePromise !== null,
      closing: this.closing || managed.disposing,
      child: Boolean(managed.subagentChild),
      recovery: managed.recoveryOnly || this.checkoutCoordinator.needsRecovery(managed.cwd),
      sdkIdle: session.isIdle && !managed.imageReplay && !managed.goals?.preparing,
      tasks,
      subagents: managed.subagents?.hasLiveRuns ? 1 : 0,
      deliveries:
        (managed.notifications.hasPendingCompletions ? 1 : 0) +
        (managed.askUser.hasPendingDeliveries ? 1 : 0) +
        (managed.subagents?.notifications?.hasPendingDeliveries ? 1 : 0),
      questions: listPendingAskUser(managed.path).length,
      escalations: listPendingEscalations(managed.path).length,
      queuedMessages: session.getSteeringMessages().length + session.getFollowUpMessages().length,
      configuredSandboxMode,
      // A child keeps its frozen restriction and also follows the parent's
      // LIVE mode. A missing parent never widens the frozen restriction.
      inheritedPlanRestriction: managed.subagentChild
        ? (managed.subagentChild.planRestricted === true || (this.sessions.get(managed.subagentChild.parentPath)?.plan.restricted ?? false))
        : false,
      // `read-only` is what plan actually runs; `enforcement` is null when no
      // runner is usable, which is a stated capability limit, not a switch veto.
      shellEnforcement: sandboxStatus('read-only').enforcement ?? 'unavailable'
    }
  }

  /**
   * Live admission for a tool that creates a process, task or child. The gate's
   * beforeToolCall already refuses a sealed/transitioning turn; this is the
   * second layer for a call that was prepared before the state changed (an
   * awaited argument hook included). It only refuses — no task is stopped and
   * no queue is cleared to pass the check.
   */
  private planToolAdmitted(managed: ManagedSession): boolean {
    try {
      managed.plan.checkWorkAdmission()
    } catch {
      return false
    }
    if (managed.plan.submissionLocked) return false
    return !managed.plan.snapshot.blockers.switch.includes('storage')
  }

  /**
   * Per-path Plan metadata clock. A managed rebuild of the same session file
   * continues this sequence; resetting it would let a fresh controller publish
   * a `seq` the renderer already accepted and silently drop the update.
   */
  private nextPlanSeq(path: string): number {
    const next = (this.planSequences.get(path) ?? 0) + 1
    this.planSequences.set(path, next)
    return next
  }

  /** Sequence-free Plan metadata ping (same rule as context_usage/subagents). */
  private publishPlanState(managed: ManagedSession): void {
    if (this.closing || managed.disposing) return
    this.emit('pi:event', serialize({
      type: 'plan_state_update',
      sessionId: managed.session.sessionId,
      sessionPath: managed.path,
      plan: managed.plan.snapshot
    }))
  }

  /** Plan metadata of one managed session, by explicit path. */
  getPlanState(sessionPath: string): PlanStateDTO {
    const managed = this.sessions.get(sessionPath)
    if (!managed) throw new Error('No such session')
    return managed.plan.snapshot
  }

  /**
   * Switch one managed session's working mode. The request names its session
   * explicitly; the active session is never consulted, so a concurrent switch
   * elsewhere cannot retarget it.
   */
  async setSessionMode(request: PlanModeRequest): Promise<PlanActionResult<PlanStateDTO>> {
    const mode = request?.mode
    if (mode !== 'normal' && mode !== 'plan') return { ok: false, code: 'invalid-mode', blockers: [] }
    const managed = this.sessions.get(request.sessionPath)
    if (!managed) return { ok: false, code: 'no-session', blockers: [] }
    if (managed.subagentChild || managed.scheduledTask) return { ok: false, code: 'child-session', blockers: ['child-session'] }
    try {
      const goals = managed.goals
      const drainGoal = mode === 'plan' && managed.session.isIdle && goals && (goals.live || goals.preparing)
      // Other admitted preparation owns the session. Refuse synchronously so
      // the transition lock cannot interrupt its next asynchronous boundary.
      if (drainGoal && managed.plan.workCount > (goals.preparing ? 1 : 0)) throw new PlanAdmissionError('The session is busy', ['busy'])
      const value = await managed.plan.setMode(mode, drainGoal ? async () => {
        goals.pause('plan'); await goals.idle()
      } : undefined)
      return { ok: true, value }
    } catch (error) {
      if (error instanceof PlanAdmissionError) {
        return { ok: false, code: planErrorCode(error.blockers), blockers: error.blockers }
      }
      throw error
    }
  }

  async approvePlan(request: PlanApproveRequest): Promise<PlanActionResult<PlanApprovalDTO>> {
    const managed = this.sessions.get(request?.sessionPath)
    if (!managed?.planApproval) return { ok: false, code: 'no-session', blockers: [] }
    return managed.planApproval.approve(request)
  }

  async resetPlanApproval(request: PlanDocumentRequest): Promise<PlanActionResult<PlanStateDTO>> {
    const managed = this.sessions.get(request?.sessionPath)
    if (!managed?.planApproval) return { ok: false, code: 'no-session', blockers: [] }
    return managed.planApproval.reset(request)
  }

  readPlanDocument(request: PlanDocumentRequest): PlanActionResult<PlanDocumentDTO> {
    const managed = this.sessions.get(request?.sessionPath)
    if (!managed) return { ok: false, code: 'no-session', blockers: [] }
    const branch = managed.session.sessionManager.getBranch()
    const index = branch.findIndex(entry => entry.id === request.submissionEntryId)
    const document = index >= 0 ? reconstructPlan(branch.slice(0, index + 1)).latest : null
    if (!document || document.ref.submissionEntryId !== request.submissionEntryId ||
        document.ref.planId !== request.planId || document.ref.revision !== request.revision) {
      return { ok: false, code: 'stale-submission', blockers: ['stale-submission'] }
    }
    return { ok: true, value: document }
  }

  private stampPlanMessages(managed: ManagedSession, messages: ChatMessage[], originals: ChatMessage[]): ChatMessage[] {
    // No streaming/token path scans a branch; only snapshots and committed results.
    if (!originals.some(m => m.role === 'toolResult' && m.toolName === 'submit_plan')) return messages
    const refs = new Map<object, PlanSubmissionRef>()
    reconstructPlan(managed.session.sessionManager.getBranch(), (entry, document) => {
      refs.set((entry as { message: object }).message, document.ref)
    })
    return messages.map((message, index) => {
      const ref = refs.get(originals[index])
      return ref && message.role === 'toolResult' ? { ...message, planSubmission: ref } : message
    })
  }

  /** Full selected-branch transcript for display; compaction affects context only. */
  private transcriptOf(managed: ManagedSession): ChatMessage[] {
    const originals = transcriptMessages(managed.session.sessionManager)
    const messages = serialize(this.stampPlanMessages(
      managed,
      originals.map(message => managed.changeScopes.stamp(message)),
      originals
    )) as ChatMessage[]
    this.stampCompletedAt(managed, messages)
    return messages
  }

  /** Serialize one session's current state for the renderer. */
  /**
   * A run is in flight: the agent loop is active, or a wake owner (notification
   * delivery, an answered question) will continue it at settlement. This is
   * exactly what the snapshot reports as `isStreaming` and what the composer
   * reads as `busy`, so the renderer's gates and the guards below agree on
   * "mid-run" by construction.
   */
  private sessionBusy(managed: ManagedSession): boolean {
    return managed.session.isStreaming || managed.notifications.continuesAtSettled || managed.askUser.continuesAtSettled || !!managed.goals?.preparing
  }

  /**
   * The mid-run switch gate: model, thinking level and the session's sandbox
   * mode may only change while a run is streaming when Settings → General
   * allows it. Off is the default and refuses; the message is a token (the
   * renderer's pickers are already disabled, so a rejection here is a stale
   * caller, not a path that needs prose).
   */
  private assertMidRunChangeAllowed(managed: ManagedSession): void {
    if (this.allowMidRunChanges || !this.sessionBusy(managed)) return
    throw new Error('mid-run-changes-disabled')
  }

  private snapshotOf(managed: ManagedSession): SessionSnapshotDTO {
    this.flushStreamEvents(managed)
    const messages = this.transcriptOf(managed)
    const live = managed.streaming as ChatMessage | null
    if (live?.role === 'assistant') {
      const index = messages.findLastIndex(
        (message) => message.role === 'assistant' && message.timestamp === live.timestamp
      )
      if (index >= 0) messages.splice(index, 1)
    }
    return {
      sessionId: managed.session.sessionId,
      sessionPath: managed.path,
      cwd: managed.cwd,
      projectless: isDefaultWorkspace(managed.cwd),
      initializing: managed.initializing,
      sandboxMode: this.effectiveSandboxMode(managed),
      sandbox: sandboxStatus(this.effectiveSandboxMode(managed)),
      // Fresh at serialization: an IPC snapshot (or a session switch) must
      // carry the pending questions itself, not rely on the metadata event's
      // arrival order relative to this snapshot.
      escalations: listPendingEscalations(managed.path),
      // Pending ask_user_question sets, subagent children's included (they
      // are listed under this owner path by construction).
      pendingAskUser: listPendingAskUser(managed.path),
      messages,
      todos: managed.todos.snapshot,
      askUserRecords: managed.askRecords.snapshot,
      activeChangeScopeId: managed.changeScopes.current,
      streaming: serialize(managed.streaming) as any,
      toolRuns: serialize(managed.toolRuns),
      queue: {
        steering: managed.queueMirror.steering.map(dtoOf),
        followUp: managed.queueMirror.followUp.map(dtoOf)
      },
      compactionQueue: managed.manualCompaction?.queueState,
      compactionProcess: managed.compactionProcess?.snapshot,
      model: modelRef(managed.session.model),
      thinkingLevel: (managed.session.thinkingLevel ?? 'medium') as ThinkingLevel,
      availableThinkingLevels: managed.session.getAvailableThinkingLevels() as ThinkingLevel[],
      isStreaming: this.sessionBusy(managed),
      contextUsage: this.contextUsageOf(managed),
      subagents: managed.subagents?.snapshot() ?? [],
      subagentChild: Boolean(managed.subagentChild),
      scheduledTaskSession: Boolean(managed.scheduledTask),
      ...(managed.subagentChild ? { subagentParentPath: managed.subagentChild.parentPath } : {}),
      plan: managed.plan.snapshot,
      jevWorkflow: managed.jevWorkflow?.snapshot ?? null,
      jevWorkflowSeq: managed.jevWorkflow?.revision ?? 0,
      goal: managed.goals?.snapshot ?? null,
      goalSeq: managed.goals?.seq ?? 0,
      eventSequence: managed.eventSequence
    }
  }

  /**
   * Attach every committed message's completion time, read from the session
   * entries' write timestamps. The SDK's message objects only carry the time
   * they were CREATED, and a turn's elapsed time has to run to the moment its
   * last message finished — which for a long final answer is most of it.
   * Entries are correlated the way the transcript already correlates messages
   * with session entries (role + creation timestamp; tool results also by
   * toolCallId), and a message without a matching entry keeps no completion
   * time rather than a wrong one.
   */
  private stampCompletedAt(managed: ManagedSession, messages: ChatMessage[]): void {
    const times = new Map<string, number>()
    const userEntries = new Map<string, string[]>()
    for (const entry of managed.session.sessionManager.getBranch()) {
      if (entry.type !== 'message') continue
      if (entry.message.role === 'user') {
        const key = JSON.stringify([entry.message.timestamp, entry.message.content])
        const ids = userEntries.get(key) ?? []; ids.push(entry.id); userEntries.set(key, ids)
      }
      const at = Date.parse(entry.timestamp)
      if (!Number.isFinite(at)) continue
      const message = entry.message as { role?: string; timestamp?: number; toolCallId?: string }
      if (message.toolCallId) times.set(`t${message.toolCallId}`, at)
      if (message.role && typeof message.timestamp === 'number') {
        times.set(`${message.role}:${message.timestamp}`, at)
      }
    }
    for (const message of messages) {
      if (message.role === 'user') message.sessionEntryId = userEntries.get(JSON.stringify([message.timestamp, message.content]))?.shift()
      const toolCallId = (message as { toolCallId?: string }).toolCallId
      const at = times.get(
        toolCallId ? `t${toolCallId}` : `${message.role}:${message.timestamp}`
      )
      if (at !== undefined) (message as { completedAt?: number }).completedAt = at
    }
  }

  /**
   * SDK-authoritative context usage plus the session's true running totals.
   * `getSessionStats()` aggregates every session entry — messages compacted out
   * of the context and tool-result usage included — which summing
   * `session.messages` alone would undercount.
   *
   * The in-flight partial is added on top (same estimator the SDK's own
   * compaction uses): the SDK only accounts for COMPLETED messages, so without
   * it the ring's numbers would sit still for a whole generation and only jump
   * when each round lands.
   */
  private contextUsageOf(managed: ManagedSession): ContextUsageDTO | null {
    const stats = managed.session.getSessionStats()
    const usage = stats.contextUsage
    const revision = `${managed.session.sessionManager.getLeafId() ?? ''}:${managed.trajectory?.contextRevision ?? 0}`
    // Unknown windows keep the ring unknown, but request/billing metadata must
    // still refresh (including the first request through a virtual model).
    if (!usage || !usage.contextWindow) return {
      tokens: null, contextWindow: usage?.contextWindow ?? 0, percent: null,
      sessionCost: stats.cost, cacheHitRate: cacheHitRate(stats.tokens), revision
    }
    const live = managed.streaming ? estimateTokens(managed.streaming as any) : 0
    const reported = usage.tokens === null || usage.tokens === undefined
      ? compactedContextTokens(managed.session.sessionManager.buildSessionProjection().messages)
      : usage.tokens
    const tokens = reported === null ? null : reported + live
    return {
      tokens,
      contextWindow: usage.contextWindow,
      percent: tokens === null ? null : (tokens / usage.contextWindow) * 100,
      sessionCost: stats.cost,
      cacheHitRate: cacheHitRate(stats.tokens),
      revision
    }
  }

  /**
   * Initialize (or re-initialize for a new cwd) with the startup session. */
  async init(cwd?: string): Promise<SessionSnapshotDTO> {
    const navigationEpoch = ++this.navigationEpoch
    cwd = cwd && !isDefaultWorkspace(cwd) ? cwd : await ensureDefaultWorkspace()
    await this.buildSession(await this.startupSession(cwd), true, navigationEpoch)
    return this.snapshot()
  }

  /**
   * The session a boot lands in, per the persisted startup preference.
   *
   * `resume` reopens exactly the session that was active at quit — the one
   * saved by `rememberFolder` — but only while it still exists and still
   * belongs to the folder being opened; a deleted or trashed session starts a
   * fresh one instead of resurrecting an older file. `new` always starts a new
   * session. Only a first launch (or a fallback) picks the newest session of
   * the folder, which is what used to make a launch unpredictable.
   */
  private async startupSession(cwd: string): Promise<SessionManager> {
    if (this.startup === 'new') return SessionManager.create(cwd)
    const saved = this.startupSessionPath()
    if (saved && existsSync(saved)) {
      try {
        const reopened = SessionManager.open(saved)
        if (reopened.getHeader()?.cwd === cwd) return reopened
      } catch {
        /* unreadable file — fall through to the folder's newest session */
      }
    }
    const sessions = await SessionManager.list(cwd).catch(() => [])
    return sessions[0] ? SessionManager.open(sessions[0].path) : SessionManager.create(cwd)
  }

  /** Session file the last activation persisted, if any. */
  private startupSessionPath(): string | null {
    const saved = loadSettings().startupSession
    return typeof saved === 'string' && saved.length > 0 ? saved : null
  }

  /** New chat without a project, or inside an explicitly selected project. */
  async newSession(cwd?: string): Promise<SessionSnapshotDTO> {
    const navigationEpoch = ++this.navigationEpoch
    const target = cwd ?? await ensureDefaultWorkspace()
    await this.buildSession(SessionManager.create(target), true, navigationEpoch)
    return this.snapshot()
  }

  /**
   * Open a session file. `cwd` is the folder the sidebar item belongs to; when
   * omitted the session header's own cwd is used. Switches the active
   * workspace folder if the session belongs to a different one.
   */
  async openSession(path: string, cwd?: string): Promise<SessionSnapshotDTO> {
    if (this.closing) throw new Error('Application is shutting down')
    const navigationEpoch = ++this.navigationEpoch
    const existing = this.sessions.get(path)
    if (existing && !existing.disposing) {
      if (this.closing || existing.disposing) throw new Error('Session was closed during initialization')
      if (navigationEpoch !== this.navigationEpoch) return this.snapshot()
      this.activateSession(existing)
      return this.snapshot()
    }
    const sessionManager = SessionManager.open(path)
    const folder = cwd ?? sessionManager.getHeader()?.cwd ?? this.cwd
    if (!folder) throw new Error('No working directory selected')
    await this.buildSession(sessionManager, true, navigationEpoch)
    return this.snapshot()
  }

  /**
   * Ask a side question. The answer is a single no-tools completion over a
   * snapshot of the bound session plus the side chat's own earlier exchanges —
   * see `pi/side-chat.ts`. Nothing here touches an AgentSession: the question
   * cannot enter the session file, queue behind a running prompt, or reach the
   * extension runner, so a side chat can never disturb the run it asks about.
   */
  async sideChatAsk(payload: SideChatAskPayload): Promise<{ exchangeId: string }> {
    // The renderer keeps its side chat bound to the session it was opened
    // against, so switching the workspace to another session does NOT repoint
    // it: the question still draws on (and inherits the model/effort of) that
    // original session, which stays live in the background. Only when the bound
    // session is gone — deleted, or its folder deleted — does this fall back to
    // whatever session is active now.
    const bound =
      (payload.sessionPath ? this.sessions.get(payload.sessionPath) : undefined) ?? this.activeSession
    if (!bound) throw new Error('Pi session is not initialized')
    const model = bound.session.model
    if (!model) throw new Error('No model selected for the side question')
    // Inherit the bound session's effort too: the side answer is about that
    // run, so it should reason at the same level (no separate setting).
    const reasoning = bound.session.thinkingLevel
    const question = payload.question.trim().slice(0, SIDE_CHAT_QUESTION_CHAR_LIMIT)
    if (!question) throw new Error('The side question is empty')
    const history = sanitizeSideChatHistory(payload.history)

    // The renderer owns the id, so its optimistic exchange and the stream that
    // answers it line up without a remap race.
    const exchangeId = payload.exchangeId.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 64)
    if (!exchangeId) throw new Error('The side question has no exchange id')
    const controller = new AbortController()
    this.sideChats.set(exchangeId, controller)
    const runtime = await this.runtime()
    // SAFETY: the SDK chat messages match the structure consumed by buildSideChatContext.
    const sessionMessages = bound.session.messages as unknown as ChatMessage[]
    void runSideChatAnswer({
      runtime,
      model,
      reasoning: reasoning === 'off' ? undefined : reasoning,
      exchangeId,
      context: buildSideChatContext({ sessionMessages, history, question, cwd: bound.cwd }),
      signal: controller.signal,
      emit: (event) => this.emit('pi:side-chat', event)
    }).finally(() => this.sideChats.delete(exchangeId))
    return { exchangeId }
  }

  /** Stop a side-chat answer. The partial text already streamed stays on screen. */
  sideChatAbort(exchangeId: string): void {
    this.sideChats.get(exchangeId)?.abort()
    this.sideChats.delete(exchangeId)
  }

  /**
   * Sessions of every known folder (opened in the app, or seen in the session
   * store), newest first within each folder. Each entry carries its folder so
   * the sidebar can group them.
   */
  async listSessions(): Promise<SessionSummaryDTO[]> {
    this.sessionSearch.warm()
    this.sessionListInFlight ??= this.listSessionsUncached().finally(() => {
      this.sessionListInFlight = null
    })
    return this.sessionListInFlight
  }

  private async listSessionsUncached(): Promise<SessionSummaryDTO[]> {
    await this.sessionIndex.refresh((path) => {
      const managed = this.sessions.get(path)
      return (managed ? rowFromSessionManager(managed.session.sessionManager) : null) ?? undefined
    })
    const infos = this.sessionIndex.list()
    const byFolder = new Map<string, typeof infos>()
    for (const info of infos) {
      if (!info.cwd) continue
      const list = byFolder.get(info.cwd) ?? []
      list.push(info)
      byFolder.set(info.cwd, list)
    }
    const folderRecency = (sessions: typeof infos) =>
      sessions.reduce((max, s) => Math.max(max, s.modified), 0)
    const orderedFolders = [
      ...(this.cwd ? [this.cwd] : []),
      ...this.folders.filter((f) => f !== this.cwd),
      // Folders with sessions but never opened here (e.g. pi CLI projects),
      // most recently modified first.
      ...[...byFolder.entries()]
        .filter(([folder]) => folder !== this.cwd && !this.folders.includes(folder))
        .sort(([, a], [, b]) => folderRecency(b) - folderRecency(a))
        .map(([folder]) => folder)
    ]
    const seen = new Set<string>()
    const summaries: SessionSummaryDTO[] = []
    for (const folder of orderedFolders) {
      if (seen.has(folder)) continue
      seen.add(folder)
      const sessions = (byFolder.get(folder) ?? []).slice().sort((a, b) => b.modified - a.modified)
      for (const s of sessions) {
        // A freshly materialized session has a header but no messages yet; keep
        // it off the sidebar until its first user message exists to name it.
        if (s.messageCount === 0) continue
        // Subagent children are reachable through their parent's roster, not
        // the sidebar. Only the persisted run marker separates them from
        // forks (which also carry parentSessionPath and do show here).
        if (s.parentSessionPath && s.subagentChild) continue
        // Scheduled-run sessions are reachable through the scheduled tasks
        // view (runs record their sessionPath), never through the sidebar.
        if (s.scheduledTask) continue
        // `messageCount` counts every branch in the file, so a session whose
        // conversation was restored to before its first turn still has all its
        // history in that number while its selected branch is empty. The branch
        // decides: it would otherwise be listed but open as a new chat.
        if (!s.branchHasMessages) continue
        summaries.push({
          path: s.path,
          id: s.id ?? '',
          // No prose here: an empty session carries `null` so the renderer can
          // label it in the active locale.
          label: s.name?.trim() || (s.messageCount > 0 ? s.firstMessage?.trim().slice(0, 80) || null : null),
          created: new Date(s.created).toISOString(),
          modified: new Date(s.modified).toISOString(),
          messageCount: s.messageCount,
          cwd: folder,
          projectless: isDefaultWorkspace(folder),
          running: this.sessions.get(s.path)?.session.isStreaming ?? false
        })
      }
    }
    return summaries
  }

  async searchSessions(request: SessionSearchRequest): Promise<SessionSearchResultDTO> {
    const result = await this.sessionSearch.search(request)
    return { ...result, hits: result.hits.map((hit) => ({ ...hit, projectless: isDefaultWorkspace(hit.cwd) })) }
  }

  /** Cross-session usage stats for Settings → Usage (worker-aggregated, TTL-cached). */
  usageStats(): Promise<UsageStatsDTO> {
    return this.usageAggregator.stats()
  }

  /** Drop a folder from the known list (and stop treating it as active). */
  private forgetFolder(cwd: string): void {
    this.folders = this.folders.filter((f) => f !== cwd)
    saveSettings({
      ...loadSettings(),
      folders: this.folders,
      ...(this.cwd === cwd ? { cwd: null } : {})
    })
  }

  /**
   * Set (or clear) a session's display name — the `session_info` entry the
   * sidebar reads and the pi CLI shares. A live session appends through its
   * AgentSession so the change lands in its transcript; an inactive file is
   * opened just to append the entry.
   */
  async renameSession(path: string, name: string): Promise<void> {
    // Empty names clear the title (SessionManager.getSessionName treats them
    // as an explicit clear).
    const managed = this.sessions.get(path)
    if (managed) {
      managed.session.setSessionName(name)
      return
    }
    SessionManager.open(path).appendSessionInfo(name)
  }

  /**
   * Move a session file to the OS trash. If it was the open session, fall
   * back to the folder's most recent remaining session (or a fresh one).
   * Returns the snapshot to re-apply, or null when nothing is open anymore.
   */
  async deleteSession(path: string): Promise<SessionSnapshotDTO | null> {
    ++this.navigationEpoch
    const managed = this.sessions.get(path)
    await this.checkoutCoordinator.ready()
    const targetCwd = managed?.cwd ?? SessionManager.open(path).getCwd()
    if (this.checkoutCoordinator.needsRecovery(targetCwd) || !this.checkoutCoordinator.canStart(targetCwd)) throw new RewindFailure('busy')
    if (managed) {
      await this.subagentRuntime.stopAll(managed.subagents)
      await this.disposeManaged(managed)
    }
    // The file is about to leave the disk: drop its browser pages (fire-and-
    // forget — the trash must not wait on guest teardown). Managed sessions
    // already recycled theirs inside disposeManaged above; only an unmanaged
    // session (pages registered before it was last closed) needs the sweep.
    if (!managed) {
      void getBrowserService()?.closePagesForOwner(agentOwner(SessionManager.open(path).getSessionId()))
    }
    // Children are conversation sub-records of the deleted parent: stop them
    // (already done above) and trash their files with it, or they would be
    // orphaned — hidden from the sidebar but unreachable from any roster.
    const childFiles = await this.subagentChildFiles(targetCwd, path)
    let trashFailure: unknown
    try {
      for (const child of childFiles) {
        const childManaged = this.sessions.get(child)
        if (childManaged) await this.disposeManaged(childManaged)
        await shell.trashItem(child)
      }
      await shell.trashItem(path)
    } catch (error) {
      // Do not report deletion when the OS refused it. Restore a usable
      // selection even though this session's live owners were already closed.
      // A failed child recycle also leaves the parent reachable on disk.
      trashFailure = error
    }
    if (!this.activeSession && this.cwd) {
      const sessions = await SessionManager.list(this.cwd).catch(() => [])
      const latest = sessions[0]
      await this.buildSession(latest ? SessionManager.open(latest.path) : SessionManager.create(this.cwd))
    }
    if (trashFailure !== undefined) throw trashFailure
    return this.activeSession ? this.snapshot() : null
  }

  /**
   * Trash every session belonging to a folder and forget the folder. If it is
   * the active workspace, a fresh empty session is opened there so the
   * workspace keeps running — but the folder still leaves the known list, so
   * the sidebar only shows it again once a session in it exists.
   */
  async deleteFolderSessions(cwd: string): Promise<SessionSnapshotDTO | null> {
    await this.checkoutCoordinator.ready()
    if (!this.checkoutCoordinator.canStart(cwd)) throw new RewindFailure('busy')
    ++this.navigationEpoch
    const infos = await SessionManager.listAll().catch(() => [])
    const targets = infos.filter((info) => info.cwd === cwd)
    const managedTargets = [...this.sessions.values()].filter((managed) => managed.cwd === cwd)
    const wasActive = this.activeSession?.cwd === cwd
    await Promise.all(managedTargets.map((managed) => this.disposeManaged(managed)))
    const paths = new Set([...targets.map((info) => info.path), ...managedTargets.map((managed) => managed.path)])
    await Promise.all([...paths].map((path) => shell.trashItem(path).catch(() => {})))
    this.forgetFolder(cwd)
    if (wasActive) {
      await this.buildSession(SessionManager.create(cwd), false)
    }
    return this.activeSession ? this.snapshot() : null
  }

  /**
   * Send a prompt. Image attachments go straight to the model; referenced
   * local files are read here and inlined as `<file path>` blocks.
   */
  prompt(payload: PromptPayload): void | Promise<PlanActionResult<PlanStateDTO>> {
    if (payload.text.trim() === '/plan') {
      if (payload.images.length || payload.files.length) return Promise.resolve({ ok: false, code: 'plan-command-attachments', blockers: [] })
      const target = this.activeSession
      if (!target) return Promise.resolve({ ok: false, code: 'no-session', blockers: [] })
      return this.setSessionMode({ sessionPath: target.path, mode: target.plan.snapshot.mode === 'plan' ? 'normal' : 'plan' })
    }
    const managed = this.activeSession
    const session = managed?.session
    if (this.closing || managed?.disposing) return
    if (managed?.imageReplay) { this.notifyError('An image retry is running. Wait for it to finish or stop it first.'); return }
    // An opened subagent child is a READ-ONLY view: it carries no checkpoint
    // recorder and its runs are owned by the parent's runtime, so a direct
    // user prompt would bypass every execution protection.
    if (managed?.subagentChild) {
      this.notifyError('This subagent session is read-only. Open its parent session to continue work.')
      return
    }
    // A scheduled-run session is likewise read-only for interactive paths: its
    // turns are owned by the scheduler and its task is managed from the
    // scheduled tasks view.
    if (managed?.scheduledTask) {
      this.notifyError('This session belongs to a scheduled task and is read-only.')
      return
    }
    if (!managed || !session) {
      this.notifyError('Pi session is not initialized. Pick a working directory first.')
      return
    }
    // A real new prompt supersedes a Continue still preparing to start.
    if (session.isIdle) managed.continuationRequest?.abort()
    // A mode change owns the session while it is in flight; a prompt admitted
    // then would race the branch write it is about to make.
    try {
      managed.plan.checkWorkAdmission()
      if (managed.plan.branchWork) throw new PlanAdmissionError('Branch work is in progress', ['transition'])
    } catch {
      this.notifyError('A session mode change is in progress. Try again in a moment.')
      return
    }
    const preparingGoal = session.isIdle && managed.goals?.preparing ? managed.goals : undefined
    managed.notifications.resume()
    managed.askUser?.resume()
    managed.subagents?.notifications?.resume()
    // Register the preparation window BEFORE the first await (file reads,
    // materialization, the lifecycle barrier): the SDK still reports idle here,
    // and a mode switch must not slip in. A user turn may be requested while a
    // planning turn is sealed; only its own message_start lifts that seal.
    const releasePlanWork = managed.plan.beginWork('user')
    managed.goals?.userPrompt()
    managed.notifications.holdWake()
    managed.askUser.holdWake()
    managed.subagents?.notifications?.holdWake()
    void (async () => {
      try {
        // A replacement session kept after project deletion intentionally has
        // no file yet. The first real prompt makes it durable and restores the
        // project to the known-folder list before any asynchronous work.
        if (!existsSync(managed.path)) {
          this.materializeSession(session.sessionManager)
          this.rememberFolder(managed.cwd)
        }
        // A superseded Goal may still be inside an asynchronous SDK input
        // hook. Drain that preparation before admitting this new user turn.
        await preparingGoal?.idle()
        const fileBlocks = await this.readFileBlocks(payload.files, managed.cwd)
        await managed.lifecyclePromise
        if (this.closing || managed.disposing || !managed.notifications.canStart) return
        // Draining the superseded run may have paused Goal on its abort
        // outcome. This explicit prompt still owns its ordinary answer wakes.
        managed.goals?.userPrompt()
        const text = fileBlocks ? `${payload.text}\n\n${fileBlocks}` : payload.text
        // Only a streaming session can queue, and only then does a payload
        // need parking — an idle prompt just starts a run and is never claimed.
        const queueing = session.isStreaming
        const stash: PendingQueuePayload = {
          composedText: text,
          originalText: payload.text,
          images: payload.images,
          filePaths: payload.files
        }
        if (queueing) managed.pendingQueuePayloads.push(stash)
        try {
          // streamingBehavior only matters while streaming (AgentSession.prompt
          // decides atomically: idle → new run, busy → steer/followUp queue), so
          // a queue request that races a settling run still lands as a prompt.
          await session.prompt(text, {
            images: payload.images,
            streamingBehavior: queueing ? (payload.streamingBehavior ?? 'steer') : undefined
          })
        } finally {
          // Remove only OUR parked payload: an overlapping enqueue may have
          // parked its own (and the reconcile may already have claimed this one).
          const index = managed.pendingQueuePayloads.indexOf(stash)
          if (index >= 0) managed.pendingQueuePayloads.splice(index, 1)
        }
      } catch (error) {
        this.emitSessionError(managed, error)
      } finally {
        releasePlanWork()
        managed.notifications.releaseWake()
        managed.askUser.releaseWake()
        managed.subagents?.notifications?.releaseWake()
      }
    })()
  }

  private async readFileBlocks(paths: string[], cwd: string): Promise<string> {
    if (!paths.length) return ''
    const fileIndex = new FileIndex(cwd)
    const blocks: string[] = []
    for (const path of paths.slice(0, 12)) {
      try {
        const preview: FilePreviewDTO = await readAttachment(fileIndex, path)
        if (preview.kind === 'image') {
          blocks.push(`<file path="${preview.relPath}">(image attachment, ${Math.round(preview.size / 1024)} KB)</file>`)
        } else if (preview.kind === 'text' && preview.text !== undefined) {
          const note = preview.truncated ? '\n(truncated)' : ''
          blocks.push(`<file path="${preview.relPath}">\n${preview.text}${note}\n</file>`)
        } else {
          blocks.push(`<file path="${preview.relPath}">(binary file, ${Math.round(preview.size / 1024)} KB)</file>`)
        }
      } catch (error) {
        blocks.push(`<file path="${path}">(could not be read: ${error instanceof Error ? error.message : 'unknown error'})</file>`)
      }
    }
    return blocks.join('\n\n')
  }

  /**
   * Clear the active session's queues and return the messages WITH their full
   * payloads (images, referenced file paths) from the mirror — the SDK's own
   * clearQueue() only returns texts. The SDK emits an empty queue_update
   * which reconciles the mirror back to empty.
   */
  clearQueue(stopping = false): { steering: RecalledItemDTO[]; followUp: RecalledItemDTO[] } {
    const managed = this.activeSession
    if (!managed) return { steering: [], followUp: [] }
    const recallOf = (items: QueuedItem[]): RecalledItemDTO[] =>
      items.map((item) => ({
        text: item.text,
        originalText: item.originalText,
        images: item.images,
        filePaths: [...item.filePaths]
      }))
    const result = {
      steering: recallOf(managed.queueMirror.steering),
      followUp: recallOf(managed.queueMirror.followUp)
    }
    if (stopping) {
      managed.goals?.pause('stopped')
      managed.manualCompaction?.cancel()
      managed.continuationRequest?.abort()
      managed.notifications.pause()
      managed.askUser.pause()
      managed.subagents?.notifications?.pause()
      if (managed.subagents) this.subagentRuntime.abortAll(managed.subagents)
      void this.commandTasksInstance?.stopSession(managed.path)
      void this.debugManagerInstance?.stopSession(managed.path)
    }
    managed.session.clearQueue()
    managed.notifications.queuesCleared()
    managed.askUser.queuesCleared()
    if (stopping) void managed.session.abort().catch(() => {})
    else managed.notifications.flush()
    managed.askUser.flush()
    return result
  }

  /**
   * Per-item queue surgery. The SDK has no single-item dequeue, so both
   * operations rebuild the queues: clearQueue() then re-queue the surviving
   * MIRROR items (payload included) in order, all in ONE synchronous block —
   * steer()/followUp() push into the queues without awaiting (their
   * skill/template expansion is synchronous), so the agent loop cannot
   * interleave a drain mid-rebuild. The SDK's intermediate queue_updates are
   * swallowed (`queueRebuilding`) and one final state is emitted, so the
   * renderer never flashes an empty panel. Residual race: a message the loop
   * already drained for the upcoming turn (not yet message_start-ed) can be
   * delivered twice; that window is a few ms around a turn boundary and the
   * outcome is a visible duplicate, never a lost message.
   */
  queueAction(payload: QueueActionPayload): void {
    const managed = this.activeSession
    if (!managed) return
    if (managed.subagentChild || managed.scheduledTask) return // read-only view: nothing to rebuild
    // A mode change owns the session: rebuilding the queues inside it would
    // race the branch write. The action is a no-op (nothing is lost).
    try {
      managed.plan.checkWorkAdmission()
    } catch {
      return
    }
    this.rebuildQueues(managed, payload)
  }

  private rebuildQueues(managed: ManagedSession, payload?: QueueActionPayload): void {
    const session = managed.session
    managed.queueRebuilding = true
    try {
      session.clearQueue()
      managed.notifications.queuesCleared()
      managed.askUser.queuesCleared()
      managed.subagents?.notifications?.queuesCleared()
      const nextSteering: QueuedItem[] = []
      const nextFollowUp: QueuedItem[] = []
      managed.queueMirror.steering.forEach((item, index) => {
        if (payload?.action === 'remove' && payload.kind === 'steering' && payload.index === index) return
        nextSteering.push(item)
      })
      managed.queueMirror.followUp.forEach((item, index) => {
        if (payload?.kind === 'followUp' && payload.index === index) {
          // promote → steering queue (behind surviving steers, preserving
          // FIFO); remove → dropped outright.
          if (payload.action === 'promote') nextSteering.push(item)
          return
        }
        nextFollowUp.push(item)
      })
      // The mirror reflects the intended end state even if a requeue call
      // throws midway — later SDK queue_updates re-reconcile toward truth.
      managed.queueMirror = { steering: nextSteering, followUp: nextFollowUp }
      for (const item of nextSteering) session.steer(item.text, item.images)
      for (const item of nextFollowUp) session.followUp(item.text, item.images)
    } catch (error) {
      this.emitSessionError(managed, error)
    } finally {
      managed.queueRebuilding = false
    }
    this.emitQueueState(managed)
    managed.notifications.flush()
    managed.askUser.flush()
    managed.subagents?.notifications?.flush()
  }

  /**
   * The `message`-type session entry on the current branch whose message has
   * the given role and timestamp. The entry id is what navigateTree and
   * createBranchedSession address; timestamps are unique per session message.
   */
  private findMessageEntry(
    managed: ManagedSession,
    role: 'user' | 'assistant',
    timestamp: number
  ): { id: string; parentId: string | null; message: { role: string; timestamp: number; content: any } } | null {
    for (const entry of managed.session.sessionManager.getBranch()) {
      if (entry.type !== 'message') continue
      const message = entry.message as { role?: string; timestamp?: number }
      if (message.role === role && message.timestamp === timestamp) {
        return { id: entry.id, parentId: entry.parentId, message: entry.message as any }
      }
    }
    return null
  }

  imageReplays(sessionPath: string): ImageReplaySnapshot {
    const managed = this.sessions.get(sessionPath)
    const manager = managed?.session.sessionManager ?? SessionManager.open(sessionPath)
    return { sessionPath, revision: this.imageReplayRevisions.get(sessionPath) ?? 0,
      items: imageReplayRecords(manager, managed?.imageReplay?.id) }
  }

  private publishImageReplays(managed: ManagedSession): void {
    if (!existsSync(managed.path)) return
    this.imageReplayRevisions.set(managed.path, (this.imageReplayRevisions.get(managed.path) ?? 0) + 1)
    this.emit('pi:image-replays', this.imageReplays(managed.path))
  }

  cancelImageReplay(sessionPath: string, id: string): void {
    const managed = this.sessions.get(sessionPath)
    if (!managed || managed.imageReplay?.id !== id || managed.subagentChild || managed.scheduledTask) throw new Error('image-retry-stale-request')
    managed.notifications.pause(); managed.askUser.pause(); managed.subagents?.notifications?.pause()
    managed.imageReplay.controller.abort()
  }

  /** User-owned UI operation: no prompt, assistant entry or model request.
   * Parameters are resolved exclusively from private selected-branch records. */
  async retryPresentedImage(request: ImageReplayRequest): Promise<void> {
    const managed = this.activeSession
    if (!managed || managed.path !== request?.sessionPath || managed.subagentChild || managed.scheduledTask) throw new Error('image-retry-stale-session')
    if (managed.plan.restricted) throw new Error('image-file-effect-refused-in-plan-mode')
    if (managed.imageReplay || managed.continuationRequest || !managed.session.isIdle || managed.plan.snapshot.blockers.switch.length) throw new Error('image-retry-busy')
    const manager = managed.session.sessionManager
    const source = presentedGeneration(manager, request.generationId, request.path)
    if (!source) throw new Error('image-retry-unavailable')
    const history = imageReplayRecords(manager).filter(item => item.generationId === source.id && item.sourcePath === request.path)
    const restoreId = request.restoreId === undefined ? history.at(-1)?.id ?? null : request.restoreId
    if (restoreId !== null && !history.some(item => item.id === restoreId)) throw new Error('image-retry-unavailable')
    const releasePlan = managed.plan.beginWork('background')
    const job = { id: randomUUID(), controller: new AbortController(), promise: undefined as Promise<void> | undefined }
    managed.imageReplay = job
    const owners = [managed.notifications, managed.askUser, managed.subagents?.notifications].filter(owner => owner != null)
    for (const owner of owners) { owner.holdWake(); owner.resume() }
    let state: ImageReplayRecord = { version: 1, id: job.id, generationId: source.id, sourcePath: request.path, restoreId, status: 'queued', startedAt: Date.now() }
    let leaf: string | null = null
    const persist = (): string => {
      if (!existsSync(managed.path)) return ''
      const entryId = manager.appendCustomEntry(IMAGE_REPLAY_ENTRY, state)
      leaf = manager.getLeafId()
      this.publishImageReplays(managed)
      return entryId
    }
    const admitted = (): boolean => {
      const tool = managed.gate?.tools().find(tool => tool.name === IMAGE_TOOL_NAME)
      return !job.controller.signal.aborted && !this.closing && !managed.disposing && !managed.plan.restricted &&
        managed.imageReplay === job && manager.getLeafId() === leaf && managed.notifications.canStart &&
        tool?.provenance === 'app' && tool.definition === managed.session.getToolDefinition(IMAGE_TOOL_NAME)
    }
    job.promise = (async () => {
      let releaseTool: (() => void) | undefined
      try {
        persist()
        releaseTool = await this.checkoutCoordinator.enter(managed.cwd, 'tool', managed.path, job.controller.signal)
        job.controller.signal.throwIfAborted()
        if (!admitted()) throw new Error('image-retry-admission-closed')
        const runtime = await this.runtime()
        if (!admitted()) throw new Error('image-retry-admission-closed')
        const tool = createImageTool({ cwd: managed.cwd, runtime, skillPath: this.imageSkillPath,
          getMode: () => this.effectiveSandboxMode(managed), getTimeoutMs: () => this.responseTimeoutMs,
          isPlanRestricted: () => managed.plan.restricted, canStart: admitted, replayFile: request.path,
          recordGeneration: record => { state = { ...state, fileHashes: record.fileHashes } } })
        const args: Record<string, unknown> = { ...structuredClone(source.arguments), n: 1 }
        // Freeze an omitted default to the model that actually produced the original.
        if (args.model === undefined) args.model = source.result.model
        if (!Check(tool.parameters, args)) throw new Error('image-retry-invalid-parameters')
        state = { ...state, status: 'generating' }; persist()
        const library = getLibraryService()
        library?.toolStarted(managed.path, job.id, IMAGE_TOOL_NAME, args)
        const output = await tool.execute(job.id, args as never, job.controller.signal, undefined, undefined as never)
        const result = parseImageToolResult(output.details)
        state = { ...state, status: output.isError ? 'error' : 'complete', endedAt: Date.now(),
          ...(result ? { result } : {}), ...(output.isError ? { error: result?.error ?? 'Image generation failed.',
            ...(job.controller.signal.aborted ? { cancelled: true } : {}) } : {}) }
        const entryId = persist()
        if (output.usage && existsSync(managed.path)) manager.appendUsage('image-replay', 'openrouter', source.result.model, output.usage)
        // Archive the same committed receipt without inserting a tool message
        // into agent state or model history. History scans read the private entry.
        library?.committed({ id: managed.session.sessionId, path: managed.path,
          cwd: isDefaultWorkspace(managed.cwd) ? null : managed.cwd, workspace: managed.cwd,
          title: manager.getSessionName() ?? '' }, entryId,
        { role: 'toolResult', toolCallId: job.id, toolName: IMAGE_TOOL_NAME, content: [], details: output.details,
          isError: output.isError ?? false, timestamp: state.endedAt })
        library?.sessionChanged(managed.path)
        this.emit('pi:rewind', { sessionPath: managed.path })
      } catch (error) {
        state = { ...state, status: 'error', endedAt: Date.now(),
          ...(job.controller.signal.aborted ? { cancelled: true } : {}),
          error: (job.controller.signal.aborted ? 'Image generation was cancelled.' : error instanceof Error ? error.message : String(error)).slice(0, 8000) }
        persist()
      } finally {
        releaseTool?.()
        if (managed.imageReplay === job) managed.imageReplay = undefined
        releasePlan()
        for (const owner of owners) owner.releaseWake()
        this.publishImageReplays(managed)
        if (managed.reloadPending && !this.closing && !managed.disposing) { managed.reloadPending = false; await this.reloadManagedSession(managed) }
      }
    })()
    await job.promise
  }

  /** UI-owned transitions pin both the session and the independent Goal revision. */
  async goalAction(request: GoalActionRequest): Promise<GoalActionResult> {
    const managed = this.sessions.get(request?.sessionPath)
    const goals = managed?.goals
    if (!managed || !goals || managed.subagentChild || managed.scheduledTask || this.closing || managed.disposing) return { ok: false, code: 'unavailable' }
    const definition = request.action === 'definition' || request.action === 'criteria'
    // Usage/status metadata changes during a run. Definition edits pin the
    // stable goal ID + criteria revision instead of that hot publication clock.
    if (!Number.isSafeInteger(request.expectedSeq) || !definition && request.expectedSeq !== goals.seq || request.goalId !== (goals.snapshot?.id ?? null)) return { ok: false, code: 'stale' }
    if (request.action === 'inspect') {
      if (managed.plan.branchWork || managed.initializing || managed.lifecyclePromise) return { ok: false, code: 'busy' }
      await goals.inspect()
      return { ok: true, goal: goals.snapshot, seq: goals.seq }
    }
    if (this.checkoutCoordinator.needsRecovery(managed.cwd)) return { ok: false, code: 'busy' }
    if (request.action === 'dismiss') {
      if (!goals.snapshot || !['completed', 'cancelled'].includes(goals.snapshot.status)) return { ok: false, code: 'invalid' }
      if (managed.initializing || managed.lifecyclePromise || !managed.session.isIdle || goals.preparing) return { ok: false, code: 'busy' }
      let release: () => void
      try { release = managed.plan.beginWork('branch') } catch { return { ok: false, code: 'busy' } }
      try {
        goals.dismiss()
        return goals.snapshot?.dismissed ? { ok: true, goal: goals.snapshot, seq: goals.seq } : { ok: false, code: 'storage' }
      } finally { release() }
    }
    if (definition) {
      const current = goals.snapshot
      if (!current || current.status === 'cancelled') return { ok: false, code: 'invalid' }
      if (request.criteriaRevision !== current.criteriaRevision) return { ok: false, code: 'stale' }
      if (!validGoalCriteria(request.criteria) || request.criteria.some(c => c.id && !current.criteria.some(old => old.id === c.id)) ||
        request.action === 'definition' && (typeof request.objective !== 'string' || !request.objective.trim() || request.objective.length > 8000)) return { ok: false, code: 'invalid' }
      if (!current.accountingAvailable) return { ok: false, code: current.billing?.unresolved ? 'accounting' : 'storage' }
      if (managed.goalEdit || managed.plan.branchWork || managed.plan.transitionBusy || managed.initializing || managed.lifecyclePromise || managed.imageReplay || managed.continuationRequest) return { ok: false, code: 'busy' }
      try { managed.plan.checkWorkAdmission() } catch { return { ok: false, code: 'busy' } }
      const controller = managed.goalEdit = new AbortController()
      try {
        await managed.plan.editGoal(async () => {
          if (controller.signal.aborted || this.closing || managed.disposing) throw new PlanAdmissionError('Goal edit cancelled', ['busy'])
          if (goals.snapshot?.id !== current.id || goals.snapshot.criteriaRevision !== request.criteriaRevision) throw new Error('goal-edit-stale')
          goals.criteria(request.criteria, request.action === 'definition' ? request.objective.trim() : current.objective)
          if (goals.snapshot?.reason === 'storage') throw new Error('goal-edit-storage')
          managed.jevWorkflow?.resume()
        }, async () => {
          this.stopManaged(managed, 'criteria')
          await managed.session.abort()
          await goals.idle()
          await this.subagentRuntime.stopAll(managed.subagents)
          await this.commandTasksInstance?.stopSession(managed.path)
          await this.debugManagerInstance?.stopSession(managed.path)
          await managed.rewind?.idle()
        })
        return { ok: true, goal: goals.snapshot, seq: goals.seq }
      } catch (error) {
        return { ok: false, code: goals.snapshot?.reason === 'storage' ? 'storage' : error instanceof PlanAdmissionError || controller.signal.aborted ? 'busy' : error instanceof Error && error.message === 'goal-edit-stale' ? 'stale' : 'storage' }
      } finally { if (managed.goalEdit === controller) managed.goalEdit = undefined }
    }
    if (request.action === 'pause' || request.action === 'cancel') {
      if (managed.plan.branchWork || managed.plan.transitionBusy) return { ok: false, code: 'busy' }
      if (!goals.snapshot) return { ok: false, code: 'invalid' }
      if (request.action === 'cancel') goals.cancel()
      this.stopManaged(managed, 'user')
      if (goals.snapshot?.reason === 'storage') return { ok: false, code: 'storage' }
      return { ok: true, goal: goals.snapshot, seq: goals.seq }
    }
    if (!['create', 'resume', 'limits'].includes(request.action)) return { ok: false, code: 'invalid' }
    if (managed.initializing || managed.lifecyclePromise || !managed.session.isIdle || goals.preparing || managed.imageReplay || managed.continuationRequest || managed.plan.workCount) return { ok: false, code: 'busy' }
    if (request.action !== 'limits' && (managed.plan.restricted || managed.plan.submissionLocked)) return { ok: false, code: 'plan' }
    if ((request.action === 'create' || request.action === 'limits') && !validGoalLimits(request.limits)) return { ok: false, code: 'invalid' }
    if (request.action === 'create') {
      if ((request.images !== undefined && (!Array.isArray(request.images) || request.images.some(image => !image || image.type !== 'image' || typeof image.data !== 'string' || typeof image.mimeType !== 'string'))) ||
        (request.files !== undefined && (!Array.isArray(request.files) || request.files.some(path => typeof path !== 'string')))) return { ok: false, code: 'invalid' }
      if (typeof request.objective !== 'string' || typeof request.acceptance !== 'string' || !request.objective.trim() || !request.acceptance.trim() ||
        request.objective.length > 8000 || request.acceptance.length > 8000) return { ok: false, code: 'invalid' }
      const current = goals.snapshot
      if (!goalCanBeReplaced(current)) return { ok: false, code: 'busy' }
      const facts = this.planFacts(managed)
      if (facts.tasks || facts.subagents || facts.deliveries || facts.questions || facts.escalations || facts.queuedMessages) return { ok: false, code: 'busy' }
    } else {
      if (!goals.snapshot || goals.snapshot.status === 'cancelled' || goals.snapshot.status === 'completed') return { ok: false, code: 'invalid' }
      if (request.action === 'resume' && !goals.snapshot.accountingAvailable) return { ok: false, code: goals.snapshot.billing?.unresolved ? 'accounting' : 'storage' }
      if (request.action === 'resume' && goals.snapshot.pendingInput && !goals.snapshot.pendingInput.available) return { ok: false, code: 'attachments' }
      if (request.action === 'resume' && goals.quota()) return { ok: false, code: goals.snapshot?.reason === 'storage' ? 'storage' : goals.snapshot?.billing?.unresolved ? 'accounting' : 'quota' }
    }
    let release: () => void
    try { release = managed.plan.beginWork('branch') } catch { return { ok: false, code: 'busy' } }
    try {
      if (!existsSync(managed.path)) this.materializeSession(managed.session.sessionManager)
      if (request.action === 'create') this.rememberFolder(managed.cwd)
      if (request.action === 'create') {
        managed.jevWorkflow?.resume()
        if (!await goals.create(request.objective.trim(), request.acceptance.trim(), request.limits, { images: request.images, files: request.files })) return { ok: false, code: goals.snapshot?.reason === 'storage' ? 'storage' : 'busy' }
      }
      else if (request.action === 'limits') goals.limits(request.limits)
      else {
        const owners = [managed.notifications, managed.askUser, managed.subagents?.notifications].filter(owner => owner != null)
        // Re-arm preserved answers before checking pending work, while holding
        // their idle wakes until explicit Resume grants goal execution.
        for (const owner of owners) { owner.holdWake(); owner.resume() }
        try { managed.jevWorkflow?.resume(); goals.resume() }
        finally { for (const owner of owners) owner.releaseWake() }
      }
      if (goals.snapshot?.reason === 'storage') return { ok: false, code: 'storage' }
      return { ok: true, goal: goals.snapshot, seq: goals.seq }
    } catch (error) { return { ok: false, code: error instanceof GoalInputError ? 'attachments' : 'storage' } }
    finally { release() }
  }

  /** Uses the same SDK continuation, wake ownership and checkout lease as Continue. */
  private async runGoal(managed: ManagedSession, content: string, initial: boolean, dispatchId: string,
    signal: AbortSignal, accepted: () => boolean, input?: GoalInput & Partial<PreparedGoalInput>): Promise<void> {
    const session = managed.session
    const owners = [managed.notifications, managed.askUser, managed.subagents?.notifications].filter(owner => owner != null)
    for (const owner of owners) { owner.holdWake(); owner.resume() }
    let releaseRun: (() => void) | undefined
    let settled!: () => void
    const done = new Promise<void>(resolve => { settled = resolve })
    let dispatchingInitial = false
    let initialMessage: object | null = null
    signal.addEventListener('abort', settled, { once: true })
    const unsubscribe = session.subscribe(event => { if (event.type === 'agent_settled') settled() })
    const unsubscribeStart = session.agent.subscribe(event => {
      if (event.type !== 'message_start' && event.type !== 'message_end') return
      const message = event.message
      if (initial && dispatchingInitial && message.role === 'user' && !initialMessage && event.type === 'message_start') {
        // Follow the actual SDK message identity, as Plan approval does;
        // input hooks, templates and image hints may rewrite the original text.
        initialMessage = message
      }
      const belongs = initial ? dispatchingInitial && message === initialMessage :
        message.role === 'custom' && message.customType === GOAL_STEP && (message.details as { dispatchId?: string } | undefined)?.dispatchId === dispatchId
      if (!belongs) return
      if (event.type === 'message_start' && (signal.aborted || this.closing || managed.disposing)) session.agent.abort()
      if (event.type === 'message_end') { managed.goals?.started(dispatchId); dispatchingInitial = false }
    })
    try {
      await managed.lifecyclePromise
      releaseRun = await this.checkoutCoordinator.enter(managed.cwd, 'run', managed.path, signal)
      if (!accepted() || signal.aborted || this.closing || managed.disposing) return
      managed.plan.checkWorkAdmission()
      managed.changeScopes.continue()
      if (initial) {
        const blocks = input?.fileBlocks ?? await this.readFileBlocks(input?.files ?? [], managed.cwd)
        if (!accepted() || signal.aborted || this.closing || managed.disposing) return
        dispatchingInitial = true
        let started = false
        await session.prompt(blocks ? `${content}\n\n${blocks}` : content, { images: input?.images,
          preflightResult: disposition => {
            if (disposition !== 'started') return
            if (!accepted() || signal.aborted || this.closing || managed.disposing) throw new Error('goal-dispatch-cancelled')
            started = true
          } })
        if (!started && !signal.aborted) { this.stopManaged(managed, 'error'); return }
      }
      else {
        const frontier = continuationTarget(this.transcriptOf(managed))
        const continued = frontier ? `${content}\n\n${continuationContent(frontier)}` : content
        await session.sendCustomMessage({ customType: GOAL_STEP, content: continued, display: false, details: { dispatchId } }, { triggerTurn: true })
      }
      // SDK prompt resolution can precede retries/compaction/follow-ups.
      await done
    } finally {
      signal.removeEventListener('abort', settled)
      unsubscribe(); unsubscribeStart(); releaseRun?.()
      for (const owner of owners) owner.releaseWake()
    }
  }

  /** Resume the interrupted frontier using its original context and scope. */
  async continueMessage(payload: ContinuePayload): Promise<void> {
    const managed = this.activeSession
    if (!managed || managed.path !== payload.sessionPath || managed.subagentChild || managed.scheduledTask) throw new Error('continue-stale-session')
    const session = managed.session
    if (managed.continuationRequest || managed.imageReplay || !session.isIdle) throw new Error('continue-busy')
    const target = continuationTarget(this.transcriptOf(managed))
    if (!target || target.timestamp !== payload.timestamp) throw new Error('continue-stale-turn')
    // A continuation cannot lift a submitted plan's seal or bypass approval.
    if (managed.plan.branchWork) throw new Error('continue-busy')
    const releasePlan = managed.plan.beginWork('background')
    managed.goals?.userPrompt()
    const request = managed.continuationRequest = new AbortController()
    const owners = [managed.notifications, managed.askUser, managed.subagents?.notifications].filter(owner => owner != null)
    for (const owner of owners) { owner.holdWake(); owner.resume() }
    let releaseRun: (() => void) | undefined
    // Rewind's SDK wrappers can await checkout admission once more. Stop in
    // that window must reach the fresh agent signal before any model/tool work.
    const unsubscribe = session.agent.subscribe(event => {
      if (event.type === 'message_start' && event.message.role === 'custom' &&
        event.message.customType === CONTINUATION_MESSAGE_TYPE &&
        (request.signal.aborted || this.closing || managed.disposing)) session.agent.abort()
    })
    try {
      await managed.lifecyclePromise
      releaseRun = await this.checkoutCoordinator.enter(managed.cwd, 'run', managed.path, request.signal)
      if (request.signal.aborted || this.closing || managed.disposing || !managed.notifications.canStart) return
      managed.plan.checkWorkAdmission()
      if (!session.isIdle || continuationTarget(this.transcriptOf(managed))?.timestamp !== payload.timestamp) throw new Error('continue-stale-turn')
      // A hidden custom message uses the normal SDK run/auto-retry/compaction
      // lifecycle without a user bubble, new checkpoint, or branch rewrite.
      managed.jevWorkflow?.resume()
      await session.sendCustomMessage({
        customType: CONTINUATION_MESSAGE_TYPE,
        content: continuationContent(target),
        display: false,
        details: { timestamp: target.timestamp }
      }, { triggerTurn: true })
    } catch (error) {
      if (!request.signal.aborted) throw error
    } finally {
      unsubscribe()
      releaseRun?.()
      if (managed.continuationRequest === request) managed.continuationRequest = undefined
      releasePlan()
      for (const owner of owners) owner.releaseWake()
    }
  }

  /**
   * Resend a user message — also the engine of "retry this response": rewind
   * the session to just before the message (navigateTree stays in the same
   * file; the abandoned branch remains in the session tree) and immediately
   * re-prompt with the stored text and image attachments. A message that never
   * persisted (a failed send left only the renderer's optimistic echo) is
   * simply re-prompted without rewinding.
   */
  async resendMessage(payload: ResendPayload): Promise<SessionSnapshotDTO> {
    const managed = this.activeSession
    const session = managed?.session
    if (!managed || !session) throw new Error('No active session')
    if (managed.subagentChild) throw new Error('A subagent session is read-only')
    if (managed.scheduledTask) throw new Error('A scheduled task session is read-only')
    if (managed.continuationRequest && session.isIdle) throw new Error('continue-busy')
    if (managed.plan.branchWork) throw new Error('Wait for the current branch operation')
    const replay = managed.imageReplay
    replay?.controller.abort()
    // Branch move + fresh user turn: reserve before the first await, and keep
    // the user registration so the new turn can lift a submission seal.
    const releasePlanWork = managed.plan.beginWork('user')
    managed.goals?.pause('rewound')
    try {
      await replay?.promise
      await managed.lifecyclePromise
      const release = await this.checkoutCoordinator.enter(managed.cwd, 'run', managed.path)
      try {
        if (this.closing || managed.disposing) throw new Error('Session is shutting down')
        if (session.isStreaming) throw new Error('Wait for the current response to finish')
        // Rewinding a branch invalidates every old task notification — and every
        // subagent run of the discarded branch: stop it NOW (awaited — the retry
        // re-prompts immediately) and suppressed, so a late completion cannot
        // wake the branch the user rewound to.
        managed.notifications?.pause()
        managed.subagents?.notifications?.pause()
        await this.subagentRuntime.stopAll(managed.subagents)
        await this.commandTasksInstance?.stopSession(managed.path)
        await this.debugManagerInstance?.stopSession(managed.path)
        session.clearQueue?.()

        let text = payload.text
        let images = payload.images
        const entry = this.findMessageEntry(managed, 'user', payload.timestamp)
        if (entry) {
          // The plain retry path re-sends exactly what is stored (text, images and
          // the already-inlined file blocks); the edit path sends the user's new
          // text/images/files instead, so it must not be overwritten here.
          if (!payload.edited) {
            const content = Array.isArray(entry.message.content) ? entry.message.content : []
            images = content.filter((part): part is ImageContent => part.type === 'image')
          }
          const sessionManager = session.sessionManager
          if (sessionManager.getLeafId() === entry.id) {
            // The user message is already the leaf — its run died before any
            // assistant output — so navigateTree(targetId) would no-op. Rewind by
            // hand the way it does internally: move the leaf to the parent (or
            // reset to an empty root) and rebuild the agent's message list.
            if (entry.parentId) sessionManager.branch(entry.parentId)
            else sessionManager.resetLeaf()
            session.refreshContext()
          } else {
            const result = await session.navigateTree(entry.id)
            if (result.cancelled) throw new Error('Resend cancelled')
            // navigateTree hands back the stored message text for the editor; an
            // edit must keep the user's replacement text instead.
            if (!payload.edited && result.editorText) text = result.editorText
          }
          // navigateTree (and the manual rewind) emit no AgentSession event; bump
          // the sequence so the renderer cannot mistake the returned snapshot for
          // one it already rendered.
          managed.eventSequence += 1
          managed.todos.restore()
          managed.askRecords.restore()
          // The branch moved, so the mode must be re-folded like the todos: the
          // recorded mode is a fact about the SELECTED branch, and a stale live
          // value here would silently widen on the next reopen.
          managed.sandboxMode = sandboxModeFromBranch(sessionManager.getBranch(), this.defaultSandboxMode)
          managed.plan.restore()
          managed.goals?.restore('rewound')
          managed.planApproval?.recover()
        }
        // Edited file references are re-inlined from disk (fresh content) — the
        // retry path carries its blocks inside the stored text already.
        if (payload.edited && payload.files?.length) {
          const fileBlocks = await this.readFileBlocks(payload.files, managed.cwd)
          if (fileBlocks) text = text ? `${text}\n\n${fileBlocks}` : fileBlocks
        }
        if (!text && !images.length) throw new Error('Nothing to resend')

        managed.goals?.userPrompt()
        managed.notifications?.resume()
        managed.subagents?.notifications?.resume()
        managed.notifications?.holdWake()
        managed.subagents?.notifications?.holdWake()
        void session.prompt(text, { images }).catch((error) =>
          this.emitSessionError(managed, error)
        ).finally(() => { managed.notifications?.releaseWake(); managed.subagents?.notifications?.releaseWake() })
        return this.snapshot()
      } finally { release() }
    } finally {
      releasePlanWork()
    }
  }

  /**
   * Fork the active session at an assistant message: the new file contains the
   * branch up to and including that message, is opened as the active session
   * and shows up in the sidebar like any other session. The fork keeps the
   * source's label (name or first user message) so the renderer can compose
   * the "Fork of …" title.
   */
  async forkFromMessage(timestamp: number): Promise<ForkResultDTO> {
    const managed = this.activeSession
    if (!managed) throw new Error('No active session')
    if (managed.subagentChild) throw new Error('A subagent session is read-only')
    if (managed.scheduledTask) throw new Error('A scheduled task session is read-only')
    const release = managed.plan.beginWork('branch')
    try {
      const entry = this.findMessageEntry(managed, 'assistant', timestamp)
      if (!entry) throw new Error('Message not found')
      const sessionManager = managed.session.sessionManager
      const file = sessionManager.getSessionFile()
      if (!file || !existsSync(file)) throw new Error('The session has not been saved yet')
      managed.goals?.checkpointAccounting()

      // The SDK switches the receiver's file/id/branch when forking. Keep the
      // live source manager untouched, or it will append to the fork even after
      // that fork is deleted (recreating a message-only file without a header).
      const forkManager = SessionManager.open(file)
      const forkedPath = forkManager.createBranchedSession(entry.id)
      if (!forkedPath) throw new Error('Failed to create the forked session')
      for (const path of [forkedPath, dirname(forkedPath)]) {
        const fd = openSync(path, 'r')
        try { fsyncSync(fd) } finally { closeSync(fd) }
      }
      const sourceAccounting = new GoalStorage(app.getPath('userData'), sessionManager.getSessionId())
      const forkAccounting = new GoalStorage(app.getPath('userData'), forkManager.getSessionId())
      const inheritedIds = new Set(forkManager.getBranch().flatMap(e => {
        const inherited = e.type === 'custom' && e.customType === GOAL_ENTRY ? goalFromBranch([e]) : null
        return inherited ? [inherited.id] : []
      }))
      for (const id of inheritedIds) forkAccounting.linkFork(sourceAccounting, id)

      let baseLabel = managed.session.sessionName?.trim() || null
      if (!baseLabel) {
        for (const candidate of sessionManager.getBranch()) {
          if (candidate.type !== 'message') continue
          const message = candidate.message as { role?: string; content?: unknown }
          if (message.role !== 'user') continue
          const content = message.content
          baseLabel =
            (typeof content === 'string'
              ? content
              : Array.isArray(content)
                ? (content as { type: string; text?: string }[])
                    .filter((part) => part.type === 'text')
                    .map((part) => part.text ?? '')
                    .join('\n')
                : ''
            )
              ?.trim()
              .slice(0, 80) || null
          break
        }
      }

      const navigationEpoch = ++this.navigationEpoch
      await this.buildSession(SessionManager.open(forkedPath), true, navigationEpoch)
      return { snapshot: this.snapshot(), baseLabel }
    } finally { release() }
  }

  abort(): void {
    const managed = this.activeSession
    if (!managed) return
    this.stopManaged(managed, 'stopped')
  }

  private stopManaged(managed: ManagedSession, reason: GoalReason): void {
    if (reason !== 'criteria') managed.goalEdit?.abort()
    managed.goals?.pause(reason === 'criteria' ? 'user' : reason)
    managed.manualCompaction?.cancel()
    managed.continuationRequest?.abort()
    managed.imageReplay?.controller.abort()
    managed.jevWorkflow?.cancel()
    managed.planApproval?.cancelOpening()
    managed.userAborted = true
    managed.notifications.pause()
    managed.askUser.pause()
    // Stop closes the wake path BEFORE aborting: a subagent completing during
    // or after the stop must not restart the conversation.
    managed.subagents?.notifications?.pause()
    if (managed.subagents) this.subagentRuntime.abortAll(managed.subagents)
    managed.session.clearQueue()
    void this.commandTasksInstance?.stopSession(managed.path)
    void this.debugManagerInstance?.stopSession(managed.path)
    void managed.session.abort().catch(() => {})
  }

  async setModel(providerId: string, modelId: string): Promise<SessionSnapshotDTO> {
    const managed = this.activeSession
    if (managed?.imageReplay) throw new Error('image-retry-busy')
    if (managed?.subagentChild) throw new Error('A subagent session is read-only')
    if (managed?.scheduledTask) throw new Error('A scheduled task session is read-only')
    if (managed) this.assertMidRunChangeAllowed(managed)
    const runtime = await this.runtime()
    const model = runtime.getModel(providerId, modelId)
    if (!model) throw new Error(`Unknown model ${providerId}/${modelId}`)
    if (managed) {
      await managed.session.setModel(model)
      return this.snapshot()
    }
    throw new Error('No active session')
  }

  async setThinkingLevel(level: ThinkingLevel): Promise<SessionSnapshotDTO> {
    if (this.activeSession?.imageReplay) throw new Error('image-retry-busy')
    if (this.activeSession?.subagentChild) throw new Error('A subagent session is read-only')
    if (this.activeSession?.scheduledTask) throw new Error('A scheduled task session is read-only')
    if (!this.activeSession) throw new Error('No active session')
    this.assertMidRunChangeAllowed(this.activeSession)
    this.activeSession.session.setThinkingLevel(level)
    return this.snapshot()
  }

  async providers(): Promise<ProviderDTO[]> {
    const runtime = await this.runtime()
    const config = readModelsConfig()
    const builtinIds = await builtinProviderIds()
    const builtinBaseUrls = await builtinProviderBaseUrls()
    const providers: ProviderDTO[] = []
    const seen = new Set<string>()
    for (const provider of runtime.getProviders()) {
      const auth = provider.auth as any
      const authTypes: ('api_key' | 'oauth')[] = []
      if (auth?.apiKey) authTypes.push('api_key')
      if (auth?.oauth) authTypes.push('oauth')
      const check = await runtime.checkAuth(provider.id).catch(() => undefined)
      const providerModels = provider.getModels()
      const api = (providerModels[0] as any)?.api as string | undefined
      const custom = Object.prototype.hasOwnProperty.call(config.providers, provider.id)
      providers.push({
        id: provider.id,
        name: provider.name,
        authTypes,
        authenticated: Boolean(check),
        authSource: check?.source,
        canLogin: Boolean(auth?.apiKey?.login) || Boolean(auth?.oauth?.login),
        builtin: builtinIds.has(provider.id),
        custom,
        api,
        baseUrl: builtinBaseUrls.get(provider.id),
        discoverable: custom
          ? supportsModelDiscovery(config.providers[provider.id]?.api ?? api)
          : supportsModelDiscovery(api),
        modelCount: providerModels.length
      })
      seen.add(provider.id)
    }
    // models.json entries that did not compose (brand-new, or not yet valid
    // enough for the runtime) still need a row so the user can finish or fix
    // them in the editor.
    for (const [providerId, entry] of Object.entries(config.providers)) {
      if (seen.has(providerId)) continue
      providers.push({
        id: providerId,
        name: entry.name || providerId,
        authTypes: [],
        authenticated: false,
        canLogin: false,
        builtin: builtinIds.has(providerId),
        custom: true,
        api: entry.api,
        baseUrl: entry.baseUrl ?? builtinBaseUrls.get(providerId),
        discoverable: Boolean(entry.baseUrl) && supportsModelDiscovery(entry.api),
        // Not composed yet: count the carriers the user added (blank-id
        // drafts are not real models).
        modelCount: (entry.models ?? []).filter(
          (model) => typeof model?.id === 'string' && model.id.trim().length > 0
        ).length
      })
    }
    return providers
  }

  // ---- models.json editing (Settings → Providers) ----

  modelsConfig(): ModelsConfigDTO {
    return readModelsConfig()
  }

  /** Persist the edited config and reload the shared runtime in place, so
   * every session built on it sees new providers/models immediately. */
  async saveModelsConfig(config: ModelsConfigDTO): Promise<ModelsConfigDTO> {
    const written = writeModelsConfig(config)
    await (await this.runtime()).refresh()
    return written
  }

  async providerModels(providerId: string): Promise<ProviderModelDTO[]> {
    return providerInventory(await this.runtime(), providerId)
  }

  async discoverProviderModels(providerId: string): Promise<DiscoveredModelDTO[]> {
    return discoverModels(providerId, await this.runtime())
  }

  async testProviderModel(providerId: string, model: CustomModelDTO): Promise<TestModelResultDTO> {
    return testModel(providerId, model)
  }

  /** models.dev parameter preset for a model id, matched to this provider. */
  async catalogPreset(providerId: string, modelId: string): Promise<CatalogRecommendationDTO> {
    const entry = readModelsConfig().providers[providerId]
    const baseUrl = entry?.baseUrl ?? (await this.runtime()).getProvider(providerId)?.getModels()[0]?.baseUrl ?? ''
    return recommendCatalogPreset(modelId, providerId, baseUrl ?? '')
  }

  /** Composed models of configured providers — the copy-config source list. */
  async configuredModelSources(): Promise<ModelConfigSourceDTO[]> {
    return configuredModels(await this.runtime())
  }

  // ---- default model (~/.pi/agent/settings.json, shared with the pi CLI) ----

  private settingsManager(): SettingsManager {
    this.settingsManagerInstance ??= SettingsManager.create(this.cwd ?? homedir())
    return this.settingsManagerInstance
  }

  defaultModel(): DefaultModelDTO | null {
    const manager = this.settingsManager()
    const providerId = manager.getDefaultProvider()
    const modelId = manager.getDefaultModel()
    return providerId && modelId ? { providerId, modelId } : null
  }

  async setDefaultModel(providerId: string, modelId: string): Promise<void> {
    const manager = this.settingsManager()
    manager.setDefaultModelAndProvider(providerId, modelId)
    await manager.flush()
  }

  // ---- global append prompt (~/.pi/agent/APPEND_SYSTEM.md) ----

  appendPrompt(): AppendPromptDTO {
    return { path: appendPromptPath(), text: readAppendPrompt() }
  }

  /**
   * Write the global append prompt and reload the live sessions so it reaches
   * their NEXT turn without a restart.
   */
  async setAppendPrompt(text: string): Promise<AppendPromptDTO> {
    writeAppendPrompt(text)
    await this.reloadLiveSessions()
    return this.appendPrompt()
  }

  /**
   * Toggle the browser_* agent tools. The 14 tools register whenever the
   * browser service exists (service-gated at build — registration can never
   * change for a live session); this flag only decides the ACTIVE set, and
   * live sessions reach it through the setAppendPrompt reload walk: an idle
   * session reloads now, a streaming one defers to `agent_settled`
   * (reloading mid-run would swap the extension runner under an in-flight
   * request). Because the SDK's reload re-activates every registered tool,
   * reloadManagedSession re-applies the active set AFTER it resolves — that
   * re-application is what removes the browser_* names when the flag goes
   * off (and is a harmless no-op when it goes on). ipc.ts persists the
   * preference; this only applies it.
   */
  async setBrowserAgentTools(enabled: boolean): Promise<void> {
    this.browserToolsFlag = enabled === true
    await this.reloadLiveSessions()
  }

  /** Toggle the DAP debugger. Same shape as the browser-tools toggle: ipc.ts
   * persists the preference, the flag is read when the active set is applied,
   * and reloading live sessions is what exposes or hides the tool. */
  async setDebugEnabled(enabled: boolean): Promise<void> {
    this.debugEnabledFlag = enabled === true
    await this.reloadLiveSessions()
  }

  // ---- context files (AGENTS.md / CLAUDE.md) ----

  contextFilesEnabled(): boolean {
    return this.includeContextFiles
  }

  /**
   * Toggle injection of AGENTS.md/CLAUDE.md context files. The resource-loader
   * override reads this flag live, so reloading each session re-derives its
   * system prompt without rebuilding the shared services.
   */
  async setContextFilesEnabled(enabled: boolean): Promise<boolean> {
    this.includeContextFiles = enabled
    saveSettings({ ...loadSettings(), contextFiles: enabled })
    await this.reloadLiveSessions()
    return this.includeContextFiles
  }

  // ---- tools & extensions (Settings → Tools / Extensions) ----

  /**
   * The tools + extensions catalog for the active workspace. Reads the real
   * (unfiltered) loader so a disabled extension still appears, with its tools
   * listed but inactive. Built-ins, active-tool membership and lazily
   * registered extension tools come from the live session's registry, while
   * package details (installed path, version, bundled skills) are resolved
   * through the package manager.
   */
  async catalog(): Promise<ToolCatalogDTO> {
    const managed = this.activeSession
    const cwd = managed?.cwd
    const loader = managed?.resourceLoader
    if (!cwd || !loader) {
      return { tools: [], extensions: [], skills: [], skillDiagnostics: [] }
    }
    await managed.lifecyclePromise
    const session = managed.session
    // Native MCP can register tools after initialization. Include exposure as
    // well as names: editing a server's direct/deferred/codemode mode changes
    // the Settings catalog even when its tool names stay the same.
    const sessionTools = session?.getAllTools() ?? []
    const registeredTools = sessionTools.map((tool) => `${tool.name}:${tool.exposure ?? 'direct'}`).sort().join('\u0001')
    const activeToolNames = session?.getActiveToolNames() ?? []
    // The effective view is part of the cache key: leaving/entering Plan must
    // invalidate a catalog that still describes the other mode's active rows.
    const effectiveTools = (managed.gate?.tools() ?? []).map((entry) => ({
      name: entry.name,
      description: entry.tool.description ?? '',
      parameters: entry.tool.parameters,
      ...(entry.definition?.promptGuidelines ? { promptGuidelines: [...entry.definition.promptGuidelines] } : {}),
      provenance: entry.provenance
    }))
    const key = `${managed.path}\u0000${[...this.disabledExtensions].sort().join('\u0000')}\u0000${registeredTools}\u0000${activeToolNames.join(',')}\u0000${effectiveTools.map((tool) => `${tool.name}:${tool.provenance}`).join(',')}`
    if (this.catalogCache?.key === key) return this.catalogCache.value
    const packages = await loadPackageResources(cwd, getAgentDir()).catch(
      () => new Map<string, PackageResources>()
    )
    const value = buildToolCatalog(
      loader,
      sessionTools,
      activeToolNames,
      this.disabledExtensions,
      packages,
      this.knownExtensionTools,
      effectiveTools
    )
    this.catalogCache = { key, value }
    return value
  }

  // ---- skills (Settings → Skills) ----

  /**
   * Toggle a skill's `disable-model-invocation` frontmatter key. Only paths the
   * current loader actually knows are accepted, so a renderer bug can't turn
   * this into an arbitrary file write. The system prompt is rebuilt afterwards
   * (skills are formatted into it), hence the session reload.
   */
  async setSkillModelInvocation(
    filePath: string,
    disableModelInvocation: boolean
  ): Promise<ToolCatalogDTO> {
    const loader = this.activeSession?.resourceLoader
    if (!loader || !loader.getSkills().skills.some((skill) => skill.filePath === filePath)) {
      throw new Error('Unknown skill file')
    }
    const content = readFileSync(filePath, 'utf8')
    writeFileSync(filePath, setDisableModelInvocation(content, disableModelInvocation), 'utf8')
    this.catalogCache = null
    await this.reloadLiveSessions()
    return this.catalog()
  }

  /** SKILL.md text for the Settings → Skills preview (validated like the toggle). */
  readSkill(filePath: string): SkillContentDTO {
    const loader = this.activeSession?.resourceLoader
    if (!loader || !loader.getSkills().skills.some((skill) => skill.filePath === filePath)) {
      throw new Error('Unknown skill file')
    }
    const handle = readFileSync(filePath)
    const truncated = handle.byteLength > MAX_SKILL_BYTES
    return {
      path: filePath,
      text: (truncated ? handle.subarray(0, MAX_SKILL_BYTES) : handle).toString('utf8'),
      truncated
    }
  }

  /**
   * Persist an extension's enabled state (app-local; the pi CLI's package
   * config is untouched) and reload the live sessions so the runner is rebuilt
   * from the filtered loader. A streaming session defers to `agent_settled`.
   *
   * Disabling snapshots the tools the extension had registered at runtime
   * first: a lazily-registering extension (pi-fff) only appears on the session
   * registry, so without the snapshot its tools would vanish from the catalog.
   */
  async setExtensionEnabled(id: string, enabled: boolean): Promise<ToolCatalogDTO> {
    if (!enabled && !this.disabledExtensions.has(id)) {
      const before = await this.catalog()
      const owned = before.tools.filter((tool) => tool.source.extensionId === id)
      if (owned.length > 0) this.knownExtensionTools.set(id, owned)
    }
    if (enabled) this.disabledExtensions.delete(id)
    else this.disabledExtensions.add(id)
    saveSettings({ ...loadSettings(), disabledExtensions: [...this.disabledExtensions] })
    this.catalogCache = null
    await this.reloadLiveSessions()
    return this.catalog()
  }

  // ---- extension package actions (Settings → Extensions) ----

  /**
   * Update the package behind an extension through the SDK's package manager
   * (npm install / git pull), then rebuild the live sessions so new code and
   * tools take effect. Throws with the manager's message on failure.
   */
  async updateExtension(source: string): Promise<ToolCatalogDTO> {
    const cwd = this.requireCwd()
    await this.packageManagerFor(cwd).update(source)
    return this.reloadAfterPackageChange()
  }

  /** Uninstall a package: it is removed from the pi settings and the live
   * sessions reload without it. */
  async removeExtension(source: string): Promise<ToolCatalogDTO> {
    const cwd = this.requireCwd()
    await this.packageManagerFor(cwd).removeAndPersist(source)
    return this.reloadAfterPackageChange()
  }

  /** Install a new package by source (`npm:…`, `git:…`, a local path). */
  async installExtension(source: string): Promise<ToolCatalogDTO> {
    const cwd = this.requireCwd()
    await this.packageManagerFor(cwd).installAndPersist(source)
    return this.reloadAfterPackageChange()
  }

  private requireCwd(): string {
    if (!this.cwd) throw new Error('No workspace is open')
    return this.cwd
  }
  private packageManagerFor(cwd: string): DefaultPackageManager {
    const agentDir = getAgentDir()
    return new DefaultPackageManager({
      cwd,
      agentDir,
      settingsManager: SettingsManager.create(cwd, agentDir)
    })
  }

  /**
   * After a package install/update/remove: drop the cached catalog, prune
   * disabled ids whose extension no longer exists, and reload the sessions.
   * `listConfiguredPackages` reads the settings before the next resolve, so the
   * prune uses the freshly loaded extension list.
   */
  private async reloadAfterPackageChange(): Promise<ToolCatalogDTO> {
    this.catalogCache = null
    this.knownExtensionTools.clear()
    await this.reloadLiveSessions()
    const loader = this.activeSession?.resourceLoader
    if (loader) {
      const present = new Set(
        loader.getExtensions().extensions.map((extension) => extensionId(extension))
      )
      const next = [...this.disabledExtensions].filter((id) => present.has(id))
      if (next.length !== this.disabledExtensions.size) {
        this.disabledExtensions = new Set(next)
        saveSettings({ ...loadSettings(), disabledExtensions: next })
      }
    }
    return this.catalog()
  }

  // ---- MCP servers (Settings → MCP; Pi's native extension) ----

  /** Native connection facts and registered tools of the selected session.
   * Tool registrations survive disconnects, so they never imply connectivity. */
  private mcpLiveTools(): Map<string, { name?: string; status: McpRuntimeStatus; tools: McpToolDTO[] }> {
    const live = new Map<string, { name?: string; status: McpRuntimeStatus; tools: McpToolDTO[] }>()
    const managed = this.activeSession
    if (!managed || managed.disposing || managed.subagentChild) return live
    for (const [key, server] of this.mcpRuntimeStatuses.get(managed.resourceLoader) ?? []) {
      live.set(key, { ...server, tools: [] })
    }
    for (const tool of managed.session.getAllTools()) {
      const namespace = tool.namespace?.name
      if (!namespace?.startsWith('mcp__') || tool.exposure === 'hidden') continue
      const name = namespace.slice('mcp__'.length)
      // The SDK keeps the full namespace but shortens long tool identifiers
      // with a hash. The namespace remains the authoritative server owner.
      if (!name || !tool.name.startsWith('mcp__')) continue
      let entry = live.get(name)
      if (!entry) { entry = { status: 'configured', tools: [] }; live.set(name, entry) }
      if (entry.tools.some(existing => existing.name === tool.name)) continue
      entry.tools.push({
        name: tool.name,
        description: tool.description,
        inputSchema: JSON.parse(JSON.stringify(tool.parameters ?? {})) as Record<string, unknown>,
        exposure: tool.exposure as McpToolDTO['exposure']
      })
    }
    for (const entry of live.values()) entry.tools.sort((a, b) => a.name.localeCompare(b.name))
    return live
  }

  /** Sequence-free settings push on native state, tool or selected-session changes. */
  private mcpStatusKey = ''
  private publishMcpStatusIfChanged(): void {
    if (this.closing) return
    const cwd = this.activeSession?.cwd
    if (!cwd) return
    const agentDir = getAgentDir()
    const projectTrusted = SettingsManager.create(cwd, agentDir).isProjectTrusted()
    const rows = buildMcpRoster({ cwd, agentDir, projectTrusted, live: this.mcpLiveTools() })
    const push: McpStatusPushDTO = { cwd, sessionPath: this.activeSession!.path, servers: rows.map(row => ({
      name: row.name, status: row.status ?? 'configured', toolCount: row.toolCount, disabled: row.disabled
    })) }
    const key = JSON.stringify(push)
    if (key === this.mcpStatusKey) return
    this.mcpStatusKey = key
    this.emit('pi:mcp-status', push)
  }

  /** Editable native config plus SDK-discovered tools, with truthful status. */
  async mcpState(): Promise<McpStateDTO> {
    const cwd = this.activeSession?.cwd ?? null
    const agentDir = getAgentDir()
    const projectTrusted = cwd ? SettingsManager.create(cwd, agentDir).isProjectTrusted() : false
    return {
      projectCwd: cwd,
      sessionPath: this.activeSession?.path ?? null,
      projectTrusted,
      global: readMcpConfigFile('global', null, agentDir)!,
      project: readMcpConfigFile('project', cwd, agentDir),
      servers: buildMcpRoster({ cwd, agentDir, projectTrusted, live: this.mcpLiveTools() }),
      configIssues: readMcpConfigIssues(cwd, agentDir, projectTrusted)
    }
  }

  /** The project file participates in MCP only after Pi trusts the project. */
  private assertMcpProjectWriteAllowed(cwd: string | null, agentDir: string, targetPath: string | null): void {
    if (!cwd || targetPath !== join(cwd, '.pi', 'mcp.json')) return
    if (!SettingsManager.create(cwd, agentDir).isProjectTrusted()) {
      throw new Error('Trust this project before editing its MCP configuration')
    }
  }

  /**
   * Save one config file's raw text (the JSON editor) and rebuild the live
   * sessions so native MCP re-reads it. Throws on invalid JSON; the renderer
   * validates first, so a throw here is a bug or a race.
   */
  async writeMcpConfig(scope: 'global' | 'project', content: string): Promise<McpStateDTO> {
    const cwd = this.activeSession?.cwd ?? null
    const agentDir = getAgentDir()
    if (scope === 'project') this.assertMcpProjectWriteAllowed(cwd, agentDir, cwd ? join(cwd, '.pi', 'mcp.json') : null)
    writeMcpConfigFile(scope, content, cwd, agentDir, cwd ? SettingsManager.create(cwd, agentDir).isProjectTrusted() : false)
    this.catalogCache = null
    await this.reloadLiveSessions()
    return this.mcpState()
  }

  /** Toggle one configured server's native `enabled` flag, then reload. */
  async setMcpServerDisabled(name: string, disabled: boolean): Promise<McpStateDTO> {
    const cwd = this.activeSession?.cwd ?? null
    const agentDir = getAgentDir()
    const projectTrusted = cwd ? SettingsManager.create(cwd, agentDir).isProjectTrusted() : false
    setMcpServerDisabled(name, disabled, { cwd, agentDir, projectTrusted })
    this.catalogCache = null
    await this.reloadLiveSessions()
    return this.mcpState()
  }

  /** One server's currently registered tools (native MCP has no public cache). */
  async mcpServerDetail(name: string): Promise<McpServerDetailDTO> {
    return mcpServerDetail(name, this.mcpLiveTools().get(mcpServerKey(name))?.tools ?? [])
  }

  /**
   * Save one server from the visual editor. The entry lands in its defining
   * file (or the chosen scope's default for a new server); main validates the
   * target path so a renderer bug cannot turn this into an arbitrary write.
   */
  async mcpUpsertServer(payload: McpUpsertServerPayload): Promise<McpStateDTO> {
    const cwd = this.activeSession?.cwd ?? null
    const agentDir = getAgentDir()
    this.assertMcpProjectWriteAllowed(cwd, agentDir, payload.targetPath ?? (payload.scope === 'project' && cwd ? join(cwd, '.pi', 'mcp.json') : null))
    upsertMcpServerEntry(payload, { cwd, agentDir, projectTrusted: cwd ? SettingsManager.create(cwd, agentDir).isProjectTrusted() : false })
    this.catalogCache = null
    await this.reloadLiveSessions()
    return this.mcpState()
  }

  /** Delete one server from its defining config file (path validated as editable). */
  async mcpDeleteServer(path: string, name: string): Promise<McpStateDTO> {
    const cwd = this.activeSession?.cwd ?? null
    const agentDir = getAgentDir()
    this.assertMcpProjectWriteAllowed(cwd, agentDir, path)
    deleteMcpServerEntry(path, name, { cwd, agentDir, projectTrusted: cwd ? SettingsManager.create(cwd, agentDir).isProjectTrusted() : false })
    this.catalogCache = null
    await this.reloadLiveSessions()
    return this.mcpState()
  }

  /**
   * Rebuild the resources and system prompt of every live session. Each owns
   * its loader/runtime; one that is mid-run defers to `agent_settled` (see
   * routeEvent), since reloading would swap the extension runner under an
   * in-flight request.
   */
  private async reloadManagedSession(managed: ManagedSession): Promise<void> {
    if (this.closing || managed.disposing) return
    const releasePlanWork = managed.plan.beginWork('branch')
    managed.notifications.holdWake()
    managed.askUser.holdWake()
    managed.subagents?.notifications?.holdWake()
    const previous = managed.lifecyclePromise
    const pending = (async () => {
      await previous
      if (this.closing || managed.disposing) return
      if (!managed.session.isIdle || managed.imageReplay) { managed.reloadPending = true; return }
      try {
        await managed.session.reload({ beforeSessionStart: () => {
          if (this.closing || managed.disposing) throw new Error('Session is shutting down')
          managed.gate?.bindExtensionRuntime(managed.resourceLoader.getExtensions().runtime)
        } })
        // reload() re-activated every registered tool (includeAllExtensionTools);
        // re-applying the active set AFTER it resolves is what removes the
        // browser_* names when the flag is now off — and re-pins children to
        // their frozen ceiling. The loader is filtered exactly as at startup
        // (initializeSession receives the filtered one too), so disabled
        // extensions' tools are not re-activated here either.
        this.applyActiveTools(managed, this.filterExtensions(managed.resourceLoader))
        managed.trajectory?.resetSystemPrompt()
        // A reload re-derives the session from disk; re-fold the Plan branch so
        // a mode/plan entry written outside this process is adopted (and an
        // unknown version keeps the session restricted).
        managed.plan.restore()
        managed.planApproval?.recover()
        if (!managed.recoveryOnly && !this.checkoutCoordinator.needsRecovery(managed.cwd)) {
          await hydrateImagePresentations(managed.session.sessionManager)
        }
      }
      catch { /* Keep the existing resource-reload error policy. */ }
      finally { this.catalogCache = null }
    })()
    managed.lifecyclePromise = pending
    try { await pending }
    finally {
      if (managed.lifecyclePromise === pending) managed.lifecyclePromise = null
      managed.notifications.releaseWake()
      managed.askUser.releaseWake()
      managed.subagents?.notifications?.releaseWake()
      releasePlanWork()
    }
  }

  private async reloadLiveSessions(): Promise<void> {
    for (const managed of [...this.sessions.values()]) {
      if (managed.session.isStreaming || managed.imageReplay) {
        managed.reloadPending = true
        continue
      }
      await this.reloadManagedSession(managed)
    }
  }

  async models(): Promise<ModelDTO[]> {
    const runtime = await this.runtime()
    // Hidden models stay usable by id (default model, sessions already on
    // them) but never appear in a selector.
    const hidden = hiddenModelKeys(readModelsConfig())
    const available = new Set(
      (await runtime.getAvailable().catch(() => [])).map((m: any) => `${m.provider}/${m.id}`)
    )
    const providerName = new Map(runtime.getProviders().map((p) => [p.id, p.name]))
    const models: ModelDTO[] = []
    for (const provider of runtime.getProviders()) {
      for (const model of provider.getModels()) {
        const anyModel = model as any
        if (hidden.has(`${anyModel.provider}/${anyModel.id}`)) continue
        models.push({
          providerId: anyModel.provider,
          providerName: providerName.get(anyModel.provider) ?? anyModel.provider,
          id: anyModel.id,
          name: anyModel.name ?? anyModel.id,
          reasoning: Boolean(anyModel.reasoning),
          thinkingLevels: !anyModel.reasoning ? ['off'] : (['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as ThinkingLevel[]).filter((level) => {
            const mapped = anyModel.thinkingLevelMap?.[level]
            if (mapped === null) return false
            return level === 'xhigh' || level === 'max' ? mapped !== undefined : true
          }),
          input: (anyModel.input ?? ['text']) as string[],
          contextWindow: anyModel.contextWindow ?? 0,
          maxTokens: anyModel.maxTokens ?? 0,
          available: available.has(`${anyModel.provider}/${anyModel.id}`),
          costInputPerM: (anyModel.cost?.input ?? 0) * 1_000_000,
          costOutputPerM: (anyModel.cost?.output ?? 0) * 1_000_000
        })
      }
    }
    return models
  }

  /**
   * Interactive login bridged to the renderer: pi asks questions through
   * `pi:auth-prompt` events and the renderer answers via `pi:auth-reply`.
   */
  async login(providerId: string, kind: 'api_key' | 'oauth'): Promise<void> {
    const runtime = await this.runtime()
    const provider = runtime.getProviders().find((p) => p.id === providerId)
    if (!provider) throw new Error(`Unknown provider ${providerId}`)

    // One login per provider: a new attempt supersedes a dangling one.
    this.loginAborts.get(providerId)?.abort()
    const controller = new AbortController()
    this.loginAborts.set(providerId, controller)

    const interaction = {
      signal: controller.signal,
      prompt: async (prompt: any): Promise<string> => {
        const requestId = `${providerId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`
        const normalizedKind =
          prompt.type === 'text'
            ? 'text'
            : prompt.type === 'secret'
              ? 'secret'
              : prompt.type === 'select'
                ? 'select'
                : 'manual_code'
        this.emit('pi:auth-prompt', {
          requestId,
          providerId,
          kind: normalizedKind,
          message: prompt.message,
          placeholder: prompt.placeholder,
          options: prompt.options
        })
        return new Promise<string>((resolve, reject) => {
          const signal: AbortSignal | undefined = prompt.signal
          const dismiss = () => this.emit('pi:auth-dismiss', { requestId })
          let timer: ReturnType<typeof setTimeout>
          const cleanup = () => {
            clearTimeout(timer)
            signal?.removeEventListener('abort', onAbort)
            this.pendingAuth.delete(requestId)
          }
          // The SDK can settle a prompt out of band (a manual-code prompt losing
          // a race to its callback server) — close the dialog then too.
          const onAbort = () => {
            cleanup()
            dismiss()
            reject(new Error('Login prompt cancelled'))
          }
          timer = setTimeout(() => {
            cleanup()
            dismiss()
            reject(new Error('Login timed out'))
          }, 5 * 60_000)
          if (signal?.aborted) {
            onAbort()
            return
          }
          signal?.addEventListener('abort', onAbort, { once: true })
          this.pendingAuth.set(requestId, {
            providerId,
            resolve: (value) => {
              cleanup()
              resolve(value)
            },
            reject: (error) => {
              cleanup()
              reject(error)
            }
          })
        })
      },
      // The SDK names the event field `type`; the DTO (and the renderer that
      // keys off it) uses `kind`. Forwarding it verbatim left `kind` undefined,
      // so the browser was never opened and the device-code/URL UI never showed.
      notify: (event: any) => {
        const { type, ...rest } = event ?? {}
        this.emit('pi:auth-notify', { providerId, kind: type, ...rest })
      }
    }

    try {
      await runtime.login(providerId, kind, interaction as any)
    } finally {
      if (this.loginAborts.get(providerId) === controller) this.loginAborts.delete(providerId)
      for (const [requestId, pending] of this.pendingAuth) {
        if (pending.providerId !== providerId) continue
        this.pendingAuth.delete(requestId)
        pending.reject(new Error('Login cancelled'))
      }
      // Settle/close whatever dialog the renderer opened for this login.
      this.emit('pi:auth-dismiss', { providerId })
    }
  }

  /** Cancel an in-flight login (the dialog's Cancel button / a superseding try). */
  cancelLogin(providerId: string): void {
    this.loginAborts.get(providerId)?.abort()
    // The provider may not have linked the flow's signal to the pending prompt,
    // so reject that too or the login would hang until the 5-minute timeout.
    for (const [requestId, pending] of this.pendingAuth) {
      if (pending.providerId !== providerId) continue
      this.pendingAuth.delete(requestId)
      pending.reject(new Error('Login cancelled'))
    }
  }

  /** Called by the IPC layer when the renderer answers a login prompt. */
  resolveAuthPrompt(reply: { requestId: string; value: string | null }): void {
    const pending = this.pendingAuth.get(reply.requestId)
    if (!pending) return
    if (reply.value === null || reply.value === undefined) {
      pending.reject(new Error('Login cancelled'))
    } else {
      pending.resolve(reply.value)
    }
  }

  async logout(providerId: string): Promise<void> {
    const runtime = await this.runtime()
    await runtime.logout(providerId)
  }

  async searchFiles(query: string) {
    if (!this.fileIndex) return []
    await this.fileIndex.refresh().catch(() => {})
    return this.fileIndex.search(query)
  }

  async readFile(path: string): Promise<FilePreviewDTO> {
    if (!this.fileIndex) throw new Error('No working directory selected')
    return readAttachment(this.fileIndex, path)
  }

  private rewindSession(path: string): ManagedSession {
    const managed = this.sessions.get(path)
    if (!managed || managed.disposing || this.closing) throw new RewindFailure('missing')
    return managed
  }

  private async rewindResult<T>(operation: () => Promise<T>): Promise<RewindResult<T>> {
    try { return { value: await operation() } } catch (error) { return { error: rewindFailure(error) } }
  }

  /**
   * Why a restore is refused right now, as one named reason. The order is what
   * the user acts on first: an unfinished recovery outranks everything, an open
   * terminal is closable, a queued message is recallable, then work that can
   * write the checkout, and a plain model turn last — that one ends by itself.
   * Undefined means nothing blocks.
   */
  private rewindBusyReason(managed: ManagedSession): RewindBusyReason | undefined {
    if (managed.plan.transitionBusy) return 'work'
    if (managed.session.getSteeringMessages().length || managed.session.getFollowUpMessages().length) return 'queued'
    const blockers = this.checkoutCoordinator.restoreBlockers(managed.cwd)
    if (blockers.recovery) return 'recovery'
    if (blockers.terminal) return 'terminal'
    if (blockers.writers > 0 || blockers.exclusive || blockers.closing) return 'work'
    if (blockers.runs > 0) return 'turn'
    return undefined
  }

  rewindList(path: string): Promise<RewindResult<RewindListDTO>> {
    return this.rewindResult(async () => {
      const managed = this.rewindSession(path)
      const list = await this.rewindClient.call('list', managed.cwd, managed.session.sessionId)
      this.checkoutCoordinator.setRecovery(managed.cwd, list.pending[0]?.id)
      const busyReason = this.rewindBusyReason(managed)
      return { ...list, checkpoints: list.checkpoints.filter(cp => cp.trigger === 'before-turn'), enabled: loadSettings().checkpointsEnabled !== false,
        busy: busyReason !== undefined, busyReason, error: this.checkoutCoordinator.restoreError() ?? managed.rewind?.error }
    })
  }

  rewindPreview(path: string, checkpointId: string, action?: 'undo' | 'redo'): Promise<RewindResult<RewindPreviewDTO>> {
    return this.rewindResult(async () => {
      const managed = this.rewindSession(path)
      if (action !== undefined && action !== 'undo' && action !== 'redo') throw new RewindFailure('missing')
      if (!action) {
        const list = await this.rewindClient.call('list', managed.cwd, managed.session.sessionId)
        if (!list.checkpoints.some(cp => cp.id === checkpointId && cp.trigger === 'before-turn')) throw new RewindFailure('unsupported')
      }
      const leaf = managed.session.sessionManager.getLeafId()
      const value = await this.rewindClient.call('preview', managed.cwd, managed.session.sessionId, checkpointId, action)
      const navigation = await this.rewindClient.call('navigation', managed.cwd, managed.session.sessionId, value.token)
      if (!action && value.scopeRoot) {
        const direct = await uncoveredWrites(managed.session.sessionManager.getBranch(), managed.cwd, value.scopeRoot, navigation.after, value.excluded)
        // Child-session writes are invisible to the branch scan (the parent
        // only sees the `agent` tool call): collect their successful written
        // records and classify them under the same scope/excluded rules.
        const subagentPaths = await this.subagentRuntime.collectSubagentWritePaths(
          managed.session.sessionManager, managed.cwd, navigation.after)
        const subagentUncovered = await classifyUncoveredWrites(subagentPaths, value.scopeRoot, value.excluded)
        const seen = new Set(direct.map((item) => item.path))
        value.uncovered = [...direct, ...subagentUncovered.filter((item) => !seen.has(item.path))]
      }
      if (leaf !== managed.session.sessionManager.getLeafId()) throw new RewindFailure('changed')
      if (this.rewindPreviews.size >= 100) this.rewindPreviews.delete(this.rewindPreviews.keys().next().value!)
      this.rewindPreviews.set(value.token, { path, leaf, target: navigation.after, file: value.file, uncovered: value.uncovered })
      return value
    })
  }

  rewindPatch(path: string, token: string, file: string, area: 'worktree' | 'index', stage = 0): Promise<RewindResult<RewindPatchDTO>> {
    return this.rewindResult(async () => {
      const managed = this.rewindSession(path)
      if (!Number.isInteger(stage) || stage < 0 || stage > 3) throw new RewindFailure('missing')
      if (area !== 'worktree' && area !== 'index') throw new RewindFailure('missing')
      return this.rewindClient.call('patch', managed.cwd, managed.session.sessionId, token, file, area, stage)
    })
  }

  rewindStats(path: string, token: string, file: string, area: 'worktree' | 'index', stage = 0): Promise<RewindResult<RewindStatsDTO>> {
    return this.rewindResult(async () => {
      const managed = this.rewindSession(path)
      if (!Number.isInteger(stage) || stage < 0 || stage > 3 || (area !== 'worktree' && area !== 'index')) throw new RewindFailure('missing')
      return this.rewindClient.call('stats', managed.cwd, managed.session.sessionId, token, file, area, stage)
    })
  }

  rewindPreviewFile(path: string, token: string, file: string): Promise<RewindResult<RewindPreviewDTO>> {
    return this.rewindResult(async () => {
      const managed = this.rewindSession(path), known = this.rewindPreviews.get(token)
      if (!known || known.path !== managed.path) throw new RewindFailure('expired')
      if (known.leaf !== managed.session.sessionManager.getLeafId()) throw new RewindFailure('changed')
      const value = await this.rewindClient.call('previewFile', managed.cwd, managed.session.sessionId, token, file)
      if (known.leaf !== managed.session.sessionManager.getLeafId()) throw new RewindFailure('changed')
      if (this.rewindPreviews.size >= 100) this.rewindPreviews.delete(this.rewindPreviews.keys().next().value!)
      // This subset contains only backed-up nodes, regardless of unrelated
      // uncovered writes in the full checkpoint's conversation branch.
      this.rewindPreviews.set(value.token, { path, leaf: known.leaf, target: known.target, file })
      return value
    })
  }

  rewindStatsBatch(path: string, token: string, targets: RewindStatsTargetDTO[]): Promise<RewindResult<RewindStatsDTO[]>> {
    return this.rewindResult(async () => {
      const managed = this.rewindSession(path)
      return this.rewindClient.call('statsBatch', managed.cwd, managed.session.sessionId, token, targets)
    })
  }

  /** SDK branch()/resetLeaf() only change memory. A minimal hidden entry
   * persists the chosen branch, then fsync precedes transaction commitment. */
  private async rewindLeaf(managed: ManagedSession, leaf: string | null, operationId: string): Promise<void> {
    const { session } = managed
    const manager = session.sessionManager
    if (leaf !== null && !manager.getEntry(leaf)) throw new RewindFailure('missing')
    if (leaf !== null && manager.getLeafId() !== leaf) {
      const result = await session.navigateTree(leaf, { summarize: false })
      if (result.cancelled) throw new RewindFailure('cancelled')
    }
    if (manager.getLeafId() !== leaf) {
      if (leaf === null) manager.resetLeaf(); else manager.branch(leaf)
      session.refreshContext()
    }
    manager.appendCustomEntry('pith_rewind_selection', { operationId, target: leaf,
      // The sidebar lists a session from its SELECTED branch, not from the
      // file's abandoned history: record whether this selection has anything
      // to show. `session-branch.ts` reads it back without a second full read.
      empty: !manager.getBranch().some(entry => entry.type === 'message' && entry.message.role !== 'system') })
    const file = await openFile(managed.path, 'r')
    try { await file.sync() } finally { await file.close() }
    managed.todos.restore(); managed.askRecords.restore(); managed.changeScopes.restore(); managed.eventSequence += 1
    // Same rule as the todos above: the selected branch moved, so re-fold the
    // sandbox mode and the Plan state instead of keeping the abandoned
    // branch's values live.
    managed.sandboxMode = sandboxModeFromBranch(manager.getBranch(), this.defaultSandboxMode)
    managed.plan.restore()
    managed.goals?.restore('rewound')
    managed.planApproval?.recover()
  }

  rewindRestore(request: RewindRequest): Promise<RewindResult<RewindCommitDTO>> {
    return this.rewindResult(async () => {
      const managed = this.rewindSession(request.sessionPath)
      if (!managed.session.isIdle) throw new RewindFailure('busy')
      // Invalidate the wake without changing the leaf bound by the preview.
      managed.goals?.pause('rewound', false)
      if (!['files', 'conversation', 'all'].includes(request.mode)) throw new RewindFailure('missing')
      let releasePlanWork: () => void
      try { releasePlanWork = managed.plan.beginWork('branch') }
      catch (error) {
        if (error instanceof PlanAdmissionError) throw new RewindFailure('busy')
        throw error
      }
      try {
        await managed.goals?.idle()
        await managed.lifecyclePromise
        await managed.rewind?.idle()
        return await this.checkoutCoordinator.withExclusive(managed.cwd, 'restore', async () => {
          const { session } = managed
          if (!session.isIdle || managed.disposing || this.closing || session.getSteeringMessages().length || session.getFollowUpMessages().length) throw new RewindFailure('busy')
          const known = this.rewindPreviews.get(request.token)
          const list = await this.rewindClient.call('list', managed.cwd, session.sessionId)
          const prior = list.operations.find(operation => operation.id === request.operationId)
          if (prior?.status === 'committed') {
            const verified = await this.rewindClient.call('prepare', managed.cwd, session.sessionId, request.token, request.mode, request.operationId, null, null, managed.path)
            return { operation: verified, ...(this.activeSession === managed ? { snapshot: this.snapshot() } : {}) }
          }
          if (!known || known.path !== managed.path) throw new RewindFailure('expired')
          if (known.file && request.mode !== 'files') throw new RewindFailure('unsupported')
          if (request.mode !== 'conversation' && known.uncovered?.length && request.skipUncovered !== true) throw new RewindFailure('uncovered', known.uncovered.map(item => item.path))
          const before = session.sessionManager.getLeafId()
          if (before !== known.leaf) throw new RewindFailure('changed')
          if (known.target !== null && !session.sessionManager.getEntry(known.target)) throw new RewindFailure('missing')
          managed.notifications.pause()
          managed.askUser.pause()
          managed.subagents?.notifications?.pause()
          // Awaited: the restore's exclusive window must not collide with the
          // runs' coordinator leases (a restore would read as busy forever).
          await this.subagentRuntime.stopAll(managed.subagents)
          const operation = await this.rewindClient.call('prepare', managed.cwd, session.sessionId, request.token,
            request.mode, request.operationId, before, request.mode === 'files' ? before : known.target, managed.path,
            { uncovered: known.uncovered ?? [], confirmed: request.skipUncovered === true })
          try {
            if (request.mode !== 'files') await this.rewindLeaf(managed, known.target, operation.id)
            const committed = await this.rewindClient.call('finish', managed.cwd, session.sessionId, operation.id, true)
            await managed.goals?.inspect()
            this.emit('pi:rewind', { sessionPath: managed.path })
            void this.fileIndex?.refresh(true).catch(() => {})
            return { operation: committed, ...(this.activeSession === managed ? { snapshot: this.snapshot() } : {}) }
          } catch (error) {
            // A worker crash may leave either phase complete. Preserve the journal
            // and recover through the same operation, never issue another restore.
            try {
              const observed = await this.rewindClient.call('list', managed.cwd, session.sessionId)
              const saved = observed.operations.find(candidate => candidate.id === operation.id)
              // A committed journal wins over a lost IPC response. Compensating
              // only the conversation here would split an already committed pair.
              if (saved?.status === 'committed') {
                this.emit('pi:rewind', { sessionPath: managed.path })
                return { operation: saved, ...(this.activeSession === managed ? { snapshot: this.snapshot() } : {}) }
              }
              if (request.mode !== 'files') await this.rewindLeaf(managed, before, operation.id)
              await this.rewindClient.call('finish', managed.cwd, session.sessionId, operation.id, false)
            } catch { throw new RewindFailure('recovery', [], operation.id) }
            throw error
          }
        })
      } finally { releasePlanWork() }
    }).then(result => {
      if ('error' in result && result.error.code === 'recovery') {
        const managed = this.sessions.get(request.sessionPath)
        if (managed) this.checkoutCoordinator.setRecovery(managed.cwd, result.error.operationId ?? request.operationId)
      }
      return result
    })
  }

  rewindRecover(path: string, operationId: string): Promise<RewindResult<RewindCommitDTO>> {
    return this.rewindResult(async () => {
      const selected = this.rewindSession(path)
      const list = await this.rewindClient.call('list', selected.cwd, selected.session.sessionId)
      const operation = list.pending.find(op => op.id === operationId)
      if (!operation) throw new RewindFailure('missing')
      let managed = [...this.sessions.values()].find(m => m.session.sessionId === operation.sessionId)
      if (!managed && operation.sessionPath) {
        const saved = SessionManager.open(operation.sessionPath)
        if (saved.getSessionId() !== operation.sessionId || checkoutRoot(saved.getCwd()) !== checkoutRoot(selected.cwd)) throw new RewindFailure('changed')
        managed = await this.createManagedSession(saved)
      }
      if (!managed) throw new RewindFailure('missing')
      const owner = managed
      await owner.lifecyclePromise
      const restored = await this.checkoutCoordinator.withExclusive(owner.cwd, 'restore', async () => {
        if (!owner.session.isIdle) throw new RewindFailure('busy')
        let leaf = owner.session.sessionManager.getLeafId()
        // SDK construction appends model/thinking metadata after a restored
        // leaf. These entries do not represent new dialogue or tool execution.
        while (leaf !== operation.beforeEntryId && leaf !== operation.afterEntryId && leaf) {
          const candidate = owner.session.sessionManager.getEntry(leaf)
          if (candidate?.type !== 'model_change' && candidate?.type !== 'thinking_level_change') break
          leaf = candidate.parentId
        }
        const entry = leaf ? owner.session.sessionManager.getEntry(leaf) : undefined
        const selection = entry?.type === 'custom' && entry.customType === 'pith_rewind_selection' ? entry.data as { operationId?: string; target?: string | null } : undefined
        const recordedSelection = selection?.operationId === operation.id && selection.target === entry?.parentId && (selection.target === operation.beforeEntryId || selection.target === operation.afterEntryId)
        if (leaf !== operation.beforeEntryId && leaf !== operation.afterEntryId && !recordedSelection) throw new RewindFailure('changed')
        owner.notifications.pause()
        owner.askUser.pause()
        if (operation.mode !== 'files') await this.rewindLeaf(owner, operation.beforeEntryId, operation.id)
        const restored = await this.rewindClient.call('finish', owner.cwd, owner.session.sessionId, operationId, false)
        this.checkoutCoordinator.setRecovery(owner.cwd)
        return restored
      }, true)
      // Recovery sessions were intentionally created without external
      // extensions. Recreate their owned runtime after the transaction resolves.
      for (const old of [...this.sessions.values()]) {
        if (!old.recoveryOnly || checkoutRoot(old.cwd) !== checkoutRoot(owner.cwd)) continue
        const active = this.activeSession === old
        await this.disposeManaged(old)
        const fresh = await this.createManagedSession(SessionManager.open(old.path))
        if (active) this.activateSession(fresh)
      }
      this.emit('pi:rewind', { sessionPath: path })
      return { operation: restored, ...(this.activeSession ? { snapshot: this.snapshot() } : {}) }
    })
  }

  setCheckpointsEnabled(enabled: boolean): boolean {
    saveSettings({ ...loadSettings(), checkpointsEnabled: enabled === true })
    for (const managed of this.sessions.values()) {
      this.emit('pi:rewind', { sessionPath: managed.path })
    }
    return enabled === true
  }

  readImage(path: string): Promise<ImageContent | null> {
    return this.readFile(path).then((preview) =>
      preview.kind === 'image' && preview.base64 && preview.mimeType
        ? { type: 'image', data: preview.base64, mimeType: preview.mimeType }
        : null
    )
  }

  /** Lightweight library provenance without loading sessions or snapshots. */
  librarySession(id?: string): LibrarySession | null {
    const managed = id ? [...this.sessions.values()].find(value => value.session.sessionId === id) : this.activeSession
    if (!managed) return null
    return { id: managed.session.sessionId, path: managed.path,
      cwd: isDefaultWorkspace(managed.cwd) ? null : managed.cwd, workspace: managed.cwd,
      title: managed.session.sessionManager.getSessionName() ?? '' }
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise
    this.closing = true
    this.jevService.dispose()
    this.checkoutCoordinator.close()
    this.navigationEpoch += 1
    this.sessionSearch.dispose()
    if (this.trajectoryTimer) clearTimeout(this.trajectoryTimer)
    this.trajectoryTimer = null
    this.trajectoryChanged.clear()
    this.usageAggregator.dispose()
    if (this.contextUsageTimer) clearInterval(this.contextUsageTimer)
    this.contextUsageTimer = null
    for (const controller of this.sideChats.values()) controller.abort()
    for (const controller of this.loginAborts.values()) controller.abort()
    this.disposePromise = Promise.allSettled([this.disposeAllSessions(), this.commandTasksInstance?.dispose(), this.debugManagerInstance?.dispose()]).then(async () => { await this.rewindClient.dispose(); await this.trajectory.dispose(); await getLibraryService()?.dispose() })
    return this.disposePromise
  }
}
