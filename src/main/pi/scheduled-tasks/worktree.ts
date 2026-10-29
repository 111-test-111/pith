import { execFile } from 'node:child_process'
import { lstat, mkdir, realpath } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { gitEnvironment } from '../../rewind/capture'

const execute = promisify(execFile)

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execute('git', ['-C', cwd, ...args], {
    env: gitEnvironment(), timeout: 30_000, maxBuffer: 1024 * 1024
  })
  return stdout.trim()
}

/** Worktree mode requires a checkout root with a committed HEAD. */
export async function validateScheduledWorktreeSource(cwd: string): Promise<string> {
  const source = await realpath(cwd)
  let top: string
  try {
    top = await git(source, ['rev-parse', '--show-toplevel'])
    await git(source, ['rev-parse', '--verify', 'HEAD^{commit}'])
  } catch {
    throw new Error('Worktree tasks require a Git repository with a commit')
  }
  if (await realpath(top) !== source) throw new Error('Worktree tasks require the root of a Git checkout')
  return source
}

/** Keep the checkout and its branch for review after the scheduled run. */
export async function createScheduledWorktree(sourceCwd: string, taskId: string, runId: string): Promise<string> {
  const source = await validateScheduledWorktreeSource(sourceCwd)
  const listing = await git(source, ['worktree', 'list', '--porcelain'])
  const first = listing.match(/^worktree (.+)$/m)?.[1]
  const main = first ? await realpath(first) : source
  const branch = `codex/scheduled-${taskId.slice(0, 8)}-${runId.slice(0, 12)}`
  const base = `${main}-worktrees`
  const path = join(base, branch.replaceAll('/', '-'))
  if (await lstat(path).then(() => true, () => false)) throw new Error(`Scheduled worktree already exists: ${path}`)
  await mkdir(dirname(path), { recursive: true })
  await git(source, ['worktree', 'add', '-b', branch, path, 'HEAD'])
  return path
}
