import type {
  AssistantMsg,
  ChatMessage,
  ContextUsageDTO,
  ModelRefDTO,
  PiEvent,
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
import { DEFAULT_SANDBOX_MODE, type SandboxMode, type SandboxStatusDTO } from '../../../shared/types'

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

/**
 * A settled compaction, as a quiet row in the transcript flow. It is feedback,
 * not session content: the session's own record of a compaction is the
 * summary entry the SDK writes, so this is deliberately UI-only and vanishes
 * when the session changes.
 */
export type CompactionNotice = {
  id: string
  tokensBefore: number
  tokensAfter: number | null
  at: number
}

export interface PiState {
  initializing: boolean
  todos: TodoSnapshotDTO | null
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
  sandboxMode: SandboxMode
  /** What the host can enforce for that mode right now. */
  sandbox: SandboxStatusDTO | null
  /** Compactions that settled while this session was on screen. */
  compactionNotices: CompactionNotice[]
  isStreaming: boolean
  /** True while the visible session is itself a subagent child (read-only). */
  subagentChild: boolean
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
  initializing: boolean
  ready: boolean
  cwd: string | null
  projectless: boolean
  sessionPath: string | null
  model: ModelRefDTO | null
  thinkingLevel: ThinkingLevel
  /** Levels the current model supports; cycles through these only. */
  availableThinkingLevels: ThinkingLevel[]
  /** This session's DSH file-sandbox mode and what the host can enforce. */
  sandboxMode: SandboxMode
  sandbox: SandboxStatusDTO | null
  isStreaming: boolean
  contextUsage: ContextUsageDTO | null
  /** Pending steering/follow-up messages (SDK queue state) for the composer. */
  queue: { steering: QueuedItemDTO[]; followUp: QueuedItemDTO[] }
  /** True while the visible session is a subagent child (composer disabled). */
  subagentChild: boolean
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

const initialState: PiState = {
  initializing: false,
  todos: null,
  subagents: [],
  subagentChild: false,
  subagentParentPath: null,
  ready: false,
  cwd: null,
  projectless: false,
  sessionId: null,
  sessionPath: null,
  model: null,
  thinkingLevel: 'medium',
  sandboxMode: DEFAULT_SANDBOX_MODE,
  sandbox: null,
  compactionNotices: [],
  isStreaming: false,
  contextUsage: null,
  eventSequence: 0,
  messages: [],
  streaming: null,
  toolRuns: {},
  queue: { steering: [], followUp: [] },
  notice: null,
  error: null
}

function shellOf(state: PiState, availableThinkingLevels: ThinkingLevel[]): PiShellState {
  return {
    initializing: state.initializing,
    ready: state.ready,
    cwd: state.cwd,
    projectless: state.projectless,
    sessionPath: state.sessionPath,
    model: state.model,
    thinkingLevel: state.thinkingLevel,
    availableThinkingLevels,
    sandboxMode: state.sandboxMode,
    sandbox: state.sandbox,
    isStreaming: state.isStreaming,
    contextUsage: state.contextUsage,
    queue: state.queue,
    subagentChild: state.subagentChild,
    subagentParentPath: state.subagentParentPath,
    subagents: state.subagents
  }
}

type Listener = () => void

/**
 * Context usage only "changed" when one of its numbers moved: the main process
 * re-pushes the same payload on a fixed cadence, and a fresh object with equal
 * numbers must not re-render the workspace. `===` on the nullable halves keeps
 * a null → null transition free.
 */
function sameUsage(a: ContextUsageDTO | null, b: ContextUsageDTO | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return (
    a.tokens === b.tokens &&
    a.contextWindow === b.contextWindow &&
    a.percent === b.percent &&
    a.sessionCost === b.sessionCost &&
    a.cacheHitRate === b.cacheHitRate
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
    if (
      prev.ready !== this.state.ready ||
      prev.initializing !== this.state.initializing ||
      prev.cwd !== this.state.cwd ||
      prev.projectless !== this.state.projectless ||
      prev.sessionPath !== this.state.sessionPath ||
      prev.model !== this.state.model ||
      prev.thinkingLevel !== this.state.thinkingLevel ||
      prev.isStreaming !== this.state.isStreaming ||
      prev.subagentChild !== this.state.subagentChild ||
      prev.subagentParentPath !== this.state.subagentParentPath ||
      prev.subagents !== this.state.subagents ||
      prev.contextUsage !== this.state.contextUsage ||
      prev.queue !== this.state.queue
    ) {
      this.shellState = shellOf(this.state, this.availableThinkingLevels)
    }
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
    const previousCached = sessionPath ? this.sessionStates.get(sessionPath) : undefined
    const snapshotSequence = snapshot.eventSequence ?? 0
    // Roster revisions are independent of transcript revisions, and belong
    // only to this session. Never merge the outgoing chat into an incoming one.
    const subagents = mergeRoster(previousCached?.subagents ?? [], snapshot.subagents ?? [])
    const cached = previousCached ? { ...previousCached, subagents } : undefined
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
    this.set({
      ...(unchanged ? cached : {}),
      ready: true,
      initializing: snapshot.initializing ?? false,
      // Switching sessions drops the previous session's compaction feedback
      // along with its transcript.
      compactionNotices: unchanged ? (cached?.compactionNotices ?? []) : [],
      cwd: snapshot.cwd,
      projectless: snapshot.projectless,
      sessionId: snapshot.sessionId,
      sessionPath,
      model: snapshot.model,
      thinkingLevel: snapshot.thinkingLevel,
      // The mode is a fact about the session, not about this render: an
      // unchanged snapshot still carries the newest value, and a session that
      // never recorded one keeps what we last saw.
      sandboxMode: snapshot.sandboxMode ?? cached?.sandboxMode ?? DEFAULT_SANDBOX_MODE,
      sandbox: snapshot.sandbox ?? cached?.sandbox ?? null,
      isStreaming: snapshot.isStreaming,
      subagentChild: snapshot.subagentChild === true,
      subagentParentPath: snapshot.subagentParentPath ?? null,
      activeChangeScopeId: snapshot.activeChangeScopeId ?? null,
      contextUsage: unchanged ? cached.contextUsage : (snapshot.contextUsage ?? null),
      eventSequence: snapshotSequence,
      messages: unchanged ? cached.messages : snapshot.messages,
      todos: unchanged ? cached.todos : (snapshot.todos ?? null),
      subagents,
      streaming: unchanged ? cached.streaming : (snapshot.streaming ?? null),
      toolRuns: unchanged ? cached.toolRuns : (snapshot.toolRuns ?? {}),
      queue: unchanged ? cached.queue : (snapshot.queue ?? { steering: [], followUp: [] }),
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
    this.state = cached
    this.shellState = shellOf(cached, this.availableThinkingLevels)
    for (const listener of this.listeners) listener()

    const pending = this.pendingEvents.get(sessionPath) ?? []
    this.pendingEvents.delete(sessionPath)
    for (const event of pending) {
      if (event.type === 'subagents_update' || (event.eventSequence ?? 0) > this.state.eventSequence) this.dispatch(event)
    }
    return prev !== cached
  }

  /** Immediately show the outgoing prompt; replaced by the real message_end. */
  appendOptimisticUser(text: string, images: UserMsg['content'] extends string ? never : any[]): void {
    const optimistic = {
      role: 'user',
      content: images.length ? [{ type: 'text', text }, ...images] : text,
      timestamp: Date.now(),
      __optimistic: true
    } as unknown as UserMsg
    this.set({ messages: [...this.state.messages, optimistic] })
  }

  dispatch(event: PiEvent): void {
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
    switch (event.type) {
      case 'session_initialized':
        this.setAvailableThinkingLevels(event.availableThinkingLevels)
        this.set({ initializing: false, model: event.model, thinkingLevel: event.thinkingLevel,
          contextUsage: event.contextUsage ?? null })
        break

      case 'agent_start':
        this.set({ isStreaming: true, activeChangeScopeId: event.changeScopeId ?? null, notice: null, error: null })
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
          } else if (!last || last.timestamp !== incoming.timestamp) {
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
            run.status = incoming.isError ? 'error' : 'success'
            run.endedAt = Date.now()
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
        this.set({ isStreaming: Boolean(event.continuing), streaming: null })
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

      case 'compaction_end': {
        // Main ships the rewritten (compaction-aware) message list with the
        // event; adopting it keeps the transcript in step with the SDK context.
        const messages = Array.isArray(event.messages) ? (event.messages as ChatMessage[]) : null
        // A compaction replaces the whole transcript, so it needs an explicit
        // acknowledgement in the flow — the same quiet row a background-task
        // completion gets — or the swap reads as the conversation changing by
        // itself. Token counts come from the compaction result; a compaction
        // that was aborted or failed is not a completion and adds no row.
        const result = event.result as { tokensBefore?: unknown; estimatedTokensAfter?: unknown } | undefined
        const tokensBefore = typeof result?.tokensBefore === 'number' ? result.tokensBefore : null
        const tokensAfter = typeof result?.estimatedTokensAfter === 'number' ? result.estimatedTokensAfter : null
        const settled = event.aborted !== true && !event.errorMessage && tokensBefore !== null
        const compactionNotices = settled
          ? [
              ...this.state.compactionNotices,
              {
                id: `c${event.eventSequence ?? Date.now()}`,
                tokensBefore: tokensBefore as number,
                tokensAfter,
                at: Date.now()
              }
            ]
          : this.state.compactionNotices
        this.set({
          ...(messages ? { messages, streaming: null } : {}),
          notice: event.errorMessage
            ? { key: 'compactFailed', detail: event.errorMessage }
            : null,
          compactionNotices,
          ...('contextUsage' in event ? { contextUsage: event.contextUsage ?? null } : {})
        })
        break
      }

      case 'pi_error':
        this.set({ error: event.rewindError ?? event.message, isStreaming: false, streaming: null })
        break

      default:
        break
    }
  }

  clearError(): void {
    this.set({ error: null })
  }
}
