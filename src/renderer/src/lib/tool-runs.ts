import type {
  AssistantMsg,
  TextContent,
  ThinkingContent,
  ToolCallContent
} from '../../../shared/types'
import { splitByToolCategory, type ToolCategoryRun } from './tool-categories'

export type AssistantBlock =
  | { kind: 'thinking'; parts: ThinkingContent[] }
  | { kind: 'text'; parts: TextContent[] }
  | { kind: 'tool'; parts: ToolCallContent[] }

/**
 * Groups a message's content into consecutive same-kind blocks, preserving the
 * model's actual output order. GPT-family models emit phase text BEFORE the tool
 * calls it introduces in the same assistant message; a fixed
 * thinking -> tools -> text order rendered those tools above their own text.
 */
export function groupContent(content: AssistantMsg['content']): AssistantBlock[] {
  const blocks: AssistantBlock[] = []
  for (const part of content) {
    if (part.type === 'thinking') {
      const last = blocks[blocks.length - 1]
      if (last?.kind === 'thinking') last.parts.push(part)
      else blocks.push({ kind: 'thinking', parts: [part] })
    } else if (part.type === 'text') {
      const last = blocks[blocks.length - 1]
      if (last?.kind === 'text') last.parts.push(part)
      else blocks.push({ kind: 'text', parts: [part] })
    } else {
      const last = blocks[blocks.length - 1]
      if (last?.kind === 'tool') last.parts.push(part)
      else blocks.push({ kind: 'tool', parts: [part] })
    }
  }
  return blocks
}

/**
 * Text that paints no row: whitespace of every kind (including the zero-width
 * characters a streamed start-of-round space can arrive as). A round that opens
 * with a bare `" "` part is not empty, so it used to render as an empty
 * markdown block — zero height, but still a flex item, which cost a whole extra
 * gap between the rows around it (two tool rows sat 24px apart instead of 12px)
 * and split a tool run that was visually continuous.
 */
const INVISIBLE_TEXT = /[\s\u200b-\u200d\ufeff]/g

export function textRendersRow(text: string): boolean {
  return text.replace(INVISIBLE_TEXT, '').length > 0
}

/** Mirrors AssistantParts: a text block that paints nothing renders no row. */
export function textBlockRenders(block: { parts: TextContent[] }): boolean {
  return textRendersRow(block.parts.map((part) => part.text).join('\n\n'))
}

/** Rows one tool block renders after category folding. */
export type ToolBlockRows = ToolCategoryRun<ToolCallContent>[]

/**
 * Cross-message tool-run plan. Each model round arrives as its own assistant
 * message, so visually adjacent tool rows (round N ends on tools, round N+1
 * opens with tools) can live in different messages — `groupContent` only sees
 * one message, so the fold is planned here over the turn's flattened block
 * sequence.
 *
 * Keyed by `<messageIndex>:<blockIndex>`. A tool block maps to the rows it
 * renders (merged with any adjacent tool blocks), or to `null` when it is a
 * continuation of a run already rendered by an earlier block.
 */
export type ToolPlan = Map<string, ToolBlockRows | null>

export function toolPlanKey(messageIndex: number, blockIndex: number): string {
  return `${messageIndex}:${blockIndex}`
}

interface ToolBlockRef {
  messageIndex: number
  blockIndex: number
  calls: ToolCallContent[]
}

/**
 * Flattens every message's blocks in order, then folds each maximal run of
 * adjacent tool blocks — adjacency means consecutive in that flattened
 * sequence, so thinking/text between two tool blocks still breaks the run —
 * into one list of same-category rows. The run's first block renders those
 * rows; the rest render nothing.
 *
 * `showReasoning` mirrors the transcript preference: when reasoning blocks are
 * hidden they paint no row, so they must not separate two tool runs either.
 * `toolGrouping` mirrors the grouping preference: when off, no run is merged —
 * every block maps to one singleton row per call (still through the plan, so
 * `AssistantParts` and the fold's step count keep a single source of truth).
 */
export function buildToolPlan(
  messages: AssistantMsg[],
  offset: number,
  showReasoning = true,
  toolGrouping = true,
  breakBefore?: ReadonlySet<number>,
  promoted: ReadonlySet<string> = new Set()
): ToolPlan {
  const plan: ToolPlan = new Map()
  const flat: (ToolBlockRef | null)[] = []
  messages.forEach((message, messageOffset) => {
    const messageIndex = offset + messageOffset
    if (breakBefore?.has(messageIndex)) flat.push(null)
    groupContent(message.content).forEach((block, blockIndex) => {
      if (block.kind === 'tool') {
        const calls = block.parts.filter(call => !promoted.has(call.id))
        const barrier = calls.length !== block.parts.length
        if (barrier) flat.push(null)
        if (calls.length) flat.push({ messageIndex, blockIndex, calls })
        else plan.set(toolPlanKey(messageIndex, blockIndex), [])
        if (barrier) flat.push(null)
      } else if (block.kind === 'thinking') {
        // Hidden reasoning paints nothing, so it cannot separate a run.
        if (showReasoning) flat.push(null)
      } else if (textBlockRenders(block)) {
        // Only a block that paints a row separates two tool blocks. A block
        // with no text at all — or only whitespace — renders nothing, so the
        // tool rows around it stay visually adjacent and must merge as soon as
        // the next call appears, not once the round settles.
        flat.push(null)
      }
    })
  })

  let cursor = 0

  // Grouping off: each call is its own row, so there is nothing to merge and
  // no continuation blocks. Emit the plan and return.
  if (!toolGrouping) {
    for (const entry of flat) {
      if (!entry) continue
      plan.set(
        toolPlanKey(entry.messageIndex, entry.blockIndex),
        entry.calls.map((call) => ({ items: [call] }))
      )
    }
    return plan
  }

  while (cursor < flat.length) {
    if (!flat[cursor]) {
      cursor++
      continue
    }
    const run: ToolBlockRef[] = []
    while (cursor < flat.length && flat[cursor]) {
      run.push(flat[cursor] as ToolBlockRef)
      cursor++
    }
    const rows = splitByToolCategory(run.flatMap((entry) => entry.calls))
    const [first, ...rest] = run
    plan.set(toolPlanKey(first.messageIndex, first.blockIndex), rows)
    for (const entry of rest) {
      plan.set(toolPlanKey(entry.messageIndex, entry.blockIndex), null)
    }
  }
  return plan
}

/** How many transcript rows a tool block's plan renders (a group counts once). */
export function planRowCount(rows: ToolBlockRows): number {
  let count = 0
  for (const run of rows) count += run.category && run.items.length > 1 ? 1 : run.items.length
  return count
}

/** Value comparison so a recomputed plan does not break AssistantParts' memo. */
function samePlanRows(
  prev: ToolBlockRows | null | undefined,
  next: ToolBlockRows | null | undefined
): boolean {
  if (prev === next) return true
  if (!prev || !next || prev.length !== next.length) return false
  for (let index = 0; index < prev.length; index++) {
    if (prev[index].category !== next[index].category) return false
    if (prev[index].items.length !== next[index].items.length) return false
    for (let item = 0; item < prev[index].items.length; item++) {
      if (prev[index].items[item] !== next[index].items[item]) return false
    }
  }
  return true
}

/** Compares only the plan entries this message's tool blocks read. */
export function sameToolPlan(
  plan: ToolPlan,
  other: ToolPlan,
  message: AssistantMsg,
  messageIndex: number
): boolean {
  let blockIndex = 0
  for (const block of groupContent(message.content)) {
    if (block.kind === 'tool') {
      const key = toolPlanKey(messageIndex, blockIndex)
      if (!samePlanRows(plan.get(key), other.get(key))) return false
    }
    blockIndex++
  }
  return true
}
