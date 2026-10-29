import type { FileHandle } from 'node:fs/promises'
import { createGunzip, crc32 } from 'node:zlib'
import { basename } from 'node:path'
import type { Readable } from 'node:stream'
import { extract } from 'tar-stream'
import { openPromise, type Entry } from 'yauzl'
import { ARCHIVE_ENTRY_BYTES, ARCHIVE_MAX_ENTRIES, type ArchiveContent, type ArchiveEntry, type ArchiveFormat, type ArchiveIndex, type BinaryPreviewQuery, type TextEncoding } from '../../shared/file-preview'
import { mediaKindOf, mediaMimeType } from '../../shared/media'
import { previewKindOf, readsAsText, textReadLimit } from '../../shared/preview'
import { decodeFileText } from '../text-decoding'
import { PreviewFailure } from './errors'
import { zipNames } from './zip-names'

const MAX_SCAN_BYTES = 128 * 1024 * 1024
const MAX_NAME_BYTES = 2 * 1024 * 1024
type ArchiveQuery = Extract<BinaryPreviewQuery, { type: 'archive-index' | 'archive-entry' }>
const safeName = (name: string) => name.length > 0 && name.length <= 4096 && !/^[\/\\]|^[a-z]:|[\x00-\x1f]/i.test(name) && !name.replaceAll('\\', '/').split('/').includes('..')
const contentLimit = (name: string) => mediaKindOf(name) === 'image' ? ARCHIVE_ENTRY_BYTES : textReadLimit(previewKindOf(name))

function content(name: string, size: number, bytes: Buffer, revision: string, encoding?: TextEncoding): ArchiveContent {
  const truncated = bytes.length > contentLimit(name) || size > contentLimit(name)
  const data = bytes.subarray(0, contentLimit(name))
  const base: ArchiveContent = { type: 'archive-entry', revision, name, size, truncated }
  if (mediaKindOf(name) === 'image') {
    if (truncated) throw new PreviewFailure('tooLarge')
    return { ...base, image: { data: new Uint8Array(data), mimeType: mediaMimeType(name)! } }
  }
  if (!readsAsText(previewKindOf(name))) return { ...base, binary: true }
  const decoded = decodeFileText(data, truncated, encoding)
  return decoded ? { ...base, ...decoded } : { ...base, binary: true }
}

async function boundedStream(stream: AsyncIterable<unknown> & { destroy(): unknown }, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let bytes = 0
  try {
    for await (const chunk of stream) {
      if (!(chunk instanceof Uint8Array)) throw new PreviewFailure('invalid')
      const data = Buffer.from(chunk)
      const take = Math.min(data.length, limit + 1 - bytes)
      chunks.push(data.subarray(0, take)); bytes += take
      if (bytes > limit) break
    }
    return Buffer.concat(chunks, bytes)
  } finally { stream.destroy() }
}

async function zip(path: string, query: ArchiveQuery, revision: string): Promise<ArchiveIndex | ArchiveContent> {
  const archive = await openPromise(path, { autoClose: false, lazyEntries: true, validateEntrySizes: true, decodeStrings: false })
  try {
    const records: Entry[] = []
    let names = 0, truncated = false
    for await (const entry of archive.eachEntry()) {
      names += entry.fileNameRaw.length * 2 + entry.extraFieldRaw.length + entry.fileCommentRaw.length
      if (records.length >= ARCHIVE_MAX_ENTRIES || names > MAX_NAME_BYTES) { truncated = true; break }
      if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0 || entry.fileNameRaw.length > 16384) throw new PreviewFailure('invalid')
      records.push(entry)
    }
    const decoded = zipNames(records)
    const entries: ArchiveEntry[] = []
    for (let current = 0; current < records.length; current++) {
      const entry = records[current], name = decoded[current]
      if (name.length > 4096) throw new PreviewFailure('invalid')
      const mode = (entry.externalFileAttributes >>> 16) & 0xf000
      const kind = mode === 0xa000 ? 'link' : name.endsWith('/') || mode === 0x4000 || (entry.externalFileAttributes & 0x10) ? 'directory' : 'file'
      const readable = kind === 'file' && safeName(name) && entry.canDecodeFileData() && !entry.isEncrypted()
      if (query.type === 'archive-entry') {
        if (String(current) !== query.entry) continue
        if (!readable) throw new PreviewFailure('unsupported')
        const bytes = await boundedStream(await archive.openReadStreamPromise(entry), contentLimit(name))
        if (bytes.length === entry.uncompressedSize && crc32(bytes) !== entry.crc32) throw new PreviewFailure('invalid')
        return content(name, entry.uncompressedSize, bytes, revision, query.encoding)
      }
      entries.push({ id: String(current), name, kind, size: entry.uncompressedSize, compressedSize: entry.compressedSize, readable })
    }
    if (query.type === 'archive-entry') throw new PreviewFailure('missing')
    return { type: 'archive-index', revision, format: 'zip', entries, truncated }
  } finally { archive.close() }
}

async function tar(handle: FileHandle, format: 'tar' | 'tgz', query: ArchiveQuery, revision: string): Promise<ArchiveIndex | ArchiveContent> {
  return new Promise((resolve, reject) => {
    const source = handle.createReadStream({ start: 0, autoClose: false })
    const gunzip = format === 'tgz' ? createGunzip() : null
    const inflated: Readable = gunzip ?? source
    const archive = extract()
    const entries: ArchiveEntry[] = []
    let settled = false, scanned = 0, names = 0, ordinal = 0
    const finish = (value?: ArchiveIndex | ArchiveContent, error?: unknown) => {
      if (settled) return
      settled = true
      source.unpipe(); inflated.unpipe()
      source.destroy(); inflated.destroy(); archive.destroy()
      if (error) reject(error); else resolve(value!)
    }
    const index = (truncated: boolean): ArchiveIndex => ({ type: 'archive-index', revision, format, entries, truncated })
    const failed = (error: Error) => finish(undefined, error)
    source.on('error', failed); archive.on('error', failed); gunzip?.on('error', failed)
    inflated.on('data', (chunk: Buffer) => {
      scanned += chunk.length
      if (scanned > MAX_SCAN_BYTES) query.type === 'archive-index' ? finish(index(true)) : finish(undefined, new PreviewFailure('tooLarge'))
    })
    archive.on('entry', (header, stream, next) => {
      const current = ordinal++
      const kind = header.type === 'directory' ? 'directory' : header.type === 'link' || header.type === 'symlink' ? 'link' : 'file'
      const size = header.size ?? 0
      const readable = (header.type === 'file' || header.type === 'contiguous-file') && safeName(header.name)
      if (!Number.isSafeInteger(size) || size < 0 || header.name.length > 4096) { finish(undefined, new PreviewFailure('invalid')); return }
      if (query.type === 'archive-entry' && String(current) === query.entry) {
        if (!readable) { finish(undefined, new PreviewFailure('unsupported')); return }
        void boundedStream(stream, contentLimit(header.name)).then(bytes => finish(content(header.name, size, bytes, revision, query.encoding)), error => finish(undefined, error))
        return
      }
      if (query.type === 'archive-index') {
        names += header.name.length * 2
        if (entries.length >= ARCHIVE_MAX_ENTRIES || names > MAX_NAME_BYTES) { finish(index(true)); return }
        entries.push({ id: String(current), name: header.name, kind, size, readable })
      }
      stream.on('end', next); stream.resume()
    })
    archive.on('finish', () => query.type === 'archive-index' ? finish(index(false)) : finish(undefined, new PreviewFailure('missing')))
    inflated.pipe(archive)
    if (gunzip) source.pipe(gunzip)
  })
}

export async function readArchive(path: string, handle: FileHandle, size: number, format: ArchiveFormat, query: ArchiveQuery, revision: string): Promise<ArchiveIndex | ArchiveContent> {
  if (format === 'zip') return zip(path, query, revision)
  if (format === 'tar' || format === 'tgz') return tar(handle, format, query, revision)
  if (size < 18) throw new PreviewFailure('invalid')
  const header = Buffer.alloc(2), footer = Buffer.alloc(4)
  await handle.read(header, 0, 2, 0); await handle.read(footer, 0, 4, size - 4)
  if (header[0] !== 0x1f || header[1] !== 0x8b) throw new PreviewFailure('invalid')
  const name = basename(path).slice(0, -3)
  const uncompressed = footer.readUInt32LE()
  if (query.type === 'archive-index') return { type: 'archive-index', revision, format, entries: [{ id: '0', name, kind: 'file', size: uncompressed, compressedSize: size, readable: true }], truncated: false }
  if (query.entry !== '0') throw new PreviewFailure('missing')
  const source = handle.createReadStream({ start: 0, autoClose: false })
  const inflated = createGunzip()
  source.on('error', error => inflated.destroy(error))
  try { return content(name, uncompressed, await boundedStream(source.pipe(inflated), contentLimit(name)), revision, query.encoding) }
  finally { source.destroy(); inflated.destroy() }
}
