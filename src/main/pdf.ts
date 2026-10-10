import { open } from 'node:fs/promises'
import { isPdfPath } from '../shared/pdf'
import type { FileBrowserRequest, PdfStatDTO } from '../shared/types'
import { resolveFilePath } from './file-path'

/**
 * Byte-range reads for the PDF preview. pdf.js parses in its own worker and
 * pulls only the ranges it needs, so the renderer never holds the file and the
 * IPC payload stays proportional to what is actually being looked at.
 *
 * `end` is exclusive (see `shared/pdf.ts`): pdf.js validates every answer
 * against its chunk grid.
 */

/** One request's ceiling. pdf.js asks for a handful of 64 KiB chunks at a time;
 * this only stops a pathological page with a gigantic embedded stream from
 * asking for hundreds of megabytes in one message. */
const MAX_RANGE_BYTES = 32 * 1024 * 1024

function pdfPath(request: FileBrowserRequest): string {
  const path = resolveFilePath(request)
  // The reader serves PDFs only, so it can never become a general file reader.
  if (!isPdfPath(path)) throw new Error('Not a PDF file')
  return path
}

export async function readPdfStat(request: FileBrowserRequest): Promise<PdfStatDTO> {
  let path = ''
  try {
    path = pdfPath(request)
    // O_NONBLOCK keeps a FIFO or device path from hanging the main process.
    const { constants } = await import('node:fs')
    const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK)
    try {
      const info = await handle.stat()
      if (!info.isFile()) return { path, size: 0, error: info.isDirectory() ? 'directory' : 'unreadable' }
      return { path, size: info.size }
    } finally {
      await handle.close()
    }
  } catch (error) {
    return { path, size: 0, error: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable' }
  }
}

/** Exactly `[begin, end)` of the file, or a rejection the reader turns into a
 * failed load. A short read means the file changed underneath us and pdf.js'
 * chunk arithmetic would be wrong, so it fails rather than returning less. */
export async function readPdfRange(request: FileBrowserRequest, begin: number, end: number): Promise<Uint8Array> {
  const path = pdfPath(request)
  if (!Number.isSafeInteger(begin) || !Number.isSafeInteger(end) || begin < 0 || end <= begin) throw new Error('Invalid PDF range')
  const length = end - begin
  if (length > MAX_RANGE_BYTES) throw new Error('PDF range too large')
  const { constants } = await import('node:fs')
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK)
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new Error('Not a file')
    if (end > info.size) throw new Error('PDF range past the end of the file')
    const buffer = Buffer.alloc(length)
    let read = 0
    while (read < length) {
      const result = await handle.read(buffer, read, length - read, begin + read)
      if (!result.bytesRead) break
      read += result.bytesRead
    }
    if (read !== length) throw new Error('PDF changed while reading')
    return buffer
  } finally {
    await handle.close()
  }
}
