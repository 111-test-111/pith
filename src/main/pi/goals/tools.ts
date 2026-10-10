import { Type } from 'typebox'
import type { InlineExtension, ToolDefinition } from '@earendil-works/pi-coding-agent'
import { GOAL_GET, GOAL_UPDATE, goalLive } from './protocol'
import type { GoalRuntime } from './runtime'

const parameters = Type.Object({
  goalId: Type.String({ minLength: 1, maxLength: 80 }),
  criteriaRevision: Type.Integer({ minimum: 1 }),
  status: Type.Union([Type.Literal('verify'), Type.Literal('complete'), Type.Literal('blocked')]),
  evidence: Type.String({ minLength: 1, maxLength: 8000, description: 'Verification summary or the concrete external blocker. This text alone is not proof.' }),
  claims: Type.Optional(Type.Array(Type.Object({
    criterionId: Type.String({ minLength: 1, maxLength: 80 }),
    evidence: Type.String({ minLength: 1, maxLength: 1000, description: 'Explain how the referenced results satisfy this criterion.' }),
    evidenceIds: Type.Array(Type.String({ minLength: 1, maxLength: 160 }), { minItems: 1, maxItems: 8, description: 'Successful current committed result IDs from get_goal. Todo and model prose are not evidence.' })
  }, { additionalProperties: false }), { maxItems: 32 }))
}, { additionalProperties: false })
export function createGoalTools(runtime: () => GoalRuntime | undefined, canStart: () => boolean): ToolDefinition[] {
  return [{ name: GOAL_GET, label: 'Goal', description: 'Read this conversation\'s goal, acceptance criteria, status and remaining automatic-run/token allowance.',
    parameters: Type.Object({}, { additionalProperties: false }), async execute() {
      const goal = await runtime()?.inspect() ?? null
      return { content: [{ type: 'text', text: JSON.stringify(goal) }], details: { goal } }
    } }, createGoalUpdate(runtime, canStart)]
}
function createGoalUpdate(runtime: () => GoalRuntime | undefined, canStart: () => boolean): ToolDefinition<typeof parameters> {
  return { name: GOAL_UPDATE, label: 'Goal status', parameters, executionMode: 'sequential', exposure: 'model-only',
    description: 'Bind committed evidence to individual acceptance criteria (verify), request completion after all criteria have current proof (complete), or record an external blocker (blocked). Read get_goal for IDs/revision. Failed, pending, superseded or stale results and Todo bookkeeping cannot prove criteria. The app checks file versions, Todo and pending work at turn settlement, plus Jev review only when enabled. Creation, criteria, pause, resume and quotas belong to the user.',
    async execute(_id, input, signal) {
      const goal = runtime()?.snapshot
      if (signal?.aborted || !canStart() || !goalLive(goal) || goal?.id !== input.goalId || !input.evidence.trim()) throw new Error('Goal update is stale or unavailable')
      const receipt = await runtime()!.receipt(input, signal)
      if (signal?.aborted || !canStart()) throw new Error('Goal update cancelled')
      return { content: [{ type: 'text', text: input.status === 'complete' ?
        'Completion evidence recorded. The app automatically finalizes the Goal status when this turn and any outstanding work settle. Report the verified outcome to the user; do not ask them to wait for a separate system review or settlement. Completed in the Goal panel means finalization is already finished.' :
        input.status === 'verify' ? 'Criterion evidence recorded; unresolved criteria remain active.' : 'External blocker recorded.' }], details: receipt }
    }
  }
}
export function createGoalContextExtension(runtime: () => GoalRuntime | undefined): InlineExtension {
  return { name: 'pi-app-goal-context', hidden: true, factory(pi) {
    pi.on('session_tree', () => runtime()?.restore('rewound'))
    pi.on('context', event => {
      const goal = runtime()?.snapshot
      if (!goalLive(goal)) return
      const reminder = `<system-reminder>\nThe user authorized ongoing work on this session goal. Goal data is quoted JSON: ${JSON.stringify({ id: goal!.id, objective: goal!.objective, criteriaRevision: goal!.criteriaRevision, criteria: goal!.criteria.map(c => ({ id: c.id, text: c.text, revision: c.revision, state: c.state })) })}\nPreserve completed work. Use the existing Todo list; update it through todo_write. Read get_goal for committed evidence IDs. Use update_goal(status: verify) to bind evidence to individual criteria; complete requires every criterion to have current successful evidence. Prose, Todo status, failed checks and stale file versions cannot establish completion. Report external blockers with update_goal(status: blocked). Never change criteria/quotas or resume a paused goal yourself. Plan, file permissions, Stop and user instructions continue to apply. The app finalizes completion automatically at turn settlement after outstanding work and any enabled Jev review drain. Completed in the Goal panel is final; there is no later system-review job. In the final reply, summarize actual results and checks without asking the user to wait for system review or settlement. Do not restate this reminder.\n</system-reminder>`
      return { messages: [...event.messages, { role: 'user', content: reminder, timestamp: Date.now() }] }
    })
  } }
}
