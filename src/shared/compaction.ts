/** Transient pending action, separate from the SDK's queued user messages. */
export interface CompactionQueueStateDTO {
  queued: boolean
  /** Independent metadata revision; survives managed-session rebuilds. */
  revision: number
}

/** No transcript sequence or persisted conversation entry. */
export interface CompactionQueueUpdateEvent {
  type: 'compaction_queue_update'
  sessionId: string
  sessionPath: string
  compactionQueue: CompactionQueueStateDTO
}

export type CompactionReason = 'manual' | 'threshold' | 'overflow'
export type CompactionStatus = 'running' | 'success' | 'error' | 'cancelled'

/** Bounded request statistics; excludes prompts, generated text and credentials. */
export interface CompactionRequestDTO {
  id: string
  startedAt: number
  endedAt?: number
  status: CompactionStatus
  provider?: string
  model?: string
  inputTokens?: number
  outputTokens?: number
  cost?: number
}

export interface CompactionProcessDTO {
  id: string
  reason: CompactionReason
  status: CompactionStatus
  phase: 'preparing' | 'summarizing' | 'applying'
  startedAt: number
  endedAt?: number
  range?: {
    summarizedMessages: number
    keptMessages: number
    previousSummary: boolean
    splitTurn: boolean
  }
  tokensBefore?: number
  /** Estimated remaining context, not the summarization request's billed input. */
  tokensAfter?: number
  requests: CompactionRequestDTO[]
  requestCount: number
  usage?: { inputTokens: number; outputTokens: number; cost: number }
  extensionGenerated?: boolean
  retry?: { attempt: number; maxAttempts: number; delayMs: number }
  /** Bounded provider/SDK failure detail; renderer owns the surrounding prose. */
  errorMessage?: string
}

/** Live metadata owns its revision independently of the transcript sequence. */
export interface CompactionProcessStateDTO {
  revision: number
  process: CompactionProcessDTO | null
}

export interface CompactionProcessUpdateEvent {
  type: 'compaction_process_update'
  sessionId: string
  sessionPath: string
  compactionProcess: CompactionProcessStateDTO
}
