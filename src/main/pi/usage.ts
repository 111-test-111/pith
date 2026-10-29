import { Worker } from 'node:worker_threads'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { getAgentDir } from '@earendil-works/pi-coding-agent'
import type { UsageStatsDTO } from '../../shared/types'

/**
 * Cross-session usage aggregation owner: a light stat-walk of the shared
 * sessions tree produces a fingerprint (file count + newest mtime); an
 * unchanged fingerprint inside the TTL returns the cached stats, and any
 * recompute is delegated to the usage worker thread so neither the renderer
 * nor the agent-hosting main thread ever parses session files. Ported from
 * pi-web's /api/usage route, with the scan moved off-thread for pi-app.
 */
export class UsageAggregator {
  private worker: Worker | null = null
  private nextId = 0
  private pending = new Map<number, { resolve: (value: UsageStatsDTO) => void; reject: (error: Error) => void }>()
  private cache: { fingerprint: string; ts: number; data: UsageStatsDTO } | null = null
  private inflight: Promise<UsageStatsDTO> | null = null

  private static readonly TTL_MS = 60_000

  async stats(): Promise<UsageStatsDTO> {
    const files = await this.walkSessionFiles()
    let newest = 0
    for (const file of files) if (file.mtimeMs > newest) newest = file.mtimeMs
    const fingerprint = `${files.length}|${newest}`
    const cached = this.cache
    if (
      cached &&
      cached.fingerprint === fingerprint &&
      Date.now() - cached.ts < UsageAggregator.TTL_MS
    ) {
      return cached.data
    }
    // A concurrent caller shares the one recompute; a failing recompute must
    // not poison the cache for a later retry.
    this.inflight ??= this.compute(files.map((file) => file.path))
      .then((data) => {
        this.cache = { fingerprint, ts: Date.now(), data }
        return data
      })
      .finally(() => { this.inflight = null })
    return this.inflight
  }

  /** All .jsonl files under ~/.pi/agent/sessions, with mtimes for the fingerprint. */
  private async walkSessionFiles(): Promise<Array<{ path: string; mtimeMs: number }>> {
    const sessionsDir = join(getAgentDir(), 'sessions')
    let directories
    try {
      directories = await readdir(sessionsDir, { withFileTypes: true })
    } catch (error: any) {
      if (error.code !== 'ENOENT') throw error
      return []
    }
    const paths: string[] = []
    for (const dir of directories) {
      if (!dir.isDirectory() && !dir.isSymbolicLink()) continue
      const folder = join(sessionsDir, dir.name)
      try {
        for (const name of await readdir(folder)) if (name.endsWith('.jsonl')) paths.push(join(folder, name))
      } catch {
        // A folder that cannot be read now may be readable next poll.
      }
    }
    const files: Array<{ path: string; mtimeMs: number }> = []
    for (let i = 0; i < paths.length; i += 32) {
      const batch = await Promise.all(paths.slice(i, i + 32).map(async (path) => {
        try { return { path, mtimeMs: (await stat(path)).mtimeMs } } catch { return null }
      }))
      for (const file of batch) if (file) files.push(file)
    }
    return files
  }

  private compute(files: string[]): Promise<UsageStatsDTO> {
    if (!this.worker) {
      const worker = new Worker(new URL('./usage-worker.mjs', import.meta.url))
      this.worker = worker
      worker.on('message', ({ id, result, error }: { id: number; result?: UsageStatsDTO; error?: string }) => {
        const pending = this.pending.get(id)
        this.pending.delete(id)
        if (error) pending?.reject(new Error(error))
        else if (result) pending?.resolve(result)
      })
      worker.on('error', () => this.fail(worker))
      worker.on('exit', () => this.fail(worker))
    }
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.worker!.postMessage({ id, files })
    })
  }

  private fail(worker: Worker): void {
    if (this.worker !== worker) return
    this.worker = null
    for (const pending of this.pending.values()) pending.reject(new Error('usage_failed'))
    this.pending.clear()
  }

  dispose(): void {
    if (!this.worker) return
    const worker = this.worker
    this.fail(worker)
    void worker.terminate()
  }
}
