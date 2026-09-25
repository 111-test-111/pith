/**
 * Scheduled task scheduler — ported from pi-web's lib/scheduled-task-service.ts.
 *
 * Differences from the pi-web original:
 * - The runtime is injected (pi-app's PiManager-backed runtime lives in
 *   runtime.ts); nothing here imports the agent engine, and with no tasks the
 *   first check() short-circuits before any storage or session is touched.
 * - The default permission for new_session tasks reads AppSettings.sandboxMode
 *   (the default a NEW chat starts from) instead of pi-web's web settings.
 * - Every mutating operation notifies subscribers so main can broadcast the
 *   sequence-free `scheduled_tasks:update` snapshot event.
 * - owner/PID/host/lease survive from pi-web's multi-process design as pure
 *   crash recovery: a run whose owner PID is dead (or whose owner this process
 *   no longer hosts) is interrupted, never replayed.
 */
import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { ScheduledTaskStore, scheduledTaskRunForClient, type StoredScheduledTaskRun, type ScheduledTaskDatabase } from './store'
import {
  isScheduledTaskRunActive,
  nextScheduledTaskRun,
  normalizeScheduledTaskInput,
  type ScheduledTask,
  type ScheduledTaskInput,
  type ScheduledTaskRun,
  type ScheduledTaskSnapshot
} from '../../../shared/scheduled-tasks'

export class ScheduledTaskError extends Error {
  constructor(
    message: string,
    readonly status = 400
  ) {
    super(message)
  }
}

export interface ScheduledTaskExecutionContext {
  signal: AbortSignal
  onSession(sessionId: string, sessionPath: string, cwd: string): Promise<void>
  onWaiting(waiting: boolean, reason?: string): Promise<void>
}

export interface ScheduledTaskRuntime {
  validate(input: ScheduledTaskInput): Promise<void>
  ready(task: ScheduledTask): Promise<boolean>
  execute(
    task: ScheduledTask,
    run: ScheduledTaskRun,
    context: ScheduledTaskExecutionContext
  ): Promise<{ summary?: string }>
}

interface Options {
  store?: ScheduledTaskStore
  now?: () => number
  runtime?: ScheduledTaskRuntime
  owner?: string
  /** Returns the app-wide default sandbox mode for new chats. */
  defaultPermissionMode?: () => ScheduledTaskInput['permissionMode']
}

const LEASE_MS = 45_000
const MAX_CONCURRENT = 2
const CONFIG_FIELDS = new Set([
  'name',
  'prompt',
  'target',
  'schedule',
  'model',
  'thinkingLevel',
  'permissionMode',
  'status',
  'revision'
])

export class ScheduledTaskService {
  private readonly store: ScheduledTaskStore
  private readonly clock: () => number
  private readonly owner: string
  private readonly host = hostname()
  private readonly runs = new Map<string, { controller: AbortController; promise: Promise<void> }>()
  private readonly listeners = new Set<() => void>()
  private readonly defaultPermissionMode: Options['defaultPermissionMode']
  private runtimePromise?: Promise<ScheduledTaskRuntime>
  private timer?: ReturnType<typeof setInterval>
  private ticking?: Promise<void>
  private disposed = false

  constructor(options: Options = {}) {
    this.store = options.store ?? new ScheduledTaskStore()
    this.clock = options.now ?? Date.now
    this.owner = options.owner ?? randomUUID()
    this.defaultPermissionMode = options.defaultPermissionMode
    if (options.runtime) this.runtimePromise = Promise.resolve(options.runtime)
  }

  /** Set once by main when the PiManager-backed runtime becomes available. */
  setRuntime(runtime: ScheduledTaskRuntime | Promise<ScheduledTaskRuntime>): void {
    this.runtimePromise = Promise.resolve(runtime)
  }

  private runtime(): Promise<ScheduledTaskRuntime> {
    if (!this.runtimePromise) throw new ScheduledTaskError('Scheduled task runtime is not available yet', 503)
    return this.runtimePromise
  }

  private iso() {
    return new Date(this.clock()).toISOString()
  }

  private assertOpen() {
    if (this.disposed) throw new ScheduledTaskError('Scheduled task service has stopped', 503)
  }

  /** Broadcast hook: main subscribes once and republishes the snapshot. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(): void {
    for (const listener of this.listeners) {
      try {
        listener()
      } catch {
        /* a broken listener must not break scheduling */
      }
    }
  }

  start(): void {
    if (this.timer || this.disposed) return
    this.timer = setInterval(() => {
      void this.tick().catch((error) => console.error('[pi-app] Scheduled tasks:', error.message))
    }, 5000)
    this.timer.unref?.()
    void this.tick().catch((error) => console.error('[pi-app] Scheduled tasks:', error.message))
  }

  stop(): void {
    this.disposed = true
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    for (const run of this.runs.values()) run.controller.abort(new Error('Scheduled task service stopped'))
  }

  async list(): Promise<ScheduledTaskSnapshot> {
    const data = this.store.read()
    return {
      tasks: data.tasks,
      runs: data.runs.map(scheduledTaskRunForClient),
      serverTime: this.iso()
    }
  }

  async get(id: string): Promise<{ task: ScheduledTask; runs: ScheduledTaskRun[] }> {
    const data = this.store.read()
    const task = data.tasks.find((task) => task.id === id)
    if (!task) throw new ScheduledTaskError('Scheduled task not found', 404)
    return { task, runs: data.runs.filter((run) => run.taskId === id).map(scheduledTaskRunForClient) }
  }

  async getRun(id: string): Promise<ScheduledTaskRun> {
    const run = this.store.read().runs.find((entry) => entry.id === id)
    if (!run) throw new ScheduledTaskError('Scheduled run not found', 404)
    return scheduledTaskRunForClient(run)
  }

  private permissionDefault(): ScheduledTaskInput['permissionMode'] {
    // PiManager always injects the app default; the constant fallback keeps
    // the scheduler core free of any Electron/settings import.
    return this.defaultPermissionMode?.() ?? 'workspace-write'
  }

  async create(value: unknown): Promise<ScheduledTask> {
    this.assertOpen()
    const input = normalizeScheduledTaskInput(value)
    if (input.target.type === 'new_session' && !input.permissionMode) input.permissionMode = this.permissionDefault()
    await (await this.runtime()).validate(input)
    const nextRunAt = nextScheduledTaskRun(input.schedule, this.clock())
    if (!nextRunAt) throw new ScheduledTaskError('Choose a future time for the one-time task')
    const task = await this.store.transaction((data) => {
      if (data.tasks.length >= 200) throw new ScheduledTaskError('At most 200 scheduled tasks can be saved')
      const task: ScheduledTask = {
        ...input,
        id: randomUUID(),
        revision: 1,
        status: input.status ?? 'active',
        createdAt: this.iso(),
        updatedAt: this.iso(),
        nextRunAt
      }
      data.tasks.unshift(task)
      return task
    })
    this.emit()
    return task
  }

  async update(id: string, patch: Record<string, unknown>, revision?: number): Promise<ScheduledTask> {
    this.assertOpen()
    for (const key of Object.keys(patch)) if (!CONFIG_FIELDS.has(key)) throw new ScheduledTaskError(`Cannot update ${key}`)
    const previous = (await this.get(id)).task
    const input = normalizeScheduledTaskInput({
      ...previous,
      status: previous.status === 'completed' ? 'paused' : previous.status,
      ...patch
    })
    if (input.target.type === 'new_session' && !input.permissionMode) input.permissionMode = this.permissionDefault()
    await (await this.runtime()).validate(input)
    const next = await this.store.transaction((data) => {
      const task = this.requireTask(data, id, revision ?? (patch.revision as number | undefined) ?? previous.revision)
      const scheduleChanged = JSON.stringify(input.schedule) !== JSON.stringify(task.schedule)
      const nextStatus = patch.status === undefined ? task.status : input.status!
      let nextRunAt = task.nextRunAt
      if (scheduleChanged || (!nextRunAt && nextStatus === 'active')) {
        nextRunAt = nextScheduledTaskRun(input.schedule, this.clock())
        if (!nextRunAt && nextStatus === 'active')
          throw new ScheduledTaskError('Choose a future time before reactivating a one-time task')
      }
      const next: ScheduledTask = {
        ...input,
        id: task.id,
        createdAt: task.createdAt,
        updatedAt: this.iso(),
        revision: task.revision + 1,
        status: nextStatus,
        nextRunAt
      }
      data.tasks[data.tasks.indexOf(task)] = next
      if (nextStatus === 'paused')
        for (const run of data.runs)
          if (run.taskId === id && run.status === 'queued') this.finish(run, 'cancelled', 'Task was paused before execution')
      return next
    })
    this.emit()
    return next
  }

  async delete(id: string, revision?: number): Promise<void> {
    this.assertOpen()
    await this.store.transaction((data) => {
      const task = this.requireTask(data, id, revision)
      data.tasks.splice(data.tasks.indexOf(task), 1)
      for (const run of data.runs)
        if (run.taskId === id && isScheduledTaskRunActive(run)) {
          if (run.status === 'queued') this.finish(run, 'cancelled', 'Task deleted')
          else {
            run.cancelRequested = true
            run.error = 'Task deleted; stopping execution'
          }
        }
    })
    this.emit()
    await this.tick()
  }

  async runNow(id: string, revision?: number): Promise<ScheduledTaskRun> {
    this.assertOpen()
    const run = await this.store.transaction((data) => {
      const task = this.requireTask(data, id, revision)
      if (data.runs.some((run) => run.taskId === id && isScheduledTaskRunActive(run)))
        throw new ScheduledTaskError('This task already has a queued or active run', 409)
      return scheduledTaskRunForClient(this.enqueue(data, task, 'manual'))
    })
    this.emit()
    void this.tick().catch((error) => console.error('[pi-app] Could not start task:', error.message))
    return run
  }

  async cancelRun(id: string): Promise<ScheduledTaskRun> {
    const result = await this.store.transaction((data) => {
      const run = this.requireRun(data, id)
      if (run.status === 'queued') this.finish(run, 'cancelled', 'Cancelled by user')
      else if (isScheduledTaskRunActive(run)) {
        run.cancelRequested = true
        run.error = 'Cancellation requested'
      }
      return scheduledTaskRunForClient(run)
    })
    this.runs.get(id)?.controller.abort(new Error('Cancelled by user'))
    this.emit()
    return result
  }

  async markRead(id: string): Promise<ScheduledTaskRun> {
    const run = await this.store.transaction((data) => {
      const run = this.requireRun(data, id)
      run.readAt = this.iso()
      return scheduledTaskRunForClient(run)
    })
    this.emit()
    return run
  }

  /** Remove only the reviewed history snapshot; never delete sessions or active execution state. */
  async deleteRuns(ids: unknown): Promise<{ deleted: number }> {
    this.assertOpen()
    if (
      !Array.isArray(ids) ||
      !ids.length ||
      ids.length > 1000 ||
      ids.some((id) => typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id))
    ) {
      throw new ScheduledTaskError('Provide between 1 and 1000 valid run ids')
    }
    const selected = new Set(ids as string[])
    const result = await this.store.transaction((data) => {
      if (data.runs.some((run) => selected.has(run.id) && isScheduledTaskRunActive(run))) {
        throw new ScheduledTaskError('Stop active runs before deleting their history', 409)
      }
      const before = data.runs.length
      data.runs = data.runs.filter((run) => !selected.has(run.id))
      return { deleted: before - data.runs.length }
    })
    this.emit()
    return result
  }

  private requireTask(data: ScheduledTaskDatabase, id: string, revision?: number): ScheduledTask {
    const task = data.tasks.find((task) => task.id === id)
    if (!task) throw new ScheduledTaskError('Scheduled task not found', 404)
    if (revision !== undefined && (!Number.isSafeInteger(revision) || revision !== task.revision))
      throw new ScheduledTaskError('This task changed elsewhere. Reload before saving.', 409)
    return task
  }

  private requireRun(data: ScheduledTaskDatabase, id: string): StoredScheduledTaskRun {
    const run = data.runs.find((run) => run.id === id)
    if (!run) throw new ScheduledTaskError('Scheduled run not found', 404)
    return run
  }

  private finish(run: StoredScheduledTaskRun, status: ScheduledTaskRun['status'], error?: string): void {
    run.status = status
    run.finishedAt = this.iso()
    run.error = error
    delete run.readAt
    delete run.leaseUntil
  }

  private enqueue(data: ScheduledTaskDatabase, task: ScheduledTask, trigger: 'manual' | 'schedule'): StoredScheduledTaskRun {
    const run: StoredScheduledTaskRun = {
      id: randomUUID(),
      taskId: task.id,
      taskName: task.name,
      task: structuredClone(task),
      status: 'queued',
      trigger,
      scheduledFor: trigger === 'schedule' ? task.nextRunAt! : this.iso(),
      createdAt: this.iso()
    }
    data.runs.unshift(run)
    // Manual runs do not move the schedule. Due recurring work is collapsed
    // into one occurrence.
    if (trigger === 'schedule') {
      task.nextRunAt = nextScheduledTaskRun(task.schedule, this.clock())
      if (!task.nextRunAt) task.status = 'completed'
      task.updatedAt = this.iso()
      task.revision++
    }
    return run
  }

  private ownerIsDead(run: StoredScheduledTaskRun): boolean {
    if (run.host !== this.host || !run.processId) return false
    if (run.processId === process.pid) return run.owner !== this.owner
    try {
      process.kill(run.processId, 0)
      return false
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ESRCH'
    }
  }

  tick(): Promise<void> {
    if (this.disposed) return Promise.resolve()
    return (this.ticking ??= this.check().finally(() => {
      this.ticking = undefined
    }))
  }

  private async check(): Promise<void> {
    // No file and no tasks: avoid creating storage or loading the agent
    // engine during normal startup.
    if (!this.store.read().tasks.length && !this.store.read().runs.some(isScheduledTaskRunActive)) return
    let changed = false
    const candidates = await this.store.transaction((data) => {
      for (const [id, execution] of this.runs) {
        const persisted = data.runs.find((run) => run.id === id)
        if (!persisted || persisted.owner !== this.owner || !isScheduledTaskRunActive(persisted))
          execution.controller.abort(new Error('Execution lease lost'))
      }
      for (const run of data.runs) {
        if (!isScheduledTaskRunActive(run) || run.status === 'queued') continue
        if (run.owner === this.owner && this.runs.has(run.id)) {
          run.leaseUntil = this.clock() + LEASE_MS
          if (run.cancelRequested) this.runs.get(run.id)!.controller.abort(new Error('Cancelled by user'))
        } else if (this.ownerIsDead(run) || (!run.processId && (!run.leaseUntil || run.leaseUntil <= this.clock()))) {
          this.finish(run, 'interrupted', 'The previous execution stopped. Its accepted prompt was not replayed.')
          changed = true
        }
      }
      for (const task of data.tasks) {
        if (task.status !== 'active' || !task.nextRunAt || Date.parse(task.nextRunAt) > this.clock()) continue
        if (!data.runs.some((run) => run.taskId === task.id && isScheduledTaskRunActive(run))) {
          this.enqueue(data, task, 'schedule')
          changed = true
        }
      }
      return data.runs.filter((run) => run.status === 'queued').reverse()
    })
    if (changed) this.emit()
    for (const candidate of candidates) {
      if (this.disposed || this.runs.size >= MAX_CONCURRENT) break
      let ready = true
      try {
        ready = await (await this.runtime()).ready(candidate.task)
      } catch {
        /* execute records target validation errors */
      }
      if (!ready) continue
      const claimed = await this.store.transaction((data) => {
        const run = data.runs.find((run) => run.id === candidate.id)
        if (!run || run.status !== 'queued') return null
        const active = data.runs.filter((run) => run.status === 'running' || run.status === 'waiting')
        if (active.length >= MAX_CONCURRENT) return null
        const target = run.task.target
        if (
          target.type === 'existing_session' &&
          active.some(
            (other) => other.task.target.type === 'existing_session' && other.task.target.sessionId === target.sessionId
          )
        )
          return null
        run.status = 'running'
        run.startedAt = this.iso()
        run.owner = this.owner
        run.processId = process.pid
        run.host = this.host
        run.leaseUntil = this.clock() + LEASE_MS
        return run
      })
      if (!claimed || this.disposed) continue
      this.emit()
      const controller = new AbortController()
      const execution = { controller, promise: Promise.resolve() }
      this.runs.set(claimed.id, execution)
      execution.promise = this.execute(claimed, controller).finally(() => this.runs.delete(claimed.id))
    }
  }

  private async execute(run: StoredScheduledTaskRun, controller: AbortController): Promise<void> {
    const change = async (mutate: (current: StoredScheduledTaskRun) => void) => {
      const result = await this.store.transaction((data) => {
        const current = this.requireRun(data, run.id)
        if (current.owner !== this.owner || !isScheduledTaskRunActive(current)) {
          controller.abort(new Error('Execution lease lost'))
          throw new Error('Execution lease lost')
        }
        mutate(current)
      })
      this.emit()
      return result
    }
    try {
      const result = await (await this.runtime()).execute(run.task, scheduledTaskRunForClient(run), {
        signal: controller.signal,
        onSession: async (sessionId, sessionPath, cwd) =>
          change((current) => {
            current.sessionId = sessionId
            current.sessionPath = sessionPath
            current.cwd = cwd
          }),
        onWaiting: async (waiting, reason) =>
          change((current) => {
            const status = waiting ? 'waiting' : 'running'
            if (status !== current.status) delete current.readAt
            current.status = status
            current.error = reason
          })
      })
      await change((current) => {
        this.finish(
          current,
          current.cancelRequested ? 'cancelled' : this.disposed ? 'interrupted' : 'succeeded',
          current.cancelRequested ? 'Cancelled by user' : undefined
        )
        current.summary = result.summary?.slice(0, 12_000)
      })
    } catch (error) {
      await change((current) =>
        this.finish(
          current,
          this.disposed
            ? 'interrupted'
            : controller.signal.aborted || current.cancelRequested || (error instanceof Error && error.name === 'AbortError')
              ? 'cancelled'
              : 'failed',
          String(error instanceof Error ? error.message : error).slice(0, 2000)
        )
      ).catch((failure) => console.error('[pi-app] Could not persist scheduled run:', failure.message))
    }
  }
}
