/** Public Git protocol. Main composes facts/error codes; renderer composes prose. */
export type GitErrorCode = 'invalid' | 'missing' | 'not-repository' | 'unavailable' | 'readonly' | 'busy' | 'terminal' | 'recovery' | 'stale' | 'conflict' | 'dirty' | 'identity' | 'upstream' | 'timeout' | 'cancelled' | 'output-limit' | 'unsupported' | 'command'
export type GitResult<T> = { ok: true; value: T } | { ok: false; code: GitErrorCode; detail?: string }
export interface GitLineStats { added: number; removed: number; binary: boolean }
export interface GitChange {
  path: string
  oldPath?: string
  index: string
  worktree: string
  untracked: boolean
  conflict: boolean
  submodule: boolean
  /** Status populates counts for each visible layer; null means unavailable. */
  stagedStats?: GitLineStats | null
  worktreeStats?: GitLineStats | null
}
export interface GitRepository {
  root: string
  revision: string
  head: string | null
  branch: string | null
  upstream: string | null
  ahead: number
  behind: number
  files: GitChange[]
  remotes: string[]
  identity: { name: string; email: string }
  operation: string | null
  blocked: GitErrorCode | null
}
export interface GitWorkspaceRequest { cwd: string }
export interface GitDiffRequest extends GitWorkspaceRequest {
  revision: string
  path: string
  area: 'staged' | 'unstaged' | 'commit'
  commit?: string
}
export interface GitDiff { patch: string; binary: boolean; truncated: boolean }
export interface GitBranch { name: string; current: boolean; worktree: string | null }
export interface GitCommit { id: string; parents: string[]; author: string; date: string; subject: string; body: string }
export interface GitHistoryRequest extends GitWorkspaceRequest { offset?: number; head?: string }
export interface GitHistory { head: string | null; commits: GitCommit[]; next: number | null }
export interface GitCommitFile { path: string; status: string }
export interface GitGraphRef { name: string; kind: 'branch' | 'remote' | 'tag' | 'head' }
export interface GitGraphCommit extends GitCommit { refs: GitGraphRef[] }
export interface GitGraphRequest extends GitWorkspaceRequest { offset?: number; revision?: string }
/** Pages are pinned to the complete visible ref frontier, including detached HEAD. */
export interface GitGraph { revision: string; head: string | null; branch: string | null; commits: GitGraphCommit[]; next: number | null; limited: boolean }
export interface GitCommitDetails { commit: GitCommit; files: GitCommitFile[] }
export interface GitDiscardPreview { token: string; paths: string[]; untracked: string[] }
export type GitAction = 'init' | 'stage' | 'unstage' | 'discard' | 'commit' | 'switch' | 'branch' | 'fetch' | 'pull' | 'push'
export interface GitMutation extends GitWorkspaceRequest {
  id: string
  revision: string
  action: GitAction
  paths?: string[]
  message?: string
  branch?: string
  remote?: string
  token?: string
}
export interface GitMutationReceipt { repository: GitRepository; output: string }
