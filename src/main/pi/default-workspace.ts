import { app } from 'electron'
import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'

/** A stable private workspace for chats created without choosing a project.
 * Keep its identity in main; renderer chrome only receives `projectless`. */
function defaultWorkspacePath(): string {
  return join(app.getPath('userData'), 'workspace')
}

export function isDefaultWorkspace(cwd: string): boolean {
  const normalize = (path: string) => {
    const absolute = resolve(path)
    return process.platform === 'win32' ? absolute.toLowerCase() : absolute
  }
  return normalize(cwd) === normalize(defaultWorkspacePath())
}

export async function ensureDefaultWorkspace(): Promise<string> {
  const cwd = defaultWorkspacePath()
  await mkdir(cwd, { recursive: true })
  return cwd
}
