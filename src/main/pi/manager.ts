import type { RewindPatchDTO, RewindStatsDTO, RewindStatsTargetDTO } from '../../shared/types'
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  DefaultPackageManager,
  estimateTokens,
  getAgentDir,
  SessionManager,
  ModelRuntime,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
  type AgentSessionServices,
  type Extension,
  type ResourceLoader
} from '@earendil-works/pi-coding-agent'
import { app, shell } from 'electron'
import { settleWithin, SESSION_DISPOSE_TIMEOUT_MS } from '../shutdown'
import { homedir } from 'node:os'
import { open as openFile } from 'node:fs/promises'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { BashTaskManager } from '../bash/manager'
import { createManagedBashTools, APP_BASH_TOOL_NAMES } from './bash-tools'
import { TaskNotifications } from './task-notifications'
import { RewindClient } from '../rewind/client'
import { checkoutRoot, CheckoutCoordinator } from '../rewind/coordinator'
import { classifyUncoveredWrites, uncoveredWrites } from '../rewind/coverage'
import { RewindRecorder } from '../rewind/recorder'
import { RewindFailure, failure as rewindFailure } from '../rewind/types'
import { ChangeScopes } from './change-scopes'
import { TodoState, createTodoTool } from './todo'
import { TODO_TOOL_NAME } from './todo-protocol'
import {
  MAX_CONCURRENT_SUBAGENTS_DEFAULT,
  MAX_CONCURRENT_SUBAGENTS_LIMIT,
  SubagentParentState,
  SubagentRuntime,
  type ChildSessionHandle,
  type SubagentHost
} from './subagents/runtime'
import { SubagentNotifications } from './subagents/notifications'
import { SUBAGENT_TOOL_NAME } from './subagents/protocol'
import { readDiskSubagentRuns } from './subagents/protocol'
import type { SubagentRunStartData } from './subagents/protocol'
import { createSubagentTool } from './subagents/tools'
import { ensureDefaultProfiles, listSubagentProfiles } from './subagents/profiles'
import { isSubagentSessionFile } from './subagents/session-filter'
import { BASH_MIN_WAIT_MS, BASH_MAX_WAIT_MS, type StartupSessionMode } from '../../shared/types'
import { FileIndex, readAttachment } from './files'
import { SessionSearch } from './session-search'
import { UsageAggregator } from './usage'
import { ensureDefaultWorkspace, isDefaultWorkspace } from './default-workspace'
import { appendPromptPath, readAppendPrompt, writeAppendPrompt } from './append-prompt'
import {
  builtinProviderBaseUrls,
  builtinProviderIds,
  configuredModels,
  discoverModels,
  providerInventory,
  readModelsConfig,
  recommendCatalogPreset,
  supportsModelDiscovery,
  testModel,
  writeModelsConfig
} from './models-config'
import { loadSettings, saveSettings } from '../settings'
import { buildToolCatalog, extensionId, loadPackageResources, type PackageResources } from './catalog'
import { setDisableModelInvocation } from './skill-frontmatter'
import { desktopExtension } from './extension-startup'
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
  ContextUsageDTO,
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
  ProviderDTO,
  ProviderModelDTO,
  PromptPayload,
  QueuedItemDTO,
  QueueActionPayload,
  RecalledItemDTO,
  RewindResult,
  RewindListDTO,
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
  SubagentRunDTO
} from '../../shared/types'

/** How many opened folders to keep in the sidebar/settings list. */
const MAX_FOLDERS = 12

/**
 * The built-in tools the app keeps active. Passed explicitly because a `tools`
 * allowlist would also filter out every extension-registered tool (see
 * `AgentSession._refreshToolRegistry`), which is why the manager omits it and
 * sets the active set by hand instead.
 */
const BUILTIN_TOOL_NAMES = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls']

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

/** Drop functions/symbols and turn Dates into ISO strings before IPC. */
function serialize(value: unknown): any {
  return JSON.parse(
    JSON.stringify(value, (_key, val) => {
      if (typeof val === 'function' || typeof val === 'symbol') return undefined
      if (val instanceof Date) return val.toISOString()
      return val
    })
  )
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

interface ManagedSession {
  recoveryOnly?: boolean
  rewind?: RewindRecorder
  todos: TodoState
  /** One real loader/runtime per session; the SDK receives its filtered proxy. */
  resourceLoader: ResourceLoader
  /** Subagent roster/runs for normal sessions; null on children. */
  subagents: SubagentParentState | null
  /** Present on subagent child sessions: linkage + frozen tool ceiling. The
   * child's initialization activates only the ceiling, never the full set. */
  subagentChild?: { parentPath: string; toolCeiling: readonly string[] }
  initializing: boolean
  lifecyclePromise: Promise<void> | null
  disposePromise: Promise<void> | null
  disposing: boolean
  changeScopes: ChangeScopes
  notifications: TaskNotifications
  session: AgentSession
  path: string
  cwd: string
  unsubscribe: () => void
  pendingStreamEvents: Map<string, PiEvent>
  streamFlushTimer: ReturnType<typeof setTimeout> | null
  streaming: ChatMessage | null
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
  private subagentsEnabledFlag = loadSettings().subagentsEnabled !== false
  private subagentMaxConcurrentSetting = loadSettings().subagentMaxConcurrent ?? MAX_CONCURRENT_SUBAGENTS_DEFAULT

  private get commandTasks(): BashTaskManager {
    return this.commandTasksInstance ??= new BashTaskManager(join(app.getPath('userData'), 'bash-tasks'),
      (task) => this.emit('pi:bash-task', task),
      (task) => {
        const managed = this.sessions.get(task.sessionPath)
        managed?.notifications.complete(task)
      }, this.checkoutCoordinator)
  }

  listBashTasks(sessionPath: string): BashTaskDTO[] { return this.commandTasks.list(sessionPath) }
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

  // ---- subagents (delegated child sessions) ----

  /** Current roster of a parent session (renderer panel refresh). */
  listSubagents(sessionPath: string): SubagentRunDTO[] {
    return this.sessions.get(sessionPath)?.subagents?.snapshot() ?? []
  }

  /**
   * Panel actions on a parent's subagent runs. `resume` continues a finished
   * child session under a fresh run, sharing the dispatch admission path.
   */
  async subagentAction(payload: SubagentActionPayload): Promise<void> {
    const managed = this.sessions.get(payload.sessionPath)
    const state = managed?.subagents
    if (!managed || !state) throw new Error('Subagents are only available on an open session')
    if (payload.action === 'steer') {
      if (!payload.message?.trim()) throw new Error('Steering message is required')
      this.subagentRuntime.steer(state, payload.sessionId, payload.message)
      return
    }
    if (payload.action === 'abort') {
      this.subagentRuntime.abort(state, payload.sessionId)
      return
    }
    await this.subagentRuntime.resume(state, managed.session, payload.sessionId, payload.message ?? '')
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

  /** Persist which session the next launch opens. */
  setStartupMode(mode: StartupSessionMode): StartupSessionMode {
    if (mode !== 'resume' && mode !== 'new') throw new Error('Invalid startup preference')
    saveSettings({ ...loadSettings(), startup: mode })
    this.startup = mode
    return mode
  }
  private sessionSearch = new SessionSearch()
  private usageAggregator = new UsageAggregator()
  private modelRuntime: ModelRuntime | null = null
  /** Lazily created; reads/writes ~/.pi/agent/settings.json (default model). */
  private settingsManagerInstance: SettingsManager | null = null
  /** Navigation can request the same file while its extensions are loading. */
  private sessionBuilds = new Map<string, Promise<ManagedSession>>()
  /** Every currently active or background-running SDK session, keyed by file. */
  private sessions = new Map<string, ManagedSession>()
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
    private notifyError: (message: string) => void
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
      commandTasks: () => this.commandTasks,
      acquireRunLease: (cwd, sessionPath) => this.checkoutCoordinator.acquire(cwd, 'run', sessionPath),
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
          throw new Error(`Unknown subagent model "${spec}" (expected "provider/modelId")`)
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
    }
    return this.modelRuntime
  }

  private async servicesFor(cwd: string, todos: TodoState, recoveryOnly = false, subagent?: { appendSystemPrompt?: string }): Promise<AgentSessionServices> {
    // A loader owns mutable extension closures and an ExtensionRuntime whose
    // actions bind to ONE session. Sharing it by cwd lets another session's
    // bind/reload/dispose overwrite or invalidate a still-live MCP context.
    return createAgentSessionServices({
      cwd,
      modelRuntime: await this.runtime(),
      resourceLoaderOptions: {
        // v1 subagent children never load extensions: N children with
        // extension runtimes would multiply MCP hosts per workspace.
        noExtensions: recoveryOnly || subagent !== undefined,
        extensionFactories: [todos.extension()],
        ...(subagent?.appendSystemPrompt ? { appendSystemPrompt: [subagent.appendSystemPrompt] } : {}),
        // Children inherit AGENTS.md per the same live app setting — a
        // delegated implementer must still know the project's rules.
        agentsFilesOverride: (base) => (this.includeContextFiles ? base : { agentsFiles: [] })
      }
    })
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
        const value = Reflect.get(target, prop, target)
        return typeof value === 'function' ? value.bind(target) : value
      }
    }) as ResourceLoader
  }

  private disposeManaged(managed: ManagedSession): Promise<void> {
    if (managed.disposePromise) return managed.disposePromise
    managed.disposing = true
    managed.rewind?.dispose()
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
        Promise.resolve().then(() => this.commandTasksInstance?.stopSession(managed.path)),
        shutdown()
      ], SESSION_DISPOSE_TIMEOUT_MS)
      if (!settled) managed.session.dispose()
      managed.unsubscribe()
      if (managed.streamFlushTimer) clearTimeout(managed.streamFlushTimer)
      managed.pendingStreamEvents.clear()
      if (this.sessions.get(managed.path) === managed) this.sessions.delete(managed.path)
      if (this.activeSession === managed) this.activeSession = null
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
    if (remember) {
      this.activateFolder(managed.cwd)
      return
    }
    if (this.cwd !== managed.cwd || !this.fileIndex) {
      this.fileIndex = new FileIndex(managed.cwd)
      void this.fileIndex.refresh(true).catch(() => {})
    }
    this.cwd = managed.cwd
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
      eventSequence: managed.eventSequence
    } as PiEvent

    // Usage (and cost) move on completed messages and compaction boundaries;
    // attach the payload so those updates land in the same render as the
    // message itself (the fixed-cadence poll covers everything between).
    if (event.type === 'message_end' || event.type === 'compaction_end') {
      const usage = this.contextUsageOf(managed)
      ;(routed as any).contextUsage = usage
      managed.contextUsageKey = JSON.stringify(usage)
    }
    // Compaction rewrites the session's message list (the summary replaces the
    // summarized tail). Ship the new list with the event so the transcript
    // collapses at the same moment the notice appears instead of keeping a
    // pre-compaction view until the next session switch.
    if (event.type === 'compaction_end' && !(event as any).aborted) {
      ;(routed as any).messages = serialize(managed.session.messages.map((message) => managed.changeScopes.stamp(message as ChatMessage)))
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
        void this.reloadManagedSession(managed)
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
   * first assistant message is appended (the `hasAssistant` gate in its
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
    model?: any
  }): Promise<ManagedSession> {
    await this.checkoutCoordinator.ready()
    if (this.checkoutCoordinator.needsRecovery(sessionManager.getCwd())) {
      const status = await this.rewindClient.call('list', sessionManager.getCwd(), sessionManager.getSessionId())
      this.checkoutCoordinator.setRecovery(sessionManager.getCwd(), status.pending[0]?.id)
    }
    const recoveryOnly = this.checkoutCoordinator.needsRecovery(sessionManager.getCwd())
    let detectedRole = subagentRole
    if (!detectedRole) {
      // Any open path (sidebar click, search hit, delete/recover rebuild) can
      // land on a subagent child file. The persisted run records are the only
      // place its frozen role lives: without restoring them the child would
      // re-activate the FULL tool set, gain a checkpoint recorder and lose its
      // profile system prompt.
      const runs = readDiskSubagentRuns(sessionManager.getEntries() as any[])
      const current = runs[runs.length - 1]
      if (current) detectedRole = { parentPath: current.start.parentSessionPath, resource: current.start.resource }
    }
    const role = detectedRole
    const isChild = role !== undefined
    const todos = new TodoState(sessionManager)
    const fullServices = await this.servicesFor(
      sessionManager.getCwd(), todos, recoveryOnly,
      isChild ? { appendSystemPrompt: role!.resource.appendSystemPrompt } : undefined
    )
    const services = { ...fullServices, resourceLoader: this.filterExtensions(fullServices.resourceLoader) }
    let notifications: TaskNotifications | undefined
    const parentSessionRef: { session: import('@earendil-works/pi-coding-agent').AgentSession | null } = { session: null }
    const subagentState = isChild ? null : new SubagentParentState(sessionManager.getSessionId())
    const { session } = await createAgentSessionFromServices({ services, sessionManager,
      ...(isChild ? {
        tools: role!.resource.tools,
        ...(role!.model ? { model: role!.model } : {}),
        ...(role!.resource.thinkingLevel ? { thinkingLevel: role!.resource.thinkingLevel as any } : {})
      } : {}),
      customTools: [...createManagedBashTools({ tasks: this.commandTasks, services,
        sessionId: sessionManager.getSessionId(), sessionPath: sessionManager.getSessionFile()!,
        maxWaitMs: () => this.bashMaxWaitMs, canStart: () => notifications?.canStart ?? false }),
        createTodoTool(todos, () => notifications?.canStart ?? false),
        // Children never see the delegation tool — recursion is excluded at
        // both the ceiling (allowlist) and the customTools layer.
        ...(subagentState && this.subagentsEnabledFlag ? [createSubagentTool({
          runtime: this.subagentRuntime, state: subagentState, parentSessionRef,
          parentSessionPath: sessionManager.getSessionFile()!,
          profiles: listSubagentProfiles(sessionManager.getCwd()),
          canStart: () => (notifications?.canStart ?? false) && subagentState.notifications!.canStart
        })] : [])]
    })
    if (!isChild) parentSessionRef.session = session
    if (isChild && role!.resource.thinkingLevel) {
      // Thinking levels are model-derived: clamp the frozen request to what
      // the child's actual model supports instead of letting it error.
      const levels = session.getAvailableThinkingLevels() as string[]
      const wanted = role!.resource.thinkingLevel as string
      if (levels.length && !levels.includes(wanted)) {
        session.setThinkingLevel((levels.includes('medium') ? 'medium' : levels[levels.length - 1]) as any)
      }
    }
    notifications = new TaskNotifications(session, this.commandTasks)
    const path = session.sessionFile ?? `memory:${session.sessionId}`
    const managed: ManagedSession = {
      recoveryOnly,
      todos,
      resourceLoader: fullServices.resourceLoader,
      subagents: subagentState,
      ...(isChild ? { subagentChild: { parentPath: role!.parentPath, toolCeiling: role!.resource.tools } } : {}),
      initializing: true,
      lifecyclePromise: null,
      disposePromise: null,
      disposing: false,
      changeScopes: new ChangeScopes(sessionManager),
      notifications,
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
    // Publish ownership before awaiting extension startup, so quitting also
    // finds sessions with a slow session_start handler.
    this.sessions.set(path, managed)
    if (this.closing) {
      await this.disposeManaged(managed)
      throw new Error('Application is shutting down')
    }
    notifications.onSettledWithQueued = () => queueMicrotask(() => {
      if (!notifications?.canStart || !session.isIdle) return
      this.rebuildQueues(managed)
    })
    notifications.onWake = () => managed.changeScopes.continue()
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
      subagentNotifications.onSettledWithQueued = () => queueMicrotask(() => {
        if (!subagentNotifications.canStart || !session.isIdle) return
        this.rebuildQueues(managed)
      })
      subagentNotifications.onWake = () => managed.changeScopes.continue()
    }
    const observeEvent = (event: AgentSessionEvent): void => {
      managed.rewind?.observe(event)
      const previousTodos = managed.todos.snapshot
      managed.todos.observe(event)
      managed.changeScopes.observe(event)
      const leaf = session.sessionManager.getLeafEntry()
      const userEntryId = event.type === 'message_end' && event.message.role === 'user' && leaf?.type === 'message' && leaf.message === event.message ? leaf.id : undefined
      const routed = { ...event,
        ...(event.type === 'agent_start' || previousTodos !== managed.todos.snapshot ? { todos: managed.todos.snapshot } : {}),
        ...('message' in event ? { message: { ...managed.changeScopes.stamp(event.message as ChatMessage), ...(userEntryId ? { sessionEntryId: userEntryId } : {}) } } : {}),
        ...(event.type === 'agent_start' ? { changeScopeId: managed.changeScopes.active } : {}),
        ...(event.type === 'agent_settled' ? { continuing: notifications!.continuesAtSettled || subagentState?.notifications?.continuesAtSettled } : {})
      }
      this.routeEvent(managed, routed as AgentSessionEvent)
      notifications!.observe(event)
      subagentState?.notifications?.observe(event)
    }
    managed.unsubscribe = session.subscribe(event => {
      // User message persistence immediately follows SDK session listeners.
      // Route on the microtask boundary so the DTO carries its actual entry
      // identity, including two identical messages created in one millisecond.
      if (event.type === 'message_end' && event.message.role === 'user') queueMicrotask(() => observeEvent(event))
      else observeEvent(event)
    })
    // Navigation only needs the restored transcript. A session_start hook can
    // wait on a file scan or network connection for many seconds; do not put
    // that wait on init/new/open. Subscribe first so startup events are kept.
    // Prompt and reload still share this barrier, and disposal owns its tail.
    const startup = this.initializeSession(managed, services.resourceLoader)
    managed.lifecyclePromise = startup
    void startup.finally(() => {
      if (managed.lifecyclePromise === startup) managed.lifecyclePromise = null
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
    sessionPath?: string
  }): Promise<ChildSessionHandle> {
    const sessionManager = options.mode === 'new'
      ? SessionManager.create(options.cwd, undefined, { parentSession: options.parentSessionPath })
      : SessionManager.open(options.sessionPath!)
    if (options.mode === 'new') this.materializeSession(sessionManager)
    const path = sessionManager.getSessionFile()
    const existing = path ? this.sessions.get(path) : undefined
    // Reuse only a settled instance: a live run owns the child right now, and
    // a second driver (resume racing the run, or steering mid-flight) would
    // interleave two runs over one session.
    if (existing && !existing.disposing && existing.session.isStreaming) {
      throw new Error('Subagent is already running')
    }
    const reused = Boolean(existing && !existing.disposing && !this.closing)
    const managed = reused
      ? existing!
      : await this.createManagedSession(sessionManager, await this.resolveSubagentRole(options))
    await managed.lifecyclePromise
    if (managed.disposing || this.closing) throw new Error('Subagent session was closed during initialization')
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
      halt: async () => {
        // Stop everything the child owns: its wake path first (a completion
        // arriving mid-halt must not re-wake it), then its queues, its
        // background processes and finally the SDK run itself.
        managed.notifications?.pause()
        managed.session.clearQueue()
        await this.commandTasksInstance?.stopSession(managed.path).catch(() => {})
        await managed.session.abort().catch(() => {})
      },
      release: () => {
        // A child the user is currently viewing stays alive; it is disposed by
        // its own lifecycle (navigation away is non-destructive in pi-app).
        if (this.sessions.get(managed.path) === managed && this.activeSession !== managed) {
          void this.disposeManaged(managed)
        }
      }
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
  }): Promise<{ parentPath: string; resource: SubagentRunStartData['resource']; model?: any }> {
    let model: any
    if (options.resource.model) {
      const runtime = await this.runtime()
      const [providerId, ...rest] = options.resource.model.split('/')
      model = providerId && rest.length ? runtime.getModel(providerId, rest.join('/')) : undefined
    }
    return { parentPath: options.parentSessionPath, resource: options.resource, ...(model ? { model } : {}) }
  }

  private async initializeSession(managed: ManagedSession, loader: ResourceLoader): Promise<void> {
    // Publish the managed session and its barrier before running extension code.
    await new Promise<void>((resolve) => setImmediate(resolve))
    if (this.closing || managed.disposing) return
    const startedAt = performance.now()
    try {
      // Keep print mode + onError: lazy tools register during session_start,
      // and the binding is also required for reload to re-emit session_start.
      await managed.session.bindExtensions({ mode: 'print', onError: (error) => {
        console.error(`Extension error (${error.extensionPath}): ${error.error}`)
      } })
      if (this.closing || managed.disposing) return
      if (managed.subagentChild) {
        // Children activate ONLY their frozen ceiling: the normal path below
        // re-activates every built-in + extension tool, which would silently
        // widen a profile's tool restriction.
        managed.session.setActiveToolsByName([...managed.subagentChild.toolCeiling])
      } else {
        // An SDK tools allowlist would also hide extension tools. Activate the
        // complete set after lazy registration, deduplicating app overrides.
        // The delegation tool is gated by its setting here (its customTool is
        // registered at build; the runtime re-checks dispatch live).
        managed.session.setActiveToolsByName([...new Set([
          ...BUILTIN_TOOL_NAMES, ...APP_BASH_TOOL_NAMES, TODO_TOOL_NAME,
          ...(managed.subagents ? [SUBAGENT_TOOL_NAME] : []),
          ...loader.getExtensions().extensions.flatMap((extension) => [...extension.tools.keys()])
        ])])
      }
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

  /** Serialize one session's current state for the renderer. */
  private snapshotOf(managed: ManagedSession): SessionSnapshotDTO {
    this.flushStreamEvents(managed)
    const messages = (serialize(managed.session.messages) as ChatMessage[]).map((message) => managed.changeScopes.stamp(message))
    const live = managed.streaming as ChatMessage | null
    if (live?.role === 'assistant') {
      const index = messages.findLastIndex(
        (message) => message.role === 'assistant' && message.timestamp === live.timestamp
      )
      if (index >= 0) messages.splice(index, 1)
    }
    this.stampCompletedAt(managed, messages)
    return {
      sessionId: managed.session.sessionId,
      sessionPath: managed.path,
      cwd: managed.cwd,
      projectless: isDefaultWorkspace(managed.cwd),
      initializing: managed.initializing,
      messages,
      todos: managed.todos.snapshot,
      activeChangeScopeId: managed.changeScopes.current,
      streaming: serialize(managed.streaming) as any,
      toolRuns: serialize(managed.toolRuns),
      queue: {
        steering: managed.queueMirror.steering.map(dtoOf),
        followUp: managed.queueMirror.followUp.map(dtoOf)
      },
      model: modelRef(managed.session.model),
      thinkingLevel: (managed.session.thinkingLevel ?? 'medium') as ThinkingLevel,
      availableThinkingLevels: managed.session.getAvailableThinkingLevels() as ThinkingLevel[],
      isStreaming: managed.session.isStreaming || managed.notifications.continuesAtSettled,
      contextUsage: this.contextUsageOf(managed),
      subagents: managed.subagents?.snapshot() ?? [],
      subagentChild: Boolean(managed.subagentChild),
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
    for (const entry of managed.session.sessionManager.buildContextEntries()) {
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
    if (!usage || !usage.contextWindow) return null
    const live = managed.streaming ? estimateTokens(managed.streaming as any) : 0
    const tokens = usage.tokens === null || usage.tokens === undefined ? null : usage.tokens + live
    const cacheable = stats.tokens.cacheRead + stats.tokens.input
    return {
      tokens,
      contextWindow: usage.contextWindow,
      percent: tokens === null ? null : (tokens / usage.contextWindow) * 100,
      sessionCost: stats.cost,
      cacheHitRate: cacheable > 0 ? Math.min(stats.tokens.cacheRead / cacheable, 1) : null
    }
  }

  /** Initialize (or re-initialize for a new cwd) with the startup session. */
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
    const infos = await SessionManager.listAll().catch(() => [])
    const byFolder = new Map<string, typeof infos>()
    for (const info of infos) {
      if (!info.cwd) continue
      const list = byFolder.get(info.cwd) ?? []
      list.push(info)
      byFolder.set(info.cwd, list)
    }
    const folderRecency = (sessions: typeof infos) =>
      sessions.reduce((max, s) => Math.max(max, s.modified.getTime()), 0)
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
      const sessions = (byFolder.get(folder) ?? []).slice().sort((a, b) => b.modified.getTime() - a.modified.getTime())
      for (const s of sessions) {
        // A freshly materialized session has a header but no messages yet; keep
        // it off the sidebar until its first user message exists to name it.
        if (s.messageCount === 0) continue
        // Subagent children are reachable through their parent's roster, not
        // the sidebar. Only the persisted run marker separates them from
        // forks (which also carry parentSessionPath and do show here).
        if (s.parentSessionPath && isSubagentSessionFile(s.path)) continue
        summaries.push({
          path: s.path,
          id: s.id,
          // No prose here: an empty session carries `null` so the renderer can
          // label it in the active locale.
          label: s.name?.trim() || (s.messageCount > 0 ? s.firstMessage?.trim().slice(0, 80) || null : null),
          modified: s.modified instanceof Date ? s.modified.toISOString() : String(s.modified),
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
    // Children are conversation sub-records of the deleted parent: stop them
    // (already done above) and trash their files with it, or they would be
    // orphaned — hidden from the sidebar but unreachable from any roster.
    const childFiles = await this.subagentChildFiles(targetCwd, path)
    for (const child of childFiles) {
      const childManaged = this.sessions.get(child)
      if (childManaged) await this.disposeManaged(childManaged)
      await shell.trashItem(child).catch(() => {})
    }
    await shell.trashItem(path).catch(() => {})
    if (!this.activeSession && this.cwd) {
      const sessions = await SessionManager.list(this.cwd).catch(() => [])
      const latest = sessions[0]
      await this.buildSession(latest ? SessionManager.open(latest.path) : SessionManager.create(this.cwd))
    }
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
  prompt(payload: PromptPayload): void {
    const managed = this.activeSession
    const session = managed?.session
    if (this.closing || managed?.disposing) return
    // An opened subagent child is a READ-ONLY view: it carries no checkpoint
    // recorder and its runs are owned by the parent's runtime, so a direct
    // user prompt would bypass every execution protection.
    if (managed?.subagentChild) {
      this.notifyError('This subagent session is read-only. Open its parent session to continue work.')
      return
    }
    managed?.notifications.resume()
    managed?.subagents?.notifications?.resume()
    if (!managed || !session) {
      this.notifyError('Pi session is not initialized. Pick a working directory first.')
      return
    }
    managed.notifications.holdWake()
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
        const fileBlocks = await this.readFileBlocks(payload.files)
        await managed.lifecyclePromise
        if (this.closing || managed.disposing || !managed.notifications.canStart) return
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
        managed.notifications.releaseWake()
        managed.subagents?.notifications?.releaseWake()
      }
    })()
  }

  private async readFileBlocks(paths: string[]): Promise<string> {
    const fileIndex = this.fileIndex
    if (!paths.length || !fileIndex) return ''
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
      managed.notifications.pause()
      managed.subagents?.notifications?.pause()
      if (managed.subagents) this.subagentRuntime.abortAll(managed.subagents)
      void this.commandTasksInstance?.stopSession(managed.path)
    }
    managed.session.clearQueue()
    managed.notifications.queuesCleared()
    if (stopping) void managed.session.abort().catch(() => {})
    else managed.notifications.flush()
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
    if (managed.subagentChild) return // read-only view: nothing to rebuild
    this.rebuildQueues(managed, payload)
  }

  private rebuildQueues(managed: ManagedSession, payload?: QueueActionPayload): void {
    const session = managed.session
    managed.queueRebuilding = true
    try {
      session.clearQueue()
      managed.notifications.queuesCleared()
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
    for (const entry of managed.session.sessionManager.buildContextEntries()) {
      if (entry.type !== 'message') continue
      const message = entry.message as { role?: string; timestamp?: number }
      if (message.role === role && message.timestamp === timestamp) {
        return { id: entry.id, parentId: entry.parentId, message: entry.message as any }
      }
    }
    return null
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
          session.agent.state.messages = sessionManager.buildSessionContext().messages
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
      }
      // Edited file references are re-inlined from disk (fresh content) — the
      // retry path carries its blocks inside the stored text already.
      if (payload.edited && payload.files?.length) {
        const fileBlocks = await this.readFileBlocks(payload.files)
        if (fileBlocks) text = text ? `${text}\n\n${fileBlocks}` : fileBlocks
      }
      if (!text && !images.length) throw new Error('Nothing to resend')

      managed.notifications?.resume()
      managed.subagents?.notifications?.resume()
      managed.notifications?.holdWake()
      managed.subagents?.notifications?.holdWake()
      void session.prompt(text, { images }).catch((error) =>
        this.emitSessionError(managed, error)
      ).finally(() => { managed.notifications?.releaseWake(); managed.subagents?.notifications?.releaseWake() })
      return this.snapshot()
    } finally { release() }
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
    const entry = this.findMessageEntry(managed, 'assistant', timestamp)
    if (!entry) throw new Error('Message not found')
    const sessionManager = managed.session.sessionManager
    const file = sessionManager.getSessionFile()
    if (!file || !existsSync(file)) throw new Error('The session has not been saved yet')

    // The SDK switches the receiver's file/id/branch when forking. Keep the
    // live source manager untouched, or it will append to the fork even after
    // that fork is deleted (recreating a message-only file without a header).
    const forkedPath = SessionManager.open(file).createBranchedSession(entry.id)
    if (!forkedPath) throw new Error('Failed to create the forked session')

    let baseLabel = managed.session.sessionName?.trim() || null
    if (!baseLabel) {
      for (const candidate of sessionManager.buildContextEntries()) {
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
  }

  abort(): void {
    const managed = this.activeSession
    if (!managed) return
    managed.notifications.pause()
    // Stop closes the wake path BEFORE aborting: a subagent completing during
    // or after the stop must not restart the conversation.
    managed.subagents?.notifications?.pause()
    if (managed.subagents) this.subagentRuntime.abortAll(managed.subagents)
    managed.session.clearQueue()
    void this.commandTasksInstance?.stopSession(managed.path)
    void managed.session.abort().catch(() => {})
  }

  async setModel(providerId: string, modelId: string): Promise<SessionSnapshotDTO> {
    const managed = this.activeSession
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
    if (!this.activeSession) throw new Error('No active session')
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
      const api = (provider.getModels()[0] as any)?.api as string | undefined
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
          : supportsModelDiscovery(api)
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
        discoverable: Boolean(entry.baseUrl) && supportsModelDiscovery(entry.api)
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
    const key = `${managed.path}\u0000${[...this.disabledExtensions].sort().join('\u0000')}`
    if (this.catalogCache?.key === key) return this.catalogCache.value
    const packages = await loadPackageResources(cwd, getAgentDir()).catch(
      () => new Map<string, PackageResources>()
    )
    const session = managed.session
    const value = buildToolCatalog(
      loader,
      session?.getAllTools() ?? [],
      session?.getActiveToolNames() ?? [],
      this.disabledExtensions,
      packages,
      this.knownExtensionTools
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

  /**
   * Rebuild the resources and system prompt of every live session. Each owns
   * its loader/runtime; one that is mid-run defers to `agent_settled` (see
   * routeEvent), since reloading would swap the extension runner under an
   * in-flight request.
   */
  private async reloadManagedSession(managed: ManagedSession): Promise<void> {
    if (this.closing || managed.disposing) return
    managed.notifications.holdWake()
    managed.subagents?.notifications?.holdWake()
    const previous = managed.lifecyclePromise
    const pending = (async () => {
      await previous
      if (this.closing || managed.disposing) return
      if (!managed.session.isIdle) { managed.reloadPending = true; return }
      try {
        await managed.session.reload({ beforeSessionStart: () => {
          if (this.closing || managed.disposing) throw new Error('Session is shutting down')
        } })
      }
      catch { /* Keep the existing resource-reload error policy. */ }
      finally { this.catalogCache = null }
    })()
    managed.lifecyclePromise = pending
    try { await pending }
    finally {
      if (managed.lifecyclePromise === pending) managed.lifecyclePromise = null
      managed.notifications.releaseWake()
      managed.subagents?.notifications?.releaseWake()
    }
  }

  private async reloadLiveSessions(): Promise<void> {
    for (const managed of [...this.sessions.values()]) {
      if (managed.session.isStreaming) {
        managed.reloadPending = true
        continue
      }
      await this.reloadManagedSession(managed)
    }
  }

  async models(): Promise<ModelDTO[]> {
    const runtime = await this.runtime()
    const available = new Set(
      (await runtime.getAvailable().catch(() => [])).map((m: any) => `${m.provider}/${m.id}`)
    )
    const providerName = new Map(runtime.getProviders().map((p) => [p.id, p.name]))
    const models: ModelDTO[] = []
    for (const provider of runtime.getProviders()) {
      for (const model of provider.getModels()) {
        const anyModel = model as any
        models.push({
          providerId: anyModel.provider,
          providerName: providerName.get(anyModel.provider) ?? anyModel.provider,
          id: anyModel.id,
          name: anyModel.name ?? anyModel.id,
          reasoning: Boolean(anyModel.reasoning),
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

  rewindList(path: string): Promise<RewindResult<RewindListDTO>> {
    return this.rewindResult(async () => {
      const managed = this.rewindSession(path)
      const list = await this.rewindClient.call('list', managed.cwd, managed.session.sessionId)
      this.checkoutCoordinator.setRecovery(managed.cwd, list.pending[0]?.id)
      return { ...list, checkpoints: list.checkpoints.filter(cp => cp.trigger === 'before-turn'), enabled: loadSettings().checkpointsEnabled !== false,
        busy: this.checkoutCoordinator.busy(managed.cwd) || !!managed.session.getSteeringMessages().length || !!managed.session.getFollowUpMessages().length, error: this.checkoutCoordinator.restoreError() ?? managed.rewind?.error }
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
      session.agent.state.messages = manager.buildSessionContext().messages
    }
    manager.appendCustomEntry('pith_rewind_selection', { operationId, target: leaf })
    const file = await openFile(managed.path, 'r')
    try { await file.sync() } finally { await file.close() }
    managed.todos.restore(); managed.changeScopes.restore(); managed.eventSequence += 1
  }

  rewindRestore(request: RewindRequest): Promise<RewindResult<RewindCommitDTO>> {
    return this.rewindResult(async () => {
      const managed = this.rewindSession(request.sessionPath)
      if (!['files', 'conversation', 'all'].includes(request.mode)) throw new RewindFailure('missing')
      await managed.lifecyclePromise
      await managed.rewind?.idle()
      return this.checkoutCoordinator.withExclusive(managed.cwd, 'restore', async () => {
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

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise
    this.closing = true
    this.checkoutCoordinator.close()
    this.navigationEpoch += 1
    this.sessionSearch.dispose()
    this.usageAggregator.dispose()
    if (this.contextUsageTimer) clearInterval(this.contextUsageTimer)
    this.contextUsageTimer = null
    for (const controller of this.sideChats.values()) controller.abort()
    for (const controller of this.loginAborts.values()) controller.abort()
    this.disposePromise = Promise.allSettled([this.disposeAllSessions(), this.commandTasksInstance?.dispose()]).then(async () => { await this.rewindClient.dispose() })
    return this.disposePromise
  }
}
