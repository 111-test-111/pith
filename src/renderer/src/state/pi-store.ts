import type {
  AssistantMsg,
  ChatMessage,
  ContextUsageDTO,
  ModelRefDTO,
  PiEvent,
  SessionSnapshotDTO,
  ThinkingLevel,
  ToolResultMsg,
  UserMsg
} from '../../../shared/types'

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

export interface PiState {
  ready: boolean
  cwd: string | null
  sessionId: string | null
  /** Path of the open session file — the sidebar's active item id. */
  sessionPath: string | null
  model: ModelRefDTO | null
  thinkingLevel: ThinkingLevel
  isStreaming: boolean
  /** SDK context usage for the composer ring; moves only on turn boundaries. */
  contextUsage: ContextUsageDTO | null
  messages: ChatMessage[]
  /** Last routed event incorporated into this view. */
  eventSequence: number
  /** Partial assistant message while the agent is streaming a response. */
  streaming: AssistantMsg | null
  toolRuns: Record<string, ToolRun>
  queue: { steering: string[]; followUp: string[] }
  notice: Notice | null
  error: string | null
}

/**
 * Workspace-chrome slice of PiState: fields the sidebar, header and composer
 * read. Its object identity only changes when one of these fields changes, so
 * `useSyncExternalStore(subscribe, getShell)` subscribers don't re-render while
 * streaming deltas churn `streaming`/`toolRuns`/`messages` in the full state.
 */
export interface PiShellState {
  ready: boolean
  cwd: string | null
  sessionPath: string | null
  model: ModelRefDTO | null
  thinkingLevel: ThinkingLevel
  /** Levels the current model supports; cycles through these only. */
  availableThinkingLevels: ThinkingLevel[]
  isStreaming: boolean
  contextUsage: ContextUsageDTO | null
  /** Pending steering/follow-up messages (SDK queue state) for the composer. */
  queue: { steering: string[]; followUp: string[] }
}

/** Fallback while no session/model is known (SDK returns all levels then). */
const ALL_THINKING_LEVELS: ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

const initialState: PiState = {
  ready: false,
  cwd: null,
  sessionId: null,
  sessionPath: null,
  model: null,
  thinkingLevel: 'medium',
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
    ready: state.ready,
    cwd: state.cwd,
    sessionPath: state.sessionPath,
    model: state.model,
    thinkingLevel: state.thinkingLevel,
    availableThinkingLevels,
    isStreaming: state.isStreaming,
    contextUsage: state.contextUsage,
    queue: state.queue
  }
}

type Listener = () => void

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
      prev.cwd !== this.state.cwd ||
      prev.sessionPath !== this.state.sessionPath ||
      prev.model !== this.state.model ||
      prev.thinkingLevel !== this.state.thinkingLevel ||
      prev.isStreaming !== this.state.isStreaming ||
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
    const cached = sessionPath ? this.sessionStates.get(sessionPath) : undefined
    const snapshotSequence = snapshot.eventSequence ?? 0
    this.setAvailableThinkingLevels(snapshot.availableThinkingLevels)
    // An unchanged visited session keeps its message/tool object identities so
    // switching back does not remount Markdown and tool trees after the instant
    // cached paint.
    const unchanged = cached?.eventSequence === snapshotSequence
    this.set({
      ...(unchanged ? cached : {}),
      ready: true,
      cwd: snapshot.cwd,
      sessionId: snapshot.sessionId,
      sessionPath,
      model: snapshot.model,
      thinkingLevel: snapshot.thinkingLevel,
      isStreaming: snapshot.isStreaming,
      contextUsage: unchanged ? cached.contextUsage : (snapshot.contextUsage ?? null),
      eventSequence: snapshotSequence,
      messages: unchanged ? cached.messages : snapshot.messages,
      streaming: unchanged ? cached.streaming : (snapshot.streaming ?? null),
      toolRuns: unchanged ? cached.toolRuns : (snapshot.toolRuns ?? {}),
      queue: unchanged ? cached.queue : (snapshot.queue ?? { steering: [], followUp: [] }),
      notice: unchanged ? cached.notice : null,
      error: unchanged ? cached.error : null
    })
    if (!sessionPath) return
    const pending = this.pendingEvents.get(sessionPath) ?? []
    this.pendingEvents.delete(sessionPath)
    for (const event of pending) {
      if ((event.eventSequence ?? 0) > snapshotSequence) this.dispatch(event)
    }
  }

  /** Local queue clear after a successful recall — the SDK's (empty)
   * queue_update confirms it, but the IPC result is already authoritative. */
  clearQueue(): void {
    this.set({ queue: { steering: [], followUp: [] } })
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
      if ((event.eventSequence ?? 0) > this.state.eventSequence) this.dispatch(event)
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

    switch (event.type) {
      case 'agent_start':
        this.set({ isStreaming: true, notice: null, error: null })
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
        // Main attaches SDK context usage to these events; stage it before the
        // role branches below so their set() calls publish it in one notification.
        if ('contextUsage' in event) {
          this.state = { ...this.state, contextUsage: event.contextUsage ?? null }
        }
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
            this.set({ messages: [...this.state.messages, incoming] })
          }
        } else if (message.role === 'assistant') {
          const incoming = message as AssistantMsg
          const messages = [...this.state.messages]
          const index = messages.findIndex(
            (m) => m.role === 'assistant' && m.timestamp === incoming.timestamp
          )
          if (index >= 0) messages[index] = incoming
          else messages.push(incoming)
          this.set({
            messages,
            streaming:
              this.state.streaming?.timestamp === incoming.timestamp ? null : this.state.streaming
          })
        } else if (message.role === 'toolResult') {
          const incoming = message as ToolResultMsg
          const toolRuns = { ...this.state.toolRuns }
          const run = toolRuns[incoming.toolCallId]
          if (run) {
            run.status = incoming.isError ? 'error' : 'success'
            run.endedAt = Date.now()
          }
          this.set({
            messages: [...this.state.messages, incoming],
            toolRuns
          })
        } else if (message.role === 'custom' && !(message as any).display) {
          // Hidden extension messages stay in the transcript data only.
          break
        } else {
          // Non-LLM transcript entries (bash execution, custom/extension or
          // summary messages) belong in the visible history too.
          const last = this.state.messages[this.state.messages.length - 1]
          if (!last || last.timestamp !== message.timestamp) {
            this.set({ messages: [...this.state.messages, message] })
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

      case 'agent_end':
        // Post-run continuations (auto-retry, compaction, queued messages) keep
        // the run alive after agent_end — only `agent_settled` means idle.
        // The partial is already cleared by its message_end.
        break

      case 'agent_settled':
        this.set({ isStreaming: false, streaming: null })
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

      case 'compaction_end': {
        // Main ships the rewritten (compaction-aware) message list with the
        // event; adopting it keeps the transcript in step with the SDK context.
        const messages = Array.isArray(event.messages) ? (event.messages as ChatMessage[]) : null
        this.set({
          ...(messages ? { messages, streaming: null } : {}),
          notice: event.errorMessage
            ? { key: 'compactFailed', detail: event.errorMessage }
            : null,
          ...('contextUsage' in event ? { contextUsage: event.contextUsage ?? null } : {})
        })
        break
      }

      case 'pi_error':
        this.set({ error: event.message, isStreaming: false, streaming: null })
        break

      default:
        break
    }
  }

  clearError(): void {
    this.set({ error: null })
  }
}
