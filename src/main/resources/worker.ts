import { parentPort, workerData } from 'node:worker_threads'
import { scanStorage } from './storage'
import type { StorageScanOptions } from './storage'

try { parentPort!.postMessage({ ok: true, value: await scanStorage(workerData as StorageScanOptions) }) }
catch { parentPort!.postMessage({ ok: false, code: 'unavailable' }) }
