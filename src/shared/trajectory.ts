/** Diagnostic data stays outside model history. Bodies are addressed by opaque
 * content hashes and read only through a record's verified ancestry. */
import type { ContextRequestDTO } from './types'
export type TrajectoryKind = 'run' | 'user' | 'assistant' | 'request' | 'tool' | 'compaction' | 'retry' | 'notification'
/** Recovered assistant entries are the older capture format of a model turn. */
export type TrajectoryPresentationKind = Exclude<TrajectoryKind, 'assistant'>
export const trajectoryPresentationKind = (kind: TrajectoryKind): TrajectoryPresentationKind => kind === 'assistant' ? 'request' : kind
export type TrajectoryStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'unavailable'
export interface TrajectoryUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  cost: number
}
export interface TrajectoryRecord {
  id: string
  seq: number
  kind: TrajectoryKind
  name: string
  /** Bounded plain-text excerpt; full documents remain lazy. */
  preview?: string
  /** Output call identities only; arguments stay in the actual tool record. */
  toolCalls?: Array<{ id: string; name: string }>
  toolCallId?: string
  startedAt: number
  finishedAt?: number
  firstTokenAt?: number
  status: TrajectoryStatus
  provider?: string
  model?: string
  parentId?: string
  turnId?: string
  usage?: TrajectoryUsage
  httpStatus?: number
  stopReason?: string
  /** Recorded requests differ from messages reconstructed from older logs. */
  captured: boolean
  captureError?: boolean
  /** Bounded statistics, retained separately from lazy request documents. */
  contextStats?: ContextRequestDTO
}
export interface TrajectoryQuery {
  sessionPath: string
  before?: number
  after?: number
  /** Reveal the exact execution of a call on the verified selected branch. */
  toolCall?: { recordId: string; callId: string }
  kind?: TrajectoryKind
  status?: TrajectoryStatus
  query?: string
}
export interface TrajectoryPage {
  items: TrajectoryRecord[]
  older: number | null
  newer: number | null
  total: number
  /** Exact execution revealed by a tool-call navigation query. */
  targetId?: string
}
export type TrajectoryDocumentKind = 'context' | 'payload' | 'options' | 'response' | 'output' | 'event'
export interface TrajectoryNode {
  id: string
  kind: 'object' | 'array' | 'value'
  count: number
  bytes: number
  preview: string
}
export interface TrajectoryDetail {
  record: TrajectoryRecord
  documents: Array<{ kind: TrajectoryDocumentKind; node: TrajectoryNode }>
}
export interface TrajectoryNodeRequest {
  sessionPath: string
  recordId: string
  /** Root followed by direct children; the worker verifies every edge. */
  trail: string[]
  offset?: number
}
export interface TrajectoryNodePage {
  node: TrajectoryNode
  children: Array<{ key: string; node: TrajectoryNode }>
  text: string | null
  nextOffset: number | null
}
export const TRAJECTORY_PAGE_SIZE = 80
export const TRAJECTORY_CHILDREN_SIZE = 40
export const TRAJECTORY_TEXT_SIZE = 16_384
export const TRAJECTORY_PREVIEW_SIZE = 512
