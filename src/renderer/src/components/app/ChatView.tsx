import { PlanCard, PlanPresentationContext } from './PlanCard'
import { visibleSubmissionIds } from '@/lib/plan-submissions'
import { BashTasksProvider } from '@/lib/bash-tasks'
import { ImageReplaysProvider } from '@/lib/image-replays'
import { SessionTasks } from './SessionTasks'
import { memo, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, useSyncExternalStore } from 'react'
import { AlertTriangle, RefreshCw, X } from '@/lib/icons'
import { MessageGroup } from '@/components/agents/message'
import { MessageScroller } from '@/components/agents/message-scroller'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/components/motion/context-menu'
import type { PreviewRailItem } from '@/components/motion/preview-rail'
import { Button } from '@/components/motion/button'
import type {
  AssistantMsg,
  ToolResultMsg,
  UserMsg
} from '../../../../shared/types'
import type { Notice, PiStore, PiState } from '@/state/pi-store'
import { useI18n } from '@/i18n'
import { buildTurns, collectChangeScopes, type ChatTurn } from '@/lib/chat-turns'
import { extractReviewTurns } from '@/lib/turn-written-files'
import { extractUserDisplay } from '@/lib/user-message'
import { AssistantGroup, BashItem, CustomItem, SummaryItem, UserItem } from './MessageItems'
import { RowReveal } from './RowReveal'
import { SummaryDisclosureContext, SummaryRow } from './SummaryRow'
import { TurnStatus } from './TurnStatus'
import { TRANSCRIPT_ROW_WIDTH } from '@/lib/transcript-rhythm'
import { continuationTarget } from '../../../../shared/continuation'

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

/** Which transcript row a menu request belongs to. The app already renders
 * these markers (`UserItem`'s rail id, `AssistantGroup`'s turn timestamp), so
 * one handler on the transcript surface resolves the target from the DOM
 * without a trigger per row. */
type TranscriptMenuRow =
  | { kind: 'user'; key: string }
  | { kind: 'assistant'; stamp: string }

type TranscriptMenuTarget =
  | { kind: 'user'; message: UserMsg; text: string }
  | { kind: 'assistant'; copyText: string; retryFrom?: UserMsg; forkAt?: AssistantMsg }

/** Resolve which transcript row a menu request belongs to, from markers the
 * app already renders: user rows carry `data-rail-id` (the turn key),
 * assistant rows `data-assistant-group` (the turn's first timestamp). */
function transcriptMenuRow(element: HTMLElement): TranscriptMenuRow | null {
  const assistantRow = element.closest<HTMLElement>('[data-assistant-group]')
  if (assistantRow) {
    return {
      kind: 'assistant',
      stamp: assistantRow.getAttribute('data-assistant-group') ?? ''
    }
  }
  const userRow = element.closest<HTMLElement>('[data-rail-id]')
  return userRow ? { kind: 'user', key: userRow.getAttribute('data-rail-id') ?? '' } : null
}

/** The user message that opened a turn: retry/fork targets. Scanning stops at a
 * summary, whose user message may have been compacted away. */
function retryFromFor(displayTurns: ChatTurn[], turn: ChatTurn): UserMsg | undefined {
  for (let i = displayTurns.indexOf(turn) - 1; i >= 0; i--) {
    const candidate = displayTurns[i]
    if (candidate.role === 'user') return candidate.user
    if (candidate.role === 'info') break
  }
  return undefined
}

/** Resolve the marker target back to the turn it names. Assistant rows key on
 * the same timestamp `AssistantGroup` puts on its DOM node (`messages[0]`, or
 * the first notice for a turn that only carries notices). */
function resolveTranscriptMenu(
  row: TranscriptMenuRow | null,
  displayTurns: ChatTurn[]
): TranscriptMenuTarget | null {
  if (!row) return null
  if (row.kind === 'user') {
    const turn = displayTurns.find(
      (candidate) => candidate.role === 'user' && candidate.key === row.key
    )
    return turn?.role === 'user'
      ? { kind: 'user', message: turn.user, text: extractUserDisplay(turn.user.content).text }
      : null
  }
  const turn = displayTurns.find(
    (candidate) =>
      candidate.role === 'assistant' &&
      String(
        candidate.assistants[0]?.timestamp ?? candidate.notices?.[0]?.message.timestamp ?? 0
      ) === row.stamp
  )
  if (turn?.role !== 'assistant') return null
  return {
    kind: 'assistant',
    copyText: finalReplyText(turn.assistants),
    retryFrom: retryFromFor(displayTurns, turn),
    forkAt: turn.assistants[turn.assistants.length - 1]
  }
}

const RAIL_TITLE_LIMIT = 56
const RAIL_DESCRIPTION_LIMIT = 88

/**
 * Localized text for an in-flight retry notice. The main process ships the key
 * and its parameters (never prose), and raw SDK error text rides along as a
 * detail suffix. Compaction is not here: it renders as a tool row (`SummaryRow`)
 * in the same slot, because that is what it is.
 */
function noticeText(notice: Notice, t: ReturnType<typeof useI18n>['t']): string {
  const base = notice.key === 'retrying'
    ? t('chat.noticeRetrying', {
        attempt: notice.params?.attempt ?? 0,
        maxAttempts: notice.params?.maxAttempts ?? 0
      })
    : t('chat.noticeRetryFailed')
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
  onContinue,
  onEditMessage,
  onRewindMessage,
  onUndoFiles,
  onFork,
  onReview,
  onOpenSession,
  onRefinePlan
}: {
  onRefinePlan?: () => void
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
  onContinue?: (message: AssistantMsg) => void
  /** Open the edit-and-resend dialog for a user message (does not resend by
   * itself — the dialog's Resend press does). */
  onEditMessage?: (message: UserMsg) => void
  onRewindMessage?: (message: UserMsg) => void
  /** Open Rewind on the user message that opened a turn's change scope,
   * preselected files-only — the changed-files card's Undo action. */
  onUndoFiles?: (message: UserMsg) => void
  /** Fork the session at an assistant message; opens the fork. */
  onFork?: (message: AssistantMsg) => void
  /** Open the review tab on a turn — the changed-files card's Review action.
   * The id is the turn's first assistant message timestamp. */
  onReview?: (turnId: number) => void
  /** Open another session file (a subagent child) as the visible chat. */
  onOpenSession?: (path: string, cwd?: string) => void
}) {
  const { t } = useI18n()
  // One menu for the whole transcript. The target row is resolved in a capture
  // handler (the vendored trigger opens on the bubble pass), so every message
  // row shares it and no row needs its own wrapper.
  const menuRow = useRef<TranscriptMenuRow | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const state: PiState = useSyncExternalStore(store.subscribe, store.getState)
  const summaryDisclosures = useRef(new Map<string, boolean>())
  const toolResults = useMemo(() => {
    const map = new Map<string, ToolResultMsg>()
    for (const message of state.messages) {
      if (message.role === 'toolResult') map.set(message.toolCallId, message)
    }
    return map
  }, [state.messages])

  const running = state.isStreaming || Boolean(state.streaming)
  /**
   * A prompt was echoed but its run has not been announced yet. The waiting
   * row (spinner + sentence) renders from this in the same commit as the
   * user's own bubble instead of trailing it by an IPC round trip; once
   * `agent_start` arrives, `isStreaming` owns the row exactly as before.
   */
  const awaitingRun = state.awaitingRun && !running
  // The echoed prompt already owns the waiting row. Hide message actions in
  // that same commit: removing their layout slot only at agent_start pulled
  // the spinner upward after it had appeared below the pending prompt.
  const busy = running || awaitingRun
  const continueFrom = !busy && !state.initializing && !state.subagentChild && !state.scheduledTaskSession &&
    !state.plan?.blockers.submit.includes('already-submitted') ? continuationTarget(state.messages) : null
  /** Seed for the waiting row's spinner verb: the session, not the turn, so the
   * sentence a user is mid-read never flips when the row moves from the
   * transcript's pending slot into the live turn. */
  const spinnerSeed = state.sessionPath ?? 'live'
  const turns = useMemo(() => buildTurns(state.messages), [state.messages])
  const changeScopes = useMemo(() => collectChangeScopes(turns), [turns])
  /**
   * Approving a plan asks the model by writing a synthetic user message that
   * carries the plan body. Nobody typed it: while it is the started approval's
   * opening entry, the transcript hides that row (and its rail tick) so the plan
   * card and the execution read as one continuous exchange.
   */
  const approvalOpeningEntryId =
    state.plan?.approval?.status === 'started' ? state.plan.approval.executionEntryId ?? null : null
  const hiddenUserKey = useMemo(() => {
    if (!approvalOpeningEntryId) return null
    const opening = turns.find(
      (turn) => turn.role === 'user' && turn.user.sessionEntryId === approvalOpeningEntryId
    )
    return opening?.role === 'user' ? opening.key : null
  }, [turns, approvalOpeningEntryId])
  /**
   * The Plan card's Review action opens the review pane on the turn that
   * executed the approved plan — the same pane and the same turn identity the
   * changed-files card uses. Offered only while the approval is started and that
   * turn actually listed files; otherwise the pane would fall back to an
   * unrelated turn and show changes the plan never caused.
   */
  const reviewExecutionId = useMemo(() => {
    const turnId = state.plan?.executionTurnId
    if (!onReview || state.plan?.approval?.status !== 'started' || typeof turnId !== 'number') return undefined
    return extractReviewTurns(state.messages, state.cwd).some((turn) => turn.id === turnId) ? turnId : undefined
  }, [state.plan, state.messages, state.cwd, onReview])
  const reviewExecution = reviewExecutionId !== undefined && onReview
    ? () => onReview(reviewExecutionId)
    : undefined
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
      // The plan-approval opening is protocol input, not a user prompt: it has
      // no tick of its own in the rail either.
      if (turn.key === hiddenUserKey) continue
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
   * A run that ENDED on a retry failure is not status chrome: the turn's own
   * group renders it as unframed error prose inside the folded process.
   * The in-flight retry notice stays in the framed status row
   * below, and so does a failure that has no settled assistant turn to host it.
   * A compaction is neither: it is a tool row of its own (below).
   */
  const failureNotice =
    state.notice && state.notice.key === 'retryFailed' ? noticeText(state.notice, t) : null
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
  const missingPlan = state.plan?.latest && !visibleSubmissionIds(state.messages).has(state.plan.latest.submissionEntryId) ? state.plan.latest : null
  const recoveredIndex = missingPlan ? displayTurns.findIndex(turn => {
    const time = turn.role === 'user' ? turn.user.timestamp : turn.role === 'assistant'
      ? (turn.assistants[0]?.timestamp ?? turn.notices?.[0]?.message.timestamp ?? 0) : turn.message.timestamp
    return time > missingPlan.submittedAt
  }) : -1
  const recoveryCard = missingPlan && state.sessionPath && state.plan
    ? <PlanCard key={`plan:${missingPlan.submissionEntryId}`} sessionPath={state.sessionPath} reference={missingPlan} state={state.plan} onRefine={onRefinePlan} /> : null
  const lastDisplayTurn = displayTurns[displayTurns.length - 1]
  const compactionProcess = state.compactionProcess.process
  const compactionRow = state.notice?.key === 'compacting' || state.notice?.key === 'compactFailed' ||
    compactionProcess?.status === 'running' || compactionProcess?.status === 'error' || compactionProcess?.status === 'cancelled' ? (
    <RowReveal key={`${compactionProcess?.id ?? 'compaction'}:${state.notice?.key ?? compactionProcess?.status}`} animate rowKind="process" className={TRANSCRIPT_ROW_WIDTH}>
      <SummaryRow
        kind="compaction"
        status={compactionProcess?.status === 'cancelled' ? 'cancelled' : state.notice?.key === 'compactFailed' || compactionProcess?.status === 'error' ? 'error' : 'running'}
        detail={state.notice?.detail ?? compactionProcess?.errorMessage}
        process={compactionProcess ?? undefined}
      />
    </RowReveal>
  ) : null
  // A live group owns the last spinner. Keep compaction in that group's row
  // stack, so it shares tool geometry and appears before the waiting row.
  const compactionHosted = Boolean(compactionRow && (liveTurn || streamingJoinsLastTurn || waitingInLastTurn))

  /** Right-click: resolve the row, then let the surface trigger open. A row the
   * menu has no actions for (a summary, a bash/custom notice, status chrome)
   * must not open an empty panel, so its default is prevented and the vendored
   * trigger skips its own open. */
  const captureMenuRow = (event: ReactMouseEvent<HTMLElement>) => {
    const row = transcriptMenuRow(event.target as HTMLElement)
    menuRow.current = row
    if (!row) event.preventDefault()
  }
  /** Touch/pen long-press opens through the trigger without a `contextmenu`
   * event, so the press records the row too. A press on a row with no actions
   * is gated the same way — unless it landed on a control, whose tap must
   * still work. */
  const trackMenuRow = (event: ReactPointerEvent<HTMLElement>) => {
    const row = transcriptMenuRow(event.target as HTMLElement)
    menuRow.current = row
    if (
      !row &&
      (event.pointerType === 'touch' || event.pointerType === 'pen') &&
      !(event.target as HTMLElement).closest('button, a, input, textarea, [role="button"]')
    ) {
      event.preventDefault()
    }
  }
  const menuTarget = menuOpen ? resolveTranscriptMenu(menuRow.current, displayTurns) : null
  const copyMenuText = (text: string) => {
    if (text) void navigator.clipboard?.writeText(text).catch(() => {})
  }
  // An opened subagent child is read-only: the same suppression `renderTurn`
  // applies to the hover rows applies to the menu.
  const menuEdit = state.subagentChild ? undefined : onEditMessage
  const menuRewind = state.subagentChild ? undefined : onRewindMessage
  const undoFiles = state.subagentChild ? undefined : onUndoFiles
  const menuResend = state.subagentChild ? undefined : onResend
  const menuFork = state.subagentChild ? undefined : onFork

  /** Every message boundary participates in the same transcript stack. */
  const renderTurn = (turn: ChatTurn) => {
    if (turn.key === hiddenUserKey) return null
    if (turn.role === 'user')
      return (
        <UserItem
          key={turn.key}
          message={turn.user}
          railId={turn.key}
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
        <RowReveal key={turn.key} animate={busy} rowKind="process" className={TRANSCRIPT_ROW_WIDTH}>
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
    // The scope's opening prompt anchors the checkpoint that covers every file
    // in the cumulative list (a steer reuses the same scope); `prompt` is null
    // when a compaction removed it, and the Undo action is simply absent.
    const undoTarget = changes?.prompt ?? null
    // Retry rewinds to the user message that opened this turn's exchange;
    // scanning stops at a summary (its user message may be compacted away).
    // Fork keeps everything up to the turn's last round.
    const retryFrom = retryFromFor(displayTurns, turn)
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
        liveProcess={isLast && compactionHosted ? compactionRow : null}
        retryFrom={retryFrom}
        continueFrom={continueFrom && turn.assistants.includes(continueFrom) ? continueFrom : undefined}
        onContinue={onContinue}
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
        onUndoFiles={undoFiles}
        undoTarget={undoTarget}
      />
    )
  }

  return (
    <BashTasksProvider sessionPath={state.sessionPath}>
      <ImageReplaysProvider sessionPath={state.sessionPath} disabled={busy || state.initializing || state.subagentChild || state.scheduledTaskSession || state.plan?.mode === 'plan' || state.sandboxMode === 'read-only'}>
      <SessionTasks jevState={state.jevWorkflow} key={state.sessionPath} todos={state.todos} subagents={state.subagents} askUserRecords={state.askUserRecords} busy={busy} sessionPath={state.sessionPath} onOpenSession={onOpenSession}
        goal={state.goal} goalSeq={state.goalSeq} goalAvailable={!!state.sessionPath && !state.subagentChild && !state.scheduledTaskSession} goalRestricted={state.plan?.mode === 'plan'} goalInitializing={state.initializing}
        goalUI={state.goalUI} onGoalDraft={draft => { if (state.sessionPath) store.setGoalDraft(state.sessionPath, draft) }}
        onGoalEnd={() => { if (state.sessionPath) void store.endGoalMode(state.sessionPath) }}
        onGoalState={(sessionPath, goal, goalSeq) => store.dispatch({ type: 'goal_update', sessionPath, goal, goalSeq })} />
      <ContextMenu open={menuOpen} onOpenChange={setMenuOpen}>
      <ContextMenuTrigger>
      <MessageScroller
      // The echoed prompt's pending run already paints a waiting row: the
      // transcript reports itself busy from that same commit (`aria-busy`).
      busy={busy}
      onContextMenuCapture={captureMenuRow}
      onPointerDownCapture={trackMenuRow}
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
      <PlanPresentationContext.Provider value={state.plan && state.sessionPath ? { state: state.plan, sessionPath: state.sessionPath, onRefine: onRefinePlan, onReviewExecution: reviewExecution } : null}>
      <SummaryDisclosureContext.Provider value={summaryDisclosures.current}>
      <MessageGroup data-transcript-rows>
        {displayTurns.flatMap((turn, index) => [index === recoveredIndex ? recoveryCard : null, renderTurn(turn)])}
        {recoveredIndex < 0 ? recoveryCard : null}

        {!compactionHosted ? compactionRow : null}

        {/* One waiting row, two owners: the announced run (`isStreaming`) or the
            echoed prompt whose run has not started yet. Keeping them in ONE
            slot means the handover reuses the mounted spinner instead of
            remounting it a frame later. */}
        {(state.isStreaming && !streaming && !waitingInLastTurn) || (awaitingRun && lastTurn?.role === 'user') ? (
          <TurnStatus seedKey={spinnerSeed} />
        ) : null}

        {state.notice && state.notice.key !== 'compacting' && state.notice.key !== 'compactFailed' && !failureHosted ? (
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
                    <RefreshCw className="size-3.5" />
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
      </SummaryDisclosureContext.Provider>
      </PlanPresentationContext.Provider>
    </MessageScroller>
    </ContextMenuTrigger>
    {/* One menu for the whole transcript; the row comes from the DOM marker
        resolved on the way in, so message rows stay untouched. */}
    <ContextMenuContent ariaLabel={t('chat.messageMenu')}>
      {menuTarget?.kind === 'user' ? (
        <>
          <ContextMenuItem
            disabled={!menuTarget.text}
            onSelect={() => copyMenuText(menuTarget.text)}
          >
            {t('chat.messageCopy')}
          </ContextMenuItem>
          {menuEdit ? (
            <ContextMenuItem onSelect={() => menuEdit(menuTarget.message)}>
              {t('chat.messageResend')}
            </ContextMenuItem>
          ) : null}
          {menuRewind ? (
            <ContextMenuItem onSelect={() => menuRewind(menuTarget.message)}>
              {t('rewind.title')}
            </ContextMenuItem>
          ) : null}
        </>
      ) : menuTarget?.kind === 'assistant' ? (
        <>
          <ContextMenuItem
            disabled={!menuTarget.copyText}
            onSelect={() => copyMenuText(menuTarget.copyText)}
          >
            {t('chat.copyReply')}
          </ContextMenuItem>
          {(menuTarget.retryFrom && menuResend) || (menuTarget.forkAt && menuFork) ? (
            <ContextMenuSeparator />
          ) : null}
          {menuTarget.retryFrom && menuResend ? (
            <ContextMenuItem onSelect={() => menuResend(menuTarget.retryFrom!)}>
              {t('chat.messageRetry')}
            </ContextMenuItem>
          ) : null}
          {menuTarget.forkAt && menuFork ? (
            <ContextMenuItem onSelect={() => menuFork(menuTarget.forkAt!)}>
              {t('chat.messageFork')}
            </ContextMenuItem>
          ) : null}
        </>
      ) : null}
    </ContextMenuContent>
    </ContextMenu>
      </ImageReplaysProvider>
    </BashTasksProvider>
  )
})
