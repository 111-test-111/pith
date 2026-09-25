import type { SandboxMode } from './types'

export type SessionMode = 'normal' | 'plan'

export const PLAN_MAX_BYTES = 128 * 1024

export type PlanBlocker =
  | 'initializing' | 'closing' | 'child-session' | 'recovery'
  | 'transition' | 'busy' | 'tasks' | 'subagents' | 'deliveries'
  | 'questions' | 'escalations' | 'queued-messages' | 'storage'
  | 'not-plan' | 'no-submission' | 'stale-submission' | 'already-submitted'
  | 'unsupported-version' | 'sandbox-unavailable' | 'sandbox-partial'

export interface PlanSubmissionRef {
  planId: string
  revision: number
  submissionEntryId: string
  hash: string
  planningTurnEntryId: string
  submittedAt: number
}

export interface PlanApprovalDTO {
  approvalId: string
  ref: PlanSubmissionRef
  status: 'requested' | 'started' | 'failed' | 'interrupted'
  executionEntryId?: string
  errorCode?: string
}

export interface PlanStateDTO {
  seq: number
  mode: SessionMode
  planId: string | null
  latest: PlanSubmissionRef | null
  /** A newer planning user turn exists but has not submitted its replacement. */
  revisionPending: boolean
  approval: PlanApprovalDTO | null
  /**
   * The transcript turn that executes an approved plan, identified the way the
   * review pane groups turns (its first assistant message timestamp). Main
   * derives it from the selected branch whenever the approval is `started`;
   * `null` means there is nothing to open — no execution, the opening entry
   * left the branch (rewind/resend) or the turn was compacted away.
   */
  executionTurnId: number | null
  configuredSandboxMode: SandboxMode
  effectiveSandboxMode: SandboxMode
  shellEnforcement: 'full' | 'partial' | 'unavailable'
  blockers: { switch: PlanBlocker[]; submit: PlanBlocker[]; approve: PlanBlocker[] }
}

export interface PlanDocumentRequest {
  sessionPath: string
  planId: string
  revision: number
  submissionEntryId: string
}

export interface PlanDocumentDTO {
  ref: PlanSubmissionRef
  markdown: string
}

export type PlanApproveRequest = PlanDocumentRequest

export interface PlanModeRequest {
  sessionPath: string
  mode: SessionMode
}

export type PlanActionResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: string; blockers: PlanBlocker[] }
