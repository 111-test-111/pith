/**
 * Shared DTO types across the Electron main process (Pi SDK) and the
 * beUI renderer. These mirror the structural shapes of pi-ai messages so
 * neither side imports the other's runtime packages.
 */

export interface TextContent {
  type: 'text'
  text: string
}

export interface ThinkingContent {
  type: 'thinking'
  thinking: string
  redacted?: boolean
}

export interface ImageContent {
  type: 'image'
  data: string
  mimeType: string
}

export interface ToolCallContent {
  type: 'toolCall'
  id: string
  name: string
  arguments: Record<string, any>
}

export type UserContent = string | (TextContent | ImageContent)[]

export interface UserMsg {
  role: 'user'
  content: UserContent
  timestamp: number
}

export interface UsageDTO {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  totalTokens: number
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }
}

export interface AssistantMsg {
  role: 'assistant'
  content: (TextContent | ThinkingContent | ToolCallContent)[]
  provider: string
  model: string
  usage?: UsageDTO
  stopReason: string
  errorMessage?: string
  timestamp: number
}

export interface ToolResultMsg {
  role: 'toolResult'
  toolCallId: string
  toolName: string
  content: (TextContent | ImageContent)[]
  details?: any
  isError: boolean
  timestamp: number
}

/** Context was compacted: the summarized history replaced by this entry. */
export interface CompactionSummaryMsg {
  role: 'compactionSummary'
  summary: string
  tokensBefore: number
  timestamp: number
}

/** A branch summary entry created when the session tree was navigated. */
export interface BranchSummaryMsg {
  role: 'branchSummary'
  summary: string
  fromId: string | null
  timestamp: number
}

/** A user-executed shell command (`!cmd`) recorded in the transcript. */
export interface BashExecutionMsg {
  role: 'bashExecution'
  command: string
  output: string
  exitCode?: number
  cancelled: boolean
  truncated: boolean
  fullOutputPath?: string
  /** True for `!!cmd`: recorded but not sent to the model. */
  excludeFromContext?: boolean
  timestamp: number
}

/** An extension-injected message; `display` false means hidden from the UI. */
export interface CustomMsg {
  role: 'custom'
  customType: string
  content: string | (TextContent | ImageContent)[]
  display: boolean
  details?: unknown
  timestamp: number
}

export type ChatMessage =
  | UserMsg
  | AssistantMsg
  | ToolResultMsg
  | CompactionSummaryMsg
  | BranchSummaryMsg
  | BashExecutionMsg
  | CustomMsg

/** A pi AgentSessionEvent after IPC serialization, routed to its owning session. */
export interface PiEvent {
  type: string
  /** Present on session-scoped events. Legacy/global errors may omit routing. */
  sessionId?: string
  sessionPath?: string
  cwd?: string
  /** Monotonic within one live AgentSession; guards snapshot/event races. */
  eventSequence?: number
  [key: string]: any
}

export interface ModelRefDTO {
  providerId: string
  id: string
  name: string
  reasoning: boolean
}

export interface ModelDTO extends ModelRefDTO {
  providerName: string
  input: string[]
  contextWindow: number
  maxTokens: number
  available: boolean
  costInputPerM: number
  costOutputPerM: number
}

export interface ProviderDTO {
  id: string
  name: string
  authTypes: ('api_key' | 'oauth')[]
  authenticated: boolean
  authSource?: string
  canLogin: boolean
  /** True when the provider exists in the built-in registry (sign-in
   * providers); false for models.json-only ids like Ollama or a proxy. */
  builtin: boolean
  /** True when a ~/.pi/agent/models.json entry exists for this provider. */
  custom: boolean
  /** The provider's wire API when known (from composition or models.json). */
  api?: string
  /** The built-in (pre-models.json) base URL — what the editor shows as the
   * provider's default. Absent for the few providers that carry it per model
   * or resolve it from auth. */
  baseUrl?: string
  /** True when the wire API exposes a models-list endpoint we can fetch. */
  discoverable: boolean
}

// ---- models.json editing (Settings → Providers) ----

export interface ModelCostDTO {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/**
 * A models.json `providers.<id>.models[]` entry. Fields the UI does not edit
 * (api/baseUrl/headers/samplingParams/compat/thinkingLevelMap…) pass through
 * untouched on save.
 */
export interface CustomModelDTO {
  id: string
  name?: string
  reasoning?: boolean
  input?: string[]
  contextWindow?: number
  maxTokens?: number
  cost?: ModelCostDTO
  [key: string]: unknown
}

/** A models.json `modelOverrides` entry; the map key is the model id. */
export interface ModelOverrideDTO {
  name?: string
  reasoning?: boolean
  input?: string[]
  contextWindow?: number
  maxTokens?: number
  cost?: ModelCostDTO
  [key: string]: unknown
}

export interface CustomProviderDTO {
  name?: string
  baseUrl?: string
  api?: string
  apiKey?: string
  headers?: Record<string, string>
  models?: CustomModelDTO[]
  modelOverrides?: Record<string, ModelOverrideDTO>
  [key: string]: unknown
}

export interface ModelsConfigDTO {
  providers: Record<string, CustomProviderDTO>
}

/**
 * One composed model row of a provider inventory: registry ∪ models.json
 * carriers with overrides applied, plus the provenance the editor needs.
 */
export interface ProviderModelDTO {
  id: string
  name: string
  contextWindow: number
  maxTokens: number
  reasoning: boolean
  input: string[]
  cost?: ModelCostDTO
  available: boolean
  /** builtin = registry only · custom = models.json carrier only ·
   * both = carrier duplicates a registry definition. */
  source: 'builtin' | 'custom' | 'both'
  /** models.json carries a modelOverrides entry for this id. */
  hasOverride: boolean
}

export interface DiscoveredModelDTO {
  id: string
  name?: string
}

// ---- models.dev catalog fill ----

/** Parameter preset recommended for a model id from the models.dev catalog. */
export interface CatalogPresetDTO {
  name?: string
  reasoning?: boolean
  input?: string[]
  contextWindow?: number
  maxTokens?: number
  cost?: ModelCostDTO
}

export type CatalogRecommendationDTO = {
  exactMatches: number
  /** How the metadata preset was matched: provider | base-url | consensus | none. */
  metadataMethod: 'provider' | 'base-url' | 'consensus' | 'none'
  matchedProviderName?: string
  preset: CatalogPresetDTO
  price:
    | {
        status: 'reliable'
        method: 'provider' | 'base-url' | 'consensus'
        cost: ModelCostDTO
        providerName?: string
        support: number
        total: number
      }
    | {
        status: 'unreliable'
        reason: 'no-exact-match' | 'no-valid-price' | 'insufficient-support' | 'conflict'
        support: number
        total: number
      }
}

// ---- model config copy ----

/**
 * A composed model of a configured provider — the source list behind the
 * model editor's "copy from model". Carries the effective
 * thinkingLevelMap/compat because copies need real values, not provenance.
 */
export interface ModelConfigSourceDTO {
  providerId: string
  providerName: string
  id: string
  name: string
  reasoning: boolean
  input?: string[]
  contextWindow: number
  maxTokens: number
  cost?: ModelCostDTO
  thinkingLevelMap?: Record<string, string | null>
  compat?: Record<string, unknown>
}

export interface TestModelResultDTO {
  ok: boolean
  latencyMs?: number
  status?: number
  responseText?: string
  error?: string
}

export interface DefaultModelDTO {
  providerId: string
  modelId: string
}

export interface SessionSummaryDTO {
  path: string
  id: string
  /** Session name or first user message; `null` for a session with no
   * messages yet, which the renderer labels in the active locale. */
  label: string | null
  modified: string
  messageCount: number
  /** Folder (working directory) the session belongs to. */
  cwd: string
  /** True while the live SDK session (active or background) is streaming. */
  running: boolean
}

export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/**
 * Live context usage of the active session, straight from the SDK's
 * AgentSession.getContextUsage() plus the session's running cost. Attached to
 * snapshots and to message_end events, and pushed by the main process' 2s
 * `context_usage` poll, so the composer ring tracks the session live.
 */
export interface ContextUsageDTO {
  /** Estimated context tokens, or null if unknown (e.g. right after compaction). */
  tokens: number | null
  contextWindow: number
  /** Percent of the context window, or null when tokens is unknown. */
  percent: number | null
  /** Session running cost in USD, summed over assistant message usage. */
  sessionCost: number
  /** Cache hit rate 0–1 over the session (cacheRead / (cacheRead + input)),
   * or null before any cacheable usage arrives. */
  cacheHitRate: number | null
}

// ---- Tools & extensions catalog (Settings → Tools / Extensions) ----

/** Where a tool comes from: a built-in SDK tool or an installed extension. */
export interface ToolSourceDTO {
  kind: 'builtin' | 'extension'
  /** Extension identity (`resolvedPath`) when `kind` is "extension". */
  extensionId?: string
  /** Display label — "Built-in" or the extension's package name. */
  label: string
}

/**
 * One tool the agent can call, with the metadata Settings → Tools renders.
 * `active` mirrors the live session's active tool set; `disabledByExtension`
 * marks tools belonging to an extension the user switched off.
 */
export interface ToolInfoDTO {
  name: string
  description: string
  /** JSON Schema (TypeBox) for the tool's arguments. */
  parameters: Record<string, any>
  promptGuidelines?: string[]
  source: ToolSourceDTO
  active: boolean
  disabledByExtension: boolean
}

/** Kinds of resource a package can contribute. */
export type ExtensionResourceKind = 'extension' | 'skill' | 'prompt' | 'theme'

/** One resource an extension's package ships (e.g. a bundled skill). */
export interface ExtensionResourceDTO {
  kind: ExtensionResourceKind
  name: string
  path: string
  /** Path relative to the package root, when inside it. */
  relativePath?: string
}

/** One installed extension as Settings → Extensions lists it. */
export interface ExtensionInfoDTO {
  /** Stable identity used for the enable/disable preference. */
  id: string
  /** Package name when resolvable, else the directory/file name. */
  name: string
  version?: string
  /** Version pinned in the configured source spec, when any. */
  configuredVersion?: string
  /** Package source (e.g. `npm:@tavily/pi-extension`) or the local path. */
  source: string
  scope: 'user' | 'project' | 'temporary'
  origin: 'package' | 'top-level'
  path: string
  toolNames: string[]
  enabled: boolean
  /** Present when the extension comes from a configured package. */
  packageName?: string
  installedPath?: string
  /** Skills/prompts/themes/extensions the owning package ships. */
  resources: ExtensionResourceDTO[]
  /** True when the extension belongs to a configured package, so it can be
   * updated or removed through the package manager. */
  manageable: boolean
}

/** One skill (SKILL.md) the agent can invoke. */
export interface SkillInfoDTO {
  name: string
  description: string
  /** Absolute path to the skill's SKILL.md. */
  filePath: string
  baseDir: string
  /** Package source (e.g. `npm:pi-mcp-adapter`) or the local path. */
  source: string
  scope: 'user' | 'project' | 'temporary'
  origin: 'package' | 'top-level'
  /** Owning package's display name when the skill ships in a package. */
  packageName?: string
  /** When true the skill is excluded from the system prompt and can only be
   * invoked explicitly (its `disable-model-invocation` frontmatter key). */
  disableModelInvocation: boolean
}

/** A skill-parsing problem reported by the SDK's skill loader. */
export interface SkillDiagnosticDTO {
  type: string
  message: string
}

/** SKILL.md text for the Settings → Skills preview. */
export interface SkillContentDTO {
  path: string
  text: string
  truncated: boolean
}

/**
 * Full tools + extensions + skills catalog for the active workspace.
 * Extensions and skills are read from the unfiltered resource loader, so a
 * disabled extension still appears (and its tools stay listed but inactive).
 */
export interface ToolCatalogDTO {
  tools: ToolInfoDTO[]
  extensions: ExtensionInfoDTO[]
  skills: SkillInfoDTO[]
  skillDiagnostics: SkillDiagnosticDTO[]
}

export interface ToolRunDTO {
  toolCallId: string
  toolName: string
  args: any
  status: 'running' | 'success' | 'error'
  partial: any
  startedAt: number
  endedAt?: number
}

export interface SessionSnapshotDTO {
  sessionId: string
  sessionPath?: string
  cwd: string
  /** Completed messages only; the live assistant is carried separately. */
  messages: ChatMessage[]
  streaming?: AssistantMsg | null
  toolRuns?: Record<string, ToolRunDTO>
  queue?: { steering: QueuedItemDTO[]; followUp: QueuedItemDTO[] }
  model: ModelRefDTO | null
  thinkingLevel: ThinkingLevel
  /** Levels the current model actually supports (SDK getAvailableThinkingLevels),
   * so the composer never offers a level that would be clamped away. */
  availableThinkingLevels?: ThinkingLevel[]
  isStreaming: boolean
  /** Live context usage for the composer ring; null before a model resolves. */
  contextUsage?: ContextUsageDTO | null
  /** Last event incorporated into this snapshot. */
  eventSequence?: number
}

/**
 * Side chat (`/btw`): a no-tools completion over a snapshot of a session. The
 * renderer owns the exchange list — main stays stateless between questions.
 */
export interface SideChatHistoryEntry {
  question: string
  answer: string
}

export interface SideChatAskPayload {
  /** Renderer-generated id; every stream event for this ask carries it. */
  exchangeId: string
  /** Session whose committed context answers the question; omitted = active one. */
  sessionPath?: string | null
  question: string
  /** Earlier side exchanges, replayed as plain user/assistant turns. */
  history: SideChatHistoryEntry[]
}

/**
 * Incremental side-chat stream, on its own channel (`pi:side-chat`) so it never
 * touches the workspace store's event log.
 */
export type SideChatEvent =
  | { type: 'delta'; exchangeId: string; text: string }
  | { type: 'done'; exchangeId: string }
  | { type: 'error'; exchangeId: string; message: string }
  | { type: 'aborted'; exchangeId: string }

export interface AppInfoDTO {
  cwd: string | null
  /** Every folder the user has opened, most recent first (active cwd included). */
  folders: string[]
  /** Whether AGENTS.md/CLAUDE.md context files are injected into the prompt. */
  contextFiles: boolean
  version: string
}

/** Global append system prompt (~/.pi/agent/APPEND_SYSTEM.md). */
export interface AppendPromptDTO {
  path: string
  text: string
}

export type FileKind = 'image' | 'text' | 'other'

export interface FileHitDTO {
  path: string
  relPath: string
  name: string
  dir: string
  kind: FileKind
  size: number
  mtime: number
}

export interface FilePreviewDTO {
  path: string
  relPath: string
  kind: FileKind
  mimeType?: string
  base64?: string
  text?: string
  truncated: boolean
  size: number
}

export type AuthPromptKind = 'text' | 'secret' | 'select' | 'manual_code'

export interface AuthPromptDTO {
  requestId: string
  providerId: string
  kind: AuthPromptKind
  message: string
  placeholder?: string
  options?: { id: string; label: string; description?: string }[]
}

export interface AuthNotifyDTO {
  providerId: string
  kind: 'info' | 'auth_url' | 'device_code' | 'progress'
  message?: string
  url?: string
  /** Extra links carried by an `info` event (label falls back to the URL). */
  links?: { url: string; label?: string }[]
  /** Follow-up text for an `auth_url` event (e.g. "paste the code"). */
  instructions?: string
  userCode?: string
  verificationUri?: string
  intervalSeconds?: number
  expiresInSeconds?: number
}

export interface PromptPayload {
  text: string
  images: ImageContent[]
  files: string[]
  /**
   * How to deliver the message while the agent is already running:
   * "steer" interrupts before the next model call, "followUp" waits for the
   * run to finish. Ignored when the session is idle (the message starts a new
   * run) — AgentSession.prompt() resolves that atomically.
   */
  streamingBehavior?: 'steer' | 'followUp'
}

/**
 * Resend/retry of a user message: `(timestamp)` locates the persisted message
 * (its session entry) so the main process can rewind the session to just
 * before it; `text`/`images` ride along so a message that never persisted (a
 * failed send left only the renderer's optimistic echo) can still be re-sent.
 */
export interface ResendPayload {
  timestamp: number
  text: string
  images: ImageContent[]
  /**
   * Referenced workspace files to (re-)inline as `<file>` blocks. Set by the
   * edit-and-resend path, where the user may have added or removed file
   * references; the plain retry path leaves this undefined so it keeps
   * re-sending the file blocks already stored in the message text.
   */
  files?: string[]
  /**
   * True when `text`/`images`/`files` are a user edit and must win over the
   * persisted entry (the rewind normally restores the stored text/images).
   */
  edited?: boolean
}

/** Identifies one row of the SDK queue (steering or follow-up). */
export interface QueueItemPayload {
  kind: 'steering' | 'followUp'
  index: number
}

/**
 * Per-item queue surgery. The SDK's only dequeue is a full clearQueue(), so
 * the main process rebuilds the queues: `promote` moves a follow-up into the
 * steering queue (deliver at the next turn boundary instead of after the
 * run), `remove` drops the item.
 */
export type QueueActionPayload = QueueItemPayload & { action: 'promote' | 'remove' }

/**
 * One queued message as the renderer sees it: the SDK-visible text plus
 * payload counts. The SDK only exposes queued messages as text — these DTOs
 * are fed by the main process's payload mirror, and image bytes never ride
 * the event stream; they return only via clearQueue() (RecalledItemDTO).
 */
export interface QueuedItemDTO {
  /** SDK-visible text (file blocks inlined, templates expanded). */
  text: string
  /** The user's draft as typed — what recall puts back into the composer. */
  originalText: string
  imageCount: number
  filePaths: string[]
}

/** A recalled queued message with its full payload (images included). */
export interface RecalledItemDTO {
  text: string
  originalText: string
  images: ImageContent[]
  filePaths: string[]
}

/**
 * Result of forking the active session at a message: the opened fork's
 * snapshot plus the source session's display label (data only — the renderer
 * composes the localized "Fork of …" title and renames the fork).
 */
export interface ForkResultDTO {
  snapshot: SessionSnapshotDTO
  baseLabel: string | null
}
