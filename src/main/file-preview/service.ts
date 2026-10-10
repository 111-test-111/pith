import { Worker } from 'node:worker_threads'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveFilePath } from '../file-path'
import { archiveFormatOf, dataFormatOf, ARCHIVE_MAX_ENTRIES, DATA_MAX_ROWS, type BinaryPreviewRequest, type BinaryPreviewWork, type PreviewResult } from '../../shared/file-preview'
import { validTextEncoding } from '../text-decoding'

interface Job {
  key: string
  owner: number
  work: BinaryPreviewWork
  worker?: Worker
  timer: ReturnType<typeof setTimeout>
  resolve(result: PreviewResult): void
}
const MAX_WORKERS = 2
const MAX_JOBS = 24
const DEADLINE_MS = 20000

/** Short-lived workers bound synchronous parsers and SQLite. Cancellation
 * terminates the owning worker, including a parser stuck inside native code. */
export class FilePreviewService {
  private jobs = new Map<string, Job>()
  private queue: Job[] = []
  private running = 0
  private closing = false
  private terminating = new Set<Promise<void>>()
  private preparing = new Set<Promise<void>>()
  private scratchRoot?: Promise<string>
  private serial = 0
  constructor(private workerUrl = new URL('./file-preview-worker.mjs', import.meta.url)) {}

  read(owner: number, request: BinaryPreviewRequest): Promise<PreviewResult> {
    if (this.closing) return Promise.resolve({ error: 'cancelled' })
    let path: string
    try {
      if (!request || typeof request.id !== 'string' || !/^[\w-]{1,96}$/.test(request.id)) throw new Error()
      path = resolveFilePath(request)
      const query = request.query
      if (!query || typeof query !== 'object') throw new Error()
      if (query.type === 'archive-index' || query.type === 'archive-entry') {
        if (!archiveFormatOf(path)) return Promise.resolve({ error: 'unsupported' })
        if (query.type === 'archive-entry' && (typeof query.entry !== 'string' || !/^\d{1,6}$/.test(query.entry) || Number(query.entry) >= ARCHIVE_MAX_ENTRIES || !this.validRevision(query.revision) || (query.encoding !== undefined && !validTextEncoding(query.encoding)))) throw new Error()
      } else if (query.type === 'data-index' || query.type === 'data-rows') {
        if (!dataFormatOf(path)) return Promise.resolve({ error: 'unsupported' })
        if (query.type === 'data-rows' && (typeof query.table !== 'string' || query.table.length > 512 || !this.validRevision(query.revision) || !Number.isSafeInteger(query.offset) || query.offset < 0 || query.offset >= DATA_MAX_ROWS)) throw new Error()
      } else throw new Error()
    } catch { return Promise.resolve({ error: 'invalid' }) }
    const key = `${owner}:${request.id}`
    if (this.jobs.has(key) || this.jobs.size >= MAX_JOBS) return Promise.resolve({ error: 'busy' })
    return new Promise(resolve => {
      const job: Job = { key, owner, work: { path, query: request.query }, resolve,
        timer: setTimeout(() => this.finish(job, { error: 'timeout' }), DEADLINE_MS) }
      this.jobs.set(key, job); this.queue.push(job); this.drain()
    })
  }
  private validRevision(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 512 }
  cancel(owner: number, id: string): void { const job = this.jobs.get(`${owner}:${id}`); if (job) this.finish(job, { error: 'cancelled' }) }
  cancelOwner(owner: number): void { for (const job of [...this.jobs.values()]) if (job.owner === owner) this.finish(job, { error: 'cancelled' }) }
  private drain(): void {
    while (!this.closing && this.running < MAX_WORKERS && this.queue.length) {
      const job = this.queue.shift()!
      if (!this.jobs.has(job.key)) continue
      const pending = this.start(job).finally(() => this.preparing.delete(pending))
      this.preparing.add(pending)
    }
  }
  private async start(job: Job): Promise<void> {
    this.running++
    try {
      if (dataFormatOf(job.work.path) === 'sqlite') {
        this.scratchRoot ??= mkdtemp(join(tmpdir(), 'pith-file-preview-'))
        job.work.scratch = join(await this.scratchRoot, String(++this.serial))
      }
      if (this.jobs.get(job.key) !== job || this.closing) return
      const worker = new Worker(this.workerUrl, { workerData: job.work, resourceLimits: { maxOldGenerationSizeMb: 192 } })
      job.worker = worker
      worker.once('message', (result: PreviewResult) => this.finish(job, result))
      worker.once('error', () => this.finish(job, { error: 'unreadable' }))
      worker.once('exit', () => this.finish(job, { error: 'unreadable' }))
    } catch { this.finish(job, { error: 'unreadable' }) }
    finally {
      if (!job.worker) { this.running--; this.drain() }
    }
  }
  private finish(job: Job, result: PreviewResult): void {
    if (this.jobs.get(job.key) !== job) return
    this.jobs.delete(job.key)
    clearTimeout(job.timer)
    this.queue = this.queue.filter(candidate => candidate !== job)
    job.resolve(result)
    if (job.worker) {
      // Release the slot only after termination, so cancellation cannot start
      // a burst of workers while old native jobs are still unwinding.
      const pending = job.worker.terminate().then(() => {}, () => {}).then(async () => {
        if (job.work.scratch) await rm(job.work.scratch, { recursive: true, force: true }).catch(() => {})
      }).finally(() => {
        this.terminating.delete(pending); this.running--; this.drain()
      })
      this.terminating.add(pending)
    } else this.drain()
  }
  async dispose(): Promise<void> {
    this.closing = true
    for (const job of [...this.jobs.values()]) this.finish(job, { error: 'cancelled' })
    await Promise.allSettled(this.preparing)
    await Promise.allSettled(this.terminating)
    if (this.scratchRoot) await this.scratchRoot.then(path => rm(path, { recursive: true, force: true }), () => {}).catch(() => {})
  }
}
export const filePreviews = new FilePreviewService()
