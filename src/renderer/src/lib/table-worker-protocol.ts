import type { TableSheet, TableSheetRows, TableRows } from '../../../shared/table'

/**
 * Messages between the table client (renderer main thread) and its parse
 * worker. Parsing never touches the UI thread: the worker walks delimited text
 * and inflates spreadsheet parts, asking the client for byte ranges as it goes —
 * that indirection is what keeps `window.pi` (and therefore IPC) out of the
 * worker, which has no access to the preload bridge.
 */

export interface TableDelimitedRequest {
  type: 'delimited'
  id: number
  text: string
  delimiter: string
}

export interface TableWorkbookRequest {
  type: 'workbook'
  id: number
  path: string
  size: number
  /** Bumped by the pane's refresh counter, so a rewritten file is re-read. */
  generation: number
}

export interface TableWorksheetRequest {
  type: 'sheet'
  id: number
  path: string
  size: number
  generation: number
  sheet: string
}

export type TableRequest = TableDelimitedRequest | TableWorkbookRequest | TableWorksheetRequest

export interface TableWorkbookValue {
  sheets: TableSheet[]
}

export type TableResultValue = TableRows | TableWorkbookValue | TableSheetRows

/** The worker asking for bytes; answered by `rangeData`/`rangeError`. */
export interface TableRangeAsk {
  type: 'range'
  id: number
  requestId: number
  begin: number
  end: number
}

export interface TableResult {
  type: 'result'
  id: number
  value: TableResultValue
}

export interface TableFailure {
  type: 'error'
  id: number
  message: string
}

export type TableResponse = TableRangeAsk | TableResult | TableFailure

export interface TableRangeData {
  type: 'rangeData'
  requestId: number
  data: Uint8Array
}

export interface TableRangeError {
  type: 'rangeError'
  requestId: number
  message: string
}

export interface TableCancel {
  type: 'cancel'
  id: number
}

export type TableFromClient = TableRequest | TableRangeData | TableRangeError | TableCancel
