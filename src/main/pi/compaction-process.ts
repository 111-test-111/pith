import { randomUUID } from 'node:crypto'
import type { AgentSession, AgentSessionEvent, InlineExtension, SessionBeforeCompactEvent, SessionCompactEvent, SessionManager } from '@earendil-works/pi-coding-agent'
import type { CompactionProcessDTO, CompactionProcessStateDTO, CompactionRequestDTO } from '../../shared/compaction'

const ENTRY_TYPE = 'pi-app:compaction-process'
const REQUEST_LIMIT = 64

const finiteCount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0
const optionalCount = (value: unknown): boolean => value === undefined || finiteCount(value)
const shortText = (value: unknown, limit = 256): value is string => typeof value === 'string' && value.length <= limit

function validProcess(process: CompactionProcessDTO): boolean {
  return shortText(process.id, 128) && process.status === 'success' && finiteCount(process.startedAt) &&
    finiteCount(process.endedAt) && process.endedAt >= process.startedAt &&
    ['manual', 'threshold', 'overflow'].includes(process.reason) && ['preparing', 'summarizing', 'applying'].includes(process.phase) &&
    optionalCount(process.tokensBefore) && optionalCount(process.tokensAfter) &&
    Number.isSafeInteger(process.requestCount) && Array.isArray(process.requests) && process.requests.length <= REQUEST_LIMIT &&
    process.requestCount >= process.requests.length &&
    (process.extensionGenerated === undefined || typeof process.extensionGenerated === 'boolean') &&
    (!process.range || (Number.isSafeInteger(process.range.summarizedMessages) && process.range.summarizedMessages >= 0 &&
      Number.isSafeInteger(process.range.keptMessages) && process.range.keptMessages >= 0 &&
      typeof process.range.previousSummary === 'boolean' && typeof process.range.splitTurn === 'boolean')) &&
    (!process.usage || [process.usage.inputTokens, process.usage.outputTokens, process.usage.cost].every(finiteCount)) &&
    process.requests.every(request => request && shortText(request.id, 128) && finiteCount(request.startedAt) &&
      optionalCount(request.endedAt) && ['running', 'success', 'error', 'cancelled'].includes(request.status) &&
      (request.provider === undefined || shortText(request.provider)) && (request.model === undefined || shortText(request.model)) &&
      [request.inputTokens, request.outputTokens, request.cost].every(optionalCount))
}

/** Use the SDK's actual preparation, rather than reimplementing its cut-point
 * algorithm. This observer never returns a replacement or cancellation. */
export function createCompactionProcessExtension(observer: {
  prepared(event: SessionBeforeCompactEvent): void
  applied(event: SessionCompactEvent): void
}): InlineExtension {
  return { name: 'pi-app-compaction-process', hidden: true, factory: pi => {
    pi.on('session_before_compact', event => { observer.prepared(event) })
    pi.on('session_compact', event => { observer.applied(event) })
  } }
}

/** Private branch entries never become model messages. Bind each record to its
 * actual compaction entry so reopen, fork and branch selection retain identity. */
export function compactionProcesses(manager: SessionManager): Map<string, CompactionProcessDTO> {
  const branch = manager.getBranch()
  const compactions = new Set(branch.filter(entry => entry.type === 'compaction').map(entry => entry.id))
  const result = new Map<string, CompactionProcessDTO>()
  for (const entry of branch) {
    if (entry.type !== 'custom' || entry.customType !== ENTRY_TYPE) continue
    const data = entry.data as { version?: unknown; entryId?: unknown; process?: CompactionProcessDTO } | undefined
    const process = data?.process
    if (data?.version !== 1 || typeof data.entryId !== 'string' || !compactions.has(data.entryId) || !process) continue
    if (!validProcess(process)) continue
    // Whitelist fields so foreign/private entry data cannot ride transcript IPC.
    result.set(data.entryId, {
      id: process.id, reason: process.reason, status: process.status, phase: process.phase,
      startedAt: process.startedAt, endedAt: process.endedAt, tokensBefore: process.tokensBefore, tokensAfter: process.tokensAfter,
      requestCount: process.requestCount, extensionGenerated: process.extensionGenerated,
      ...(process.range ? { range: { summarizedMessages: process.range.summarizedMessages, keptMessages: process.range.keptMessages,
        previousSummary: process.range.previousSummary, splitTurn: process.range.splitTurn } } : {}),
      ...(process.usage ? { usage: { inputTokens: process.usage.inputTokens, outputTokens: process.usage.outputTokens, cost: process.usage.cost } } : {}),
      requests: process.requests.map(request => ({ id: request.id, startedAt: request.startedAt, endedAt: request.endedAt,
        status: request.status, provider: request.provider, model: request.model,
        inputTokens: request.inputTokens, outputTokens: request.outputTokens, cost: request.cost }))
    })
  }
  return result
}

/** Observes SDK boundaries and the existing trajectory request recorder. It
 * neither consumes streams nor changes compaction admission or model context. */
export class CompactionProcess {
  private state: CompactionProcessStateDTO

  constructor(private session: AgentSession, private options: {
    nextRevision(): number
    changed(state: CompactionProcessStateDTO): void
  }) {
    this.state = { revision: options.nextRevision(), process: null }
  }

  get snapshot(): CompactionProcessStateDTO { return this.state }

  private publish(process: CompactionProcessDTO | null): void {
    this.state = { revision: this.options.nextRevision(), process }
    this.options.changed(this.state)
  }

  prepared(event: SessionBeforeCompactEvent): void {
    const process = this.state.process
    if (!process || process.status !== 'running') return
    const preparation = event.preparation
    const projection = this.session.sessionManager.buildSessionProjection()
    const kept = projection.entries.findIndex(entry => entry.sourceEntry.id === preparation.firstKeptEntryId)
    this.publish({ ...process, phase: 'summarizing', tokensBefore: preparation.tokensBefore,
      range: {
        summarizedMessages: preparation.messagesToSummarize.length + preparation.turnPrefixMessages.length,
        keptMessages: projection.entries.slice(kept < 0 ? projection.entries.length : kept)
          .flatMap(entry => entry.messages).filter(message => message.role !== 'system' && message.role !== 'compactionSummary').length,
        previousSummary: preparation.previousSummary !== undefined,
        splitTurn: preparation.isSplitTurn
      } })
  }

  applied(event: SessionCompactEvent): void {
    const process = this.state.process
    if (process?.status === 'running') this.publish({ ...process, phase: 'applying',
      ...(event.fromExtension ? { extensionGenerated: true, range: undefined } : {}) })
  }

  observe(event: AgentSessionEvent): void {
    if (event.type === 'agent_start') {
      if (this.state.process && this.state.process.status !== 'running') this.publish(null)
    } else if (event.type === 'compaction_start') {
      const process: CompactionProcessDTO = { id: randomUUID(), reason: event.reason, status: 'running',
        phase: 'preparing', startedAt: Date.now(), requests: [], requestCount: 0 }
      this.publish(process)
    } else if (event.type === 'summarization_retry_scheduled') {
      const process = this.state.process
      if (process?.status === 'running') this.publish({ ...process, phase: 'summarizing',
        retry: { attempt: event.attempt, maxAttempts: event.maxAttempts, delayMs: event.delayMs } })
    } else if (event.type === 'summarization_retry_attempt_start' && event.source === 'compaction') {
      const process = this.state.process
      if (process?.status === 'running') this.publish({ ...process, retry: undefined })
    } else if (event.type === 'compaction_end') {
      const previous = this.state.process
      if (!previous || previous.status !== 'running') return
      const process: CompactionProcessDTO = { ...previous, endedAt: Date.now(), retry: undefined,
        errorMessage: event.errorMessage?.slice(0, 2048),
        status: event.aborted ? 'cancelled' : event.errorMessage || !event.result ? 'error' : 'success',
        ...(!event.aborted && !event.errorMessage && event.result ? { phase: 'applying', tokensBefore: event.result.tokensBefore, tokensAfter: event.result.estimatedTokensAfter } : {}) }
      // The trajectory recorder observes the original compaction leaf first.
      // This bounded private receipt adds no user row, checkpoint or context.
      if (process.status === 'success' && event.result) {
        const entry = this.session.sessionManager.getBranch().findLast(entry => entry.type === 'compaction' &&
          entry.summary === event.result!.summary && entry.firstKeptEntryId === event.result!.firstKeptEntryId)
        if (entry) {
          if (entry.type === 'compaction' && entry.fromHook) { process.extensionGenerated = true; process.range = undefined }
          try { this.session.sessionManager.appendCustomEntry(ENTRY_TYPE, { version: 1, entryId: entry.id, process }) }
          catch { /* Diagnostic persistence cannot fail an already-applied summary. */ }
        }
      }
      this.publish(process)
    }
  }

  request(request: CompactionRequestDTO): void {
    const process = this.state.process
    if (!process || process.status !== 'running') return
    const previous = process.requests.find(item => item.id === request.id)
    if (previous && JSON.stringify(previous) === JSON.stringify(request)) return
    const requests = previous ? process.requests.map(item => item.id === request.id ? request : item)
      : [...process.requests, request].slice(-REQUEST_LIMIT)
    const usage = request.inputTokens !== undefined || request.outputTokens !== undefined || request.cost !== undefined ? {
      inputTokens: (process.usage?.inputTokens ?? 0) + (request.inputTokens ?? 0) - (previous?.inputTokens ?? 0),
      outputTokens: (process.usage?.outputTokens ?? 0) + (request.outputTokens ?? 0) - (previous?.outputTokens ?? 0),
      cost: (process.usage?.cost ?? 0) + (request.cost ?? 0) - (previous?.cost ?? 0)
    } : process.usage
    this.publish({ ...process, requests, requestCount: process.requestCount + Number(!previous),
      usage, phase: 'summarizing' })
  }
}
