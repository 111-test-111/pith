import type { SessionEntry } from '@earendil-works/pi-coding-agent'
import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { RewindCheckpointDTO, RewindUncoveredPathDTO } from '../../shared/types'
import { PathIndex } from './paths'
import { IMAGE_TOOL_NAME, parseImageToolResult } from '../../shared/image'
import { IMAGE_REPLAY_ENTRY, parseImageReplayRecord } from '../../shared/image-replay'

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
  const outerCalls = new Map<string, number>()
  const imageCalls = new Set<string>()
  const paths = new Set<string>()
  const addPath = (raw: unknown): void => {
    if (typeof raw !== 'string') return
    try { paths.add(toolPath(raw, cwd)) } catch { /* Invalid paths cannot be executed by the built-in tool. */ }
  }
  for (let position = 0; position < branch.length; position++) {
    const entry = branch[position]
    if (entry.type === 'custom' && entry.customType === IMAGE_REPLAY_ENTRY && position > anchor) {
      const replay = parseImageReplayRecord(entry.data)
      if (replay?.endedAt !== undefined) for (const file of replay.result?.files ?? []) addPath(file.path)
    }
    if (entry.type !== 'message') continue
    const message = entry.message
    if (message.role === 'assistant') {
      for (const block of message.content) if (block.type === 'toolCall') {
        outerCalls.set(block.id, position)
        if (block.name === IMAGE_TOOL_NAME) imageCalls.add(block.id)
        if (['edit', 'write'].includes(block.name) && typeof block.arguments.path === 'string') {
          try { calls.set(block.id, { path: toolPath(block.arguments.path, cwd), position }) } catch { /* Invalid paths cannot be executed by the built-in tool. */ }
        }
      }
    } else if (message.role === 'toolResult') {
      if (!message.isError) {
        const call = calls.get(message.toolCallId)
        if (call && call.position > anchor) paths.add(call.path)
      }
      // A script may write successfully and then itself return an error. Its
      // successful nested writes still happened. The app records exact paths
      // in details because the SDK bounds nestedCalls to 256 calls and 32 KiB
      // of arguments; older sessions can use the complete records it kept.
      if ((outerCalls.get(message.toolCallId) ?? -1) <= anchor) continue
      if (message.toolName === IMAGE_TOOL_NAME && imageCalls.has(message.toolCallId)) {
        // Failed batches may still contain explicitly committed earlier files.
        for (const file of parseImageToolResult(message.details)?.files ?? []) addPath(file.path)
      }
      const details = message.details as { piAppNestedWrites?: { version?: unknown; paths?: unknown } } | undefined
      if (details?.piAppNestedWrites?.version === 1 && Array.isArray(details.piAppNestedWrites.paths)) {
        for (const path of details.piAppNestedWrites.paths) addPath(path)
      }
      for (const nested of message.nestedCalls?.calls ?? []) {
        if (nested.status === 'ok' && (nested.name === 'edit' || nested.name === 'write')) addPath(nested.arguments?.path)
      }
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
