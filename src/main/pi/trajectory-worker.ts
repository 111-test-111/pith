import { parentPort, workerData } from 'node:worker_threads'
import { TrajectoryStorage } from './trajectory/storage'
import type { TraceCommand } from './trajectory/protocol'

const storage = await TrajectoryStorage.open(workerData.databasePath)
type Job = { id: number; command: TraceCommand }
const queue: Job[] = []
let draining = false

// Long history scans/export yield at bounded chunks. Immutable body nodes let
// capture writes proceed without changing the export snapshot or taking a
// second SQLite connection/worker. The client bounds the posted queue.
const yieldWrites = async (): Promise<void> => {
  for (let index = 0; index < queue.length;) {
    if (queue[index].command.type !== 'write') { index++; continue }
    await execute(queue.splice(index, 1)[0])
  }
}
async function execute({ id, command }: Job): Promise<void> {
  try {
    let result: unknown = null
    switch (command.type) {
      case 'write': storage.write(command.value); break
      case 'page': await storage.history(command.access, yieldWrites); result = storage.page(command.access, command.query); break
      case 'detail': await storage.history(command.access, yieldWrites); result = storage.detail(command.access, command.recordId); break
      case 'context': await storage.history(command.access, yieldWrites); result = storage.context(command.access); break
      case 'node': await storage.history(command.access, yieldWrites); result = storage.readNode(command.access, command.request); break
      case 'export': await storage.history(command.access, yieldWrites); await storage.export(command.access, command.recordId, command.path, yieldWrites); break
      case 'settle': storage.settle(command.sessionId); break
      case 'close': storage.close(); break
    }
    parentPort!.postMessage({ id, result })
  } catch { parentPort!.postMessage({ id, error: 'trajectory-unavailable' }) }
}
parentPort!.on('message', (job: Job) => {
  queue.push(job)
  if (draining) return
  draining = true
  void (async () => {
    try { while (queue.length) await execute(queue.shift()!) }
    finally { draining = false }
  })()
})
