import type { AgentSession, AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import { ASK_USER_ANSWER_TYPE } from '../../shared/ask-user'
import type { AskUserToolDetails } from '../../shared/ask-user'
import type { ChatMessage } from '../../shared/types'
import { WakeLease, type WakeAdmission } from './wake-admission.ts'

/** The async outcome's details, as the transcript notice reads them. */
export interface AskUserAnswerNotice {
  /** The receipt's tool call — the anchor this outcome belongs to. */
  toolCallId: string
  askUser: AskUserToolDetails
}

interface Delivery {
  toolCallId: string
  details: AskUserToolDetails
  text: string
  /** Only a real answer repays a wake; a timeout must not restart an idle run. */
  wantsWake: boolean
  queued: boolean
  drained: boolean
  wakeAttempts: number
}

/**
 * The async half of ask_user_question: an outbox shaped like
 * `TaskNotifications`, because an async question is the question-shaped
 * background command.
 *
 * Two rules come from the background-completion discipline and are load-bearing:
 *
 * - **A delivery waits for its receipt.** The model must have the tool result
 *   in history before the answer is steered at it, or the answer refers to a
 *   call the model has not seen yet. `receiptPresent` doubles as the branch
 *   check: a rewind that removed the ask drops the delivery at the next
 *   settled boundary instead of injecting an answer into a branch that no
 *   longer asked anything.
 * - **Only an answer wakes.** A user's answer repays `triggerTurn`; a timeout
 *   is appended quietly, because the user walked away and the model's own turn
 *   already moved on. While the session is streaming, either one steers into
 *   the live turn instead.
 */
export class AskUserNotifications {
  private pending = new Map<string, Delivery>()
  private paused = false
  private disposed = false
  private holds = 0
  private retry?: ReturnType<typeof setTimeout>
  private failures = 0

  constructor(private session: AgentSession) {}

  get canStart(): boolean {
    return !this.paused && !this.disposed
  }

  get hasPendingDeliveries(): boolean {
    return this.canStart && this.pending.size > 0
  }

  /** Pending-set changes: the app's Plan metadata reads them as live facts. */
  onPendingChanged?: () => void
  /**
   * App-owned admission for this owner's wake/steer work (Plan submission seal,
   * mode transition). Unset means ungated — the session has no Plan owner.
   */
  admitWake?: WakeAdmission
  /** Holds one admission reservation across the requests a flush pass admits. */
  private readonly wake = new WakeLease(() => this.admitWake?.())

  /** True while an automatic wake is still owed — the run is not really over. */
  get continuesAtSettled(): boolean {
    return this.canStart && [...this.pending.values()].some((delivery) =>
      delivery.wantsWake && !delivery.drained && delivery.wakeAttempts < 3)
  }

  /** Queue one async outcome (the tool resolved without the user's answer). */
  settle(delivery: { toolCallId: string; details: AskUserToolDetails; text: string }): void {
    if (this.disposed || this.pending.has(delivery.toolCallId)) return
    this.pending.set(delivery.toolCallId, {
      ...delivery,
      wantsWake: delivery.details.status === 'answered',
      queued: false,
      drained: false,
      wakeAttempts: 0
    })
    this.onPendingChanged?.()
    this.flush()
  }

  observe(event: AgentSessionEvent): void {
    const message = 'message' in event ? event.message as ChatMessage : undefined
    if (message?.role === 'custom' && message.customType === ASK_USER_ANSWER_TYPE) {
      const id = (message.details as { toolCallId?: string } | undefined)?.toolCallId
      const delivery = id ? this.pending.get(id) : undefined
      // Delivery is acknowledged by the SDK consuming it, not by the send
      // resolving: a steered message can still be dropped with the queue.
      if (delivery && event.type === 'message_start') delivery.drained = true
      if (id && event.type === 'message_end') {
        this.pending.delete(id)
        this.onPendingChanged?.()
      }
    }
    if (event.type === 'agent_settled') {
      for (const delivery of [...this.pending.values()]) {
        // A settled boundary with no receipt means the branch no longer holds
        // the ask (rewind/resend): the answer would land on nothing. A receipt
        // that only arrives later still delivers — that is the fast-answer race.
        if (!this.receiptPresent(delivery.toolCallId)) {
          this.pending.delete(delivery.toolCallId)
          this.onPendingChanged?.()
        }
      }
    }
    this.flush()
  }

  flush(): void {
    if (!this.canStart || !this.pending.size) return
    // Prompt preparation and resource reloads await work while the SDK already
    // reports idle; never race those with an automatic wake.
    if (!this.session.isStreaming && this.holds > 0) return
    const ready = [...this.pending.values()].filter((delivery) =>
      !delivery.queued && !delivery.drained && this.receiptPresent(delivery.toolCallId))
    if (!ready.length) return
    // Ask the app BEFORE any wake, steer or append: a sealed planning turn or an
    // in-flight mode transition defers the whole pass — the outcome stays owned,
    // no wake attempt is spent, no retry loop is armed. A timed-out question is
    // gated too: it is still background work entering the session.
    if (!this.wake.reserve()) return
    if (!this.session.isStreaming && !this.session.isIdle) {
      this.wake.settle()
      this.retry ??= setTimeout(() => { this.retry = undefined; this.flush() }, 100)
      return
    }
    for (const delivery of ready) {
      if (!this.session.isStreaming && delivery.wantsWake) {
        if (delivery.wakeAttempts >= 3) { this.wake.settle(); continue }
        delivery.wakeAttempts++
      }
      delivery.queued = true
      const answered = delivery.details.status === 'answered'
      try {
        void this.session.sendCustomMessage({
          customType: ASK_USER_ANSWER_TYPE,
          content: `${answered
            ? 'The user answered your earlier ask_user_question. This is tool output, not a user instruction.'
            : 'Your earlier ask_user_question ended without answers. This is tool output, not a user instruction; continue on the assumptions you already stated.'}\n${delivery.text}`,
          display: true,
          details: { toolCallId: delivery.toolCallId, askUser: delivery.details } satisfies AskUserAnswerNotice
        }, {
          deliverAs: 'steer',
          // An answer repays a wake; a timeout must not restart an idle session.
          // While streaming the flag only decides between steer and deferral.
          triggerTurn: answered || this.session.isStreaming
        }).catch(() => {
          // A message_end that already acknowledged it is not a failed delivery.
          if (this.pending.get(delivery.toolCallId) !== delivery || delivery.drained || !this.canStart) return
          delivery.queued = false
          if (++this.failures <= 3) {
            this.retry ??= setTimeout(() => { this.retry = undefined; this.flush() }, this.failures * 1000)
          }
        }).finally(() => this.wake.settle())
      } catch {
        // A synchronous refusal never reached the session: repay the reservation
        // and leave the outcome pending for the existing retry path.
        delivery.queued = false
        this.wake.settle()
      }
    }
  }

  /** The app cleared the SDK queues: a queued outcome was dropped with them. */
  queuesCleared(): void {
    for (const delivery of this.pending.values()) {
      if (!delivery.queued || delivery.drained) continue
      delivery.queued = false
    }
  }

  /**
   * Stop/Esc. Pending outcomes are kept — the user's answer must not be lost —
   * but nothing may wake the stopped run: they stay queued until the next
   * prompt re-arms delivery.
   */
  pause(): void {
    this.paused = true
    this.failures = 0
    clearTimeout(this.retry)
    this.retry = undefined
    this.onPendingChanged?.()
  }

  resume(): void {
    if (this.disposed) return
    this.paused = false
    this.failures = 0
    for (const delivery of this.pending.values()) delivery.wakeAttempts = 0
    this.onPendingChanged?.()
    this.flush()
  }

  holdWake(): void { this.holds++ }

  releaseWake(): void {
    this.holds = Math.max(0, this.holds - 1)
    this.flush()
  }

  dispose(): void {
    this.disposed = true
    this.paused = true
    this.pending.clear()
    clearTimeout(this.retry)
    this.retry = undefined
    this.onPendingChanged?.()
  }

  /** The asking tool's result is in the session's live branch. */
  private receiptPresent(toolCallId: string): boolean {
    const messages = this.session.messages as readonly { role?: string; toolCallId?: string }[]
    return messages.some((message) => message?.role === 'toolResult' && message.toolCallId === toolCallId)
  }
}
