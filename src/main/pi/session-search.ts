import { Worker } from 'node:worker_threads'
import { join } from 'node:path'
import { app } from 'electron'
import { getAgentDir } from '@earendil-works/pi-coding-agent'
import type { SessionSearchRequest, SessionSearchResultDTO } from '../../shared/types'

/** Owns the worker; parsing, indexing, disk I/O and SQLite never run on the
 * renderer or the Electron main thread that hosts the agent. */
export class SessionSearch {
  private worker: Worker | null = null
  private nextId = 0
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>()
  private warming: Promise<unknown> | null = null

  warm(): void {
    this.warming ??= this.send().catch(() => {}).finally(() => { this.warming = null })
  }

  search(request: SessionSearchRequest): Promise<SessionSearchResultDTO> {
    return this.send(request)
  }

  private send(request?: SessionSearchRequest): Promise<any> {
    if (!this.worker) {
      const worker = new Worker(new URL('./session-search-worker.mjs', import.meta.url), {
        workerData: {
          sessionsDir: join(getAgentDir(), 'sessions'),
          databasePath: join(app.getPath('userData'), 'session-search.sqlite')
        }
      })
      this.worker = worker
      worker.on('message', ({ id, result, error }) => {
        const pending = this.pending.get(id)
        this.pending.delete(id)
        if (error) pending?.reject(new Error(error))
        else pending?.resolve(result)
      })
      worker.on('error', () => this.fail(worker))
      worker.on('exit', () => this.fail(worker))
    }
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.worker!.postMessage({ id, request })
    })
  }

  private fail(worker: Worker): void {
    if (this.worker !== worker) return
    this.worker = null
    for (const pending of this.pending.values()) pending.reject(new Error('search_failed'))
    this.pending.clear()
  }

  dispose(): void {
    if (!this.worker) return
    const worker = this.worker
    this.fail(worker)
    void worker.terminate()
  }
}
