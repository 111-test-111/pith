/**
 * The Q&A record: every ask_user_question this session asked, projected from
 * the session branch so it survives compaction, a reopen and a restart — the
 * same discipline TodoState uses, and for the same reason (the transcript is
 * not the record; the branch is).
 *
 * One record per asking call, keyed by its toolCallId. Two entry kinds feed it:
 *
 * - a `toolResult` for `ask_user_question` — a blocking call's outcome, or an
 *   async call's receipt (`status: 'pending'`, replaced when the answer lands);
 * - an `ask_user_answer` custom message — an async outcome, which carries the
 *   questions it answers, so it replaces the receipt wholesale.
 *
 * Records are deliberately NOT trimmed to what the context still holds: the
 * panel exists so a question the model asked and the user answered is still
 * reviewable after a compaction removed it from context.
 */
import type { AgentSessionEvent, SessionManager } from '@earendil-works/pi-coding-agent'
import {
  ASK_USER_ANSWER_TYPE,
  ASK_USER_TOOL_NAME,
  isAskUserToolDetails,
  normalizeAskUserQuestions
} from '../../shared/ask-user'
import type { AskUserRecordDTO, AskUserToolDetails } from '../../shared/ask-user'

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function asTimestamp(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : Date.now()
}

/**
 * The record one message contributes, or null when it is not an ask at all.
 *
 * Two shapes reach this: the live AgentMessage the observer sees
 * (`role: 'custom'`) and the persisted branch entry the reconstructor reads
 * (`type: 'custom_message'`), which carries the same fields at the top level.
 * Handling only one of them silently reverted an async outcome to its receipt
 * after a reopen, so both are accepted here.
 */
export function askUserRecordOf(message: unknown): AskUserRecordDTO | null {
  const record = asRecord(message)
  if (!record) return null
  if (record.role === 'toolResult') {
    if (record.toolName !== ASK_USER_TOOL_NAME || record.isError) return null
    if (!isAskUserToolDetails(record.details)) return null
    return recordFrom(record.details, record.toolCallId, record.timestamp)
  }
  const custom = record.type === 'custom_message' || record.role === 'custom'
  if (custom && record.customType === ASK_USER_ANSWER_TYPE) {
    const notice = asRecord(record.details)
    if (!notice || !isAskUserToolDetails(notice.askUser)) return null
    return recordFrom(notice.askUser, notice.toolCallId, record.timestamp)
  }
  return null
}

function recordFrom(details: AskUserToolDetails, toolCallId: unknown, timestamp: unknown): AskUserRecordDTO | null {
  if (typeof toolCallId !== 'string' || !toolCallId) return null
  // The questions travel through the same normalizer as everywhere else: a
  // hand-edited or extension-written entry can never inject a half-broken card.
  const questions = normalizeAskUserQuestions(details.questions)
  if (!questions) return null
  return {
    toolCallId,
    questions,
    status: details.status,
    answers: Array.isArray(details.answers) ? details.answers : null,
    ...(details.mode ? { mode: details.mode } : {}),
    ...(details.reason ? { reason: details.reason } : {}),
    at: asTimestamp(timestamp)
  }
}

/** Fold a whole branch into records, oldest first. */
export function askUserRecordsFromEntries(entries: readonly unknown[]): AskUserRecordDTO[] {
  const records = new Map<string, AskUserRecordDTO>()
  for (const raw of entries) {
    const entry = asRecord(raw)
    if (!entry) continue
    // A branch entry WRAPS a message (`{ type: 'message', message }`), except a
    // custom message, which IS the entry.
    const record = entry.type === 'message'
      ? askUserRecordOf(entry.message)
      : entry.type === 'custom_message'
        ? askUserRecordOf(entry)
        : null
    // Later entries win: an async outcome replaces its own receipt, and a
    // re-ask after a rewind is simply the newest record for that call.
    if (record) records.set(record.toolCallId, record)
  }
  return [...records.values()]
}

/** Session-owned projection, kept in step with the branch like TodoState. */
export class AskUserRecords {
  snapshot: AskUserRecordDTO[] = []

  constructor(private manager: SessionManager) {
    this.restore()
  }

  /** Rebuild from the live branch (open, rewind, manual leaf move). */
  restore(): void {
    const next = askUserRecordsFromEntries(this.manager.getBranch())
    if (JSON.stringify(next) !== JSON.stringify(this.snapshot)) this.snapshot = next
  }

  observe(event: AgentSessionEvent): void {
    if (event.type === 'agent_start') {
      this.restore()
      return
    }
    if (event.type !== 'message_end') return
    const record = askUserRecordOf(event.message)
    if (!record) return
    const next = [...this.snapshot]
    const index = next.findIndex((item) => item.toolCallId === record.toolCallId)
    if (index >= 0) next[index] = record
    else next.push(record)
    this.snapshot = next
  }
}
