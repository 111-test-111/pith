import { convertToLlm, estimateTokens } from '@earendil-works/pi-coding-agent'
import type { ContextBreakdownDTO, ContextCategoryDTO, ContextCategoryKind } from '../../shared/types'
import { currentSystemMessage } from './transcript-context'

type Bucket = keyof Omit<ContextBreakdownDTO, 'total'>
type Part = { kind: ContextCategoryKind; chars: number; name?: string }
const ITEM_LIMIT = 24

/** Apportion one SDK estimate without rounding each fragment up independently.
 * Thus categories, named items and the four role buckets all have one total. */
function apportion(total: number, weights: readonly number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0)
  if (!sum) return weights.map(() => 0)
  // Keep whole-token components (notably the SDK's 1200-token image estimate)
  // exact. Only fractional text/schema tokens participate in rounding.
  const exact = weights.map(weight => weight / 4)
  const tokens = exact.map(Math.floor)
  const order = exact.map((value, i) => ({ i, fraction: value - tokens[i] }))
    .sort((a, b) => b.fraction - a.fraction || a.i - b.i)
  const remainder = total - tokens.reduce((a, b) => a + b, 0)
  for (let i = 0; i < remainder; i++) tokens[order[i].i]++
  return tokens
}

function contentParts(content: any, textKind: ContextCategoryKind, name?: string): Part[] {
  if (typeof content === 'string') return [{ kind: textKind, chars: content.length, name }]
  return (content ?? []).flatMap((block: any): Part[] => block.type === 'text'
    ? [{ kind: textKind, chars: block.text.length, name }]
    : block.type === 'image' ? [{ kind: 'images', chars: 4800 }] : [])
}

function sameContent(a: any, b: any): boolean {
  if (typeof a === 'string' || typeof b === 'string') return a === b
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
  return a.every((block, i) => block.type === b[i].type && (block.type === 'text'
    ? block.text === b[i].text : block.type === 'image' && block.data === b[i].data && block.mimeType === b[i].mimeType))
}

/** Attribute only exact converted user messages. Timestamp alone cannot prove
 * an extension/summary origin; duplicate messages are consumed once each.
 * Unmatched request user content is explicitly an addition/edit of unknown
 * origin, rather than guessed to be a particular extension. */
function requestOrigins(projection: readonly any[]): (message: any) => string {
  const candidates = new Map<number, Array<{ message: any; role: string }>>()
  for (const original of projection) {
    if (!['user', 'custom', 'compactionSummary', 'branchSummary', 'bashExecution'].includes(original.role)) continue
    for (const message of convertToLlm([original])) {
      if (message.role !== 'user') continue
      const list = candidates.get(message.timestamp) ?? []
      list.push({ message, role: original.role })
      candidates.set(message.timestamp, list)
    }
  }
  return message => {
    if (message.role !== 'user') return message.role
    const list = candidates.get(message.timestamp)
    const at = list?.findIndex(candidate => sameContent(candidate.message.content, message.content)) ?? -1
    return at < 0 ? 'requestOnly' : list!.splice(at, 1)[0].role
  }
}

/** Statistics only. System state is replayed once; opaque thinking signatures
 * and image base64 are never counted as text. Request attribution compares to
 * the canonical projection, while all sizes come from the observed request. */
export function contextComposition(messages: readonly any[], projection?: readonly any[]): {
  breakdown: ContextBreakdownDTO; categories: ContextCategoryDTO[]
} {
  const breakdown: ContextBreakdownDTO = { user: 0, assistant: 0, toolResults: 0, other: 0, total: 0 }
  const categories = new Map<ContextCategoryKind, { tokens: number; items: Map<string, number> }>()
  const add = (bucket: Bucket, total: number, parts: Part[]): void => {
    breakdown[bucket] += total
    const nonempty = parts.filter(part => part.chars > 0)
    if (!nonempty.length && total) nonempty.push({ kind: 'other', chars: total * 4 })
    const assigned = apportion(total, nonempty.map(part => part.chars))
    nonempty.forEach((part, i) => {
      const category = categories.get(part.kind) ?? { tokens: 0, items: new Map<string, number>() }
      category.tokens += assigned[i]
      if (part.name) {
        const name = part.name.slice(0, 200)
        category.items.set(name, (category.items.get(name) ?? 0) + assigned[i])
      }
      categories.set(part.kind, category)
    })
  }
  const system = currentSystemMessage(messages)
  if (system) {
    const parts = contentParts(system.content, 'system')
    for (const [name, text] of Object.entries(system.sections ?? {})) {
      if (!text) continue
      parts.push({ kind: name === 'project_context' ? 'projectFiles' : name === 'skills' ? 'skills' : 'system',
        chars: text.length, ...(name !== 'project_context' && name !== 'skills' ? { name } : {}) })
    }
    const tools = system.toolsAdded ?? []
    tools.forEach((tool, i) => parts.push({ kind: 'toolSchemas', name: tool.name,
      chars: JSON.stringify(tool).length + (i === 0 ? tools.length + 1 : 0) }))
    add('other', estimateTokens(system), parts)
  }
  const origin = projection ? requestOrigins(projection) : (message: any) => message.role
  for (const message of messages) {
    if (message?.role === 'system') continue
    if (message?.role === 'bashExecution' && message.excludeFromContext) continue
    const role = origin(message)
    const total = estimateTokens(message)
    if (role === 'assistant') {
      const parts: Part[] = message.content.flatMap((block: any): Part[] => block.type === 'text'
        ? [{ kind: 'assistantText', chars: block.text.length }]
        : block.type === 'thinking' ? [{ kind: 'thinking', chars: block.thinking.length }]
          : block.type === 'toolCall' ? [{ kind: 'toolCalls', chars: block.name.length + JSON.stringify(block.arguments).length }] : [])
      add('assistant', total, parts)
    } else if (role === 'compactionSummary' || role === 'branchSummary') {
      add('other', total, message.role === 'user' ? contentParts(message.content, 'summaries')
        : [{ kind: 'summaries', chars: message.summary.length }])
    } else if (role === 'custom' || role === 'requestOnly') {
      add('other', total, contentParts(message.content, role === 'custom' ? 'extensions' : 'requestOnly'))
    } else if (role === 'bashExecution') {
      add('other', total, message.role === 'user' ? contentParts(message.content, 'bash')
        : [{ kind: 'bash', chars: message.command.length + message.output.length }])
    } else if (role === 'toolResult') {
      add('toolResults', total, contentParts(message.content, 'toolResults', message.toolName))
    } else if (role === 'user') add('user', total, contentParts(message.content, 'userText'))
    else add('other', total, [{ kind: 'other', chars: total * 4 }])
  }
  breakdown.total = breakdown.user + breakdown.assistant + breakdown.toolResults + breakdown.other
  return { breakdown, categories: [...categories].filter(([, category]) => category.tokens > 0).map(([kind, category]) => {
    const items = [...category.items].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    return { kind, tokens: category.tokens, items: items.slice(0, ITEM_LIMIT).map(([name, tokens]) => ({ name, tokens })),
      omittedItems: Math.max(0, items.length - ITEM_LIMIT) }
  }) }
}
