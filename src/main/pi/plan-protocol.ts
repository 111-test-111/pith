import { createHash } from 'node:crypto'
import type { PlanApprovalDTO, PlanDocumentDTO, PlanSubmissionRef, SessionMode } from '../../shared/plan'
import { PLAN_MAX_BYTES } from '../../shared/plan'

export const PLAN_MODE_ENTRY = 'pith_plan_mode'
export const PLAN_APPROVAL_ENTRY = 'pith_plan_approval'
export const PLAN_SUBMISSION_KIND = 'pi-app-plan-submission'

export interface PlanSubmissionDetails {
  kind: typeof PLAN_SUBMISSION_KIND
  version: 1
  planId: string
  revision: number
  planningTurnEntryId: string
  plan: string
  hash: string
}

export interface PlanBranchState {
  mode: SessionMode
  planId: string | null
  latest: PlanDocumentDTO | null
  approval: PlanApprovalDTO | null
  planningTurnEntryId: string | null
  unsupported: boolean
}

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null

const text = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined

const positiveInt = (value: unknown): number | undefined => {
  if (typeof value !== 'number') return undefined
  if (!Number.isInteger(value) || value <= 0) return undefined
  return value
}

const hex64 = (value: unknown): string | undefined => {
  const s = text(value)
  if (!s || s.length !== 64 || !/^[0-9a-f]{64}$/.test(s)) return undefined
  return s
}

const boundedPlan = (value: unknown): string | undefined => {
  const s = text(value)
  if (!s) return undefined
  // Trim decides emptiness only; the persisted body is stored untouched and the
  // bound measures its raw UTF-8 bytes.
  const trimmed = s.trim()
  if (!trimmed) return undefined
  if (Buffer.byteLength(s, 'utf8') > PLAN_MAX_BYTES) return undefined
  return s
}

export function parsePlanSubmission(value: unknown): PlanSubmissionDetails | null {
  const message = record(value)
  if (!message) return null
  if (message.role !== 'toolResult') return null
  if (message.toolName !== 'submit_plan') return null
  if (message.isError === true) return null
  const details = record(message.details)
  if (!details) return null
  if (details.kind !== PLAN_SUBMISSION_KIND) return null
  if (details.version !== 1) return null
  const planId = text(details.planId)?.trim()
  if (!planId) return null
  const revision = positiveInt(details.revision)
  if (revision === undefined) return null
  const planningTurnEntryId = text(details.planningTurnEntryId)?.trim()
  if (!planningTurnEntryId) return null
  const plan = boundedPlan(details.plan)
  if (!plan) return null
  const hash = hex64(details.hash)
  if (!hash) return null
  return { kind: PLAN_SUBMISSION_KIND, version: 1, planId, revision, planningTurnEntryId, plan, hash }
}

function hashOfPlan(plan: string): string {
  return createHash('sha256').update(plan, 'utf8').digest('hex')
}

function refOf(details: PlanSubmissionDetails, entryId: string, submittedAt: number): PlanSubmissionRef {
  return {
    planId: details.planId,
    revision: details.revision,
    submissionEntryId: entryId,
    hash: details.hash,
    planningTurnEntryId: details.planningTurnEntryId,
    submittedAt
  }
}

function refFrom(value: unknown): PlanSubmissionRef | null {
  const r = record(value)
  if (!r) return null
  const planId = text(r.planId)?.trim()
  const revision = positiveInt(r.revision)
  const submissionEntryId = text(r.submissionEntryId)?.trim()
  const hash = hex64(r.hash)
  const planningTurnEntryId = text(r.planningTurnEntryId)?.trim()
  const submittedAt = typeof r.submittedAt === 'number' ? r.submittedAt : 0
  if (!planId || revision === undefined || !submissionEntryId || !hash || !planningTurnEntryId) return null
  return { planId, revision, submissionEntryId, hash, planningTurnEntryId, submittedAt }
}

export function reconstructPlan(branch: readonly unknown[], onSubmission?: (entry: unknown, document: PlanDocumentDTO) => void): PlanBranchState {
  const state: PlanBranchState = {
    mode: 'normal',
    planId: null,
    latest: null,
    approval: null,
    planningTurnEntryId: null,
    unsupported: false
  }
  for (const entry of branch) {
    const recordEntry = record(entry)
    if (!recordEntry) continue
    if (recordEntry.type === 'custom') {
      const data = record(recordEntry.data)
      if (!data) continue
      if (recordEntry.customType === PLAN_MODE_ENTRY) {
        if (data.version !== 1) {
          // Unknown protocol version is explicitly incompatible and fail-closed.
          state.unsupported = true
          state.mode = 'normal'
          state.planId = null
          state.latest = null
          state.approval = null
          continue
        }
        const mode = text(data.mode)
        if (mode !== 'normal' && mode !== 'plan') continue
        state.mode = mode
        if (mode === 'plan') {
          const planId = text(data.planId)?.trim()
          if (!planId) continue
          state.planId = planId
          // Re-entering plan (other than recovery) starts a fresh planning cycle.
          if (data.via !== 'recovery') {
            state.latest = null
            state.approval = null
          }
        } else {
          // Normal exit keeps historical plan identity but clears active approval.
          if (data.via !== 'approve') state.approval = null
        }
      } else if (recordEntry.customType === PLAN_APPROVAL_ENTRY) {
        if (data.version !== 1) { state.unsupported = true; continue }
        const approvalId = text(data.approvalId)?.trim()
        const status = text(data.status)
        const ref = refFrom(data.ref)
        if (!approvalId || !status || !ref) continue
        if (!['requested', 'started', 'failed', 'interrupted'].includes(status)) continue
        state.approval = {
          approvalId,
          ref,
          status: status as PlanApprovalDTO['status'],
          ...(text(data.executionEntryId) ? { executionEntryId: text(data.executionEntryId) } : {}),
          ...(text(data.errorCode) ? { errorCode: text(data.errorCode) } : {})
        }
      }
    } else if (recordEntry.type === 'message') {
      const message = record(recordEntry.message)
      if (!message) continue
      if (message.role === 'user') {
        const id = text(recordEntry.id)?.trim()
        if (id) state.planningTurnEntryId = id
      } else if (message.role === 'toolResult') {
        const details = parsePlanSubmission(message)
        if (!details) continue
        // Only accept submissions that match the current plan identity and mode.
        if (state.mode !== 'plan' || details.planId !== state.planId ||
            details.planningTurnEntryId !== state.planningTurnEntryId ||
            details.hash !== hashOfPlan(details.plan) ||
            details.revision !== (state.latest?.ref.revision ?? 0) + 1) continue
        // The approval identity must come from the persisted entry; a record
        // without a nonempty one has no authoritative source, so skip it.
        const entryId = text(recordEntry.id)?.trim()
        if (!entryId) continue
        const submittedAt = typeof message.timestamp === 'number' ? message.timestamp : (typeof recordEntry.timestamp === 'number' ? recordEntry.timestamp : 0)
        state.latest = { ref: refOf(details, entryId, submittedAt), markdown: details.plan }
        onSubmission?.(entry, state.latest)
      }
    }
  }
  return state
}

/**
 * The review pane groups a transcript turn by its first assistant message
 * timestamp, while an approval records only the JSONL entry id of the user
 * message that opened execution. Map one to the other from the selected branch:
 * the first assistant message after that user entry belongs to the execution
 * turn.
 *
 * This is computed from the LIVE branch on every publish rather than cached in
 * the folded state: the assistant message the mapping needs arrives after the
 * approval entry, so a fold performed at approval time could never see it.
 * Rewind/resend take the entry off the branch and compaction folds the turn
 * away; both report `null`, and the UI offers no entry point.
 */
export function planExecutionTurnId(branch: readonly unknown[], approval: PlanApprovalDTO | null): number | null {
  if (approval?.status !== 'started' || !approval.executionEntryId) return null
  let reached = false
  for (const entry of branch) {
    const recordEntry = record(entry)
    if (!recordEntry) continue
    if (!reached) {
      if (recordEntry.type === 'message' && text(recordEntry.id) === approval.executionEntryId) reached = true
      continue
    }
    if (recordEntry.type !== 'message') continue
    const message = record(recordEntry.message)
    if (message?.role !== 'assistant') continue
    return typeof message.timestamp === 'number' ? message.timestamp : null
  }
  return null
}

export function isCurrentPlan(state: PlanBranchState): boolean {
  if (state.mode !== 'plan') return false
  if (!state.latest) return false
  if (state.unsupported) return false
  return state.latest.ref.planningTurnEntryId === state.planningTurnEntryId
}

/** A later user turn invalidates the submitted document until that turn
 * commits a complete replacement through `submit_plan`. This is a selected-
 * branch fact, so reopening, compaction and rewind all recover it identically. */
export function isRevisionPending(state: PlanBranchState): boolean {
  return state.mode === 'plan' && !state.unsupported && state.latest !== null &&
    state.planningTurnEntryId !== null && !isCurrentPlan(state)
}
