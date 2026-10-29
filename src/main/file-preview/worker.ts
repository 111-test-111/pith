import { parentPort, workerData } from 'node:worker_threads'
import { open, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { archiveFormatOf, dataFormatOf, type BinaryPreviewWork, type PreviewResult } from '../../shared/file-preview'
import { previewError, PreviewFailure } from './errors'
import { readArchive } from './archive'
import { readData } from './data'

export async function fileRevision(path: string): Promise<string> {
  const info = await stat(path)
  if (!info.isFile()) throw new PreviewFailure(info.isDirectory() ? 'directory' : 'unreadable')
  const identity = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`
  // WAL commits change the selected data without changing the main DB file.
  if (dataFormatOf(path) !== 'sqlite') return identity
  const wal = await stat(path + '-wal').catch(() => null)
  return identity + (wal ? `:${wal.ino}:${wal.size}:${wal.mtimeMs}:${wal.ctimeMs}` : ':no-wal')
}

export async function readBinaryPreview({ path, query, scratch }: BinaryPreviewWork): Promise<PreviewResult> {
  try {
    const revision = await fileRevision(path)
    if ('revision' in query && query.revision !== revision) throw new PreviewFailure('changed')
    const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK)
    try {
      const info = await handle.stat()
      if (!info.isFile()) throw new PreviewFailure('unreadable')
      const format = archiveFormatOf(path)
      const value = format && (query.type === 'archive-index' || query.type === 'archive-entry')
        ? await readArchive(path, handle, info.size, format, query, revision)
        : await readData(path, handle, info.size, query, revision, scratch)
      if (await fileRevision(path) !== revision) throw new PreviewFailure('changed')
      return { value }
    } catch (error) {
      if (await fileRevision(path).catch(() => null) !== revision) throw new PreviewFailure('changed')
      throw error
    } finally { await handle.close() }
  } catch (error) { return { error: previewError(error) } }
}

if (parentPort) {
  const result = await readBinaryPreview(workerData as BinaryPreviewWork)
  parentPort.postMessage(result)
  parentPort.close()
}
