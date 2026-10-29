import { memo, useMemo, useSyncExternalStore } from 'react'
import { ChatAdd, Link2 } from '@/lib/icons'
import { Button } from '@/components/motion/button'
import { RunningLoader } from './RunningLoader'
import { MessageGroup, Message, MessageBubble, MessageBubbleContent } from '@/components/agents/message'
import { MessageScroller } from '@/components/agents/message-scroller'
import { PromptInput } from '@/components/agents/prompt-input'
import { Tooltip } from '@/components/motion/tooltip'
import { Markdown } from '@/lib/markdown'
import { StreamingResponse } from '@/components/agents/streaming-response'
import { formatTime } from '@/lib/format'
import type { SideChatExchange, SideChatStore } from '@/state/side-chat-store'
import type { UserMsg } from '../../../../shared/types'
import { useI18n } from '@/i18n'
import { UserItem } from './MessageItems'

interface SideChatPaneProps {
  store: SideChatStore
  /** Composer draft lives with the tab, not the pane, so switching panel tabs
   * (or collapsing the rail) keeps what was typed. */
  draft: string
  onDraftChange: (value: string) => void
  /** True while this thread is bound to the session the workspace shows. */
  onCurrentSession: boolean
  /** Point this thread at the current session, clearing its exchanges. */
  onRebind: () => void
}

/**
 * Side chat (`/btw`): a thread of quick questions answered from this session's
 * context, which never writes back into it and has no tools. The pane renders
 * one exchange per question — the app's own user bubble over a markdown answer —
 * and reuses the transcript's message components so it reads as the same
 * product, minus the session-level affordances (edit/resend/fork) that belong to
 * the real conversation.
 */
export const SideChatPane = memo(function SideChatPane({
  store,
  draft,
  onDraftChange,
  onCurrentSession,
  onRebind
}: SideChatPaneProps) {
  const { t } = useI18n()
  const state = useSyncExternalStore(store.subscribe, store.getState)
  const busy = state.activeId !== null

  const send = (value: string) => {
    if (!value.trim() || busy) return
    onDraftChange('')
    store.ask(value)
  }

  return (
    <div data-side-chat-pane className="flex h-full min-h-0 min-w-0 flex-col">
      <MessageScroller
        busy={busy}
        label={t('sidebar.chatTranscript')}
        className="min-h-0 flex-1"
        viewportClassName="px-3 py-4"
        contentClassName="pane-readable min-h-full overflow-x-clip"
      >
        <MessageGroup spacing="default">
          {state.exchanges.length === 0 ? <SideChatEmpty /> : null}
          {state.exchanges.map((exchange, index) => (
            <SideChatExchangeRow
              key={exchange.id}
              exchange={exchange}
              spaced={index > 0}
            />
          ))}
        </MessageGroup>
      </MessageScroller>

      {/* Same chrome as the workspace composer: no divider and no extra row —
          the input's own frame is the separation, and the transcript's bottom
          padding supplies the gap. */}
      <div className="shrink-0 bg-background px-3 pb-3">
        <div className="pane-readable">
        <PromptInput
          value={draft}
          onValueChange={onDraftChange}
          onSubmit={send}
          // Escape stops the side answer only: the workspace composer's
          // window-level Esc handler skips `defaultPrevented` events, so the
          // main session's run is untouched.
          onKeyDown={(event) => {
            if (event.key !== 'Escape' || !busy) return
            event.preventDefault()
            store.abort()
          }}
          loading={busy}
          onStop={() => store.abort()}
          minRows={1}
          maxRows={6}
          placeholder={t('sidebar.chatPlaceholder')}
          // The thread belongs to the session it was opened against, so drift
          // between that session and the selected one is actionable right here.
          // Nothing to do while the two already match, so the button is inert
          // then; when it can act it is an ordinary ghost icon button — quiet at
          // rest, highlighted on hover (the variant's own hover styling).
          leadingAction={
            <Tooltip content={t('sidebar.chatRebind')}>
              <Button
                variant="ghost"
                size="icon"
                aria-label={t('sidebar.chatRebind')}
                disabled={onCurrentSession}
                onClick={onRebind}
              >
                <Link2 aria-hidden="true" className="size-4" />
              </Button>
            </Tooltip>
          }
        />
        </div>
      </div>
    </div>
  )
})

/** One question and its answer, as two transcript-style rows. */
function SideChatExchangeRow({ exchange, spaced }: { exchange: SideChatExchange; spaced: boolean }) {
  const { t } = useI18n()
  const streaming = exchange.status === 'streaming'
  // The question is rendered through the transcript's own user bubble; a
  // synthetic message keeps the two views pixel-identical.
  const question = useMemo<UserMsg>(
    () => ({ role: 'user', content: exchange.question, timestamp: exchange.timestamp }),
    [exchange.question, exchange.timestamp]
  )

  return (
    <>
      <UserItem message={question} spaced={spaced} showActions actionsAlwaysVisible />

      {streaming && !exchange.answer ? (
        <Message from="assistant" className="flex h-6 items-center">
          <RunningLoader
            variant="spinner"
            size={16}
            label={t('sidebar.chatAsking')}
            className="shrink-0 text-primary"
          />
        </Message>
      ) : exchange.answer ? (
        <Message from="assistant" className="w-full">
          <MessageBubble variant="ghost" className="w-full">
            <MessageBubbleContent>
              <StreamingResponse
                status={streaming ? 'streaming' : 'complete'}
                copyText={exchange.answer}
                showActions={!streaming}
                meta={formatTime(exchange.timestamp)}
              >
                <Markdown streaming={streaming}>{exchange.answer}</Markdown>
              </StreamingResponse>
            </MessageBubbleContent>
          </MessageBubble>
        </Message>
      ) : null}

      {exchange.status === 'error' ? (
        <p className="text-xs text-destructive [overflow-wrap:anywhere]">
          {t('sidebar.chatAnswerFailed')}
          {exchange.error ? ` · ${exchange.error}` : ''}
        </p>
      ) : null}

      {exchange.status === 'aborted' ? (
        <p className="text-xs text-muted-foreground">{t('sidebar.chatAborted')}</p>
      ) : null}
    </>
  )
}

function SideChatEmpty() {
  const { t } = useI18n()
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-4 py-16 text-center">
      <ChatAdd aria-hidden="true" className="size-5 text-muted-foreground/70" />
      <p className="text-sm font-medium text-foreground">{t('sidebar.chatEmptyTitle')}</p>
      <p className="text-xs leading-ui text-muted-foreground">{t('sidebar.chatEmptyBody')}</p>
    </div>
  )
}
