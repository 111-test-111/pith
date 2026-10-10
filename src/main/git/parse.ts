import type { GitChange, GitCommit } from '../../shared/git'
import { GitFailure } from './errors'

/** NUL records preserve spaces, tabs, newlines and literal pathspec characters. */
export function parseStatus(text: string): { files: GitChange[]; head: string | null; branch: string | null; upstream: string | null; ahead: number; behind: number } {
  const result = { files: [] as GitChange[], head: null as string | null, branch: null as string | null, upstream: null as string | null, ahead: 0, behind: 0 }
  const records = text.split('\0')
  for (let i = 0; i < records.length; i++) {
    const record = records[i]; if (!record) continue
    if (record.startsWith('# branch.oid ')) { const head = record.slice(13); result.head = head === '(initial)' ? null : head }
    else if (record.startsWith('# branch.head ')) { const branch = record.slice(14); result.branch = branch === '(detached)' ? null : branch }
    else if (record.startsWith('# branch.upstream ')) result.upstream = record.slice(18)
    else if (record.startsWith('# branch.ab ')) { const match = /\+(\d+) -(\d+)/.exec(record); if (match) { result.ahead = Number(match[1]); result.behind = Number(match[2]) } }
    else if (record.startsWith('? ')) result.files.push({ path: record.slice(2), index: '.', worktree: '?', untracked: true, conflict: false, submodule: false })
    else if (/^[12u] /.test(record)) {
      const fields = record[0] === '1' ? 8 : record[0] === '2' ? 9 : 10
      let cursor = 0; const metadata: string[] = []
      for (let field = 0; field < fields; field++) { const space = record.indexOf(' ', cursor); if (space < 0) throw new GitFailure('unsupported'); metadata.push(record.slice(cursor, space)); cursor = space + 1 }
      const path = record.slice(cursor), xy = metadata[1]
      if (!path || xy.length !== 2) throw new GitFailure('unsupported')
      const oldPath = record[0] === '2' ? records[++i] : undefined
      if (record[0] === '2' && !oldPath) throw new GitFailure('unsupported')
      result.files.push({ path, ...(oldPath ? { oldPath } : {}), index: xy[0], worktree: xy[1], untracked: false, conflict: record[0] === 'u', submodule: metadata[2].startsWith('S') })
    } else if (!record.startsWith('# ') && !record.startsWith('! ')) throw new GitFailure('unsupported')
  }
  return result
}
export function parseHistory(text: string): GitCommit[] {
  const fields = text.split('\0'); if (fields.at(-1) === '') fields.pop()
  if (fields.length % 6) throw new GitFailure('unsupported')
  const commits: GitCommit[] = []
  for (let i = 0; i < fields.length; i += 6) commits.push({ id: fields[i], parents: fields[i + 1] ? fields[i + 1].split(' ') : [], author: fields[i + 2], date: fields[i + 3], subject: fields[i + 4], body: fields[i + 5] })
  return commits
}
