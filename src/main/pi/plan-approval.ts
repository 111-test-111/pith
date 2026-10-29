import { randomUUID } from 'node:crypto'
import type { AgentSession } from '@earendil-works/pi-coding-agent'
import type { PlanActionResult, PlanApprovalDTO, PlanApproveRequest, PlanDocumentDTO, PlanDocumentRequest, PlanStateDTO } from '../../shared/plan'
import { PlanAdmissionError, planErrorCode, type PlanController } from './plan-mode'
import type { PlanStorage } from './plan-storage'
import { PLAN_APPROVAL_ENTRY, PLAN_MODE_ENTRY, isCurrentPlan } from './plan-protocol'
import { createPlanApprovalAccess } from './plan-approval-access'

export interface PlanApprovalHost {
  session: AgentSession; controller: PlanController; storage: PlanStorage
  read(request: PlanDocumentRequest): PlanDocumentDTO
  applyTools(): void; holdWakes(): () => void; changed(): void
  onError?(error: unknown): void
}
const matches = (ref: PlanDocumentDTO['ref'], request: PlanDocumentRequest) =>
  ref.planId === request.planId && ref.revision === request.revision && ref.submissionEntryId === request.submissionEntryId

export class PlanApprovalController {
  private readonly access: ReturnType<typeof createPlanApprovalAccess>
  private opening: { approval: PlanApprovalDTO; user?: object; accepted: boolean;
    resolve(value: PlanApprovalDTO): void; reject(error: unknown): void; release(): void } | null = null
  private readonly unsubscribe: () => void
  private execution: Promise<void> | null = null
  private disposed = false
  constructor(private host: PlanApprovalHost) {
    this.access = createPlanApprovalAccess(host.controller)
    // Installed after the SDK's persistence listener and app's projection.
    this.unsubscribe = host.session.agent.subscribe(event => {
      const opening = this.opening
      if (!opening || opening.accepted) return
      if (event.type === 'message_start' && event.message.role === 'user' && !opening.user) opening.user = event.message
      if (event.type !== 'message_end' || event.message !== opening.user) return
      const leaf = host.session.sessionManager.getLeafEntry()
      if (leaf?.type !== 'message' || leaf.message !== event.message) throw new Error('plan-opening-not-persisted')
      const started: PlanApprovalDTO = { ...opening.approval, status: 'started', executionEntryId: leaf.id }
      host.storage.append(PLAN_APPROVAL_ENTRY, { version: 1, ...started })
      opening.accepted = true
      this.access.started(started.approvalId)
      host.controller.restore()
      host.applyTools()
      opening.resolve(started)
    })
  }

  async approve(request: PlanApproveRequest): Promise<PlanActionResult<PlanApprovalDTO>> {
    const { controller, session, storage } = this.host
    if (storage.failed) return { ok: false, code: 'storage', blockers: ['storage'] }
    if (controller.branch.unsupported) return { ok: false, code: 'unsupported-version', blockers: ['unsupported-version'] }
    const previous = controller.branch.approval
    if (previous?.status === 'started' && matches(previous.ref, request) &&
        session.sessionManager.getBranch().some(e => e.id === previous.executionEntryId)) return { ok: true, value: previous }
    try {
      const value = await controller.transition(async () => {
        if (this.disposed) throw new Error('closing')
        if (this.execution) throw new PlanAdmissionError('busy', ['busy'])
        const blockers = controller.snapshot.blockers.approve.filter(b => b !== 'transition')
        if (blockers.length) throw new PlanAdmissionError('plan-approval-blocked', blockers)
        const document = this.host.read(request)
        if (!isCurrentPlan(controller.branch) || !controller.branch.latest ||
            !matches(controller.branch.latest.ref, request) || controller.branch.latest.ref.hash !== document.ref.hash) {
          throw new PlanAdmissionError('stale-submission', ['stale-submission'])
        }
        const approval: PlanApprovalDTO = { approvalId: randomUUID(), ref: document.ref, status: 'requested' }
        storage.append(PLAN_APPROVAL_ENTRY, { version: 1, ...approval })
        let resolve!: (value: PlanApprovalDTO) => void
        let reject!: (error: unknown) => void
        const accepted = new Promise<PlanApprovalDTO>((yes, no) => { resolve = yes; reject = no })
        this.opening = { approval, accepted: false, resolve, reject, release: this.host.holdWakes() }
        this.access.prepare(approval.approvalId)
        try {
          storage.append(PLAN_MODE_ENTRY, { version: 1, mode: 'normal', planId: document.ref.planId, via: 'approve', approvalId: approval.approvalId })
          controller.restore()
          this.host.applyTools()
          const prompt = `The user has explicitly approved the following plan. Implement it in this conversation and verify the result. Ask the user about substantive changes required by new evidence. Use the existing file permissions.\n\n${document.markdown}`
          this.execution = session.prompt(prompt, { expandPromptTemplates: false }).then(
            () => { if (this.opening && !this.opening.accepted) this.failOpening(new Error('plan-opening-not-accepted')) },
            error => { if (this.opening && !this.opening.accepted) this.failOpening(error); else this.host.onError?.(error) }
          ).finally(() => { this.execution = null; this.access.done(approval.approvalId) })
          return await accepted
        } catch (error) {
          this.failOpening(error)
          // An append can fail before the acceptance promise is awaited.
          await accepted.catch(() => {})
          throw error
        } finally {
          if (!this.execution) this.access.done(approval.approvalId)
          this.opening?.release()
          this.opening = null
        }
      })
      return { ok: true, value }
    } catch (error) {
      this.host.controller.refresh()
      const blockers = error instanceof PlanAdmissionError ? error.blockers : storage.failed ? ['storage' as const] : []
      return { ok: false, code: blockers.length ? planErrorCode(blockers) : 'approval-start-failed', blockers }
    }
  }

  private failOpening(error: unknown): void {
    const opening = this.opening
    if (!opening || opening.accepted) return
    const { storage, controller } = this.host
    this.access.failed(opening.approval.approvalId)
    try {
      if (!storage.failed) {
        storage.append(PLAN_MODE_ENTRY, { version: 1, mode: 'plan', planId: opening.approval.ref.planId, via: 'recovery' })
        storage.append(PLAN_APPROVAL_ENTRY, { version: 1, ...opening.approval,
          status: opening.user ? 'interrupted' : 'failed', errorCode: 'approval-start-failed' })
      }
    } catch { /* Storage owns the failure latch; never claim a rollback succeeded. */ }
    controller.restore()
    this.host.applyTools()
    opening.reject(error)
  }

  recover(): void {
    const { controller, session, storage } = this.host
    const approval = controller.branch.approval
    if (!approval || this.opening || approval.status === 'failed' || approval.status === 'interrupted') return
    const started = approval.status === 'started' && session.sessionManager.getBranch().some(e =>
      e.id === approval.executionEntryId && e.type === 'message' && e.message.role === 'user')
    if (started) return
    try {
      storage.append(PLAN_APPROVAL_ENTRY, { version: 1, ...approval, status: 'interrupted', errorCode: 'approval-interrupted' })
    } catch { /* A failed disk remains closed. */ }
    controller.restore()
  }

  async reset(request: PlanDocumentRequest): Promise<PlanActionResult<PlanStateDTO>> {
    const { controller, storage } = this.host
    try {
      await controller.transition(async () => {
        const approval = controller.branch.approval
        if (approval?.status !== 'interrupted' || !matches(approval.ref, request)) throw new PlanAdmissionError('stale-submission', ['stale-submission'])
        storage.append(PLAN_MODE_ENTRY, { version: 1, mode: 'plan', planId: randomUUID(), via: 'toggle' })
        controller.restore()
      })
      return { ok: true, value: controller.snapshot }
    } catch (error) {
      const blockers = error instanceof PlanAdmissionError ? error.blockers : storage.failed ? ['storage' as const] : []
      return { ok: false, code: planErrorCode(blockers), blockers }
    }
  }
  cancelOpening(): void { this.failOpening(new Error('plan-opening-aborted')) }
  dispose(): void { this.disposed = true; this.cancelOpening(); this.unsubscribe() }
}
