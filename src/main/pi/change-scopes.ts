import { randomUUID } from 'node:crypto'
import type { AgentSession, AgentSessionEvent, SessionManager } from '@earendil-works/pi-coding-agent'
import type { ChatMessage, UserMsg } from '../../shared/types'
import { SUBAGENT_MESSAGE_TYPE } from './subagents/protocol'

const ENTRY_TYPE = 'pith_change_scope'
type QueueDelivery = NonNullable<UserMsg['queuedDelivery']>

/** UI bookkeeping lives in hidden session entries, never in model context.
 * A steer shares the current scope. A follow-up opens its own scope even
 * when the SDK delivers it in the same run. Idle task wakes can reopen a
 * scope. Branch/reload reconstructs this from the selected branch. */
export class ChangeScopes {
  private scopes = new Map<number, string>()
  private deliveries = new Map<string, QueueDelivery>()
  private readonly queued = new WeakMap<object, QueueDelivery>()
  private previous: string | null = null
  private continuing = false
  private subagentOpening: object | null = null
  active: string | null = null

  constructor(private manager: SessionManager) { this.restore() }
  get current(): string | null { return this.active ?? this.previous }

  restore(): void {
    this.scopes.clear()
    this.deliveries.clear()
    let scope: string | null = null
    let marked = false
    let previous: string | null = null
    let precedingScope: string | null = null
    let lastUserId: string | null = null
    let afterToolRound = false
    const legacyAliases = new Map<string, string>()
    for (const entry of this.manager.getBranch()) {
      if (entry.type === 'custom' && entry.customType === ENTRY_TYPE) {
        const data = entry.data as { id?: unknown; phase?: unknown; delivery?: unknown; userEntryId?: unknown }
        if (typeof data?.id === 'string') {
          const delivery = data.delivery === 'steer' || data.delivery === 'followUp' ? data.delivery : null
          if (delivery) {
            if (!lastUserId || data.userEntryId !== lastUserId) continue
            this.deliveries.set(lastUserId, delivery)
          }
          if (delivery !== 'steer') afterToolRound = false
          const alias = legacyAliases.get(data.id)
          const id = alias ?? data.id
          scope = data.phase === 'end' ? null : id
          precedingScope = scope && !delivery && !alias && scope !== previous ? previous : null
          previous = id
          marked = scope !== null
        }
      }
      // Older builds allocated a new ID for a child-message wake. The first
      // non-system message identifies that wake, even if the old ID was reused
      // by a later completion. Reconstruct its ownership from the branch.
      if (entry.type === 'custom_message') {
        if (precedingScope && scope && entry.customType === SUBAGENT_MESSAGE_TYPE && entry.display) {
          legacyAliases.set(scope, precedingScope)
          scope = previous = precedingScope
        }
        precedingScope = null
      }
      if (entry.type === 'branch_summary') afterToolRound = false
      if (entry.type !== 'message' || entry.message.role === 'system') continue
      precedingScope = null
      if (entry.message.role === 'assistant') {
        // Legacy history still has a stable identity when a task resumes it.
        scope ??= `legacy:${entry.message.timestamp}`
        this.scopes.set(entry.message.timestamp, scope)
        previous = scope
        afterToolRound = entry.message.stopReason === 'toolUse'
      }
      if (entry.message.role === 'user') {
        lastUserId = entry.id
        // Older Pith sessions only recorded the SDK run. Tool-work boundaries
        // can identify steering there; a reply followed by another prompt is
        // ambiguous without the queue delivery marker.
        if (marked && afterToolRound) this.deliveries.set(entry.id, 'steer')
        if (!marked) scope = null
      } else if (entry.message.role !== 'toolResult') lastUserId = null
    }
    this.previous = previous
  }

  continue(): void { this.continuing = !this.active }

  /** Capture delivery by message identity and recognize idle subagent wakes
   * inside the run admission wrappers. */
  bindAgent(agent: AgentSession['agent']): void {
    // The SDK's text mirror cannot distinguish identical prompts in the two
    // queues. The queue delivers the original message object to its listeners.
    const steer = agent.steer.bind(agent)
    agent.steer = message => {
      if (message.role === 'user') this.queued.set(message, 'steer')
      steer(message)
    }
    const followUp = agent.followUp.bind(agent)
    agent.followUp = message => {
      if (message.role === 'user') this.queued.set(message, 'followUp')
      followUp(message)
    }

    const prompt = agent.prompt
    agent.prompt = async (...args) => {
      const input = args[0]
      const opening = Array.isArray(input) ? input.find(message => message.role !== 'system') : input
      if (typeof opening !== 'object' || opening?.role !== 'custom' || opening.customType !== SUBAGENT_MESSAGE_TYPE ||
        !opening.display || agent.state.isStreaming) return Reflect.apply(prompt, agent, args)

      this.subagentOpening = opening
      try { return await Reflect.apply(prompt, agent, args) }
      finally { if (this.subagentOpening === opening) this.subagentOpening = null }
    }
  }

  observe(event: AgentSessionEvent, userEntryId?: string): void {
    if (event.type === 'agent_start' && !this.active) {
      this.restore() // Retry/rewind may have selected another session branch.
      this.active = (this.continuing || this.subagentOpening) && this.previous ? this.previous : randomUUID()
      this.continuing = false
      this.manager.appendCustomEntry(ENTRY_TYPE, { id: this.active })
    }
    if (event.type === 'message_end' && event.message.role === 'user' && userEntryId && this.active) {
      const delivery = this.queued.get(event.message)
      if (delivery) {
        const id = delivery === 'followUp' ? randomUUID() : this.active
        this.manager.appendCustomEntry(ENTRY_TYPE, { id, delivery, userEntryId })
        this.deliveries.set(userEntryId, delivery)
        this.active = id
      }
    }
    if ('message' in event && event.message.role === 'assistant' && this.active) {
      this.scopes.set(event.message.timestamp, this.active)
    }
    if (event.type === 'agent_settled') {
      if (this.active) this.manager.appendCustomEntry(ENTRY_TYPE, { id: this.active, phase: 'end' })
      this.previous = this.active ?? this.previous
      this.active = null
    }
  }

  stamp<T extends ChatMessage>(message: T, userEntryId?: string): T {
    if (message.role === 'user' && userEntryId) {
      return { ...message, sessionEntryId: userEntryId, queuedDelivery: this.deliveries.get(userEntryId) }
    }
    if (message.role === 'assistant') {
      return { ...message, changeScopeId: this.scopes.get(message.timestamp) ?? this.active ?? undefined }
    }
    return message
  }
}
