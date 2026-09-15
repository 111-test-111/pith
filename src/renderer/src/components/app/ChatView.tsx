import { BashTasksProvider } from '@/lib/bash-tasks'
import { SessionTasks } from './SessionTasks'
import { memo, useMemo, useSyncExternalStore } from 'react'
import { AlertTriangle, Minimize2, RotateCcw, X } from '@/lib/icons'
import { MessageGroup } from '@/components/agents/message'
import { MessageScroller } from '@/components/agents/message-scroller'
import type { PreviewRailItem } from '@/components/motion/preview-rail'
import { Button } from '@/components/motion/button'
import type {
  AssistantMsg,
  ToolResultMsg,
  UserMsg
} from '../../../../shared/types'
import type { Notice, PiStore, PiState } from '@/state/pi-store'
import { useI18n } from '@/i18n'
import { formatTokenCount } from '@/lib/format'
import { buildTurns, collectChangeScopes, type ChatTurn } from '@/lib/chat-turns'
import { extractUserDisplay } from '@/lib/user-message'
import { AssistantGroup, BashItem, CustomItem, SummaryItem, UserItem } from './MessageItems'
import { RowReveal } from './RowReveal'
import { TurnStatus } from './TurnStatus'

/** Final answer text of a turn: the last round that produced prose. */
function finalReplyText(assistants: AssistantMsg[]): string {
  for (let i = assistants.length - 1; i >= 0; i--) {
    const text = assistants[i].content
      .filter((part) => part.type === 'text')
      .map((part) => (part as any).text as string)
      .join('\n\n')
      .trim()
    if (text) return text
  }
  return ''
}

/** Markdown syntax off a reply so the rail excerpt reads as prose. Code fence
 * bodies stay (they are often the answer); emphasis/link markers go. */
function plainMarkdown(text: string): string {
  return text
    .replace(/```[\w-]*\n?/g, '')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/__(.*?)__/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
}

/** Word-boundary ellipsis, mirroring beUI's preview truncation. */
function excerpt(text: string, limit: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (normalized.length <= limit) return normalized
  const cut = normalized.slice(0, limit)
  const boundary = cut.lastIndexOf(' ')
  return `${cut.slice(0, boundary > limit * 0.65 ? boundary : limit).trim()}…`
}

const RAIL_TITLE_LIMIT = 56
const RAIL_DESCRIPTION_LIMIT = 88

/**
 * Localized text for an in-flight work notice. The main process ships the key
 * and its parameters (never prose), and raw SDK error text rides along as a
 * detail suffix.
 */
function noticeText(notice: Notice, t: ReturnType<typeof useI18n>['t']): string {
  const base =
    notice.key === 'retrying'
      ? t('chat.noticeRetrying', {
          attempt: notice.params?.attempt ?? 0,
          maxAttempts: notice.params?.maxAttempts ?? 0
        })
      : notice.key === 'retryFailed'
        ? t('chat.noticeRetryFailed')
        : notice.key === 'compacting'
          ? t('chat.noticeCompacting')
          : t('chat.noticeCompactFailed')
  return notice.detail ? `${base} · ${notice.detail}` : base
}

/**
 * Subscribes to the FULL store state itself — the transcript is the one place
 * that must see every streaming delta — so the rest of the Workspace tree can
 * subscribe to the cheaper shell slice instead.
 */
export const ChatView = memo(function ChatView({
  store,
  scrollResetKey = 0,
  onDismissError,
  onResend,
  onEditMessage,
  onRewindMessage,
  onFork,
  onReview,
  onOpenSession
}: {
  store: PiStore
  /** Changes when a resend/retry lands, forcing the transcript back to the
   * live edge so the retried user message is visible. */
  scrollResetKey?: number
  /** Session-level actions are OPTIONAL so a read-only view (an opened subagent
   * child, or the rail's peeked transcript) can omit them instead of passing
   * no-ops that look live but do nothing. */
  onDismissError?: () => void
  /** Retry a turn's response — rewinds the session to the user message that
   * opened it and re-prompts. The assistant turn's retry cell and the error
   * banner funnel here. */
  onResend?: (message: UserMsg) => void
  /** Open the edit-and-resend dialog for a user message (does not resend by
   * itself — the dialog's Resend press does). */
  onEditMessage?: (message: UserMsg) => void
  onRewindMessage?: (message: UserMsg) => void
  /** Fork the session at an assistant message; opens the fork. */
  onFork?: (message: AssistantMsg) => void
  /** Open the review tab on a turn — the changed-files card's Review action.
   * The id is the turn's first assistant message timestamp. */
  onReview?: (turnId: number) => void
  /** Open another session file (a subagent child) as the visible chat. */
  onOpenSession?: (path: string, cwd?: string) => void
}) {
  const { t } = useI18n()
  const state: PiState = useSyncExternalStore(store.subscribe, store.getState)
  const toolResults = useMemo(() => {
    const map = new Map<string, ToolResultMsg>()
    for (const message of state.messages) {
      if (message.role === 'toolResult') map.set(message.toolCallId, message)
    }
    return map
  }, [state.messages])

  const busy = state.isStreaming || Boolean(state.streaming)
  /** Seed for the waiting row's spinner verb: the session, not the turn, so the
   * sentence a user is mid-read never flips when the row moves from the
   * transcript's pending slot into the live turn. */
  const spinnerSeed = state.sessionPath ?? 'live'
  const turns = useMemo(() => buildTurns(state.messages), [state.messages])
  const changeScopes = useMemo(() => collectChangeScopes(turns), [turns])
  /**
   * Navigation rail: one tick per user turn. The hover preview pairs the
   * user's message with the turn's final assistant reply — both excerpted
   * from the message data, so UI chrome (tool cards, copy buttons, usage
   * footers) never leaks into the rail the way DOM-derived previews did.
   */
  const railItems = useMemo<PreviewRailItem[]>(() => {
    // buildTurns keeps assistant rounds in their own turns; pair each user
    // turn with the assistant turns that follow it, up to the next user turn.
    const userTurns: { turn: Extract<ChatTurn, { role: 'user' }>; assistants: AssistantMsg[] }[] = []
    for (let index = 0; index < turns.length; index++) {
      const turn = turns[index]
      if (turn.role !== 'user') continue
      const assistants: AssistantMsg[] = []
      for (let next = index + 1; next < turns.length; next++) {
        const candidate = turns[next]
        if (candidate.role !== 'assistant') break
        assistants.push(...candidate.assistants)
      }
      userTurns.push({ turn, assistants })
    }
    return userTurns.map(({ turn, assistants }, index) => {
      const reply = finalReplyText(assistants)
      return {
        id: turn.key,
        label: excerpt(extractUserDisplay(turn.user.content).text, RAIL_TITLE_LIMIT),
        description: reply ? excerpt(plainMarkdown(reply), RAIL_DESCRIPTION_LIMIT) : undefined,
        ariaLabel: t('chat.navGoTo', { index: index + 1, count: userTurns.length })
      }
    })
  }, [turns, t])
  const streaming = state.streaming
  const lastTurn = turns[turns.length - 1]
  /** Retry target for the error banner: the newest user turn. */
  const lastUserTurn = (() => {
    for (let index = turns.length - 1; index >= 0; index--) {
      const turn = turns[index]
      if (turn.role === 'user') return turn.user
    }
    return undefined
  })()
  /**
   * A run that ENDED on a failure (`auto_retry_end` without success, or a
   * failed compaction) is not status chrome: the turn's own group renders it as
   * unframed error prose, directly above the retry/fork row it explains. The
   * in-flight notices (retrying/compacting) stay in the framed status row
   * below, and so does a failure that has no settled assistant turn to host it.
   */
  const failureNotice =
    state.notice && (state.notice.key === 'retryFailed' || state.notice.key === 'compactFailed')
      ? noticeText(state.notice, t)
      : null
  const failureHosted = Boolean(failureNotice && lastTurn?.role === 'assistant')
  // A fresh streaming round either joins the trailing assistant turn or
  // (first round of a new turn) opens one.
  const lastScopeId = lastTurn?.role === 'assistant' ? lastTurn.assistants[0]?.changeScopeId : undefined
  const continuesLastScope = !state.activeChangeScopeId || !lastScopeId || state.activeChangeScopeId === lastScopeId
  const streamingJoinsLastTurn = Boolean(streaming && lastTurn?.role === 'assistant' && continuesLastScope)
  // Between rounds (tools running, no partial message yet) the spinner sits
  // inside the trailing turn instead of a separate row.
  const waitingInLastTurn = state.isStreaming && !streaming && lastTurn?.role === 'assistant' && continuesLastScope
  // The first round of a turn streams before it exists as a message. Render it
  // as a synthetic turn keyed exactly the way `buildTurns` will key the
  // persisted message (`a<timestamp>-<index>`), and splice it into the same
  // list. `message_end` then swaps the data WITHOUT remounting the group: the
  // old separate `key="streaming"` row was torn down and re-created on every
  // turn start, which replayed its entrance animation and re-rendered the whole
  // turn (the visible jump at the start of a fast model's turn).
  const liveTurn: ChatTurn | null =
    streaming && !streamingJoinsLastTurn
      ? {
          key: `a${streaming.timestamp}-${turns.length}`,
          role: 'assistant',
          assistants: [streaming],
          live: true
        }
      : null
  const displayTurns = liveTurn ? [...turns, liveTurn] : turns
  const lastDisplayTurn = displayTurns[displayTurns.length - 1]

  /** One transcript row. Assistant rounds are folded by the group itself —
   * only when a turn has many steps — so every user prompt and every turn's
   * final reply stay visible. `previous` lets a user row sit a little further
   * from the assistant turn above it than turns sit from each other. */
  const renderTurn = (turn: ChatTurn, previous?: ChatTurn) => {
    if (turn.role === 'user')
      return (
        <UserItem
          key={turn.key}
          message={turn.user}
          railId={turn.key}
          spaced={previous?.role === 'assistant'}
          showActions={!busy}
          // Only the transcript's newest row keeps its actions on screen; every
          // older one reveals them on hover.
          actionsAlwaysVisible={turn === lastTurn}
          onEdit={state.subagentChild ? undefined : onEditMessage}
          onRewind={state.subagentChild ? undefined : onRewindMessage}
        />
      )
    if (turn.role === 'info')
      return (
        <RowReveal key={turn.key} animate={busy}>
          <SummaryItem message={turn.message} />
        </RowReveal>
      )
    if (turn.role === 'bash')
      return (
        <RowReveal key={turn.key} animate={busy}>
          <BashItem message={turn.message} />
        </RowReveal>
      )
    if (turn.role === 'custom')
      return (
        <RowReveal key={turn.key} animate={busy}>
          <CustomItem message={turn.message} />
        </RowReveal>
      )

    const isLast = turn === lastDisplayTurn
    const live = Boolean(turn.live)
    const messages = live
      ? turn.assistants
      : isLast && streamingJoinsLastTurn
        ? [...turn.assistants, streaming!]
        : turn.assistants
    const scopeId = turn.assistants[0]?.changeScopeId ?? turn.key
    const changes = changeScopes.get(scopeId)
    // Retry rewinds to the user message that opened this turn's exchange;
    // scanning stops at a summary (its user message may be compacted away).
    // Fork keeps everything up to the turn's last round.
    const index = displayTurns.indexOf(turn)
    let retryFrom: UserMsg | undefined
    for (let i = index - 1; i >= 0; i--) {
      const candidate = displayTurns[i]
      if (candidate.role === 'user') {
        retryFrom = candidate.user
        break
      }
      if (candidate.role === 'info') break
    }
    return (
      <AssistantGroup
        key={turn.key}
        messages={messages}
        notices={turn.notices}
        writtenMessages={changes?.assistants}
        writtenCompletions={changes?.completions}
        writtenReviewId={changes?.reviewId}
        showWrittenFiles={changes?.ownerKey === turn.key && !(busy && scopeId === state.activeChangeScopeId)}
        streamingIndex={live ? 0 : isLast && streamingJoinsLastTurn ? turn.assistants.length : -1}
        pending={!live && isLast && waitingInLastTurn}
        retryFrom={retryFrom}
        forkAt={turn.assistants[turn.assistants.length - 1]}
        failure={turn === lastTurn ? failureNotice ?? undefined : undefined}
        onResend={state.subagentChild ? undefined : onResend}
        onFork={state.subagentChild ? undefined : onFork}
        showActions={!busy}
        actionsAlwaysVisible={isLast && !live}
        cwd={state.cwd}
        toolResults={toolResults}
        toolRuns={state.toolRuns}
        spinnerSeed={spinnerSeed}
        onReview={onReview}
      />
    )
  }

  return (
    <BashTasksProvider sessionPath={state.sessionPath}>
      <SessionTasks key={state.sessionPath} todos={state.todos} subagents={state.subagents} busy={busy} sessionPath={state.sessionPath} onOpenSession={onOpenSession} />
      <MessageScroller
      busy={busy}
      navigation="rail"
      railItems={railItems}
      // local patch (pi-app): bumping the reset key on resend/retry re-runs the
      // scroller's live-edge reset (following = true + scroll to bottom), which
      // a plain scroll can't do while the rewound transcript is too short to
      // produce a scroll event.
      initialScrollKey={state.sessionPath ? `${state.sessionPath}#${scrollResetKey}` : null}
      label={t('chat.transcriptAria')}
      className="min-h-0 flex-1"
      viewportClassName="px-3 py-5 sm:px-5"
      // `clip` (not `hidden`): hidden forces overflow-y to `auto`, turning the
      // column into a nested scroll container whose scrollbar flashes on
      // session switches. clip never creates a scroll container.
      contentClassName="mx-auto min-h-full w-full max-w-3xl overflow-x-clip"
    >
      <MessageGroup spacing="default">
        {displayTurns.map((turn, index) => renderTurn(turn, displayTurns[index - 1]))}

        {state.isStreaming && !streaming && !waitingInLastTurn ? (
          <TurnStatus seedKey={spinnerSeed} />
        ) : null}

        {state.compactionNotices.map((notice) => (
          <RowReveal animate key={notice.id}>
            {/* A compaction swaps the whole transcript, so it acknowledges
                itself where the swap happened — the same quiet row a
                background-task completion uses, never a conversation card. */}
            <div
              data-compaction-notice
              className="flex items-center gap-2 rounded-xl border border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground"
            >
              <Minimize2 aria-hidden="true" className="size-3.5 shrink-0" />
              <span className="font-medium text-foreground">{t('chat.compacted')}</span>
              <span className="tabular-nums">
                {t('chat.compactedTokens', {
                  before: formatTokenCount(notice.tokensBefore),
                  after: notice.tokensAfter === null ? '—' : formatTokenCount(notice.tokensAfter)
                })}
              </span>
            </div>
          </RowReveal>
        ))}

        {state.notice && !failureHosted ? (
          <RowReveal animate>
            <div
              data-turn-notice
              className="rounded-xl bg-muted/60 px-3 py-2 text-xs text-muted-foreground"
            >
              {noticeText(state.notice, t)}
            </div>
          </RowReveal>
        ) : null}

        {state.error ? (
          <RowReveal animate>
            <div className="flex items-start justify-between gap-3 rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-sm text-destructive">
              <span className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                {typeof state.error === 'string' ? state.error : t(`rewind.error.${state.error.code}`)}
              </span>
              <span className="flex items-center gap-0.5">
                {lastUserTurn && !busy && !state.subagentChild ? (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-6 text-destructive hover:text-destructive"
                    aria-label={t('chat.errorRetry')}
                    onClick={() => onResend?.(lastUserTurn)}
                  >
                    <RotateCcw className="size-3.5" />
                  </Button>
                ) : null}
                <Button variant="ghost" size="icon" className="size-6" aria-label={t('chat.dismissError')} onClick={() => onDismissError?.()}>
                  <X className="size-3.5" />
                </Button>
              </span>
            </div>
          </RowReveal>
        ) : null}
      </MessageGroup>
    </MessageScroller>
    </BashTasksProvider>
  )
})
