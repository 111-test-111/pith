import { randomUUID } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import { join } from 'node:path'
import { app } from 'electron'
import type { RewindEngine } from './engine'
import { RewindFailure } from './types'
import { names, readJson } from './storage'
import type { RewindErrorDTO } from '../../shared/types'

type Method = 'list' | 'checkpoint' | 'preview' | 'previewFile' | 'stats' | 'statsBatch' | 'patch' | 'prepare' | 'finish' | 'navigation' | 'bindMessage'
/** Heavy filesystem and Git work never blocks the Electron event loop. The
 * owner survives worker restarts, so only this application can recover locks
 * left by its failed worker while the main process is still alive. */
export class RewindClient {
  private worker: Worker | null = null
  private sequence = 0
  private owner = randomUUID()
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; mutation: boolean }>()
  private closing = false
  constructor(private dataDir = join(app.getPath('userData'), 'rewind')) {}
  /** Tiny admission markers are read before any extension code runs. Full
   * manifests and file contents remain worker-owned. */
  async recoveryMarkers(): Promise<{ root: string; operationId: string }[]> {
    const result: { root: string; operationId: string }[] = []
    const base = join(this.dataDir, 'checkouts')
    for (const name of await names(base)) {
      if (!/^[a-f0-9]{64}$/.test(name)) continue
      const marker = await readJson<{ root: string; operationId: string }>(join(base, name, 'recovery.json')).catch(error => {
        if (error instanceof RewindFailure && error.code === 'missing') return null
        throw error
      })
      if (marker) {
        if (typeof marker.root !== 'string' || typeof marker.operationId !== 'string') throw new RewindFailure('corrupt')
        result.push(marker)
      }
    }
    return result
  }
  call<K extends Method>(method: K, ...args: Parameters<RewindEngine[K]>): ReturnType<RewindEngine[K]> {
    if (this.closing) return Promise.reject(new RewindFailure('cancelled')) as ReturnType<RewindEngine[K]>
    if (!this.worker) {
      const worker = new Worker(new URL('./rewind-worker.mjs', import.meta.url), { workerData: { dataDir: this.dataDir, owner: this.owner } })
      this.worker = worker
      worker.on('message', ({ id, value, error }: { id: number; value: unknown; error?: RewindErrorDTO }) => {
        const pending = this.pending.get(id); this.pending.delete(id)
        if (error) pending?.reject(new RewindFailure(error.code, error.paths, error.operationId))
        else pending?.resolve(value)
      })
      worker.on('error', () => this.fail(worker)); worker.on('exit', () => this.fail(worker))
    }
    const id = ++this.sequence
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject, mutation: method === 'prepare' || method === 'finish' }); this.worker!.postMessage({ id, method, args }) }) as ReturnType<RewindEngine[K]>
  }
  private fail(worker: Worker): void {
    if (this.worker !== worker) return
    this.worker = null
    for (const pending of this.pending.values()) pending.reject(new RewindFailure(pending.mutation ? 'recovery' : 'storage'))
    this.pending.clear()
  }
  async dispose(): Promise<void> {
    this.closing = true
    if (this.worker) { const worker = this.worker; this.fail(worker); await worker.terminate() }
  }
}
