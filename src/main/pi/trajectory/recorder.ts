import { randomUUID } from 'node:crypto'
import type { AgentSession, AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import type { TrajectoryDocumentKind, TrajectoryRecord } from '../../../shared/trajectory'
import type { TraceWrite } from './protocol'
import type { TrajectoryClient } from './client'

type StreamFn = AgentSession['agent']['streamFunction']
type Stream = Awaited<ReturnType<StreamFn>>
type Reply = Awaited<ReturnType<Stream['result']>>
type PendingRecord = TraceWrite & { record: Omit<TrajectoryRecord, 'seq'> }

/** Observes the public SDK stream boundary after context transforms and the
 * provider's final onPayload callback. No stream chunks are copied or retained.
 * Authentication/ambient options never enter diagnostic storage. */
export class TrajectoryRecorder {
  private previous: StreamFn
  private wrapper: StreamFn
  private jobs = new Set<Promise<void>>()
  private tools = new Map<string, PendingRecord>()
  private replies = new Map<number, PendingRecord[]>()
  private exceptionalReply: PendingRecord[] | null = null
  private run: PendingRecord | null = null
  private maintenance: PendingRecord | null = null
  private retry: PendingRecord | null = null
  private latestRequest: string | undefined
  private disposed = false

  constructor(private session: AgentSession, private client: TrajectoryClient) {
    this.previous = session.agent.streamFunction
    this.wrapper = (model, context, options) => this.stream(model, context, options)
    session.agent.streamFunction = this.wrapper
  }

  private create(kind: TrajectoryRecord['kind'], name: string): PendingRecord {
    return { sessionId: this.session.sessionId, anchor: this.session.sessionManager.getLeafId() ?? `session:${this.session.sessionId}`,
      record: { id: randomUUID(), kind, name, status: 'running', captured: true, startedAt: Date.now(),
        ...(this.run ? { turnId: this.run.record.id } : {}) } }
  }

  private save(record: PendingRecord, documents?: Partial<Record<TrajectoryDocumentKind, unknown>>): Promise<void> {
    // Clone metadata now: a later settlement must not change an earlier queued
    // write. Bodies are posted once and never kept in recorder state.
    const job = this.client.write({ ...record, record: { ...record.record }, ...(documents ? { documents } : {}) })
      .catch(() => { record.record.captureError = true /* A disk failure cannot fail agent work. */ })
    this.jobs.add(job)
    void job.finally(() => this.jobs.delete(job))
    return job
  }

  private async stream(model: Parameters<StreamFn>[0], context: Parameters<StreamFn>[1], options: Parameters<StreamFn>[2]): Promise<Stream> {
    this.exceptionalReply = null
    let record = this.create('request', this.maintenance ? 'compaction' : model.id)
    record.record.provider = model.provider
    record.record.model = model.id
    record.record.parentId = this.maintenance?.record.id ?? this.run?.record.id
    this.latestRequest = record.record.id
    const retry = this.session.settingsManager.getProviderRetrySettings()
    const idle = this.session.settingsManager.getHttpIdleTimeoutMs()
    const requestOptions = {
      api: model.api, baseUrl: model.baseUrl, thinkingLevel: this.session.thinkingLevel,
      temperature: options?.temperature, maxTokens: options?.maxTokens, reasoning: options?.reasoning,
      cacheRetention: options?.cacheRetention, transport: options?.transport ?? this.session.settingsManager.getTransport(),
      timeoutMs: options?.timeoutMs ?? retry.timeoutMs ?? (idle === 0 ? 2147483647 : idle),
      maxRetries: options?.maxRetries ?? retry.maxRetries, maxRetryDelayMs: options?.maxRetryDelayMs ?? retry.maxRetryDelayMs,
      websocketConnectTimeoutMs: options?.websocketConnectTimeoutMs ?? this.session.settingsManager.getWebSocketConnectTimeoutMs(),
      samplingParams: options?.samplingParams
    }
    // AgentTool definitions carry execute/prepareArguments closures. Only the
    // public model-facing Tool fields belong in a cloneable request document.
    const capturedContext = { ...context, tools: context.tools?.map(tool => ({
      name: tool.name, description: tool.description, parameters: tool.parameters,
      ...(tool.constrainedSampling !== undefined ? { constrainedSampling: tool.constrainedSampling } : {})
    })) }
    await this.save(record, { context: capturedContext, options: requestOptions })
    const attempts = [record]
    let payloads = 0
    let finished = false
    const finish = async (message: Reply): Promise<void> => {
      if (finished) return
      finished = true
      record.record.finishedAt = Date.now()
      record.record.status = message.stopReason === 'aborted' ? 'cancelled' : message.stopReason === 'error' ? 'failed' : 'completed'
      record.record.stopReason = message.stopReason
      record.record.usage = { input: message.usage.input, output: message.usage.output,
        cacheRead: message.usage.cacheRead, cacheWrite: message.usage.cacheWrite, cost: message.usage.cost.total }
      if (this.run) {
        const usage = this.run.record.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }
        for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'cost'] as const) usage[key] += record.record.usage[key]
        this.run.record.usage = { ...usage }
      }
      if (!this.maintenance) {
        this.replies.set(message.timestamp, attempts)
        // Only an uncommitted response needs correlation. Compaction/failed
        // responses may never enter history, so keep this map bounded.
        while (this.replies.size > 8) this.replies.delete(this.replies.keys().next().value!)
      }
      await this.save(record, { output: message })
    }
    try {
      const stream = await this.previous(model, context, { ...options,
        onPayload: async (payload, requestModel) => {
          const replacement = await options?.onPayload?.(payload, requestModel)
          const actual = replacement === undefined ? payload : replacement
          if (payloads++) {
            record.record.finishedAt = Date.now()
            record.record.status = 'failed'
            await this.save(record)
            const next = this.create('request', model.id)
            next.record = { ...record.record, id: next.record.id, startedAt: Date.now(), status: 'running', finishedAt: undefined,
              firstTokenAt: undefined, httpStatus: undefined }
            record = next
            attempts.push(record)
            this.latestRequest = record.record.id
            await this.save(record, { context: capturedContext, options: requestOptions })
          }
          record.record.provider = requestModel.provider
          record.record.model = requestModel.id
          await this.save(record, { payload: actual })
          return replacement
        },
        onResponse: async (response, requestModel) => {
          record.record.httpStatus = response.status
          const headers = Object.fromEntries(Object.entries(response.headers).filter(([key]) => /^(date|content-type|retry-after|request-id|x-request-id|(?:x-|anthropic-)?ratelimit-[\w-]+|server-timing|openai-processing-ms)$/i.test(key)))
          await this.save(record, { response: { status: response.status, headers } })
          await options?.onResponse?.(response, requestModel)
        }
      })
      const self = this
      return new Proxy(stream, {
        get(target, property) {
          if (property === Symbol.asyncIterator) return async function* () {
            try {
              for await (const event of target) {
                if (record.record.firstTokenAt === undefined && (event.type === 'text_delta' || event.type === 'thinking_delta' || event.type === 'toolcall_delta')) record.record.firstTokenAt = Date.now()
                if (event.type === 'done') await finish(event.message)
                else if (event.type === 'error') await finish(event.error)
                yield event
              }
            } catch (error) {
              record.record.status = options?.signal?.aborted ? 'cancelled' : 'failed'
              if (!self.maintenance) self.exceptionalReply = attempts
              record.record.finishedAt = Date.now()
              await self.save(record, { event: { error: error instanceof Error ? error.message : String(error) } })
              throw error
            }
          }
          if (property === 'result') return async () => {
            const message = await target.result()
            await finish(message)
            return message
          }
          const value = Reflect.get(target, property, target)
          return typeof value === 'function' ? value.bind(target) : value
        }
      })
    } catch (error) {
      record.record.status = options?.signal?.aborted ? 'cancelled' : 'failed'
      if (!this.maintenance) this.exceptionalReply = attempts
      record.record.finishedAt = Date.now()
      await this.save(record, { event: { error: error instanceof Error ? error.message : String(error) } })
      throw error
    }
  }

  observe(event: AgentSessionEvent): void {
    if (this.disposed) return
    if (event.type === 'agent_start') {
      this.run = this.create('run', 'run')
      void this.save(this.run)
    } else if (event.type === 'agent_settled') {
      if (this.run) {
        this.run.record.finishedAt = Date.now()
        const last = this.session.messages.at(-1)
        this.run.record.status = last?.role === 'assistant' && last.stopReason === 'aborted' ? 'cancelled'
          : last?.role === 'assistant' && last.stopReason === 'error' ? 'failed' : 'completed'
        void this.save(this.run)
      }
      this.run = null
    } else if (event.type === 'tool_execution_start') {
      const record = this.create('tool', event.toolName)
      record.record.parentId = this.latestRequest
      this.tools.set(event.toolCallId, record)
      void this.save(record, { context: event.args })
    } else if (event.type === 'tool_execution_end') {
      const record = this.tools.get(event.toolCallId)
      if (record) {
        record.record.finishedAt = Date.now()
        record.record.status = event.isError ? 'failed' : 'completed'
        void this.save(record, { output: event.result })
      }
    } else if (event.type === 'message_end') {
      const leaf = this.session.sessionManager.getLeafEntry()
      if (event.message.role === 'custom' && leaf?.type === 'custom_message') {
        const record = this.create('notification', event.message.customType)
        record.entryId = record.anchor = leaf.id
        record.record.status = 'completed'
        record.record.startedAt = event.message.timestamp
        void this.save(record, { event: event.message })
        return
      }
      if (leaf?.type !== 'message' || leaf.message !== event.message) return
      if (event.message.role === 'user') {
        const record = this.create('user', 'user')
        record.entryId = record.anchor = leaf.id
        record.record.startedAt = event.message.timestamp
        record.record.finishedAt = Date.now()
        record.record.status = 'completed'
        void this.save(record, { context: event.message })
        if (this.run) { this.run.anchor = leaf.id; void this.save(this.run) }
      } else if (event.message.role === 'assistant') {
        const records = this.replies.get(event.message.timestamp) ?? this.exceptionalReply
        if (records) {
          for (const record of records) {
            record.entryId = record.anchor = leaf.id
            void this.save(record, record === records.at(-1) && this.exceptionalReply ? { output: event.message } : undefined)
          }
          this.exceptionalReply = null
          this.replies.delete(event.message.timestamp)
        }
      } else if (event.message.role === 'toolResult') {
        const record = this.tools.get(event.message.toolCallId)
        if (record) {
          record.entryId = record.anchor = leaf.id
          record.record.status = event.message.isError ? 'failed' : 'completed'
          void this.save(record, { output: event.message })
          this.tools.delete(event.message.toolCallId)
        }
      }
    } else if (event.type === 'compaction_start') {
      this.maintenance = this.create('compaction', event.reason)
      void this.save(this.maintenance, { event })
    } else if (event.type === 'compaction_end') {
      if (this.maintenance) {
        const leaf = this.session.sessionManager.getLeafEntry()
        if (leaf?.type === 'compaction') this.maintenance.entryId = this.maintenance.anchor = leaf.id
        this.maintenance.record.finishedAt = Date.now()
        this.maintenance.record.status = event.aborted ? 'cancelled' : event.errorMessage ? 'failed' : 'completed'
        void this.save(this.maintenance, { output: event })
      }
      this.maintenance = null
    } else if (event.type === 'auto_retry_start') {
      this.retry = this.create('retry', String(event.attempt))
      void this.save(this.retry, { event })
    } else if (event.type === 'auto_retry_end') {
      if (this.retry) {
        this.retry.record.finishedAt = Date.now()
        this.retry.record.status = event.success ? 'completed' : 'failed'
        void this.save(this.retry, { output: event })
      }
      this.retry = null
    }
  }

  async flush(): Promise<void> { await Promise.allSettled(this.jobs) }

  async dispose(): Promise<void> {
    this.disposed = true
    if (this.session.agent.streamFunction === this.wrapper) this.session.agent.streamFunction = this.previous
    await this.flush()
    await this.client.settle(this.session.sessionId).catch(() => {})
    this.tools.clear()
    this.replies.clear()
  }
}
