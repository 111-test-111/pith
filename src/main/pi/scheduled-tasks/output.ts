import type { ChatMessage } from '../../../shared/types'
import type { ScheduledTaskRun } from '../../../shared/scheduled-tasks'

/** Read the final assistant text from this run's time window. A scheduled
 * task may continue an existing conversation, so the session's latest reply
 * can belong to a later user turn or a later scheduled run. */
export function scheduledRunOutputFromMessages(run: ScheduledTaskRun, messages: readonly ChatMessage[]): string | null {
  const start = Date.parse(run.startedAt ?? run.createdAt)
  const end = run.finishedAt ? Date.parse(run.finishedAt) : Infinity
  if (Number.isFinite(start)) {
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index]
      if (message.role !== 'assistant') continue
      const at = message.completedAt ?? message.timestamp
      if (at < start || at > end) continue
      const text = message.content
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('\n\n')
        .trim()
      if (text) return text
    }
  }
  // Legacy records and deleted/unreadable sessions still retain the excerpt.
  return run.summary ?? null
}
