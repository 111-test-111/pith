import { memo } from 'react'
import { Bot, FileText, User } from 'lucide-react'
import { AgentActivity } from '@/components/agents/agent-activity'
import {
  Message,
  MessageAvatar,
  MessageBubble,
  MessageBubbleContent,
  MessageContent,
  MessageFooter,
  MessageHeader,
} from '@/components/agents/message'
import { ThinkingShimmer } from '@/components/agents/loading-states'
import { StreamingResponse } from '@/components/agents/streaming-response'
import { Markdown } from '@/lib/markdown'
import { formatCost, formatTime, formatTokenCount, basename } from '@/lib/format'
import { extractUserDisplay } from '@/lib/user-message'
import type { AssistantMsg, ToolCallContent, ToolResultMsg, UserMsg, UsageDTO } from '../../../../shared/types'
import type { ToolRun } from '@/state/pi-store'
import { useI18n } from '@/i18n'
import { ToolCallView } from './ToolCallView'

/** `anywhere` (unlike `break-words`) shrinks intrinsic min-content so long
 * unbroken strings wrap instead of widening the conversation column. */
const WRAP_ANYWHERE = '[overflow-wrap:anywhere]'

/** `railId` marks this row as a navigation-rail target (MessageScroller
 * resolves app-provided rail items through data-rail-id). */
export const UserItem = memo(function UserItem({
  message,
  railId
}: {
  message: UserMsg
  railId?: string
}) {
  const { t } = useI18n()
  const { text, files, images } = extractUserDisplay(message.content)
  return (
    <Message from="user" animateIn data-rail-id={railId}>
      <MessageAvatar>
        <User />
      </MessageAvatar>
      <MessageContent>
        <MessageHeader>
          <span>{t('chat.you')}</span>
          <span>{formatTime(message.timestamp)}</span>
        </MessageHeader>
        <MessageBubble variant="solid">
          <MessageBubbleContent>
            {text ? <p className={`whitespace-pre-wrap ${WRAP_ANYWHERE}`}>{text}</p> : null}
            {files.length ? (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {files.map((path) => (
                  <button
                    key={path}
                    type="button"
                    onClick={() => void window.pi.openPath(path)}
                    className="inline-flex max-w-64 items-center gap-1.5 rounded-lg bg-background/15 px-2 py-1 text-xs text-background/90 transition-opacity hover:opacity-80"
                    title={path}
                  >
                    <FileText className="size-3.5 shrink-0" />
                    <span className="truncate">{basename(path)}</span>
                  </button>
                ))}
              </div>
            ) : null}
            {images.length ? (
              <div className="mt-2 flex flex-wrap gap-2">
                {images.map((image, index) => (
                  <img
                    key={index}
                    src={`data:${image.mimeType};base64,${image.data}`}
                    alt={`attachment ${index + 1}`}
                    className="max-h-44 max-w-64 rounded-lg border border-background/20 object-cover"
                  />
                ))}
              </div>
            ) : null}
          </MessageBubbleContent>
        </MessageBubble>
      </MessageContent>
    </Message>
  )
})

interface ToolContext {
  toolResults: Map<string, ToolResultMsg>
  toolRuns: Record<string, ToolRun>
}

/** One assistant model round (thinking + tool calls + text) inside a merged group. */
function AssistantParts({ message, streaming, toolResults, toolRuns }: { message: AssistantMsg; streaming: boolean } & ToolContext) {
  const { t } = useI18n()
  const thinking = message.content.filter((part) => part.type === 'thinking')
  const text = message.content
    .filter((part) => part.type === 'text')
    .map((part) => (part as any).text as string)
    .join('\n\n')
  const toolCalls = message.content.filter(
    (part): part is ToolCallContent => part.type === 'toolCall'
  )
  const plainText = `${text}${
    toolCalls.length ? `\n\n${toolCalls.map((call) => `${call.name}(${JSON.stringify(call.arguments)})`).join('\n')}` : ''
  }`
  const hasContent = thinking.length > 0 || text.length > 0 || toolCalls.length > 0

  if (!hasContent && !streaming) return null

  return (
    <>
      {thinking.length ? (
        <>
          {/* beUI's AgentActivity force-expands while "working", so it is
             always rendered in its completed (collapsed) form — the live
             indicator is a plain shimmer row instead. Manual expansion sticks
             because the status never transitions working→complete here. */}
          {streaming ? (
            <div className="flex h-7 items-center text-sm text-muted-foreground">
              <ThinkingShimmer>{t('chat.thinking')}</ThinkingShimmer>
            </div>
          ) : null}
          <AgentActivity
            status="complete"
            summary={t('chat.reasoning')}
            defaultOpen={false}
            collapseOnComplete={false}
            contentClassName={WRAP_ANYWHERE}
            items={thinking.map((part: any, index: number) => ({
              id: `think-${index}`,
              type: 'text' as const,
              content: part.thinking || '(redacted)',
            }))}
          />
        </>
      ) : null}

      {toolCalls.length ? (
        <div className="w-full space-y-2">
          {toolCalls.map((call) => (
            <ToolCallView
              key={call.id}
              call={call}
              result={toolResults.get(call.id)}
              run={toolRuns[call.id]}
            />
          ))}
        </div>
      ) : null}

      {message.errorMessage ? (
        <div className={`rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive ${WRAP_ANYWHERE}`}>
          {message.errorMessage}
          {message.stopReason === 'aborted' ? t('chat.aborted') : ''}
        </div>
      ) : null}

      {text ? (
        <MessageBubble variant="ghost" className="w-full">
          <MessageBubbleContent>
            <StreamingResponse
              status={streaming ? 'streaming' : 'complete'}
              copyText={plainText}
              showActions={!streaming}
            >
              <Markdown streaming={streaming}>{text}</Markdown>
            </StreamingResponse>
          </MessageBubbleContent>
        </MessageBubble>
      ) : null}

      {!text && streaming && !toolCalls.length && !thinking.length ? (
        <StreamingResponse status="streaming" showActions={false}>
          <span className="text-muted-foreground">…</span>
        </StreamingResponse>
      ) : null}
    </>
  )
}

function totalUsage(messages: AssistantMsg[]): UsageDTO | null {
  let usage: UsageDTO | null = null
  for (const message of messages) {
    if (!message.usage) continue
    if (!usage) {
      usage = { ...message.usage, cost: { ...message.usage.cost } }
      continue
    }
    usage.input += message.usage.input
    usage.output += message.usage.output
    usage.cacheRead += message.usage.cacheRead
    usage.cacheWrite += message.usage.cacheWrite
    usage.totalTokens += message.usage.totalTokens
    usage.cost.input += message.usage.cost.input
    usage.cost.output += message.usage.cost.output
    usage.cost.cacheRead += message.usage.cost.cacheRead
    usage.cost.cacheWrite += message.usage.cost.cacheWrite
    usage.cost.total += message.usage.cost.total
  }
  return usage
}

export interface AssistantGroupProps extends ToolContext {
  /** Consecutive assistant rounds of one turn, oldest first. */
  messages: AssistantMsg[]
  /** Index of the live streaming round inside `messages`; -1 when idle. */
  streamingIndex: number
  /** Shows the between-rounds "Working…" shimmer after the last round. */
  pending?: boolean
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
    prev.toolResults !== next.toolResults
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
 * A whole assistant turn as one message row: one avatar and header, then each
 * model round's parts in order, and a single usage footer summing the turn.
 */
export const AssistantGroup = memo(function AssistantGroup({
  messages,
  streamingIndex,
  pending = false,
  toolResults,
  toolRuns,
}: AssistantGroupProps) {
  const { t } = useI18n()
  const live = streamingIndex >= 0 || pending
  const model = [...messages].reverse().find((message) => message.model)?.model ?? t('chat.assistantFallback')
  const usage = live ? null : totalUsage(messages)
  const hasParts = live || messages.some((message) => message.content.length > 0 || message.errorMessage)

  if (!hasParts) return null

  return (
    <Message from="assistant" animateIn>
      <MessageAvatar>
        <Bot />
      </MessageAvatar>
      <MessageContent className="gap-3">
        <MessageHeader>
          <span>{model}</span>
          <span>{formatTime(messages[0].timestamp)}</span>
        </MessageHeader>

        {messages.map((message, index) => (
          <AssistantParts
            key={`${message.timestamp}-${index}`}
            message={message}
            streaming={index === streamingIndex}
            toolResults={toolResults}
            toolRuns={toolRuns}
          />
        ))}

        {pending ? (
          <div className="flex items-center gap-2 px-1 text-sm text-muted-foreground">
            <ThinkingShimmer>{t('chat.working')}</ThinkingShimmer>
          </div>
        ) : null}

        {usage ? (
          <MessageFooter>
            {t('chat.usage', {
              input: formatTokenCount(usage.input + (usage.cacheRead ?? 0)),
              output: formatTokenCount(usage.output),
              cost: formatCost(usage.cost?.total ?? 0)
            })}
          </MessageFooter>
        ) : null}
      </MessageContent>
    </Message>
  )
}, assistantGroupPropsEqual)
