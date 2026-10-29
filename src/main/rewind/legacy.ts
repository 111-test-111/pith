import { mkdir, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { RewindCheckpointDTO } from '../../shared/types'
import { git, indexBlobs, safeRelative, scope } from './capture'
import { BlobStore, digest } from './storage'
import { RewindFailure, type Checkpoint, type IndexEntry, type Snapshot } from './types'

interface Legacy extends RewindCheckpointDTO { indexTree: string; worktreeTree: string; head: string; gitBranch: string | null }
const oid = (value: string): boolean => /^[a-f0-9]{40,64}$/.test(value)
/** Read-only compatibility: never delete or rewrite pi-web's refs. Content is
 * imported lazily on selection; list does not spawn a Git process per ref. */
export async function legacyList(cwd: string, sessionId: string): Promise<Legacy[]> {
  const location = await scope(cwd)
  if (!location.gitDir) return []
  const parts = (await git(location.root, ['for-each-ref', '--format=%(refname)%00%(contents)%00', 'refs/pi-checkpoints/'])).split('\0')
  const result: Legacy[] = []
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const ref = parts[i].replace(/^\n/, ''), message = parts[i + 1]
    const get = (key: string): string => message.match(new RegExp(`^${key} (.+)$`, 'm'))?.[1] ?? ''
    if (!ref.startsWith('refs/pi-checkpoints/') || get('sessionId') !== sessionId) continue
    const indexTree = get('index-tree'), worktreeTree = get('worktree-tree'), head = get('head')
    if (!oid(indexTree) || !oid(worktreeTree) || !oid(head)) continue
    const paths = (key: string): string[] => {
      try { const data = JSON.parse(get(key)); return Array.isArray(data) ? data.filter(p => typeof p === 'string' && safeRelative(p)) : [] } catch { return [] }
    }
    let entryId: string | null = null, conversationUnavailable = true
    try {
      const entry = JSON.parse(get('conversation-entry'))
      if (entry === null || (typeof entry === 'string' && /^[a-zA-Z0-9_-]+$/.test(entry))) { entryId = entry; conversationUnavailable = false }
    } catch { /* Old snapshots did not record a conversation anchor. */ }
    const branch = get('branch')
    result.push({ id: `legacy-${digest(ref).slice(0, 40)}`, sessionId, entryId, conversationUnavailable,
      legacy: true, trigger: 'legacy', description: get('description').slice(0, 200), timestamp: Date.parse(get('created')) || 0,
      branch, gitBranch: branch && !['unknown', 'HEAD', '(detached)'].includes(branch) ? `refs/heads/${branch}` : null,
      files: 0, bytes: 0, excluded: [...paths('largeFiles').map(path => ({ path, reason: 'large' as const })), ...paths('largeDirs').map(path => ({ path, reason: 'directory-limit' as const }))],
      indexTree, worktreeTree, head })
  }
  return result.sort((a, b) => b.timestamp - a.timestamp)
}
export function legacyDTO(item: Legacy): RewindCheckpointDTO { const { indexTree: _, worktreeTree: __, head: ___, gitBranch: ____, ...dto } = item; return dto }

export async function importLegacy(cwd: string, source: Legacy, store: BlobStore, stateDir: string): Promise<Checkpoint> {
  const location = await scope(cwd)
  if (!location.gitDir || !location.indexPath) throw new RewindFailure('branch')
  const tree = async (sha: string): Promise<IndexEntry[]> => (await git(location.root, ['ls-tree', '-rz', '--full-tree', sha])).split('\0').filter(Boolean).map(record => {
    const match = /^(\d+) (?:blob|commit) ([a-f0-9]+)\t([\s\S]+)$/.exec(record)
    if (!match || !safeRelative(match[3])) throw new RewindFailure('unsupported')
    return { path: match[3], mode: match[1], oid: match[2], stage: 0 }
  })
  const worktree = await tree(source.worktreeTree), entries = await tree(source.indexTree)
  await indexBlobs(location.root, [...worktree, ...entries], store, stateDir)
  const nodes: Snapshot['nodes'] = Object.create(null), excluded = [...source.excluded]
  for (const entry of worktree) {
    if (entry.mode === '160000') { excluded.push({ path: entry.path, reason: 'submodule' }); continue }
    if (!entry.blob || !['100644', '100755', '120000'].includes(entry.mode)) throw new RewindFailure('unsupported', [entry.path])
    // The legacy format contains Git-normalized bytes. Never label this as
    // reconstruction of the unknown original EOL/filter/xattr representation.
    let size = 0
    for await (const chunk of store.chunks(entry.blob)) size += chunk.length
    nodes[entry.path] = { kind: entry.mode === '120000' ? 'symlink' : 'file', hash: entry.blob, size, mode: entry.mode === '120000' ? 0o777 : entry.mode === '100755' ? 0o755 : 0o644 }
    for (let parent = dirname(entry.path); parent !== '.'; parent = dirname(parent)) nodes[parent] = { kind: 'directory', hash: '', size: 0, mode: 0o755 }
  }
  await mkdir(stateDir, { recursive: true, mode: 0o700 })
  const tempIndex = join(stateDir, `legacy-index-${source.id}`)
  await unlink(tempIndex).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error })
  try {
    const env = { GIT_INDEX_FILE: tempIndex }
    await git(location.root, ['-c', 'core.splitIndex=false', '-c', 'core.sparseCheckout=false', 'read-tree', source.indexTree], env)
    const index = await store.capture(tempIndex, true)
    const flags = await git(location.root, ['ls-files', '-v', '-z'], env)
    const snapshot: Snapshot = { version: 1, root: location.root, nodes, excluded,
      git: { gitDir: location.gitDir, indexPath: location.indexPath, entries, index, sharedIndexes: {}, flags, branch: source.gitBranch, head: source.head },
      digest: digest(JSON.stringify({ nodes, index })) }
    return { version: 1, ...legacyDTO(source), files: worktree.length, bytes: Object.values(nodes).reduce((sum, node) => sum + node.size, 0), excluded, snapshot }
  } finally { await unlink(tempIndex).catch(() => {}) }
}
