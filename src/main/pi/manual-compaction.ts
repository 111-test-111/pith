import type { AgentSession } from '@earendil-works/pi-coding-agent'
import type { CompactionQueueStateDTO } from '../../shared/compaction'

interface CompactionRequest {
  promise: Promise<void>
  resolve: () => void
  reject: (error: unknown) => void
  release: () => void
  armed: boolean
  running: boolean
  cancelled: boolean
}

/** One transient manual request per session. The awaited core listener runs
 * after SDK persistence and the complete tool batch, without adding a user
 * message or waking the agent. Failed responses retain SDK recovery priority. */
export class ManualCompaction {
  private pending: CompactionRequest | null = null
  private unsubscribe: () => void
  private queue: CompactionQueueStateDTO

  constructor(private session: AgentSession, private options: {
    reserve: () => () => void
    prepare: () => Promise<void> | null
    validate: () => void
    nextRevision: () => number
    queueChanged: (state: CompactionQueueStateDTO) => void
  }) {
    this.queue = { queued: false, revision: options.nextRevision() }
    this.unsubscribe = session.agent.subscribe(async (event, signal) => {
      if (event.type !== 'turn_end' || event.message.role !== 'assistant') return
      if (signal.aborted || event.message.stopReason === 'aborted') { this.cancel(); return }
      // Let overflow/length recovery repair the failed attempt first. If the
      // run has no successful boundary, the idle waiter handles the request.
      if (event.message.stopReason === 'error' || event.message.stopReason === 'length') return
      const request = this.pending
      if (request?.armed) await this.run(request)
    })
  }

  get queueState(): CompactionQueueStateDTO { return this.queue }

  private setQueued(queued: boolean): void {
    if (this.queue.queued === queued) return
    this.queue = { queued, revision: this.options.nextRevision() }
    this.options.queueChanged(this.queue)
  }

  request(): Promise<void> {
    if (this.pending) return this.pending.promise
    const release = this.options.reserve()
    try { this.options.validate() }
    catch (error) { release(); throw error }
    let resolve!: () => void
    let reject!: (error: unknown) => void
    const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail })
    const request: CompactionRequest = { promise, resolve, reject, release, armed: false, running: false, cancelled: false }
    this.pending = request
    if (!this.session.isIdle) this.setQueued(true)
    void this.arm(request).catch(error => this.finish(request, error))
    return promise
  }

  private async arm(request: CompactionRequest): Promise<void> {
    await this.options.prepare()
    if (this.pending !== request) return
    request.armed = true
    // A request made during auto-compaction/retry may miss turn_end. Waiting
    // for idle provides a fallback without treating agent_end as completion.
    if (!this.session.isIdle) await this.session.waitForIdle()
    await this.run(request)
  }

  private async run(request: CompactionRequest): Promise<void> {
    if (this.pending !== request || request.running || this.session.isCompacting) return
    request.running = true
    this.setQueued(false)
    try {
      // Automatic compaction or a context edit may have shortened the context
      // since admission; never start a useless summary at the boundary.
      this.options.validate()
      await this.session.compactAtBoundary()
      this.finish(request, request.cancelled ? new Error('Manual compaction cancelled') : undefined)
    } catch (error) {
      // The SDK emitted the compaction outcome. Reject the caller without
      // throwing through the agent listener and interrupting normal work.
      this.finish(request, error)
    }
  }

  private finish(request: CompactionRequest, error?: unknown): void {
    if (this.pending !== request) return
    this.pending = null
    this.setQueued(false)
    request.release()
    if (error !== undefined) request.reject(error)
    else request.resolve()
  }

  cancel(): void {
    const request = this.pending
    if (!request) return
    request.cancelled = true
    if (request.running) this.session.abortCompaction()
    else this.finish(request, new Error('Manual compaction cancelled'))
  }

  dispose(): void {
    const request = this.pending
    this.cancel()
    // Teardown already closes admission. Settle the IPC even if an extension
    // ignores the SDK's cancellation signal during its summary hook.
    if (request) this.finish(request, new Error('Manual compaction cancelled'))
    this.unsubscribe()
  }
}
