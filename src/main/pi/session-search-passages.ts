import type { SessionSearchSource } from '../../shared/types'
import { searchSnippet } from './session-search-text'

export interface SearchPassage {
  text: string
  source: SessionSearchSource
  toolName?: string
}

const MESSAGE_SOURCES: Partial<Record<string, SessionSearchSource>> = { user: 'user', assistant: 'assistant', custom: 'custom', toolResult: 'tool' }
const string = (value: unknown): string => typeof value === 'string' ? value : ''
export const isConversationPassage = (passage: SearchPassage): boolean =>
  passage.source !== 'tool' && passage.source !== 'thinking' && passage.source !== 'attachment'

/** Match the renderer's user-message file-block extraction. File contents
 * appear as attachment chips, not as words the user typed into the chat. */
function textPassages(text: string, source: SessionSearchSource, toolName?: string): SearchPassage[] {
  if (source !== 'user') return [{ text, source, toolName }]
  const passages: SearchPassage[] = []
  let offset = 0
  for (const match of text.matchAll(/<file path="([^"]+)">([\s\S]*?)<\/file>/g)) {
    if (match.index > offset) passages.push({ text: text.slice(offset, match.index), source })
    passages.push({ text: `${match[1]}\n${match[2]}`, source: 'attachment' })
    offset = match.index + match[0].length
  }
  if (offset < text.length) passages.push({ text: text.slice(offset), source })
  return passages
}

function argumentText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value == null) return ''
  if (Array.isArray(value)) return value.map(argumentText).join('\n')
  if (typeof value === 'object') return Object.entries(value).map(([key, item]) => `${key}\n${argumentText(item)}`).join('\n')
  return String(value)
}

/** Preserve block provenance. Reading another session/sidebar through a tool
 * must not turn that session's title into this conversation's own prose. */
export function contentPassages(content: unknown, source: SessionSearchSource, toolName?: string): SearchPassage[] {
  if (typeof content === 'string') return textPassages(content, source, toolName)
  if (!Array.isArray(content)) return []
  return content.flatMap((part): SearchPassage[] => {
    if (part?.type === 'text' && typeof part.text === 'string') return textPassages(part.text, source, toolName)
    if (part?.type === 'thinking' && !part.redacted && typeof part.thinking === 'string') {
      return [{ text: part.thinking, source: 'thinking' }]
    }
    if (part?.type === 'toolCall') {
      return [{ text: `${string(part.name)}\n${argumentText(part.arguments)}`, source: 'tool', toolName: string(part.name) || undefined }]
    }
    return []
  })
}

export function messagePassages(message: any): SearchPassage[] {
  if (!message || (message.role === 'custom' && message.display === false)) return []
  if (message.role === 'custom' && message.customType === 'bash_task_completion') {
    return contentPassages(message.content, 'tool', 'bash')
  }
  if (message.role === 'bashExecution') return [{
    text: `${string(message.command)}\n${string(message.output)}`, source: 'tool', toolName: 'bash'
  }]
  if (message.role === 'compactionSummary' || message.role === 'branchSummary') return [{ text: string(message.summary), source: 'summary' }]
  const source = MESSAGE_SOURCES[message.role]
  if (!source) return []
  return [
    ...contentPassages(message.content, source, string(message.toolName) || undefined),
    ...(message.role === 'assistant' && typeof message.errorMessage === 'string'
      ? [{ text: message.errorMessage, source: 'assistant' as const }] : [])
  ]
}

/** Prefer the user's/assistant's words even if an earlier tool block matches.
 * A phrase must fit in a single block, just as in candidate verification. */
export function passageSnippet(passages: SearchPassage[], terms: string[], includeDetails: boolean) {
  const conversation = passages.filter(isConversationPassage)
  const eligible = includeDetails ? [...conversation, ...passages.filter((p) => !isConversationPassage(p))] : conversation
  for (const passage of eligible) {
    const snippet = searchSnippet(passage.text, terms)
    if (snippet) return { snippet, snippetSource: passage.source, snippetToolName: passage.toolName }
  }
  return { snippet: null }
}
