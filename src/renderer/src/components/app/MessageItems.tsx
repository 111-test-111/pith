import { memo, useMemo, useState, type ReactNode } from 'react'
import { Brain, FileText, GitFork, History, Pencil, RotateCcw } from 'lucide-react'
import { AgentActivity } from '@/components/agents/agent-activity'
import { AgentDisclosure } from '@/components/agents/agent-disclosure'
import {
  Message,
  MessageBubble,
  MessageBubbleContent,
  MessageContent
} from '@/components/agents/message'
import { ToolResult, ToolResultOutput } from '@/components/agents/tool-result'
import { StreamingResponse } from '@/components/agents/streaming-response'
import { Markdown } from '@/lib/markdown'
import { cn } from '@/lib/utils'
import { ToolIcon } from '@/lib/tool-icons'
import { formatTime, formatTokenCount, basename } from '@/lib/format'
import { extractTurnWrittenFiles } from '@/lib/turn-written-files'
import { extractUserDisplay } from '@/lib/user-message'
import type {
  AssistantMsg,
  BashExecutionMsg,
  BranchSummaryMsg,
  CompactionSummaryMsg,
  CustomMsg,
  TextContent,
  ThinkingContent,
  ToolCallContent,
  ToolResultMsg,
  UserMsg
} from '../../../../shared/types'
import type { ToolRun } from '@/state/pi-store'
import { useI18n } from '@/i18n'
import { ToolCallView } from './ToolCallView'
import { Button } from '@/components/motion/button'
import { ReasoningText } from './ReasoningText'
import { RowReveal } from './RowReveal'
import { TurnStatus } from './TurnStatus'
import { TurnWrittenFiles } from './TurnWrittenFiles'
import { CopyAction, MessageAction, MessageActions } from './MessageActions'
import { PreviewThumb } from './ImagePreview'
import { LabelTooltip } from './LabelTooltip'

/** `anywhere` (unlike `break-words`) shrinks intrinsic min-content so long
 * unbroken strings wrap instead of widening the conversation column. */
const WRAP_ANYWHERE = '[overflow-wrap:anywhere]'

/** Hover-reveal for action rows that keep their layout slot (opacity, not
 * display) so the transcript doesn't shift when they appear. Mirrors
 * `MessageActions` and rides the enclosing beUI `Message` row's
 * `group/message`. */
const ACTIONS_HOVER =
  'opacity-0 transition-opacity group-hover/message:opacity-100 focus-within:opacity-100'

/** `railId` marks this row as a navigation-rail target (MessageScroller
 * resolves app-provided rail items through data-rail-id). */
export const UserItem = memo(function UserItem({
  message,
  railId,
  spaced,
  showActions = false,
  actionsAlwaysVisible = false,
  onEdit
}: {
  message: UserMsg
  railId?: string
  /** Extra space above the bubble so it clears the assistant turn's completion
   * action row above — deliberately larger than the normal turn spacing. */
  spaced?: boolean
  /** False while a run streams: editing rewinds the session, which the SDK
   * only allows when idle. */
  showActions?: boolean
  /** True only for the transcript's newest row: its actions stay visible
   * instead of being revealed on hover like every older message. */
  actionsAlwaysVisible?: boolean
  /** Opens the edit-and-resend dialog for this message. */
  onEdit?: (message: UserMsg) => void
}) {
  const { t } = useI18n()
  const { text, files, images } = extractUserDisplay(message.content)
  return (
    <Message
      from="user"
      animateIn={Boolean((message as any).__optimistic)}
      data-rail-id={railId}
      className={spaced ? 'mt-4' : undefined}
    >
      <MessageContent>
        {/* beUI's native gray bubble: `bg-muted` with `text-foreground`, so it
            stays a distinct gray in both light and dark mode and keeps the
            text legible (unlike solid's fixed black/white). */}
        <MessageBubble variant="soft">
          <MessageBubbleContent>
            {text ? <p className={`whitespace-pre-wrap ${WRAP_ANYWHERE}`}>{text}</p> : null}
            {files.length ? (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {files.map((path) => (
                  <LabelTooltip key={path} content={path} wrap>
                    <button
                      type="button"
                      onClick={() => void window.pi.openPath(path)}
                      className="inline-flex max-w-64 items-center gap-1.5 rounded-lg bg-background/60 px-2 py-1 text-xs text-foreground/90 transition-colors hover:bg-background"
                    >
                      <FileText className="size-3.5 shrink-0" />
                      <span className="truncate">{basename(path)}</span>
                    </button>
                  </LabelTooltip>
                ))}
              </div>
            ) : null}
            {images.length ? (
              <div className="mt-2 flex flex-wrap gap-2">
                {images.map((image, index) => (
                  <PreviewThumb
                    key={index}
                    src={`data:${image.mimeType};base64,${image.data}`}
                    alt={t('imagePreview.attachment', { index: index + 1 })}
                    className="max-w-64 rounded-lg"
                    imageClassName="max-h-44 w-auto max-w-full object-cover"
                  />
                ))}
              </div>
            ) : null}
          </MessageBubbleContent>
        </MessageBubble>
        {showActions ? (
          <MessageActions alwaysVisible={actionsAlwaysVisible}>
            {text ? <CopyAction text={text} /> : null}
            {onEdit ? (
              <MessageAction label={t('chat.messageResend')} onClick={() => onEdit(message)}>
                <Pencil className="size-3.5" />
              </MessageAction>
            ) : null}
          </MessageActions>
        ) : null}
      </MessageContent>
    </Message>
  )
})

/**
 * A compaction or branch summary: the SDK replaces the summarized history (or
 * an abandoned branch) with this entry, so the row explains why earlier
 * messages are gone and lets the user read the summary itself.
 */
export const SummaryItem = memo(function SummaryItem({
  message
}: {
  message: CompactionSummaryMsg | BranchSummaryMsg
}) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const branch = message.role === 'branchSummary'
  const tokensBefore = message.role === 'compactionSummary' ? message.tokensBefore : 0
  return (
    <div className="rounded-xl border border-dashed border-border bg-muted/30 px-3 py-2">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <History aria-hidden="true" className="size-3.5 shrink-0" />
        <span className="font-medium text-foreground">
          {branch ? t('chat.summaryBranchTitle') : t('chat.summaryTitle')}
        </span>
        {tokensBefore > 0 ? (
          <span className="tabular-nums">
            {t('chat.summaryTokensBefore', { tokens: formatTokenCount(tokensBefore) })}
          </span>
        ) : null}
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto px-2"
          onClick={() => setOpen((value) => !value)}
        >
          {open ? t('chat.summaryHide') : t('chat.summaryShow')}
        </Button>
      </div>
      {open ? (
        <div className="mt-2 max-h-80 overflow-y-auto text-xs leading-5 text-muted-foreground">
          <Markdown>{message.summary}</Markdown>
        </div>
      ) : null}
    </div>
  )
})

/**
 * A user shell command recorded in the transcript (`!cmd` in the pi CLI, or an
 * extension-driven executeBash). Uses the same terminal surface as the bash
 * tool so live output and history read alike.
 */
export const BashItem = memo(function BashItem({ message }: { message: BashExecutionMsg }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const status = message.cancelled ? 'cancelled' : (message.exitCode ?? 0) !== 0 ? 'error' : 'success'
  const meta = [
    message.cancelled
      ? t('chat.bashCancelled')
      : message.exitCode !== undefined
        ? t('chat.bashExitCode', { code: message.exitCode })
        : '',
    message.truncated ? t('chat.bashTruncated') : ''
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <ToolResult
      animateChanges={false}
      lazyContent
      open={open}
      onOpenChange={setOpen}
      title={`$ ${message.command}`}
      status={status}
      icon={<ToolIcon name="bash" />}
      meta={meta || undefined}
      copyText={message.output || message.command}
      defaultOpen={false}
      collapseOnComplete={false}
      contentClassName={WRAP_ANYWHERE}
    >
      <ToolResultOutput language="text" highlight={false}>
        {message.output || t('tool.noOutput')}
      </ToolResultOutput>
    </ToolResult>
  )
})

/** An extension-injected message that opted into display. */
export const CustomItem = memo(function CustomItem({ message }: { message: CustomMsg }) {
  const { t } = useI18n()
  const { text, images } = extractUserDisplay(message.content)
  return (
    <div className="rounded-xl border border-border bg-card px-3 py-2">
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {t('chat.customMessage', { type: message.customType })}
      </p>
      {text ? (
        <div className={`mt-1 text-sm text-foreground ${WRAP_ANYWHERE}`}>
          <Markdown>{text}</Markdown>
        </div>
      ) : null}
      {images.length ? (
        <div className="mt-2 flex flex-wrap gap-2">
          {images.map((image, index) => (
            <PreviewThumb
              key={index}
              src={`data:${image.mimeType};base64,${image.data}`}
              alt={t('imagePreview.attachment', { index: index + 1 })}
              className="max-w-64 rounded-lg"
              imageClassName="max-h-44 w-auto max-w-full object-cover"
            />
          ))}
        </div>
      ) : null}
    </div>
  )
})

interface ToolContext {
  toolResults: Map<string, ToolResultMsg>
  toolRuns: Record<string, ToolRun>
}
interface AssistantPartsProps extends ToolContext {
  message: AssistantMsg
  streaming: boolean
  /** False for phase text that is followed by more rounds of the same turn —
   * only the turn's final summary gets the copy/feedback actions. */
  showActions: boolean
  /** True for the transcript's newest turn: its completion-actions row (icons
   * + timestamp) stays visible instead of revealing on hover. */
  actionsAlwaysVisible: boolean
  /** Timestamp of the turn's first round, shown beside the action icons. */
  turnTimestamp: number
  /** The user message that opened the turn — retry target. Rendered as extra
   * cells of the final text round's completion-actions row so retry/fork share
   * one line with copy/feedback and the timestamp stays rightmost. */
  retryFrom?: UserMsg
  /** The turn's last round — fork point. */
  forkAt?: AssistantMsg
  onResend?: (message: UserMsg) => void
  onFork?: (message: AssistantMsg) => void
  /** Turn-level content shown between the answer and the completion-actions row
   * (the files this turn wrote); only the round that renders that row gets it. */
  footer?: ReactNode
  /** Session working directory, used to render each tool call's target path. */
  cwd?: string | null
}

type AssistantBlock =
  | { kind: 'thinking'; parts: ThinkingContent[] }
  | { kind: 'text'; parts: TextContent[] }
  | { kind: 'tool'; parts: ToolCallContent[] }

/**
 * Groups a message's content into consecutive same-kind blocks, preserving the
 * model's actual output order. GPT-family models emit phase text BEFORE the tool
 * calls it introduces in the same assistant message; a fixed
 * thinking -> tools -> text order rendered those tools above their own text.
 */
function groupContent(content: AssistantMsg['content']): AssistantBlock[] {
  const blocks: AssistantBlock[] = []
  for (const part of content) {
    if (part.type === 'thinking') {
      const last = blocks[blocks.length - 1]
      if (last?.kind === 'thinking') last.parts.push(part)
      else blocks.push({ kind: 'thinking', parts: [part] })
    } else if (part.type === 'text') {
      const last = blocks[blocks.length - 1]
      if (last?.kind === 'text') last.parts.push(part)
      else blocks.push({ kind: 'text', parts: [part] })
    } else {
      const last = blocks[blocks.length - 1]
      if (last?.kind === 'tool') last.parts.push(part)
      else blocks.push({ kind: 'tool', parts: [part] })
    }
  }
  return blocks
}

/** One assistant model round (thinking + tool calls + text) inside a merged group. */
const AssistantParts = memo(function AssistantParts({
  message,
  streaming,
  showActions,
  actionsAlwaysVisible,
  turnTimestamp,
  retryFrom,
  forkAt,
  onResend,
  onFork,
  footer,
  cwd,
  toolResults,
  toolRuns,
}: AssistantPartsProps) {
  const { t } = useI18n()
  const blocks = groupContent(message.content)
  const hasContent = blocks.length > 0

  // Retry/fork ride in the completion-actions row of the turn's final text
  // block (rendered only when `showActions`, i.e. the turn is idle and this is
  // the last round). Rounds that end on a tool call render no such row — the
  // group falls back to a standalone row for those.
  const retryForkActions =
    showActions && (retryFrom || forkAt) ? (
      <>
        {onResend && retryFrom ? (
          <MessageAction label={t('chat.messageRetry')} onClick={() => onResend(retryFrom)}>
            <RotateCcw className="size-3.5" />
          </MessageAction>
        ) : null}
        {onFork && forkAt ? (
          <MessageAction label={t('chat.messageFork')} onClick={() => onFork(forkAt)}>
            <GitFork className="size-3.5" />
          </MessageAction>
        ) : null}
      </>
    ) : null

  if (!hasContent && !streaming && !message.errorMessage) return null

  return (
    <>
      {blocks.map((block, index) => {
        if (block.kind === 'thinking') {
          // Render from the first delta. The old guard hid the block until the
          // round completed, so a round whose reasoning led into a tool call
          // only revealed its Reasoning row AFTER the tool call appeared. The
          // disclosure stays collapsed by default, so the growing text is cheap
          // and the user can expand it live.
          return (
            <RowReveal key={`thinking-${index}`} animate={streaming} className="w-full">
              <AgentActivity
                status="complete"
                summary={
                  // Same leading-icon shape as a tool row, so the Reasoning row
                  // scans like the tool calls under it.
                  <span className="inline-flex items-center gap-2">
                    <Brain aria-hidden="true" className="size-4 shrink-0" />
                    {t('chat.reasoning')}
                  </span>
                }
                defaultOpen={false}
                collapseOnComplete={false}
                contentClassName={WRAP_ANYWHERE}
                items={block.parts.map((part, partIndex) => ({
                  id: `think-${index}-${partIndex}`,
                  type: 'text' as const,
                  content: <ReasoningText text={part.thinking || '(redacted)'} />,
                }))}
              />
            </RowReveal>
          )
        }

        if (block.kind === 'tool') {
          return (
            <div key={`tool-${index}`} className="w-full space-y-2">
              {block.parts.map((call) => (
                <RowReveal key={call.id} animate={streaming}>
                  <ToolCallView
                    call={call}
                    result={toolResults.get(call.id)}
                    run={toolRuns[call.id]}
                    cwd={cwd}
                  />
                </RowReveal>
              ))}
            </div>
          )
        }

        const text = block.parts.map((part) => part.text).join('\n\n')
        if (!text) return null
        const isFinalBlock = index === blocks.length - 1
        return (
          <MessageBubble key={`text-${index}`} variant="ghost" className="w-full">
            <MessageBubbleContent>
              <StreamingResponse
                status={streaming ? 'streaming' : 'complete'}
                copyText={text}
                showActions={!streaming && showActions && isFinalBlock}
                footer={!streaming && showActions && isFinalBlock ? footer : undefined}
                actions={
                  !streaming && index === blocks.length - 1 ? retryForkActions : undefined
                }
                // The completion row is always painted into the layout; older
                // turns keep it at opacity 0 until their row is hovered, so
                // only the newest turn's icons + timestamp read as permanent
                // chrome.
                actionsClassName={actionsAlwaysVisible ? undefined : ACTIONS_HOVER}
                meta={showActions ? formatTime(turnTimestamp) : undefined}
              >
                <Markdown streaming={streaming}>{text}</Markdown>
              </StreamingResponse>
            </MessageBubbleContent>
          </MessageBubble>
        )
      })}

      {message.errorMessage ? (
        // Reuses the reasoning disclosure (beUI AgentActivity): a collapsed row
        // that expands to the raw provider/SDK error instead of dumping a red
        // box into the transcript.
        <RowReveal animate={streaming} className="w-full">
          <AgentActivity
            status="complete"
            summary={<span className="text-destructive">{t('chat.error')}</span>}
            defaultOpen={false}
            collapseOnComplete={false}
            contentClassName={WRAP_ANYWHERE}
            items={[
              {
                id: 'error',
                type: 'text' as const,
                content: (
                  <span className="text-destructive">
                    {message.errorMessage}
                    {message.stopReason === 'aborted' ? t('chat.aborted') : ''}
                  </span>
                ),
              },
            ]}
          />
        </RowReveal>
      ) : null}
    </>
  )
}, assistantPartsPropsEqual)

function assistantPartsPropsEqual(prev: AssistantPartsProps, next: AssistantPartsProps): boolean {
  if (
    prev.message !== next.message ||
    prev.streaming !== next.streaming ||
    prev.showActions !== next.showActions ||
    prev.actionsAlwaysVisible !== next.actionsAlwaysVisible ||
    prev.cwd !== next.cwd ||
    prev.turnTimestamp !== next.turnTimestamp ||
    prev.retryFrom !== next.retryFrom ||
    prev.forkAt !== next.forkAt ||
    prev.footer !== next.footer ||
    prev.onResend !== next.onResend ||
    prev.onFork !== next.onFork ||
    prev.toolResults !== next.toolResults
  ) {
    return false
  }
  if (prev.toolRuns === next.toolRuns) return true
  for (const part of prev.message.content) {
    if (part.type === 'toolCall' && prev.toolRuns[part.id] !== next.toolRuns[part.id]) return false
  }
  return true
}

export interface AssistantGroupProps extends ToolContext {
  /** Consecutive assistant rounds of one turn, oldest first. */
  messages: AssistantMsg[]
  /** Index of the live streaming round inside `messages`; -1 when idle. */
  streamingIndex: number
  /** True while the turn is between rounds (tools running, no partial message
   * yet): the group keeps its bottom spinner lit even without a live round. */
  pending?: boolean
  /** The user message that started this turn — the retry target. Data (not a
   * closure) so the group's memo survives streaming re-renders. */
  retryFrom?: UserMsg
  /** Identifying round for "fork here" (the turn's last message). */
  forkAt?: AssistantMsg
  onResend?: (message: UserMsg) => void
  onFork?: (message: AssistantMsg) => void
  /** False while a run streams: retry rewinds the session (SDK requires idle)
   * and fork switches the active session mid-observation. */
  showActions?: boolean
  /** True only for the transcript's newest turn: its completion-actions row
   * (icons + timestamp) stays visible instead of revealing on hover. */
  actionsAlwaysVisible?: boolean
  /** Session working directory, used to resolve the turn's written files. */
  cwd?: string | null
  /** Opens the review tab on this turn (its first assistant message id). */
  onReview?: (turnId: number) => void
}

/**
 * memo comparator for AssistantGroup: a new `toolRuns` record identity (every
 * tool_execution_update creates one) must not re-render the group unless one
 * of the tool calls THIS group renders actually changed.
 */
function assistantGroupPropsEqual(prev: AssistantGroupProps, next: AssistantGroupProps): boolean {
  if (
    prev.messages !== next.messages ||
    prev.streamingIndex !== next.streamingIndex ||
    prev.pending !== next.pending ||
    prev.toolResults !== next.toolResults ||
    prev.cwd !== next.cwd ||
    prev.retryFrom !== next.retryFrom ||
    prev.forkAt !== next.forkAt ||
    prev.onResend !== next.onResend ||
    prev.onFork !== next.onFork ||
    prev.showActions !== next.showActions ||
    prev.actionsAlwaysVisible !== next.actionsAlwaysVisible ||
    prev.onReview !== next.onReview
  ) {
    return false
  }
  if (prev.toolRuns === next.toolRuns) return true
  for (const message of prev.messages) {
    for (const part of message.content) {
      if (part.type === 'toolCall' && prev.toolRuns[part.id] !== next.toolRuns[part.id]) {
        return false
      }
    }
  }
  return true
}

const ASSISTANT_ROUND_PAGE = 8

/** Index of the last round that produced prose — the turn's final reply. */
function lastTextRoundIndex(messages: AssistantMsg[]): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].content.some((part) => part.type === 'text' && part.text.trim())) return index
  }
  return -1
}

/**
 * How many transcript rows a set of rounds renders once expanded: one per
 * thinking/text block and one per tool call. The fold's "show earlier" count
 * uses this so the number matches what expanding actually reveals (a round can
 * hold several reasoning/tool rows).
 */
function stepCount(messages: AssistantMsg[]): number {
  let count = 0
  for (const message of messages) {
    for (const block of groupContent(message.content)) {
      if (block.kind === 'tool') count += block.parts.length
      // An all-blank text block renders nothing (AssistantParts bails on it).
      else if (block.kind === 'text') count += block.parts.some((part) => part.text.trim()) ? 1 : 0
      else count += 1
    }
    if (message.errorMessage) count += 1
  }
  return count
}

/**
 * A whole assistant turn as one message row: each model round's parts in order,
 * a single timestamp beside the completion actions, and — while it is the live
 * turn — one spinner. A turn with many rounds folds the earlier steps, but its
 * final reply text and newest rounds always stay visible.
 */
export const AssistantGroup = memo(function AssistantGroup({
  messages,
  streamingIndex,
  pending = false,
  retryFrom,
  forkAt,
  onResend,
  onFork,
  showActions = false,
  actionsAlwaysVisible = false,
  cwd,
  onReview,
  toolResults,
  toolRuns
}: AssistantGroupProps) {
  const { t } = useI18n()
  const [roundsOpen, setRoundsOpen] = useState(false)
  const [roundWindow] = useState(ASSISTANT_ROUND_PAGE)
  const live = streamingIndex >= 0 || pending
  const windowStart = Math.max(0, messages.length - roundWindow)
  // Pull the window back far enough to include the final reply: a turn that
  // ends on tool rounds must not hide the answer it produced mid-turn.
  const answerRound = lastTextRoundIndex(messages)
  const firstVisibleRound = answerRound >= 0 ? Math.min(windowStart, answerRound) : windowStart
  const visibleMessages = messages.slice(firstVisibleRound)
  const hiddenMessages = messages.slice(0, firstVisibleRound)
  const visibleStreamingIndex =
    streamingIndex >= firstVisibleRound ? streamingIndex - firstVisibleRound : -1
  const hiddenStepCount = stepCount(hiddenMessages)
  const turnTimestamp = messages[0].timestamp
  const hasParts = live || messages.some((message) => message.content.length > 0 || message.errorMessage)
  // Copy/feedback actions (and the turn timestamp beside them) belong to the
  // turn's final prose only: phase text that precedes tool calls must stay
  // chrome-free, and an unfinished tool round has no completed answer to act
  // on. Rounds are windowed, so compare against the visible tail instead of
  // absolute indices.
  const lastRound = messages[messages.length - 1]
  // The completion-actions row (and the retry/fork cells that ride in it) is
  // actually painted only when the round's LAST content block is prose — a
  // round that ends on a tool call renders no row, so it needs the standalone
  // fallback below.
  const lastRoundBlocks = groupContent(lastRound?.content ?? [])
  const lastBlock = lastRoundBlocks[lastRoundBlocks.length - 1]
  const lastRoundHasText = Boolean(
    lastBlock?.kind === 'text' &&
      lastBlock.parts.some((part) => (part.text ?? '').trim().length > 0)
  )
  // A turn that did not finish cleanly (user pressed Stop → stopReason
  // 'aborted', or the stream died → 'error') has no completed answer to act on:
  // suppress the copy/feedback/timestamp row and fall back to a bare retry/fork
  // row, which is rendered after the error disclosure — i.e. at the very
  // bottom of the turn.
  const incomplete =
    lastRound?.stopReason === 'aborted' ||
    lastRound?.stopReason === 'error' ||
    Boolean(lastRound?.errorMessage)
  const showTurnActions = !live && lastRoundHasText && !incomplete
  /**
   * The files this turn wrote, derived here rather than passed in: the group's
   * memo already keeps untouched turns out of the render path, so only the turn
   * that changed pays for the extraction (and the per-result patch cache in
   * `turn-written-files` keeps repeat work off the streaming path).
   */
  const writtenFiles = useMemo(
    () => extractTurnWrittenFiles(messages, toolResults, cwd),
    [messages, toolResults, cwd]
  )
  /**
   * The list belongs between the answer and the completion-actions row, so it
   * rides in that row's `footer` slot whenever the turn renders one. A turn that
   * ends on tools, or was stopped/errored, has no such row — there it stays a
   * plain row above the standalone retry/fork fallback.
   *
   * Either way it only appears once THIS turn stopped writing: `live` is the
   * turn's own flag, not the session's `busy`, so a run in progress shows nothing
   * (no half-written file set) while an earlier, settled turn keeps its list even
   * as the next turn streams. Every ending — completed, stopped, errored —
   * reveals it.
   */
  const writtenFilesNode =
    !live && writtenFiles.length > 0 ? (
      <TurnWrittenFiles
        files={writtenFiles}
        onReview={onReview ? () => onReview(messages[0].timestamp) : undefined}
      />
    ) : null
  const writtenFilesInFooter = showTurnActions && Boolean(writtenFilesNode)

  if (!hasParts) return null

  return (
    // No `animateIn`: the pop is an underdamped spring (it overshoots and
    // wobbles the whole turn), and an assistant turn fills with content while
    // it streams, so the wobble lands on a large block and reads as jitter.
    // The rise-from-the-live-edge entrance stays with sent user messages.
    <Message from="assistant">
      <MessageContent className="gap-3">
        {hiddenStepCount > 0 ? (
          // Trigger + a bare disclosure. The earlier rounds are rendered as a
          // plain `flex flex-col gap-3` (the same container `MessageContent`
          // uses) instead of through AgentActivity's item/TextRow pipeline:
          // that pipeline injected its own vertical padding and typography, so
          // the folded rows sat at a different spacing than the rest of the
          // transcript. Only the disclosure animates.
          <>
            <AgentActivity
              status="complete"
              summary={<span className="text-primary">{t(roundsOpen ? 'chat.hideEarlier' : 'chat.showEarlier', { count: hiddenStepCount })}</span>}
              open={roundsOpen}
              onOpenChange={setRoundsOpen}
              collapseOnComplete={false}
              items={[]}
              // The trigger renders no items; zero the empty list's padding so
              // the only space between it and the rounds below is the flex gap.
              contentClassName="py-0"
              // The fold reads as a section header: its first row sits a little
              // further below the trigger (16px) than body rows sit from each
              // other (12px), identically whether the fold is open or closed.
              className="mb-1"
            />
            <AgentDisclosure
              open={roundsOpen}
              // Closed, the (zero-height) body must leave the flex flow — else
              // it adds its own flex gap and the collapsed spacing would be
              // 8px larger than the expanded one.
              className={cn('w-full', !roundsOpen && 'hidden')}
            >
              <div className="flex flex-col gap-3">
                {hiddenMessages.map((message, index) => (
                  <AssistantParts
                    key={`${message.timestamp}-h${index}`}
                    message={message}
                    streaming={false}
                    showActions={false}
                    actionsAlwaysVisible={false}
                    turnTimestamp={turnTimestamp}
                    cwd={cwd}
                    toolResults={toolResults}
                    toolRuns={toolRuns}
                  />
                ))}
              </div>
            </AgentDisclosure>
          </>
        ) : null}

        {visibleMessages.map((message, index) => (
          <AssistantParts
            key={`${message.timestamp}-${firstVisibleRound + index}`}
            message={message}
            streaming={index === visibleStreamingIndex}
            showActions={showTurnActions && index === visibleMessages.length - 1}
            actionsAlwaysVisible={actionsAlwaysVisible}
            retryFrom={retryFrom}
            forkAt={forkAt}
            onResend={onResend}
            onFork={onFork}
            footer={
              writtenFilesInFooter && index === visibleMessages.length - 1
                ? writtenFilesNode
                : undefined
            }
            turnTimestamp={turnTimestamp}
            cwd={cwd}
            toolResults={toolResults}
            toolRuns={toolRuns}
          />
        ))}

        {live ? <TurnStatus /> : null}

        {writtenFilesNode && !writtenFilesInFooter ? writtenFilesNode : null}

        {/* Retry/fork normally live inside the final text round's completion
            actions row (so they share a line with copy/feedback and the
            timestamp stays rightmost). A turn that ended on tools or an error
            renders no such row, so keep the standalone actions row for it. */}
        {!live && showActions && !showTurnActions && (retryFrom || forkAt) ? (
          // No completion row to host them (turn ended on tools, or was stopped
          // / errored): show a visible retry/fork row after the error
          // disclosure — the very bottom of the turn.
          <MessageActions alwaysVisible={actionsAlwaysVisible}>
            {onResend && retryFrom ? (
              <MessageAction label={t('chat.messageRetry')} onClick={() => onResend(retryFrom)}>
                <RotateCcw className="size-3.5" />
              </MessageAction>
            ) : null}
            {onFork && forkAt ? (
              <MessageAction label={t('chat.messageFork')} onClick={() => onFork(forkAt)}>
                <GitFork className="size-3.5" />
              </MessageAction>
            ) : null}
          </MessageActions>
        ) : null}
      </MessageContent>
    </Message>
  )
}, assistantGroupPropsEqual)
