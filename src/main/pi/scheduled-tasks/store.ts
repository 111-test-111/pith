/**
 * Scheduled task persistence: atomic file replacement plus a cross-process
 * lock; corrupt stores are never overwritten.
 *
 * Ported from pi-web's lib/scheduled-task-store.ts. pi-app runs a single
 * Electron main process, but there is no single-instance lock, so the
 * proper-lockfile guard stays as the only defense against two app processes
 * sharing one agent dir. The owner/PID/host/lease fields double as crash
 * recovery: a run whose owner PID is dead is marked interrupted on the next
 * scheduler tick, never replayed.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, rmSync, chmodSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import lockfile from 'proper-lockfile'
import { getAgentDir } from '@earendil-works/pi-coding-agent'
import {
  isScheduledTaskRunActive,
  normalizeScheduledTaskInput,
  type ScheduledTask,
  type ScheduledTaskRun
} from '../../../shared/scheduled-tasks'

export interface StoredScheduledTaskRun extends ScheduledTaskRun {
  /** Immutable execution configuration: editing a task cannot change an admitted run. */
  task: ScheduledTask
  owner?: string
  processId?: number
  host?: string
  leaseUntil?: number
  cancelRequested?: boolean
}

export interface ScheduledTaskDatabase {
  version: 1
  tasks: ScheduledTask[]
  runs: StoredScheduledTaskRun[]
}

export const scheduledTaskRunForClient = (run: StoredScheduledTaskRun): ScheduledTaskRun => {
  const { task, owner, processId, host, leaseUntil, cancelRequested, ...publicRun } = run
  void task
  void owner
  void processId
  void host
  void leaseUntil
  void cancelRequested
  return structuredClone(publicRun)
}

/** tmp + rename, private mode: a crash mid-write never leaves a torn store. */
function writeFileAtomicSync(path: string, content: string): void {
  const tmp = join(dirname(path), `.${randomUUID()}.tmp`)
  try {
    writeFileSync(tmp, content, { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, path)
    chmodSync(path, 0o600)
  } finally {
    rmSync(tmp, { force: true })
  }
}

export class ScheduledTaskStore {
  constructor(readonly path = join(getAgentDir(), 'pith-scheduled-tasks.json')) {}

  read(): ScheduledTaskDatabase {
    if (!existsSync(this.path)) return { version: 1, tasks: [], runs: [] }
    try {
      const data = JSON.parse(readFileSync(this.path, 'utf8')) as ScheduledTaskDatabase
      if (data.version !== 1 || !Array.isArray(data.tasks) || !Array.isArray(data.runs)) throw new Error('Invalid database')
      const validateTask = (task: ScheduledTask) => {
        normalizeScheduledTaskInput({ ...task, status: task.status === 'completed' ? 'paused' : task.status })
        if (
          !task.id ||
          !Number.isSafeInteger(task.revision) ||
          task.revision < 1 ||
          !['active', 'paused', 'completed'].includes(task.status) ||
          !Number.isFinite(Date.parse(task.createdAt)) ||
          !Number.isFinite(Date.parse(task.updatedAt)) ||
          (task.nextRunAt !== null && !Number.isFinite(Date.parse(task.nextRunAt)))
        )
          throw new Error('Invalid task')
      }
      data.tasks.forEach(validateTask)
      if (
        new Set(data.tasks.map((task) => task.id)).size !== data.tasks.length ||
        new Set(data.runs.map((run) => run.id)).size !== data.runs.length
      )
        throw new Error('Duplicate records')
      for (const run of data.runs) {
        validateTask(run.task)
        if (
          !run.id ||
          run.taskId !== run.task.id ||
          typeof run.taskName !== 'string' ||
          !['queued', 'running', 'waiting', 'succeeded', 'failed', 'cancelled', 'interrupted'].includes(run.status) ||
          !['schedule', 'manual'].includes(run.trigger) ||
          !Number.isFinite(Date.parse(run.scheduledFor)) ||
          !Number.isFinite(Date.parse(run.createdAt)) ||
          (run.leaseUntil !== undefined && !Number.isFinite(run.leaseUntil))
        )
          throw new Error('Invalid run')
      }
      return data
    } catch {
      throw new Error('Scheduled task storage is unreadable; the original file has been preserved')
    }
  }

  async transaction<T>(mutate: (database: ScheduledTaskDatabase) => T): Promise<T> {
    mkdirSync(dirname(this.path), { recursive: true })
    const release = await lockfile.lock(this.path, {
      realpath: false,
      stale: 10_000,
      retries: { retries: 40, minTimeout: 25, maxTimeout: 100 }
    })
    try {
      const database = this.read()
      const result = mutate(database)
      // Keep all active work and the latest 1000 terminal records. Session
      // files hold full transcripts.
      let terminal = 0
      database.runs = database.runs.filter((run) => isScheduledTaskRunActive(run) || ++terminal <= 1000)
      writeFileAtomicSync(this.path, `${JSON.stringify(database)}\n`)
      return structuredClone(result)
    } finally {
      await release()
    }
  }
}
