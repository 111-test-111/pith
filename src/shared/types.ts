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
 * snapshots and to message_end events so the composer ring updates per turn.
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
  queue?: { steering: string[]; followUp: string[] }
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

export interface AppInfoDTO {
  cwd: string | null
  /** Every folder the user has opened, most recent first (active cwd included). */
  folders: string[]
  version: string
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
