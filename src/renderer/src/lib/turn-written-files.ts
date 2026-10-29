import type { AssistantMsg, ChatMessage, CustomMsg, SubagentRunDTO, ToolCallContent, ToolResultMsg } from '../../../shared/types'
import { countDiffChanges, synthesizeWritePatch } from './diff'
import { relativize, resolveFromCwd } from './tool-path'
import { extractUserDisplay } from './user-message'
import { buildTurns, collectChangeScopes } from './chat-turns'
import { previewKindOf } from '../../../shared/preview'

/**
 * The files one assistant turn wrote — the data behind the transcript's
 * "changed N files" list.
 *
 * Direct edit/write results and persisted child-run text writes share this
 * projection. Generated images stay in their result cards and Library.
 */
const WRITE_TOOL_NAMES = new Set(['edit', 'write'])

export interface WrittenFile {
  /**
   * Absolute path resolved against the session cwd (so two calls that spell the
   * same file differently still merge), when a cwd was available; otherwise the
   * raw path the tool reported.
   */
  filePath: string
  /** Path to render: relative to the session cwd when it lies inside it. */
  displayPath: string
  /** Lines added, summed over the turn's calls that reported a patch. */
  added?: number
  /** Lines removed, summed over the turn's calls that reported a patch. */
  removed?: number
  /**
   * The turn's unified patches for this file, concatenated in call order, ready
   * for `parseUnifiedDiff`. Undefined only when no call yielded one: an `edit`
   * reports it in `details.patch`, and a `write` — which returns no details at
   * all — has one synthesized from the content it wrote (see
   * `synthesizeWritePatch`), so a created file has both stats and a preview.
   */
  patch?: string
}

/** A tool result's parsed patch, independent of where the call pointed. */
interface ParsedPatch {
  patch: string
  added: number
  removed: number
}

/**
 * One tool result's parsed patch, cached on the message object.
 *
 * Tool results are immutable and belong to exactly one session entry, so the
 * message is an exact cache key that needs no invalidation — and a WeakMap
 * releases it with the transcript. Without this, every appended message (which
 * re-renders every turn group) would re-count the whole session's patches.
 */
const PATCH_CACHE = new WeakMap<ToolResultMsg, ParsedPatch | null>()

/**
 * The patch a file-writing result reported, or null when it reported none.
 *
 * `details.patch` is the real unified patch; `details.diff` is the SDK's
 * display-oriented string with line numbers baked into every line, which
 * `parseUnifiedDiff` cannot read back. Only the patch is accepted — never the
 * display string as a fallback — so a tool that reports only the latter lists
 * its file without a diff instead of with a corrupted one.
 *
 * A `write` result carries no details at all, so its patch is synthesized from
 * the call's own `content` argument. Keying the cache on the result is still
 * exact: one result belongs to exactly one call, and a call's arguments are
 * fixed once its result exists.
 */
function patchOfResult(result: ToolResultMsg, call: ToolCallContent, rawPath: string): ParsedPatch | null {
  const cached = PATCH_CACHE.get(result)
  if (cached !== undefined) return cached

  const reported = (result.details as { patch?: unknown } | undefined)?.patch
  let patch: string | null =
    typeof reported === 'string' && reported.length > 0 ? reported : null
  if (!patch && call.name === 'write') {
    const content = call.arguments?.content
    if (typeof content === 'string') patch = synthesizeWritePatch(rawPath, content)
  }
  const parsed = patch ? { patch, ...countDiffChanges(patch) } : null
  PATCH_CACHE.set(result, parsed)
  return parsed
}

/** Merges one call's change into the map, preserving first-seen path order. */
function mergeChange(
  byPath: Map<string, WrittenFile>,
  rawPath: string,
  change: ParsedPatch | null,
  cwd: string | null | undefined
): void {
  const filePath = resolveFromCwd(rawPath, cwd)
  const existing = byPath.get(filePath)
  if (!existing) {
    byPath.set(filePath, {
      filePath,
      displayPath: relativize(filePath, cwd),
      added: change?.added,
      removed: change?.removed,
      patch: change?.patch
    })
    return
  }
  // A call that yielded no patch (an empty `write`) contributes its path only:
  // it must not turn a known 0 into "unknown", nor the other way round.
  if (!change) return
  existing.added = (existing.added ?? 0) + change.added
  existing.removed = (existing.removed ?? 0) + change.removed
  existing.patch = existing.patch ? `${existing.patch}\n${change.patch}` : change.patch
}

/**
 * Collects the distinct files one turn wrote, in first-seen order.
 *
 * A call counts only when its result carries committed text writes. Reply text is
 * never a source: mentioning a path is not evidence that a file was touched.
 * Several calls on the same file merge: their stats sum and their patches
 * concatenate. A `write` reports no patch of its own, so one is synthesized
 * from its content — the file lists with stats and a preview like any edit.
 */
export function extractTurnWrittenFiles(
  assistants: readonly AssistantMsg[],
  toolResults: ReadonlyMap<string, ToolResultMsg>,
  cwd?: string | null,
  /** Background subagent completions delivered into this turn as custom
   * messages; each carries the run's finished record (writtenFiles) — the
   * same payload the foreground result details carry. */
  completions?: readonly CustomMsg[]
): WrittenFile[] {
  const byPath = new Map<string, WrittenFile>()
  // Current payloads describe one run. Legacy payloads describe the whole
  // child: keep only their latest cumulative record. Both delivery paths use
  // the same map so a tool result and a completion cannot count twice.
  const runs = new Map<string, { run: Partial<SubagentRunDTO>; timestamp: number }>()
  const collectRun = (details: unknown, timestamp: number, fallback: string): void => {
    const run = (details as { subagent?: Partial<SubagentRunDTO> } | undefined)?.subagent
    if (!Array.isArray(run?.writtenFiles)) return
    const key = run.writtenFilesScope === 'run' ? `run:${run.runId ?? fallback}` : `child:${run.sessionId ?? fallback}`
    const previous = runs.get(key)
    if (!previous || timestamp >= previous.timestamp) runs.set(key, { run, timestamp })
  }
  for (const message of completions ?? []) {
    if (message.customType !== 'subagent_completion') continue
    collectRun(message.details, message.timestamp, `notice:${message.timestamp}`)
  }
  for (const message of assistants) {
    for (const part of message.content) {
      if (part.type !== 'toolCall') continue
      const result = toolResults.get(part.id)
      if (!result) continue
      // A subagent's own writes ride its `agent` tool result: the runtime
      // extracts them from the child session's successful edit/write calls
      // (bounded patch budget), so the parent turn's changed-files list folds
      // them in like direct calls. Foreground results and the final roster
      // entry carry the same payload.
      if (part.name === 'agent') {
        collectRun(result.details, result.timestamp, part.id)
        continue
      }
      if (result.isError) continue
      if (!WRITE_TOOL_NAMES.has(part.name)) continue
      const rawPath = part.arguments?.path
      if (typeof rawPath !== 'string' || rawPath.length === 0) continue
      const change = patchOfResult(result, part, rawPath)
      mergeChange(byPath, rawPath, change, cwd)
    }
  }
  for (const { run } of runs.values()) {
    for (const file of run.writtenFiles ?? []) {
      if (typeof file?.filePath !== 'string' || !file.filePath) continue
      // Keep image receipts in the persisted run for Rewind, outside code diffs.
      // Older receipts have no kind; image paths without any text-change
      // evidence are the legacy equivalent. Actual SVG edits retain their diff.
      if (file.kind === 'generated-image' || (!file.patch && file.added === undefined && file.removed === undefined && previewKindOf(file.filePath) === 'image')) continue
      mergeChange(byPath, file.filePath,
        typeof file.patch === 'string' && file.patch.length > 0
          ? { patch: file.patch, added: file.added ?? countDiffChanges(file.patch).added, removed: file.removed ?? countDiffChanges(file.patch).removed }
          : null, cwd)
    }
  }
  return [...byPath.values()]
}

/** Totals for the list header; null when nothing reported stats (writes only). */
export function sumWrittenFileStats(
  files: readonly WrittenFile[]
): { added: number; removed: number } | null {
  let added = 0
  let removed = 0
  for (const file of files) {
    added += file.added ?? 0
    removed += file.removed ?? 0
  }
  return added || removed ? { added, removed } : null
}

/**
 * One turn of the review tab: every file the turn changed, plus what identifies
 * it in the transcript so the tab can open on the turn the user came from.
 */
export interface ReviewTurn {
  /**
   * The cumulative scope's first assistant timestamp, shared with the
   * transcript's Review action even if user steers created more display groups.
   */
  id: number
  /** The user message that opened the turn, as the switcher's label. */
  prompt: string | null
  /** When the turn's last round landed — newest turn wins the initial selection. */
  timestamp: number
  files: WrittenFile[]
}

/** First line of a prompt, cut on a word boundary — the switcher's label. */
function promptLabel(text: string, limit = 60): string | null {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (!normalized) return null
  if (normalized.length <= limit) return normalized
  const cut = normalized.slice(0, limit)
  const boundary = cut.lastIndexOf(' ')
  return `${cut.slice(0, boundary > limit * 0.6 ? boundary : limit).trim()}…`
}

/**
 * Every turn of a session that changed files, oldest first — the review tab's
 * model. Use the transcript's cumulative scopes, which can span user-steer
 * folds and idle task continuations. A scope with no changed file is omitted.
 */
export function extractReviewTurns(
  messages: readonly ChatMessage[],
  cwd?: string | null,
  /**
   * Entry id of a synthetic prompt the transcript hides — the plan-approval
   * opening. Its turn still lists the files it changed, but the switcher's
   * label falls back to the turn number instead of echoing protocol text the
   * user never wrote.
   */
  suppressedPromptEntryId?: string | null
): ReviewTurn[] {
  const suppressPrompt = typeof suppressedPromptEntryId === 'string' && suppressedPromptEntryId.length > 0
  const toolResults = new Map<string, ToolResultMsg>()
  for (const message of messages) {
    if (message.role === 'toolResult') toolResults.set(message.toolCallId, message)
  }

  const turns: ReviewTurn[] = []
  for (const scope of collectChangeScopes(buildTurns([...messages])).values()) {
    const rounds = scope.assistants
    const files = extractTurnWrittenFiles(rounds, toolResults, cwd, scope.completions)
    if (files.length > 0) {
      const prompt = scope.prompt && !(suppressPrompt && scope.prompt.sessionEntryId === suppressedPromptEntryId)
        ? scope.prompt
        : null
      turns.push({
        id: scope.reviewId,
        prompt: prompt ? promptLabel(extractUserDisplay(prompt.content).text) : null,
        timestamp: rounds[rounds.length - 1].timestamp,
        files
      })
    }
  }
  return turns
}
