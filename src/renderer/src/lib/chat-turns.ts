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
  | (ChatTurnBase & { role: 'assistant'; assistants: AssistantMsg[]; notices?: TurnNotice[]; live?: boolean })
  | (ChatTurnBase & { role: 'info'; message: CompactionSummaryMsg | BranchSummaryMsg })
  | (ChatTurnBase & { role: 'bash'; message: BashExecutionMsg })
  | (ChatTurnBase & { role: 'custom'; message: CustomMsg })

export interface TurnNotice { beforeRound: number; message: CustomMsg }

/**
 * Folds the message log into turns: a user message opens a turn, every
 * following assistant round (tool rounds, then the final text) joins the same
 * turn so it renders as ONE message row. toolResult entries are skipped —
 * they are rendered through the toolResults map on the calling round.
 */
export function buildTurns(messages: ChatMessage[]): ChatTurn[] {
  const turns: ChatTurn[] = []
  const summaries: ChatTurn[] = []
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
        if (last?.role === 'assistant' && (!message.changeScopeId || !last.assistants[0]?.changeScopeId ||
          last.assistants[0].changeScopeId === message.changeScopeId)) last.assistants.push(message)
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
        // Placed after the loop so both full branch transcripts and older
        // compaction-aware snapshots use the entry timestamp as the authority.
        summaries.push({ key: `s${message.timestamp}-${summaries.length}`, role: 'info', message })
        break
      case 'bashExecution':
        turns.push({ key: `b${message.timestamp}-${turns.length}`, role: 'bash', message })
        break
      case 'custom':
        // Completion deliveries are tool data, not conversation turns: they
        // attach to the running turn as notices (the same treatment a
        // background bash completion gets) instead of opening a new card.
        if (message.display && (message.customType === 'bash_task_completion' || message.customType === 'subagent_completion' || message.customType === 'subagent_message' || message.customType === 'ask_user_answer')) {
          if (last?.role === 'assistant') {
            ;(last.notices ??= []).push({ beforeRound: last.assistants.length, message })
          } else {
            turns.push({ key: `a${message.timestamp}-${turns.length}`, role: 'assistant', assistants: [],
              notices: [{ beforeRound: 0, message }] })
          }
        } else if (message.display)
          turns.push({ key: `c${message.timestamp}-${turns.length}`, role: 'custom', message })
        break
    }
  }
  placeSummaries(turns, summaries)
  return turns
}

/** The newest moment a turn paints, so a summary can be placed by time. */
function turnEndedAt(turn: ChatTurn): number {
  if (turn.role === 'user') return turn.user.timestamp
  if (turn.role === 'assistant') {
    const fromMessages = turn.assistants.reduce(
      (end, message) => Math.max(end, message.completedAt ?? message.timestamp),
      0
    )
    const fromNotices = turn.notices?.reduce(
      (end, notice) => Math.max(end, notice.message.timestamp),
      0
    ) ?? 0
    return Math.max(fromMessages, fromNotices)
  }
  return turn.message.timestamp
}

/**
 * Put every summary where it happened, independent of input array layout.
 *
 * A full selected branch already contains old messages followed by the
 * compaction entry, while an older/compaction-aware list can start with
 * `[summary, ...kept, ...new]`. Ordering by timestamp handles both and keeps
 * the row after the conversation it summarizes and before what followed.
 */
function placeSummaries(turns: ChatTurn[], summaries: ChatTurn[]): void {
  for (const summary of summaries) {
    const at = turnEndedAt(summary)
    let index = 0
    turns.forEach((turn, position) => {
      if (turnEndedAt(turn) <= at) index = position + 1
    })
    turns.splice(index, 0, summary)
  }
}

/** One file list per execution scope, even when user steers create multiple
 * display groups. Ownership moves to the last group without copying results. */
export interface ChangeScope {
  id: string
  reviewId: number
  ownerKey: string
  assistants: AssistantMsg[]
  completions: CustomMsg[]
  prompt: UserMsg | null
}

export function collectChangeScopes(turns: readonly ChatTurn[]): Map<string, ChangeScope> {
  const scopes = new Map<string, ChangeScope>()
  let prompt: UserMsg | null = null
  for (const turn of turns) {
    if (turn.role === 'user') prompt = turn.user
    if (turn.role === 'info') prompt = null
    if (turn.role !== 'assistant') continue
    for (const message of turn.assistants) {
      const id = message.changeScopeId ?? turn.key
      let scope = scopes.get(id)
      if (!scope) {
        scope = { id, reviewId: message.timestamp, ownerKey: turn.key, assistants: [], completions: [], prompt }
        scopes.set(id, scope)
      }
      scope.ownerKey = turn.key
      scope.assistants.push(message)
    }
    // Completion evidence follows its display group's execution scope even
    // when a later user steer moves that scope's file list to another group.
    const scopeId = turn.assistants[0]?.changeScopeId ?? turn.key
    const scope = scopes.get(scopeId)
    if (scope) scope.completions.push(...(turn.notices ?? []).map(notice => notice.message)
      .filter(message => message.customType === 'subagent_completion'))
  }
  return scopes
}
