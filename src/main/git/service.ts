import { createHash, randomUUID } from 'node:crypto'
import type { GitBranch, GitChange, GitCommitDetails, GitCommitFile, GitDiff, GitDiffRequest, GitDiscardPreview, GitGraph, GitGraphRequest, GitHistory, GitHistoryRequest, GitMutation, GitMutationReceipt, GitRepository, GitResult, GitWorkspaceRequest } from '../../shared/git'
import type { CheckoutCoordinator } from '../rewind/coordinator'
import { GitFailure, gitResult } from './errors'
import { GitRunner } from './runner'
import { GitStatistics } from './statistics'
import { GitGraphReader } from './graph'
import { parseHistory } from './parse'
import { blockReason, canonicalDirectory, entryPath, fileDigest, hasGitAncestor, inspect, MAX_FILES, MAX_PATCH_BYTES, readPreviewFile, trimLine } from './repository'

const PREVIEW_TTL = 5 * 60_000
const RECEIPT_TTL = 15 * 60_000
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
interface Preview { cwd: string; root: string; revision: string; paths: string[]; digests: string[]; at: number }
interface Receipt { key: string; cwd: string; controller: AbortController; at: number; settled: boolean; result: Promise<GitResult<GitMutationReceipt>> }
export interface GitServiceOptions {
  coordinator: CheckoutCoordinator
  /** Current main-owned workspace; a switched/read-only view cannot write. */
  workspace: () => { cwd: string | null; writable: boolean }
  trash: (path: string) => Promise<void>
}

export class GitWorkbench {
  private runner: GitRunner
  private statistics: GitStatistics
  private graphs: GitGraphReader
  private statisticsCache = new Map<string, Promise<GitChange[]>>()
  private previews = new Map<string, Preview>()
  private receipts = new Map<string, Receipt>()
  private closing = false
  constructor(private readonly options: GitServiceOptions) {
    this.runner = new GitRunner(cwd => options.coordinator.fence(cwd))
    this.statistics = new GitStatistics(this.runner)
    this.graphs = new GitGraphReader(this.runner)
  }
  private async workspace(request: GitWorkspaceRequest, write = false): Promise<string> {
    if (this.closing) throw new GitFailure('cancelled')
    const active = this.options.workspace()
    if (!request || !active.cwd) throw new GitFailure('readonly')
    if (write && !active.writable) throw new GitFailure('readonly')
    const cwd = await canonicalDirectory(request.cwd), current = await canonicalDirectory(active.cwd)
    if (cwd !== current) throw new GitFailure('stale')
    return cwd
  }
  private async read(request: GitWorkspaceRequest, write = false) {
    const cwd = await this.workspace(request, write)
    await this.options.coordinator.ready()
    return { cwd, ...await inspect(this.runner, cwd, this.options.coordinator) }
  }
  status(request: GitWorkspaceRequest): Promise<GitResult<GitRepository>> {
    return gitResult(async () => {
      const { repository } = await this.read(request), key = JSON.stringify([repository.root, repository.revision])
      let counts = this.statisticsCache.get(key)
      if (!counts) {
        counts = this.statistics.files(repository).then(async files => {
          if ((await inspect(this.runner, repository.root, this.options.coordinator)).repository.revision !== repository.revision) throw new GitFailure('stale')
          return files
        })
        this.statisticsCache.set(key, counts)
        const current = counts
        void counts.catch(() => { if (this.statisticsCache.get(key) === current) this.statisticsCache.delete(key) })
        while (this.statisticsCache.size > 8) this.statisticsCache.delete(this.statisticsCache.keys().next().value!)
      }
      return { ...repository, files: await counts, blocked: this.options.workspace().writable ? blockReason(this.options.coordinator, repository.root) : 'readonly' }
    })
  }
  diff(request: GitDiffRequest): Promise<GitResult<GitDiff>> {
    return gitResult(async () => {
      const { cwd, repository: repo } = await this.read(request)
      if (!request || !['staged', 'unstaged', 'commit'].includes(request.area) || typeof request.path !== 'string') throw new GitFailure('invalid')
      if (repo.revision !== request.revision) throw new GitFailure('stale')
      const path = await entryPath(repo.root, request.path)
      const flags = ['--no-ext-diff', '--no-textconv', '--no-renames', '--no-color', '--unified=3']
      let patch: string
      if (request.area === 'commit') {
        if (!request.commit || !SHA.test(request.commit)) throw new GitFailure('invalid')
        const parents = await this.commitParents(repo.root, request.commit)
        if (parents[0]) patch = (await this.runner.run(repo.root, ['diff', ...flags, parents[0], request.commit, '--', request.path], { limit: MAX_PATCH_BYTES, strictUtf8: true })).stdout
        else patch = (await this.runner.run(repo.root, ['show', '--format=', ...flags, request.commit, '--', request.path], { limit: MAX_PATCH_BYTES, strictUtf8: true })).stdout
      } else {
        const file = repo.files.find(file => file.path === request.path && (request.area === 'staged' ? !file.untracked && file.index !== '.' : file.untracked || file.worktree !== '.'))
        if (!file) throw new GitFailure('stale')
        if (file.submodule) return { patch: '', binary: false, truncated: false }
        if (file.untracked) {
          const bytes = await readPreviewFile(path)
          if (bytes.includes(0) || !Buffer.from(bytes.toString('utf8')).equals(bytes)) return { patch: '', binary: true, truncated: false }
          const text = bytes.toString('utf8'), lines = (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n')
          const label = /[\s"\\]/.test(file.path) ? JSON.stringify(`b/${file.path}`) : `b/${file.path}`
          patch = text ? `--- /dev/null\n+++ ${label}\n@@ -0,0 +1,${lines.length} @@\n${lines.map(line => '+' + line).join('\n')}${text.endsWith('\n') ? '\n' : '\n\\ No newline at end of file\n'}` : ''
        } else patch = (await this.runner.run(repo.root, ['diff', ...flags, ...(request.area === 'staged' ? ['--cached'] : []), '--', ...[file.path, file.oldPath].filter((p): p is string => !!p)], { limit: MAX_PATCH_BYTES, strictUtf8: true })).stdout
      }
      if ((await inspect(this.runner, cwd, this.options.coordinator)).repository.revision !== repo.revision) throw new GitFailure('stale')
      return { patch, binary: /^(?:Binary files |GIT binary patch)/m.test(patch), truncated: false }
    })
  }
  branches(request: GitWorkspaceRequest): Promise<GitResult<GitBranch[]>> {
    return gitResult(async () => {
      const { repository: repo } = await this.read(request)
      const text = (await this.runner.run(repo.root, ['for-each-ref', '--format=%(refname:short)%00%(HEAD)%00%(worktreepath)%00', 'refs/heads/'], { strictUtf8: true })).stdout
      return text.split('\0\n').filter(Boolean).map(row => { const fields = row.split('\0'); if (fields.length !== 3) throw new GitFailure('unsupported'); const [name, head, worktree] = fields; return { name, current: head === '*', worktree: worktree || null } })
    })
  }
  history(request: GitHistoryRequest): Promise<GitResult<GitHistory>> {
    return gitResult(async () => {
      const { repository: repo } = await this.read(request), offset = request.offset ?? 0
      if (!Number.isInteger(offset) || offset < 0 || offset > 100_000 || (request.head !== undefined && !SHA.test(request.head)) || (offset > 0 && !request.head)) throw new GitFailure('invalid')
      if (request.head && request.head !== repo.head) throw new GitFailure('stale')
      if (!repo.head) return { head: null, commits: [], next: null }
      const commits = parseHistory((await this.runner.run(repo.root, ['log', '-z', '--format=%H%x00%P%x00%an%x00%aI%x00%s%x00%b', '--max-count=51', `--skip=${offset}`, repo.head, '--'], { strictUtf8: true })).stdout)
      return { head: repo.head, commits: commits.slice(0, 50), next: commits.length > 50 ? offset + 50 : null }
    })
  }
  private async commitParents(root: string, commit: string): Promise<string[]> {
    const row = (await this.runner.run(root, ['rev-list', '--parents', '-n', '1', commit, '--'])).stdout.trim().split(' ')
    if (row[0] !== commit) throw new GitFailure('invalid')
    return row.slice(1)
  }
  graph(request: GitGraphRequest): Promise<GitResult<GitGraph>> {
    return gitResult(async () => { const { repository } = await this.read(request); return this.graphs.read(repository.root, request) })
  }
  commitDetails(request: GitWorkspaceRequest & { commit: string }): Promise<GitResult<GitCommitDetails>> {
    return gitResult(async () => {
      const { repository: repo } = await this.read(request)
      if (typeof request.commit !== 'string' || !SHA.test(request.commit)) throw new GitFailure('invalid')
      const [commits, files] = await Promise.all([
        this.runner.run(repo.root, ['log', '-z', '-1', '--format=%H%x00%P%x00%an%x00%aI%x00%s%x00%b', request.commit, '--'], { strictUtf8: true, limit: MAX_PATCH_BYTES }).then(result => parseHistory(result.stdout)),
        this.readCommitFiles(repo.root, request.commit),
      ])
      if (commits.length !== 1 || commits[0].id !== request.commit) throw new GitFailure('invalid')
      return { commit: commits[0], files }
    })
  }
  commitFiles(request: GitWorkspaceRequest & { commit: string }): Promise<GitResult<GitCommitFile[]>> {
    return gitResult(async () => {
      const { repository: repo } = await this.read(request)
      if (typeof request.commit !== 'string' || !SHA.test(request.commit)) throw new GitFailure('invalid')
      return this.readCommitFiles(repo.root, request.commit)
    })
  }
  private async readCommitFiles(root: string, commit: string): Promise<GitCommitFile[]> {
    const parents = await this.commitParents(root, commit)
    const args = parents[0] ? ['diff', '--name-status', '-z', '--no-renames', parents[0], commit, '--'] : ['diff-tree', '--root', '--no-commit-id', '-r', '--name-status', '-z', '--no-renames', commit, '--']
    const fields = (await this.runner.run(root, args, { strictUtf8: true })).stdout.split('\0'); if (fields.at(-1) === '') fields.pop()
    if (fields.length % 2 || fields.length / 2 > MAX_FILES) throw new GitFailure('output-limit')
    const files: GitCommitFile[] = []; for (let i = 0; i < fields.length; i += 2) { await entryPath(root, fields[i + 1]); files.push({ status: fields[i], path: fields[i + 1] }) }
    return files
  }
  prepareDiscard(request: GitWorkspaceRequest & { revision: string; paths: string[] }): Promise<GitResult<GitDiscardPreview>> {
    return gitResult(async () => {
      const { cwd, repository: repo } = await this.read(request, true)
      if (repo.revision !== request.revision) throw new GitFailure('stale')
      const files = this.select(repo, request.paths, 'worktree')
      if (files.some(file => file.conflict || file.submodule || file.worktree === '.')) throw new GitFailure('unsupported')
      const paths = files.map(file => file.path), digests: string[] = []
      for (const path of paths) digests.push(await fileDigest(await entryPath(repo.root, path)))
      if ((await this.read(request, true)).repository.revision !== repo.revision) throw new GitFailure('stale')
      const token = randomUUID(); this.prune()
      this.previews.set(token, { cwd, root: repo.root, revision: repo.revision, paths, digests, at: Date.now() })
      return { token, paths, untracked: files.filter(file => file.untracked).map(file => file.path) }
    })
  }
  private select(repo: GitRepository, paths: unknown, area: 'any' | 'worktree' = 'any') {
    if (!Array.isArray(paths) || !paths.length || paths.length > MAX_FILES || paths.some(path => typeof path !== 'string') || new Set(paths).size !== paths.length) throw new GitFailure('invalid')
    return paths.map(path => { const file = repo.files.find(file => file.path === path && (area === 'any' || file.untracked || file.worktree !== '.')); if (!file) throw new GitFailure('stale'); return file })
  }
  private prune(): void {
    for (const [key, value] of this.previews) if (Date.now() - value.at > PREVIEW_TTL || this.previews.size > 64) this.previews.delete(key)
    for (const [key, value] of this.receipts) if (value.settled && (Date.now() - value.at > RECEIPT_TTL || this.receipts.size > 256)) this.receipts.delete(key)
  }
  execute(request: GitMutation): Promise<GitResult<GitMutationReceipt>> {
    if (!request || typeof request.id !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(request.id)) return Promise.resolve({ ok: false, code: 'invalid' })
    let key: string
    try { key = createHash('sha256').update(JSON.stringify(request)).digest('hex') } catch { return Promise.resolve({ ok: false, code: 'invalid' }) }
    const previous = this.receipts.get(request.id)
    if (previous) return previous.key === key ? previous.result : Promise.resolve({ ok: false, code: 'invalid' })
    this.prune(); const controller = new AbortController()
    const result = gitResult(() => this.mutate(request, controller.signal))
    const receipt: Receipt = { key, cwd: request.cwd, controller, at: Date.now(), settled: false, result }
    this.receipts.set(request.id, receipt)
    void result.then(() => { receipt.settled = true; receipt.at = Date.now(); this.prune() })
    return result
  }
  cancel(request: GitWorkspaceRequest & { id: string }): Promise<GitResult<void>> {
    return gitResult(async () => { await this.workspace(request); const receipt = this.receipts.get(request.id); if (!receipt || receipt.cwd !== request.cwd) throw new GitFailure('invalid'); receipt.controller.abort() })
  }
  private async mutate(request: GitMutation, signal: AbortSignal): Promise<GitMutationReceipt> {
    const cwd = await this.workspace(request, true)
    if (typeof request.revision !== 'string' || !['init', 'stage', 'unstage', 'discard', 'commit', 'switch', 'branch', 'fetch', 'pull', 'push'].includes(request.action)) throw new GitFailure('invalid')
    await this.options.coordinator.ready()
    const blocked = blockReason(this.options.coordinator, cwd); if (blocked) throw new GitFailure(blocked)
    try {
      const receipt = await this.options.coordinator.withExclusive(cwd, 'git', async () => {
        await this.workspace(request, true)
        if (signal.aborted) throw new GitFailure('cancelled')
        if (request.action === 'init') {
          if (request.revision !== '' || await hasGitAncestor(cwd)) throw new GitFailure('stale')
          const bare = await this.runner.run(cwd, ['rev-parse', '--is-bare-repository'], { accept: [128], signal })
          if (bare.stdout.trim() === 'true') throw new GitFailure('unsupported')
          await this.runner.run(cwd, ['init'], { signal })
          return { repository: (await inspect(this.runner, cwd, this.options.coordinator, signal)).repository, output: '' }
        }
        const { repository: repo } = await inspect(this.runner, cwd, this.options.coordinator, signal)
        if (repo.revision !== request.revision) throw new GitFailure('stale')
        const run = (args: string[], options: { input?: string; network?: boolean; accept?: number[] } = {}) => this.runner.run(repo.root, args, { ...options, signal, timeoutMs: 120_000 })
        let output = ''
        if (request.action === 'stage' || request.action === 'unstage') {
          const files = this.select(repo, request.paths)
          if (request.action === 'unstage' && files.some(file => file.conflict)) throw new GitFailure('conflict')
          const paths = [...new Set(files.flatMap(file => [file.path, ...(file.oldPath ? [file.oldPath] : [])]))]
          for (const path of paths) await entryPath(repo.root, path)
          const input = paths.join('\0') + '\0', pathspec = ['--pathspec-from-file=-', '--pathspec-file-nul']
          await run(request.action === 'stage' ? ['add', '-A', ...pathspec] : repo.head ? ['restore', '--staged', '--source=HEAD', ...pathspec] : ['rm', '--cached', '--force', '--ignore-unmatch', ...pathspec], { input })
        } else if (request.action === 'discard') {
          const preview = typeof request.token === 'string' ? this.previews.get(request.token) : undefined
          if (!preview || Date.now() - preview.at > PREVIEW_TTL || preview.cwd !== cwd || preview.root !== repo.root || preview.revision !== repo.revision) throw new GitFailure('stale')
          const files = this.select(repo, preview.paths, 'worktree')
          for (let i = 0; i < preview.paths.length; i++) if (await fileDigest(await entryPath(repo.root, preview.paths[i]), signal) !== preview.digests[i]) throw new GitFailure('stale')
          this.previews.delete(request.token!)
          const tracked = files.filter(file => !file.untracked).map(file => file.path)
          if (tracked.length) await run(['restore', '--worktree', '--pathspec-from-file=-', '--pathspec-file-nul'], { input: tracked.join('\0') + '\0' })
          for (const file of files.filter(file => file.untracked)) { if (signal.aborted) throw new GitFailure('cancelled'); await this.options.trash(await entryPath(repo.root, file.path)) }
        } else if (request.action === 'commit') {
          if (repo.files.some(file => file.conflict)) throw new GitFailure('conflict')
          if (repo.operation) throw new GitFailure('unsupported')
          if (!repo.identity.name || !repo.identity.email) throw new GitFailure('identity')
          if (!repo.files.some(file => file.index !== '.' && !file.untracked) || typeof request.message !== 'string' || !request.message.trim() || request.message.length > 64_000 || request.message.includes('\0')) throw new GitFailure('invalid')
          output = (await run(['commit', '--file=-'], { input: request.message })).stdout
        } else if (request.action === 'switch' || request.action === 'branch') {
          if (repo.files.length || repo.operation) throw new GitFailure('dirty')
          if (typeof request.branch !== 'string' || !request.branch || request.branch.length > 255 || request.branch.startsWith('-') || request.branch.includes('\0')) throw new GitFailure('invalid')
          await run(['check-ref-format', '--branch', request.branch])
          // No DWIM remote branch creation and no implicit stash/reset.
          output = (await run(['switch', ...(request.action === 'branch' ? ['-c'] : ['--no-guess']), request.branch])).stdout
        } else {
          if (request.action !== 'fetch' && (!repo.branch || !repo.head)) throw new GitFailure('upstream')
          if (repo.operation || repo.files.some(file => file.conflict)) throw new GitFailure('conflict')
          if (!repo.remotes.length) throw new GitFailure('upstream')
          if (request.action === 'fetch') output = (await run(['fetch', '--all', '--prune'], { network: true })).stderr
          if (request.action === 'pull') {
            if (repo.files.length) throw new GitFailure('dirty')
            if (!repo.upstream) throw new GitFailure('upstream')
            output = (await run(['-c', 'pull.rebase=false', 'pull', '--ff-only', '--no-edit'], { network: true })).stdout
          }
          if (request.action === 'push') {
            const row = (await run(['for-each-ref', '--format=%(upstream:remotename)%00%(upstream:remoteref)', `refs/heads/${repo.branch}`])).stdout
            let [remote, ref] = trimLine(row).split('\0')
            const first = !remote || !ref
            if (first) { remote = request.remote ?? ''; ref = `refs/heads/${repo.branch}` }
            if (!repo.remotes.includes(remote) || !ref?.startsWith('refs/heads/')) throw new GitFailure('upstream')
            output = (await run(['push', '--porcelain', ...(first ? ['--set-upstream'] : []), '--', remote, `HEAD:${ref}`], { network: true })).stdout
          }
        }
        return { repository: (await inspect(this.runner, cwd, this.options.coordinator, signal)).repository, output: output.slice(0, 8192) }
      })
      return { ...receipt, repository: { ...receipt.repository, blocked: blockReason(this.options.coordinator, receipt.repository.root) } }
    } catch (error) {
      if (error instanceof GitFailure) throw error
      if (error && typeof error === 'object' && 'code' in error && ['busy', 'recovery', 'terminal'].includes(String(error.code))) throw new GitFailure(error.code as 'busy' | 'recovery' | 'terminal')
      throw error
    }
  }
  async dispose(): Promise<void> { this.closing = true; this.graphs.clear(); this.statisticsCache.clear(); this.statistics.clear(); for (const receipt of this.receipts.values()) receipt.controller.abort(); await this.runner.dispose() }
}
