/**
 * The ask_user_question tool's protocol: shared types plus defensive
 * normalizers used by all three sides — the tool (registration/waiting in
 * main), the pending-question payload (snapshot + metadata event) and the
 * transcript's Q&A card (tool result details).
 *
 * Ported from pi-web's lib/ask-user-protocol.ts. Semantics follow Claude
 * Code's AskUserQuestion: one call asks 1-4 questions, each with 2-4
 * candidate options (a label plus an optional explanation), optionally
 * multi-select, and the user can always type a free-form answer instead.
 * Skipping is an explicit non-error: the model is told the user did not
 * answer and continues with stated assumptions.
 */

export const ASK_USER_TOOL_NAME = 'ask_user_question'
/** `details.kind` marker on a settled ask_user_question tool result. */
export const ASK_USER_KIND = 'pi-app-ask-user'
/**
 * The custom message an ASYNC question's outcome arrives as. An async call
 * returns a receipt immediately and the model keeps working; the answer (or
 * the reason there is none) is steered into the session later.
 */
export const ASK_USER_ANSWER_TYPE = 'ask_user_answer'

/**
 * blocking — the tool call waits for the user (Claude Code semantics).
 * async — like a background command: the call returns at once and the outcome
 * is delivered as a message, because the user may answer much later.
 */
export type AskUserMode = 'blocking' | 'async'

/** Why a question set ended without answers. */
export type AskUserCancelReason = 'dismissed' | 'timeout' | 'aborted'

/** The app-wide auto-settle deadline (Settings → General), in seconds. */
export const ASK_USER_DEFAULT_TIMEOUT_S = 120
export const ASK_USER_MIN_TIMEOUT_S = 10
export const ASK_USER_MAX_TIMEOUT_S = 3600

/** Clamp a seconds value into the documented range; NaN falls back to the default. */
export function clampAskUserTimeoutSeconds(value: number): number {
  if (!Number.isFinite(value)) return ASK_USER_DEFAULT_TIMEOUT_S
  return Math.min(ASK_USER_MAX_TIMEOUT_S, Math.max(ASK_USER_MIN_TIMEOUT_S, Math.round(value)))
}

export const ASK_USER_MAX_QUESTIONS = 4
export const ASK_USER_MIN_OPTIONS = 2
export const ASK_USER_MAX_OPTIONS = 4
/** Display truncation for a question's short header (Claude Code's 12 chars). */
export const ASK_USER_HEADER_MAX_CHARS = 12

export interface AskUserOption {
  label: string
  description?: string
}

export interface AskUserQuestion {
  question: string
  /** Short tab label; the panel falls back to the question's ordinal. */
  header?: string
  options: AskUserOption[]
  /** true = checkboxes (several picks + free text coexist); false/absent = radio. */
  multiSelect?: boolean
}

/** One question's answer: picked option labels plus optional free text. */
export interface AskUserAnswer {
  question: string
  selected: string[]
  custom?: string
}

export type AskUserResolution =
  | { status: 'answered'; answers: AskUserAnswer[] }
  | { status: 'cancelled'; reason: AskUserCancelReason }

/**
 * A subagent child's question: registered under the parent's session path so
 * the parent's panel can answer it, with the child identified for the badge
 * and for source-scoped cleanup when that run goes away.
 */
export interface AskUserSource {
  kind: 'subagent'
  sessionPath: string
  profile?: string
}

/** One pending question set, as the renderer receives it. */
export interface PendingAskUserDTO {
  requestId: string
  /** Owning chat: the parent session's path for subagent children. */
  sessionPath: string
  questions: AskUserQuestion[]
  createdAt: number
  /** How the asking call interacts with the run (defaults to blocking). */
  mode?: AskUserMode
  /**
   * Auto-settle deadline in ms, counted from `createdAt`. The user's FIRST
   * real interaction (picking, typing, navigating — deliberately not
   * collapsing) cancels it for good, which is why `engaged` is published
   * rather than kept renderer-side.
   */
  timeoutMs?: number
  /** True once the user has touched the panel; the countdown is over. */
  engaged?: boolean
  source?: AskUserSource
}

/** Tool result details the transcript card renders. */
export interface AskUserToolDetails {
  kind: typeof ASK_USER_KIND
  /** `pending` = an async call's receipt; the outcome arrives as a message. */
  status: 'answered' | 'cancelled' | 'pending'
  questions: AskUserQuestion[]
  answers: AskUserAnswer[] | null
  mode?: AskUserMode
  reason?: AskUserCancelReason
}

/**
 * One settled (or still-awaited) question set as the Q&A RECORD panel shows it.
 * Records are a projection of the session branch — a blocking call's tool result
 * and an async outcome's notice both land here, keyed by the call that asked.
 */
export type AskUserRecordDTO = Omit<AskUserToolDetails, 'kind'> & {
  /** The asking tool call; one record per call. */
  toolCallId: string
  /** When it settled — or when it was asked, while it is still open. */
  at: number
}

/** The five outcomes a record row labels itself with. */
export type AskUserRecordKind = 'answered' | 'dismissed' | 'timeout' | 'aborted' | 'pending'

/** `dismissed` and `aborted` are separate records even though both are cancels. */
export function askUserRecordKind(record: Pick<AskUserRecordDTO, 'status' | 'reason'>): AskUserRecordKind {
  if (record.status === 'answered') return 'answered'
  if (record.status === 'pending') return 'pending'
  return record.reason ?? 'dismissed'
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

/**
 * Validate and tighten a questions payload: at most 4 questions, each with
 * 2-4 non-empty options, empty labels dropped, stray fields stripped. Any
 * invalid question rejects the whole call — a half-delivered question list is
 * worse than an error (the model believes every question was asked).
 */
export function normalizeAskUserQuestions(input: unknown): AskUserQuestion[] | null {
  if (!Array.isArray(input) || input.length === 0) return null
  const questions: AskUserQuestion[] = []
  for (const raw of input) {
    const record = asRecord(raw)
    if (!record) return null
    const question = asTrimmedString(record.question)
    if (!question) return null
    if (!Array.isArray(record.options)) return null
    const options: AskUserOption[] = []
    for (const rawOption of record.options) {
      const optionRecord = asRecord(rawOption)
      if (!optionRecord) return null
      const label = asTrimmedString(optionRecord.label)
      if (!label) return null
      const description = asTrimmedString(optionRecord.description)
      options.push(description ? { label, description } : { label })
    }
    if (options.length < ASK_USER_MIN_OPTIONS) return null
    const header = asTrimmedString(record.header)
    questions.push({
      question,
      ...(header ? { header: header.slice(0, ASK_USER_HEADER_MAX_CHARS) } : {}),
      options: options.slice(0, ASK_USER_MAX_OPTIONS),
      ...(record.multiSelect === true ? { multiSelect: true } : {})
    })
    if (questions.length >= ASK_USER_MAX_QUESTIONS) break
  }
  return questions
}

/**
 * Validate submitted answers against the questions they answer: aligned by
 * index, `selected` filtered to labels that question actually offers, `custom`
 * trimmed. A question may legitimately come back empty (partial answers); the
 * transcript and the model-facing text mark those "(no answer)".
 */
export function normalizeAskUserAnswers(questions: AskUserQuestion[], input: unknown): AskUserAnswer[] | null {
  if (!Array.isArray(input) || input.length !== questions.length) return null
  const answers: AskUserAnswer[] = []
  for (let i = 0; i < questions.length; i++) {
    const record = asRecord(input[i])
    if (!record) return null
    const validLabels = new Set(questions[i]!.options.map((option) => option.label))
    const selected = Array.isArray(record.selected)
      ? [...new Set(record.selected.filter((label): label is string => typeof label === 'string' && validLabels.has(label)))]
      : []
    const custom = asTrimmedString(record.custom)
    answers.push({ question: questions[i]!.question, selected, ...(custom ? { custom } : {}) })
  }
  return answers
}

/** Defensive re-normalization of an event/snapshot payload; one bad entry is dropped, not the list. */
export function normalizePendingAskUser(input: unknown): PendingAskUserDTO | null {
  const record = asRecord(input)
  if (!record) return null
  const requestId = asTrimmedString(record.requestId)
  const sessionPath = asTrimmedString(record.sessionPath)
  const questions = normalizeAskUserQuestions(record.questions)
  const createdAt = typeof record.createdAt === 'number' && Number.isFinite(record.createdAt) ? record.createdAt : null
  if (!requestId || !sessionPath || !questions || createdAt === null) return null
  const sourceRecord = asRecord(record.source)
  const sourcePath = sourceRecord?.kind === 'subagent' ? asTrimmedString(sourceRecord.sessionPath) : null
  const sourceProfile = sourceRecord ? asTrimmedString(sourceRecord.profile) : null
  const mode: AskUserMode | undefined = record.mode === 'async' ? 'async' : record.mode === 'blocking' ? 'blocking' : undefined
  const timeoutMs = typeof record.timeoutMs === 'number' && Number.isFinite(record.timeoutMs) && record.timeoutMs > 0
    ? Math.round(record.timeoutMs)
    : undefined
  return {
    requestId,
    sessionPath,
    questions,
    createdAt,
    ...(mode ? { mode } : {}),
    ...(timeoutMs ? { timeoutMs } : {}),
    ...(record.engaged === true ? { engaged: true } : {}),
    ...(sourcePath ? { source: { kind: 'subagent', sessionPath: sourcePath, ...(sourceProfile ? { profile: sourceProfile } : {}) } } : {})
  }
}

export function normalizePendingAskUserList(input: unknown): PendingAskUserDTO[] {
  if (!Array.isArray(input)) return []
  return input.map(normalizePendingAskUser).filter((entry): entry is PendingAskUserDTO => entry !== null)
}

export function isAskUserToolDetails(details: unknown): details is AskUserToolDetails {
  const record = asRecord(details)
  if (!record || record.kind !== ASK_USER_KIND) return false
  return record.status === 'answered' || record.status === 'cancelled' || record.status === 'pending'
}

/** One answer's display string: picks + free text joined; null when unanswered. */
export function askUserAnswerText(answer: AskUserAnswer | undefined): string | null {
  if (!answer) return null
  const parts: string[] = []
  if (answer.selected.length > 0) parts.push(answer.selected.join('、'))
  if (answer.custom) parts.push(answer.custom)
  return parts.length > 0 ? parts.join('；') : null
}

/** The first question's text from a tool call's input (the transcript row's
 * one-line preview); null when it cannot be parsed. */
export function firstAskUserQuestionText(input: unknown): string | null {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return null
  const questions = (input as { questions?: unknown }).questions
  if (!Array.isArray(questions) || questions.length === 0) return null
  const first = questions[0]
  if (first === null || typeof first !== 'object' || Array.isArray(first)) return null
  return asTrimmedString((first as { question?: unknown }).question)
}

/**
 * The tool's result text (the model's view). Unanswered parts and a dismissal
 * both say so explicitly with behavioural guidance — Claude Code's stance:
 * skipping is not an error; the model continues on stated assumptions instead
 * of re-asking.
 */
export interface AskUserResultOptions {
  /** Why it was cancelled; defaults to a user dismissal. */
  reason?: AskUserCancelReason
  /** The deadline that expired, for the timeout message. */
  timeoutSeconds?: number
}

export function formatAskUserResultText(
  status: 'answered' | 'cancelled' | 'pending',
  questions: AskUserQuestion[],
  answers: AskUserAnswer[] | null,
  options: AskUserResultOptions = {}
): string {
  if (status === 'pending') {
    return 'The question is with the user and you did not block on it (async mode). Continue with your work; their answers will arrive as a message. Do not re-ask the same question.'
  }
  if (status !== 'answered' || !answers) {
    const reason = options.reason ?? 'dismissed'
    if (reason === 'timeout') {
      const seconds = options.timeoutSeconds ? ` within ${options.timeoutSeconds} seconds` : ''
      return `The user did not answer${seconds}, so the question was closed automatically. Do not immediately re-ask; only ask again if you are truly blocked. Otherwise proceed with reasonable assumptions and state them explicitly.`
    }
    if (reason === 'aborted') {
      return 'The question was cancelled because the run was interrupted. Do not immediately re-ask; proceed with reasonable assumptions and state them explicitly, or wait for the user to bring it up again.'
    }
    return 'The user dismissed the questions without answering. Do not immediately re-ask; only ask again if you are truly blocked. Otherwise proceed with reasonable assumptions and state them explicitly.'
  }
  const lines = [`The user answered ${questions.length} question(s):`]
  questions.forEach((question, index) => {
    const text = askUserAnswerText(answers[index])
    lines.push(`${index + 1}. ${question.question}`)
    lines.push(`   -> ${text ?? '(no answer)'}`)
  })
  return lines.join('\n')
}
