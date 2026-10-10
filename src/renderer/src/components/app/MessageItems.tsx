import { presentedFiles } from '@/lib/presented-files'
import { FileTypeIcon } from './FileTypeIcon'
import { PresentedFiles } from './PresentedFiles'
import { SubmissionCard } from './PlanCard'
import { submittedPlanRef } from '@/lib/plan-submissions'
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
import { ArrowLeftFromLine, ArrowRight, Brain, ChevronDown, CircleX, GitFork, Pencil, RefreshCw } from '@/lib/icons'
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
import { ACTIVITY_BODY_INDENT, TRANSCRIPT_ROW, TRANSCRIPT_ROW_WIDTH } from '@/lib/transcript-rhythm'
import { contentLineHeight, useContentFontSize } from '@/lib/typography'
import { cn } from '@/lib/utils'
import { ToolIcon } from '@/lib/tool-icons'
import { formatTime, formatTokenCount, basename } from '@/lib/format'
import { extractTurnWrittenFiles } from '@/lib/turn-written-files'
import type { TurnNotice } from '@/lib/chat-turns'
import { extractUserDisplay } from '@/lib/user-message'
import { continuationTarget } from '../../../../shared/continuation'
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
import { ImagePreviewGroup, PreviewThumb } from './ImagePreview'
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

/** Collapse at ten content lines, including when the user changes its base. */
const USER_BUBBLE_MAX_LINES = 10

/**
 * Clamps a user bubble body to {@link USER_BUBBLE_MAX_LINES} and — only when the
 * body is actually taller than that — offers the expand toggle. The measured
 * element is the inner one: the clamp caps the wrapper, so the verdict cannot
 * flip when expanding removes the cap and hide the control the user just used.
 * A layout effect puts the clamp and its toggle into the first painted frame,
 * so a long message never flashes at full height.
 */
function UserBubbleBody({ children }: { children: ReactNode }) {
  const { t } = useI18n()
  const maxHeight = USER_BUBBLE_MAX_LINES * contentLineHeight(useContentFontSize())
  const [open, setOpen] = useState(false)
  const [overflowing, setOverflowing] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)
  const bodyId = useId()

  useLayoutEffect(() => {
    const node = bodyRef.current
    if (!node) return
    const update = () => {
      setOverflowing(node.getBoundingClientRect().height > maxHeight + 1)
    }
    update()
    // Watching the inner element (not the clamped wrapper, whose box stops
    // changing once capped) also catches re-wraps, images decoding and font
    // swaps, all of which move the natural height only.
    const observer = new ResizeObserver(update)
    observer.observe(node)
    return () => observer.disconnect()
  }, [maxHeight])

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
        style={collapsed ? { maxHeight } : undefined}
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
      data-row="text"
      animateIn={Boolean((message as any).__optimistic)}
      data-rail-id={railId}
      className={spaced ? 'mt-4' : undefined}
    >
      <MessageContent data-transcript-rows>
        {/* A pale wash of the theme's accent, not a gray: `tint` is
            `bg-primary/10`, which blends the ACTIVE accent token over whatever
            is behind it — and because `--primary` carries a light/dark pair
            (plus the accent presets and the runtime custom slot), the wash
            stays a light theme colour in both modes while `text-foreground`
            keeps the text legible (unlike solid's fixed black/white). */}
        <MessageBubble variant="tint">
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
                        className="inline-flex max-w-64 items-center gap-1.5 rounded-lg bg-background/60 px-2 py-1 text-xs text-foreground transition-colors hover:bg-background"
                      >
                        <FileTypeIcon path={path} className="size-4 shrink-0" />
                        <span className="truncate">{basename(path)}</span>
                      </Button>
                    </LabelTooltip>
                  ))}
                </div>
              ) : null}
              {images.length ? (
                <ImagePreviewGroup>
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
                </ImagePreviewGroup>
              ) : null}
            </UserBubbleBody>
          </MessageBubbleContent>
        </MessageBubble>
        {showActions ? (
          <MessageActions alwaysVisible={actionsAlwaysVisible}>
            {text ? <CopyAction text={text} /> : null}
            {onRewind ? <MessageAction label={t('rewind.title')} onClick={() => onRewind(message)}><ArrowLeftFromLine className="size-3.5" /></MessageAction> : null}
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
 * A compaction or branch summary. Compaction replaces older MODEL context but
 * the UI keeps that history visible; a branch summary still represents an
 * abandoned path. The expandable result is the summary itself. Rendered as a
 * tool row — see `SummaryRow` for why.
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
      process={message.process}
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
    <div data-row="text" className="rounded-xl border border-border bg-card px-3 py-2">
      <p className="text-caption font-medium uppercase tracking-wide text-muted-foreground">
        {t('chat.customMessage', { type: message.customType })}
      </p>
      {text ? (
        <div className={`mt-1 text-sm text-foreground ${WRAP_ANYWHERE}`}>
          <Markdown>{text}</Markdown>
        </div>
      ) : null}
      {images.length ? (
        <ImagePreviewGroup>
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
        </ImagePreviewGroup>
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
  /** A terminal Stop is hosted outside the process by the group. */
  showStatus?: boolean
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
  showStatus = true,
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
            <RowReveal key={`thinking-${index}`} animate={streaming} rowKind="process" className="w-full">
              <AgentActivity
                status="complete"
                summary={
                  // Same leading-icon shape as a tool row, so the Reasoning row
                  // scans like the tool calls under it.
                  <span className="inline-flex items-center gap-2">
                    <Brain aria-hidden="true" className="size-4 shrink-0" />
                    <span className="transcript-label">{t('chat.reasoning')}</span>
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
          const submissions = block.parts.flatMap(call => { const ref = submittedPlanRef(toolResults.get(call.id)); return ref ? [ref] : [] })
          if (planRows === null && !submissions.length) return null
          const rows = planRows ?? splitByToolCategory(block.parts)
          return (
            <Fragment key={`tool-${index}`}>
              {submissions.map(reference => <SubmissionCard key={reference.submissionEntryId} reference={reference} />)}
              {/* Each visible row is a direct stack item across SDK rounds. */}
              {rows.flatMap((run) =>
                run.category && run.items.length > 1 ? (
                  <RowReveal key={run.items[0].id} animate={streaming} rowKind="process" className={TRANSCRIPT_ROW_WIDTH}>
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
                    <RowReveal key={call.id} animate={streaming} rowKind="process" className={TRANSCRIPT_ROW_WIDTH}>
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
            data-row="text"
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

      {ownsTail && showStatus ? <AssistantStatus message={message} streaming={streaming} /> : null}
    </>
  )
}, assistantPartsPropsEqual)

/** Errors belong to the process; the current turn's terminal Stop remains
 * visible beside its actions, with the regular transcript spacing. */
function AssistantStatus({ message, streaming = false }: {
  message: AssistantMsg
  streaming?: boolean
}) {
  const { t } = useI18n()
  if (!message.errorMessage) return null
  // A user-stopped round is not a failure: it reads as a neutral
  // "stopped" row instead of a red error disclosure (the SDK reports the
  // abort through the same `errorMessage` field).
  const stopped = message.stopReason === 'aborted'
  const tone = 'text-muted-foreground'
  const summary = message.errorMessage === 'JEV_WORKFLOW_PAUSED' ? t('jev.phase.paused') : stopped ? t('subagent.aborted') : t('chat.error')
  return (
    // Reuses the reasoning disclosure (beUI AgentActivity): a collapsed row
    // that expands to the raw provider/SDK error instead of dumping a red
    // box into the transcript.
    <RowReveal animate={streaming} rowKind="process" className="w-full">
      <AgentActivity
        status="complete"
        summary={
          // Same leading-icon shape as the reasoning and tool rows (a
          // 16px glyph plus an 8px gap = the 24px text indent): a 14px
          // glyph on a 6px gap made this row's icon hug its label while
          // every row around it started at the shared indent.
          <span className={cn(tone, 'inline-flex items-center gap-2')}>
            {!stopped && <CircleX aria-hidden="true" className="size-4 shrink-0" />}
            {summary}
          </span>
        }
        defaultOpen={false}
        collapseOnComplete={false}
        // Same indent as the reasoning body it shares this disclosure with.
        contentClassName={cn(WRAP_ANYWHERE, ACTIVITY_BODY_INDENT)}
        items={[
          {
            id: 'error',
            type: 'text' as const,
            content: <span className={tone}>{message.errorMessage === 'JEV_WORKFLOW_PAUSED' ? t('jev.workflowResume') : message.errorMessage}</span>,
          },
        ]}
      />
    </RowReveal>
  )
}

/**
 * Element-wise identity for the arrays a row renders from. The transcript
 * rebuilds every turn's arrays on each message change, so comparing by array
 * identity would re-render every settled turn for a row that never saw it.
 */
function sameRefs<T>(prev: readonly T[] | undefined, next: readonly T[] | undefined): boolean {
  if (prev === next) return true
  if (!prev || !next || prev.length !== next.length) return false
  for (let index = 0; index < prev.length; index++) {
    if (prev[index] !== next[index]) return false
  }
  return true
}

/** Turn notices are rebuilt with their turn, so compare their data by value. */
function sameNotices(prev: TurnNotice[] | undefined, next: TurnNotice[] | undefined): boolean {
  if (prev === next) return true
  if (!prev || !next || prev.length !== next.length) return false
  for (let index = 0; index < prev.length; index++) {
    if (prev[index].beforeRound !== next[index].beforeRound || prev[index].message !== next[index].message) {
      return false
    }
  }
  return true
}

/**
 * Whether the tool results these messages read changed. The store rebuilds the
 * whole map on every transcript change, so its identity says nothing about a
 * given round: compare the entries that round actually renders.
 */
function sameToolResults(
  messages: readonly AssistantMsg[],
  prev: ReadonlyMap<string, ToolResultMsg>,
  next: ReadonlyMap<string, ToolResultMsg>
): boolean {
  if (prev === next) return true
  for (const message of messages) {
    for (const part of message.content) {
      if (part.type === 'toolCall' && prev.get(part.id) !== next.get(part.id)) return false
    }
  }
  return true
}

function assistantPartsPropsEqual(prev: AssistantPartsProps, next: AssistantPartsProps): boolean {
  if (
    prev.showStatus !== next.showStatus ||
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
    prev.messageIndex !== next.messageIndex ||
    prev.blocksFrom !== next.blocksFrom ||
    prev.blocksTo !== next.blocksTo
  ) {
    return false
  }
  if (!sameToolResults([prev.message], prev.toolResults, next.toolResults)) return false
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
  continueFrom?: AssistantMsg
  onContinue?: (message: AssistantMsg) => void
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
  /** In-flight process rows, such as compaction, before the live spinner. */
  liveProcess?: ReactNode
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
  /** Terminal retry failure prose, unframed and inside the turn's process. */
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
  /** Opens Rewind on the user message that opened the turn's change scope,
   * preselected files-only — the changed-files card's Undo action. Together
   * with `undoTarget` this stays a stable prop; the group binds the pair. */
  onUndoFiles?: (message: UserMsg) => void
  /** The change scope's opening prompt, or null when a compaction removed it. */
  undoTarget?: UserMsg | null
}

/**
 * memo comparator for AssistantGroup: a new `toolRuns` record identity (every
 * tool_execution_update creates one) must not re-render the group unless one
 * of the tool calls THIS group renders actually changed. The turn's own arrays
 * and the shared tool-result map are rebuilt with every transcript change for
 * the same reason, so they are compared element- and entry-wise.
 */
function assistantGroupPropsEqual(prev: AssistantGroupProps, next: AssistantGroupProps): boolean {
  if (
    prev.continueFrom !== next.continueFrom ||
    prev.onContinue !== next.onContinue ||
    prev.writtenReviewId !== next.writtenReviewId ||
    prev.showWrittenFiles !== next.showWrittenFiles ||
    prev.streamingIndex !== next.streamingIndex ||
    prev.pending !== next.pending ||
    prev.liveProcess !== next.liveProcess ||
    prev.cwd !== next.cwd ||
    prev.retryFrom !== next.retryFrom ||
    prev.forkAt !== next.forkAt ||
    prev.onResend !== next.onResend ||
    prev.onFork !== next.onFork ||
    prev.showActions !== next.showActions ||
    prev.failure !== next.failure ||
    prev.actionsAlwaysVisible !== next.actionsAlwaysVisible ||
    prev.spinnerSeed !== next.spinnerSeed ||
    prev.onReview !== next.onReview ||
    prev.onUndoFiles !== next.onUndoFiles ||
    prev.undoTarget !== next.undoTarget
  ) {
    return false
  }
  if (!sameRefs(prev.messages, next.messages)) return false
  if (!sameRefs(prev.writtenMessages, next.writtenMessages)) return false
  if (!sameRefs(prev.writtenCompletions, next.writtenCompletions)) return false
  if (!sameNotices(prev.notices, next.notices)) return false
  if (!sameToolResults(prev.messages, prev.toolResults, next.toolResults)) return false
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
 * answer alone. Interrupted turns have no completed reply: all their blocks
 * fold away, with the terminal Stop row hosted separately by the group.
 */
interface TurnBoundary {
  round: number
  block: number
}

function replyBoundary(messages: AssistantMsg[], results: Map<string, ToolResultMsg>, failed: boolean): TurnBoundary {
  for (let round = 0; round < messages.length; round++) {
    const blocks = groupContent(messages[round].content)
    const block = blocks.findIndex(b => b.kind === 'tool' && b.parts.some(call => submittedPlanRef(results.get(call.id))))
    if (block >= 0) return { round, block }
  }
  if (failed || continuationTarget(messages)) return { round: messages.length, block: 0 }
  for (let round = messages.length - 1; round >= 0; round--) {
    const blocks = groupContent(messages[round].content)
    for (let block = blocks.length - 1; block >= 0; block--) {
      const candidate = blocks[block]
      if (candidate.kind === 'text' && textBlockRenders(candidate)) return { round, block }
    }
  }
  return { round: messages.length, block: 0 }
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
  showReasoning: boolean,
  outsideStatus: AssistantMsg | undefined
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
    if (messageIndex < boundary.round && message !== outsideStatus && message.errorMessage) count += 1
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
  continueFrom,
  onContinue,
  messages,
  notices,
  writtenMessages = messages,
  writtenCompletions,
  writtenReviewId,
  showWrittenFiles = true,
  streamingIndex,
  pending = false,
  liveProcess,
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
  onUndoFiles,
  undoTarget,
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
  const lastRound = messages[messages.length - 1]
  const outsideStatus = !live && lastRound?.stopReason === 'aborted' && lastRound.errorMessage ? lastRound : undefined
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
  const boundary: TurnBoundary = live ? { round: 0, block: 0 } : replyBoundary(messages, toolResults, Boolean(failure))
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
  const promoted = new Set([...toolResults].filter(([, result]) => submittedPlanRef(result)).map(([id]) => id))
  const foldedToolPlan = buildToolPlan(
    messages.slice(0, boundary.round + 1),
    0,
    showReasoning,
    toolGrouping,
    noticeBoundaries,
    promoted
  )
  const tailToolPlan = buildToolPlan(
    tailMessages,
    boundary.round,
    showReasoning,
    toolGrouping,
    noticeBoundaries,
    promoted
  )
  const foldedRowCount = live
    ? 0
    : foldedRows(messages, boundary, foldedToolPlan, showReasoning, outsideStatus) +
      (notices?.filter((notice) => notice.beforeRound <= boundary.round).length ?? 0) +
      (failure ? 1 : 0)
  const noticeRows = (index: number) => notices?.filter((notice) => notice.beforeRound === index)
    .map((notice, index) => <CustomItem key={`notice-${notice.message.timestamp}-${index}`} message={notice.message} />)
  const turnDuration = useMemo(
    () => turnDurationMs(messages, toolResults, retryFrom),
    [messages, toolResults, retryFrom]
  )
  const turnTimestamp = messages[0]?.timestamp ?? notices?.[0]?.message.timestamp ?? 0
  const hasParts = live || Boolean(continueFrom) || Boolean(failure) || Boolean(notices?.length) || messages.some((message) => message.content.length > 0 || message.errorMessage)
  // Copy/feedback actions (and the turn timestamp beside them) belong to the
  // turn's final prose only: phase text that precedes tool calls must stay
  // chrome-free, and an unfinished tool round has no completed answer to act
  // on. Rounds are windowed, so compare against the visible tail instead of
  // absolute indices.
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
    Boolean(continueFrom) || Boolean(failure) || Boolean(continuationTarget(messages))
  const showTurnActions = !live && lastRoundHasText && !incomplete
  /**
   * The files this turn wrote, derived here rather than passed in: the group's
   * memo already keeps untouched turns out of the render path, so only the turn
   * that changed pays for the extraction (and the per-result patch cache in
   * `turn-written-files` keeps repeat work off the streaming path).
   */
  const deliveredFiles = useMemo(() => !live && showWrittenFiles ? presentedFiles(writtenMessages, toolResults) : [], [live, showWrittenFiles, writtenMessages, toolResults])
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
    !live && (writtenFiles.length > 0 || deliveredFiles.length > 0) ? (
      <div className="w-full space-y-3">
        {deliveredFiles.length > 0 ? <PresentedFiles files={deliveredFiles} /> : null}
        {writtenFiles.length > 0 ? <TurnWrittenFiles
          files={writtenFiles}
          onReview={onReview ? () => onReview(writtenReviewId ?? turnTimestamp) : undefined}
          onUndo={onUndoFiles && undoTarget ? () => onUndoFiles(undoTarget) : undefined}
        /> : null}
      </div>
    ) : null
  const writtenFilesInFooter = showTurnActions && Boolean(writtenFilesNode)
  const showStandaloneActions = !live && showActions && !showTurnActions && Boolean(retryFrom || forkAt || continueFrom)

  if (!hasParts) return null

  return (
    // No `animateIn`: the pop is an underdamped spring (it overshoots and
    // wobbles the whole turn), and an assistant turn fills with content while
    // it streams, so the wobble lands on a large block and reads as jitter.
    // The rise-from-the-live-edge entrance stays with sent user messages.
    <Message from="assistant" data-assistant-group={turnTimestamp}>
      <MessageContent data-transcript-rows>
        {foldedRowCount > 0 ? (
          // Header and disclosure form one row, so a closed body has no slot.
          <div className="w-full" data-row="process" data-transcript-gap-after="divider">
            <AgentActivity
              status="complete"
              summary={t('chat.turnDuration', { duration: formatDuration(t, turnDuration) })}
              open={processOpen}
              onOpenChange={setProcessOpen}
              collapseOnComplete={false}
              items={[]}
              contentClassName="py-0"
              // The full-width section owns the straight rule. Drawing it on
              // the rounded, content-width button bends and shortens the line.
              className="relative after:pointer-events-none after:absolute after:inset-x-0 after:bottom-0 after:border-b after:border-border/70"
            />
            <AgentDisclosure open={processOpen} data-agent-body data-transcript-gap-before="divider">
              <div data-transcript-rows data-turn-process>
                {foldedMessages.map((message, index) => (
                  <Fragment key={`${message.timestamp}-h${index}`}>
                  {noticeRows(index)}
                  <AssistantParts
                    key={`${message.timestamp}-h${index}`}
                    message={message}
                    showStatus={message !== outsideStatus}
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
                    showStatus={boundaryRound !== outsideStatus}
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
                {failure ? (
                  <p data-turn-failure data-row="text" className={cn('text-content text-destructive', WRAP_ANYWHERE)}>
                    {failure}
                  </p>
                ) : null}
              </div>
            </AgentDisclosure>
          </div>
        ) : null}

        {tailMessages.map((message, index) => (
          <Fragment key={`${message.timestamp}-${boundary.round + index}`}>
          {index === 0 && foldedRowCount > 0 ? null : noticeRows(boundary.round + index)}
          <AssistantParts
            key={`${message.timestamp}-${boundary.round + index}`}
            message={message}
            showStatus={message !== outsideStatus}
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

        {live ? liveProcess : null}
        {live ? <TurnStatus step={liveStep} waitingUser={waitingUser} seedKey={spinnerSeed} /> : null}

        {/* A standalone file summary keeps the roomy leading gap, including
            when it immediately follows the collapsed process divider. */}
        {writtenFilesNode && !writtenFilesInFooter ? (
          <div data-transcript-gap-before="roomy" className="w-full">
            {writtenFilesNode}
          </div>
        ) : null}

        {/* Retry/fork normally live inside the final text round's completion
            actions row (so they share a line with copy/feedback and the
            timestamp stays rightmost). A turn that ended on tools or an error
            renders no such row, so keep the standalone actions row for it.
            Actions own one fixed leading gap, whether the preceding row is
            Stop, a card or the collapsed process itself. */}
        {outsideStatus || showStandaloneActions ? (
          <div data-turn-ending data-transcript-gap-before={outsideStatus ? 'roomy' : 'actions'} className="flex w-full flex-col">
            {outsideStatus ? <AssistantStatus message={outsideStatus} /> : null}
            {showStandaloneActions ? (
              <MessageActions alwaysVisible={actionsAlwaysVisible}>
                {onContinue && continueFrom ? (
                  <MessageAction label={t('chat.messageContinue')} onClick={() => onContinue(continueFrom)}>
                    <ArrowRight className="size-3.5" />
                  </MessageAction>
                ) : null}
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
          </div>
        ) : null}
      </MessageContent>
    </Message>
  )
}, assistantGroupPropsEqual)
