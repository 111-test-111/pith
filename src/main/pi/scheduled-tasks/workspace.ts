import { mkdir, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** The saved target; a dated child is chosen only when a run starts. */
export function scheduledTasksRoot(homeDir = homedir()): string {
  return join(homeDir, 'pi-workspace', 'scheduled_tasks')
}

export async function isScheduledTasksRoot(cwd: string, homeDir = homedir()): Promise<boolean> {
  const root = scheduledTasksRoot(homeDir)
  const [actual, expected] = await Promise.all([
    realpath(cwd).catch(() => resolve(cwd)),
    realpath(root).catch(() => resolve(root))
  ])
  return actual === expected
}

export async function prepareScheduledTasksRoot(homeDir = homedir()): Promise<string> {
  const root = scheduledTasksRoot(homeDir)
  await mkdir(root, { recursive: true })
  return root
}

export async function scheduledTasksRunCwd(now = new Date(), homeDir = homedir()): Promise<string> {
  const date = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-')
  const cwd = join(scheduledTasksRoot(homeDir), date)
  await mkdir(cwd, { recursive: true })
  return cwd
}
