/**
 * ask_user_question: the app-owned human-in-the-loop question tool.
 *
 * Two halves live here, both ported from pi-web (lib/ask-user*.ts) onto this
 * app's own precedents:
 *
 * - a pending-question registry shaped exactly like the sandbox escalation
 *   one (src/main/sandbox/pending.ts): the tool's execute suspends on a
 *   module-level Map, the renderer answers through IPC, and every teardown
 *   path (abort signal, session dispose, child-run teardown) settles as
 *   cancelled so the agent loop can never hang.
 * - the tool definition, registered as a customTool exactly like todo_write.
 *
 * Two modes (the model chooses):
 * - `blocking` (default) is Claude Code's semantics: the call waits for the
 *   user as long as they want. Skipping is an explicit cancel the model is
 *   told to continue past, never an error.
 * - `async` is the background-command shape: the call returns a receipt at
 *   once, the model keeps working, and the outcome is steered into the session
 *   later by AskUserNotifications. An async question therefore does NOT take
 *   the tool call's abort signal — the user can still answer it after the call
 *   that asked it has ended.
 *
 * Both modes carry an app-wide auto-settle deadline (Settings → General). It
 * measures ENGAGEMENT, not elapsed time: the countdown starts when the panel
 * appears and the user's first real interaction cancels it for good, so a
 * question the user is actually working on never expires under them.
 *
 * Subagent children register their questions under the PARENT's session path
 * (a child has no composer, so its question could never be answered there)
 * with a source marker; the parent's panel shows the badge and answering
 * resolves the child's call.
 */
import { randomUUID } from 'node:crypto'
import { Type } from 'typebox'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import {
  ASK_USER_KIND,
  ASK_USER_MAX_OPTIONS,
  ASK_USER_MAX_QUESTIONS,
  ASK_USER_MIN_OPTIONS,
  ASK_USER_TOOL_NAME,
  formatAskUserResultText,
  normalizeAskUserAnswers,
  normalizeAskUserQuestions
} from '../../shared/ask-user'
import type {
  AskUserAnswer,
  AskUserMode,
  AskUserQuestion,
  AskUserResolution,
  AskUserSource,
  AskUserToolDetails,
  PendingAskUserDTO
} from '../../shared/ask-user'

// ---- pending registry (main-process memory; nothing is persisted) ----

interface RegistryEntry extends PendingAskUserDTO {
  settle: (resolution: AskUserResolution) => void
  notify: () => void
  /** Auto-settle deadline; cleared on any settle and on engagement. */
  timer?: ReturnType<typeof setTimeout>
}

const registry = new Map<string, RegistryEntry>()

function clearEntryTimer(entry: RegistryEntry): void {
  if (entry.timer === undefined) return
  clearTimeout(entry.timer)
  entry.timer = undefined
}

/** Pending questions for one owning chat, oldest first. */
export function listPendingAskUser(ownerPath: string): PendingAskUserDTO[] {
  return [...registry.values()]
    .filter((entry) => entry.sessionPath === ownerPath)
    .sort((a, b) => a.createdAt - b.createdAt)
    .map(({ settle: _settle, notify: _notify, timer: _timer, ...rest }) => {
      void _settle
      void _notify
      void _timer
      return { ...rest }
    })
}

/**
 * Answer one question. The owner path is part of the check — an id alone must
 * never settle another chat's question. Answers are validated against the
 * entry's own question list (label whitelist, per-question alignment), which
 * is why the pending entry is read here rather than trusted from the caller.
 */
export function respondAskUserRequest(
  requestId: string,
  ownerPath: string,
  payload: { answers?: AskUserAnswer[]; cancelled?: boolean }
): boolean {
  const entry = registry.get(requestId)
  if (!entry || entry.sessionPath !== ownerPath) return false
  if (payload.cancelled === true) {
    settleEntry(entry, requestId, { status: 'cancelled', reason: 'dismissed' })
    return true
  }
  const answers = normalizeAskUserAnswers(entry.questions, payload.answers)
  if (!answers) return false
  settleEntry(entry, requestId, { status: 'answered', answers })
  return true
}

/**
 * The user touched the panel. Engagement cancels the countdown for good (it is
 * not restarted by later idling), and it is published so a re-mounted panel
 * stops showing one. Collapsing deliberately does not come through here: it
 * parks the question, it does not engage it.
 */
export function engageAskUser(requestId: string, ownerPath: string): boolean {
  const entry = registry.get(requestId)
  if (!entry || entry.sessionPath !== ownerPath || entry.engaged) return false
  entry.engaged = true
  clearEntryTimer(entry)
  entry.notify()
  return true
}

function settleEntry(entry: RegistryEntry, requestId: string, resolution: AskUserResolution): void {
  clearEntryTimer(entry)
  registry.delete(requestId)
  entry.settle(resolution)
  entry.notify()
}

/**
 * Suspend waiting for the user. `onChanged` fires on registration and on every
 * settle so the manager can republish the pending list. An aborted signal
 * (Stop/Esc, rewind, resend, dispose) settles as cancelled — never an error.
 */
export function waitForAskUser(
  request: {
    sessionPath: string
    questions: AskUserQuestion[]
    source?: AskUserSource
    mode?: AskUserMode
    timeoutMs?: number
  },
  onChanged: () => void,
  signal?: AbortSignal
): Promise<AskUserResolution> {
  if (signal?.aborted) return Promise.resolve({ status: 'cancelled', reason: 'aborted' })
  return new Promise((resolve) => {
    const requestId = randomUUID()
    const entry: RegistryEntry = {
      requestId,
      sessionPath: request.sessionPath,
      questions: request.questions,
      createdAt: Date.now(),
      ...(request.mode ? { mode: request.mode } : {}),
      ...(request.timeoutMs ? { timeoutMs: request.timeoutMs } : {}),
      ...(request.source ? { source: request.source } : {}),
      settle: (resolution) => {
        signal?.removeEventListener('abort', onAbort)
        clearEntryTimer(entry)
        resolve(resolution)
      },
      notify: onChanged
    }
    const onAbort = () => {
      if (registry.get(requestId) === entry) settleEntry(entry, requestId, { status: 'cancelled', reason: 'aborted' })
      else entry.settle({ status: 'cancelled', reason: 'aborted' })
    }
    registry.set(requestId, entry)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (request.timeoutMs && request.timeoutMs > 0) {
      entry.timer = setTimeout(() => {
        if (registry.get(requestId) !== entry) return
        settleEntry(entry, requestId, { status: 'cancelled', reason: 'timeout' })
      }, request.timeoutMs)
      // The deadline must never be the last thing keeping the process alive.
      entry.timer.unref?.()
    }
    onChanged()
  })
}

/** Settle every question an owning chat still has open (dispose, delete, quit). */
export function clearSessionAskUserRequests(ownerPath: string): void {
  for (const entry of [...registry.values()]) {
    if (entry.sessionPath !== ownerPath) continue
    settleEntry(entry, entry.requestId, { status: 'cancelled', reason: 'aborted' })
  }
}

/**
 * Settle only one child run's questions. A child's questions live under the
 * parent's path, so clearing the parent key would also kill the parent chat's
 * own questions — teardown of one run must filter by its source instead.
 */
export function clearSubagentAskUserRequests(childPath: string): void {
  for (const entry of [...registry.values()]) {
    if (entry.source?.kind !== 'subagent' || entry.source.sessionPath !== childPath) continue
    settleEntry(entry, entry.requestId, { status: 'cancelled', reason: 'aborted' })
  }
}

// ---- the tool ----

const parameters = Type.Object({
  mode: Type.Optional(
    Type.Union([Type.Literal('blocking'), Type.Literal('async')], {
      description:
        'blocking (default): wait for the user before continuing. async: return immediately and keep working; the answer (or the fact there is none) arrives later as a message.'
    })
  ),
  questions: Type.Array(
    Type.Object({
      question: Type.String({ description: 'The complete question text, self-contained' }),
      header: Type.Optional(Type.String({ description: 'Short tab label for the question (max 12 chars)' })),
      options: Type.Array(
        Type.Object({
          label: Type.String({ description: 'Concise display label for the option' }),
          description: Type.Optional(Type.String({ description: 'One-line explanation shown under the label' }))
        }),
        { minItems: ASK_USER_MIN_OPTIONS, maxItems: ASK_USER_MAX_OPTIONS, description: '2-4 candidate answers' }
      ),
      multiSelect: Type.Optional(Type.Boolean({ description: 'Allow choosing multiple options (checkboxes)' }))
    }),
    { minItems: 1, maxItems: ASK_USER_MAX_QUESTIONS, description: '1-4 questions asked together in one card' }
  )
})

/** One settled (or dispatched) question set as the tool result details. */
export function askUserDetailsOf(
  questions: AskUserQuestion[],
  mode: AskUserMode,
  outcome: AskUserResolution
): AskUserToolDetails {
  if (outcome.status === 'answered') {
    return { kind: ASK_USER_KIND, status: 'answered', questions, answers: outcome.answers, mode }
  }
  return { kind: ASK_USER_KIND, status: 'cancelled', questions, answers: null, mode, reason: outcome.reason }
}

export interface AskUserToolDeps {
  /** Owning chat path: the parent session's path for subagent children. */
  ownerPath: string
  /** Source badge when a subagent child asks in its parent's panel. */
  source?: AskUserSource
  /** Republishes the owner's pending list (registration + every settle). */
  onChanged: () => void
  /** Fails closed into a cancelled result during teardown windows. */
  canStart: () => boolean
  /**
   * The app-wide auto-settle deadline in ms (read live, so a settings change
   * applies to the next question). 0 disables the countdown.
   */
  timeoutMs: () => number
  /**
   * Where an async outcome goes: the manager hands it to the session's
   * AskUserNotifications outbox, which steers it in when the user answers.
   */
  deliverAsync?: (delivery: { toolCallId: string; details: AskUserToolDetails; text: string }) => void
}

export function createAskUserTool(deps: AskUserToolDeps): ToolDefinition<typeof parameters> {
  return {
    name: ASK_USER_TOOL_NAME,
    label: 'Ask user',
    parameters,
    executionMode: 'sequential',
    description: [
      'Ask the user 1-4 structured questions to gather information or decisions you cannot infer yourself.',
      'Each question offers 2-4 candidate options (a short label plus an optional explanation); the user picks one, checks several when multiSelect is set, and can always type a free-form answer instead.',
      'Use it when the answer changes what you do next (scope, preference, strategy, missing context).',
      'Mode "async" returns immediately and delivers the answer later as a message — use it when you have independent work to do meanwhile; "blocking" (the default) waits when the answer decides your next step.',
      'Questions auto-close after a while if the user never touches them.',
      'Do NOT use it to confirm actions you are already allowed to take, for yes/no questions you can settle yourself, or to dump questions the user already answered.'
    ].join(' '),
    promptSnippet: 'Ask the user structured questions when the answer changes what you do next.',
    promptGuidelines: [
      'Ask only for user-owned decisions or missing facts that change your next step, never to reconfirm authorized work. Use async while independent work remains. Do not duplicate open/dismissed questions; after dismissal, proceed with stated assumptions.'
    ],
    async execute(toolCallId, args, signal) {
      const questions = normalizeAskUserQuestions(args.questions)
      if (!questions) {
        return {
          content: [{
            type: 'text' as const,
            text: `Error: questions must be 1-${ASK_USER_MAX_QUESTIONS} items, each with ${ASK_USER_MIN_OPTIONS}-${ASK_USER_MAX_OPTIONS} non-empty options (label) and a non-empty question.`
          }],
          details: undefined,
          isError: true
        }
      }
      const mode: AskUserMode = args.mode === 'async' ? 'async' : 'blocking'
      // A session mid-teardown has no answerer left: resolve as a dismissal
      // rather than registering a question nothing will ever settle.
      if (!deps.canStart()) {
        const details: AskUserToolDetails = {
          kind: ASK_USER_KIND,
          status: 'cancelled',
          questions,
          answers: null,
          mode,
          reason: 'aborted'
        }
        return {
          content: [{ type: 'text' as const, text: formatAskUserResultText('cancelled', questions, null, { reason: 'aborted' }) }],
          details
        }
      }
      const timeoutMs = Math.max(0, Math.round(deps.timeoutMs()))
      const resolution = waitForAskUser(
        {
          sessionPath: deps.ownerPath,
          questions,
          mode,
          ...(timeoutMs > 0 ? { timeoutMs } : {}),
          ...(deps.source ? { source: deps.source } : {})
        },
        deps.onChanged,
        // An async question outlives the call that asked it: the call's abort
        // signal must not cancel something the user can still answer. Session
        // teardown settles it through the registry instead.
        mode === 'blocking' ? signal : undefined
      )
      if (mode === 'async') {
        void resolution.then((outcome) => {
          const details = askUserDetailsOf(questions, mode, outcome)
          deps.deliverAsync?.({
            toolCallId,
            details,
            text: formatAskUserResultText(
              outcome.status,
              questions,
              details.answers,
              outcome.status === 'cancelled' ? { reason: outcome.reason, timeoutSeconds: Math.round(timeoutMs / 1000) } : {}
            )
          })
        })
        const receipt: AskUserToolDetails = { kind: ASK_USER_KIND, status: 'pending', questions, answers: null, mode }
        return {
          content: [{ type: 'text' as const, text: formatAskUserResultText('pending', questions, null) }],
          details: receipt
        }
      }
      const outcome = await resolution
      const details = askUserDetailsOf(questions, mode, outcome)
      return {
        content: [{
          type: 'text' as const,
          text: formatAskUserResultText(
            outcome.status,
            questions,
            details.answers,
            outcome.status === 'cancelled' ? { reason: outcome.reason, timeoutSeconds: Math.round(timeoutMs / 1000) } : {}
          )
        }],
        details
      }
    }
  }
}
