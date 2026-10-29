/**
 * Scheduled task contracts and calendar math — renderer-safe, no Node imports.
 *
 * Ported from pi-web's lib/scheduled-task-protocol.ts. Runtime state is
 * written only by the main-process scheduler; the renderer composes all
 * prose from these data shapes (main sends data only, per AGENTS.md).
 */
import type { SandboxMode } from './types'

export type ScheduledTaskSchedule =
  | { type: 'once'; at: string }
  | { type: 'interval'; minutes: number }
  | { type: 'daily'; time: string; timeZone: string }
  | { type: 'weekly'; time: string; timeZone: string; weekdays: number[] }

export type ScheduledTaskTarget =
  /** A scheduled run can use the source directory or its own Git worktree. */
  | { type: 'new_session'; cwd: string; environment: 'local' | 'worktree' }
  | { type: 'existing_session'; sessionId: string }

export type ScheduledTaskThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** The scheduled permission mode IS the app's per-session SandboxMode, frozen at task creation. */
export type ScheduledTaskPermissionMode = SandboxMode

export interface ScheduledTaskInput {
  name: string
  prompt: string
  target: ScheduledTaskTarget
  schedule: ScheduledTaskSchedule
  model?: { provider: string; modelId: string }
  thinkingLevel?: ScheduledTaskThinkingLevel
  permissionMode?: ScheduledTaskPermissionMode
  status?: 'active' | 'paused'
}

export interface ScheduledTask extends Omit<ScheduledTaskInput, 'status'> {
  id: string
  revision: number
  status: 'active' | 'paused' | 'completed'
  createdAt: string
  updatedAt: string
  nextRunAt: string | null
}

export type ScheduledTaskRunStatus =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'interrupted'

export interface ScheduledTaskRun {
  id: string
  taskId: string
  taskName: string
  status: ScheduledTaskRunStatus
  trigger: 'schedule' | 'manual'
  scheduledFor: string
  createdAt: string
  startedAt?: string
  finishedAt?: string
  sessionId?: string
  sessionPath?: string
  cwd?: string
  summary?: string
  error?: string
  readAt?: string
}

export interface ScheduledTaskSnapshot {
  tasks: ScheduledTask[]
  runs: ScheduledTaskRun[]
  serverTime: string
}

export const SCHEDULED_TASK_ACTIVE_RUN_STATUSES: readonly ScheduledTaskRunStatus[] = ['queued', 'running', 'waiting']

export const isScheduledTaskRunActive = (run: Pick<ScheduledTaskRun, 'status'>): boolean =>
  SCHEDULED_TASK_ACTIVE_RUN_STATUSES.includes(run.status)

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function text(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0'))
    throw new Error(`${label} must be non-empty and at most ${max} characters`)
  return value.trim()
}

export function normalizeScheduledTaskSchedule(value: unknown): ScheduledTaskSchedule {
  const input = object(value, 'schedule')
  if (input.type === 'once') {
    const at = text(input.at, 'at', 100)
    if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(at) || !Number.isFinite(Date.parse(at)))
      throw new Error('A one-time schedule needs an ISO date with a timezone offset')
    return { type: 'once', at: new Date(at).toISOString() }
  }
  if (input.type === 'interval') {
    if (!Number.isSafeInteger(input.minutes) || (input.minutes as number) < 1 || (input.minutes as number) > 525600)
      throw new Error('Interval must be between 1 and 525600 whole minutes')
    return { type: 'interval', minutes: input.minutes as number }
  }
  if (input.type !== 'daily' && input.type !== 'weekly') throw new Error('Schedule type must be once, interval, daily, or weekly')
  const time = text(input.time, 'time', 5)
  const timeZone = text(input.timeZone, 'timeZone', 100)
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('Schedule time must use HH:mm (24-hour)')
  try {
    new Intl.DateTimeFormat('en', { timeZone }).format(0)
  } catch {
    throw new Error('Unknown schedule timezone')
  }
  if (input.type === 'daily') return { type: 'daily', time, timeZone }
  if (
    !Array.isArray(input.weekdays) ||
    !input.weekdays.length ||
    input.weekdays.length > 7 ||
    input.weekdays.some((day) => !Number.isInteger(day) || day < 0 || day > 6)
  )
    throw new Error('Select weekdays from 0 (Sunday) to 6 (Saturday)')
  return { type: 'weekly', time, timeZone, weekdays: [...new Set(input.weekdays as number[])].sort() }
}

export function normalizeScheduledTaskInput(value: unknown): ScheduledTaskInput {
  const input = object(value, 'task')
  const rawTarget = object(input.target, 'target')
  let target: ScheduledTaskTarget
  if (rawTarget.type === 'existing_session') {
    const sessionId = text(rawTarget.sessionId, 'sessionId', 128)
    if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) throw new Error('Invalid session id')
    target = { type: 'existing_session', sessionId }
  } else if (rawTarget.type === 'new_session') {
    const cwd = text(rawTarget.cwd, 'cwd', 4096)
    if (!/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(cwd)) throw new Error('The project directory must be an absolute path')
    if (rawTarget.environment !== undefined && rawTarget.environment !== 'local' && rawTarget.environment !== 'worktree')
      throw new Error('Environment must be local or worktree')
    target = { type: 'new_session', cwd, environment: rawTarget.environment === 'worktree' ? 'worktree' : 'local' }
  } else throw new Error('Target must be new_session or existing_session')
  let model: ScheduledTaskInput['model']
  if (input.model !== undefined && input.model !== null) {
    const raw = object(input.model, 'model')
    model = { provider: text(raw.provider, 'provider', 200), modelId: text(raw.modelId, 'modelId', 200) }
  }
  const thinking = input.thinkingLevel
  const permission = input.permissionMode
  if (thinking != null && !['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(thinking as string))
    throw new Error('Invalid thinking level')
  if (permission != null && !['read-only', 'workspace-write', 'danger-full-access'].includes(permission as string))
    throw new Error('Invalid permission mode')
  if (input.status !== undefined && input.status !== 'active' && input.status !== 'paused')
    throw new Error('Task status must be active or paused')
  if (target.type === 'existing_session' && (model || thinking != null || permission != null))
    throw new Error("Existing-session tasks use that conversation's model, thinking level, tools, and permissions")
  return {
    name: text(input.name, 'name', 120),
    prompt: text(input.prompt, 'prompt', 50_000),
    target,
    schedule: normalizeScheduledTaskSchedule(input.schedule),
    ...(model ? { model } : {}),
    ...(thinking != null ? { thinkingLevel: thinking as ScheduledTaskThinkingLevel } : {}),
    ...(permission != null ? { permissionMode: permission as ScheduledTaskPermissionMode } : {}),
    ...(input.status ? { status: input.status as 'active' | 'paused' } : {})
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>()

function localParts(timestamp: number, timeZone: string): number[] {
  let format = formatters.get(timeZone)
  if (!format) {
    format = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    })
    if (formatters.size >= 32) formatters.clear()
    formatters.set(timeZone, format)
  }
  const parts = Object.fromEntries(format.formatToParts(timestamp).map((part) => [part.type, part.value]))
  return ['year', 'month', 'day', 'hour', 'minute'].map((key) => Number(parts[key]))
}

const wallTime = (parts: number[]) => Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3] ?? 0, parts[4] ?? 0)

/** Resolve DST folds once (earlier occurrence); a missing local time moves forward by the gap. */
function wallToInstant(parts: number[], timeZone: string): number {
  const wall = wallTime(parts)
  const offsets = [...new Set([-86400000, 0, 86400000].map((delta) => wallTime(localParts(wall + delta, timeZone)) - (wall + delta)))]
  const candidates = offsets.map((offset) => wall - offset).sort((a, b) => a - b)
  return candidates.find((candidate) => wallTime(localParts(candidate, timeZone)) === wall) ?? candidates.at(-1)!
}

/** Strictly after the supplied instant. Never replays missed recurring occurrences. */
export function nextScheduledTaskRun(schedule: ScheduledTaskSchedule, after: number): string | null {
  if (schedule.type === 'once') return Date.parse(schedule.at) > after ? schedule.at : null
  if (schedule.type === 'interval') return new Date(after + schedule.minutes * 60_000).toISOString()
  const [year, month, day] = localParts(after, schedule.timeZone)
  const [hour, minute] = schedule.time.split(':').map(Number)
  for (let offset = 0; offset <= 8; offset++) {
    const date = new Date(Date.UTC(year, month - 1, day + offset))
    if (schedule.type === 'weekly' && !schedule.weekdays.includes(date.getUTCDay())) continue
    const candidate = wallToInstant([date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), hour, minute], schedule.timeZone)
    if (candidate > after) return new Date(candidate).toISOString()
  }
  throw new Error('Could not calculate the next scheduled time')
}
