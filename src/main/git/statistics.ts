import { lstat } from 'node:fs/promises'
import type { GitChange, GitLineStats, GitRepository } from '../../shared/git'
import { GitFailure } from './errors'
import { GitRunner } from './runner'
import { entryPath, mapBounded, MAX_FILES, readPreviewFile } from './repository'

/** Only the first two tabs are delimiters; paths can contain tabs/newlines. */
export function parseNumstat(text: string): Map<string, GitLineStats> {
  const records = text.split('\0'); if (records.at(-1) === '') records.pop()
  if (records.length > MAX_FILES * 2) throw new GitFailure('output-limit')
  const result = new Map<string, GitLineStats>()
  for (const record of records) {
    const first = record.indexOf('\t'), second = record.indexOf('\t', first + 1)
    const added = record.slice(0, first), removed = record.slice(first + 1, second), path = record.slice(second + 1)
    if (first < 0 || second < 0 || !path || !/^(?:\d+|-)$/.test(added) || !/^(?:\d+|-)$/.test(removed) || (added === '-') !== (removed === '-')) throw new GitFailure('unsupported')
    const stats = { added: added === '-' ? 0 : Number(added), removed: removed === '-' ? 0 : Number(removed), binary: added === '-' }
    if (!Number.isSafeInteger(stats.added) || !Number.isSafeInteger(stats.removed)) throw new GitFailure('output-limit')
    const previous = result.get(path)
    const combined = previous ? { added: previous.added + stats.added, removed: previous.removed + stats.removed, binary: previous.binary || stats.binary } : stats
    if (!Number.isSafeInteger(combined.added) || !Number.isSafeInteger(combined.removed)) throw new GitFailure('output-limit')
    result.set(path, combined)
  }
  return result
}

const zero = (): GitLineStats => ({ added: 0, removed: 0, binary: false })
function pathsStats(file: GitChange, readout: Map<string, GitLineStats>): GitLineStats {
  const total = zero()
  for (const path of [file.path, ...(file.oldPath ? [file.oldPath] : [])]) {
    const stats = readout.get(path)
    if (stats) { total.added += stats.added; total.removed += stats.removed; total.binary ||= stats.binary }
  }
  return total
}

/** Metadata-keyed untracked counts avoid re-reading unchanged file contents. */
export class GitStatistics {
  private untracked = new Map<string, { stamp: string; stats: GitLineStats | null }>()
  constructor(private readonly runner: GitRunner) {}
  private async countUntracked(root: string, file: GitChange): Promise<GitLineStats | null> {
    if (file.path.endsWith('/')) return null
    const path = await entryPath(root, file.path), metadata = await lstat(path, { bigint: true }).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new GitFailure('stale')
      throw error
    })
    const stamp = `${metadata.dev}:${metadata.ino}:${metadata.mode}:${metadata.size}:${metadata.mtimeNs}:${metadata.ctimeNs}`, key = JSON.stringify([root, file.path])
    const cached = this.untracked.get(key)
    if (cached?.stamp === stamp) return cached.stats
    let stats: GitLineStats | null
    try {
      const bytes = await readPreviewFile(path)
      if (bytes.includes(0) || !Buffer.from(bytes.toString('utf8')).equals(bytes)) stats = { ...zero(), binary: true }
      else {
        let lines = bytes.length && bytes.at(-1) !== 10 ? 1 : 0
        for (const byte of bytes) if (byte === 10) lines++
        stats = { added: lines, removed: 0, binary: false }
      }
    } catch (error) {
      if (!(error instanceof GitFailure) || !['unsupported', 'output-limit'].includes(error.code)) throw error
      stats = null
    }
    this.untracked.delete(key); this.untracked.set(key, { stamp, stats })
    while (this.untracked.size > MAX_FILES) this.untracked.delete(this.untracked.keys().next().value!)
    return stats
  }
  async files(repo: GitRepository): Promise<GitChange[]> {
    const flags = ['--numstat', '-z', '--no-ext-diff', '--no-textconv', '--no-renames', '--no-color']
    const readouts = await mapBounded([['diff', ...flags, '--cached', '--'], ['diff', ...flags, '--']], args => this.runner.run(repo.root, args, { strictUtf8: true }))
    const staged = parseNumstat(readouts[0].stdout), worktree = parseNumstat(readouts[1].stdout)
    return mapBounded(repo.files, async file => ({
      ...file,
      stagedStats: file.conflict || file.submodule || file.untracked || file.index === '.' ? null : pathsStats(file, staged),
      worktreeStats: file.conflict || file.submodule || file.worktree === '.' ? null : file.untracked ? await this.countUntracked(repo.root, file) : pathsStats(file, worktree)
    }))
  }
  clear(): void { this.untracked.clear() }
}
