import { open } from 'node:fs/promises'
import { previewKindOf } from '../shared/preview'
import type { FileBrowserRequest, FontDataDTO } from '../shared/types'
import { resolveFilePath } from './file-path'

/**
 * Bytes for the font preview.
 *
 * A font is the one previewable family that does NOT ride the `pith-media`
 * scheme, and deliberately so: a `FontFace` whose source is a URL is fetched as
 * a cross-origin font request, while the media scheme carries no CORS headers
 * and no `supportFetchAPI` — dropping the scheme's "page JS cannot read these
 * bytes" property to serve a typeface would be a bad trade. `new FontFace(family,
 * buffer)` takes the bytes directly and needs neither, so the file crosses IPC
 * once, bounded, when its tab opens.
 */

/** Ceiling for one read. Variable fonts run a few MB; this only stops a
 * mislabeled multi-gigabyte file from becoming one message. */
const MAX_FONT_BYTES = 32 * 1024 * 1024

/** The absolute path of a request that really is a font: the same routing table
 * the pane dispatches on decides, so this can never serve another family. */
function fontPath(request: FileBrowserRequest): string {
  const path = resolveFilePath(request)
  if (previewKindOf(path) !== 'font') throw new Error('Not a font file')
  return path
}

export async function readFontData(request: FileBrowserRequest): Promise<FontDataDTO> {
  let path = ''
  try {
    path = fontPath(request)
    // O_NONBLOCK keeps a FIFO or device path from hanging the main process.
    const { constants } = await import('node:fs')
    const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK)
    try {
      const info = await handle.stat()
      if (!info.isFile()) return { path, size: 0, error: info.isDirectory() ? 'directory' : 'unreadable' }
      if (info.size > MAX_FONT_BYTES) return { path, size: info.size, error: 'tooLarge' }
      const buffer = Buffer.alloc(info.size)
      let read = 0
      while (read < info.size) {
        const result = await handle.read(buffer, read, info.size - read, read)
        if (!result.bytesRead) break
        read += result.bytesRead
      }
      // A short read means the file changed under us; a half font is not worth
      // rendering as a broken one.
      if (read !== info.size) return { path, size: info.size, error: 'unreadable' }
      return { path, size: info.size, data: buffer }
    } finally {
      await handle.close()
    }
  } catch (error) {
    return { path, size: 0, error: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable' }
  }
}
