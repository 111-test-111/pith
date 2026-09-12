import type { SideChatEvent, SideChatHistoryEntry } from '../../../shared/types'

export type SideChatStatus = 'streaming' | 'done' | 'error' | 'aborted'

/** One side question and the answer it drew. */
export interface SideChatExchange {
  id: string
  question: string
  /** Answer text so far — final once `status` is no longer `streaming`. */
  answer: string
  status: SideChatStatus
  /** Provider/SDK error text when the answer failed. */
  error: string | null
  timestamp: number
}

export interface SideChatState {
  exchanges: SideChatExchange[]
  /** The exchange currently streaming, if any. */
  activeId: string | null
}

type Listener = () => void

/**
 * The side chat's exchanges, owned entirely by the renderer.
 *
 * Main holds no side-chat state (each question is a stateless no-tools
 * completion), so closing the tab discards everything: there is no session, no
 * file and nothing to clean up — hence "closing the tab destroys it" costs
 * nothing to implement.
 *
 * Streaming deltas churn this store up to ~20×/s. Only the pane subscribes, so
 * an answering side question never re-renders the workspace or the transcript.
 */
export class SideChatStore {
  private state: SideChatState = { exchanges: [], activeId: null }
  private listeners = new Set<Listener>()
  private seq = 0
  private unsubscribe: () => void
  /**
   * The session every answer draws on, captured when the side-chat tab opens:
   * switching the workspace to another session afterwards cannot silently
   * repoint an existing thread at a different conversation. Rebinding is an
   * explicit action (see the pane's rebind button), which starts a fresh store.
   */
  readonly boundSessionPath: string | null

  constructor(boundSessionPath: string | null) {
    this.boundSessionPath = boundSessionPath
    this.unsubscribe = window.pi.onSideChatEvent((event) => this.dispatch(event))
  }

  getState = (): SideChatState => this.state

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private set(patch: Partial<SideChatState>): void {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener()
  }

  private patch(id: string, patch: Partial<SideChatExchange>): void {
    const exchanges = this.state.exchanges.map((exchange) =>
      exchange.id === id ? { ...exchange, ...patch } : exchange
    )
    this.set({ exchanges })
  }

  /** Settle an exchange and stop treating it as the running one. */
  private finish(id: string, patch: Partial<SideChatExchange>): void {
    if (!this.state.exchanges.some((exchange) => exchange.id === id)) return
    this.patch(id, patch)
    if (this.state.activeId === id) this.set({ activeId: null })
  }

  /** Ask a side question. Ignored while another answer is still streaming. */
  ask(question: string): void {
    const text = question.trim()
    if (!text || this.state.activeId) return
    const id = `btw-${Date.now().toString(36)}-${++this.seq}`
    // Only settled exchanges replay into the next prompt: a failed or stopped
    // answer has no answer text worth quoting back to the model.
    const history: SideChatHistoryEntry[] = this.state.exchanges
      .filter((exchange) => exchange.status === 'done')
      .map((exchange) => ({ question: exchange.question, answer: exchange.answer }))
    this.set({
      exchanges: [
        ...this.state.exchanges,
        {
          id,
          question: text,
          answer: '',
          status: 'streaming',
          error: null,
          timestamp: Date.now()
        }
      ],
      activeId: id
    })
    void window.pi
      .sideChatAsk({ exchangeId: id, sessionPath: this.boundSessionPath, question: text, history })
      .catch((error) => {
        this.finish(id, {
          status: 'error',
          error: error instanceof Error ? error.message : String(error)
        })
      })
  }

  /** Stop the running answer; the text already streamed stays on screen. */
  abort(): void {
    const id = this.state.activeId
    if (!id) return
    void window.pi.sideChatAbort(id)
    // Settle locally too, so the composer unlocks without waiting for the
    // stream's own end event.
    this.finish(id, { status: 'aborted' })
  }

  /** Destroy the side chat: stop its answer and stop listening for events. */
  dispose(): void {
    this.abort()
    this.unsubscribe()
  }

  dispatch(event: SideChatEvent): void {
    switch (event.type) {
      case 'delta':
        this.patch(event.exchangeId, {
          answer: `${
            this.state.exchanges.find((exchange) => exchange.id === event.exchangeId)?.answer ?? ''
          }${event.text}`
        })
        break
      case 'done':
        this.finish(event.exchangeId, { status: 'done' })
        break
      case 'error':
        this.finish(event.exchangeId, { status: 'error', error: event.message })
        break
      case 'aborted':
        this.finish(event.exchangeId, { status: 'aborted' })
        break
    }
  }
}
