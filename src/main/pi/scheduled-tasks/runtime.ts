/**
 * Scheduled task runtime over PiManager.
 *
 * The heavy lifting lives on PiManager itself (it owns ManagedSession
 * internals: Plan admission, notification owners, bash task registry). This
 * adapter keeps the scheduler's `ScheduledTaskRuntime` surface in one place,
 * mirroring pi-web's lib/scheduled-task-runtime.ts shape.
 */
import type { ScheduledTask, ScheduledTaskInput, ScheduledTaskRun } from '../../../shared/scheduled-tasks'
import type { ScheduledTaskExecutionContext, ScheduledTaskRuntime } from './service'
import type { PiManager } from '../manager'

export function createScheduledTaskRuntime(manager: PiManager): ScheduledTaskRuntime {
  return {
    validate: (input: ScheduledTaskInput) => manager.validateScheduledTaskTarget(input),
    ready: (task: ScheduledTask) => manager.scheduledTaskReady(task),
    execute: (task: ScheduledTask, run: ScheduledTaskRun, context: ScheduledTaskExecutionContext) =>
      manager.executeScheduledTask(task, run, context)
  }
}
