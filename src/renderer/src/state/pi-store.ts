import type {
  AssistantMsg,
  ChatMessage,
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

export interface PiState {
  ready: boolean
  cwd: string | null
  sessionId: string | null
  /** Path of the open session file — the sidebar's active item id. */
  sessionPath: string | null
  model: ModelRefDTO | null
  thinkingLevel: ThinkingLevel
  isStreaming: boolean
  messages: ChatMessage[]
  /** Partial assistant message while the agent is streaming a response. */
  streaming: AssistantMsg | null
  toolRuns: Record<string, ToolRun>
  queue: { steering: string[]; followUp: string[] }
  notice: string | null
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
  isStreaming: boolean
}

const initialState: PiState = {
  ready: false,
  cwd: null,
  sessionId: null,
  sessionPath: null,
  model: null,
  thinkingLevel: 'medium',
  isStreaming: false,
  messages: [],
  streaming: null,
  toolRuns: {},
  queue: { steering: [], followUp: [] },
  notice: null,
  error: null
}

function shellOf(state: PiState): PiShellState {
  return {
    ready: state.ready,
    cwd: state.cwd,
    sessionPath: state.sessionPath,
    model: state.model,
    thinkingLevel: state.thinkingLevel,
    isStreaming: state.isStreaming
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
  private shellState: PiShellState = shellOf(initialState)
  private listeners = new Set<Listener>()

  getState = (): PiState => this.state

  getShell = (): PiShellState => this.shellState

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private set(patch: Partial<PiState>): void {
    const prev = this.state
    this.state = { ...prev, ...patch }
    if (
      prev.ready !== this.state.ready ||
      prev.cwd !== this.state.cwd ||
      prev.sessionPath !== this.state.sessionPath ||
      prev.model !== this.state.model ||
      prev.thinkingLevel !== this.state.thinkingLevel ||
      prev.isStreaming !== this.state.isStreaming
    ) {
      this.shellState = shellOf(this.state)
    }
    for (const listener of this.listeners) listener()
  }

  applySnapshot(snapshot: SessionSnapshotDTO): void {
    this.set({
      ready: true,
      cwd: snapshot.cwd,
      sessionId: snapshot.sessionId,
      sessionPath: snapshot.sessionPath ?? null,
      model: snapshot.model,
      thinkingLevel: snapshot.thinkingLevel,
      isStreaming: snapshot.isStreaming,
      messages: snapshot.messages,
      streaming: null,
      toolRuns: {},
      queue: { steering: [], followUp: [] },
      error: null
    })
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
        }
        break
      }

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
        this.set({ isStreaming: false, streaming: null })
        break

      case 'queue_update':
        this.set({
          queue: { steering: [...event.steering], followUp: [...event.followUp] }
        })
        break

      case 'auto_retry_start':
        this.set({
          notice: `Request failed — retrying (attempt ${event.attempt} of ${event.maxAttempts})`
        })
        break

      case 'auto_retry_end':
        this.set({ notice: event.success ? null : (event.finalError ?? 'Request failed') })
        break

      case 'compaction_start':
        this.set({ notice: 'Compacting conversation context…' })
        break

      case 'compaction_end':
        this.set({ notice: event.errorMessage ?? null })
        break

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
