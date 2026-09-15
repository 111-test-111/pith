import { parentPort, workerData as _workerData } from 'node:worker_threads'
import { readFile } from 'node:fs/promises'
import {
  accumulateSessionFile,
  createUsageAccumulator,
  finalizeUsage
} from './usage-stats'
import type { UsageStatsDTO } from '../../shared/types'

/**
 * Usage aggregation worker — reading and JSON-parsing every session .jsonl
 * never runs on the renderer or the Electron main thread that hosts the agent
 * (same policy as the session-search worker). The PiManager-side owner passes
 * the file list it already stat-walked for the cache fingerprint, so the
 * worker never re-lists the sessions tree.
 */
void _workerData

const READ_CONCURRENCY = 8
const MAX_USAGE_RECORDS = 1000

parentPort?.on('message', ({ id, files }: { id: number; files: string[] }) => {
  void (async () => {
    const acc = createUsageAccumulator()
    for (let i = 0; i < files.length; i += READ_CONCURRENCY) {
      const batch = files.slice(i, i + READ_CONCURRENCY)
      const texts = await Promise.all(batch.map((path) => readFile(path, 'utf8').catch(() => null)))
      for (const text of texts) {
        if (text !== null) accumulateSessionFile(acc, text)
      }
    }
    const result: UsageStatsDTO = finalizeUsage(acc, MAX_USAGE_RECORDS)
    parentPort?.postMessage({ id, result })
  })().catch(() => {
    parentPort?.postMessage({ id, error: 'usage_aggregation_failed' })
  })
})
