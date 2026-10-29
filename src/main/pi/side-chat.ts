import type { ModelRuntime } from '@earendil-works/pi-coding-agent'
import type { ChatMessage, SideChatEvent, SideChatHistoryEntry } from '../../shared/types'

/**
 * Side chat (`/btw`): a single no-tools completion over a snapshot of the
 * session, plus the side exchanges asked before it.
 *
 * It is deliberately NOT an AgentSession. A side question must never enter the
 * session file, queue behind a running prompt, or reach the extension runner —
 * and it has no tools, so the model cannot touch the workspace the main run is
 * editing. Building it out of `ModelRuntime.streamSimple` makes all of that
 * true by construction instead of by discipline: there is no session to leak
 * into, and nothing to dispose when the tab closes.
 *
 * The system prompt is the other half of the design. Handing a stock
 * coding-agent prompt the session's (tool-call-shaped) history makes models try
 * to call tools anyway; with no tools declared, providers return that markup as
 * ordinary answer text and the user reads garbage. Telling the model plainly
 * that it has no tools and must answer from the context is what keeps the
 * answer clean.
 */

/** Wire shapes accepted by `ModelRuntime.streamSimple`. Taken from the method
 * itself, so the app never imports pi-ai directly (it is a nested dependency of
 * the SDK, not one of ours). */
export type SideChatContext = Parameters<ModelRuntime['streamSimple']>[1]
export type SideChatModel = Parameters<ModelRuntime['streamSimple']>[0]
type SideChatStreamOptions = NonNullable<Parameters<ModelRuntime['streamSimple']>[2]>
/** Effort the answer runs at — the bound session's own thinking level. */
export type SideChatReasoning = SideChatStreamOptions['reasoning']
type WireMessage = SideChatContext['messages'][number]
type WireText = { type: 'text'; text: string }
type WireImage = { type: 'image'; data: string; mimeType: string }
type WireToolCall = { type: 'toolCall'; id: string; name: string; arguments: Record<string, unknown> }

/** Prior side exchanges replayed as plain user/assistant text (newest kept). */
export const SIDE_CHAT_HISTORY_LIMIT = 20
/** Caps on the incoming question, mirroring the history replay bounds. */
export const SIDE_CHAT_QUESTION_CHAR_LIMIT = 16_000
/** Keeps one slow provider from hanging an exchange forever. */
const SIDE_CHAT_TIMEOUT_MS = 120_000

/**
 * Usage for the replayed assistant messages. pi-ai's stream path estimates
 * context tokens from assistant usage and reads `totalTokens` unguarded, so a
 * message without one crashes the side call before it starts; zero simply means
 * "not a context anchor" to that estimator.
 */
const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
}

export function sideChatSystemPrompt(cwd?: string | null): string {
  const lines = [
    'You are answering a "by the way" side question about an ongoing coding-agent session.',
    'You have no tools. Do not attempt to use any, and never emit tool-call syntax: answer in prose.',
    'The work described in the context was done by the main agent, not by you — never continue it, and never ask for permission to run anything.',
    '',
    'The session history follows as a plain transcript: user messages, assistant replies, and notes holding what tool calls produced.',
    '',
    'Rules:',
    '- Answer only from that transcript. You cannot read files, run commands, or search.',
    '- Be concise and direct. Reply in the language the question is asked in.',
    '- If the transcript does not contain the answer (for example the agent is still working on it), say so plainly instead of guessing.',
    '- This exchange is a side channel: it never enters the main conversation and the main task is unaffected.'
  ]
  if (cwd) lines.push('', `The session's working directory: ${cwd}`)
  return lines.join('\n')
}

/** Marker tool output carries into the replayed context. */
const TOOL_OUTPUT_NOTE = '[tool output'
/** Markers for the transcript entries that are not plain chat. */
const SUMMARY_NOTE = '[conversation summary — earlier context]'
const SHELL_NOTE = '[shell command]'

/** Prose of a message's content, ignoring thinking and tool-call parts. */
function textOf(content: readonly { type: string; text?: string }[]): string {
  return content
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('')
    .trim()
}

/**
 * The session as plain chat turns: user prose, assistant prose, and tool output
 * folded into short text notes.
 *
 * Deliberately NOT the wire tool-call shape. A session is full of tool calls,
 * and handing them to a model that has none invites two failures at once: it
 * imitates the pattern and emits tool-call markup of its own — which, with no
 * tools declared, comes back as ordinary answer text the user reads as garbage —
 * and a context that ends mid-tool-round reads as "keep working", so the model
 * continues the task instead of answering the side question. Folding output into
 * text keeps what a side question is actually about (what a command printed,
 * what a file contained) without either signal.
 */
export function mapSessionMessages(messages: readonly ChatMessage[]): WireMessage[] {
  const out: WireMessage[] = []
  const appendToolOutput = (text: string, failed: boolean, timestamp: number): void => {
    if (!text) return
    const note = `${TOOL_OUTPUT_NOTE}${failed ? ' (failed)' : ''}]\n${text}`
    const last = out[out.length - 1]
    // Consecutive results of one round read as one note instead of a stack of
    // single-line user messages.
    if (last?.role === 'user' && typeof last.content === 'string' && last.content.startsWith(TOOL_OUTPUT_NOTE)) {
      out[out.length - 1] = { ...last, content: `${last.content}\n\n${note}` } as WireMessage
      return
    }
    out.push({ role: 'user', content: note, timestamp } as WireMessage)
  }

  for (const message of messages) {
    switch (message.role) {
      case 'user': {
        const content =
          typeof message.content === 'string'
            ? message.content
            : message.content.flatMap((block): (WireText | WireImage)[] => {
                if (block.type === 'text') return block.text ? [{ type: 'text', text: block.text }] : []
                if (block.type === 'image') {
                  return [{ type: 'image', data: block.data, mimeType: block.mimeType }]
                }
                return []
              })
        if (typeof content !== 'string' && content.length === 0) break
        out.push({ role: 'user', content, timestamp: message.timestamp } as WireMessage)
        break
      }
      case 'assistant': {
        // Text only — no tool calls, and no thinking (a side call never
        // produced it, and some providers reject replayed thinking).
        const text = textOf(message.content)
        if (!text) break
        out.push({
          ...message,
          content: [{ type: 'text', text }],
          usage: message.usage ?? ZERO_USAGE
        } as unknown as WireMessage)
        break
      }
      case 'toolResult':
        appendToolOutput(textOf(message.content), message.isError, message.timestamp)
        break
      case 'compactionSummary':
      case 'branchSummary':
        out.push({
          role: 'user',
          content: `${SUMMARY_NOTE}\n${message.summary}`,
          timestamp: message.timestamp
        } as WireMessage)
        break
      case 'bashExecution': {
        if (message.excludeFromContext) break
        appendToolOutput(
          `${SHELL_NOTE} ${message.command}\n${message.output}`,
          Boolean(message.exitCode),
          message.timestamp
        )
        break
      }
      default:
        // Extension-injected display messages are UI-only.
        break
    }
  }

  // A side chat is usually opened mid-run, so the snapshot can end on output
  // that is still in flight; without this the model answers THAT instead of the
  // question the user is about to ask.
  while (out.length > 0) {
    const last = out[out.length - 1]
    if (last.role === 'user' && typeof last.content === 'string' && last.content.startsWith(TOOL_OUTPUT_NOTE)) {
      out.pop()
      continue
    }
    break
  }
  return out
}

/** Append a user turn as its own message: consecutive user roles are valid and
 * keeping the snapshot prefix untouched preserves provider prompt-cache hits. */
function appendUser(messages: WireMessage[], text: string, timestamp: number): void {
  messages.push({ role: 'user', content: text, timestamp } as WireMessage)
}

/** The side chat's own earlier exchanges, replayed as plain chat turns. */
function appendHistory(messages: WireMessage[], history: readonly SideChatHistoryEntry[]): void {
  for (const exchange of history.slice(-SIDE_CHAT_HISTORY_LIMIT)) {
    appendUser(messages, exchange.question, 0)
    messages.push({
      role: 'assistant',
      content: [{ type: 'text', text: exchange.answer || '(no answer)' }],
      stopReason: 'stop',
      usage: ZERO_USAGE,
      timestamp: 0
    } as WireMessage)
  }
}

export function buildSideChatContext(input: {
  sessionMessages: readonly ChatMessage[]
  history: readonly SideChatHistoryEntry[]
  question: string
  cwd?: string | null
}): SideChatContext {
  const messages = mapSessionMessages(input.sessionMessages)
  appendHistory(messages, input.history)
  appendUser(messages, input.question, Date.now())
  return { systemPrompt: sideChatSystemPrompt(input.cwd), messages }
}

/** Text deltas are per-token from some providers; coalesce before IPC. */
const DELTA_FLUSH_MS = 50

export interface SideChatRunOptions {
  runtime: ModelRuntime
  model: SideChatModel
  /** Session thinking level, inherited so a side answer reasons like the run it
   * is asked about ('off' is simply the absence of an effort override). */
  reasoning?: SideChatReasoning
  exchangeId: string
  context: SideChatContext
  signal: AbortSignal
  emit: (event: SideChatEvent) => void
}

type StreamOutcome =
  | { status: 'done' }
  | { status: 'aborted' }
  | { status: 'error'; message: string }

/** Stream one answer, emitting coalesced text deltas. */
async function streamAnswer(
  options: SideChatRunOptions,
  context: SideChatContext
): Promise<StreamOutcome> {
  const { runtime, model, reasoning, exchangeId, signal, emit } = options
  let pending = ''
  let flushTimer: ReturnType<typeof setTimeout> | null = null
  const flush = () => {
    if (flushTimer) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
    if (!pending) return
    emit({ type: 'delta', exchangeId, text: pending })
    pending = ''
  }
  try {
    for await (const event of runtime.streamSimple(model, context, {
      signal,
      timeoutMs: SIDE_CHAT_TIMEOUT_MS,
      ...(reasoning ? { reasoning } : {})
    })) {
      if (event.type === 'text_delta') {
        pending += event.delta
        if (!flushTimer) flushTimer = setTimeout(flush, DELTA_FLUSH_MS)
        continue
      }
      if (event.type === 'done') {
        flush()
        emit({ type: 'done', exchangeId })
        return { status: 'done' }
      }
      if (event.type === 'error') {
        flush()
        if (event.reason === 'aborted') return { status: 'aborted' }
        return {
          status: 'error',
          message: event.error.errorMessage || 'The model stream failed'
        }
      }
    }
    flush()
    return { status: 'done' }
  } catch (error) {
    flush()
    if (signal.aborted) return { status: 'aborted' }
    return {
      status: 'error',
      message: error instanceof Error ? error.message : String(error)
    }
  } finally {
    if (flushTimer) clearTimeout(flushTimer)
  }
}

/** Run one side exchange to completion, emitting deltas as they arrive. */
export async function runSideChatAnswer(options: SideChatRunOptions): Promise<void> {
  const { emit, exchangeId } = options
  const outcome = await streamAnswer(options, options.context)
  if (outcome.status === 'aborted') emit({ type: 'aborted', exchangeId })
  else if (outcome.status === 'error') emit({ type: 'error', exchangeId, message: outcome.message })
}
