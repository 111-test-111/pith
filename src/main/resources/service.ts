import { app, ipcMain } from 'electron'
import { Worker } from 'node:worker_threads'
import { cpus } from 'node:os'
import { join } from 'node:path'
import { getAgentDir } from '@earendil-works/pi-coding-agent'
import { loadSettings } from '../settings'
import { collectProcessTree } from './processes'
import { RuntimeSampler } from './runtime'
import type { StorageScanOptions } from './storage'
import type { ResourceResult, ResourceRuntimeDTO, ResourceStorageDTO } from '../../shared/resources'

export function registerResourceIpc(): ResourceService {
  const resources = new ResourceService()
  ipcMain.handle('resources:runtime', () => resources.runtime())
  ipcMain.handle('resources:storage', () => resources.storage())
  return resources
}

/** One sampler/scan owner across windows. Nothing polls or writes to disk when
 * the resource panel is inactive. Disk traversal runs off the main event loop. */
export class ResourceService {
  private sampler = new RuntimeSampler()
  private runtimeJob: Promise<ResourceResult<ResourceRuntimeDTO>> | null = null
  private runtimeCache: ResourceResult<ResourceRuntimeDTO> | null = null
  private runtimeAt = 0
  private runtimeAbort = new AbortController()
  private storageJob: Promise<ResourceResult<ResourceStorageDTO>> | null = null
  private worker: Worker | null = null
  private closing = false

  runtime(): Promise<ResourceResult<ResourceRuntimeDTO>> {
    if (this.closing) return Promise.resolve({ ok: false, code: 'unavailable' })
    if (this.runtimeJob) return this.runtimeJob
    if (this.runtimeCache && performance.now() - this.runtimeAt < 1_000) return Promise.resolve(this.runtimeCache)
    if (performance.now() - this.runtimeAt > 5_000) this.sampler = new RuntimeSampler()
    this.runtimeJob = (async (): Promise<ResourceResult<ResourceRuntimeDTO>> => {
      try {
        // Cumulative counters keep our interval independent of other callers
        // of getAppMetrics (the SDK or an extension may sample it as well).
        const roots = new Set([process.pid, ...app.getAppMetrics().map(metric => metric.pid)])
        const native = await collectProcessTree(roots, this.runtimeAbort.signal).catch(() => ({ processes: [], partial: true }))
        if (this.closing) return { ok: false, code: 'unavailable' }
        const value = this.sampler.sample(app.getAppMetrics(), native.processes, native.partial, cpus().length)
        return { ok: true, value }
      } catch { return { ok: false, code: 'unavailable' } }
    })().then(result => { this.runtimeAt = performance.now(); this.runtimeCache = result; return result })
      .finally(() => { this.runtimeJob = null })
    return this.runtimeJob
  }

  storage(): Promise<ResourceResult<ResourceStorageDTO>> {
    if (this.closing) return Promise.resolve({ ok: false, code: 'unavailable' })
    if (this.storageJob) return this.storageJob
    const appData = app.getPath('userData'), agentData = getAgentDir(), sessionData = app.getPath('sessionData')
    const library = loadSettings().library.directory ?? join(appData, 'library')
    const options: StorageScanOptions = { appData, agentData, sessionData, library, roots: [
      { kind: 'app', path: appData }, { kind: 'pi', path: agentData }, { kind: 'library', path: library },
      { kind: 'browser', path: sessionData }, { kind: 'logs', path: app.getPath('logs') }, { kind: 'crashes', path: app.getPath('crashDumps') }
    ] }
    this.storageJob = new Promise<ResourceResult<ResourceStorageDTO>>(resolve => {
      const worker = new Worker(new URL('./resources-worker.mjs', import.meta.url), { workerData: options })
      this.worker = worker
      let settled = false
      const done = (result: ResourceResult<ResourceStorageDTO>) => {
        if (settled) return
        settled = true; resolve(result)
        if (this.worker === worker) this.worker = null
        void worker.terminate()
      }
      worker.once('message', done)
      worker.once('error', () => done({ ok: false, code: 'unavailable' }))
      worker.once('exit', () => done({ ok: false, code: 'unavailable' }))
    }).catch((): ResourceResult<ResourceStorageDTO> => ({ ok: false, code: 'unavailable' }))
      .finally(() => { this.storageJob = null })
    return this.storageJob
  }

  async dispose(): Promise<void> {
    this.closing = true
    this.runtimeAbort.abort()
    await this.worker?.terminate()
    this.worker = null
  }
}
