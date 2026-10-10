/** Goal is a session fact, independent of permission/Plan mode and Todo. */
export type GoalStatus = 'active' | 'verifying' | 'paused' | 'blocked' | 'completed' | 'cancelled'
export type GoalReason = 'user' | 'stopped' | 'plan' | 'rewound' | 'interrupted' | 'runs' | 'tokens' | 'no_progress' | 'review' | 'error' | 'storage'
export interface GoalLimits { maxAutoRuns: number; tokenBudget: number | null }
export const DEFAULT_GOAL_LIMITS: GoalLimits = { maxAutoRuns: 20, tokenBudget: null }
export interface GoalRecord {
  version: 1
  id: string
  objective: string
  acceptance: string
  status: GoalStatus
  reason: GoalReason | null
  evidence: string | null
  limits: GoalLimits
  createdAt: number
  updatedAt: number
}
export interface GoalSnapshotDTO extends GoalRecord {
  seq: number
  autoRuns: number
  tokens: number
  accountingAvailable: boolean
  executing: boolean
  /** Automatic execution is waiting for outstanding work or user input. */
  waiting: boolean
}
export type GoalActionRequest = {
  sessionPath: string
  expectedSeq: number
  goalId: string | null
} & (
  { action: 'create'; objective: string; acceptance: string; limits: GoalLimits } |
  { action: 'resume' | 'pause' | 'cancel' } |
  { action: 'limits'; limits: GoalLimits }
)
export type GoalErrorCode = 'invalid' | 'stale' | 'busy' | 'plan' | 'quota' | 'storage' | 'unavailable'
export type GoalActionResult = { ok: true; goal: GoalSnapshotDTO | null; seq: number } | { ok: false; code: GoalErrorCode }
export function validGoalLimits(value: unknown): value is GoalLimits {
  if (!value || typeof value !== 'object') return false
  const { maxAutoRuns, tokenBudget } = value as GoalLimits
  return Number.isSafeInteger(maxAutoRuns) && maxAutoRuns >= 1 && maxAutoRuns <= 1000 &&
    (tokenBudget === null || (Number.isSafeInteger(tokenBudget) && tokenBudget >= 1 && tokenBudget <= 1_000_000_000))
}
