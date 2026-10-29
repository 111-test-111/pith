import { parentPort, workerData } from 'node:worker_threads'
import { RewindEngine } from './engine'
import { failure } from './types'

const engine = new RewindEngine(workerData.dataDir, undefined, workerData.owner)
const methods = new Set(['list', 'checkpoint', 'preview', 'previewFile', 'stats', 'statsBatch', 'patch', 'prepare', 'finish', 'navigation', 'bindMessage'])
let pending = Promise.resolve()
let lastMaintenance = 0
parentPort!.on('message', ({ id, method, args }: { id: number; method: string; args: unknown[] }) => {
  // A single worker serializes record updates and bounds hashing/diff memory.
  // The main coordinator separately owns actual sessions and process leases.
  pending = pending.then(async () => {
    try {
      if (!methods.has(method)) throw new Error('Invalid worker method')
      const value = await (engine[method as keyof RewindEngine] as (...args: unknown[]) => Promise<unknown>).apply(engine, args)
      parentPort!.postMessage({ id, value })
      if (method === 'checkpoint' && Date.now() - lastMaintenance > 30 * 60_000) {
        lastMaintenance = Date.now()
        setImmediate(() => { pending = pending.then(() => engine.maintenance()).then(() => {}, () => {}) })
      }
    } catch (error) { parentPort!.postMessage({ id, error: failure(error) }) }
  })
})
