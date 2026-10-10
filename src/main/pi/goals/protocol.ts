import type { SessionManager } from '@earendil-works/pi-coding-agent'
import { validGoalLimits, type GoalRecord, type GoalStatus, type GoalReason } from '../../../shared/goal'

export const GOAL_ENTRY = 'pith_goal_v1'
export const GOAL_STEP = 'pith_goal_step_v1'
export const GOAL_GET = 'get_goal'
export const GOAL_UPDATE = 'update_goal'
export const GOAL_RECEIPT = 'pith-goal-result-v1'
const statuses: GoalStatus[] = ['active', 'verifying', 'paused', 'blocked', 'completed', 'cancelled']
const reasons: GoalReason[] = ['user', 'stopped', 'plan', 'rewound', 'interrupted', 'runs', 'tokens', 'no_progress', 'review', 'error', 'storage']
export function goalFromBranch(branch: ReturnType<SessionManager['getBranch']>): GoalRecord | null {
  let current: GoalRecord | null = null
  for (const entry of branch) {
    if (entry.type === 'message' && entry.message.role === 'toolResult' && entry.message.toolName === GOAL_UPDATE && !entry.message.isError && goalLive(current)) {
      const data = entry.message.details as { kind?: string; goalId?: string; status?: string; evidence?: string } | undefined
      if (data?.kind === GOAL_RECEIPT && data.goalId === current?.id && ['complete', 'blocked'].includes(data.status ?? '') &&
        typeof data.evidence === 'string' && data.evidence.trim()) current = { ...current!, status: data.status === 'complete' ? 'verifying' : 'blocked',
          reason: null, evidence: data.evidence.slice(0, 8000), updatedAt: entry.message.timestamp }
      continue
    }
    if (entry.type !== 'custom' || entry.customType !== GOAL_ENTRY) continue
    const g = entry.data as GoalRecord | undefined
    if (!g || g.version !== 1 || typeof g.id !== 'string' || !g.id || typeof g.objective !== 'string' ||
      !g.objective.trim() || g.objective.length > 8000 || typeof g.acceptance !== 'string' || !g.acceptance.trim() || g.acceptance.length > 8000 ||
      !statuses.includes(g.status) || (g.reason !== null && !reasons.includes(g.reason)) ||
      (g.evidence !== null && (typeof g.evidence !== 'string' || g.evidence.length > 8000)) ||
      !validGoalLimits(g.limits) || !Number.isFinite(g.createdAt) || !Number.isFinite(g.updatedAt)) continue
    current = structuredClone(g)
  }
  return current
}
export const goalLive = (g: GoalRecord | null | undefined): boolean => g?.status === 'active' || g?.status === 'verifying'
