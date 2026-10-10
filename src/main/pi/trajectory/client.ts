import { Worker } from 'node:worker_threads'
import type { TrajectoryDetail, TrajectoryNodePage, TrajectoryNodeRequest, TrajectoryPage, TrajectoryQuery } from '../../../shared/trajectory'
import type { TraceAccess, TraceCommand, TraceWrite } from './protocol'
import type { ContextRequestDTO } from '../../../shared/types'

/** The global worker is lazy. At most eight jobs are posted at a time; capture
 * callers await completion and never queue streamed deltas or body copies. */
export class TrajectoryClient {
  private worker: Worker | null = null
  private nextId = 0
  private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()
  private closing = false
  private unavailableUntil = 0
  private admission = Promise.resolve()
  constructor(private databasePath: string, private changed: (sessionId: string) => void = () => {}) {}

  private async send<T>(command: TraceCommand): Promise<T> {
    // FIFO admission preserves start/finish ordering even under backpressure.
    const previous = this.admission
    let release!: () => void
    this.admission = new Promise<void>(resolve => { release = resolve })
    await previous
    try {
      while (this.pending.size >= 8) await new Promise<void>(resolve => setTimeout(resolve, 5))
      if (this.closing && command.type !== 'close') throw new Error('trajectory-closed')
      if (Date.now() < this.unavailableUntil) throw new Error('trajectory-unavailable')
      if (!this.worker) {
        const worker = new Worker(new URL('./trajectory-worker.mjs', import.meta.url), { workerData: { databasePath: this.databasePath }, resourceLimits: { maxOldGenerationSizeMb: 96, maxYoungGenerationSizeMb: 16 } })
        this.worker = worker
        worker.on('message', ({ id, result, error }) => {
          const pending = this.pending.get(id)
          this.pending.delete(id)
          if (error) pending?.reject(new Error(error))
          else pending?.resolve(result)
        })
        const fail = () => {
          if (this.worker !== worker) return
          this.worker = null
          this.unavailableUntil = Date.now() + 30_000
          for (const job of this.pending.values()) job.reject(new Error('trajectory-unavailable'))
          this.pending.clear()
        }
        worker.on('error', fail)
        worker.on('exit', fail)
      }
      const id = ++this.nextId
      const result = new Promise<T>((resolve, reject) => {
        this.pending.set(id, { resolve: value => resolve(value as T), reject })
        try { this.worker!.postMessage({ id, command }) }
        catch (error) { this.pending.delete(id); reject(error) }
      })
      return result
    } finally { release() }
  }
  async write(value: TraceWrite): Promise<void> { await this.send({ type: 'write', value }); this.changed(value.sessionId) }
  page(access: TraceAccess, query: TrajectoryQuery): Promise<TrajectoryPage> { return this.send({ type: 'page', access, query }) }
  detail(access: TraceAccess, recordId: string): Promise<TrajectoryDetail> { return this.send({ type: 'detail', access, recordId }) }
  context(access: TraceAccess): Promise<ContextRequestDTO | null> { return this.send({ type: 'context', access }) }
  node(access: TraceAccess, request: TrajectoryNodeRequest): Promise<TrajectoryNodePage> { return this.send({ type: 'node', access, request }) }
  export(access: TraceAccess, recordId: string, path: string): Promise<void> { return this.send({ type: 'export', access, recordId, path }) }
  settle(sessionId: string): Promise<void> { return this.send({ type: 'settle', sessionId }) }
  async dispose(): Promise<void> {
    if (this.closing) return
    this.closing = true
    if (!this.worker) return
    try { await this.send({ type: 'close' }) }
    finally { const worker = this.worker; this.worker = null; await worker?.terminate() }
  }
}
