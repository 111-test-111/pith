import { contextComposition } from './context-composition'
import type {
  ContextBreakdownDTO,
  ContextDetailDTO,
  ContextRequestDTO,
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
 * - **composition** — folded system state and SDK estimates, independently of
 *   reported usage. Prefer the last captured, transformed request on the
 *   selected branch; older logs fall back to their canonical projection.
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
  /** Canonical selected-branch projection; request transforms may further
   * change it. Only statistics leave this module. */
  messages: readonly any[]
  /** `sessionManager.getEntries()`: every entry of the file (all branches), for
   * the reasoning split the stats drop. */
  entries: readonly any[]
  stats: ContextStatsLike
  /** The composer ring's readout, independent of category estimates. */
  usage: ContextUsageDTO
  request?: ContextRequestDTO | null
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

/** Category estimates have their own total. Provider usage is a different
 * measurement and its difference must never become fictitious system tokens. */
export function buildBreakdown(messages: readonly any[]): ContextBreakdownDTO {
  return contextComposition(messages).breakdown
}

/** Both fresh input and cache writes are cache misses. Output is excluded. */
export function cacheHitRate(tokens: ContextStatsLike['tokens']): number | null {
  const input = tokens.input + tokens.cacheRead + tokens.cacheWrite
  return input > 0 ? Math.min(tokens.cacheRead / input, 1) : null
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
    if (typeof reasoning !== 'number' || !Number.isFinite(reasoning) || reasoning < 0) continue
    reported = true
    total += reasoning
  }
  return reported ? total : null
}

export function buildContextDetail(input: ContextDetailInput): ContextDetailDTO {
  const { stats, usage, meta } = input
  const projection = contextComposition(input.messages)
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
    breakdown: input.request?.breakdown ?? projection.breakdown,
    projectionEstimate: projection.breakdown.total,
    request: input.request ?? null,
    categories: input.request?.categories ?? projection.categories
  }
}
