import { createHash } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { open, lstat, readlink, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { GitRepository, GitErrorCode } from '../../shared/git'
import type { CheckoutCoordinator } from '../rewind/coordinator'
import { GitFailure } from './errors'
import { GitRunner } from './runner'
import { parseStatus } from './parse'

export const MAX_FILES = 5000
export const MAX_PATCH_BYTES = 1024 * 1024
export const trimLine = (value: string) => value.endsWith('\n') ? value.slice(0, -1) : value
export interface Inspection { repository: GitRepository; gitDir: string; index: string }
/** Bound parallel filesystem/Git reads and drain every worker before returning. */
export async function mapBounded<T, R>(items: readonly T[], read: (item: T) => Promise<R>, concurrency = 16): Promise<R[]> {
  const values = new Array<R>(items.length)
  let next = 0, failed = false
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (!failed && next < items.length) {
      const index = next++
      try { values[index] = await read(items[index]) }
      catch (error) { failed = true; throw error }
    }
  })
  const results = await Promise.allSettled(workers)
  for (const result of results) if (result.status === 'rejected') throw result.reason
  return values
}
export async function canonicalDirectory(cwd: unknown): Promise<string> {
  if (typeof cwd !== 'string' || !isAbsolute(cwd) || cwd.includes('\0')) throw new GitFailure('invalid')
  try { const path = await realpath(cwd); if (!(await stat(path)).isDirectory()) throw new GitFailure('missing'); return path }
  catch (error) { if (error instanceof GitFailure) throw error; throw new GitFailure('missing') }
}
export function blockReason(coordinator: CheckoutCoordinator, cwd: string): GitErrorCode | null {
  const b = coordinator.restoreBlockers(cwd)
  return b.recovery ? 'recovery' : b.terminal ? 'terminal' : b.closing || b.exclusive || b.runs > 0 || b.writers > 0 ? 'busy' : null
}
async function exists(path: string): Promise<boolean> { try { await lstat(path); return true } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error } }
export async function hasGitAncestor(cwd: string): Promise<boolean> {
  for (let cursor = cwd; ; cursor = dirname(cursor)) { if (await exists(join(cursor, '.git'))) return true; if (dirname(cursor) === cursor) return false }
}

/** Never follow the final symlink; its parent must still resolve inside root. */
export async function entryPath(root: string, path: string): Promise<string> {
  const parts = process.platform === 'win32' ? path.split(/[\\/]/) : path.split('/')
  if (!path || path.includes('\0') || isAbsolute(path) || parts.some(part => part === '..' || part.toLowerCase() === '.git') || path === '.') throw new GitFailure('invalid')
  const target = resolve(root, path), rel = relative(root, target)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new GitFailure('invalid')
  let parent = dirname(target)
  while (true) {
    try {
      const physical = await realpath(parent), outside = relative(root, physical)
      if (outside === '..' || outside.startsWith(`..${sep}`) || isAbsolute(outside)) throw new GitFailure('invalid')
      return target
    } catch (error) {
      if (error instanceof GitFailure) throw error
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const next = dirname(parent); if (next === parent) throw new GitFailure('invalid'); parent = next
    }
  }
}

const sameFile = (before: BigIntStats, after: BigIntStats): boolean => before.dev === after.dev && before.ino === after.ino && before.mode === after.mode && before.size === after.size && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs
/** Nonblocking/no-follow open avoids a replaced entry becoming a symlink or FIFO. */
async function openRegular(path: string, metadata: BigIntStats) {
  if (!metadata.isFile()) throw new GitFailure('unsupported')
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)).catch(error => {
    if (['ENOENT', 'ELOOP'].includes((error as NodeJS.ErrnoException).code ?? '')) throw new GitFailure('stale')
    throw error
  })
  try { if (!sameFile(metadata, await handle.stat({ bigint: true }))) throw new GitFailure('stale'); return handle }
  catch (error) { await handle.close(); throw error }
}
export async function readPreviewFile(path: string): Promise<Buffer> {
  const metadata = await lstat(path, { bigint: true })
  if (metadata.size > BigInt(MAX_PATCH_BYTES)) throw new GitFailure('output-limit')
  const handle = await openRegular(path, metadata), chunks: Buffer[] = []
  try {
    let total = 0
    while (true) {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_PATCH_BYTES + 1 - total))
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
      if (!bytesRead) break
      total += bytesRead; if (total > MAX_PATCH_BYTES) throw new GitFailure('output-limit')
      chunks.push(buffer.subarray(0, bytesRead))
    }
    if (!sameFile(metadata, await lstat(path, { bigint: true })) || !sameFile(metadata, await handle.stat({ bigint: true }))) throw new GitFailure('stale')
    return Buffer.concat(chunks)
  } finally { await handle.close() }
}
export async function fileDigest(path: string, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) throw new GitFailure('cancelled')
  const metadata = await lstat(path, { bigint: true }).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error })
  if (!metadata) return 'missing'
  if (metadata.isSymbolicLink()) { const link = await readlink(path); if (!sameFile(metadata, await lstat(path, { bigint: true }))) throw new GitFailure('stale'); return `link:${link}` }
  const hash = createHash('sha256'), handle = await openRegular(path, metadata)
  try { const buffer = Buffer.allocUnsafe(64 * 1024); let read: number; do { if (signal?.aborted) throw new GitFailure('cancelled'); read = (await handle.read(buffer, 0, buffer.length, null)).bytesRead; if (read) hash.update(buffer.subarray(0, read)) } while (read) }
  finally { await handle.close() }
  const after = await lstat(path, { bigint: true })
  if (!sameFile(metadata, after)) throw new GitFailure('stale')
  return `${metadata.mode}:${hash.digest('hex')}`
}
async function stamp(path: string): Promise<string> {
  try { const s = await lstat(path, { bigint: true }); return `${s.dev}:${s.ino}:${s.mode}:${s.size}:${s.mtimeNs}:${s.ctimeNs}` }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'; throw error }
}

export async function inspect(runner: GitRunner, cwd: string, coordinator: CheckoutCoordinator, signal?: AbortSignal): Promise<Inspection> {
  const inside = await runner.run(cwd, ['rev-parse', '--is-inside-work-tree'], { accept: [128], signal })
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') {
    if (inside.code !== 0 && await hasGitAncestor(cwd)) throw new GitFailure('command', inside.stderr.trim())
    throw new GitFailure('not-repository')
  }
  const locations = await mapBounded([
    ['rev-parse', '--show-toplevel'], ['rev-parse', '--absolute-git-dir'], ['rev-parse', '--path-format=absolute', '--git-path', 'index']
  ], args => runner.run(cwd, args, { signal }))
  const root = await realpath(trimLine(locations[0].stdout)), gitDir = trimLine(locations[1].stdout), index = trimLine(locations[2].stdout)
  const readouts = await mapBounded([
    ['-c', 'core.fsmonitor=false', 'status', '--porcelain=v2', '--branch', '--untracked-files=all', '-z'],
    ['config', '--get', 'user.name'], ['config', '--get', 'user.email'], ['remote'], ['config', '--null', '--list']
  ], args => runner.run(root, args, { signal, accept: args[0] === 'config' && args[1] === '--get' ? [1] : [], strictUtf8: args[0] === '-c' }))
  const status = readouts[0].stdout
  const facts = parseStatus(status)
  if (facts.files.length > MAX_FILES) throw new GitFailure('output-limit')
  const metadata = await mapBounded(facts.files, async file => {
    const paths = [file.path, ...(file.oldPath ? [file.oldPath] : [])]
    return mapBounded(paths, async path => ({ path, stamp: await stamp(await entryPath(root, path)) }))
  })
  const hash = createHash('sha256').update(status).update(await fileDigest(index, signal))
  for (const files of metadata) for (const file of files) hash.update(file.path).update(file.stamp)
  let operation: string | null = null
  for (const name of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'BISECT_LOG']) if (await exists(join(gitDir, name))) { operation = name; hash.update(name); break }
  const name = trimLine(readouts[1].stdout), email = trimLine(readouts[2].stdout)
  const remotes = readouts[3].stdout.split('\n').filter(Boolean)
  // Includes upstream/remote destination and hook/signing policy, without exposing values.
  hash.update(readouts[4].stdout)
  return { gitDir, index, repository: { root, revision: hash.digest('hex'), ...facts, identity: { name, email }, remotes, operation, blocked: blockReason(coordinator, root) } }
}
