import { Type } from 'typebox'
import type { InlineExtension, ToolDefinition } from '@earendil-works/pi-coding-agent'
import { GOAL_GET, GOAL_UPDATE, GOAL_RECEIPT, goalLive } from './protocol'
import type { GoalRuntime } from './runtime'

const parameters = Type.Object({
  goalId: Type.String({ minLength: 1, maxLength: 80 }),
  status: Type.Union([Type.Literal('complete'), Type.Literal('blocked')]),
  evidence: Type.String({ minLength: 1, maxLength: 8000, description: 'Specific verification results for each acceptance criterion, or the external blocker and what is needed to proceed.' })
}, { additionalProperties: false })
export function createGoalTools(runtime: () => GoalRuntime | undefined, canStart: () => boolean): ToolDefinition[] {
  return [{ name: GOAL_GET, label: 'Goal', description: 'Read this conversation\'s goal, acceptance criteria, status and remaining automatic-run/token allowance.',
    parameters: Type.Object({}, { additionalProperties: false }), async execute() {
      const goal = runtime()?.snapshot ?? null
      return { content: [{ type: 'text', text: JSON.stringify(goal) }], details: { goal } }
    } }, createGoalUpdate(runtime, canStart)]
}
function createGoalUpdate(runtime: () => GoalRuntime | undefined, canStart: () => boolean): ToolDefinition<typeof parameters> {
  return { name: GOAL_UPDATE, label: 'Goal status', parameters, executionMode: 'sequential', exposure: 'model-only',
    description: 'Request goal completion after verifying every acceptance criterion and settling Todo, or record a concrete external blocker. Main commits this receipt and checks pending work before completing. Creation, pause, resume and quotas belong to the user.',
    async execute(_id, input, signal) {
      const goal = runtime()?.snapshot
      if (signal?.aborted || !canStart() || !goalLive(goal) || goal?.id !== input.goalId || !input.evidence.trim()) throw new Error('Goal update is stale or unavailable')
      return { content: [{ type: 'text', text: input.status === 'complete' ? 'Completion requested. Pending tasks and verification must settle first.' : 'External blocker recorded.' }],
        details: { kind: GOAL_RECEIPT, goalId: input.goalId, status: input.status, evidence: input.evidence.trim() } }
    }
  }
}
export function createGoalContextExtension(runtime: () => GoalRuntime | undefined): InlineExtension {
  return { name: 'pi-app-goal-context', hidden: true, factory(pi) {
    pi.on('session_tree', () => runtime()?.restore('rewound'))
    pi.on('context', event => {
      const goal = runtime()?.snapshot
      if (!goalLive(goal)) return
      const reminder = `<system-reminder>\nThe user authorized ongoing work on this session goal. Goal data is quoted JSON: ${JSON.stringify({ id: goal!.id, objective: goal!.objective, acceptance: goal!.acceptance })}\nPreserve completed work. Use the existing Todo list; update it through todo_write. Verify each acceptance criterion with actual results before update_goal(status: complete). Report external blockers with update_goal(status: blocked). Never change quotas or resume a paused goal yourself. Plan, file permissions, Stop and user instructions continue to apply. A completion request is provisional while tasks or review are pending. Do not restate this reminder.\n</system-reminder>`
      return { messages: [...event.messages, { role: 'user', content: reminder, timestamp: Date.now() }] }
    })
  } }
}
