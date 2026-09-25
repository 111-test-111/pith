import type { AssistantMsg, ChatMessage } from './types'

/** Only the unfinished frontier can resume; a later user turn supersedes it.
 * An idle tool-use tail also covers a crash/Stop between model rounds. */
export function continuationTarget(messages: readonly ChatMessage[]): AssistantMsg | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message.role === 'user') return null
    if (message.role !== 'assistant') continue
    return ['aborted', 'error', 'length', 'toolUse'].includes(message.stopReason) || message.errorMessage
      ? message : null
  }
  return null
}
