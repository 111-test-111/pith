import type { BashTaskDTO } from '../../shared/types'

/**
 * Pure task-liveness predicate, split from `bash/manager.ts` so subagent-side
 * consumers (`pi/subagents/runtime.ts`'s drain loop and its node-loadable
 * checks) do not pull the Electron-importing manager module.
 */
export const taskIsLive = (task: Pick<BashTaskDTO, 'status'>): boolean =>
  task.status === 'running' || task.status === 'stopping'
