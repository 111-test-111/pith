import { open, stat as statPath } from 'node:fs/promises'
import { TABLE_DELIMITERS, SLICE_BYTES, expectedDelimiter, isXlsxPath, tableFormatOf } from '../shared/table'
import type { FileBrowserError, FileBrowserRequest, TableSliceDTO, TableStatDTO } from '../shared/types'
import { resolveFilePath } from './file-path'
import { sniffTextEncoding } from './text-decoding'
import type { TextEncoding } from '../shared/file-preview'

/**
 * Main-process reads for the table preview: the format and delimiter of a
 * delimited file, record-aligned text slices of it, and raw byte ranges of a
 * spreadsheet (a ZIP, which its own reader walks).
 *
 * Nothing here parses a table. The renderer's worker does that, so a wide file
 * cannot block the Electron main process (the Pi SDK's host) — this module only
 * moves bounded byte windows and keeps the sniff result warm.
 */

/** Head bytes read once per file to decide encoding and delimiter. */
const SNIFF_BYTES = 64 * 1024
/** Extra bytes a slice may read past its budget to finish the last record. */
const SLICE_SLACK = 64 * 1024
/** Ceiling for one range message; the ZIP reader asks for 128 KiB chunks. */
const MAX_RANGE_BYTES = 4 * 1024 * 1024
const MAX_SNIFF_CACHE = 32

interface Sniff {
  size: number
  mtimeMs: number
  encoding: string
  /** Bytes per code unit: UTF-8 scans byte-wise, UTF-16 pair-wise. */
  unit: 1 | 2
  /** BOM length, stripped from the first decoded slice. */
  bom: number
  delimiter: string
}

const sniffs = new Map<string, Sniff>()

/** The absolute path of a request that really is a table of this kind. */
function tablePath(request: FileBrowserRequest, kind: 'delimited' | 'xlsx' | null): string {
  const path = resolveFilePath(request)
  const format = tableFormatOf(path)
  if (!format || (kind && format !== kind)) throw new Error('Not a table file')
  return path
}

function errorCode(error: unknown): FileBrowserError {
  return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable'
}

async function readRange(path: string, begin: number, end: number): Promise<Buffer> {
  const length = end - begin
  if (!Number.isSafeInteger(begin) || !Number.isSafeInteger(end) || begin < 0 || length <= 0 || length > MAX_RANGE_BYTES) throw new Error('Invalid table range')
  // O_NONBLOCK keeps a FIFO or device path from hanging the main process.
  const { constants } = await import('node:fs')
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK)
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new Error('Not a file')
    if (end > info.size) throw new Error('Table range past the end of the file')
    const buffer = Buffer.alloc(length)
    let read = 0
    while (read < length) {
      const result = await handle.read(buffer, read, length - read, begin + read)
      if (!result.bytesRead) break
      read += result.bytesRead
    }
    // A short read means the file changed under us; a shifted offset would
    // silently merge two records, so fail instead of returning less.
    if (read !== length) throw new Error('Table changed while reading')
    return buffer
  } finally {
    await handle.close()
  }
}

/** BOM first (never guesses over an explicit marker), then the NUL density of
 * the head, which is what distinguishes UTF-16 from UTF-8 in practice. */
const detectEncoding = (buffer: Buffer, requested: TextEncoding = 'auto'): Pick<Sniff, 'encoding' | 'unit' | 'bom'> => sniffTextEncoding(buffer, requested)

/** Fields a line would split into, ignoring separators inside quotes. */
function countFields(line: string, delimiter: string): number {
  let fields = 1
  let quoted = false
  for (let index = 0; index < line.length; index++) {
    const char = line[index]
    if (char === '"') {
      if (quoted && line[index + 1] === '"') index++
      else quoted = !quoted
    } else if (char === delimiter && !quoted) fields++
  }
  return fields
}

/** The delimiter that splits the head most consistently — with the extension's
 * own delimiter winning ties, so a single-column `.tsv` stays tab-separated. */
function sniffDelimiter(text: string, expected: string | null): string {
  const lines = text.split(/\r?\n/).slice(0, 50).filter(line => line.length > 0)
  let best = expected ?? ','
  let score = 0
  for (const candidate of TABLE_DELIMITERS) {
    const counts = lines.map(line => countFields(line, candidate))
    let mode = 0
    let modeCount = 0
    for (const count of counts) {
      const seen = counts.filter(value => value === count).length
      if (seen > modeCount) { modeCount = seen; mode = count }
    }
    if (mode < 2) continue
    const consistent = modeCount / Math.max(1, counts.length)
    const value = consistent * 1000 + Math.min(mode, 50) + (candidate === expected ? 500 : 0)
    if (value > score) { score = value; best = candidate }
  }
  return best
}

function decode(bytes: Buffer, sniff: Pick<Sniff, 'encoding'>): string {
  return new TextDecoder(sniff.encoding).decode(bytes)
}

/** Cached by path, invalidated by the file's own size and mtime. */
async function sniffFile(path: string, requested: TextEncoding = 'auto'): Promise<Sniff> {
  const info = await statPath(path)
  const key = `${path}\0${requested}`
  const cached = sniffs.get(key)
  if (cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs) return cached
  const head = await readRange(path, 0, Math.min(info.size, SNIFF_BYTES) || 1).catch(() => Buffer.alloc(0))
  const encoding = detectEncoding(head, requested)
  const text = decode(head.subarray(encoding.bom), encoding)
  const sniff: Sniff = { size: info.size, mtimeMs: info.mtimeMs, ...encoding, delimiter: sniffDelimiter(text, expectedDelimiter(path)) }
  sniffs.delete(key)
  sniffs.set(key, sniff)
  while (sniffs.size > MAX_SNIFF_CACHE) sniffs.delete(sniffs.keys().next().value!)
  return sniff
}

/**
 * The first record boundary at or after `from`, in bytes. Quote state is
 * tracked from the start of the window, because a newline inside a quoted field
 * does not end a record — splitting there would merge two rows in the grid.
 */
function recordEnd(buffer: Buffer, from: number, unit: 1 | 2, little: boolean): number {
  if (unit === 1) {
    let quoted = false
    for (let index = 0; index < buffer.length; index++) {
      const byte = buffer[index]
      if (byte === 0x22) {
        // An escaped quote inside a quoted field never closes it.
        if (quoted && buffer[index + 1] === 0x22) index++
        else quoted = !quoted
      } else if (byte === 0x0a && !quoted && index >= from) return index + 1
    }
    return buffer.length
  }
  const pair = (index: number) => little ? buffer[index] | (buffer[index + 1] << 8) : (buffer[index] << 8) | buffer[index + 1]
  let quoted = false
  for (let index = 0; index + 1 < buffer.length; index += 2) {
    const code = pair(index)
    if (code === 0x22) {
      if (quoted && pair(index + 2) === 0x22) index += 2
      else quoted = !quoted
    } else if (code === 0x0a && !quoted && index >= from) return index + 2
  }
  return buffer.length
}

export async function readTableStat(request: FileBrowserRequest): Promise<TableStatDTO> {
  let path = ''
  let format: TableStatDTO['format'] = null
  try {
    path = tablePath(request, null)
    format = tableFormatOf(path)
    const info = await statPath(path)
    if (!info.isFile()) return { path, format, size: 0, error: info.isDirectory() ? 'directory' : 'unreadable' }
    if (!format) return { path, format: null, size: info.size }
    if (format === 'xlsx') return { path, format, size: info.size }
    const sniff = await sniffFile(path, request.encoding)
    return { path, format, size: sniff.size, delimiter: sniff.delimiter }
  } catch (error) {
    return { path, format, size: 0, error: errorCode(error) }
  }
}

/** `[offset, nextOffset)` of a delimited file: whole records only, so the
 * worker never has to stitch a row across two slices. */
export async function readTableSlice(request: FileBrowserRequest, offset: number, maxBytes = SLICE_BYTES): Promise<TableSliceDTO> {
  let path = ''
  const start = Number.isSafeInteger(offset) && offset > 0 ? offset : 0
  try {
    path = tablePath(request, 'delimited')
    const sniff = await sniffFile(path, request.encoding)
    if (start >= sniff.size) return { path, offset: start, nextOffset: start, eof: true, text: '' }
    const budget = Math.max(4096, Math.min(SLICE_BYTES, maxBytes))
    const buffer = await readRange(path, start, Math.min(sniff.size, start + budget + SLICE_SLACK))
    const last = start + buffer.length >= sniff.size
    const end = last ? buffer.length : recordEnd(buffer, budget, sniff.unit, sniff.encoding === 'utf-16le')
    // The BOM only ever precedes the first byte of the file.
    const bytes = start === 0 && sniff.bom ? buffer.subarray(Math.min(sniff.bom, end), end) : buffer.subarray(0, end)
    const nextOffset = start + end
    return { path, offset: start, nextOffset, eof: nextOffset >= sniff.size, text: decode(bytes, sniff) }
  } catch (error) {
    return { path, offset: start, nextOffset: start, eof: true, text: '', error: errorCode(error) }
  }
}

/** Exactly `[begin, end)` of a spreadsheet, for its ZIP reader. */
export async function readTableRange(request: FileBrowserRequest, begin: number, end: number): Promise<Uint8Array> {
  const path = tablePath(request, 'xlsx')
  if (!isXlsxPath(path)) throw new Error('Not a spreadsheet')
  return readRange(path, begin, end)
}
