import { fileExtension } from './extension'
import type { FileBrowserRequest } from './types'

export type StructuredFormat = 'jsonc' | 'jsonl' | 'yaml' | 'toml' | 'xml'
const STRUCTURED: Record<string, StructuredFormat> = {
  '.jsonc': 'jsonc', '.jsonl': 'jsonl', '.ndjson': 'jsonl',
  '.yaml': 'yaml', '.yml': 'yaml', '.toml': 'toml', '.xml': 'xml'
}
export const structuredFormatOf = (path: string): StructuredFormat | null => STRUCTURED[fileExtension(path)] ?? null

export type ArchiveFormat = 'zip' | 'tar' | 'tgz' | 'gzip'
export function archiveFormatOf(path: string): ArchiveFormat | null {
  const lower = path.toLowerCase()
  if (lower.endsWith('.tar.gz')) return 'tgz'
  return ({ '.zip': 'zip', '.tar': 'tar', '.tgz': 'tgz', '.gz': 'gzip' } as Record<string, ArchiveFormat>)[fileExtension(path)] ?? null
}
export type DataFormat = 'parquet' | 'sqlite'
export function dataFormatOf(path: string): DataFormat | null {
  const ext = fileExtension(path)
  if (ext === '.parquet') return 'parquet'
  return ['.sqlite', '.sqlite3', '.db', '.db3'].includes(ext) ? 'sqlite' : null
}

export type TextEncoding = 'auto' | 'utf-8' | 'utf-16le' | 'utf-16be' | 'gb18030' | 'big5'
export type DecodedEncoding = Exclude<TextEncoding, 'auto'>
export const TEXT_ENCODINGS: readonly TextEncoding[] = ['auto', 'utf-8', 'utf-16le', 'utf-16be', 'gb18030', 'big5']

/** File previews never execute code or mutate their input. */
export type PreviewError = 'missing' | 'directory' | 'unreadable' | 'invalid' | 'unsupported' | 'tooLarge' | 'changed' | 'cancelled' | 'timeout' | 'busy'
export type PreviewResult<T = BinaryPreviewValue> = { value: T; error?: never } | { error: PreviewError; value?: never }
export const ARCHIVE_MAX_ENTRIES = 5000
export const ARCHIVE_ENTRY_BYTES = 8 * 1024 * 1024
export const PREVIEW_MAX_COLUMNS = 200
export const DATA_PAGE_ROWS = 300
export const DATA_PAGE_CHARS = 1024 * 1024
export const DATA_MAX_ROWS = 20000
export const PREVIEW_MAX_CELL_CHARS = 512

export interface ArchiveEntry {
  id: string
  name: string
  kind: 'file' | 'directory' | 'link'
  size: number
  compressedSize?: number
  readable: boolean
}
export interface ArchiveIndex {
  type: 'archive-index'
  revision: string
  format: ArchiveFormat
  entries: ArchiveEntry[]
  truncated: boolean
}
export interface ArchiveContent {
  type: 'archive-entry'
  revision: string
  name: string
  size: number
  truncated: boolean
  text?: string
  encoding?: DecodedEncoding
  image?: { data: Uint8Array; mimeType: string }
  binary?: boolean
}
export interface DataColumn { name: string; type: string }
export interface DataTable { id: string; name: string; columns: DataColumn[]; totalRows: number | null }
export interface DataIndex {
  type: 'data-index'
  revision: string
  format: DataFormat
  tables: DataTable[]
  truncated: boolean
}
export interface DataRows {
  type: 'data-rows'
  revision: string
  table: string
  offset: number
  rows: string[][]
  eof: boolean
  truncated: boolean
}
export type BinaryPreviewValue = ArchiveIndex | ArchiveContent | DataIndex | DataRows
export type BinaryPreviewQuery =
  | { type: 'archive-index' }
  | { type: 'archive-entry'; entry: string; revision: string; encoding?: TextEncoding }
  | { type: 'data-index' }
  | { type: 'data-rows'; table: string; offset: number; revision: string }
export interface BinaryPreviewRequest extends FileBrowserRequest { id: string; query: BinaryPreviewQuery }
export interface BinaryPreviewWork { path: string; query: BinaryPreviewQuery; scratch?: string }
export type StructuredValue = null | boolean | number | string | StructuredValue[] | { [key: string]: StructuredValue }
export type StructuredResult = { value: StructuredValue; records?: number; truncated: boolean } | { error: 'invalid' | 'tooLarge'; line?: number }
