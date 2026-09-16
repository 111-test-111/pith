import { estimateTokens } from '@earendil-works/pi-coding-agent'

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
 * The fallback is the estimate the SDK itself uses for a compaction's
 * `estimatedTokensAfter`: the summed per-message estimate of the compacted
 * list, computed with the SDK's own `estimateTokens`. Only a session that
 * actually carries a summary takes it — a fresh session's blank ring is honest,
 * because this estimate covers neither the system prompt nor the tool schemas.
 */
export function compactedContextTokens(messages: readonly any[]): number | null {
  if (!messages.some((message) => message?.role === 'compactionSummary')) return null
  let tokens = 0
  for (const message of messages) tokens += estimateTokens(message)
  return tokens
}
