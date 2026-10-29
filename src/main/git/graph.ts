import { createHash } from 'node:crypto'
import { isAbsolute, join } from 'node:path'
import type { GitGraph, GitGraphRef, GitGraphRequest } from '../../shared/git'
import { GitFailure } from './errors'
import { fileDigest, mapBounded, trimLine } from './repository'
import { parseHistory } from './parse'
import type { GitRunner } from './runner'

const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
const PAGE = 50, MAX_COMMITS = 5000

/** Explicit public refs exclude private checkpoint refs. Pagination never mixes frontiers. */
export class GitGraphReader {
  private cache = new Map<string, GitGraph>()
  constructor(private readonly runner: GitRunner) {}
  clear(): void { this.cache.clear() }
  private async frontier(root: string) {
    const [raw, headText, branchText, config, commonText] = await mapBounded([
      ['for-each-ref', '--sort=refname', '--format=%(refname)%00%(objectname)%00%(*objectname)%00%(objecttype)%00%(*objecttype)%00%(symref)%00', 'refs/heads/', 'refs/remotes/', 'refs/tags/', 'refs/replace/'],
      ['rev-parse', '--verify', '--quiet', 'HEAD'],
      ['symbolic-ref', '--quiet', '--short', 'HEAD'],
      ['config', '--null', '--list'],
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    ], async args => (await this.runner.run(root, args, { strictUtf8: true, limit: 1024 * 1024, ...(args[0] === 'symbolic-ref' ? { accept: [1] } : args.at(-1) === 'HEAD' ? { accept: [1, 128] } : {}) })).stdout)
    const head = trimLine(headText) || null, branch = trimLine(branchText) || null
    if (head && !SHA.test(head)) throw new GitFailure('unsupported')
    const common = trimLine(commonText)
    if (!isAbsolute(common)) throw new GitFailure('unsupported')
    const boundaries = await mapBounded(['shallow', 'info/grafts'], path => fileDigest(join(common, path)))
    const rows = raw.split('\0\n').filter(Boolean)
    if (rows.length > 5000) throw new GitFailure('output-limit')
    const refs = new Map<string, GitGraphRef[]>(), tips = new Set<string>()
    const add = (id: string, ref: GitGraphRef) => { tips.add(id); refs.set(id, [...refs.get(id) ?? [], ref]) }
    const decoded = await mapBounded(rows, async row => {
      const fields = row.split('\0')
      if (fields.length !== 6 || !SHA.test(fields[1])) throw new GitFailure('unsupported')
      const [name, object, peeled, type, peeledType] = fields
      if (name.startsWith('refs/replace/')) return null // Changes traversal but is not a public tip.
      const kind = name.startsWith('refs/heads/') ? 'branch' : name.startsWith('refs/remotes/') ? 'remote' : name.startsWith('refs/tags/') ? 'tag' : null
      if (!kind) throw new GitFailure('unsupported')
      let id = type === 'commit' ? object : peeledType === 'commit' ? peeled : null
      if (type === 'tag' && peeledType === 'tag') id = trimLine((await this.runner.run(root, ['rev-parse', '--verify', '--quiet', `${object}^{commit}`], { accept: [1, 128] })).stdout) || null
      if (id && !SHA.test(id)) throw new GitFailure('unsupported')
      return id ? { id, ref: { name: name.slice(kind === 'branch' ? 11 : kind === 'remote' ? 13 : 10), kind } as GitGraphRef } : null
    })
    for (const entry of decoded) if (entry) add(entry.id, entry.ref)
    if (head) {
      const priority = (ref: GitGraphRef) => ref.kind === 'head' ? 0 : ref.kind === 'branch' && ref.name === branch ? 1 : 2
      const headRefs: GitGraphRef[] = [{ name: 'HEAD', kind: 'head' }, ...refs.get(head) ?? []]
      tips.add(head); refs.set(head, headRefs.sort((a, b) => priority(a) - priority(b)))
    }
    const revision = createHash('sha256').update(JSON.stringify([raw, head, branch, config, boundaries])).digest('hex')
    return { revision, head, branch, refs, tips: [...tips].sort() }
  }
  async read(root: string, request: GitGraphRequest): Promise<GitGraph> {
    const offset = request.offset ?? 0
    if (!Number.isInteger(offset) || offset < 0 || offset >= MAX_COMMITS || (request.revision !== undefined && !/^[a-f0-9]{64}$/.test(request.revision)) || (offset > 0 && !request.revision)) throw new GitFailure('invalid')
    const before = await this.frontier(root)
    if (request.revision && request.revision !== before.revision) throw new GitFailure('stale')
    const key = JSON.stringify([root, before.revision, offset])
    let page = this.cache.get(key)
    if (!page) {
      const size = Math.min(PAGE, MAX_COMMITS - offset)
      const rows = before.tips.length ? parseHistory((await this.runner.run(root, ['log', '-z', '--topo-order', '--format=%H%x00%P%x00%an%x00%aI%x00%s%x00', `--max-count=${size + 1}`, `--skip=${offset}`, ...before.tips, '--'], { strictUtf8: true, limit: 1024 * 1024 })).stdout) : []
      const limited = offset + size >= MAX_COMMITS && rows.length > size
      page = { revision: before.revision, head: before.head, branch: before.branch, commits: rows.slice(0, size).map(commit => ({ ...commit, refs: before.refs.get(commit.id) ?? [] })), next: rows.length > size && !limited ? offset + size : null, limited }
    }
    if ((await this.frontier(root)).revision !== before.revision) throw new GitFailure('stale')
    this.cache.delete(key); this.cache.set(key, page)
    while (this.cache.size > 8) this.cache.delete(this.cache.keys().next().value!)
    return page
  }
}
