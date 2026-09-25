/**
 * Shared DTO types across the Electron main process (Pi SDK) and the
 * beUI renderer. These mirror the structural shapes of pi-ai messages so
 * neither side imports the other's runtime packages.
 */

import type { AskUserRecordDTO, PendingAskUserDTO } from './ask-user'
import type { TableFormat } from './table'
import type { BrowserPageMeta } from './browser'
import type {
  PlanActionResult,
  PlanApprovalDTO,
  PlanApproveRequest,
  PlanBlocker,
  PlanDocumentDTO,
  PlanDocumentRequest,
  PlanModeRequest,
  PlanStateDTO,
  PlanSubmissionRef,
  SessionMode
} from './plan'
import { PLAN_MAX_BYTES } from './plan.ts'

export type WindowTheme = 'light' | 'dark' | 'system'

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

/** Attached by the main process (never by the SDK): the wall-clock time the
 * session entry was written, i.e. when the message FINISHED. `timestamp` is
 * the SDK's creation time, so a turn's elapsed time can only be measured to
 * this. Absent on in-flight/partial messages. */
export interface CompletedAt {
  completedAt?: number
}

export interface UserMsg extends CompletedAt {
  sessionEntryId?: string
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

export interface AssistantMsg extends CompletedAt {
  /** App-only cumulative change ownership; independent of user-message folds. */
  changeScopeId?: string
  role: 'assistant'
  content: (TextContent | ThinkingContent | ToolCallContent)[]
  provider: string
  model: string
  usage?: UsageDTO
  stopReason: string
  errorMessage?: string
  timestamp: number
}

export interface ToolResultMsg extends CompletedAt {
  /** App-owned stamp, attached only after a valid submission is persisted. */
  planSubmission?: PlanSubmissionRef
  role: 'toolResult'
  toolCallId: string
  toolName: string
  content: (TextContent | ImageContent)[]
  details?: any
  isError: boolean
  timestamp: number
}

/** Context was compacted: this entry replaces summarized history for the model, not the UI. */
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
  rewindError?: RewindErrorDTO
  /** Present on session-scoped events. Legacy/global errors may omit routing. */
  sessionId?: string
  sessionPath?: string
  cwd?: string
  /** Monotonic within one live AgentSession; guards snapshot/event races. */
  eventSequence?: number
  /** True when this event belongs to a subagent child session. A child's turns
   * are steps of its parent's run, so notification cues (renderer-side) skip
   * them instead of chiming once per delegated round. */
  subagentChild?: boolean
  /** True on the `agent_settled` that ends a run the user stopped themselves
   * (Stop/Esc). A stopped run is not a finished one, so the completion cue
   * stays silent for it. */
  userAborted?: boolean
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
  /** The SDK's per-model supported thinking levels, including opt-in xhigh/max. */
  thinkingLevels?: ThinkingLevel[]
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
  /** App-level visibility: hidden models stay composed/usable but are kept
   * out of every model selector. Not an SDK field — the runtime ignores it. */
  hidden?: boolean
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
  /** models.json hides this model from the app's model selectors
   * (modelOverrides.<id>.hidden). The runtime still composes it. */
  hidden: boolean
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
  /** Internal default directory; never show cwd in workspace chrome. */
  projectless: boolean
  /** True while the live SDK session (active or background) is streaming. */
  running: boolean
}

/** Order of the folder groups and of the sessions inside a group. */
export type SessionSearchSort = 'newest' | 'oldest'

export interface SessionSearchRequest {
  query: string
  /** Titles and conversation prose are always searched together. Tool I/O, attachment bodies and thinking are opt-in. */
  includeDetails?: boolean
  /** Defaults to 'newest' when omitted. */
  sort?: SessionSearchSort
  offset?: number
}

/** Half-open UTF-16 ranges in the accompanying original text. */
export interface SearchTextDTO {
  text: string
  ranges: [number, number][]
}

export type SessionSearchSource = 'user' | 'assistant' | 'summary' | 'custom' | 'tool' | 'thinking' | 'attachment'

export interface SessionSearchHitDTO {
  path: string
  id: string
  cwd: string
  /** Internal default directory; never show cwd in workspace chrome. */
  projectless?: boolean
  modified: string
  title: SearchTextDTO
  snippet: SearchTextDTO | null
  /** Source of the excerpt, never inferred from its text by the renderer. */
  snippetSource?: SessionSearchSource
  snippetToolName?: string
}

export interface SessionSearchResultDTO {
  hits: SessionSearchHitDTO[]
  total: number
  /** Internal diagnostics only; never displayed in the search panel. */
  incomplete: number
}

// ---------------------------------------------------------------------------
// Cross-session usage aggregation (Settings → Usage). Distinct from the
// per-message `UsageDTO` above: these are day × model buckets folded from
// every session file in the shared ~/.pi/agent/sessions tree.
// ---------------------------------------------------------------------------

export interface UsageDayPointDTO {
  tokens: number
  /** USD; 0 when the provider has no pricing configured. */
  cost: number
  requests: number
}

export interface UsageModelSeriesDTO {
  /** "provider/model" — the grouping key. */
  key: string
  provider: string
  model: string
  /** Sparse per-day points keyed by local YYYY-MM-DD. */
  days: Record<string, UsageDayPointDTO>
  totalTokens: number
  totalCost: number
  totalRequests: number
}

/** One conversation turn — everything the model ran between two user
 * messages (or file boundaries), merged across requests and models. */
export interface UsageTurnRecordDTO {
  /** Turn start (the user message), epoch ms; falls back to the first request. */
  startTs: number
  /** Last request end in the turn, epoch ms. */
  endTs: number
  /** Distinct provider/model buckets hit by the turn, most tokens first. */
  models: Array<{ provider: string; model: string; tokens: number }>
  tokens: number
  /** USD; 0 when the provider has no pricing configured. */
  cost: number
  requests: number
}

export interface UsageStatsDTO {
  generatedAt: number
  /** Local YYYY-MM-DD of the earliest/latest day with usage; null when empty. */
  firstDay: string | null
  lastDay: string | null
  /** Sorted by totalTokens desc. */
  models: UsageModelSeriesDTO[]
  totalTokens: number
  totalCost: number
  totalRequests: number
  /** Conversation turns, newest first, capped by the aggregator. */
  records: UsageTurnRecordDTO[]
  /** True when older turns were dropped by the cap. */
  recordsTruncated: boolean
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

/**
 * Token split of ONE message of the context, for the detail pane's breakdown
 * bar. The numbers are the SDK's own `estimateTokens` heuristic (chars/4), so
 * they are estimates — see `ContextBreakdownDTO` for how the residue is
 * reconciled with the ring's provider-anchored total.
 */
export interface ContextBreakdownDTO {
  user: number
  assistant: number
  toolResults: number
  /** System prompt + tool schemas + estimate residue: total − the three above. */
  other: number
  /** Sum of the four buckets; never null (falls back to the message estimates). */
  total: number
}

/**
 * Everything the right rail's context tab shows about the open session:
 * the SDK's own session stats plus the message-level detail the stats do not
 * carry. `usage` is the same readout the composer ring renders, so the two can
 * never disagree about the window, the percent or the cost.
 *
 * Every number here is either reported by the SDK or the ring's own; the only
 * derived one is `tokens.reasoning` (a documented subset the SDK's totals drop)
 * and `breakdown`, which is labelled as an estimate wherever it is shown.
 */
export interface ContextDetailDTO {
  sessionId: string
  sessionPath: string | null
  /** Session name, or the first user message; null when the file has neither. */
  title: string | null
  cwd: string
  projectless: boolean
  provider: string | null
  model: string | null
  /** Null for a session file read from disk whose level is not recorded; the
   * pane shows `—` rather than inventing a level. */
  thinkingLevel: ThinkingLevel | null
  /** Session header creation time, epoch ms; null when unreadable. */
  createdAt: number | null
  /** Session file mtime, epoch ms; null when unreadable. */
  lastActivity: number | null
  /** Cumulative billed totals over the whole session FILE — every branch, the
   * abandoned ones from resends/retries included — not the context size. */
  userMessages: number
  assistantMessages: number
  toolCalls: number
  toolResults: number
  totalMessages: number
  tokens: {
    input: number
    output: number
    /** Subset of `output`; null when no provider reported a reasoning split. */
    reasoning: number | null
    cacheRead: number
    cacheWrite: number
    /** Cumulative billed tokens over the whole session, NOT the context size. */
    total: number
  }
  cost: number
  /** The composer ring's live readout (context size, window, percent, cache hit). */
  usage: ContextUsageDTO
  /** Estimated token split of the CURRENT context; never sums to more than the
   * ring's total, which it is reconciled against (see the pane's own note). */
  breakdown: ContextBreakdownDTO
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
  jevWorkflow?: JevWorkflowDTO | null
  jevWorkflowSeq?: number
  /** Transcript is available while session_start hooks finish preparing tools. */
  initializing?: boolean
  /** This session's DSH file-sandbox mode, folded from its own branch. */
  sandboxMode?: SandboxMode
  /** What that mode can actually enforce on this host, right now. */
  sandbox?: SandboxStatusDTO
  /** Pending one-shot sandbox escalation questions, fresh at snapshot time;
   * carrying them here makes a session switch or an IPC snapshot unable to
   * lose one to event/snapshot ordering. */
  escalations?: SandboxEscalationRequestDTO[]
  /** Pending ask_user_question sets the user has to answer, fresh at snapshot
   * time; subagent children's questions are listed under the owning parent. */
  pendingAskUser?: PendingAskUserDTO[]
  /** Latest successful todo result on the complete selected branch, including compacted entries. */
  todos?: TodoSnapshotDTO | null
  /** Every ask_user_question on the selected branch, oldest first — the Q&A record panel. */
  askUserRecords?: AskUserRecordDTO[]
  activeChangeScopeId?: string | null
  sessionId: string
  sessionPath?: string
  cwd: string
  /** Internal default directory; never show cwd in workspace chrome. */
  projectless: boolean
  /** Full selected-branch transcript; compacted history stays visible. The live assistant is separate. */
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
  /** Subagent runs belonging to this session (roster cards). */
  subagents?: SubagentRunDTO[]
  /** True when THIS session is itself a subagent child: a read-only view —
   * the composer is disabled and main refuses direct prompts. */
  subagentChild?: boolean
  /** True when this session is owned by a scheduled run (read-only). */
  scheduledTaskSession?: boolean
  /** Parent session file for a child view (the "open parent" action). */
  subagentParentPath?: string
  /** Last event incorporated into this snapshot. */
  eventSequence?: number
  /** Plan Mode metadata: working mode, the plan overlay's effective sandbox,
   * the latest submission/approval identity and the live blockers. Sequence-
   * free; older sessions without the field are `normal` by default. */
  plan?: PlanStateDTO
}

// ---- subagents (delegated child sessions) ----

/** A file a subagent run wrote, extracted from the child session's successful
 * edit/write results. `patch` is a real unified diff (synthesized for `write`),
 * bounded in total size by the runtime. */
export interface SubagentWrittenFileDTO {
  /** Absolute path resolved against the shared session cwd. */
  filePath: string
  /** Path to render: relative to the cwd when it lies inside it. */
  displayPath: string
  added?: number
  removed?: number
  patch?: string
}

export type SubagentRunStatus = 'running' | 'completed' | 'failed' | 'aborted' | 'interrupted'

/** Tools a profile may hold and still count as read-only. Also the
 * conservative fallback for a profile whose tool set cannot be resolved (a
 * `tool_preset` this app does not know, or a missing `tools:` field): an
 * unknown restriction must never widen to write/bash access. */
export const SUBAGENT_READ_ONLY_TOOLS: readonly string[] = ['read', 'grep', 'find', 'ls']

/** The SDK's seven built-in tools — every session keeps these active, and
 * Settings → Subagents offers them even when no live session exists to read a
 * catalog from. */
export const SDK_BUILTIN_TOOL_NAMES: readonly string[] = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls']

/** A profile file's name (its filename without `.md`): lowercase letters,
 * digits, `-` and `_`, starting with a letter or digit. Shared so the
 * Settings creation form validates exactly what the loader accepts. */
export const SUBAGENT_PROFILE_NAME_PATTERN = /^[a-z0-9][a-z0-9-_]*$/

/** Payload for creating one new profile file (Settings → Subagents). */
export interface SubagentProfileCreatePayload {
  name: string
  description: string
  systemPrompt: string
  scope: 'global' | 'project'
}

/** The subagents tab's read model: every visible profile plus the two
 * directories a new file can land in. `projectDir` is null when no project is
 * active (projectless chats use a hidden internal workspace), in which case
 * the creation form offers global scope only. */
export interface SubagentProfilesDTO {
  profiles: SubagentProfileDTO[]
  globalDir: string
  projectDir: string | null
}

/** One subagent profile as Settings → Subagents renders it: an ordinary
 * Markdown file (flat frontmatter + system-prompt body) in the global
 * `${agentDir}/agents` or the project's `.pi/agents` directory. There is no
 * builtin/custom split — a starter profile is just a file seeded on first
 * run and editable like any other. */
export interface SubagentProfileDTO {
  name: string
  displayName: string
  description: string
  systemPrompt: string
  /** 'all' resolves against the parent session's active tools at dispatch. */
  tools: 'all' | string[]
  /** Where `tools` came from — an unresolved preset is flagged so the settings
   * row can say why the set is only read-only. */
  toolsSource?: 'explicit' | 'preset' | 'unresolved-preset' | 'default'
  /** The `tool_preset` id the profile declares, when any (diagnostics). */
  toolPreset?: string
  model?: string
  thinking?: ThinkingLevel
  maxTurns?: number
  inheritContext: boolean
  runInBackground: boolean
  enabled: boolean
  scope: 'global' | 'project'
  filePath: string
}

/** One subagent run as the renderer sees it (roster card + tool-row details). */
export interface SubagentRunDTO {
  runId: string
  /** Child session identity — its file is a real, openable pi session. */
  sessionId: string
  sessionPath: string
  /** The parent's `agent` tool call this run belongs to. */
  parentToolCallId: string
  profile: string
  description: string
  task: string
  runInBackground: boolean
  status: SubagentRunStatus
  createdAt: string
  completedAt?: string
  result?: string
  error?: string
  /** The runtime ended the run at its dispatched turn limit (the child was told
   * to wrap up and its answer is the final one). Never set on a user stop. */
  limitReached?: boolean
  /** `provider/modelId`, resolved at dispatch. */
  model?: string
  /** The frozen tool ceiling this run dispatched with. */
  tools?: string[]
  /** Cumulative usage of the child session's assistant messages (progress). */
  tokens?: number
  toolUses?: number
  writtenFiles?: SubagentWrittenFileDTO[]
  /** Absent on legacy results whose file list covered the entire child. */
  writtenFilesScope?: 'run'
  /**
   * Per-parent monotonic revision. Roster updates with a seq lower than the
   * entry they target are stale (a late event from an aborted run) and must
   * be dropped; 0 marks a record reconstructed from disk.
   */
  seq: number
}

/** Renderer-initiated action on a parent's subagent run. */
export interface SubagentActionPayload {
  /** Parent session file whose roster owns the run. */
  sessionPath: string
  /** Child session id the action targets. */
  sessionId: string
  /** Run visible when the user chose the action. Main rejects a newer run. */
  expectedRunId: string
  action: 'steer' | 'abort' | 'resume'
  /** Steer/resume message; required for steer. */
  message?: string
}

/** Details carried by a `subagent_message` custom message: which child sent
 * the message and its text. The renderer's quiet tool row reads the same
 * fields the model-facing prose in the message content carries. Shared by
 * the main-process protocol and the renderer's transcript row. */
export interface SubagentMessageDetails {
  kind: 'pi-app-subagent-message'
  /** Child session id the message came from. */
  sessionId: string
  runId?: string
  description: string
  profile: string
  message: string
  sentAt: string
}

export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled'

export interface TodoItemDTO {
  id: string
  content: string
  status: TodoStatus
  activeForm?: string
}

export interface TodoSnapshotDTO {
  toolCallId: string
  items: TodoItemDTO[]
  /** Last list retained with original statuses for review after clearing; never active model work. */
  retainedItems?: TodoItemDTO[]
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

/**
 * Which session a boot opens (Settings → General → Startup). `resume` reopens
 * exactly the session that was active when the app last quit; `new` always
 * lands on the new-session page. Both are deterministic — the app never picks
 * "whichever session file happens to be newest".
 */
export type StartupSessionMode = 'resume' | 'new'

/**
 * DSH file-sandbox vocabulary, shared by both processes. It describes exactly
 * one thing: which file effects the first-party `bash`, `edit` and `write` may
 * perform. Reads, network access, MCP tools and extensions are outside it, and
 * there is no approval gate — the mode is the whole policy.
 */
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'
export const SANDBOX_MODES = ['read-only', 'workspace-write', 'danger-full-access'] as const
/** Same default as DSH: writes inside the workspace, nothing outside it. */
export const DEFAULT_SANDBOX_MODE: SandboxMode = 'workspace-write'

export function isSandboxMode(value: unknown): value is SandboxMode {
  return typeof value === 'string' && (SANDBOX_MODES as readonly string[]).includes(value)
}

export type SandboxBackend = 'bubblewrap' | 'landlock' | 'seatbelt' | 'windows-acl'
export type SandboxSupport = 'ready' | 'partial' | 'dependencies-missing' | 'host'
export type SandboxEscalationDecision = 'approve' | 'deny'

/**
 * One pending one-shot escalation: this call wants a strictly wider mode, and
 * only the user's answer decides. Data only — the renderer composes the prose.
 */
export interface SandboxEscalationRequestDTO {
  requestId: string
  sessionId: string
  sessionPath: string
  toolCallId: string
  toolName: string
  currentMode: SandboxMode
  requestedMode: SandboxMode
  /** The model's reason for wanting the wider mode. */
  justification: string
  createdAt: number
}

/**
 * Capability readout, not prose: the renderer composes whatever sentence the
 * user reads from these facts.
 */
export interface SandboxStatusDTO {
  mode: SandboxMode
  backend: SandboxBackend | null
  enforcement: 'full' | 'partial' | null
  support: SandboxSupport
  /** True only for `danger-full-access`: commands run on the host. */
  unsandboxed: boolean
}

/** A createPage handshake entry waiting for the renderer to materialize its
 * webview guest (marker URL). Same shape the service's pendingCreates carries. */
export interface BrowserPendingCreateDTO { id: string; owner: string; createdAt: number }

// ---- Chrome 登录态导入（Settings → Browser；清单 = <userData>/browser-import.json） ----

/** 可导入的 Chrome 档案（目录名 + 显示名）。 */
export interface BrowserImportSourceDTO {
  id: string
  label: string
}

/** 档案发现结果：`ok` 可导入；`blocked` 被 macOS 应用数据保护拦住（引导授权）；
 *  `none` 装了 Chrome 但没有带 cookie 库的档案；`absent` 没装。 */
export interface BrowserImportDiscoveryDTO {
  status: 'ok' | 'blocked' | 'none' | 'absent'
  profiles: BrowserImportSourceDTO[]
  /** 是否 dev 模式（含 preview，进程都是仓库里的 Electron.app）：blocked 引导
   *  走两条路 —— dev 授「完全磁盘访问」给启动终端即可，正式安装则直接勾选 pi-app。 */
  devMode: boolean
}

export type BrowserImportErrorCode =
  | 'chrome-not-found'
  | 'profile-not-found'
  | 'keychain'
  | 'database'
  /** macOS 应用数据保护（TCC）拦住了对 Chrome 目录的读取 —— 引导用户授「完全磁盘访问」。 */
  | 'permission'

/** 一次导入的结果。code 只在 ok=false 时有值；计数无论成败都尽力填充。 */
export interface BrowserImportResultDTO {
  ok: boolean
  code?: BrowserImportErrorCode
  total: number
  imported: number
  failed: number
  /** 第一条写入失败的技术性错误消息（英文，仅诊断展示，可缺省）。 */
  firstError?: string
  skippedExpired: number
  /** v20/损坏/空身份等「跳过不导」的合计。 */
  skippedUndecryptable: number
}

/** 已导入清单的读数；present=false 表示没有可清除的导入。 */
export interface BrowserImportStatusDTO {
  present: boolean
  source?: 'chrome'
  profileLabel?: string
  importedAt?: number
  cookieCount: number
}

/** Embedded browser registry readout (`browser:status` / `browser:state`).
 * `available` stays true in this host: pages are renderer-hosted webviews and
 * the service always answers. */
export interface BrowserStatusDTO {
  available: boolean
  consentRequired: boolean
  pages: BrowserPageMeta[]
  pendingCreates: BrowserPendingCreateDTO[]
}

export interface AppInfoDTO {
  checkpointsEnabled: boolean
  bashMaxWaitMs: number
  /** DSH file-sandbox mode: which file effects bash/edit/write may perform. */
  sandboxMode: SandboxMode
  /** What that mode can actually enforce on this host, right now. */
  sandbox: SandboxStatusDTO
  cwd: string | null
  /** Every folder the user has opened, most recent first (active cwd included). */
  folders: string[]
  /** Whether AGENTS.md/CLAUDE.md context files are injected into the prompt. */
  contextFiles: boolean
  /** What the next launch opens. */
  startup: StartupSessionMode
  /** Whether subagent delegation is enabled. */
  subagentsEnabled: boolean
  /** Whether the model may continue finished subagent sessions
   * (the `agent` tool's `continue_session_id`). */
  subagentReuseEnabled: boolean
  /** Whether parent↔child subagent steering is enabled (`agent_steer` /
   * `message_parent`). */
  subagentCommsEnabled: boolean
  /** Per-parent limit on concurrently running subagent delegations. */
  subagentMaxConcurrent: number
  /**
   * Auto-settle deadline for an ask_user_question panel, in seconds. The
   * countdown runs from the moment the panel appears and the user's first
   * real interaction cancels it for good (collapsing does not).
   */
  askUserTimeoutSeconds: number
  /**
   * Provider request timeout, in seconds (Settings → General → timeouts). A
   * model request that stays unanswered this long fails as a timeout and the
   * SDK retries it; the value is applied to sessions in memory only.
   */
  responseTimeoutSeconds: number
  /** The user consented to the embedded browser (stored, asked once). */
  browserConsent: boolean
  /** Whether the model's browser_* tools are enabled for sessions. */
  browserAgentToolsEnabled: boolean
  version: string
}

export type BashTaskStatus = 'running' | 'stopping' | 'succeeded' | 'failed' | 'cancelled' | 'timed_out' | 'interrupted'

/** Command lifetime is independent of its SDK tool call and agent run. */
export interface BashTaskDTO {
  id: string
  sessionId: string
  sessionPath: string
  toolCallId: string
  command: string
  cwd: string
  status: BashTaskStatus
  background: boolean
  reason?: 'requested' | 'wait_threshold'
  startedAt: number
  endedAt?: number
  lastOutputAt?: number
  exitCode?: number | null
  signal?: string | null
  outputChars: number
  logPath: string
  logTruncated: boolean
  /** Set when the sandbox runner refused this command: the file policy, not
   * the command, is what failed. The user changes it in Settings. */
  denied?: boolean
  /** The DSH file-sandbox mode this command ran under (confined launches
   * only); lets a denied completion name the mode its escalation widens. */
  sandboxMode?: SandboxMode
  error?: string
  revision: number
}

export interface BashTaskOutputDTO {
  task: BashTaskDTO
  output: string
  /** UTF-16 character offset, scoped to this task. */
  cursor: number
  truncated: boolean
}

export interface BashTaskRequest {
  sessionPath: string
  taskId: string
  cursor?: number
}

export const BASH_DEFAULT_MAX_WAIT_MS = 10_000
export const BASH_MIN_WAIT_MS = 100
export const BASH_MAX_WAIT_MS = 60_000

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

/** Read-only file browser. Requests carry their original workspace so switching
 * sessions cannot repoint an in-flight read at another project. */
export interface FileBrowserRequest {
  cwd: string
  path: string
}
/** URL serves complete HTML and its scoped assets, independently of the source cap. */
export type HtmlPreviewDTO = { url: string; error?: never } | { url?: never; error: FileBrowserError }
export interface HtmlPreviewLinkDTO { webContentsId: number; url: string }
export interface FileActionResultDTO { status: 'ok' | 'cancelled' | 'error' }
export type FileBrowserError = 'missing' | 'directory' | 'binary' | 'unreadable' | 'tooLarge' | 'git'
export interface FileDirectoryEntryDTO {
  name: string
  path: string
  directory: boolean
  symlink: boolean
}
export interface FileDirectoryDTO {
  path: string
  entries: FileDirectoryEntryDTO[]
  nextOffset?: number
  error?: FileBrowserError
}
export interface FileDocumentDTO {
  path: string
  relativePath: string
  gitRoot: string | null
  text?: string
  size: number
  truncated: boolean
  error?: FileBrowserError
}
export interface FileGitDiffDTO {
  gitRoot: string | null
  patch: string
  binary: boolean
  error?: FileBrowserError
}

/** Size of a PDF the preview will stream. Byte ranges are read on demand through
 * `files:pdfRange`; `end` is exclusive (see `shared/pdf.ts`). */
export interface PdfStatDTO {
  path: string
  size: number
  error?: FileBrowserError
}

/** Bytes of a previewable font file (`shared/preview.ts` kind `font`). Fonts
 * ride IPC instead of the `pith-media` scheme: a `FontFace` URL source is a
 * cross-origin font request and that scheme deliberately has no CORS headers,
 * while `new FontFace(family, buffer)` needs none. Bounded by the reader. */
export interface FontDataDTO {
  path: string
  data?: Uint8Array
  size: number
  error?: FileBrowserError
}

/** Table preview (`shared/table.ts`). The stat decides the format and the
 * delimiter; delimited files then arrive as record-aligned slices, and a
 * spreadsheet is a ZIP the renderer's worker reads through `files:tableRange`. */
export interface TableStatDTO {
  path: string
  format: TableFormat | null
  /** The sniffed field separator of a delimited file. */
  delimiter?: string
  size: number
  error?: FileBrowserError
}

export interface TableSliceDTO {
  path: string
  offset: number
  /** Byte offset after the last complete record in `text`. */
  nextOffset: number
  eof: boolean
  text: string
  error?: FileBrowserError
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

/** Resume the unfinished frontier without moving the selected branch. */
export interface ContinuePayload {
  sessionPath: string
  /** The interrupted frontier, checked again in main before starting. */
  timestamp: number
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
/** Terminal traffic is independent of Pi events and never enters the chat store. */
export interface TerminalCreatePayload {
  id: string
  /** null means home, including projectless chats. */
  cwd: string | null
  cols: number
  rows: number
}

export interface TerminalInfoDTO {
  id: string
  cwd: string
  shell: string
  pid: number
}

export type TerminalErrorCode = 'directory' | 'spawn' | 'host' | 'closed'
export type TerminalCreateResult = { terminal: TerminalInfoDTO } | { error: TerminalErrorCode }
export type TerminalEvent =
  | { type: 'data'; id: string; data: string }
  | { type: 'exit'; id: string; exitCode: number; signal?: number }
  | { type: 'error'; id: string; error: TerminalErrorCode }

export type TerminalCommand =
  | { type: 'create'; payload: TerminalCreatePayload }
  | { type: 'input'; id: string; data: string; binary?: boolean }
  | { type: 'resize'; id: string; cols: number; rows: number }
  | { type: 'ack'; id: string; chars: number }
  | { type: 'close'; id: string }
  | { type: 'dispose' }

export type TerminalHostEvent = TerminalEvent | { type: 'ready'; terminal: TerminalInfoDTO }

/** Rewind IPC carries data/error codes only; the renderer owns all prose. */
export type RewindMode = 'files' | 'conversation' | 'all'
export type RewindErrorCode = 'busy' | 'changed' | 'missing' | 'corrupt' | 'unsupported' | 'storage' | 'recovery' | 'branch' | 'expired' | 'cancelled' | 'terminal' | 'uncovered'
export interface RewindErrorDTO { code: RewindErrorCode; paths?: string[]; operationId?: string }
export type RewindResult<T> = { value: T } | { error: RewindErrorDTO }
export interface RewindCheckpointDTO {
  messageEntryId?: string
  messageTimestamp?: number
  id: string
  sessionId: string
  timestamp: number
  trigger: 'before-turn' | 'after-turn' | 'resume' | 'safety' | 'legacy'
  entryId: string | null
  description: string
  branch: string | null
  files: number
  bytes: number
  excluded: { path: string; reason: 'ignored' | 'large' | 'directory-limit' | 'submodule' | 'special' }[]
  legacy?: boolean
  conversationUnavailable?: boolean
}
export interface RewindChangeDTO {
  /** Only leaf worktree changes can be restored independently. */
  singleFile?: boolean
  stage?: number
  path: string
  area: 'worktree' | 'index'
  kind: 'added' | 'deleted' | 'modified'
  binary: boolean
  beforeMode?: number
  afterMode?: number
  bytes: number
}
export interface RewindOperationDTO {
  /** Known missing originals left untouched by this operation and its Undo/Redo. */
  skipped?: RewindUncoveredPathDTO[]
  file?: string
  sessionPath?: string
  id: string
  timestamp: number
  sessionId: string
  targetId: string
  mode: RewindMode
  status: 'prepared' | 'files-applied' | 'committed' | 'rolled-back' | 'conflict'
  beforeEntryId: string | null
  afterEntryId: string | null
  undoOf?: string
  redoOf?: string
  canUndo?: boolean
  canRedo?: boolean
  conflicts?: string[]
  recoveryPath?: string
}
export interface RewindListDTO {
  checkpoints: RewindCheckpointDTO[]
  operations: RewindOperationDTO[]
  pending: RewindOperationDTO[]
  enabled: boolean
  /** The restore is refused right now; `busyReason` says why. */
  busy: boolean
  /**
   * The one live fact that refuses a restore, named so the panel can say what
   * is actually holding it instead of one sentence that lists every
   * possibility. Ordered by what the user acts on first: an unfinished recovery
   * outranks everything, an open terminal is closable, a queued message is
   * recallable, then work that can write the checkout, and a plain model turn
   * last — that one ends by itself. Absent while nothing blocks.
   */
  busyReason?: RewindBusyReason
  bytes: number
  error?: RewindErrorDTO
}
export type RewindBusyReason = 'recovery' | 'terminal' | 'queued' | 'work' | 'turn'
export interface RewindPatchDTO { patch: string; truncated: boolean; binary?: boolean }
export interface RewindStatsDTO { added: number; removed: number; binary: boolean }
export type RewindStatsTargetDTO = Pick<RewindChangeDTO, 'path' | 'area' | 'stage'>
export interface RewindUncoveredPathDTO { path: string; reason: 'outside-workspace' | 'excluded' }
export interface RewindPreviewDTO {
  file?: string
  scopeRoot?: string
  uncovered?: RewindUncoveredPathDTO[]
  conversationUnavailable?: boolean
  token: string
  checkpointId: string
  changes: RewindChangeDTO[]
  excluded: RewindCheckpointDTO['excluded']
  blocked?: RewindErrorDTO
  operationId?: string
  action?: 'undo' | 'redo'
}
export interface RewindRequest {
  /** Explicit confirmation to leave this preview's uncovered paths untouched. */
  skipUncovered?: boolean
  sessionPath: string
  token: string
  mode: RewindMode
  operationId: string
}
export interface RewindCommitDTO { operation: RewindOperationDTO; snapshot?: SessionSnapshotDTO }

// Re-export Plan Mode DTOs so they share the same shared/types surface.
export type { PlanActionResult, PlanApprovalDTO, PlanApproveRequest, PlanBlocker, PlanDocumentDTO, PlanDocumentRequest, PlanModeRequest, PlanStateDTO, PlanSubmissionRef, SessionMode }
export { PLAN_MAX_BYTES }
/** Native Jev settings. Credentials only travel renderer → main when replaced. */
export interface JevPreferences {
  mode: 'off' | 'tools' | 'workflow'
  choice: boolean
  score: boolean
  noul: boolean
}
export interface JevSettingsDTO extends JevPreferences {
  keySource: 'saved' | 'environment' | 'missing' | 'unavailable'
}
export interface JevSettingsUpdate {
  preferences?: JevPreferences
  apiKey?: string | null
}
export const JEV_ERROR_CODES = ['disabled', 'capability_disabled', 'missing_key', 'credentials', 'invalid_input', 'authentication', 'rate_limit', 'timeout', 'cancelled', 'network', 'invalid_response', 'busy', 'storage'] as const
export type JevErrorCode = typeof JEV_ERROR_CODES[number]
export type JevActionResult<T> = { ok: true; data: T } | { ok: false; code: JevErrorCode }
export type JevAnswerDTO =
  | { type: 'noul'; noul: number }
  | { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: 'score'; score: number; legend: Record<string, string>; probabilities: Record<string, number>; confidence: number }
export interface JevEvaluationDTO {
  model: string
  answers: Record<string, JevAnswerDTO>
  elapsedMs: number
  inputTokens: number
  outputTokens: number
}
export type JevWorkflowRoute = 'respond' | 'inspect' | 'act'
/** Branch-owned audit, fetched on demand; never part of the model context. */
export interface JevTraceSummaryDTO {
  id: string
  stage: 'router' | 'verifier'
  timestamp: number
  status: 'running' | 'completed' | 'failed' | 'interrupted'
  choice?: string
  effectiveChoice?: string
  override?: 'action_request' | 'missing_evidence' | 'unactionable_review' | 'no_progress'
  target?: { id: string; requirement: string; instruction: string; evidenceIds: string[] }
  error?: JevErrorCode
}
export interface JevTraceDTO extends JevTraceSummaryDTO {
  request: { state: string; questions: Record<string, unknown> }
  evaluation?: JevEvaluationDTO
}
export interface JevTracePageDTO {
  items: JevTraceSummaryDTO[]
  nextCursor: string | null
}
export type JevWorkflowReason = JevErrorCode | 'limit' | 'uncertain' | 'interrupted' | 'no_progress' | 'blocked'
export interface JevWorkflowDTO {
  seq: number
  phase: 'routing' | 'executing' | 'verifying' | 'waiting' | 'approval' | 'completed' | 'paused'
  route?: JevWorkflowRoute
  decision?: 'continue' | 'retry' | 'verify' | 'stop'
  reason?: JevWorkflowReason
  corrections: number
  requests: number
  jevInput: number
  jevOutput: number
  mainInput: number
  mainOutput: number
  cacheRead: number
  cacheWrite: number
}

// ---- Scheduled tasks ----
export interface ScheduledTasksSnapshotDTO {
  tasks: import('./scheduled-tasks').ScheduledTask[]
  runs: import('./scheduled-tasks').ScheduledTaskRun[]
  serverTime: string
  defaultPermissionMode: SandboxMode
  dedicatedRoot: string
  /** Terminal runs the user has not marked read — the sidebar badge count. */
  unreadCount: number
}

/** Full final assistant text for one selected scheduled run, fetched on demand. */
export interface ScheduledRunOutputDTO {
  text: string | null
}

/** IPC result wrapper: ScheduledTaskError's status survives the boundary. */
export type ScheduledTaskResult<T> = { ok: true; value: T } | { ok: false; status: number; error: string }
