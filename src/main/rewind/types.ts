import type { RewindCheckpointDTO, RewindErrorCode, RewindErrorDTO, RewindMode, RewindOperationDTO, RewindUncoveredPathDTO } from '../../shared/types'

export class RewindFailure extends Error {
  constructor(readonly code: RewindErrorCode, readonly paths: string[] = [], readonly operationId?: string) { super(code) }
  dto(): RewindErrorDTO { return { code: this.code, ...(this.paths.length ? { paths: this.paths } : {}), ...(this.operationId ? { operationId: this.operationId } : {}) } }
}
export function failure(error: unknown): RewindErrorDTO {
  return error instanceof RewindFailure ? error.dto() : { code: 'storage' }
}
export interface NodeState { kind: 'file' | 'symlink' | 'directory'; hash: string; mode: number; size: number }
export interface IndexEntry { path: string; mode: string; oid: string; stage: number; blob?: string }
export interface GitState {
  gitDir: string
  indexPath: string
  index: NodeState | null
  sharedIndexes: Record<string, NodeState>
  entries: IndexEntry[]
  flags: string
  head: string
  branch: string | null
}
export interface Snapshot {
  version: 1
  root: string
  nodes: Record<string, NodeState>
  git: GitState | null
  excluded: RewindCheckpointDTO['excluded']
  digest: string
}
export interface Checkpoint extends RewindCheckpointDTO { version: 1; snapshot: Snapshot }
export interface PathChange { path: string; before: NodeState | null; after: NodeState | null }
export interface RestorePlan {
  /** Inherited from a partial operation for Undo/Redo; never expands its writes. */
  skipped?: RewindUncoveredPathDTO[]
  /** An immutable working-file subset; always executed in files mode. */
  file?: string
  conversationUnavailable?: boolean
  version: 1
  token: string
  created: number
  sessionId: string
  targetId: string
  before: Snapshot
  after: Snapshot
  changes: PathChange[]
  undoOf?: string
  redoOf?: string
  blocked?: RewindErrorDTO
}
export interface Transaction extends RewindOperationDTO {
  version: 1
  plan: RestorePlan
  quarantine: string
  mode: RewindMode
}
export const nodeEqual = (a?: NodeState | null, b?: NodeState | null): boolean =>
  !a || !b ? !a && !b : a.kind === b.kind && a.hash === b.hash && a.mode === b.mode
