import type { ImageContent } from './types'

/** Goal is a session fact, independent of permission/Plan mode and Todo. */
export type GoalStatus = 'active' | 'verifying' | 'paused' | 'blocked' | 'completed' | 'cancelled'
export type GoalReason = 'user' | 'stopped' | 'plan' | 'rewound' | 'interrupted' | 'runs' | 'tokens' | 'no_progress' | 'review' | 'error' | 'storage' | 'criteria' | 'evidence' | 'input' | 'accounting'
export interface GoalLimits { maxAutoRuns: number; tokenBudget: number | null }
export interface GoalInput { images?: ImageContent[]; files?: string[] }
/** Frozen attribution, including the original pool owner across Fork. */
export interface GoalBillingOwner {
  goalId: string
  ownerSessionId: string
  parentSessionId: string
  parentRunId: string
  tokenBudget: number | null
}
export function validGoalBillingOwner(value: unknown): value is GoalBillingOwner {
  if (!value || typeof value !== 'object') return false
  const owner = value as GoalBillingOwner
  return [owner.goalId, owner.ownerSessionId, owner.parentSessionId, owner.parentRunId].every(id => typeof id === 'string' && !!id && id.length <= 160) &&
    (owner.tokenBudget === null || Number.isSafeInteger(owner.tokenBudget) && owner.tokenBudget > 0 && owner.tokenBudget <= 1_000_000_000)
}
export interface GoalBillingDTO {
  parentTokens: number
  subagentTokens: number
  jevTokens: number
  unresolved: number
}
export interface GoalPendingInputDTO { cwd: string; files: string[]; imageCount: number; available: boolean }
export const DEFAULT_GOAL_LIMITS: GoalLimits = { maxAutoRuns: 20, tokenBudget: null }
export const GOAL_MAX_CRITERIA = 32
export interface GoalCriterionInput { id?: string; text: string }
export interface GoalEvidenceRef { id: string; stampId: string; hash: string }
export interface GoalCriterionProof {
  revision: number
  summary: string
  sources: GoalEvidenceRef[]
  receiptId: string
}
export interface GoalCriterion { id: string; text: string; revision: number; proof: GoalCriterionProof | null }
export interface GoalCriterionDTO extends GoalCriterion { state: 'pending' | 'verified' | 'stale'; files?: Record<string, string> }
export interface GoalEvidenceDTO {
  id: string
  tool: string
  kind: 'change' | 'inspection' | 'check' | 'result'
  status: 'success' | 'failure' | 'pending' | 'stale'
  excerpt: string
  path?: string
  command?: string
}
export interface GoalRecord {
  version: 2
  id: string
  objective: string
  acceptance: string
  criteriaRevision: number
  criteria: GoalCriterion[]
  status: GoalStatus
  reason: GoalReason | null
  evidence: string | null
  limits: GoalLimits
  createdAt: number
  updatedAt: number
  /** Initial input has a private immutable receipt; it must never fall back to live files. */
  inputReceipt?: true
  /** Explicit End hides this retained record across renderer/app restarts. */
  dismissed?: true
}
export interface GoalSnapshotDTO extends GoalRecord {
  criteria: GoalCriterionDTO[]
  /** Bounded committed results available for proof references; Todo is excluded. */
  evidenceResults: GoalEvidenceDTO[]
  evidenceOmitted: number
  evidenceBlocked: boolean
  seq: number
  autoRuns: number
  tokens: number
  accountingAvailable: boolean
  executing: boolean
  /** Automatic execution is waiting for outstanding work or user input. */
  waiting: boolean
  pendingInput?: GoalPendingInputDTO
  billing?: GoalBillingDTO
}
export type GoalActionRequest = {
  sessionPath: string
  expectedSeq: number
  goalId: string | null
} & (
  ({ action: 'create'; objective: string; acceptance: string; limits: GoalLimits } & GoalInput) |
  { action: 'resume' | 'pause' | 'cancel' | 'dismiss' | 'inspect' } |
  { action: 'limits'; limits: GoalLimits } |
  { action: 'criteria'; criteriaRevision: number; criteria: GoalCriterionInput[] } |
  { action: 'definition'; criteriaRevision: number; objective: string; criteria: GoalCriterionInput[] }
)
export type GoalErrorCode = 'invalid' | 'stale' | 'busy' | 'plan' | 'quota' | 'storage' | 'unavailable' | 'attachments' | 'accounting'
export type GoalActionResult = { ok: true; goal: GoalSnapshotDTO | null; seq: number } | { ok: false; code: GoalErrorCode }
/** A completed goal remains replaceable if later observations invalidate its
 * bound proofs. Explicit Pause, criteria edits and Rewind keep their ownership. */
export function goalCanBeReplaced(goal: GoalRecord | null | undefined): boolean {
  return !goal || goal.status === 'completed' || goal.status === 'cancelled' ||
    goal.status === 'paused' && goal.reason === 'evidence' && goal.criteria.every(c => c.proof !== null)
}
export function validGoalLimits(value: unknown): value is GoalLimits {
  if (!value || typeof value !== 'object') return false
  const { maxAutoRuns, tokenBudget } = value as GoalLimits
  return Number.isSafeInteger(maxAutoRuns) && maxAutoRuns >= 1 && maxAutoRuns <= 1000 &&
    (tokenBudget === null || (Number.isSafeInteger(tokenBudget) && tokenBudget >= 1 && tokenBudget <= 1_000_000_000))
}
export function validGoalCriteria(value: unknown): value is GoalCriterionInput[] {
  if (!Array.isArray(value) || !value.length || value.length > GOAL_MAX_CRITERIA) return false
  const ids = new Set<string>()
  let length = value.length - 1 // The canonical acceptance text joins rows with newlines.
  for (const item of value) {
    if (!item || typeof item.text !== 'string' || !item.text.trim()) return false
    length += item.text.length
    if (item.id !== undefined) {
      if (typeof item.id !== 'string' || !item.id || item.id.length > 80 || ids.has(item.id)) return false
      ids.add(item.id)
    }
  }
  return length <= 8000
}
