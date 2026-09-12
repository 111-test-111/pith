import type {
  AssistantMsg,
  BashExecutionMsg,
  BranchSummaryMsg,
  ChatMessage,
  CompactionSummaryMsg,
  CustomMsg,
  UserMsg
} from '../../../shared/types'

interface ChatTurnBase {
  key: string
}

/**
 * A user message and the assistant rounds it triggered fold into one turn; the
 * SDK's non-LLM transcript entries (summaries, bash executions, extension
 * messages) each stand alone so nothing silently disappears from the history.
 *
 * Shared by the workspace transcript and the side-chat pane — both render the
 * same message log, so both fold it the same way.
 */
export type ChatTurn =
  | (ChatTurnBase & { role: 'user'; user: UserMsg; assistants: [] })
  | (ChatTurnBase & { role: 'assistant'; assistants: AssistantMsg[]; live?: boolean })
  | (ChatTurnBase & { role: 'info'; message: CompactionSummaryMsg | BranchSummaryMsg })
  | (ChatTurnBase & { role: 'bash'; message: BashExecutionMsg })
  | (ChatTurnBase & { role: 'custom'; message: CustomMsg })

/**
 * Folds the message log into turns: a user message opens a turn, every
 * following assistant round (tool rounds, then the final text) joins the same
 * turn so it renders as ONE message row. toolResult entries are skipped —
 * they are rendered through the toolResults map on the calling round.
 */
export function buildTurns(messages: ChatMessage[]): ChatTurn[] {
  const turns: ChatTurn[] = []
  for (const message of messages) {
    const last = turns[turns.length - 1]
    switch (message.role) {
      case 'user':
        turns.push({
          key: `u${message.timestamp}-${turns.length}`,
          role: 'user',
          user: message,
          assistants: []
        })
        break
      case 'assistant':
        if (last?.role === 'assistant') last.assistants.push(message)
        else
          turns.push({
            key: `a${message.timestamp}-${turns.length}`,
            role: 'assistant',
            assistants: [message]
          })
        break
      case 'toolResult':
        break
      case 'compactionSummary':
      case 'branchSummary':
        turns.push({ key: `s${message.timestamp}-${turns.length}`, role: 'info', message })
        break
      case 'bashExecution':
        turns.push({ key: `b${message.timestamp}-${turns.length}`, role: 'bash', message })
        break
      case 'custom':
        if (message.display)
          turns.push({ key: `c${message.timestamp}-${turns.length}`, role: 'custom', message })
        break
    }
  }
  return turns
}
