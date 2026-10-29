import { estimateTokens, type AgentSession } from '@earendil-works/pi-coding-agent'
import { currentSystemPrompt, currentTools } from './transcript-context'

type StreamFunction = AgentSession['agent']['streamFunction']
type RequestContext = Parameters<StreamFunction>[1]
type RequestMessage = RequestContext['messages'][number]
type RequestModel = Parameters<StreamFunction>[0]
type RequestOptions = Parameters<StreamFunction>[2]

/** Mirrors the provider's framing safety margin, not a tokenizer guarantee. */
const SAFETY_TOKENS = 4096
const MESSAGE_FRAMING_TOKENS = 12
const RETAINED_RESULT_TOKENS = 512
const REPORT_RESULT_LIMIT = 256
const STATE_TOOLS = new Set(['todo_write', 'submit_plan', 'present', 'scheduled_task'])

export interface ContextBudgetSettings {
  /** The SDK's existing compaction settings remain the policy source. */
  reserveTokens: number
  keepRecentTokens: number
  /** Identifies the persisted user turn before ephemeral context reminders. */
  latestUserTimestamp?: number
}

export interface ContextBudgetReport {
  version: 1
  estimation: 'heuristic'
  estimator: 'sdk-chars/4+framing'
  status: 'within-budget' | 'shortened' | 'protected-over-budget' | 'unknown-window'
  contextWindow: number | null
  replyReserveTokens: number
  safetyTokens: number
  inputBudgetTokens: number | null
  systemTokensEstimate: number
  toolDefinitionTokensEstimate: number
  dialogueTokensEstimate: number
  toolResultTokensBeforeEstimate: number
  toolResultTokensAfterEstimate: number
  recentBudgetTokens: number
  recentTokensProtectedEstimate: number
  originalInputTokensEstimate: number
  requestInputTokensEstimate: number
  remainingOverBudgetTokensEstimate: number | null
  shortenedToolResultCount: number
  shortenedToolResults: Array<{
    toolCallId: string
    toolName: string
    beforeTokensEstimate: number
    afterTokensEstimate: number
    omittedUtf16Units: number
  }>
  omittedReportResultCount: number
}

export type BudgetedContext = RequestContext & { contextBudget: ContextBudgetReport }

function nonnegative(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback
}

function messageTokens(message: RequestMessage): number {
  // The transcript carries prompt/tool declarations as system messages. They
  // have their own estimate below and must not enter the dialogue total twice.
  if (message.role === 'system') return 0
  return estimateTokens(message) + MESSAGE_FRAMING_TOKENS
}

/** Avoid manufacturing a lone surrogate at a truncation boundary. */
function prefix(text: string, length: number): string {
  let end = Math.min(text.length, length)
  if (end > 0 && end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--
  return text.slice(0, end)
}

function suffix(text: string, length: number): string {
  let start = Math.max(0, text.length - length)
  if (start > 0 && start < text.length && /[\uDC00-\uDFFF]/.test(text[start])) start++
  return text.slice(start)
}

/** Preserve images and block ordering, with one explicit omission marker. */
function shortenResult(message: Extract<RequestMessage, { role: 'toolResult' }>): {
  message: typeof message; omittedUtf16Units: number
} | null {
  const total = message.content.reduce((sum, block) => sum + (block.type === 'text' ? block.text.length : 0), 0)
  const marker = '\n[Earlier tool result shortened for this request. Full output remains in the execution trace; retrieve details again only when safe.]\n'
  const retained = RETAINED_RESULT_TOKENS * 4 - marker.length
  if (total <= retained + marker.length) return null
  const head = Math.ceil(retained * 0.6)
  const tailStart = total - (retained - head)
  let offset = 0
  let marked = false
  let kept = 0
  const content = message.content.map(block => {
    if (block.type !== 'text') return block
    const start = offset
    const end = offset += block.text.length
    const leading = prefix(block.text, Math.max(0, Math.min(block.text.length, head - start)))
    const trailing = suffix(block.text, Math.max(0, end - Math.max(start, tailStart)))
    kept += leading.length + trailing.length
    const omission = !marked && end > head && start < tailStart ? marker : ''
    if (omission) marked = true
    return { ...block, text: leading + omission + trailing }
  })
  return { message: { ...message, content }, omittedUtf16Units: total - kept }
}

/**
 * Request-only soft budget. No messages, calls, images or user instructions are
 * removed; only older large tool-result text can change. Protected input can
 * still exceed the heuristic budget, in which case the SDK owns compaction and
 * provider overflow recovery exactly as before.
 */
export function budgetRequestContext(
  model: RequestModel, context: RequestContext, options: RequestOptions,
  settings: ContextBudgetSettings
): BudgetedContext {
  const contextWindow = model.contextWindow > 0 && Number.isFinite(model.contextWindow) ? Math.floor(model.contextWindow) : null
  const modelReplyLimit = nonnegative(model.maxTokens, 16384) || 16384
  const replyReserveTokens = nonnegative(options?.maxTokens, Math.min(modelReplyLimit, nonnegative(settings.reserveTokens, 16384)))
  const recentBudgetTokens = nonnegative(settings.keepRecentTokens, 20000)
  const systemTokensEstimate = Math.ceil(currentSystemPrompt(context).length / 4)
  const toolDefinitionTokensEstimate = Math.ceil(JSON.stringify(currentTools(context).map(tool => ({
    name: tool.name, description: tool.description, parameters: tool.parameters, constrainedSampling: tool.constrainedSampling
  }))).length / 4)
  const estimates = context.messages.map(messageTokens)
  const toolResultTokensBeforeEstimate = context.messages.reduce((sum, message, index) => sum + (message.role === 'toolResult' ? estimates[index] : 0), 0)
  const messageTotal = estimates.reduce((sum, tokens) => sum + tokens, 0)
  const originalInputTokensEstimate = systemTokensEstimate + toolDefinitionTokensEstimate + messageTotal
  const inputBudgetTokens = contextWindow === null ? null : Math.max(0, contextWindow - replyReserveTokens - SAFETY_TOKENS)

  // Protect a recent suffix, and the latest tool-call batch even if that batch
  // alone exceeds keepRecentTokens. A parallel batch must remain fully visible.
  let recentStart = context.messages.length
  let recentTokensProtectedEstimate = 0
  for (let i = context.messages.length - 1; i >= 0; i--) {
    if (recentTokensProtectedEstimate + estimates[i] > recentBudgetTokens && i < context.messages.length - 1) break
    recentStart = i
    recentTokensProtectedEstimate += estimates[i]
    if (recentTokensProtectedEstimate >= recentBudgetTokens) break
  }
  let latestUser = context.messages.findLastIndex(message => message.role === 'user' &&
    (settings.latestUserTimestamp === undefined || message.timestamp === settings.latestUserTimestamp))
  if (latestUser < 0) latestUser = context.messages.findLastIndex(message => message.role === 'user')
  let latestBatch = -1
  for (let i = context.messages.length - 1; i > latestUser; i--) {
    const message = context.messages[i]
    if (message.role === 'assistant' && message.content.some(block => block.type === 'toolCall')) { latestBatch = i; break }
  }
  if (latestBatch >= 0 && latestBatch < recentStart) {
    for (let i = latestBatch; i < recentStart; i++) recentTokensProtectedEstimate += estimates[i]
    recentStart = latestBatch
  }

  // A result is eligible only if the matching call is still present. Unknown
  // or extension-reconstructed result provenance is preserved rather than
  // guessed; retaining every message also preserves provider call/result pairs.
  const callIds = new Set<string>()
  for (const message of context.messages) {
    if (message.role === 'assistant') for (const block of message.content) if (block.type === 'toolCall') callIds.add(block.id)
  }
  let messages = context.messages
  const shortenedToolResults: ContextBudgetReport['shortenedToolResults'] = []
  let shortenedToolResultCount = 0
  let requestInputTokensEstimate = originalInputTokensEstimate
  for (let i = 0; inputBudgetTokens !== null && requestInputTokensEstimate > inputBudgetTokens && i < recentStart; i++) {
    const message = messages[i]
    if (message.role !== 'toolResult' || STATE_TOOLS.has(message.toolName) || !callIds.has(message.toolCallId)) continue
    const shortened = shortenResult(message)
    if (!shortened) continue
    const afterTokensEstimate = messageTokens(shortened.message)
    if (afterTokensEstimate >= estimates[i]) continue
    if (messages === context.messages) messages = [...context.messages]
    messages[i] = shortened.message
    requestInputTokensEstimate -= estimates[i] - afterTokensEstimate
    shortenedToolResultCount++
    if (shortenedToolResults.length < REPORT_RESULT_LIMIT) shortenedToolResults.push({
      toolCallId: message.toolCallId, toolName: message.toolName,
      beforeTokensEstimate: estimates[i], afterTokensEstimate, omittedUtf16Units: shortened.omittedUtf16Units
    })
  }
  const remainingOverBudgetTokensEstimate = inputBudgetTokens === null ? null : Math.max(0, requestInputTokensEstimate - inputBudgetTokens)
  return {
    ...context,
    messages: shortenedToolResultCount ? messages : context.messages,
    contextBudget: {
      version: 1, estimation: 'heuristic', estimator: 'sdk-chars/4+framing',
      status: inputBudgetTokens === null ? 'unknown-window' : remainingOverBudgetTokensEstimate! > 0 ? 'protected-over-budget' : shortenedToolResultCount ? 'shortened' : 'within-budget',
      contextWindow, replyReserveTokens, safetyTokens: SAFETY_TOKENS, inputBudgetTokens,
      systemTokensEstimate, toolDefinitionTokensEstimate,
      dialogueTokensEstimate: messageTotal - toolResultTokensBeforeEstimate,
      toolResultTokensBeforeEstimate,
      toolResultTokensAfterEstimate: toolResultTokensBeforeEstimate - (originalInputTokensEstimate - requestInputTokensEstimate),
      recentBudgetTokens, recentTokensProtectedEstimate, originalInputTokensEstimate, requestInputTokensEstimate,
      remainingOverBudgetTokensEstimate, shortenedToolResultCount, shortenedToolResults,
      omittedReportResultCount: shortenedToolResultCount - shortenedToolResults.length
    }
  }
}

/** Install outside the recorder and inside Plan's system-prompt overlay. */
export function installContextBudgetOverlay(session: AgentSession, settings: (model: RequestModel) => ContextBudgetSettings): () => void {
  const previous = session.agent.streamFunction
  const overlay: StreamFunction = (model, context, options) => previous(model, budgetRequestContext(model, context, options, {
    ...settings(model), latestUserTimestamp: session.messages.findLast(message => message.role === 'user')?.timestamp
  }), options)
  session.agent.streamFunction = overlay
  return () => { if (session.agent.streamFunction === overlay) session.agent.streamFunction = previous }
}
