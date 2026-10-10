import type { TrajectoryDocumentKind, TrajectoryKind, TrajectoryQuery, TrajectoryRecord, TrajectoryNodeRequest } from '../../../shared/trajectory'

export interface TraceWrite {
  record: Omit<TrajectoryRecord, 'seq'>
  sessionId: string
  anchor: string
  entryId?: string
  documents?: Partial<Record<TrajectoryDocumentKind, unknown>>
}
export interface TraceAccess { sessionPath: string; sessionId: string; leafId?: string | null }
export type TraceCommand =
  | { type: 'write'; value: TraceWrite }
  | { type: 'page'; access: TraceAccess; query: TrajectoryQuery }
  | { type: 'detail'; access: TraceAccess; recordId: string }
  | { type: 'context'; access: TraceAccess }
  | { type: 'node'; access: TraceAccess; request: TrajectoryNodeRequest }
  | { type: 'export'; access: TraceAccess; recordId: string; path: string }
  | { type: 'settle'; sessionId: string }
  | { type: 'close' }
export const TRACE_KINDS: readonly TrajectoryKind[] = ['run', 'user', 'assistant', 'request', 'tool', 'compaction', 'retry', 'notification']
