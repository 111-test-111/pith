import { estimateTokens } from '@earendil-works/pi-coding-agent'
import type {
  ContextBreakdownDTO,
  ContextDetailDTO,
  ContextUsageDTO,
  ThinkingLevel
} from '../../shared/types'

/**
 * The right rail's context tab. Almost all of it is reported by the SDK's
 * `getSessionStats()` (message counts, cumulative input/output/cache tokens,
 * cost) or by the composer ring's own readout; two things it cannot answer are
 * derived here:
 *
 * - **the reasoning split** — `Usage.reasoning` is a documented subset of
 *   `output` that the SDK's totals drop, so it is summed from the session
 *   entries (the summary entries' usage counts too: those are real LLM calls
 *   that the stats fold in as well);
 * - **the context breakdown** — the SDK has no per-category accounting, so each
 *   context message is estimated with the SDK's own `estimateTokens` (the same
 *   heuristic its compaction uses) and grouped by role. The pane labels this as
 *   an estimate everywhere it appears.
 *
 * Everything is a pure function of what the caller read off the session, so the
 * whole surface is checkable without booting Electron
 * (scripts/check-context-detail.mjs).
 */

/** Structural view of the SDK pieces this module reads — no SDK import needed. */
export interface ContextStatsLike {
  userMessages: number
  assistantMessages: number
  toolCalls: number
  toolResults: number
  totalMessages: number
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }
  cost: number
}

export interface ContextDetailInput {
  /** `AgentSession.messages`: the branch's context, compaction-converted and
   * ordered oldest first — what the model actually receives. Only the breakdown
   * estimates it; no message body leaves this module. */
  messages: readonly any[]
  /** `sessionManager.getEntries()`: every entry of the file (all branches), for
   * the reasoning split the stats drop. */
  entries: readonly any[]
  stats: ContextStatsLike
  /** The composer ring's readout; its `tokens` anchors the breakdown total. */
  usage: ContextUsageDTO
  meta: {
    sessionId: string
    sessionPath: string | null
    title: string | null
    cwd: string
    projectless: boolean
    provider: string | null
    model: string | null
    thinkingLevel: ThinkingLevel | null
    createdAt: number | null
    lastActivity: number | null
  }
}

/**
 * `SessionStats` for a session file nobody holds open (the visible session was
 * just switched away from, so its `AgentSession` is gone). Mirrors
 * `AgentSession.getSessionStats()` exactly — same sources, same semantics: every
 * entry of the file counts, standalone usage and compaction/branch-summary usage included, because
 * those were real billed requests. Added usage is taken from `entry.message` for
 * message entries and from the entry itself for summaries.
 */
export function statsFromEntries(entries: readonly any[]): ContextStatsLike {
  let userMessages = 0
  let assistantMessages = 0
  let toolResults = 0
  let toolCalls = 0
  let totalMessages = 0
  let input = 0
  let output = 0
  let cacheRead = 0
  let cacheWrite = 0
  let cost = 0
  const addUsage = (usage: any): void => {
    if (!usage) return
    input += usage.input ?? 0
    output += usage.output ?? 0
    cacheRead += usage.cacheRead ?? 0
    cacheWrite += usage.cacheWrite ?? 0
    cost += usage.cost?.total ?? 0
  }
  for (const entry of entries) {
    if ((entry?.type === 'usage' || entry?.type === 'branch_summary' || entry?.type === 'compaction') && entry.usage) addUsage(entry.usage)
    if (entry?.type !== 'message') continue
    totalMessages++
    const message = entry.message
    if (message?.role === 'user') userMessages++
    else if (message?.role === 'toolResult') {
      toolResults++
      addUsage(message.usage)
    } else if (message?.role === 'assistant') {
      assistantMessages++
      if (Array.isArray(message.content)) {
        toolCalls += message.content.filter((part: any) => part.type === 'toolCall').length
      }
      addUsage(message.usage)
    }
  }
  return {
    userMessages,
    assistantMessages,
    toolCalls,
    toolResults,
    totalMessages,
    tokens: { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite },
    cost
  }
}

/** Which bucket a context message's estimate lands in. Anything the four
 * buckets do not name (summaries, hidden extension state, bash executions) is
 * "other" together with the system prompt and the tool schemas. */
export function bucketOf(role: string | undefined): 'user' | 'assistant' | 'toolResults' | 'other' {
  if (role === 'user') return 'user'
  if (role === 'assistant') return 'assistant'
  if (role === 'toolResult') return 'toolResults'
  return 'other'
}

/**
 * Per-category tokens. `total` is the provider-anchored context size when the
 * ring has one, so the four buckets always sum to the number the ring shows:
 * the residue (`total` − the summed message estimates) IS the system prompt
 * plus the tool schemas plus estimation error, and it is reported as "other"
 * instead of being hidden as a bar that does not add up.
 */
export function buildBreakdown(messages: readonly any[], contextTokens: number | null): ContextBreakdownDTO {
  const buckets = { user: 0, assistant: 0, toolResults: 0, other: 0 }
  for (const message of messages) buckets[bucketOf(message?.role)] += estimateTokens(message)
  const estimate = buckets.user + buckets.assistant + buckets.toolResults + buckets.other
  const total = contextTokens !== null && contextTokens > estimate ? contextTokens : estimate
  return { ...buckets, other: buckets.other + (total - estimate), total }
}

/**
 * Reasoning tokens over the whole session. The SDK reports them per request and
 * drops them from `SessionStats`, so they are summed back from the entries:
 * message entries carry them on the message, `compaction`/`branch_summary` on
 * the entry itself. `null` (not 0) when no provider exposed a split — a real 0
 * and "the provider is silent" must not read the same in the UI.
 */
export function reasoningTokens(entries: readonly any[]): number | null {
  let total = 0
  let reported = false
  for (const entry of entries) {
    const usage =
      entry?.type === 'message' ? entry.message?.usage : entry?.type === 'compaction' || entry?.type === 'branch_summary' || entry?.type === 'usage' ? entry.usage : undefined
    const reasoning = usage?.reasoning
    if (typeof reasoning !== 'number' || !Number.isFinite(reasoning)) continue
    reported = true
    total += reasoning
  }
  return reported ? total : null
}

export function buildContextDetail(input: ContextDetailInput): ContextDetailDTO {
  const { stats, usage, meta } = input
  return {
    sessionId: meta.sessionId,
    sessionPath: meta.sessionPath,
    title: meta.title,
    cwd: meta.cwd,
    projectless: meta.projectless,
    provider: meta.provider,
    model: meta.model,
    thinkingLevel: meta.thinkingLevel,
    createdAt: meta.createdAt,
    lastActivity: meta.lastActivity,
    userMessages: stats.userMessages,
    assistantMessages: stats.assistantMessages,
    toolCalls: stats.toolCalls,
    toolResults: stats.toolResults,
    totalMessages: stats.totalMessages,
    tokens: {
      input: stats.tokens.input,
      output: stats.tokens.output,
      reasoning: reasoningTokens(input.entries),
      cacheRead: stats.tokens.cacheRead,
      cacheWrite: stats.tokens.cacheWrite,
      total: stats.tokens.total
    },
    cost: stats.cost,
    usage,
    breakdown: buildBreakdown(input.messages, usage.tokens)
  }
}
