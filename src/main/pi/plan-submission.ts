import { createHash } from 'node:crypto'
import { Type } from 'typebox'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { PLAN_MAX_BYTES } from '../../shared/plan'
import { PLAN_SUBMISSION_KIND, type PlanSubmissionDetails } from './plan-protocol'
import { PlanAdmissionError, type PlanController } from './plan-mode'

export function normalizePlan(text: string): { plan: string; hash: string } {
  if (typeof text !== 'string') throw new Error('invalid-plan')
  const plan = text.replace(/\r\n?/g, '\n').trim()
  if (!plan) throw new Error('empty-plan')
  if (Buffer.byteLength(plan, 'utf8') > PLAN_MAX_BYTES) throw new Error('plan-too-large')
  return { plan, hash: createHash('sha256').update(plan, 'utf8').digest('hex') }
}
const parameters = Type.Object({ plan: Type.String({ description: 'The complete Markdown plan, replacing any previous revision.' }) }, { additionalProperties: false })
export function createPlanSubmissionTool(controller: PlanController): ToolDefinition<typeof parameters> {
  return { name: 'submit_plan', label: 'Submit plan', parameters, executionMode: 'sequential',
    description: 'Submit the complete implementation plan for explicit user approval. Call alone after all investigation results are received. Stops this planning turn; does not authorize implementation.',
    async execute(_id, args, signal) {
      controller.checkWorkAdmission()
      if (signal?.aborted) throw new Error('plan-submission-aborted')
      const blockers = controller.snapshot.blockers.submit
      if (blockers.length) throw new PlanAdmissionError('plan-submission-blocked', blockers)
      const { planId, planningTurnEntryId, latest } = controller.branch
      if (!planId || !planningTurnEntryId) throw new Error('plan-turn-missing')
      const details: PlanSubmissionDetails = { kind: PLAN_SUBMISSION_KIND, version: 1, planId,
        revision: (latest?.ref.revision ?? 0) + 1, planningTurnEntryId, ...normalizePlan(args.plan) }
      return { content: [{ type: 'text', text: details.plan }], details, terminate: true }
    }
  }
}
