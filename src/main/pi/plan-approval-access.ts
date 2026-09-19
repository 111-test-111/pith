import type { PlanController } from './plan-mode'
/** Main-only owner capability. No IPC, renderer or tool accepts this value. */
const openings = new WeakMap<PlanController, { id: string; cancelled: boolean }>()
export const hasPlanOpening = (controller: PlanController): boolean => openings.get(controller)?.cancelled === false
export const cancelledPlanOpening = (controller: PlanController): boolean => openings.get(controller)?.cancelled === true
export function createPlanApprovalAccess(controller: PlanController) {
  return {
    prepare(id: string) { if (openings.has(controller)) throw new Error('plan-opening-owned'); openings.set(controller, { id, cancelled: false }) },
    started(id: string) { if (openings.get(controller)?.id !== id) throw new Error('plan-opening-owner-mismatch'); openings.delete(controller) },
    failed(id: string) { const opening = openings.get(controller); if (opening?.id === id) opening.cancelled = true },
    done(id: string) { if (openings.get(controller)?.id === id) openings.delete(controller) }
  }
}
