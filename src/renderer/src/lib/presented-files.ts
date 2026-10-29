import type { AssistantMsg, PresentedFile, ToolResultMsg } from '../../../shared/types'
import { parsePresentResult } from '../../../shared/present'

/** Only a successful, matching call/result declares delivery. Prose, write
 * intents and child completions cannot implicitly become deliverables. */
export function presentedFiles(messages: readonly AssistantMsg[], results: ReadonlyMap<string, ToolResultMsg>): PresentedFile[] {
  const files = new Map<string, PresentedFile>()
  for (const message of messages) for (const call of message.content) {
    if (call.type !== 'toolCall' || call.name !== 'present') continue
    const result = results.get(call.id)
    if (!result || result.isError || result.toolName !== 'present') continue
    for (const file of parsePresentResult(result.details)?.files ?? []) files.set(file.path, file)
  }
  return [...files.values()]
}
