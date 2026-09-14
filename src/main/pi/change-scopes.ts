import { randomUUID } from 'node:crypto'
import type { AgentSessionEvent, SessionManager } from '@earendil-works/pi-coding-agent'
import type { ChatMessage } from '../../shared/types'

const ENTRY_TYPE = 'pith_change_scope'

/** UI bookkeeping lives in hidden session entries, never in model context.
 * A user steer changes the display group but stays in the active scope. An
 * idle task continuation reopens the preceding scope; a fresh prompt starts
 * another. Branch/reload reconstructs ownership from the selected branch. */
export class ChangeScopes {
  private scopes = new Map<number, string>()
  private previous: string | null = null
  private continuing = false
  active: string | null = null

  constructor(private manager: SessionManager) { this.restore() }
  get current(): string | null { return this.active ?? this.previous }

  restore(): void {
    this.scopes.clear()
    let scope: string | null = null
    let marked = false
    let previous: string | null = null
    for (const entry of this.manager.getBranch()) {
      if (entry.type === 'custom' && entry.customType === ENTRY_TYPE) {
        const data = entry.data as { id?: unknown; phase?: unknown }
        if (typeof data?.id === 'string') {
          previous = data.id
          scope = data.phase === 'end' ? null : data.id
          marked = scope !== null
        }
      }
      if (entry.type === 'message' && entry.message.role === 'assistant') {
        // Legacy history still has a stable identity when a task resumes it.
        scope ??= `legacy:${entry.message.timestamp}`
        this.scopes.set(entry.message.timestamp, scope)
        previous = scope
      }
      // Unmarked historical user exchanges must not all merge together.
      if (entry.type === 'message' && entry.message.role === 'user' && !marked) scope = null
    }
    this.previous = previous
  }

  continue(): void { this.continuing = !this.active }

  observe(event: AgentSessionEvent): void {
    if (event.type === 'agent_start' && !this.active) {
      this.restore() // Retry/rewind may have selected another session branch.
      this.active = this.continuing && this.previous ? this.previous : randomUUID()
      this.continuing = false
      this.manager.appendCustomEntry(ENTRY_TYPE, { id: this.active })
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

  stamp<T extends ChatMessage>(message: T): T {
    if (message.role !== 'assistant') return message
    return { ...message, changeScopeId: this.scopes.get(message.timestamp) ?? this.active ?? undefined }
  }
}
