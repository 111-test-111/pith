/**
 * Table preview facts shared by the main-process slice readers, the renderer's
 * parse worker and the grid UI: which files are tables, how big a read may be,
 * and what a parsed sheet looks like.
 *
 * A table is never read like a text document. Delimited files are streamed as
 * record-aligned byte slices (the renderer keeps only what it can show), and a
 * spreadsheet is read as a ZIP through byte ranges, inflated in a worker and
 * stopped at the preview's row cap. `files:table*` are the only readers, and
 * each refuses paths outside this table's extensions.
 */

import { fileExtension } from './extension'

export type TableFormat = 'delimited' | 'xlsx'

/** Extension → delimiter. Delimited text is still sniffed (the first slice
 * decides), so this is the tie-break hint, never the final answer. */
const DELIMITED: Record<string, string> = {
  '.csv': ',',
  '.tsv': '\t',
  '.tab': '\t',
  '.psv': '|'
}

/** `.xls` (BIFF8) is deliberately absent: the preview reads OOXML only. */
const XLSX = new Set(['.xlsx', '.xlsm'])

/** Candidate delimiters the sniffer scores against each other. */
export const TABLE_DELIMITERS = [',', '\t', ';', '|']

/** Bytes of text a single delimited slice carries. */
export const SLICE_BYTES = 256 * 1024
/** Bytes per spreadsheet range read (the worker's ZIP reader). */
export const RANGE_BYTES = 128 * 1024
/** Columns a parsed table keeps. */
export const MAX_COLUMNS = 200
/** Characters a single cell keeps. */
export const MAX_CELL_CHARS = 512
/** Rows held for a delimited file — the preview streams, then stops. */
export const DELIMITED_MAX_ROWS = 20000
/** Rows held for a worksheet: a spreadsheet is parsed in one go, so its cap is
 * what bounds both the worker's memory and the grid's DOM window. */
export const XLSX_MAX_ROWS = 5000
/** Rows loaded before the grid is first painted. */
export const INITIAL_ROWS = 300
/** How close to the loaded tail the window must scroll before it loads more. */
export const LOOKAHEAD_ROWS = 150
/** Shared-catalog/style text a workbook may accumulate before it is truncated. */
export const XLSX_MAX_TEXT_BYTES = 48 * 1024 * 1024

/** Zoom steps around 1; the grid scales its font size and row height by these. */
export const ZOOM_STEPS = [0.75, 0.9, 1, 1.15, 1.35, 1.6, 1.9]
/** Base cell font size in px; every row height and column width follows it. */
export const BASE_FONT_PX = 12
/** Base row height in px at zoom 1. */
export const BASE_ROW_PX = 24

/** The preview format of a path, or `null` (ordinary text). */
export function tableFormatOf(path: string): TableFormat | null {
  const ext = fileExtension(path)
  if (DELIMITED[ext]) return 'delimited'
  if (XLSX.has(ext)) return 'xlsx'
  return null
}

export function isXlsxPath(path: string): boolean {
  return tableFormatOf(path) === 'xlsx'
}

/** The delimiter the extension implies, used to break sniffing ties. */
export function expectedDelimiter(path: string): string | null {
  return DELIMITED[fileExtension(path)] ?? null
}

/** One worksheet, as the workbook part names it. */
export interface TableSheet {
  name: string
  path: string
}

/** A parsed worksheet. `rowNumbers` are the sheet's own 1-based row indexes, so
 * a sparse sheet keeps its real numbering (delimited rows are ordinal). */
export interface TableSheetRows {
  rows: string[][]
  rowNumbers: number[] | null
  columns: number
  totalRows: number | null
  truncated: boolean
}

/** Rows parsed out of one delimited slice. */
export interface TableRows {
  rows: string[][]
  columns: number
}
