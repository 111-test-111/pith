import { isNothingToCompactError } from '../../../shared/compaction-errors'
import { optimisticEchoText } from '../lib/attachments'
import { DEFAULT_GOAL_LIMITS, validGoalLimits, type GoalErrorCode, type GoalInput, type GoalLimits, type GoalSnapshotDTO } from '../../../shared/goal'
import type { CompactionProcessStateDTO, CompactionQueueStateDTO } from '../../../shared/compaction'
import type {
  AssistantMsg,
  ChatMessage,
  ContextUsageDTO,
  ModelRefDTO,
  PiEvent,
  PlanStateDTO,
  JevWorkflowDTO,
  RewindErrorDTO,
  QueuedItemDTO,
  SessionSnapshotDTO,
  SubagentRunDTO,
  ThinkingLevel,
  ToolCallContent,
  ToolResultMsg,
  TodoSnapshotDTO,
  UserMsg
} from '../../../shared/types'
import { DEFAULT_SANDBOX_MODE, type SandboxEscalationRequestDTO, type SandboxMode, type SandboxStatusDTO } from '../../../shared/types'
import type { AskUserRecordDTO, PendingAskUserDTO } from '../../../shared/ask-user'

export interface ToolRun {
  toolCallId: string
  toolName: string
  args: any
  status: 'running' | 'success' | 'error'
  partial: any
  startedAt: number
  endedAt?: number
}

/**
 * In-flight work notice, kept as data (key + params) so the renderer composes
 * the sentence in the active locale instead of the main process shipping prose.
 */
export interface Notice {
  key: 'retrying' | 'retryFailed' | 'compacting' | 'compactFailed'
  params?: { attempt?: number; maxAttempts?: number }
  /** Raw SDK/provider error text, appended after the localized label. */
  detail?: string
}

/** Composer intent is local to a chat; selecting it never grants execution. */
export interface GoalUIState {
  enabled: boolean
  /** Show the task-strip entry only after this mode has a submitted goal. */
  submitted: boolean
  limits: GoalLimits
  acceptance: string
  pending: boolean
  error: GoalErrorCode | null
}
const EMPTY_GOAL_UI: GoalUIState = { enabled: false, submitted: false, limits: DEFAULT_GOAL_LIMITS, acceptance: '', pending: false, error: null }

export interface PiState {
  goalUI: GoalUIState
  goal: GoalSnapshotDTO | null
  goalSeq: number
  jevWorkflow: JevWorkflowDTO | null
  initializing: boolean
  todos: TodoSnapshotDTO | null
  /** Every ask_user_question of this session, oldest first (the record panel). */
  askUserRecords: AskUserRecordDTO[]
  /** Subagent roster of this session (roster cards + tool-row details). */
  subagents: SubagentRunDTO[]
  ready: boolean
  cwd: string | null
  projectless: boolean
  sessionId: string | null
  /** Path of the open session file — the sidebar's active item id. */
  sessionPath: string | null
  model: ModelRefDTO | null
  thinkingLevel: ThinkingLevel
  /** This session's DSH file-sandbox mode, folded from its own branch. */
  plan: PlanStateDTO | null
  sandboxMode: SandboxMode
  /** What the host can enforce for that mode right now. */
  sandbox: SandboxStatusDTO | null
  /** Pending one-shot escalation questions the user has to answer. */
  escalations: SandboxEscalationRequestDTO[]
  /** Pending ask_user_question sets the user has to answer (subagent
   * children's questions included — they arrive under this owner path). */
  pendingAskUser: PendingAskUserDTO[]
  isStreaming: boolean
  /**
   * A prompt was echoed locally and no run has been announced for it yet.
   * The transcript paints its waiting row (spinner + sentence) from this flag,
   * so the row cannot trail the user's own bubble by an IPC round trip;
   * `agent_start` (or a settling/error event) hands the row over to
   * `isStreaming`.
   */
  awaitingRun: boolean
  /** True while the visible session is itself a subagent child (read-only). */
  subagentChild: boolean
  /** The visible conversation belongs to a scheduled task (read-only). */
  scheduledTaskSession: boolean
  /** Parent session file for a child view (the composer's "open parent"). */
  subagentParentPath: string | null
  activeChangeScopeId?: string | null
  /** SDK context usage for the composer ring; refreshed by the main process'
   * 2s poll (`context_usage`) and by every turn boundary. */
  contextUsage: ContextUsageDTO | null
  messages: ChatMessage[]
  /** Last routed event incorporated into this view. */
  eventSequence: number
  /** Partial assistant message while the agent is streaming a response. */
  streaming: AssistantMsg | null
  toolRuns: Record<string, ToolRun>
  /** Queued steer/follow-up messages with payload counts (mirror-fed). */
  queue: { steering: QueuedItemDTO[]; followUp: QueuedItemDTO[] }
  compactionQueue: CompactionQueueStateDTO
  compactionProcess: CompactionProcessStateDTO
  notice: Notice | null
  error: string | RewindErrorDTO | null
}

/**
 * Workspace-chrome slice of PiState: fields the sidebar, header and composer
 * read. Its object identity only changes when one of these fields changes, so
 * `useSyncExternalStore(subscribe, getShell)` subscribers don't re-render while
 * streaming deltas churn `streaming`/`toolRuns`/`messages` in the full state.
 */
export interface PiShellState {
  goalUI: GoalUIState
  initializing: boolean
  ready: boolean
  cwd: string | null
  projectless: boolean
  sessionPath: string | null
  sessionId: string | null
  model: ModelRefDTO | null
  thinkingLevel: ThinkingLevel
  /** Levels the current model supports; cycles through these only. */
  availableThinkingLevels: ThinkingLevel[]
  /** This session's DSH file-sandbox mode and what the host can enforce. */
  plan: PlanStateDTO | null
  sandboxMode: SandboxMode
  sandbox: SandboxStatusDTO | null
  /** Pending escalation questions for this session, oldest first. */
  escalations: SandboxEscalationRequestDTO[]
  /** Pending ask_user_question sets for this session, oldest first. */
  pendingAskUser: PendingAskUserDTO[]
  isStreaming: boolean
  contextUsage: ContextUsageDTO | null
  /** Pending steering/follow-up messages (SDK queue state) for the composer. */
  queue: { steering: QueuedItemDTO[]; followUp: QueuedItemDTO[] }
  compactionQueue: CompactionQueueStateDTO
  /** True while the visible session is a subagent child (composer disabled). */
  subagentChild: boolean
  scheduledTaskSession: boolean
  /** Parent session file for a child view, when known. */
  subagentParentPath: string | null
  /** This session's subagent roster: the rail names its agent tabs from it and
   * the pane header reads live status/tokens from it. */
  subagents: SubagentRunDTO[]
}

/** Fallback while no session/model is known (SDK returns all levels then). */
const ALL_THINKING_LEVELS: ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/**
 * Prose part of a user message — the text before any inlined `<file path>`
 * block. Used to match an optimistic echo against its persisted twin without
 * the blocks' content (the echo only carries "(pending)" placeholders).
 */
function userProse(content: UserMsg['content']): string {
  const text =
    typeof content === 'string'
      ? content
      : content
          .filter((part) => part.type === 'text')
          .map((part) => (part as any).text ?? '')
          .join('\n')
  return text.split('\n\n<file path=')[0].trim()
}

/**
 * Append a message to the transcript by its creation time instead of pushing
 * it onto the end.
 *
 * A round can reach the renderer after rounds it chronologically precedes. The
 * SDK's auto-retry strips the errored assistant round from the live agent state
 * (`_prepareRetry`: "Remove error message from agent state (keep in session for
 * history)"), so every snapshot this store rebuilds from (session switch,
 * model/thinking change, resend/fork/rewind) has no slot for it; it re-enters
 * later as a plain event. Appending it put that round's rows — its error
 * disclosure in particular — at the live edge, below content it belongs above,
 * so the row appeared to drift as the retry kept streaming. Ordering by
 * `timestamp` gives it back its own slot; equal timestamps keep arrival order.
 *
 * The array is always a fresh copy: callers pass `[...this.state.messages]`.
 */
/**
 * Merge two roster snapshots by per-session seq. Neither side is universally
 * newer: a completion EVENT can overtake the snapshot that was serialized
 * before it, and a fresh snapshot can carry disk-recovered rows a parked
 * event never saw. Max-seq per session resolves both directions; equal seq
 * prefers the incoming row (idempotent refreshes).
 */
function mergeRoster(current: readonly SubagentRunDTO[], incoming: readonly SubagentRunDTO[]): SubagentRunDTO[] {
  if (!current.length) return [...incoming]
  const bySession = new Map(current.map((run) => [run.sessionId, run]))
  for (const run of incoming) {
    const existing = bySession.get(run.sessionId)
    if (!existing || run.seq >= existing.seq) bySession.set(run.sessionId, run)
  }
  return [...bySession.values()].sort(
    (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.seq - a.seq
  )
}

function insertByTimestamp(messages: ChatMessage[], incoming: ChatMessage): void {
  let index = messages.length
  while (index > 0 && messages[index - 1].timestamp > incoming.timestamp) index -= 1
  messages.splice(index, 0, incoming)
}

const EMPTY_COMPACTION_QUEUE: CompactionQueueStateDTO = { queued: false, revision: 0 }
const EMPTY_COMPACTION_PROCESS: CompactionProcessStateDTO = { process: null, revision: 0 }

const initialState: PiState = {
  goalUI: EMPTY_GOAL_UI,
  goal: null,
  goalSeq: 0,
  initializing: false,
  todos: null,
  askUserRecords: [],
  subagents: [],
  subagentChild: false,
  scheduledTaskSession: false,
  subagentParentPath: null,
  ready: false,
  cwd: null,
  projectless: false,
  sessionId: null,
  sessionPath: null,
  model: null,
  thinkingLevel: 'medium',
  plan: null,
  jevWorkflow: null,
  sandboxMode: DEFAULT_SANDBOX_MODE,
  sandbox: null,
  escalations: [],
  pendingAskUser: [],
  isStreaming: false,
  awaitingRun: false,
  contextUsage: null,
  eventSequence: 0,
  messages: [],
  streaming: null,
  toolRuns: {},
  queue: { steering: [], followUp: [] },
  compactionQueue: EMPTY_COMPACTION_QUEUE,
  compactionProcess: EMPTY_COMPACTION_PROCESS,
  notice: null,
  error: null
}

function shellOf(state: PiState, availableThinkingLevels: ThinkingLevel[]): PiShellState {  return {
    goalUI: state.goalUI,
    initializing: state.initializing,
    ready: state.ready,
    cwd: state.cwd,
    projectless: state.projectless,
    sessionPath: state.sessionPath,
    sessionId: state.sessionId,
    model: state.model,
    thinkingLevel: state.thinkingLevel,
    availableThinkingLevels,
    plan: state.plan,
    sandboxMode: state.sandboxMode,
    sandbox: state.sandbox,
    escalations: state.escalations,
    pendingAskUser: state.pendingAskUser,
    isStreaming: state.isStreaming,
    contextUsage: state.contextUsage,
    queue: state.queue,
    compactionQueue: state.compactionQueue,
    subagentChild: state.subagentChild,
    scheduledTaskSession: state.scheduledTaskSession,
    subagentParentPath: state.subagentParentPath,
    subagents: state.subagents
  }
}

/** Shallow compare of two shell slices; `shellOf` replaces changed values. */
function sameShell(a: PiShellState, b: PiShellState): boolean {
  for (const key of Object.keys(a) as (keyof PiShellState)[]) {
    if (a[key] !== b[key]) return false
  }
  return true
}

type Listener = () => void

/**
 * Equal numbers and an equal metadata revision are unchanged. A new request or
 * branch must still refresh detail when its numeric usage happens to be equal.
 */
function sameUsage(a: ContextUsageDTO | null, b: ContextUsageDTO | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return (
    a.tokens === b.tokens &&
    a.contextWindow === b.contextWindow &&
    a.percent === b.percent &&
    a.sessionCost === b.sessionCost &&
    a.cacheHitRate === b.cacheHitRate &&
    a.revision === b.revision
  )
}

/**
 * External store fed by Pi SDK session events over IPC. The messages array is
 * the render source of truth; `streaming` is a live overlay rendered between
 * the last message and the composer.
 */
export class PiStore {
  private state: PiState = initialState
  private availableThinkingLevels: ThinkingLevel[] = ALL_THINKING_LEVELS
  private shellState: PiShellState = shellOf(initialState, ALL_THINKING_LEVELS)
  private listeners = new Set<Listener>()
  /** Fully rendered state of visited sessions. Re-activating one is synchronous;
   * the main-process snapshot only reconciles changes made in the background. */
  private sessionStates = new Map<string, PiState>()
  /** Events may beat an openSession IPC response; retain them without
   * rendering and replay only those newer than the returned snapshot. */
  private planStates = new Map<string, PlanStateDTO>()
  private jevStates = new Map<string, { seq: number; state: JevWorkflowDTO | null }>()
  private goalStates = new Map<string, { seq: number; goal: GoalSnapshotDTO | null }>()
  private goalUIStates = new Map<string, GoalUIState>()
  private goalPresentationKeys = new Map<string, string>()
  private goalEchoes = new Map<string, { goalId: string | null; message: UserMsg }>()
  private goalUIFor(path: string | null, goal?: GoalSnapshotDTO | null): GoalUIState {
    if (!path) return EMPTY_GOAL_UI
    let ui = this.goalUIStates.get(path)
    if (!ui) {
      const submitted = !!goal && goal.status !== 'cancelled' && !goal.dismissed
      ui = { ...EMPTY_GOAL_UI, enabled: submitted, submitted, limits: goal?.limits ?? DEFAULT_GOAL_LIMITS }
      this.goalUIStates.set(path, ui)
    }
    if (goal !== undefined && !ui.pending) {
      const hidden = !goal || goal.status === 'cancelled' || !!goal.dismissed
      const key = goal ? `${goal.id}:${hidden}` : ''
      if (key !== this.goalPresentationKeys.get(path)) {
        // A restored branch may arrive after an empty startup snapshot. Keep
        // completed goals discoverable too; only explicit End hides them.
        const submitted = !hidden
        ui = { ...ui, enabled: submitted || ui.enabled && !ui.submitted, submitted,
          ...(submitted ? { limits: goal!.limits } : {}), error: null }
        this.goalUIStates.set(path, ui)
        this.goalPresentationKeys.set(path, key)
      }
    }
    return ui
  }
  private setGoalUI(path: string, patch: Partial<GoalUIState>): void {
    let goalUI = { ...this.goalUIFor(path), ...patch }
    this.goalUIStates.set(path, goalUI)
    if (patch.pending === false) goalUI = this.goalUIFor(path, this.goalStates.get(path)?.goal)
    const cached = this.sessionStates.get(path)
    if (cached) this.sessionStates.set(path, { ...cached, goalUI })
    if (this.state.sessionPath === path) this.set({ goalUI })
  }
  openGoalMode(path: string): void {
    const ui = this.goalUIFor(path)
    // Unsubmitted edits to a previous goal's limits must not strand a new
    // selection, which has no task panel until its first message is sent.
    const limits = validGoalLimits(ui.limits) ? ui.limits : this.goalStates.get(path)?.goal?.limits ?? DEFAULT_GOAL_LIMITS
    this.setGoalUI(path, { enabled: true, limits, error: null })
  }
  setGoalDraft(path: string, draft: Pick<GoalUIState, 'limits' | 'acceptance'>): void {
    this.setGoalUI(path, { ...draft, error: null })
  }
  /** IPC records the goal and admits its first user turn without awaiting that turn. */
  async startGoal(input: GoalInput & { text: string }): Promise<boolean> {
    const path = this.state.sessionPath
    if (!path) return false
    const ui = this.goalUIFor(path)
    if (!ui.enabled || ui.pending) return false
    if (!input.text.trim() || !validGoalLimits(ui.limits)) {
      this.setGoalUI(path, { error: 'invalid' }); return false
    }
    const identity = this.goalStates.get(path)
    const echo = this.appendOptimisticUser(optimisticEchoText(input.text, input.files ?? []), input.images ?? [])
    this.goalEchoes.set(path, { goalId: null, message: echo })
    let accepted = false
    this.setGoalUI(path, { pending: true, error: null })
    try {
      const result = await window.pi.goalAction({ sessionPath: path, expectedSeq: identity?.seq ?? 0, goalId: identity?.goal?.id ?? null,
        action: 'create', objective: input.text, acceptance: ui.acceptance.trim() || input.text, limits: ui.limits, images: input.images, files: input.files })
      if (!result.ok) { this.setGoalUI(path, { error: result.code }); return false }
      this.goalEchoes.set(path, { goalId: result.goal?.id ?? null, message: echo })
      this.dispatch({ type: 'goal_update', sessionPath: path, goal: result.goal, goalSeq: result.seq })
      this.setGoalUI(path, { acceptance: '', submitted: true })
      accepted = true
      return true
    } catch { this.setGoalUI(path, { error: 'unavailable' }); return false }
    finally {
      if (!accepted) this.removeOptimisticUser(path, echo)
      this.setGoalUI(path, { pending: false })
      if (accepted) this.settleGoalEcho(path, this.goalStates.get(path)?.goal ?? null)
      else this.goalEchoes.delete(path)
    }
  }
  async endGoalMode(path: string): Promise<void> {
    const ui = this.goalUIFor(path)
    if (ui.pending) return
    const identity = this.goalStates.get(path)
    if (!identity?.goal || identity.goal.status === 'cancelled' || identity.goal.dismissed || !ui.submitted) {
      this.setGoalUI(path, { enabled: false, submitted: false, error: null }); return
    }
    this.setGoalUI(path, { pending: true, error: null })
    try {
      const result = await window.pi.goalAction({ sessionPath: path, expectedSeq: identity.seq, goalId: identity.goal.id,
        action: identity.goal.status === 'completed' ? 'dismiss' : 'cancel' })
      if (!result.ok) { this.setGoalUI(path, { error: result.code }); return }
      this.dispatch({ type: 'goal_update', sessionPath: path, goal: result.goal, goalSeq: result.seq })
      this.setGoalUI(path, { enabled: false, submitted: false })
    } catch { this.setGoalUI(path, { error: 'unavailable' }) }
    finally { this.setGoalUI(path, { pending: false }) }
  }
  private mergeGoal(path: string | null, goal: GoalSnapshotDTO | null | undefined, seq = 0): { goal: GoalSnapshotDTO | null; goalSeq: number } {
    if (!path) return { goal: null, goalSeq: 0 }
    const previous = this.goalStates.get(path)
    if (!previous || seq > previous.seq) this.goalStates.set(path, { seq, goal: goal ?? null })
    const merged = this.goalStates.get(path)!
    return { goal: merged.goal, goalSeq: merged.seq }
  }
  private compactionQueues = new Map<string, CompactionQueueStateDTO>()
  private compactionProcesses = new Map<string, CompactionProcessStateDTO>()
  private mergeCompactionProcess(path: string | null, next?: CompactionProcessStateDTO): CompactionProcessStateDTO {
    if (!path) return EMPTY_COMPACTION_PROCESS
    const previous = this.compactionProcesses.get(path)
    const merged = next && (!previous || next.revision > previous.revision) ? next : previous
    if (merged) this.compactionProcesses.set(path, merged)
    return merged ?? EMPTY_COMPACTION_PROCESS
  }
  private mergeCompactionQueue(path: string | null, next?: CompactionQueueStateDTO): CompactionQueueStateDTO {
    if (!path) return EMPTY_COMPACTION_QUEUE
    const previous = this.compactionQueues.get(path)
    const merged = next && (!previous || next.revision > previous.revision) ? next : previous
    if (merged) this.compactionQueues.set(path, merged)
    return merged ?? EMPTY_COMPACTION_QUEUE
  }
  private mergeJevState(path: string | null, state: JevWorkflowDTO | null | undefined, seq = 0): JevWorkflowDTO | null {
    if (!path) return null
    const previous = this.jevStates.get(path)
    if (previous && previous.seq > seq) return previous.state
    this.jevStates.set(path, { seq, state: state ?? null })
    return state ?? null
  }
  private mergePlanState(path: string | null, next?: PlanStateDTO | null): PlanStateDTO | null {
    if (!path) return null
    const previous = this.planStates.get(path)
    const merged = next && (!previous || next.seq > previous.seq) ? next : previous
    if (merged) this.planStates.set(path, merged)
    return merged ?? null
  }
  private pendingEvents = new Map<string, PiEvent[]>()

  getState = (): PiState => this.state

  getShell = (): PiShellState => this.shellState

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private set(patch: Partial<PiState>): void {
    const prev = this.state
    this.state = { ...prev, ...patch }
    if (this.state.sessionPath) this.sessionStates.set(this.state.sessionPath, this.state)
    // Compare the slice itself rather than a hand-maintained field list: a new
    // shell field must not be able to silently stop reaching the UI (a pending
    // escalation that never arrives is a question nobody can answer).
    const nextShell = shellOf(this.state, this.availableThinkingLevels)
    if (!sameShell(nextShell, this.shellState)) this.shellState = nextShell
    for (const listener of this.listeners) listener()
  }

  private setAvailableThinkingLevels(levels: ThinkingLevel[] | undefined): void {
    const next = levels?.length ? levels : ALL_THINKING_LEVELS
    if (next === this.availableThinkingLevels || next.join() === this.availableThinkingLevels.join()) {
      return
    }
    this.availableThinkingLevels = next
    this.shellState = shellOf(this.state, next)
  }

  applySnapshot(snapshot: SessionSnapshotDTO): void {
    const sessionPath = snapshot.sessionPath ?? null
    const plan = this.mergePlanState(sessionPath, snapshot.plan)
    const jevWorkflow = this.mergeJevState(sessionPath, snapshot.jevWorkflow, snapshot.jevWorkflowSeq)
    const goal = this.mergeGoal(sessionPath, snapshot.goal, snapshot.goalSeq)
    const goalUI = this.goalUIFor(sessionPath, goal.goal)
    const compactionQueue = this.mergeCompactionQueue(sessionPath, snapshot.compactionQueue)
    const compactionProcess = this.mergeCompactionProcess(sessionPath, snapshot.compactionProcess)
    const previousCached = sessionPath ? this.sessionStates.get(sessionPath) : undefined
    const snapshotSequence = snapshot.eventSequence ?? 0
    // Roster revisions are independent of transcript revisions, and belong
    // only to this session. Never merge the outgoing chat into an incoming one.
    const subagents = mergeRoster(previousCached?.subagents ?? [], snapshot.subagents ?? [])
    const cached = previousCached ? { ...previousCached, subagents, plan, jevWorkflow, ...goal, goalUI, compactionQueue, compactionProcess } : undefined
    if (cached) this.sessionStates.set(sessionPath!, cached)
    // A readiness/event push can overtake an IPC snapshot of a cached session.
    // Keep the newer projection (including its sequence), then replay any
    // background events instead of reverting to an initialization that ended.
    if (cached && cached.eventSequence > snapshotSequence) {
      this.activateCachedSession(sessionPath!)
      return
    }
    this.setAvailableThinkingLevels(snapshot.availableThinkingLevels)
    // An unchanged visited session keeps its message/tool object identities so
    // switching back does not remount Markdown and tool trees after the instant
    // cached paint.
    const unchanged = cached?.eventSequence === snapshotSequence
    const messages = unchanged ? cached.messages : [...snapshot.messages,
      ...(cached?.messages.filter(message => (message as any).__optimistic && message.role === 'user' &&
        !snapshot.messages.some(committed => committed.role === 'user' && committed.timestamp >= message.timestamp)) ?? [])]
    this.set({
      ...(unchanged ? cached : {}),
      ready: true,
      initializing: snapshot.initializing ?? false,
      // An unanswered question belongs to the session it was asked in. The
      // snapshot carries the pending list (fresh at serialization), so neither
      // a session switch nor an IPC snapshot can lose one to event ordering.
      escalations: snapshot.escalations ?? (unchanged ? (cached?.escalations ?? []) : []),
      pendingAskUser: snapshot.pendingAskUser ?? (unchanged ? (cached?.pendingAskUser ?? []) : []),
      cwd: snapshot.cwd,
      projectless: snapshot.projectless,
      sessionId: snapshot.sessionId,
      sessionPath,
      model: snapshot.model,
      thinkingLevel: snapshot.thinkingLevel,
      // The mode is a fact about the session, not about this render: an
      // unchanged snapshot still carries the newest value, and a session that
      // never recorded one keeps what we last saw.
      plan,
      jevWorkflow,
      ...goal,
      goalUI,
      sandboxMode: snapshot.sandboxMode ?? cached?.sandboxMode ?? DEFAULT_SANDBOX_MODE,
      sandbox: snapshot.sandbox ?? cached?.sandbox ?? null,
      isStreaming: snapshot.isStreaming,
      // The echo's pending run is a fact about THIS view: a snapshot for the
      // same session cannot disprove it (it was taken before the run started),
      // while another session's snapshot must not inherit it.
      awaitingRun: cached?.awaitingRun ?? (this.state.sessionPath === sessionPath ? this.state.awaitingRun : false),
      subagentChild: snapshot.subagentChild === true,
      scheduledTaskSession: snapshot.scheduledTaskSession === true,
      subagentParentPath: snapshot.subagentParentPath ?? null,
      activeChangeScopeId: snapshot.activeChangeScopeId ?? null,
      contextUsage: unchanged ? cached.contextUsage : (snapshot.contextUsage ?? null),
      eventSequence: snapshotSequence,
      messages,
      todos: unchanged ? cached.todos : (snapshot.todos ?? null),
      askUserRecords: unchanged ? cached.askUserRecords : (snapshot.askUserRecords ?? []),
      subagents,
      streaming: unchanged ? cached.streaming : (snapshot.streaming ?? null),
      toolRuns: unchanged ? cached.toolRuns : (snapshot.toolRuns ?? {}),
      queue: unchanged ? cached.queue : (snapshot.queue ?? { steering: [], followUp: [] }),
      compactionQueue,
      compactionProcess,
      notice: unchanged ? cached.notice : null,
      error: unchanged ? cached.error : null
    })
    // An idle session has no tool executing: a run restored from disk (the
    // session was stopped, or the app died mid-execution) is a failure, not a
    // live row. A streaming snapshot keeps its runs untouched.
    if (!snapshot.isStreaming) this.settleToolRuns()
    if (!sessionPath) return
    const pending = this.pendingEvents.get(sessionPath) ?? []
    this.pendingEvents.delete(sessionPath)
    for (const event of pending) {
      if (event.type === 'subagents_update' || (event.eventSequence ?? 0) > snapshotSequence) this.dispatch(event)
    }
    this.settleGoalEcho(sessionPath, this.goalStates.get(sessionPath)?.goal ?? null)
  }

  /** Local queue clear after a successful recall — the SDK's (empty)
   * queue_update confirms it, but the IPC result is already authoritative. */
  clearQueue(): void {
    this.set({ queue: { steering: [], followUp: [] } })
  }

  /**
   * Replace the composer ring's payload (per turn boundary and every 2s from
   * the main process' poll). Published through `set()` so the shell slice the
   * composer reads is rebuilt in the same notification: staging it straight
   * onto `state` — as message boundaries used to — left the ring showing
   * whatever the last shell-relevant field change happened to publish, which
   * could freeze the readout for a whole run.
   */
  setContextUsage(usage: ContextUsageDTO | null): void {
    if (sameUsage(this.state.contextUsage, usage)) return
    this.set({ contextUsage: usage })
  }

  /**
   * Close every tool run that can no longer finish.
   *
   * A run that dies with its agent — Stop, a provider error, a crash — never
   * receives its `tool_execution_end` (the SDK's loop returns as soon as a round
   * ends aborted/errored), and a call the abort cut off before execution never
   * starts a run at all. Either way the row would read "Running" forever, so the
   * transcript settles them as failures the moment the run is known to be over:
   * every run still marked running, plus a synthesized error run for a
   * transcript tool call with neither a result nor a run.
   */
  private settleToolRuns(): void {
    const pending = new Map<string, ToolCallContent>()
    const resolved = new Set<string>()
    // The live overlay is not in `messages` yet; at settle time its tool calls
    // are just as dead as the ones already committed to the transcript.
    const history = this.state.streaming
      ? [...this.state.messages, this.state.streaming]
      : this.state.messages
    for (const message of history) {
      if (message.role === 'assistant') {
        for (const part of message.content) {
          if (part.type === 'toolCall' && !pending.has(part.id)) pending.set(part.id, part)
        }
      } else if (message.role === 'toolResult') {
        resolved.add(message.toolCallId)
      }
    }
    const toolRuns = { ...this.state.toolRuns }
    const now = Date.now()
    let changed = false
    for (const [id, run] of Object.entries(toolRuns)) {
      if (run.status !== 'running') continue
      toolRuns[id] = { ...run, status: 'error', endedAt: run.endedAt ?? now }
      changed = true
    }
    for (const [id, call] of pending) {
      if (resolved.has(id) || toolRuns[id]) continue
      // `startedAt: 0` — the call never ran, so the row reports no duration.
      toolRuns[id] = {
        toolCallId: id,
        toolName: call.name,
        args: call.arguments,
        status: 'error',
        partial: undefined,
        startedAt: 0
      }
      changed = true
    }
    if (changed) this.set({ toolRuns })
  }

  /** Immediately show a previously visited session while main-process
   * activation and snapshot reconciliation continue in the background. */
  activateCachedSession(sessionPath: string): boolean {
    const cached = this.sessionStates.get(sessionPath)
    if (!cached) return false
    const prev = this.state
    this.state = {
      ...cached,
      goalUI: this.goalUIFor(sessionPath, cached.goal),
      plan: this.mergePlanState(sessionPath, cached.plan),
      compactionQueue: this.mergeCompactionQueue(sessionPath, cached.compactionQueue),
      compactionProcess: this.mergeCompactionProcess(sessionPath, cached.compactionProcess)
    }
    this.shellState = shellOf(this.state, this.availableThinkingLevels)
    for (const listener of this.listeners) listener()

    const pending = this.pendingEvents.get(sessionPath) ?? []
    this.pendingEvents.delete(sessionPath)
    for (const event of pending) {
      if (event.type === 'subagents_update' || (event.eventSequence ?? 0) > this.state.eventSequence) this.dispatch(event)
    }
    this.settleGoalEcho(sessionPath, this.goalStates.get(sessionPath)?.goal ?? null)
    return prev !== cached
  }

  /** Immediately show the outgoing prompt; replaced by the real message_end. */
  appendOptimisticUser(text: string, images: UserMsg['content'] extends string ? never : any[]): UserMsg {
    // SAFETY: the echo is a renderer-only row; `__optimistic` marks it for the
    // message_end swap and `UserMsg` carries no such field, so a cast is the
    // only way to keep the placeholder inside the transcript's message list.
    const optimistic = {
      role: 'user',
      content: images.length ? [{ type: 'text', text }, ...images] : text,
      timestamp: Date.now(),
      __optimistic: true
    } as unknown as UserMsg
    // The waiting row rides the echo: the run this prompt opens is already a
    // fact in the UI, so the spinner and its sentence appear in the same
    // commit as the bubble instead of waiting for `agent_start`.
    this.set({ messages: [...this.state.messages, optimistic], awaitingRun: true })
    return optimistic
  }

  private removeOptimisticUser(path: string, echo: UserMsg): void {
    const remove = (state: PiState) => {
      if (!state.messages.includes(echo)) return state
      const messages = state.messages.filter(message => message !== echo)
      return { ...state, messages, awaitingRun: messages.some(message => !!(message as any).__optimistic) }
    }
    const cached = this.sessionStates.get(path)
    if (cached) this.sessionStates.set(path, remove(cached))
    if (this.state.sessionPath === path) this.set(remove(this.state))
  }

  private settleGoalEcho(path: string, goal: GoalSnapshotDTO | null): void {
    const echo = this.goalEchoes.get(path)
    if (!echo || !echo.goalId) return
    const state = this.state.sessionPath === path ? this.state : this.sessionStates.get(path)
    if (!state?.messages.includes(echo.message)) { this.goalEchoes.delete(path); return }
    // An extension may handle the input, or Stop may win before the first SDK
    // user commit. Retain the durable Goal/input, but not a fictitious sent row.
    const branchChanged = (!goal || goal.id !== echo.goalId) && !this.goalUIStates.get(path)?.pending
    const unaccepted = goal?.id === echo.goalId && !goal.executing && (goal.status === 'cancelled' ||
      !['active', 'verifying'].includes(goal.status) && !!goal.pendingInput)
    if (branchChanged || unaccepted) {
      this.removeOptimisticUser(path, echo.message)
      this.goalEchoes.delete(path)
    }
  }

  dispatch(event: PiEvent): void {
    if (event.type === 'compaction_process_update' && event.sessionPath && event.compactionProcess) {
      const compactionProcess = this.mergeCompactionProcess(event.sessionPath, event.compactionProcess)
      const cached = this.sessionStates.get(event.sessionPath)
      if (cached) this.sessionStates.set(event.sessionPath, { ...cached, compactionProcess })
      if (event.sessionPath === this.state.sessionPath && compactionProcess !== this.state.compactionProcess) this.set({ compactionProcess })
      return
    }
    if (event.type === 'compaction_queue_update' && event.sessionPath && event.compactionQueue) {
      const compactionQueue = this.mergeCompactionQueue(event.sessionPath, event.compactionQueue)
      const cached = this.sessionStates.get(event.sessionPath)
      if (cached) this.sessionStates.set(event.sessionPath, { ...cached, compactionQueue })
      if (event.sessionPath === this.state.sessionPath && compactionQueue !== this.state.compactionQueue) this.set({ compactionQueue })
      return
    }
    if (event.type === 'jev_workflow_update' && event.sessionPath) {
      const jevWorkflow = this.mergeJevState(event.sessionPath, event.jevWorkflow, event.jevWorkflowSeq)
      const cached = this.sessionStates.get(event.sessionPath)
      if (cached) this.sessionStates.set(event.sessionPath, { ...cached, jevWorkflow })
      if (event.sessionPath === this.state.sessionPath && jevWorkflow !== this.state.jevWorkflow) this.set({ jevWorkflow })
      return
    }
    if (event.type === 'goal_update' && event.sessionPath) {
      const goal = this.mergeGoal(event.sessionPath, event.goal, event.goalSeq)
      const goalUI = this.goalUIFor(event.sessionPath, goal.goal)
      const cached = this.sessionStates.get(event.sessionPath)
      if (cached) this.sessionStates.set(event.sessionPath, { ...cached, ...goal, goalUI })
      if (event.sessionPath === this.state.sessionPath && (goal.goalSeq !== this.state.goalSeq || goalUI !== this.state.goalUI)) this.set({ ...goal, goalUI,
        // A Goal can decide to pause after the settled event's continuation
        // hint. Clearing that hint is metadata, not a second transcript end.
        ...(goal.goal && !goal.goal.executing && !['active', 'verifying'].includes(goal.goal.status) ? { isStreaming: false } : {}) })
      this.settleGoalEcho(event.sessionPath, goal.goal)
      return
    }
    if (event.type === 'plan_state_update' && event.sessionPath && event.plan) {
      const plan = this.mergePlanState(event.sessionPath, event.plan)
      const cached = this.sessionStates.get(event.sessionPath)
      if (cached) this.sessionStates.set(event.sessionPath, { ...cached, plan })
      if (event.sessionPath === this.state.sessionPath && plan !== this.state.plan) this.set({ plan })
      return
    }
    // Events from background sessions are intentionally retained by the main
    // process, but only the visible session is allowed to update this view.
    if (event.sessionPath && event.sessionPath !== this.state.sessionPath) {
      const pending = this.pendingEvents.get(event.sessionPath) ?? []
      // Snapshots are authoritative for older history, so only a short race
      // window must be retained. Keep the newest events if a background turn
      // produces a long sequence before the user opens it.
      this.pendingEvents.set(event.sessionPath, [...pending.slice(-99), event])
      return
    }
    if (typeof event.eventSequence === 'number') {
      if (event.eventSequence <= this.state.eventSequence) return
      // Update without notifying; the branch below emits one consolidated
      // notification with the actual state patch.
      this.state = { ...this.state, eventSequence: event.eventSequence }
    }

    // Main sends committed task state with its sequenced message/branch event.
    // It is independent of compaction's replacement transcript.
    if ('todos' in event) this.state = { ...this.state, todos: event.todos ?? null }
    const eventRecords = (event as { askUserRecords?: unknown }).askUserRecords
    if (Array.isArray(eventRecords)) {
      this.state = { ...this.state, askUserRecords: eventRecords as AskUserRecordDTO[] }
    }
    switch (event.type) {
      case 'session_initialized':
        this.setAvailableThinkingLevels(event.availableThinkingLevels)
        this.set({ initializing: false, model: event.model, thinkingLevel: event.thinkingLevel,
          contextUsage: event.contextUsage ?? null, awaitingRun: false })
        break

      case 'agent_start':
        // The announced run owns the waiting row from here on (`isStreaming`).
        this.set({ isStreaming: true, awaitingRun: false, activeChangeScopeId: event.changeScopeId ?? null, notice: null, error: null })
        break

      case 'message_start': {
        const message = event.message as ChatMessage
        if (message.role === 'assistant') {
          this.set({ streaming: message as AssistantMsg })
        }
        break
      }

      case 'message_update': {
        const message = event.message as ChatMessage
        if (message.role === 'assistant') {
          this.set({ streaming: message as AssistantMsg })
        }
        break
      }

      case 'message_end': {
        // Main attaches SDK context usage to these events, so the ring lands in
        // the same tick as the message it belongs to.
        if ('contextUsage' in event) this.setContextUsage(event.contextUsage ?? null)
        // SDK system messages carry prompt/tool updates, not chat transcript
        // rows. Their timestamps can match the following user message.
        if (event.message?.role === 'system') break
        const message = event.message as ChatMessage
        if (message.role === 'user') {
          const incoming = message as UserMsg
          const messages = [...this.state.messages]
          const lastIndex = messages.length - 1
          const last = messages[lastIndex]
          // Swap the optimistic echo for the persisted message.
          if (last && (last as any).__optimistic && last.role === 'user') {
            messages[lastIndex] = incoming
            this.set({ messages })
          } else if (!last || last.role !== 'user' || last.timestamp !== incoming.timestamp) {
            // A send the renderer believed idle can be queued as a steer when
            // the main process disagrees (double-send before agent_start
            // arrives); its message_end then lands mid-run with the echo no
            // longer the tail. Drop the matching echo instead of duplicating
            // the row until the next snapshot. Comparison ignores inlined
            // file blocks — the echo carries "(pending)" placeholders there.
            const prose = userProse(incoming.content)
            const withoutEcho = prose
              ? messages.filter(
                  (m) =>
                    !((m as any).__optimistic && m.role === 'user' && userProse(m.content) === prose)
                )
              : messages
            this.set({ messages: [...withoutEcho, incoming] })
          }
        } else if (message.role === 'assistant') {
          const incoming = message as AssistantMsg
          const messages = [...this.state.messages]
          const index = messages.findIndex(
            (m) => m.role === 'assistant' && m.timestamp === incoming.timestamp
          )
          if (index >= 0) messages[index] = incoming
          else insertByTimestamp(messages, incoming)
          this.set({
            messages,
            streaming:
              this.state.streaming?.timestamp === incoming.timestamp ? null : this.state.streaming
          })
          // A round that ended aborted/errored runs no tool call of its own and
          // ends the run, so whatever it left hanging is settled as failed here
          // rather than staying "Running" until (or past) `agent_settled`.
          if (incoming.stopReason === 'aborted' || incoming.stopReason === 'error') {
            this.settleToolRuns()
          }
        } else if (message.role === 'toolResult') {
          const incoming = message as ToolResultMsg
          const toolRuns = { ...this.state.toolRuns }
          const run = toolRuns[incoming.toolCallId]
          if (run) {
            // Pi may publish the results of several tool calls only after the
            // whole batch finishes. Keep the end time from this call's own
            // tool_execution_end; stamping every result on arrival made the
            // earlier calls appear to take as long as the last one.
            toolRuns[incoming.toolCallId] = {
              ...run,
              status: incoming.isError ? 'error' : 'success',
              endedAt: run.endedAt ?? Date.now()
            }
          }
          const messages = [...this.state.messages]
          insertByTimestamp(messages, incoming)
          this.set({ messages, toolRuns })
        } else if (message.role === 'custom' && !(message as any).display) {
          // Hidden extension messages stay in the transcript data only.
          break
        } else {
          // Non-LLM transcript entries (bash execution, custom/extension or
          // summary messages) belong in the visible history too.
          const last = this.state.messages[this.state.messages.length - 1]
          if (!last || last.timestamp !== message.timestamp) {
            const messages = [...this.state.messages]
            insertByTimestamp(messages, message)
            this.set({ messages })
          }
        }
        break
      }

      case 'thinking_level_changed':
        // The SDK clamps on model switches and may cycle on its own; follow it.
        this.set({ thinkingLevel: event.level as ThinkingLevel })
        break

      case 'tool_execution_start': {
        const toolRuns = { ...this.state.toolRuns }
        toolRuns[event.toolCallId] = {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args,
          status: 'running',
          partial: undefined,
          startedAt: Date.now()
        }
        this.set({ toolRuns })
        break
      }

      case 'tool_execution_update': {
        const toolRuns = { ...this.state.toolRuns }
        const run = toolRuns[event.toolCallId]
        if (run) {
          toolRuns[event.toolCallId] = { ...run, partial: event.partialResult }
        }
        this.set({ toolRuns })
        break
      }

      case 'tool_execution_end': {
        const toolRuns = { ...this.state.toolRuns }
        const run = toolRuns[event.toolCallId]
        if (run && run.status === 'running') {
          toolRuns[event.toolCallId] = {
            ...run,
            status: event.isError ? 'error' : 'success',
            endedAt: Date.now(),
            partial: event.result ?? run.partial
          }
        }
        this.set({ toolRuns })
        break
      }

      // Sequence-free roster ping (same rule as context_usage): the roster is
      // task-panel metadata, not a step of the transcript's event log. A
      // background parent's updates are parked and the snapshot reconciles on
      // switch-back.
      case 'subagents_update':
        this.set({ subagents: mergeRoster(this.state.subagents, event.subagents ?? []) })
        break

      case 'agent_end':
        // Post-run continuations (auto-retry, compaction, queued messages) keep
        // the run alive after agent_end — only `agent_settled` means idle.
        // The partial is already cleared by its message_end.
        break

      case 'agent_settled':
        // A settled run (or one that never announced itself) releases the
        // echo's waiting row too, so a prompt main dropped cannot spin forever.
        this.set({ isStreaming: Boolean(event.continuing), streaming: null, awaitingRun: false })
        // The run is over: nothing can still be executing, so a run without an
        // end is one that never got to finish (Stop, provider error, a crash).
        this.settleToolRuns()
        break

      case 'queue_update':
        this.set({
          queue: { steering: [...event.steering], followUp: [...event.followUp] }
        })
        break

      case 'auto_retry_start':
        this.set({
          notice: {
            key: 'retrying',
            params: { attempt: event.attempt, maxAttempts: event.maxAttempts }
          }
        })
        break

      case 'auto_retry_end':
        this.set({
          notice: event.success ? null : { key: 'retryFailed', detail: event.finalError }
        })
        break

      case 'compaction_start':
        this.set({ notice: { key: 'compacting' } })
        break

      // Main-process 2s poll: the ring tracks the growing context while a turn
      // is in flight, instead of jumping only at message boundaries. Carries no
      // eventSequence — it is metadata, not a step of the session's event log.
      case 'context_usage':
        this.setContextUsage(event.contextUsage ?? null)
        break

      // Main publishes the whole pending set for one session whenever it
      // changes; only the visible session's questions belong in this store.
      case 'sandbox_escalation': {
        if (event.sessionPath && event.sessionPath !== this.state.sessionPath) break
        this.set({
          escalations: Array.isArray(event.requests)
            ? (event.requests as SandboxEscalationRequestDTO[])
            : []
        })
        break
      }

      // Main republishes the whole pending question-set list for one chat
      // whenever it changes; only the visible session's questions belong here
      // (a subagent child's set arrives under the parent's owner path).
      case 'ask_user': {
        if (event.sessionPath && event.sessionPath !== this.state.sessionPath) break
        this.set({
          pendingAskUser: Array.isArray(event.requests)
            ? (event.requests as PendingAskUserDTO[])
            : []
        })
        break
      }

      case 'compaction_end': {
        // Main ships the full selected-branch transcript with the new summary;
        // compacted-out history remains visible even though it left model context.
        // The acknowledgement is the summary row itself — a session entry that
        // renders where it happened (`chat-turns` places it by time) and is
        // still there when the session is reopened, which a UI-only row was not.
        const messages = Array.isArray(event.messages) ? (event.messages as ChatMessage[]) : null
        const nothingToCompact = isNothingToCompactError(event.errorMessage)
        this.set({
          ...(messages ? { messages, streaming: null } : {}),
          notice: event.errorMessage && !nothingToCompact
            ? { key: 'compactFailed', detail: event.errorMessage }
            : null,
          ...('contextUsage' in event ? { contextUsage: event.contextUsage ?? null } : {})
        })
        break
      }

      case 'pi_error':
        this.set({ error: event.rewindError ?? event.message, isStreaming: false, streaming: null, awaitingRun: false })
        break

      default:
        break
    }
  }

  clearError(): void {
    this.set({ error: null })
  }
}
