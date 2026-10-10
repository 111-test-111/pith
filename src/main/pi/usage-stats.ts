import type {
  UsageDayPointDTO,
  UsageModelSeriesDTO,
  UsageStatsDTO,
  UsageTurnRecordDTO
} from '../../shared/types'
import { IMAGE_TOOL_NAME, parseImageToolResult } from '../../shared/image'

/**
 * Cross-session token/cost usage aggregation, grouped by local day × model.
 * Pure parsing/aggregation — the usage worker feeds it raw .jsonl file text,
 * so this stays testable without touching the filesystem. Ported from
 * pi-web's lib/usage-stats.ts, with the per-request records regrouped into
 * per-turn records (a turn = one user prompt and everything the model ran
 * until the next user prompt or the end of the file).
 *
 * Semantics notes:
 * - Every SDK usage report counts (assistant/tool messages, summaries and
 *   standalone usage entries), including entries on abandoned branches.
 *   Each one was a real paid request. This intentionally
 *   differs from the transcript view, which walks only the selected branch.
 * - The day bucket uses the entry timestamp (request end) in the machine's
 *   local timezone — the app runs on the user's machine, so local == user.
 * - Sessions here come from the shared `~/.pi/agent/sessions` tree, so files
 *   written by the pi CLI, pi-web and pi-app all aggregate consistently; the
 *   pi-web-specific entry kinds below stay readable for exactly that reason.
 * - Turn boundaries follow file order: the SDK appends entries as they
 *   happen, so a turn's requests sit between its user message and the next
 *   one in the file.
 */

export interface UsageAccumulator {
  buckets: Map<string, {
    provider: string
    model: string
    days: Record<string, UsageDayPointDTO>
    totalTokens: number
    totalCost: number
    totalRequests: number
  }>
  records: UsageTurnRecordDTO[]
  firstDay: string | null
  lastDay: string | null
  generatedAt: number
}

/** Per-file turn accumulator (turns never span session files). */
interface TurnAccumulator {
  startTs: number | null
  endTs: number
  models: Map<string, { provider: string; model: string; tokens: number }>
  tokens: number
  cost: number
  requests: number
}

export function createUsageAccumulator(now = Date.now()): UsageAccumulator {
  return { buckets: new Map(), records: [], firstDay: null, lastDay: null, generatedAt: now }
}

/** Local (machine timezone) YYYY-MM-DD for an epoch-ms timestamp. */
export function localDayKey(ts: number): string {
  const d = new Date(ts)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function entryTimestamp(entry: Record<string, unknown>, message: Record<string, unknown>): number {
  const entryTs = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN
  const innerTs = num(message.timestamp)
  return Number.isFinite(entryTs) ? entryTs : innerTs
}

/** usage.cost arrives either as a plain number or as { input, output, ..., total }. */
function costOf(usage: Record<string, unknown>): number {
  const cost = usage.cost
  if (typeof cost === 'number') return Number.isFinite(cost) ? cost : 0
  if (cost && typeof cost === 'object') return num((cost as Record<string, unknown>).total)
  return 0
}

function tokensOf(usage: Record<string, unknown>): number {
  const total = num(usage.totalTokens)
  if (total > 0) return total
  return num(usage.input) + num(usage.output) + num(usage.cacheRead) + num(usage.cacheWrite)
}

/** Fold one usage report into the provider/model bucket and the open turn. */
function recordUsage(
  acc: UsageAccumulator,
  turn: TurnAccumulator,
  ts: number,
  provider: string,
  model: string,
  usage: Record<string, unknown>
): void {
  const day = localDayKey(ts)
  const key = `${provider}/${model}`
  let bucket = acc.buckets.get(key)
  if (!bucket) {
    bucket = { provider, model, days: {}, totalTokens: 0, totalCost: 0, totalRequests: 0 }
    acc.buckets.set(key, bucket)
  }
  let point = bucket.days[day]
  if (!point) {
    point = { tokens: 0, cost: 0, requests: 0 }
    bucket.days[day] = point
  }
  const tokens = tokensOf(usage)
  const cost = costOf(usage)
  point.tokens += tokens
  point.cost += cost
  point.requests += 1
  bucket.totalTokens += tokens
  bucket.totalCost += cost
  bucket.totalRequests += 1

  if (turn.startTs === null) turn.startTs = ts
  turn.endTs = Math.max(turn.endTs, ts)
  turn.tokens += tokens
  turn.cost += cost
  turn.requests += 1
  let turnModel = turn.models.get(key)
  if (!turnModel) {
    turnModel = { provider, model, tokens: 0 }
    turn.models.set(key, turnModel)
  }
  turnModel.tokens += tokens

  if (acc.firstDay === null || day < acc.firstDay) acc.firstDay = day
  if (acc.lastDay === null || day > acc.lastDay) acc.lastDay = day
}

/**
 * Fold one session file's raw text into the accumulator. Lines are scanned in
 * file order; `model_change` entries are tracked so old files whose assistant
 * messages lack inline provider/model still attribute correctly, and every
 * user message closes the open turn and opens the next one.
 */
export function accumulateSessionFile(acc: UsageAccumulator, text: string): void {
  let currentProvider: string | null = null
  let currentModel: string | null = null
  let turn: TurnAccumulator | null = null

  const flushTurn = () => {
    // A turn whose requests all reported zero tokens/cost (e.g. an aborted
    // round) carries nothing worth listing.
    if (turn && turn.requests > 0 && (turn.tokens > 0 || turn.cost > 0)) {
      acc.records.push({
        startTs: turn.startTs ?? turn.endTs,
        endTs: turn.endTs,
        models: [...turn.models.values()].sort((a, b) => b.tokens - a.tokens),
        tokens: turn.tokens,
        cost: turn.cost,
        requests: turn.requests
      })
    }
    turn = null
  }

  for (const line of text.split('\n')) {
    // Cheap string pre-filter before paying for JSON.parse (same trick as the
    // SDK's session lister). User lines are needed too — they close turns.
    if (!line.includes('"usage"') && !line.includes('model_change') && !line.includes('"user"')) continue

    let entry: Record<string, unknown>
    try {
      entry = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue // tolerate a torn last line of a live session file
    }

    if (entry.type === 'model_change') {
      if (typeof entry.provider === 'string') currentProvider = entry.provider
      if (typeof entry.modelId === 'string') currentModel = entry.modelId
      continue
    }
    if (entry.type === 'usage' || entry.type === 'compaction' || entry.type === 'branch_summary') {
      const usage = entry.usage
      const ts = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN
      if (usage && typeof usage === 'object' && Number.isFinite(ts) && ts > 0) {
        // Standalone usage owns its model; summaries use the selected model.
        const provider = typeof entry.provider === 'string' ? entry.provider : entry.type === 'usage' ? 'unknown' : currentProvider ?? 'unknown'
        const model = typeof entry.model === 'string' ? entry.model : entry.type === 'usage' ? 'unknown' : currentModel ?? 'unknown'
        if (!turn) turn = { startTs: null, endTs: 0, models: new Map(), tokens: 0, cost: 0, requests: 0 }
        recordUsage(acc, turn, ts, provider, model, usage as Record<string, unknown>)
      }
      continue
    }
    if (
      entry.type === 'custom' &&
      (entry.customType === 'pi-web:model-space-usage' || entry.customType === 'pi-web:goal-evaluation-usage')
    ) {
      const data = entry.data as Record<string, unknown> | undefined
      const ts = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN
      if (
        data &&
        typeof data.provider === 'string' &&
        typeof data.modelId === 'string' &&
        data.usage &&
        typeof data.usage === 'object' &&
        Number.isFinite(ts)
      ) {
        if (!turn) turn = { startTs: null, endTs: 0, models: new Map(), tokens: 0, cost: 0, requests: 0 }
        recordUsage(acc, turn, ts, data.provider, data.modelId, data.usage as Record<string, unknown>)
      }
      continue
    }
    if (entry.type !== 'message') continue

    const message = entry.message as Record<string, unknown> | undefined
    if (!message) continue

    if (message.role === 'user') {
      const ts = entryTimestamp(entry, message)
      flushTurn()
      turn = {
        startTs: Number.isFinite(ts) && ts > 0 ? ts : null,
        endTs: 0,
        models: new Map(),
        tokens: 0,
        cost: 0,
        requests: 0
      }
      continue
    }

    // SDK 0.99 also aggregates nested/classifier usage onto the outer result.
    // Count that aggregate once, never recurse into nestedCalls. Only legacy
    // vision results identify their model; don't attribute other tool usage
    // to the chat model that requested the tool.
    if (message.role === 'toolResult') {
      const details = message.details as Record<string, unknown> | undefined
      const usage = message.usage as Record<string, unknown> | undefined
      if (usage && typeof usage === 'object') {
        const ts = entryTimestamp(entry, message)
        if (Number.isFinite(ts) && ts > 0) {
          const vision = details?.kind === 'pi-web-vision'
          const image = message.toolName === IMAGE_TOOL_NAME ? parseImageToolResult(details) : null
          const provider = image ? 'openrouter' : vision && typeof details.provider === 'string' ? details.provider : 'unknown'
          const model = image ? image.model : vision && typeof details.modelId === 'string' ? details.modelId : 'unknown'
          if (!turn) turn = { startTs: null, endTs: 0, models: new Map(), tokens: 0, cost: 0, requests: 0 }
          recordUsage(acc, turn, ts, provider, model, usage)
        }
      }
      continue
    }
    if (message.role !== 'assistant') continue
    const usage = message.usage as Record<string, unknown> | undefined
    if (!usage || typeof usage !== 'object') continue

    const ts = entryTimestamp(entry, message)
    if (!Number.isFinite(ts) || ts <= 0) continue

    const provider =
      (typeof message.provider === 'string' && message.provider) || currentProvider || 'unknown'
    const model =
      (typeof message.model === 'string' && message.model) || currentModel || 'unknown'
    if (!turn) turn = { startTs: null, endTs: 0, models: new Map(), tokens: 0, cost: 0, requests: 0 }
    recordUsage(acc, turn, ts, provider, model, usage)
  }

  flushTurn()
}

export function finalizeUsage(acc: UsageAccumulator, maxRecords: number): UsageStatsDTO {
  const models: UsageModelSeriesDTO[] = [...acc.buckets.entries()]
    .map(([key, bucket]) => ({ key, ...bucket }))
    .sort((a, b) => b.totalTokens - a.totalTokens || a.key.localeCompare(b.key))

  let totalTokens = 0
  let totalCost = 0
  let totalRequests = 0
  for (const m of models) {
    totalTokens += m.totalTokens
    totalCost += m.totalCost
    totalRequests += m.totalRequests
  }

  const records = [...acc.records].sort((a, b) => b.endTs - a.endTs)
  const recordsTruncated = records.length > maxRecords
  if (recordsTruncated) records.length = maxRecords

  return {
    generatedAt: acc.generatedAt,
    firstDay: acc.firstDay,
    lastDay: acc.lastDay,
    models,
    totalTokens,
    totalCost,
    totalRequests,
    records,
    recordsTruncated
  }
}
