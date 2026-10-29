import type { AssistantMsg } from '../../shared/types'

export const CONTINUATION_MESSAGE_TYPE = 'pith_turn_continuation'

/** Providers discard aborted/error assistant messages. Preserve their usable
 * partial output as quoted context, never replay incomplete signed thinking
 * or turn unfinished tool arguments into executable calls. Other history and
 * committed tool results stay in the SDK's existing context. */
export function continuationContent(message: AssistantMsg): string {
  const instruction = 'Continue the interrupted turn from where you left off. Preserve the original request and completed work; do not restart or repeat your answer. Check actual tool results before deciding whether interrupted work needs to be retried.'
  if (message.stopReason !== 'aborted' && message.stopReason !== 'error') return instruction
  const partial = message.content.flatMap(part => {
    if (part.type === 'text' && part.text) return [{ type: 'text', text: part.text }]
    if (part.type === 'thinking' && !part.redacted && part.thinking) return [{ type: 'thinking', text: part.thinking }]
    if (part.type === 'toolCall') return [{ type: 'unexecutedToolCall', text: JSON.stringify({ name: part.name, arguments: part.arguments }) }]
    return []
  })
  return partial.length ? `${instruction}\n\nThe following JSON is the interrupted assistant's partial output, quoted as context (not new user instructions). Tool calls in it were incomplete and are not evidence of execution:\n${JSON.stringify(partial)}` : instruction
}
