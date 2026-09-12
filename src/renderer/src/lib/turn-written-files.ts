import type { AssistantMsg, ChatMessage, ToolCallContent, ToolResultMsg } from '../../../shared/types'
import { countDiffChanges, synthesizeWritePatch } from './diff'
import { relativize, resolveFromCwd } from './tool-path'
import { extractUserDisplay } from './user-message'

/**
 * The files one assistant turn wrote — the data behind the transcript's
 * "changed N files" list.
 *
 * Ported from pi-web's `extractTurnWrittenFiles`, deliberately narrowed to what
 * pi-app has today: tool names are matched exactly (`edit` / `write`, no
 * MCP-decorated spellings) and subagent fan-out is not folded in (the app has no
 * subagent system). Widening it later means extending `WRITE_TOOL_NAMES` here,
 * nothing else.
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
 * A call counts only when its result arrived and did not fail — a call still
 * running on a live turn, or one that errored, wrote nothing. Reply text is
 * never a source: mentioning a path is not evidence that a file was touched.
 * Several calls on the same file merge: their stats sum and their patches
 * concatenate. A `write` reports no patch of its own, so one is synthesized
 * from its content — the file lists with stats and a preview like any edit.
 */
export function extractTurnWrittenFiles(
  assistants: readonly AssistantMsg[],
  toolResults: ReadonlyMap<string, ToolResultMsg>,
  cwd?: string | null
): WrittenFile[] {
  const byPath = new Map<string, WrittenFile>()
  for (const message of assistants) {
    for (const part of message.content) {
      if (part.type !== 'toolCall' || !WRITE_TOOL_NAMES.has(part.name)) continue
      const result = toolResults.get(part.id)
      if (!result || result.isError) continue
      const rawPath = part.arguments?.path
      if (typeof rawPath !== 'string' || rawPath.length === 0) continue
      const change = patchOfResult(result, part, rawPath)
      mergeChange(byPath, rawPath, change, cwd)
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
   * The turn's first assistant message timestamp — the same identity the
   * transcript's AssistantGroup passes to its "Review" action, so a click there
   * selects the very same turn here. (`buildTurns` keys a turn by its first
   * assistant message, so the two derivations agree by construction.)
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
 * model. Turns are folded exactly the way the transcript folds them (the
 * assistant rounds between two user messages are one turn, and `toolResult`
 * entries sit inside it rather than breaking it), and a turn with no changed
 * file is left out so the switcher only walks reviews that have something to
 * show.
 */
export function extractReviewTurns(
  messages: readonly ChatMessage[],
  cwd?: string | null
): ReviewTurn[] {
  const toolResults = new Map<string, ToolResultMsg>()
  for (const message of messages) {
    if (message.role === 'toolResult') toolResults.set(message.toolCallId, message)
  }

  const turns: ReviewTurn[] = []
  let rounds: AssistantMsg[] = []
  let prompt: string | null = null
  const closeTurn = () => {
    if (rounds.length === 0) return
    const files = extractTurnWrittenFiles(rounds, toolResults, cwd)
    if (files.length > 0) {
      turns.push({
        id: rounds[0].timestamp,
        prompt,
        timestamp: rounds[rounds.length - 1].timestamp,
        files
      })
    }
    rounds = []
  }

  for (const message of messages) {
    if (message.role === 'toolResult') continue
    if (message.role === 'assistant') {
      rounds.push(message)
      continue
    }
    closeTurn()
    prompt = message.role === 'user' ? promptLabel(extractUserDisplay(message.content).text) : null
  }
  closeTurn()
  return turns
}
