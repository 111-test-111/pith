import type { SessionEntry } from '@earendil-works/pi-coding-agent'
import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { RewindCheckpointDTO, RewindUncoveredPathDTO } from '../../shared/types'
import { PathIndex } from './paths'

/** Same input normalization as the SDK's built-in edit/write path resolver.
 * Keep this local: the SDK's path utility is not a public package export. */
function toolPath(input: string, cwd: string): string {
  let path = input.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, ' ').replace(/^@/, '')
  if (process.platform === 'win32' && !path.includes('\\')) {
    const drive = /^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i.exec(path)
    if (drive) path = `${drive[1].toUpperCase()}:\\${(drive[2] ?? '').replaceAll('/', '\\')}`
  }
  if (path === '~') path = homedir()
  else if (/^~[/\\]/.test(path)) path = join(homedir(), path.slice(2))
  if (path.startsWith('file://')) path = fileURLToPath(path)
  return resolve(cwd, path)
}
async function canonical(path: string): Promise<string> {
  try { return await realpath(path) } catch { /* A removed file can still have a symlinked parent. */ }
  const parent = dirname(path)
  return parent === path ? path : join(await canonical(parent), relative(parent, path))
}
function inside(root: string, path: string): string | null {
  const part = relative(root, path)
  return isAbsolute(part) || part === '..' || part.startsWith(`..${sep}`) ? null : part.split(sep).join('/')
}

/** Both spellings matter: restoring a symlink/ancestor must not indirectly
 * change a skipped path, and aliases must not hide an in-workspace overlap. */
export async function coveragePaths(root: string, path: string): Promise<string[]> {
  return [...new Set([inside(root, path), inside(await canonical(root), await canonical(path))].filter((part): part is string => part !== null))]
}

/** Diagnose known committed file writes, never reconstruct missing backups from
 * tool output. getBranch() includes compacted history; prose, read calls and
 * guessed paths inside shell command strings are not evidence of a write. */
export async function uncoveredWrites(branch: readonly SessionEntry[], cwd: string, root: string, afterEntryId: string | null,
  excluded: RewindCheckpointDTO['excluded']): Promise<RewindUncoveredPathDTO[]> {
  const anchor = afterEntryId === null ? -1 : branch.findIndex(entry => entry.id === afterEntryId)
  const calls = new Map<string, { path: string; position: number }>()
  const paths = new Set<string>()
  for (let position = 0; position < branch.length; position++) {
    const entry = branch[position]
    if (entry.type !== 'message') continue
    const message = entry.message
    if (message.role === 'assistant') {
      for (const block of message.content) if (block.type === 'toolCall' && ['edit', 'write'].includes(block.name) && typeof block.arguments.path === 'string') {
        try { calls.set(block.id, { path: toolPath(block.arguments.path, cwd), position }) } catch { /* Invalid paths cannot be executed by the built-in tool. */ }
      }
    } else if (message.role === 'toolResult' && !message.isError) {
      const call = calls.get(message.toolCallId)
      if (call && call.position > anchor) paths.add(call.path)
    }
  }
  return classifyUncoveredWrites([...paths], root, excluded)
}

/**
 * Classify already-collected write paths under the checkpoint's scope and
 * exclusion rules. Exported for callers that collect their writes elsewhere
 * (subagent child sessions): same evidence bar — only known successful writes
 * may be classified, never reconstructed or guessed paths.
 */
export async function classifyUncoveredWrites(paths: readonly string[], root: string,
  excluded: RewindCheckpointDTO['excluded']): Promise<RewindUncoveredPathDTO[]> {
  const omitted = new PathIndex(excluded.map(item => item.path))
  const scope = await canonical(root)
  const result: RewindUncoveredPathDTO[] = []
  for (const path of paths) {
    const local = inside(scope, await canonical(path))
    if (local === null) result.push({ path, reason: 'outside-workspace' })
    else if (omitted.contains(local)) result.push({ path, reason: 'excluded' })
  }
  return result
}
