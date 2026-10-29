/**
 * The `scheduled_task` conversation tool, ported from pi-web's
 * lib/scheduled-task-extension.ts onto this app's customTool conventions.
 *
 * Permission ceiling: a task can never receive a broader SandboxMode than the
 * conversation creating it (the ceiling is read live per call), and the tool
 * can only schedule or activate ITS OWN conversation — a task belonging to a
 * higher-privilege chat cannot be edited or fired from a narrower one.
 *
 * Registration is cheap and never boots the scheduler: the service is
 * resolved lazily inside execute (PiManager.scheduledTasks).
 */
import { Type } from 'typebox'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { SandboxMode } from '../../../shared/types'
import type { ScheduledTask, ScheduledTaskInput } from '../../../shared/scheduled-tasks'
import type { ScheduledTaskService } from './service'

export const SCHEDULED_TASK_TOOL_NAME = 'scheduled_task'

type Awaitable<T> = T | Promise<T>

/** Kept structural so tool definition and tests never initialize a scheduler. */
export interface ScheduledTaskToolService {
  list(): Awaitable<unknown>
  get(id: string): Awaitable<{ task: Pick<ScheduledTask, 'target' | 'permissionMode' | 'revision'>; runs: unknown[] }>
  create(input: ScheduledTaskInput): Awaitable<unknown>
  update(id: string, input: Partial<ScheduledTaskInput>, revision?: number): Awaitable<unknown>
  delete(id: string, revision?: number): Awaitable<unknown>
  runNow(id: string, revision?: number): Awaitable<unknown>
  cancelRun(runId: string): Awaitable<unknown>
}

export interface ScheduledTaskToolOptions {
  sessionId: string
  cwd: string
  /** Live effective mode of the calling session — the per-call ceiling. */
  getPermissionMode: () => SandboxMode
  getService: () => Awaitable<ScheduledTaskToolService>
  canStart: () => boolean
}

/** Narrowest first: modes a ceiling forbids. */
const WIDER_MODES: Record<SandboxMode, readonly SandboxMode[]> = {
  'read-only': ['workspace-write', 'danger-full-access'],
  'workspace-write': ['danger-full-access'],
  'danger-full-access': []
}

const SANDBOX_MODES = ['read-only', 'workspace-write', 'danger-full-access'] as const

function stringEnum<T extends readonly string[]>(values: T, description?: string) {
  return Type.Union(values.map((value) => Type.Literal(value)), { description })
}

const scheduleSchema = Type.Union([
  Type.Object({
    type: Type.Literal('once'),
    at: Type.String({ description: 'Absolute ISO 8601 timestamp with UTC Z or a numeric offset' })
  }),
  Type.Object({
    type: Type.Literal('interval'),
    minutes: Type.Integer({ minimum: 1, description: 'Minutes between runs' })
  }),
  Type.Object({
    type: Type.Literal('daily'),
    time: Type.String({ pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$', description: '24-hour wall-clock time, HH:mm' }),
    timeZone: Type.String({ description: 'IANA time zone, e.g. Asia/Shanghai; use the user\'s time zone' })
  }),
  Type.Object({
    type: Type.Literal('weekly'),
    time: Type.String({ pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$', description: '24-hour wall-clock time, HH:mm' }),
    timeZone: Type.String({ description: 'IANA time zone, e.g. Asia/Shanghai; use the user\'s time zone' }),
    weekdays: Type.Array(Type.Integer({ minimum: 0, maximum: 6 }), {
      minItems: 1,
      maxItems: 7,
      uniqueItems: true,
      description: 'Sunday = 0 through Saturday = 6'
    })
  })
])

const targetSchema = Type.Union([
  Type.Object({
    type: Type.Literal('existing_session'),
    sessionId: Type.Optional(
      Type.String({ description: 'Defaults to the current conversation. This tool can only schedule its own conversation.' })
    )
  }),
  Type.Object({
    type: Type.Literal('new_session'),
    cwd: Type.Optional(
      Type.String({ description: 'Absolute project directory; defaults to the current conversation\'s directory' })
    ),
    environment: Type.Optional(
      stringEnum(['local'] as const, 'Only local execution is supported; omit this field')
    )
  })
])

function requiredText(value: string | undefined, field: string): string {
  if (!value?.trim()) throw new Error(`${field} is required and must be non-empty.`)
  return value.trim()
}

function requiredRevision(value: number | undefined): number {
  if (!Number.isSafeInteger(value) || value! < 1) {
    throw new Error('revision is required for update, delete, pause, and resume. Read the task with list or get first.')
  }
  return value!
}

function withinPermissionCeiling(mode: SandboxMode, ceiling: SandboxMode): SandboxMode {
  if (!(SANDBOX_MODES as readonly string[]).includes(mode) || WIDER_MODES[ceiling].includes(mode)) {
    throw new Error(
      "Scheduled tasks cannot grant broader permissions than the current conversation. Ask the user to change the task's permissions in the scheduled tasks view if needed."
    )
  }
  return mode
}

function ownConversation(target: ScheduledTaskInput['target'], sessionId: string): void {
  if (target.type === 'existing_session' && target.sessionId !== sessionId) {
    throw new Error(
      'This tool can only schedule or activate its own conversation. Manage another conversation\'s execution in the scheduled tasks view.'
    )
  }
}

function inheritedExecutionOptions(target: ScheduledTaskInput['target'], input: Partial<ScheduledTaskInput>): void {
  if (target.type === 'existing_session' && (input.model !== undefined || input.thinkingLevel !== undefined || input.permissionMode !== undefined)) {
    throw new Error("Existing-session tasks inherit their conversation's model, thinking level, tools, and permissions; omit execution overrides.")
  }
}

const parameters = Type.Object({
  action: stringEnum(['list', 'get', 'create', 'update', 'delete', 'run', 'pause', 'resume', 'cancel'] as const),
  id: Type.Optional(Type.String({ description: 'Durable task id from list/get/create; required except for list, create, and cancel' })),
  revision: Type.Optional(
    Type.Integer({ minimum: 1, description: 'Last observed task revision; required for update, delete, pause, and resume to prevent overwriting concurrent changes' })
  ),
  runId: Type.Optional(Type.String({ description: 'Durable run id to cancel' })),
  name: Type.Optional(Type.String({ description: 'Short user-visible task name; required for create' })),
  prompt: Type.Optional(Type.String({ description: 'Self-contained user-visible instructions for every scheduled run; required for create' })),
  target: Type.Optional(targetSchema),
  schedule: Type.Optional(scheduleSchema),
  model: Type.Optional(
    Type.Object({ provider: Type.String(), modelId: Type.String() }, { description: 'Optional explicit model selection; otherwise use runtime defaults' })
  ),
  thinkingLevel: Type.Optional(stringEnum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const)),
  permissionMode: Type.Optional(
    stringEnum(SANDBOX_MODES, 'At most the current conversation\'s permission level; creation defaults to its current level')
  ),
  status: Type.Optional(stringEnum(['active', 'paused'] as const, 'Create/update state; default active on create'))
})

export function createScheduledTaskTool(options: ScheduledTaskToolOptions): ToolDefinition<typeof parameters> {
  return {
    name: SCHEDULED_TASK_TOOL_NAME,
    label: 'Scheduled task',
    parameters,
    executionMode: 'sequential',
    description: [
      'Manage durable local schedules. Create ONLY for explicit user requests to schedule, remind, follow up later, monitor or repeat work. Immediate work/tracking belongs in the conversation or todo_write; never infer a schedule from unfinished work.',
      'Omit target for this conversation; existing-session tasks inherit its model, thinking, tools and permissions, without overrides. Existing-session scheduling/activation is limited to this conversation. new_session requires requested independent project work or a separate chat per run; cwd defaults here.',
      'The user-visible prompt is replayed each run: include self-contained instructions, context and expected output. Monitors should stay quiet while unchanged/non-actionable and notify on meaningful changes or required action, unless periodic reports were requested.',
      'once uses absolute ISO date/time; interval uses elapsed minutes; daily/weekly uses wall-clock time with an explicit IANA zone. Resolve relative times from the current date and user zone (list/get include server time). After creation, confirm the readable schedule and local execution requirement.',
      'Runs require this app running and the computer awake. Closing a chat window is fine; Quit/sleep stops execution. Restart catches up one overdue run, without replaying missed occurrences. Runs use the configured model, normal tokens and tools. New scheduled chats are hidden from sidebar/search; review in scheduled tasks.',
      'Use list/get for durable id/revision before changes; update a matching task instead of duplicating. update changes provided fields only; pause/resume retain the definition; run starts immediately without waiting for the answer; cancel needs runId; delete removes the task.',
      'Scheduling cannot bypass authorization, tool restrictions or permissions. File permissions cannot exceed this conversation; normal execution checks apply and may require user attention.'
    ].join(' '),
    promptSnippet: 'Schedule user-requested reminders, recurring work, and future follow-ups as local app tasks',
    promptGuidelines: [
      'Schedule only explicit user requests. Default to this conversation; new_session requires independent runs. Save a self-contained prompt, inspect existing tasks before updating by id/revision, preserve other fields, and confirm local time plus the running/awake requirement.'
    ],
    async execute(_toolCallId, params, signal) {
      if (signal?.aborted || !options.canStart()) throw new Error('Scheduled task request was cancelled.')
      const service = await options.getService()
      if (signal?.aborted) throw new Error('Scheduled task request was cancelled.')
      const ceiling = options.getPermissionMode()
      const target =
        params.target?.type === 'new_session'
          ? ({ type: 'new_session', cwd: params.target.cwd ?? options.cwd, environment: 'local' } as const)
          : ({ type: 'existing_session', sessionId: params.target?.sessionId ?? options.sessionId } as const)
      const patch: Partial<ScheduledTaskInput> = {
        ...(params.name !== undefined ? { name: requiredText(params.name, 'name') } : {}),
        ...(params.prompt !== undefined ? { prompt: requiredText(params.prompt, 'prompt') } : {}),
        ...(params.target !== undefined ? { target } : {}),
        ...(params.schedule !== undefined ? { schedule: params.schedule as ScheduledTaskInput['schedule'] } : {}),
        ...(params.model !== undefined ? { model: params.model } : {}),
        ...(params.thinkingLevel !== undefined ? { thinkingLevel: params.thinkingLevel as ScheduledTaskInput['thinkingLevel'] } : {}),
        ...(params.permissionMode !== undefined
          ? { permissionMode: withinPermissionCeiling(params.permissionMode as SandboxMode, ceiling) }
          : {}),
        ...(params.status !== undefined ? { status: params.status } : {})
      }
      let result: unknown
      switch (params.action) {
        case 'list':
          result = await service.list()
          break
        case 'get':
          result = await service.get(requiredText(params.id, 'id'))
          break
        case 'create': {
          if (!params.schedule) throw new Error('schedule is required for create.')
          ownConversation(target, options.sessionId)
          inheritedExecutionOptions(target, patch)
          result = await service.create({
            ...patch,
            name: requiredText(params.name, 'name'),
            prompt: requiredText(params.prompt, 'prompt'),
            target,
            schedule: params.schedule as ScheduledTaskInput['schedule'],
            ...(target.type === 'new_session' ? { permissionMode: patch.permissionMode ?? ceiling } : {})
          })
          break
        }
        case 'update': {
          const id = requiredText(params.id, 'id')
          const revision = requiredRevision(params.revision)
          if (!Object.keys(patch).length) throw new Error('Provide at least one task field to update.')
          const { task } = await service.get(id)
          const nextTarget = patch.target ?? task.target
          ownConversation(nextTarget, options.sessionId)
          inheritedExecutionOptions(nextTarget, patch)
          if (nextTarget.type === 'new_session') {
            patch.permissionMode = withinPermissionCeiling(patch.permissionMode ?? task.permissionMode ?? ceiling, ceiling)
          } else if (patch.target) {
            // A target-kind change must also remove the old independent run's overrides.
            patch.model = undefined
            patch.thinkingLevel = undefined
            patch.permissionMode = undefined
          }
          result = await service.update(id, patch, revision)
          break
        }
        case 'delete': {
          const id = requiredText(params.id, 'id')
          await service.delete(id, requiredRevision(params.revision))
          result = { id, deleted: true }
          break
        }
        case 'pause':
          result = await service.update(requiredText(params.id, 'id'), { status: 'paused' }, requiredRevision(params.revision))
          break
        case 'resume': {
          const id = requiredText(params.id, 'id')
          const revision = requiredRevision(params.revision)
          const { task } = await service.get(id)
          ownConversation(task.target, options.sessionId)
          withinPermissionCeiling(task.permissionMode ?? 'read-only', ceiling)
          result = await service.update(id, { status: 'active' }, revision)
          break
        }
        case 'run': {
          const id = requiredText(params.id, 'id')
          const { task } = await service.get(id)
          ownConversation(task.target, options.sessionId)
          withinPermissionCeiling(task.permissionMode ?? 'read-only', ceiling)
          result = await service.runNow(id, task.revision)
          break
        }
        case 'cancel':
          result = await service.cancelRun(requiredText(params.runId, 'runId'))
          break
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                result,
                schedulingContext: {
                  now: new Date().toISOString(),
                  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                  execution: 'local-app'
                }
              },
              null,
              2
            )
          }
        ],
        details: { kind: 'pith_scheduled_task', action: params.action, result }
      }
    }
  }
}
