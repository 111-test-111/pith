import { mkdir, mkdtemp, open, rm, type FileHandle } from 'node:fs/promises'
import { constants } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { parquetMetadataAsync, parquetReadObjects, parquetSchema, type AsyncBuffer, type Compressors, type FileMetaData } from 'hyparquet'
import { compressors } from 'hyparquet-compressors'
import { dataFormatOf, DATA_MAX_ROWS, DATA_PAGE_ROWS, DATA_PAGE_CHARS, PREVIEW_MAX_CELL_CHARS, PREVIEW_MAX_COLUMNS, type BinaryPreviewQuery, type DataIndex, type DataRows, type DataTable } from '../../shared/file-preview'
import { PreviewFailure } from './errors'

const MAX_PARQUET_RANGE = 32 * 1024 * 1024
const MAX_PARQUET_READ = 64 * 1024 * 1024
const MAX_PARQUET_METADATA = 4 * 1024 * 1024
const MAX_GROUP_VALUES = 2_000_000
const MAX_TABLES = 100
const MAX_SQLITE_SNAPSHOT = 128 * 1024 * 1024
const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"'
const cell = (value: unknown): string => {
  if (value === null || value === undefined) return ''
  if (value instanceof Uint8Array) return `0x${Buffer.from(value.subarray(0, 64)).toString('hex')}${value.length > 64 ? '…' : ''}`
  if (value instanceof Date) return value.toISOString()
  // Nested Parquet values can be much larger than their displayed cell. Bound
  // the walk before serializing, rather than constructing a giant JSON string.
  let nodes = 0
  const seen = new WeakSet<object>()
  const boundedValue = (item: unknown, depth = 0): unknown => {
    if (++nodes > 64 || depth > 6) return '…'
    if (typeof item === 'bigint') return item.toString()
    if (typeof item === 'string') return item.slice(0, PREVIEW_MAX_CELL_CHARS)
    if (item instanceof Uint8Array) return cell(item)
    if (item instanceof Date) return item.toISOString()
    if (!item || typeof item !== 'object') return item
    if (seen.has(item)) return '…'
    seen.add(item)
    if (Array.isArray(item)) return item.slice(0, 32).map(child => boundedValue(child, depth + 1))
    return Object.fromEntries(Object.entries(item).slice(0, 32).map(([key, child]) => [key.slice(0, 128), boundedValue(child, depth + 1)]))
  }
  const text = typeof value === 'object' ? JSON.stringify(boundedValue(value)) : String(value)
  return text.length > PREVIEW_MAX_CELL_CHARS ? text.slice(0, PREVIEW_MAX_CELL_CHARS) + '…' : text
}
function boundedRows(records: Iterable<unknown[]>, count: number): { rows: string[][]; more: boolean } {
  const rows: string[][] = []
  let chars = 0
  for (const record of records) {
    if (rows.length >= count) return { rows, more: true }
    const row = record.map(cell)
    const size = row.reduce((sum, item) => sum + item.length, 0)
    if (rows.length && chars + size > DATA_PAGE_CHARS) return { rows, more: true }
    chars += size; rows.push(row)
  }
  return { rows, more: false }
}
const rowOffset = (query: Extract<BinaryPreviewQuery, { type: 'data-rows' }>) => {
  if (!Number.isSafeInteger(query.offset) || query.offset < 0 || query.offset >= DATA_MAX_ROWS) throw new PreviewFailure('invalid')
  return query.offset
}

function sqlite(path: string, query: Extract<BinaryPreviewQuery, { type: 'data-index' | 'data-rows' }>, revision: string): DataIndex | DataRows {
  const database = new DatabaseSync(path, { readOnly: true, allowExtension: false, timeout: 1000 })
  try {
    database.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA temp_store=MEMORY; PRAGMA cache_size=-4096; BEGIN')
    // Only ordinary main tables: views/virtual tables can execute expressions
    // and shadow tables are implementation details of their owning modules.
    const names = database.prepare("SELECT name FROM pragma_table_list WHERE schema='main' AND type='table' AND name NOT LIKE 'sqlite_%' LIMIT ?").all(MAX_TABLES + 1).map(row => String(row.name))
    let truncated = names.length > MAX_TABLES, metadataChars = 0
    const tables: DataTable[] = []
    for (const name of names.slice(0, MAX_TABLES)) {
      if (name.length > 512) throw new PreviewFailure('tooLarge')
      const columns = database.prepare('SELECT name, type FROM pragma_table_xinfo(?) WHERE hidden=0 LIMIT ?').all(name, PREVIEW_MAX_COLUMNS + 1)
      if (columns.length > PREVIEW_MAX_COLUMNS) truncated = true
      const displayed = columns.slice(0, PREVIEW_MAX_COLUMNS).map(column => {
        if (String(column.name).length > 512) throw new PreviewFailure('tooLarge')
        return { name: String(column.name), type: String(column.type || 'ANY').slice(0, 128) }
      })
      metadataChars += name.length + displayed.reduce((sum, column) => sum + column.name.length + column.type.length, 0)
      if (metadataChars > DATA_PAGE_CHARS) { truncated = true; break }
      tables.push({ id: name, name, columns: displayed, totalRows: null })
    }
    if (query.type === 'data-index') return { type: 'data-index', revision, format: 'sqlite', tables, truncated }
    const table = tables.find(item => item.id === query.table)
    if (!table || !table.columns.length) throw new PreviewFailure('missing')
    const offset = rowOffset(query)
    // Clamp text in SQL before it enters JS; represent blobs by their size.
    const fields = table.columns.map(column => {
      const name = quote(column.name)
      return `CASE WHEN typeof(${name})='blob' THEN 'BLOB (' || length(${name}) || ')' WHEN typeof(${name})='text' THEN substr(${name},1,${PREVIEW_MAX_CELL_CHARS}) ELSE ${name} END`
    }).join(', ')
    const statement = database.prepare(`SELECT ${fields} FROM ${quote(table.name)} LIMIT ? OFFSET ?`)
    statement.setReturnArrays(true); statement.setReadBigInts(true)
    const count = Math.min(DATA_PAGE_ROWS, DATA_MAX_ROWS - offset)
    const page = boundedRows(statement.iterate(count + 1, offset) as unknown as Iterable<unknown[]>, count)
    return { type: 'data-rows', revision, table: table.id, offset, rows: page.rows, eof: !page.more, truncated: page.more && offset + page.rows.length >= DATA_MAX_ROWS }
  } finally { database.close() }
}

async function parquet(handle: FileHandle, size: number, query: Extract<BinaryPreviewQuery, { type: 'data-index' | 'data-rows' }>, revision: string): Promise<DataIndex | DataRows> {
  let readBytes = 0
  const file: AsyncBuffer = { byteLength: size, slice: async (begin, end = size) => {
    const length = end - begin
    if (!Number.isSafeInteger(begin) || !Number.isSafeInteger(end) || begin < 0 || end > size || length <= 0) throw new PreviewFailure('invalid')
    if (length > MAX_PARQUET_RANGE || (readBytes += length) > MAX_PARQUET_READ) throw new PreviewFailure('tooLarge')
    const bytes = Buffer.alloc(length)
    let read = 0
    while (read < length) { const part = await handle.read(bytes, read, length - read, begin + read); if (!part.bytesRead) throw new PreviewFailure('changed'); read += part.bytesRead }
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  } }
  if (size < 12) throw new PreviewFailure('invalid')
  if (new DataView(await file.slice(0, 4)).getUint32(0, true) !== 0x31524150) throw new PreviewFailure('invalid')
  const footer = new DataView(await file.slice(size - 8, size))
  if (footer.getUint32(4, true) !== 0x31524150) throw new PreviewFailure('invalid')
  if (footer.getUint32(0, true) > MAX_PARQUET_METADATA) throw new PreviewFailure('tooLarge')
  const metadata: FileMetaData = await parquetMetadataAsync(file)
  if (metadata.num_rows < 0n || metadata.row_groups.some(group => group.num_rows < 0n || group.num_rows > BigInt(Number.MAX_SAFE_INTEGER))) throw new PreviewFailure('invalid')
  if (metadata.schema.length > 4096 || metadata.row_groups.length > 10000) throw new PreviewFailure('tooLarge')
  if (metadata.row_groups.some(group => group.columns.some(column => column.file_path || column.crypto_metadata || column.encrypted_column_metadata))) throw new PreviewFailure('unsupported')
  const children = parquetSchema(metadata).children
  if (children.some(child => child.element.name.length > 512)) throw new PreviewFailure('tooLarge')
  const columns = children.slice(0, PREVIEW_MAX_COLUMNS).map(({ element }) => ({ name: element.name, type: element.converted_type ?? element.type ?? (element.num_children ? 'STRUCT' : 'UNKNOWN') }))
  const totalRows = metadata.num_rows <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(metadata.num_rows) : null
  if (query.type === 'data-index') return { type: 'data-index', revision, format: 'parquet', tables: [{ id: 'parquet', name: 'Parquet', columns, totalRows }], truncated: children.length > PREVIEW_MAX_COLUMNS }
  if (query.table !== 'parquet') throw new PreviewFailure('missing')
  const offset = rowOffset(query)
  const end = Math.min(offset + DATA_PAGE_ROWS, DATA_MAX_ROWS, totalRows ?? DATA_MAX_ROWS)
  if (offset >= end) return { type: 'data-rows', revision, table: query.table, offset, rows: [], eof: true, truncated: false }
  let groupOffset = 0
  for (const group of metadata.row_groups) {
    const groupEnd = groupOffset + Number(group.num_rows)
    if (groupOffset < end && groupEnd > offset) {
      let uncompressed = 0n
      for (const column of group.columns) {
        const meta = column.meta_data
        if (meta && columns.some(item => item.name === meta.path_in_schema[0])) {
          uncompressed += meta.total_uncompressed_size
          if (meta.num_values > BigInt(MAX_GROUP_VALUES)) throw new PreviewFailure('tooLarge')
        }
      }
      if (uncompressed > BigInt(MAX_PARQUET_READ)) throw new PreviewFailure('tooLarge')
    }
    groupOffset = groupEnd
  }
  const bounded: Compressors = Object.fromEntries(Object.entries(compressors).map(([codec, decode]) => [codec, (input: Uint8Array, outputLength: number) => {
    if (outputLength > MAX_PARQUET_RANGE || outputLength < 0) throw new PreviewFailure('tooLarge')
    return decode(input, outputLength)
  }]))
  const records = await parquetReadObjects({ file, metadata, columns: columns.map(column => column.name), rowStart: offset, rowEnd: end, compressors: bounded })
  const page = boundedRows(records.map(record => columns.map(column => record[column.name])), end - offset)
  const eof = !page.more && (totalRows !== null ? offset + page.rows.length >= totalRows : records.length < end - offset)
  return { type: 'data-rows', revision, table: query.table, offset, rows: page.rows, eof, truncated: !eof && offset + page.rows.length >= DATA_MAX_ROWS }
}

async function copyBounded(source: FileHandle, size: number, destination: string): Promise<void> {
  const target = await open(destination, 'wx', 0o600)
  try {
    const buffer = Buffer.alloc(Math.min(128 * 1024, size))
    for (let offset = 0; offset < size;) {
      const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, size - offset), offset)
      if (!bytesRead) throw new PreviewFailure('changed')
      await target.writeFile(buffer.subarray(0, bytesRead)); offset += bytesRead
    }
  } finally { await target.close() }
}

export async function readData(path: string, handle: FileHandle, size: number, query: BinaryPreviewQuery, revision: string, scratch?: string): Promise<DataIndex | DataRows> {
  if (query.type !== 'data-index' && query.type !== 'data-rows') throw new PreviewFailure('unsupported')
  if (dataFormatOf(path) === 'parquet') return parquet(handle, size, query, revision)
  if (dataFormatOf(path) !== 'sqlite') throw new PreviewFailure('unsupported')
  if (size > MAX_SQLITE_SNAPSHOT) throw new PreviewFailure('tooLarge')
  const magic = Buffer.alloc(32)
  await handle.read(magic, 0, magic.length, 0)
  if (magic.toString('ascii', 0, 16) !== 'SQLite format 3\0') throw new PreviewFailure('invalid')
  if (magic[18] !== 2) {
    // A hot rollback journal means main-file pages may be uncommitted. A
    // private copy cannot take the writer's lock or recover the user's file.
    let journal: FileHandle | undefined
    try {
      try { journal = await open(path + '-journal', constants.O_RDONLY | constants.O_NONBLOCK) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      if (journal) {
        const info = await journal.stat()
        if (!info.isFile()) throw new PreviewFailure('busy')
        const header = Buffer.alloc(28)
        await journal.read(header, 0, header.length, 0)
        if (header.some(byte => byte !== 0)) throw new PreviewFailure('busy')
      }
    } finally { await journal?.close() }
  }
  // SQLite's read-only connection may still create/write WAL shared-memory
  // sidecars. Query a bounded private copy instead of opening the user path.
  const root = scratch ?? await mkdtemp(join(tmpdir(), 'pith-sqlite-preview-'))
  if (scratch) await mkdir(root, { mode: 0o700 })
  let wal: FileHandle | undefined
  try {
    const copied = join(root, 'database.sqlite')
    await copyBounded(handle, size, copied)
    try { wal = await open(path + '-wal', constants.O_RDONLY | constants.O_NONBLOCK) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    if (wal) {
      const info = await wal.stat()
      if (!info.isFile()) throw new PreviewFailure('unsupported')
      if (size + info.size > MAX_SQLITE_SNAPSHOT) throw new PreviewFailure('tooLarge')
      await copyBounded(wal, info.size, copied + '-wal')
    }
    return sqlite(copied, query, revision)
  } finally {
    await wal?.close()
    await rm(root, { recursive: true, force: true })
  }
}
