import { BashTaskRow } from './BashTaskView'
import { SubagentCompletionRow, SubagentMessageRow, subagentMessageDetailsOf } from './SubagentView'
import {
  Fragment,
  memo,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'
import { Brain, ChevronDown, FileText, GitFork, Pencil, RefreshCw, Rewind } from '@/lib/icons'
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
import { SummaryRow } from './SummaryRow'
import { useFileNavigation } from '@/lib/file-navigation'
import { ACTIVITY_BODY_INDENT, TRANSCRIPT_ROW, TRANSCRIPT_ROW_TRIGGER, TRANSCRIPT_ROW_WIDTH } from '@/lib/transcript-rhythm'
import { cn } from '@/lib/utils'
import { ToolIcon } from '@/lib/tool-icons'
import { formatTime, formatTokenCount, basename } from '@/lib/format'
import { extractTurnWrittenFiles } from '@/lib/turn-written-files'
import type { TurnNotice } from '@/lib/chat-turns'
import { extractUserDisplay } from '@/lib/user-message'
import type {
  AssistantMsg,
  BashTaskDTO,
  BashExecutionMsg,
  BranchSummaryMsg,
  CompactionSummaryMsg,
  CustomMsg,
  SubagentRunDTO,
  ToolResultMsg,
  UserMsg
} from '../../../../shared/types'
import type { ToolRun } from '@/state/pi-store'
import { splitByToolCategory } from '@/lib/tool-categories'
import {
  buildToolPlan,
  groupContent,
  planRowCount,
  sameToolPlan,
  textBlockRenders,
  textRendersRow,
  toolPlanKey,
  type ToolPlan
} from '@/lib/tool-runs'
import { useI18n } from '@/i18n'
import type { MessageKey } from '@/i18n/locales/en'
import { useShowReasoning } from '@/lib/show-reasoning'
import { useToolGrouping } from '@/lib/tool-grouping'
import { frontierStepContext, frontierWaitingOnUser } from '@/lib/spinner-verbs'
import { ToolCallView } from './ToolCallView'
import { ToolGroupView } from './ToolGroupView'
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

/** The i18n translate function, so module-level label helpers (a turn's
 * elapsed time) can compose localized text without re-rendering. */
type Translate = (key: MessageKey, params?: Record<string, string | number>) => string

/** Hover-reveal for action rows that keep their layout slot (opacity, not
 * display) so the transcript doesn't shift when they appear. Mirrors
 * `MessageActions` and rides the enclosing beUI `Message` row's
 * `group/message`. */
const ACTIONS_HOVER =
  'opacity-0 transition-opacity group-hover/message:opacity-100 focus-within:opacity-100'

/** Collapsed height of a user bubble body: ten 24px body lines
 * (`text-sm/leading-6`). Long pastes are cut here and offered an expand
 * toggle instead of pushing the whole transcript down. */
const USER_BUBBLE_MAX_REM = 10 * 1.5

/**
 * Clamps a user bubble body to {@link USER_BUBBLE_MAX_REM} and — only when the
 * body is actually taller than that — offers the expand toggle. The measured
 * element is the inner one: the clamp caps the wrapper, so the verdict cannot
 * flip when expanding removes the cap and hide the control the user just used.
 * A layout effect puts the clamp and its toggle into the first painted frame,
 * so a long message never flashes at full height.
 */
function UserBubbleBody({ children }: { children: ReactNode }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [overflowing, setOverflowing] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)
  const bodyId = useId()

  useLayoutEffect(() => {
    const node = bodyRef.current
    if (!node) return
    const update = () => {
      const rootFont = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
      setOverflowing(node.getBoundingClientRect().height > USER_BUBBLE_MAX_REM * rootFont + 1)
    }
    update()
    // Watching the inner element (not the clamped wrapper, whose box stops
    // changing once capped) also catches re-wraps, images decoding and font
    // swaps, all of which move the natural height only.
    const observer = new ResizeObserver(update)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  const collapsed = overflowing && !open
  return (
    <>
      <div
        id={bodyId}
        data-user-bubble-body
        data-collapsed={collapsed ? 'true' : undefined}
        className={
          collapsed
            ? 'overflow-hidden [mask-image:linear-gradient(to_bottom,#000_82%,transparent_100%)]'
            : undefined
        }
        style={collapsed ? { maxHeight: `${USER_BUBBLE_MAX_REM}rem` } : undefined}
      >
        <div ref={bodyRef}>{children}</div>
      </div>
      {overflowing ? (
        <Button
          variant="ghost"
          size="sm"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((value) => !value)}
          className="mt-1 px-2"
        >
          {open ? t('chat.messageCollapse') : t('chat.messageExpand')}
          <ChevronDown
            aria-hidden="true"
            className={cn('size-3.5 transition-transform', open && 'rotate-180')}
          />
        </Button>
      ) : null}
    </>
  )
}

/** `railId` marks this row as a navigation-rail target (MessageScroller
 * resolves app-provided rail items through data-rail-id). */
export const UserItem = memo(function UserItem({
  message,
  railId,
  spaced,
  showActions = false,
  actionsAlwaysVisible = false,
  onEdit,
  onRewind
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
  onRewind?: (message: UserMsg) => void
}) {
  const { t } = useI18n()
  const { text, files, images } = extractUserDisplay(message.content)
  const fileNavigation = useFileNavigation()
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
            <UserBubbleBody>
              {text ? <p className={`whitespace-pre-wrap ${WRAP_ANYWHERE}`}>{text}</p> : null}
              {files.length ? (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {files.map((path) => (
                    <LabelTooltip key={path} content={path} wrap>
                      <Button
                        variant="ghost" size="sm"
                        onClick={() => fileNavigation.openPath(path)}
                        className="inline-flex max-w-64 items-center gap-1.5 rounded-lg bg-background/60 px-2 py-1 text-xs text-foreground/90 transition-colors hover:bg-background"
                      >
                        <FileText className="size-3.5 shrink-0" />
                        <span className="truncate">{basename(path)}</span>
                      </Button>
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
            </UserBubbleBody>
          </MessageBubbleContent>
        </MessageBubble>
        {showActions ? (
          <MessageActions alwaysVisible={actionsAlwaysVisible}>
            {text ? <CopyAction text={text} /> : null}
            {onRewind ? <MessageAction label={t('rewind.title')} onClick={() => onRewind(message)}><Rewind className="size-3.5" /></MessageAction> : null}
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
 * an abandoned branch) with this entry, so the sentence explains why earlier
 * messages are gone and the expansion is the summary itself. Rendered as a tool
 * row — see `SummaryRow` for why.
 */
export const SummaryItem = memo(function SummaryItem({
  message
}: {
  message: CompactionSummaryMsg | BranchSummaryMsg
}) {
  return message.role === 'compactionSummary' ? (
    <SummaryRow
      kind="compaction"
      status="success"
      summary={message.summary}
      tokensBefore={message.tokensBefore}
    />
  ) : (
    <SummaryRow kind="branch" status="success" summary={message.summary} />
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
  const task = (message.details as { bashTask?: BashTaskDTO } | undefined)?.bashTask
  if (message.customType === 'bash_task_completion' && task) return <BashTaskRow task={task} completion />
  const subagent = (message.details as { subagent?: SubagentRunDTO } | undefined)?.subagent
  if (message.customType === 'subagent_completion' && subagent) return <SubagentCompletionRow run={subagent} />
  // A running subagent's message to its parent: the same quiet tool-row
  // treatment a completion notice gets — it is steering data the model
  // consumed, not a conversation card.
  if (message.customType === 'subagent_message') {
    const fromSubagent = subagentMessageDetailsOf(message.details)
    if (fromSubagent) return <SubagentMessageRow details={fromSubagent} />
  }
  // An async question's outcome is tool data for the model: it stays out of the
  // transcript — the Q&A record panel is where the user reads it.
  if (message.customType === 'ask_user_answer') return null
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
  /** Absolute index of this message within the turn — plan key prefix. */
  messageIndex: number
  /** Cross-message tool-run plan shared by every round of the turn. */
  toolPlan: ToolPlan
  /** First/last block of this round to paint. A settled turn folds the blocks
   * before its reply into the fold, so the round holding the reply renders as
   * two halves: its process blocks inside the fold, the reply below it. Block
   * indices stay absolute, so `toolPlan` lookups are unaffected. */
  blocksFrom?: number
  blocksTo?: number
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
  messageIndex,
  toolPlan,
  blocksFrom,
  blocksTo,
  toolResults,
  toolRuns,
}: AssistantPartsProps) {
  const { t } = useI18n()
  // Settings → General: reasoning blocks can be hidden entirely. The hook makes
  // this memoized round re-render on its own when the preference flips.
  const [showReasoning] = useShowReasoning()
  const blocks = groupContent(message.content)
  const hasContent = blocks.length > 0
  const from = blocksFrom ?? 0
  const to = blocksTo ?? blocks.length
  // Only the instance that owns the round's tail paints its error disclosure
  // and its completion row; a folded half of the same round must not repeat
  // them (the row belongs at the very bottom of the turn).
  const ownsTail = to >= blocks.length

  // Retry/fork ride in the completion-actions row of the turn's final text
  // block (rendered only when `showActions`, i.e. the turn is idle and this is
  // the last round). Rounds that end on a tool call render no such row — the
  // group falls back to a standalone row for those.
  const retryForkActions =
    showActions && (retryFrom || forkAt) ? (
      <>
        {onResend && retryFrom ? (
          <MessageAction label={t('chat.messageRetry')} onClick={() => onResend(retryFrom)}>
            <RefreshCw className="size-3.5" />
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
      {blocks.slice(from, to).map((block, offset) => {
        // Absolute block index: plan keys and "is this the round's last block"
        // are both about the whole round, not about the rendered slice.
        const index = from + offset
        if (block.kind === 'thinking') {
          // Hidden from Settings → General: the round keeps its tool/text rows,
          // and `buildToolPlan` treats the block as painting nothing.
          if (!showReasoning) return null
          // Render from the first delta. The old guard hid the block until the
          // round completed, so a round whose reasoning led into a tool call
          // only revealed its Reasoning row AFTER the tool call appeared. The
          // disclosure stays collapsed by default, so the growing text is cheap
          // and the user can expand it live.
          return (
            <RowReveal key={`thinking-${index}`} animate={streaming} className="w-full">
              <AgentActivity
                status="complete"
                // One row height for the whole transcript (see TRANSCRIPT_ROW):
                // the row is the same box as a tool row and centres its own
                // content, so the space between two rows' text is identical
                // whichever pair of rows you look at. The trigger takes that
                // box itself, so opening the reasoning cannot re-centre it.
                className={TRANSCRIPT_ROW_TRIGGER}
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
                // The body starts where the row's own "Reasoning" label does,
                // like a tool row's expanded output (see ACTIVITY_BODY_INDENT).
                contentClassName={cn(WRAP_ANYWHERE, ACTIVITY_BODY_INDENT)}
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
          // The turn-wide plan merges adjacent tool blocks across rounds. A
          // block that continues a run an earlier block already rendered stays
          // out of the DOM entirely.
          const planRows = toolPlan.get(toolPlanKey(messageIndex, index))
          if (planRows === null) return null
          const rows = planRows ?? splitByToolCategory(block.parts)
          return (
            <Fragment key={`tool-${index}`}>
              {/* Adjacent same-category calls fold into one row; everything
                  else (including a lone categorized call) keeps its own row,
                  so reasoning or a different category between two calls never
                  merges them.

                  Deliberately a Fragment, with no wrapper box: every row of a
                  turn is a flex item of the group's own column, so the gap
                  between two rows is the same 12px whether they are tool rows,
                  a group row, a reasoning row or the waiting row. A block-local
                  wrapper (this used to be `space-y-2`) put sibling rows of one
                  round on a tighter 8px rhythm than rows of two rounds — the
                  "spacing suddenly changed" the transcript must not have. */}
              {rows.flatMap((run) =>
                run.category && run.items.length > 1 ? (
                  <RowReveal key={run.items[0].id} animate={streaming} className={TRANSCRIPT_ROW_WIDTH}>
                    <ToolGroupView
                      category={run.category}
                      calls={run.items}
                      toolResults={toolResults}
                      toolRuns={toolRuns}
                      cwd={cwd}
                    />
                  </RowReveal>
                ) : (
                  run.items.map((call) => (
                    <RowReveal key={call.id} animate={streaming} className={TRANSCRIPT_ROW_WIDTH}>
                      <ToolCallView
                        call={call}
                        result={toolResults.get(call.id)}
                        run={toolRuns[call.id]}
                        cwd={cwd}
                      />
                    </RowReveal>
                  ))
                )
              )}
            </Fragment>
          )
        }

        const text = block.parts.map((part) => part.text).join('\n\n')
        // A text block that paints nothing — no text, or whitespace only, as a
        // streamed round that opens with a bare space does — must not take a
        // flex slot either: an empty markdown block has no height but still
        // owns a gap, which is what made two tool rows sit 24px apart. The tool
        // plan reads the same rule through `textBlockRenders`, so the plan and
        // the paint always agree about whether a row exists.
        if (!textRendersRow(text)) return null
        const isFinalBlock = index === blocks.length - 1
        return (
          <MessageBubble
            key={`text-${index}`}
            variant="ghost"
            // One row height, content centred: a one-line reply then occupies the
            // same box as a tool row, so the space around it matches every other
            // row (a longer reply simply grows past the minimum).
            className={cn('w-full', TRANSCRIPT_ROW)}
          >
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

      {ownsTail && message.errorMessage ? (() => {
        // A user-stopped round is not a failure: it reads as a neutral
        // "stopped" row instead of a red error disclosure (the SDK reports the
        // abort through the same `errorMessage` field).
        const stopped = message.stopReason === 'aborted'
        const tone = stopped ? 'text-muted-foreground' : 'text-destructive'
        return (
          // Reuses the reasoning disclosure (beUI AgentActivity): a collapsed row
          // that expands to the raw provider/SDK error instead of dumping a red
          // box into the transcript.
          <RowReveal animate={streaming} className="w-full">
            <AgentActivity
              status="complete"
              summary={<span className={tone}>{stopped ? t('subagent.aborted') : t('chat.error')}</span>}
              defaultOpen={false}
              collapseOnComplete={false}
              // Same indent as the reasoning body it shares this disclosure with.
              contentClassName={cn(WRAP_ANYWHERE, ACTIVITY_BODY_INDENT)}
              items={[
                {
                  id: 'error',
                  type: 'text' as const,
                  content: <span className={tone}>{message.errorMessage}</span>,
                },
              ]}
            />
          </RowReveal>
        )
      })() : null}
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
    prev.toolResults !== next.toolResults ||
    prev.messageIndex !== next.messageIndex ||
    prev.blocksFrom !== next.blocksFrom ||
    prev.blocksTo !== next.blocksTo
  ) {
    return false
  }
  // Plans are rebuilt (new Map identity) whenever any round changes, so compare
  // by value — an untouched round must keep its memo.
  if (!sameToolPlan(prev.toolPlan, next.toolPlan, prev.message, prev.messageIndex)) return false
  if (prev.toolRuns === next.toolRuns) return true
  for (const part of prev.message.content) {
    if (part.type === 'toolCall' && prev.toolRuns[part.id] !== next.toolRuns[part.id]) return false
  }
  return true
}

export interface AssistantGroupProps extends ToolContext {
  notices?: TurnNotice[]
  /** File ownership can span multiple user-steer display groups. */
  writtenMessages?: readonly AssistantMsg[]
  writtenCompletions?: readonly CustomMsg[]
  writtenReviewId?: number
  showWrittenFiles?: boolean
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
  /** Terminal failure prose for this turn (auto-retry gave up, or compaction
   * failed). It is prose about the turn, not status chrome: unframed, at body
   * size, in the error colour, and directly ABOVE the retry/fork row it
   * explains. */
  failure?: string
  /** True only for the transcript's newest turn: its completion-actions row
   * (icons + timestamp) stays visible instead of revealing on hover. */
  actionsAlwaysVisible?: boolean
  /** Session working directory, used to resolve the turn's written files. */
  cwd?: string | null
  /** Stable identity for the live turn's spinner-verb pick (the session). */
  spinnerSeed?: string
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
    prev.notices !== next.notices ||
    prev.writtenMessages !== next.writtenMessages ||
    prev.writtenCompletions !== next.writtenCompletions ||
    prev.writtenReviewId !== next.writtenReviewId ||
    prev.showWrittenFiles !== next.showWrittenFiles ||
    prev.streamingIndex !== next.streamingIndex ||
    prev.pending !== next.pending ||
    prev.toolResults !== next.toolResults ||
    prev.cwd !== next.cwd ||
    prev.retryFrom !== next.retryFrom ||
    prev.forkAt !== next.forkAt ||
    prev.onResend !== next.onResend ||
    prev.onFork !== next.onFork ||
    prev.showActions !== next.showActions ||
    prev.failure !== next.failure ||
    prev.actionsAlwaysVisible !== next.actionsAlwaysVisible ||
    prev.spinnerSeed !== next.spinnerSeed ||
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

/**
 * Where a settled turn's visible tail starts: the block holding the final reply,
 * i.e. the turn's LAST non-empty prose block. Everything before it — including
 * the reasoning (and any tool calls) the final round emitted before it wrote
 * that prose — is process and folds away, so a finished turn reads as its
 * answer alone. `round === messages.length` when the turn produced no prose at
 * all, which folds every block it has.
 */
interface TurnBoundary {
  round: number
  block: number
}

function replyBoundary(messages: AssistantMsg[]): TurnBoundary {
  for (let round = messages.length - 1; round >= 0; round--) {
    const blocks = groupContent(messages[round].content)
    for (let block = blocks.length - 1; block >= 0; block--) {
      const candidate = blocks[block]
      if (candidate.kind === 'text' && textBlockRenders(candidate)) return { round, block }
    }
  }
  return { round: messages.length, block: 0 }
}

/** The fold boundary: the reply block, pulled back to an errored round — that
 * disclosure IS the turn's outcome and has to stay on screen. */
function processBoundary(messages: AssistantMsg[]): TurnBoundary {
  const reply = replyBoundary(messages)
  const error = messages.findIndex((message) => Boolean(message.errorMessage))
  return error >= 0 && error < reply.round ? { round: error, block: 0 } : reply
}

/**
 * How many transcript rows the folded side paints: every block before the
 * boundary, one row per thinking/text block and one per tool block's planned
 * rows (a folded run counts once). Used to decide whether a collapsed turn
 * actually has process content to hide, so the fold trigger never appears over
 * nothing.
 */
function foldedRows(
  messages: AssistantMsg[],
  boundary: TurnBoundary,
  plan: ToolPlan,
  showReasoning: boolean
): number {
  let count = 0
  messages.forEach((message, messageIndex) => {
    if (messageIndex > boundary.round) return
    const blocks = groupContent(message.content)
    const limit = messageIndex === boundary.round ? boundary.block : blocks.length
    blocks.forEach((block, blockIndex) => {
      if (blockIndex >= limit) return
      if (block.kind === 'tool') {
        // Continuation blocks are absent/`null` in the plan and render nothing.
        const rows = plan.get(toolPlanKey(messageIndex, blockIndex))
        if (rows) count += planRowCount(rows)
      }
      // An all-blank text block renders nothing (AssistantParts bails on it).
      else if (block.kind === 'text') count += textBlockRenders(block) ? 1 : 0
      // Reasoning rows are not painted when the preference is off, so they
      // cannot make the folded part look non-empty either.
      else count += showReasoning ? 1 : 0
    })
    if (message.errorMessage) count += 1
  })
  return count
}

/**
 * How long a settled turn took: from the prompt that opened it to the last
 * committed message or tool result. `completedAt` is the session entry's write
 * time, attached by the main process (the SDK's own `timestamp` marks when a
 * message was CREATED, which would leave out the final answer's generation).
 * Falls back to creation times so an untimed message still yields a bound.
 */
function turnDurationMs(
  messages: AssistantMsg[],
  toolResults: Map<string, ToolResultMsg>,
  openedBy?: UserMsg
): number {
  const start = openedBy?.timestamp ?? messages[0]?.timestamp ?? 0
  let end = start
  for (const message of messages) {
    end = Math.max(end, message.completedAt ?? message.timestamp)
    for (const part of message.content) {
      if (part.type !== 'toolCall') continue
      const result = toolResults.get(part.id)
      if (result) end = Math.max(end, result.completedAt ?? result.timestamp)
    }
  }
  return Math.max(0, end - start)
}

/** Compact elapsed time for the fold trigger: `32s`, `2m 5s`, `1h 4m`. */
function formatDuration(t: Translate, ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000))
  if (seconds < 60) return t('chat.durationSeconds', { count: seconds })
  const minutes = Math.floor(seconds / 60)
  const restSeconds = seconds % 60
  if (minutes < 60) {
    return restSeconds
      ? t('chat.durationMinutesSeconds', { minutes, seconds: restSeconds })
      : t('chat.durationMinutes', { minutes })
  }
  const hours = Math.floor(minutes / 60)
  const restMinutes = minutes % 60
  return restMinutes
    ? t('chat.durationHoursMinutes', { hours, minutes: restMinutes })
    : t('chat.durationHours', { hours })
}

/**
 * A whole assistant turn as one message row: each model round's parts in order,
 * a single timestamp beside the completion actions, and — while it is the live
 * turn — one spinner. A live turn never folds (watching the run is the point);
 * once it settles every round before the final reply folds behind one trigger
 * showing how long the turn took, expandable at any time.
 */
export const AssistantGroup = memo(function AssistantGroup({
  messages,
  notices,
  writtenMessages = messages,
  writtenCompletions,
  writtenReviewId,
  showWrittenFiles = true,
  streamingIndex,
  pending = false,
  retryFrom,
  forkAt,
  onResend,
  onFork,
  showActions = false,
  failure,
  actionsAlwaysVisible = false,
  cwd,
  spinnerSeed,
  onReview,
  toolResults,
  toolRuns
}: AssistantGroupProps) {
  const { t } = useI18n()
  // Same preference the rounds read; subscribing here too keeps the two tool
  // plans below (and the fold's step count) in step with it.
  const [showReasoning] = useShowReasoning()
  // Grouping preference: off turns the plan into one singleton row per call,
  // restoring the pre-grouping transcript without touching the render path.
  const [toolGrouping] = useToolGrouping()
  const [processOpen, setProcessOpen] = useState(false)
  const live = streamingIndex >= 0 || pending
  // Frontier step of the live turn, for the waiting row's spinner verb: the
  // newest content part of the newest round — the tool call that is running, or
  // the reasoning/prose the model is writing now. Only the live turn needs it.
  const liveStep = live ? frontierStepContext(messages) : undefined
  // A pending ask_user_question suspends the turn on the user's answer: the
  // waiting row then states that instead of playing a work verb.
  const waitingUser = live ? frontierWaitingOnUser(messages) : false
  // Nothing folds while the turn runs — the rows the user is watching stay put,
  // and the fold appears in the same frame the turn settles. Settled, the
  // boundary is the turn's own final reply block, so every block before it is
  // process — including the reasoning the reply's own round emitted first.
  const boundary: TurnBoundary = live ? { round: 0, block: 0 } : processBoundary(messages)
  const boundaryRound = messages[boundary.round]
  const foldedMessages = messages.slice(0, boundary.round)
  const tailMessages = messages.slice(boundary.round)
  const visibleStreamingIndex =
    streamingIndex >= boundary.round ? streamingIndex - boundary.round : -1
  // Plan runs per sequence: the folded process and the visible tail never merge
  // across the fold, which is a deliberate UI break. The boundary round goes
  // into the folded plan as well, so the blocks it contributes there keep their
  // run continuations resolved.
  const noticeBoundaries = new Set(notices?.map((notice) => notice.beforeRound))
  const foldedToolPlan = buildToolPlan(
    messages.slice(0, boundary.round + 1),
    0,
    showReasoning,
    toolGrouping,
    noticeBoundaries
  )
  const tailToolPlan = buildToolPlan(
    tailMessages,
    boundary.round,
    showReasoning,
    toolGrouping,
    noticeBoundaries
  )
  const foldedRowCount = live
    ? 0
    : foldedRows(messages, boundary, foldedToolPlan, showReasoning) +
      (notices?.filter((notice) => notice.beforeRound <= boundary.round).length ?? 0)
  const noticeRows = (index: number) => notices?.filter((notice) => notice.beforeRound === index)
    .map((notice, index) => <CustomItem key={`notice-${notice.message.timestamp}-${index}`} message={notice.message} />)
  const turnDuration = useMemo(
    () => turnDurationMs(messages, toolResults, retryFrom),
    [messages, toolResults, retryFrom]
  )
  const turnTimestamp = messages[0]?.timestamp ?? notices?.[0]?.message.timestamp ?? 0
  const hasParts = live || Boolean(notices?.length) || messages.some((message) => message.content.length > 0 || message.errorMessage)
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
    () => {
      if (live || !showWrittenFiles) return []
      // Background subagent completions land in this display group as turn
      // notices (the wake continues the scope here); their written-file
      // payloads belong in the same cumulative list as direct edit/write calls.
      const completions = writtenCompletions ?? (notices ?? []).map((notice) => notice.message)
        .filter((message) => message.customType === 'subagent_completion')
      return extractTurnWrittenFiles(writtenMessages, toolResults, cwd, completions)
    },
    [live, showWrittenFiles, writtenMessages, writtenCompletions, toolResults, cwd, notices]
  )
  /**
   * The list belongs between the answer and the completion-actions row, so it
   * rides in that row's `footer` slot whenever the turn renders one. A turn that
   * ends on tools, or was stopped/errored, has no such row — there it stays a
   * plain row above the standalone retry/fork fallback.
   *
   * The parent grants ownership only to the cumulative scope's final group,
   * and hides that scope synchronously for its entire active run. A user steer
   * can settle this display group without settling its files. An unrelated
   * later run leaves the old scope's card alone. No effect/animation may expose
   * an intermediate list before the final settled event.
   */
  const writtenFilesNode =
    !live && writtenFiles.length > 0 ? (
      <TurnWrittenFiles
        files={writtenFiles}
        onReview={onReview ? () => onReview(writtenReviewId ?? turnTimestamp) : undefined}
      />
    ) : null
  const writtenFilesInFooter = showTurnActions && Boolean(writtenFilesNode)

  if (!hasParts) return null

  return (
    // No `animateIn`: the pop is an underdamped spring (it overshoots and
    // wobbles the whole turn), and an assistant turn fills with content while
    // it streams, so the wobble lands on a large block and reads as jitter.
    // The rise-from-the-live-edge entrance stays with sent user messages.
    <Message from="assistant" data-assistant-group={turnTimestamp}>
      <MessageContent className="gap-3">
        {foldedRowCount > 0 ? (
          // Trigger + a bare disclosure. The folded rounds are rendered as a
          // plain `flex flex-col gap-3` (the same container `MessageContent`
          // uses) instead of through AgentActivity's item/TextRow pipeline:
          // that pipeline injected its own vertical padding and typography, so
          // the folded rows sat at a different spacing than the rest of the
          // transcript. Only the disclosure animates.
          <>
            <AgentActivity
              status="complete"
              summary={t('chat.turnDuration', { duration: formatDuration(t, turnDuration) })}
              open={processOpen}
              onOpenChange={setProcessOpen}
              collapseOnComplete={false}
              items={[]}
              // The trigger renders no items; zero the empty list's padding so
              // the only space between it and the rounds below is the flex gap.
              contentClassName="py-0"
              // The fold reads as a section header: a hairline under the trigger
              // separates the process it hides from the answer below it. The
              // rule sits on the row's own bottom edge, so the fold's first row
              // keeps exactly the same spacing as every other pair of rows —
              // whether the fold is open or closed.
              className={cn(TRANSCRIPT_ROW_TRIGGER, 'border-b border-border/70')}
            />
            <AgentDisclosure
              open={processOpen}
              // Closed, the (zero-height) body must leave the flex flow — else
              // it adds its own flex gap and the collapsed spacing would be
              // 8px larger than the expanded one.
              className={cn('w-full', !processOpen && 'hidden')}
            >
              <div className="flex flex-col gap-3" data-turn-process>
                {foldedMessages.map((message, index) => (
                  <Fragment key={`${message.timestamp}-h${index}`}>
                  {noticeRows(index)}
                  <AssistantParts
                    key={`${message.timestamp}-h${index}`}
                    message={message}
                    messageIndex={index}
                    toolPlan={foldedToolPlan}
                    streaming={false}
                    showActions={false}
                    actionsAlwaysVisible={false}
                    turnTimestamp={turnTimestamp}
                    cwd={cwd}
                    toolResults={toolResults}
                    toolRuns={toolRuns}
                  />
                  </Fragment>
                ))}
                {noticeRows(boundary.round)}
                {/* The reply's own round contributes everything it emitted
                    before that prose to the fold, so no process row is left
                    stranded above the answer. */}
                {boundaryRound && boundary.block > 0 ? (
                  <AssistantParts
                    key={`${boundaryRound.timestamp}-h${boundary.round}`}
                    message={boundaryRound}
                    messageIndex={boundary.round}
                    blocksTo={boundary.block}
                    toolPlan={foldedToolPlan}
                    streaming={false}
                    showActions={false}
                    actionsAlwaysVisible={false}
                    turnTimestamp={turnTimestamp}
                    cwd={cwd}
                    toolResults={toolResults}
                    toolRuns={toolRuns}
                  />
                ) : null}
              </div>
            </AgentDisclosure>
          </>
        ) : null}

        {tailMessages.map((message, index) => (
          <Fragment key={`${message.timestamp}-${boundary.round + index}`}>
          {index === 0 && foldedRowCount > 0 ? null : noticeRows(boundary.round + index)}
          <AssistantParts
            key={`${message.timestamp}-${boundary.round + index}`}
            message={message}
            messageIndex={boundary.round + index}
            // A folded-away prefix paints nothing, so rendering the round from
            // its reply block on is the same transcript either way.
            blocksFrom={index === 0 ? boundary.block : 0}
            toolPlan={tailToolPlan}
            streaming={index === visibleStreamingIndex}
            showActions={showTurnActions && index === tailMessages.length - 1}
            actionsAlwaysVisible={actionsAlwaysVisible}
            retryFrom={retryFrom}
            forkAt={forkAt}
            onResend={onResend}
            onFork={onFork}
            footer={
              writtenFilesInFooter && index === tailMessages.length - 1
                ? writtenFilesNode
                : undefined
            }
            turnTimestamp={turnTimestamp}
            cwd={cwd}
            toolResults={toolResults}
            toolRuns={toolRuns}
          />
          </Fragment>
        ))}
        {tailMessages.length > 0 || foldedRowCount === 0 ? noticeRows(messages.length) : null}

        {live ? <TurnStatus step={liveStep} waitingUser={waitingUser} seedKey={spinnerSeed} /> : null}

        {writtenFilesNode && !writtenFilesInFooter ? writtenFilesNode : null}

        {/* A failure the run ended on is prose about the turn, not a banner:
            no frame, body size, error colour — and always above the actions
            row it belongs to. */}
        {!live && failure ? (
          <p
            data-turn-failure
            className={cn('text-sm leading-6 text-destructive', WRAP_ANYWHERE)}
          >
            {failure}
          </p>
        ) : null}

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
                <RefreshCw className="size-3.5" />
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
