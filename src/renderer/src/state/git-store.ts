import type { GitBranch, GitCommit, GitCommitDetails, GitCommitFile, GitDiff, GitDiffRequest, GitDiscardPreview, GitGraph, GitHistory, GitMutation, GitRepository, GitResult, GitMutationReceipt } from '../../../shared/git'

type Failure = Extract<GitResult<unknown>, { ok: false }>
export interface GitSelection { path: string; area: GitDiffRequest['area']; commit?: string }
export interface GitState {
  cwd: string | null
  view: 'changes' | 'history' | 'graph'
  returnView: 'changes' | 'history'
  splitWidths: Partial<Record<GitState['view'], number>>
  loading: boolean
  repository: GitRepository | null
  error: Failure | null
  actionError: Failure | null
  busy: { id: string; action: GitMutation['action'] } | null
  selection: GitSelection | null
  diff: GitDiff | null
  diffRevision: string | null
  diffLoading: boolean
  diffError: Failure | null
  branches: GitBranch[]
  branchesLoading: boolean
  history: GitHistory
  historyLoading: boolean
  historyError: Failure | null
  graph: GitGraph | null
  graphLoading: boolean
  graphError: Failure | null
  commit: GitCommit | null
  commitFiles: GitCommitFile[]
  commitFilesLoading: boolean
  commitError: Failure | null
  draft: string
  output: string
}
const initial = (cwd: string | null): GitState => ({ cwd, view: 'changes', returnView: 'changes', splitWidths: {}, loading: false, repository: null, error: null, actionError: null, busy: null, selection: null, diff: null, diffRevision: null, diffLoading: false, diffError: null, branches: [], branchesLoading: false, history: { head: null, commits: [], next: null }, historyLoading: false, historyError: null, graph: null, graphLoading: false, graphError: null, commit: null, commitFiles: [], commitFilesLoading: false, commitError: null, draft: '', output: '' })
const failure = (): Failure => ({ ok: false, code: 'command' })
const MAX_DIFF_BYTES = 8 * 1024 * 1024

/** A receipt may precede its branch read. Reconcile only this checkout's occupancy. */
function reconcileBranches(branches: GitBranch[], repo: GitRepository): GitBranch[] {
  const rows = branches.map(item => ({ ...item, current: item.name === repo.branch, worktree: item.name === repo.branch ? repo.root : item.current || item.worktree === repo.root ? null : item.worktree }))
  if (repo.branch && !rows.some(item => item.name === repo.branch)) rows.unshift({ name: repo.branch, current: true, worktree: repo.root })
  return rows
}

/** Workspace-owned read cache and drafts; pane mounts/width do not own requests. */
export class GitStore {
  private state = initial(null)
  private cache = new Map<string, GitState>()
  private listeners = new Set<() => void>()
  private refreshing = new Map<string, Promise<void>>()
  private readVersions = new Map<string, number>()
  private diffVersion = 0
  private historyVersion = 0
  private commitVersion = 0
  private branchVersion = 0
  private graphVersion = 0
  private branchReads = new Map<string, { version: number; promise: Promise<void> }>()
  private graphReads = new Map<string, { version: number; promise: Promise<void> }>()
  private diffs = new Map<string, { cwd: string; diff: GitDiff; bytes: number }>()
  private pendingDiffs = new Map<string, Promise<GitResult<GitDiff>>>()
  private diffBytes = 0
  private disposed = false
  private timer: ReturnType<typeof setInterval> | null = null
  private visible = false
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  getState = () => this.state
  private clearDiffCache(cwd?: string): void {
    for (const [key, entry] of this.diffs) if (!cwd || entry.cwd === cwd) { this.diffs.delete(key); this.diffBytes -= entry.bytes }
  }
  private rememberDiff(key: string, cwd: string, diff: GitDiff): void {
    const bytes = diff.patch.length * 2
    if (bytes > MAX_DIFF_BYTES) return
    const previous = this.diffs.get(key)
    if (previous) { this.diffBytes -= previous.bytes; this.diffs.delete(key) }
    this.diffs.set(key, { cwd, diff, bytes }); this.diffBytes += bytes
    while (this.diffs.size > 32 || this.diffBytes > MAX_DIFF_BYTES) {
      const first = this.diffs.entries().next().value!
      this.diffs.delete(first[0]); this.diffBytes -= first[1].bytes
    }
  }
  private publish(cwd: string | null, patch: Partial<GitState>): void {
    // A delayed response must not recreate an evicted workspace cache.
    const previous = cwd ? this.cache.get(cwd) : this.state
    if (!previous) return
    const next = { ...previous, ...patch }
    if (cwd) this.cache.set(cwd, next)
    if (this.state.cwd !== cwd) return
    this.state = next; for (const listener of this.listeners) listener()
  }
  bind(cwd: string | null): void {
    if (cwd === this.state.cwd) return
    ++this.diffVersion; ++this.historyVersion; ++this.commitVersion; ++this.branchVersion; ++this.graphVersion
    const cached = cwd ? this.cache.get(cwd) : null
    this.state = { ...(cached ?? initial(cwd)), diffLoading: false, historyLoading: false, commitFilesLoading: false, branchesLoading: false, graphLoading: false }
    if (cwd) {
      this.cache.delete(cwd); this.cache.set(cwd, this.state)
      while (this.cache.size > 8) { const key = [...this.cache.keys()].find(key => key !== cwd && !this.cache.get(key)?.busy); if (!key) break; this.cache.delete(key); this.clearDiffCache(key); if (!this.refreshing.has(key)) this.readVersions.delete(key) }
    }
    for (const listener of this.listeners) listener()
    if (this.visible) void this.refresh()
    if (cached?.commitFilesLoading && cached.commit) void this.selectCommit(cached.commit)
    else if (cached?.diffLoading && cached.selection) void this.select(cached.selection)
    if (cached?.branchesLoading) void this.loadBranches()
    if (cached?.graphLoading && cached.view === 'graph') void this.loadGraph()
  }
  private focus = () => { if (this.visible) void this.refresh() }
  setVisible(visible: boolean): void {
    this.visible = visible
    if (visible && !this.timer) {
      window.addEventListener('focus', this.focus)
      this.timer = setInterval(() => { if (document.visibilityState === 'visible') void this.refresh() }, 3000)
      void this.refresh()
    } else if (!visible && this.timer) { clearInterval(this.timer); this.timer = null; window.removeEventListener('focus', this.focus) }
  }
  refresh = (): Promise<void> => {
    const cwd = this.state.cwd
    if (!cwd || this.state.busy) return Promise.resolve()
    const pending = this.refreshing.get(cwd); if (pending) return pending
    const work = this.load(cwd).finally(() => this.refreshing.delete(cwd)); this.refreshing.set(cwd, work); return work
  }
  private async load(cwd: string): Promise<void> {
    const version = this.readVersions.get(cwd) ?? 0
    if (!this.cache.get(cwd)?.repository) { this.publish(cwd, { loading: true }); if (cwd === this.state.cwd) void this.loadBranches() }
    let result: GitResult<GitRepository>
    try { result = await window.pi.gitStatus({ cwd }) } catch { result = failure() }
    if (version !== (this.readVersions.get(cwd) ?? 0)) return
    if (!result.ok) { this.publish(cwd, { loading: false, error: result, ...(['missing', 'not-repository'].includes(result.code) ? { repository: null, selection: null, diff: null, diffRevision: null, diffLoading: false } : {}) }); return }
    const previous = this.cache.get(cwd)?.repository
    if (previous?.revision !== result.value.revision) this.clearDiffCache(cwd)
    const branches = previous?.root === result.value.root ? this.cache.get(cwd)!.branches : []
    this.publish(cwd, { loading: false, repository: result.value, branches: reconcileBranches(branches, result.value), error: null })
    if (cwd !== this.state.cwd) return
    if (!previous || previous.head !== result.value.head || previous.branch !== result.value.branch || (!this.state.historyLoading && this.state.history.head !== result.value.head)) { void this.loadHistory(); void this.loadBranches() }
    if (this.state.view === 'graph') void this.loadGraph()
    // Mutation receipts may already have advanced `repository`. Compare with the
    // preview's own revision so reads selected during a write cannot get stranded.
    if (this.state.selection && this.state.diffRevision !== result.value.revision) {
      const selection = this.state.selection
      if (selection.area === 'commit' || result.value.files.some(file => file.path === selection.path && (selection.area === 'staged' ? file.index !== '.' && !file.untracked : file.worktree !== '.'))) void this.select(selection)
      else {
        const remaining = result.value.files.find(file => file.path === selection.path)
        if (remaining) void this.select({ path: selection.path, area: remaining.untracked || remaining.worktree !== '.' ? 'unstaged' : 'staged' })
        else this.clearSelection()
      }
    }
  }
  setDraft(draft: string): void { this.publish(this.state.cwd, { draft }) }
  setSplitWidth(view: GitState['view'], width: number, cwd = this.state.cwd): void {
    const previous = cwd ? this.cache.get(cwd) : this.state
    width = Math.round(width)
    if (!previous || !Number.isFinite(width) || width <= 0 || width > 10000) return
    if (previous.splitWidths[view] !== width) this.publish(cwd, { splitWidths: { ...previous.splitWidths, [view]: width } })
  }
  setView(view: GitState['view']): void {
    this.publish(this.state.cwd, { view, ...(view === 'graph' && this.state.view !== 'graph' ? { returnView: this.state.view as GitState['returnView'] } : {}) }); this.clearSelection()
    void this.selectCommit(null)
    if (view === 'history') void this.loadHistory()
    else if (view === 'graph') void this.loadGraph()
  }
  toggleGraph(): void { this.setView(this.state.view === 'graph' ? this.state.returnView : 'graph') }
  clearSelection(): void { ++this.diffVersion; this.publish(this.state.cwd, { selection: null, diff: null, diffRevision: null, diffError: null, diffLoading: false }) }
  async select(selection: GitSelection): Promise<void> {
    const cwd = this.state.cwd, repo = this.state.repository; if (!cwd || !repo) return
    const version = ++this.diffVersion
    const key = JSON.stringify([cwd, repo.revision, selection.path, selection.area, selection.commit ?? null])
    const cached = this.diffs.get(key)
    if (cached) {
      this.diffs.delete(key); this.diffs.set(key, cached)
      this.publish(cwd, { selection, diff: cached.diff, diffRevision: repo.revision, diffLoading: false, diffError: null }); return
    }
    this.publish(cwd, { selection, diff: null, diffRevision: repo.revision, diffLoading: true, diffError: null })
    let pending = this.pendingDiffs.get(key)
    if (!pending) {
      pending = (async () => {
        let result: GitResult<GitDiff>
        try { result = await window.pi.gitDiff({ cwd, revision: repo.revision, ...selection }) } catch { result = failure() }
        if (result.ok && !this.disposed && this.cache.get(cwd)?.repository?.revision === repo.revision) this.rememberDiff(key, cwd, result.value)
        return result
      })()
      this.pendingDiffs.set(key, pending)
      const request = pending
      void request.finally(() => { if (this.pendingDiffs.get(key) === request) this.pendingDiffs.delete(key) })
    }
    const result = await pending
    if (cwd !== this.state.cwd || version !== this.diffVersion || repo.revision !== this.state.repository?.revision) return
    this.publish(cwd, result.ok ? { diff: result.value, diffLoading: false } : { diffError: result, diffLoading: false })
    if (!result.ok && result.code === 'stale') void this.refresh()
  }
  loadBranches(): Promise<void> {
    const cwd = this.state.cwd; if (!cwd) return Promise.resolve()
    const pending = this.branchReads.get(cwd)
    if (pending?.version === this.branchVersion) return pending.promise
    const version = ++this.branchVersion
    this.publish(cwd, { branchesLoading: true })
    const promise = (async () => {
      let result: GitResult<GitBranch[]>
      try { result = await window.pi.gitBranches({ cwd }) } catch { result = failure() }
      if (cwd !== this.state.cwd || version !== this.branchVersion) return
      this.publish(cwd, result.ok ? { branches: this.state.repository ? reconcileBranches(result.value, this.state.repository) : result.value, branchesLoading: false } : { ...(this.state.repository ? { actionError: result } : {}), branchesLoading: false })
    })().finally(() => { if (this.branchReads.get(cwd)?.version === version) this.branchReads.delete(cwd) })
    this.branchReads.set(cwd, { version, promise }); return promise
  }
  loadGraph(more = false): Promise<void> {
    const cwd = this.state.cwd; if (!cwd || !this.state.repository) return Promise.resolve()
    const pending = this.graphReads.get(cwd)
    if (pending?.version === this.graphVersion) return pending.promise
    const previous = this.state.graph, offset = more ? previous?.next : 0
    if (offset == null || (more && !previous)) return Promise.resolve()
    const version = ++this.graphVersion
    this.publish(cwd, { graphLoading: true, graphError: null })
    let restart = false
    const promise = (async () => {
      let result: GitResult<GitGraph>
      try { result = await window.pi.gitGraph({ cwd, offset, ...(more && previous ? { revision: previous.revision } : {}) }) } catch { result = failure() }
      if (cwd !== this.state.cwd || version !== this.graphVersion) return
      if (!result.ok) { this.publish(cwd, { graphError: result, graphLoading: false }); restart = more && result.code === 'stale'; return }
      const commits = more && previous ? [...previous.commits, ...result.value.commits] : result.value.commits
      if (new Set(commits.map(commit => commit.id)).size !== commits.length) { this.publish(cwd, { graphError: { ok: false, code: 'stale' }, graphLoading: false }); restart = true; return }
      if (JSON.stringify(commits).length * 2 > MAX_DIFF_BYTES) { this.publish(cwd, { graphError: { ok: false, code: 'output-limit' }, graphLoading: false }); return }
      // An unchanged frontier preserves already loaded pages and the layout identity.
      const graph = !more && previous?.revision === result.value.revision ? previous : { ...result.value, commits }
      this.publish(cwd, { graph, graphLoading: false, graphError: null })
    })().finally(() => {
      if (this.graphReads.get(cwd)?.version === version) this.graphReads.delete(cwd)
      if (restart && cwd === this.state.cwd && version === this.graphVersion) void this.loadGraph()
    })
    this.graphReads.set(cwd, { version, promise }); return promise
  }
  async loadHistory(more = false): Promise<void> {
    const cwd = this.state.cwd; if (!cwd) return
    const offset = more ? this.state.history.next : 0; if (offset === null) return
    if (more && (!this.state.history.head || this.state.historyLoading)) return
    const version = ++this.historyVersion
    this.publish(cwd, { historyLoading: true, historyError: null })
    let result: GitResult<GitHistory>
    try { result = await window.pi.gitHistory({ cwd, offset, ...(more && this.state.history.head ? { head: this.state.history.head } : {}) }) } catch { result = failure() }
    if (cwd !== this.state.cwd || version !== this.historyVersion) return
    this.publish(cwd, result.ok ? { history: { ...result.value, commits: more ? [...this.state.history.commits, ...result.value.commits] : result.value.commits }, historyLoading: false } : { historyError: result, historyLoading: false })
    if (!result.ok && result.code === 'stale') { void this.refresh(); if (more) void this.loadHistory() }
  }
  async selectCommit(commit: GitCommit | null): Promise<void> {
    const cwd = this.state.cwd; if (!cwd) return
    this.clearSelection(); const version = ++this.commitVersion
    this.publish(cwd, { commit, commitFiles: [], commitFilesLoading: !!commit, commitError: null })
    if (!commit) return
    let result: GitResult<GitCommitDetails>
    try {
      if (this.state.view === 'graph') result = await window.pi.gitCommitDetails({ cwd, commit: commit.id })
      else { const files = await window.pi.gitCommitFiles({ cwd, commit: commit.id }); result = files.ok ? { ok: true, value: { commit, files: files.value } } : files }
    } catch { result = failure() }
    if (cwd !== this.state.cwd || version !== this.commitVersion) return
    this.publish(cwd, result.ok ? { commit: result.value.commit, commitFiles: result.value.files, commitFilesLoading: false } : { commitError: result, commitFilesLoading: false })
  }
  async prepareDiscard(paths: string[]): Promise<GitDiscardPreview | null> {
    const cwd = this.state.cwd, repo = this.state.repository; if (!cwd || !repo || this.state.busy) return null
    try {
      const result = await window.pi.gitPrepareDiscard({ cwd, revision: repo.revision, paths })
      if (cwd !== this.state.cwd) return null
      if (result.ok) return result.value
      this.publish(cwd, { actionError: result }); if (result.code === 'stale') void this.refresh()
    } catch { this.publish(cwd, { actionError: failure() }) }
    return null
  }
  async execute(action: GitMutation['action'], fields: Partial<GitMutation> = {}): Promise<boolean> {
    const cwd = this.state.cwd, repo = this.state.repository
    if (!cwd || this.state.busy || (action !== 'init' && !repo)) return false
    const id = crypto.randomUUID()
    this.readVersions.set(cwd, (this.readVersions.get(cwd) ?? 0) + 1)
    const selection = this.state.selection, selectedVersion = this.diffVersion, commitVersion = this.commitVersion
    this.publish(cwd, { busy: { id, action }, actionError: null, output: '' })
    let result: GitResult<GitMutationReceipt>
    try { result = await window.pi.gitExecute({ ...fields, cwd, id, action, revision: repo?.revision ?? '' }) } catch { result = failure() }
    if (result.ok && cwd === this.state.cwd) ++this.branchVersion
    this.publish(cwd, result.ok ? { repository: result.value.repository, branches: reconcileBranches(this.cache.get(cwd)?.branches ?? [], result.value.repository), branchesLoading: false, error: null, output: result.value.output, ...(action === 'commit' ? { draft: '' } : {}) } : { actionError: result })
    if (cwd === this.state.cwd) {
      await this.refreshing.get(cwd)
      if (cwd === this.state.cwd) await this.load(cwd)
      if (cwd !== this.state.cwd) { this.publish(cwd, { busy: null }); return result.ok }
      void this.loadBranches()
      if (selection && result.ok && this.diffVersion === selectedVersion) {
        const file = this.state.repository?.files.find(file => file.path === selection.path)
        if (selection.area === 'commit') void this.select(selection)
        else if (file) void this.select({ path: file.path, area: action === 'stage' ? 'staged' : action === 'unstage' ? 'unstaged' : file.worktree !== '.' ? 'unstaged' : 'staged' })
        else this.clearSelection()
      }
      if (result.ok && ['commit', 'pull', 'switch', 'branch'].includes(action)) { void this.loadHistory(); if (this.commitVersion === commitVersion) void this.selectCommit(null) }
    }
    this.publish(cwd, { busy: null })
    return result.ok
  }
  async cancel(): Promise<void> {
    const { cwd, busy } = this.state; if (!cwd || !busy) return
    try { const result = await window.pi.gitCancel({ cwd, id: busy.id }); if (!result.ok) this.publish(cwd, { actionError: result }) } catch { this.publish(cwd, { actionError: failure() }) }
  }
  dismissError(): void { this.publish(this.state.cwd, { actionError: null, output: '' }) }
  stalePreview(): void { this.publish(this.state.cwd, { actionError: { ok: false, code: 'stale' } }); void this.refresh() }
  dispose(): void { this.disposed = true; this.setVisible(false); ++this.diffVersion; ++this.historyVersion; ++this.commitVersion; ++this.branchVersion; ++this.graphVersion; this.clearDiffCache(); this.pendingDiffs.clear(); this.branchReads.clear(); this.graphReads.clear(); this.listeners.clear() }
}
