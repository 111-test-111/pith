import { estimateTokens } from '@earendil-works/pi-coding-agent'
import { currentSystemMessage } from './transcript-context'

/** Canonical projection estimate, matching the SDK's system-state fold. */
export function estimateContextTokens(messages: readonly any[]): number {
  const system = currentSystemMessage(messages)
  return (system ? estimateTokens(system) : 0) + messages.reduce((tokens, message) =>
    tokens + (message?.role === 'system' ? 0 : estimateTokens(message)), 0)
}

/**
 * What the context holds after a compaction, for as long as the SDK cannot say.
 *
 * `AgentSession.getContextUsage()` deliberately reports NO token count once a
 * compaction boundary exists: the only provider usage it can see belongs to an
 * assistant that responded before that boundary, and that number describes the
 * context that was just summarized away. It stays unknown until the next
 * response — which left the composer ring blank for that whole gap (percent and
 * tokens both stranded at `—`), exactly when the user wants to watch the number
 * drop.
 *
 * Fold system patches once, then estimate the remaining projection messages.
 * This includes checkpoint prompts/schemas without counting superseded state.
 * Only a session carrying a compaction summary takes this fallback.
 */
export function compactedContextTokens(messages: readonly any[]): number | null {
  if (!messages.some((message) => message?.role === 'compactionSummary')) return null
  return estimateContextTokens(messages)
}
