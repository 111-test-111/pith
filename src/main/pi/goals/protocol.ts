import type { SessionManager } from '@earendil-works/pi-coding-agent'
import { validGoalCriteria, validGoalLimits, type GoalCriterion, type GoalCriterionProof, type GoalEvidenceRef, type GoalRecord, type GoalStatus, type GoalReason } from '../../../shared/goal'
import { BASH_COMPLETION_TYPE } from '../task-notifications'
import { SUBAGENT_COMPLETION_TYPE } from '../subagents/protocol'
import { ASK_USER_ANSWER_TYPE } from '../../../shared/ask-user'

export const GOAL_ENTRY = 'pith_goal_v1'
export const GOAL_STEP = 'pith_goal_step_v1'
export const GOAL_GET = 'get_goal'
export const GOAL_UPDATE = 'update_goal'
export const GOAL_RECEIPT = 'pith-goal-result-v2'
export const GOAL_EVIDENCE = 'pith_goal_evidence_v1'
export type GoalBranch = ReturnType<SessionManager['getBranch']>
export interface GoalClaim { criterionId: string; evidence: string; evidenceIds: string[] }
export interface GoalUpdateInput { goalId: string; criteriaRevision: number; status: 'verify' | 'complete' | 'blocked'; evidence: string; claims?: GoalClaim[] }
export interface GoalReceipt extends Omit<GoalUpdateInput, 'claims'> {
  kind: typeof GOAL_RECEIPT
  claims: Array<{ criterionId: string; revision: number; summary: string; sources: GoalEvidenceRef[] }>
}
const statuses: GoalStatus[] = ['active', 'verifying', 'paused', 'blocked', 'completed', 'cancelled']
const reasons: GoalReason[] = ['user', 'stopped', 'plan', 'rewound', 'interrupted', 'runs', 'tokens', 'no_progress', 'review', 'error', 'storage', 'criteria', 'evidence', 'input', 'accounting']
const object = (v: unknown): Record<string, any> | null => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : null
const id = (v: unknown, max = 160): v is string => typeof v === 'string' && !!v && v.length <= max
const revision = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 1
export function validEvidenceRefs(value: unknown): value is GoalEvidenceRef[] {
  return Array.isArray(value) && value.length >= 1 && value.length <= 8 && new Set(value.map(v => v?.id)).size === value.length &&
    value.every(v => object(v) && id(v.id) && id(v.stampId) && typeof v.hash === 'string' && /^[a-f0-9]{64}$/.test(v.hash))
}
export function parseGoalReceipt(value: unknown): GoalReceipt | null {
  const v = object(value)
  if (!v || v.kind !== GOAL_RECEIPT || !id(v.goalId, 80) || !revision(v.criteriaRevision) ||
    !['verify', 'complete', 'blocked'].includes(v.status) || typeof v.evidence !== 'string' || !v.evidence.trim() || v.evidence.length > 8000 ||
    !Array.isArray(v.claims) || v.claims.length > 32 || new Set(v.claims.map(c => c?.criterionId)).size !== v.claims.length ||
    v.claims.some(c => !object(c) || !id(c.criterionId, 80) || !revision(c.revision) || typeof c.summary !== 'string' || !c.summary.trim() || c.summary.length > 1000 || !validEvidenceRefs(c.sources))) return null
  return structuredClone(v) as GoalReceipt
}
function proof(value: unknown): GoalCriterionProof | null {
  const v = object(value)
  return v && revision(v.revision) && id(v.receiptId) && typeof v.summary === 'string' && !!v.summary.trim() && v.summary.length <= 1000 && validEvidenceRefs(v.sources)
    ? { revision: v.revision, receiptId: v.receiptId, summary: v.summary, sources: structuredClone(v.sources) } : null
}
function record(value: unknown): GoalRecord | null {
  const g = object(value)
  if (!g || ![1, 2].includes(g.version) || !id(g.id, 80) || typeof g.objective !== 'string' || !g.objective.trim() || g.objective.length > 8000 ||
    typeof g.acceptance !== 'string' || !g.acceptance.trim() || g.acceptance.length > 8000 || !statuses.includes(g.status) ||
    (g.reason !== null && !reasons.includes(g.reason)) || (g.evidence !== null && (typeof g.evidence !== 'string' || g.evidence.length > 8000)) ||
    !validGoalLimits(g.limits) || !Number.isFinite(g.createdAt) || !Number.isFinite(g.updatedAt) || (g.inputReceipt !== undefined && g.inputReceipt !== true) ||
    (g.dismissed !== undefined && g.dismissed !== true)) return null
  if (g.version === 1) {
    // Legacy prose was never a bound proof. Keep identity/accounting but require
    // explicit review and Resume; recovery must not append or dispatch.
    return { ...structuredClone(g), version: 2, criteriaRevision: 1,
      criteria: [{ id: `${g.id}:c1`, text: g.acceptance, revision: 1, proof: null }],
      ...(['completed', 'verifying'].includes(g.status) ? { status: 'paused', reason: 'evidence', evidence: null } : {}) } as GoalRecord
  }
  if (!revision(g.criteriaRevision) || !validGoalCriteria(g.criteria)) return null
  const raw = g.criteria as unknown as GoalCriterion[]
  if (raw.some(c => !id(c.id, 80) || !revision(c.revision) || (c.proof !== null && !proof(c.proof)))) return null
  const criteria: GoalCriterion[] = raw.map(c => ({ id: c.id, text: c.text, revision: c.revision, proof: proof(c.proof) }))
  return { version: 2, id: g.id, objective: g.objective, acceptance: g.acceptance, criteriaRevision: g.criteriaRevision, criteria,
    status: g.status, reason: g.reason, evidence: g.evidence, limits: structuredClone(g.limits), createdAt: g.createdAt, updatedAt: g.updatedAt,
    ...(g.inputReceipt ? { inputReceipt: true } : {}), ...(g.dismissed ? { dismissed: true } : {}) }
}
export function applyGoalReceipt(goal: GoalRecord, receipt: GoalReceipt, receiptId: string, timestamp: number): GoalRecord | null {
  if (!goalLive(goal) || receipt.goalId !== goal.id || receipt.criteriaRevision !== goal.criteriaRevision ||
    receipt.claims.some(claim => !goal.criteria.some(c => c.id === claim.criterionId && c.revision === claim.revision))) return null
  const criteria = goal.criteria.map(c => {
    const claim = receipt.claims.find(claim => claim.criterionId === c.id)
    return claim ? { ...c, proof: { revision: claim.revision, summary: claim.summary, sources: claim.sources, receiptId } } : c
  })
  if (receipt.status === 'complete' && criteria.some(c => !c.proof)) return null
  return { ...goal, criteria, status: receipt.status === 'complete' ? 'verifying' : receipt.status === 'blocked' ? 'blocked' : 'active',
    reason: null, evidence: receipt.evidence, updatedAt: timestamp }
}
export function goalFromBranch(branch: GoalBranch): GoalRecord | null {
  let current: GoalRecord | null = null
  for (const entry of branch) {
    if (entry.type === 'custom' && entry.customType === GOAL_ENTRY) {
      const next = record(entry.data)
      if (next) current = next
    } else if (entry.type === 'message' && entry.message.role === 'toolResult' && entry.message.toolName === GOAL_UPDATE && !entry.message.isError && current) {
      const receipt = parseGoalReceipt(entry.message.details)
      if (receipt) current = applyGoalReceipt(current, receipt, entry.id, entry.message.timestamp) ?? current
    } else if (current?.status === 'verifying' && (entry.type === 'message' && (entry.message.role === 'user' ||
      entry.message.role === 'toolResult' && entry.message.toolName !== GOAL_UPDATE && (entry.message.isError || !['read', 'grep', 'find', 'ls', GOAL_GET, 'todo_write'].includes(entry.message.toolName))) ||
      entry.type === 'custom_message' && [BASH_COMPLETION_TYPE, SUBAGENT_COMPLETION_TYPE, ASK_USER_ANSWER_TYPE].includes(entry.customType))) {
      current = { ...(current as GoalRecord), status: 'active', reason: null, evidence: null }
    }
  }
  return current
}
export const goalLive = (g: GoalRecord | null | undefined): boolean => g?.status === 'active' || g?.status === 'verifying'
