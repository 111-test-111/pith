import { parentPort, workerData } from 'node:worker_threads'
import { collectMessage, collectTool } from './extract'
import { LibraryStore } from './store'
import type { LibraryCommand, LibraryWorkerOptions } from './protocol'

const store = await LibraryStore.open(workerData as LibraryWorkerOptions)
let chain = Promise.resolve()
let closing = false
let scan: Promise<void> | null = null
let rescanPending = false
type CaptureCommand = Extract<LibraryCommand, { type: 'message' | 'nested' | 'collect' }>
const captures: { id: number; command: CaptureCommand }[] = []
const enqueue = <T>(work: () => Promise<T> | T): Promise<T> => {
  const job = chain.then(work)
  chain = job.then(() => {}, () => {})
  return job
}
const changed = () => parentPort?.postMessage({ changed: true })
const errorCode = (error: unknown) => error instanceof Error && error.message === 'library-directory' ? 'directory'
  : error instanceof Error && error.message.startsWith('library-invalid') ? 'invalid' : 'unavailable'
async function yieldCaptures(): Promise<void> {
  while (captures.length && !closing) {
    const { id, command } = captures.shift()!
    try {
      if (command.type === 'collect') await store.collect(command.candidates)
      else if (command.type === 'nested') await store.collect(collectTool(command.session, 'nested:' + command.callId, Date.now(), command.name, command.args, command.result))
      else {
        const value = command.message as { toolCallId?: string }
        const calls = new Map<string, { name: string; args: unknown }>()
        if (command.call && value.toolCallId) calls.set(value.toolCallId, command.call)
        await store.collect(collectMessage(command.session, command.entryId, command.message, calls))
      }
      parentPort!.postMessage({ id }); changed()
    } catch (error) { parentPort!.postMessage({ id, error: errorCode(error) }) }
  }
  changed()
}

/** Background history work yields between files so reads/live captures are
 * admitted between batches. Opening the page only reads the index. */
function scanHistory(force = false): void {
  if (scan) { rescanPending ||= force; return }
  if (closing || !store.status().preferences.enabled) return
  store.scanning = true; store.scanErrors = 0; changed()
  scan = (async () => {
    const paths = await store.sessionFiles()
    for (const path of paths) {
      if (closing) break
      await enqueue(() => store.scanFile(path, force, yieldCaptures)).catch(() => { store.scanErrors++ })
    }
    if (force && !closing) await enqueue(() => store.retryUnsaved())
    store.lastScanAt = Date.now()
  })().catch(() => { store.scanErrors++ }).finally(() => {
    store.scanning = false; scan = null; changed()
    if (rescanPending) { rescanPending = false; scanHistory(true) }
  })
}

parentPort!.on('message', ({ id, command }: { id: number; command: LibraryCommand }) => {
  // Reads observe only committed rows and remain responsive during a long
  // history file or disk copy. Mutations still have one serialized owner.
  if (command.type === 'status' || command.type === 'page') {
    try { parentPort!.postMessage({ id, result: command.type === 'status' ? store.status() : store.page(command.query) }) }
    catch (error) { parentPort!.postMessage({ id, error: errorCode(error) }) }
    return
  }
  if (command.type === 'message' || command.type === 'nested' || command.type === 'collect') {
    captures.push({ id, command }); void enqueue(yieldCaptures); return
  }
  // The scan loop must never await itself through this queue.
  if (command.type === 'scan') { scanHistory(command.force); parentPort!.postMessage({ id, result: store.status() }); return }
  void enqueue(async () => {
    if (closing && command.type !== 'close') throw new Error('library-unavailable')
    switch (command.type) {
      case 'session': await store.scanFile(command.path, false, yieldCaptures); changed(); return
      case 'configure': { const result = await store.configure(command.preferences, command.directory); changed(); return result }
      case 'delete': await store.remove(command.id); changed(); return
      case 'clear': try { return await store.clear(command.kind) } finally { changed() }
      case 'file': return store.archivedFile(command.id)
      case 'preview-text': return store.previewText(command.id)
      case 'close': closing = true; clearInterval(timer); await store.close(); return
    }
  }).then(result => { parentPort!.postMessage({ id, result }); if (command.type === 'close') parentPort!.close() }, error => {
    parentPort!.postMessage({ id, error: errorCode(error) })
  })
})
const timer = setInterval(() => scanHistory(), 60_000)
timer.unref()
scanHistory()
