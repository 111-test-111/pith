import { useMemo } from 'react'
import { AlertTriangle, X } from 'lucide-react'
import { MessageGroup } from '@/components/agents/message'
import { MessageScroller } from '@/components/agents/message-scroller'
import { ThinkingShimmer } from '@/components/agents/loading-states'
import { Button } from '@/components/motion/button'
import type { AssistantMsg, ChatMessage, ToolResultMsg, UserMsg } from '../../../../shared/types'
import type { PiState } from '@/state/pi-store'
import { useI18n } from '@/i18n'
import { AssistantGroup, UserItem } from './MessageItems'

interface ChatTurn {
  key: string
  role: 'user' | 'assistant'
  user?: UserMsg
  /** Consecutive assistant rounds of this turn, oldest first. */
  assistants: AssistantMsg[]
}

/**
 * Folds the message log into turns: a user message opens a turn, every
 * following assistant round (tool rounds, then the final text) joins the same
 * turn so it renders as ONE message row. toolResult entries are skipped —
 * they are rendered through the toolResults map on the calling round.
 */
function buildTurns(messages: ChatMessage[]): ChatTurn[] {
  const turns: ChatTurn[] = []
  for (const message of messages) {
    if (message.role === 'user') {
      turns.push({ key: `u${message.timestamp}-${turns.length}`, role: 'user', user: message, assistants: [] })
    } else if (message.role === 'assistant') {
      const last = turns[turns.length - 1]
      if (last && last.role === 'assistant') last.assistants.push(message)
      else turns.push({ key: `a${message.timestamp}-${turns.length}`, role: 'assistant', assistants: [message] })
    }
  }
  return turns
}

export function ChatView({ state, onDismissError }: { state: PiState; onDismissError: () => void }) {
  const { t } = useI18n()
  const toolResults = useMemo(() => {
    const map = new Map<string, ToolResultMsg>()
    for (const message of state.messages) {
      if (message.role === 'toolResult') map.set(message.toolCallId, message)
    }
    return map
  }, [state.messages])

  const busy = state.isStreaming || Boolean(state.streaming)
  const turns = useMemo(() => buildTurns(state.messages), [state.messages])
  const streaming = state.streaming
  const lastTurn = turns[turns.length - 1]
  // A fresh streaming round either joins the trailing assistant turn or
  // (first round of a new turn) becomes its own group.
  const streamingJoinsLastTurn = Boolean(streaming && lastTurn?.role === 'assistant')
  // Between rounds (tools running, no partial message yet) the shimmer sits
  // inside the trailing turn instead of a separate avatar row.
  const waitingInLastTurn = state.isStreaming && !streaming && lastTurn?.role === 'assistant'

  return (
      <MessageScroller
      busy={busy}
      navigation="rail"
      label={t('chat.transcriptAria')}
      className="min-h-0 flex-1"
      viewportClassName="px-3 py-5 sm:px-5"
      // `clip` (not `hidden`): hidden forces overflow-y to `auto`, turning the
      // column into a nested scroll container whose scrollbar flashes on
      // session switches. clip never creates a scroll container.
      contentClassName="mx-auto min-h-full w-full max-w-3xl overflow-x-clip"
    >
      <MessageGroup spacing="default">
        {state.messages.length === 0 && !busy ? <EmptyState /> : null}

        {turns.map((turn) => {
          if (turn.role === 'user') return <UserItem key={turn.key} message={turn.user!} />

          const isLast = turn === lastTurn
          const messages = isLast && streamingJoinsLastTurn ? [...turn.assistants, streaming!] : turn.assistants
          return (
            <AssistantGroup
              key={turn.key}
              messages={messages}
              streamingIndex={isLast && streamingJoinsLastTurn ? turn.assistants.length : -1}
              pending={isLast && waitingInLastTurn}
              toolResults={toolResults}
              toolRuns={state.toolRuns}
            />
          )
        })}

        {streaming && !streamingJoinsLastTurn ? (
          <AssistantGroup
            key="streaming"
            messages={[streaming]}
            streamingIndex={0}
            toolResults={toolResults}
            toolRuns={state.toolRuns}
          />
        ) : null}

        {state.isStreaming && !streaming && !waitingInLastTurn ? (
          <div className="flex items-center gap-2 pl-11 text-sm text-muted-foreground">
            <ThinkingShimmer>{t('chat.working')}</ThinkingShimmer>
          </div>
        ) : null}

        {state.queue.steering.length ? (
          <div className="rounded-xl border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
            {t('chat.queuedSteer', { text: state.queue.steering[state.queue.steering.length - 1] })}
          </div>
        ) : null}

        {state.notice ? (
          <div className="rounded-xl bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
            {state.notice}
          </div>
        ) : null}

        {state.error ? (
          <div className="flex items-start justify-between gap-3 rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-sm text-destructive">
            <span className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              {state.error}
            </span>
            <Button variant="ghost" size="icon" className="size-6" aria-label="Dismiss error" onClick={onDismissError}>
              <X className="size-3.5" />
            </Button>
          </div>
        ) : null}
      </MessageGroup>
    </MessageScroller>
  )
}

function EmptyState() {
  const { t } = useI18n()
  // Both locales carry exactly one literal `@` (the mention trigger); split
  // around it so it keeps its inline-code styling.
  const [before, after] = t('chat.emptyBody').split('@')
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-24 text-center">
      <div className="grid size-12 place-items-center rounded-2xl bg-primary/10 font-mono text-2xl font-bold text-primary">
        π
      </div>
      <p className="text-base font-medium text-foreground">{t('chat.emptyTitle')}</p>
      <p className="max-w-sm text-sm text-muted-foreground">
        {before}
        <code className="rounded bg-muted px-1 py-0.5 text-xs">@</code>
        {after}
      </p>
    </div>
  )
}
