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
 * An opening user message and its assistant rounds form one turn. Steering
 * bubbles, compaction and completion notices keep their slots between rounds.
 * Branch summaries, bash executions and other extension
 * messages stand alone so nothing silently disappears from the history.
 *
 * Shared by the workspace transcript and the side-chat pane — both render the
 * same message log, so both fold it the same way.
 */
export type ChatTurn =
  | (ChatTurnBase & { role: 'user'; user: UserMsg; assistants: [] })
  | (ChatTurnBase & { role: 'assistant'; assistants: AssistantMsg[]; insertions?: TurnInsertion[]; live?: boolean })
  | (ChatTurnBase & { role: 'info'; message: CompactionSummaryMsg | BranchSummaryMsg })
  | (ChatTurnBase & { role: 'bash'; message: BashExecutionMsg })
  | (ChatTurnBase & { role: 'custom'; message: CustomMsg })

export type TurnInsertion =
  | { beforeRound: number; message: CustomMsg | CompactionSummaryMsg }
  | TurnSteer

export interface TurnSteer { beforeRound: number; message: UserMsg; key: string }

export function isTurnSteer(insertion: TurnInsertion): insertion is TurnSteer {
  return 'key' in insertion
}

/**
 * Folds the message log into turns: a prompt or follow-up opens a turn, every
 * following assistant round (tool rounds, then the final text) joins the same
 * turn so it renders as ONE message row. toolResult entries are skipped —
 * they are rendered through the toolResults map on the calling round.
 */
export function buildTurns(messages: readonly ChatMessage[]): ChatTurn[] {
  const turns: ChatTurn[] = []
  let summaryCount = 0
  const insert = (last: ChatTurn | undefined, message: TurnInsertion['message']) => {
    const turn = last?.role === 'assistant' ? last : {
      key: `a${message.timestamp}-${turns.length}`, role: 'assistant' as const, assistants: [], insertions: []
    }
    if (turn !== last) turns.push(turn)
    const items = turn.insertions ??= []
    const beforeRound = turn.assistants.length
    items.push(message.role === 'user'
      ? { beforeRound, message, key: `u${message.sessionEntryId ?? `${message.timestamp}-${turns.length}-${items.length}`}` }
      : { beforeRound, message })
  }
  for (const message of orderLegacySummaries(messages)) {
    const last = turns[turns.length - 1]
    switch (message.role) {
      case 'user':
        if (message.queuedDelivery === 'steer') {
          insert(last, message)
          break
        }
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
        // Like a background completion, compaction is one process row, not
        // the end of the assistant turn. Its round anchor never moves when
        // later replies extend the same group.
        if (last?.role === 'assistant') {
          insert(last, message)
        } else {
          turns.push({ key: `s${message.timestamp}-${summaryCount++}`, role: 'info', message })
        }
        break
      case 'branchSummary':
        turns.push({ key: `s${message.timestamp}-${summaryCount++}`, role: 'info', message })
        break
      case 'bashExecution':
        turns.push({ key: `b${message.timestamp}-${turns.length}`, role: 'bash', message })
        break
      case 'custom':
        // Completion deliveries are tool data, not conversation turns: they
        // attach to the running turn as notices (the same treatment a
        // background bash completion gets) instead of opening a new card.
        if (message.display && (message.customType === 'bash_task_completion' || message.customType === 'subagent_completion' || message.customType === 'subagent_message' || message.customType === 'ask_user_answer')) {
          insert(last, message)
        } else if (message.display)
          turns.push({ key: `c${message.timestamp}-${turns.length}`, role: 'custom', message })
        break
    }
  }
  return turns
}

/**
 * Older model-context snapshots start with `[summary, ...kept, ...new]`.
 * Move only those unanchored headers by message time BEFORE folding rounds.
 * Current full-branch transcripts retain their persisted order, including a
 * queued steer created before compaction but delivered after its entry.
 */
function orderLegacySummaries(messages: readonly ChatMessage[]): readonly ChatMessage[] {
  let headers = 0
  for (const message of messages) {
    if (message.role !== 'compactionSummary' && message.role !== 'branchSummary') break
    if (message.role === 'compactionSummary' && message.sessionEntryId) break
    headers++
  }
  if (!headers) return messages
  const ordered = messages.slice(headers)
  for (const summary of messages.slice(0, headers)) {
    let index = 0
    ordered.forEach((message, position) => {
      if (message.timestamp <= summary.timestamp) index = position + 1
    })
    ordered.splice(index, 0, summary)
  }
  return ordered
}

/** One file list per execution scope. Task wakes can add to an existing
 * scope; ownership belongs to its last display group. */
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
    const scopeId = turn.assistants[0]?.changeScopeId ?? turn.key
    const scope = scopes.get(scopeId)
    if (scope) scope.completions.push(...(turn.insertions ?? []).map(insertion => insertion.message)
      .filter((message): message is CustomMsg => message.role === 'custom' && message.customType === 'subagent_completion'))
  }
  return scopes
}
