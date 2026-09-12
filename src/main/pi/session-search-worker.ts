import { parentPort, workerData } from 'node:worker_threads'
import { SessionSearchIndex } from './session-search-index'
import type { SessionSearchRequest } from '../../shared/types'

const index = await SessionSearchIndex.open(workerData.sessionsDir, workerData.databasePath)
type Job = { id: number; request?: SessionSearchRequest }
const pending: Job[] = []
let running = false

async function drain(): Promise<void> {
  running = true
  while (pending.length) {
    try {
      await index.sync()
      // Requests arriving during a cold build share that scan. Rapid typing
      // must not queue a fresh filesystem traversal for every old query.
      for (const { id, request } of pending.splice(0)) {
        try { parentPort!.postMessage({ id, result: request ? index.search(request) : null }) }
        catch { parentPort!.postMessage({ id, error: 'search_failed' }) }
      }
    } catch {
      for (const { id } of pending.splice(0)) parentPort!.postMessage({ id, error: 'search_failed' })
    }
  }
  running = false
}

parentPort!.on('message', (job: Job) => {
  pending.push(job)
  if (!running) void drain()
})
