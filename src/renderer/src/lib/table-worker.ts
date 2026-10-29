import { XLSX_MAX_ROWS } from '../../../shared/table'
import { parseDelimitedRows } from './table-parse'
import { TableCancelled, Workbook, isTableCancelled, type ByteSource } from './table-xlsx'
import type { TableFromClient, TableRangeAsk, TableRequest, TableResponse, TableResultValue, TableWorkbookValue } from './table-worker-protocol'

/**
 * The table parse worker. Delimited slices are parsed here so bulk text never
 * runs on the UI thread, and a spreadsheet is inflated and scanned here while
 * the bytes arrive as ranges the client fetches over IPC.
 *
 * A workbook (its ZIP directory, shared strings and styles) is kept between
 * sheet switches, keyed by path/size/generation — switching sheets must not
 * re-read what both sheets share.
 */

const jobs = new Map<number, { cancelled: boolean }>()
const pending = new Map<number, { job: number; resolve: (data: Uint8Array) => void; reject: (error: Error) => void }>()
/** Resolved workbooks only. A cached promise would bind to the job that opened
 * it, so cancelling that job (a tab switch, React's mount replay) would poison
 * the parse the next job is waiting for. */
const workbooks = new Map<string, Workbook>()
const MAX_WORKBOOKS = 3
let nextRangeId = 1

const post = (message: TableResponse) => self.postMessage(message)

function requestRange(jobId: number, begin: number, end: number): Promise<Uint8Array> {
  if (jobs.get(jobId)?.cancelled) return Promise.reject(new TableCancelled())
  const requestId = nextRangeId++
  return new Promise<Uint8Array>((resolve, reject) => {
    pending.set(requestId, { job: jobId, resolve, reject })
    const ask: TableRangeAsk = { type: 'range', id: jobId, requestId, begin, end }
    post(ask)
  })
}

function sourceFor(jobId: number, size: number): ByteSource {
  return {
    size,
    read: (begin, end) => requestRange(jobId, begin, end),
    cancelled: () => jobs.get(jobId)?.cancelled === true
  }
}

async function workbookFor(job: Extract<TableRequest, { type: 'workbook' | 'sheet' }>): Promise<Workbook> {
  const key = `${job.path}\0${job.size}\0${job.generation}`
  const cached = workbooks.get(key)
  if (cached) return cached
  const workbook = await Workbook.open(sourceFor(job.id, job.size))
  workbooks.set(key, workbook)
  while (workbooks.size > MAX_WORKBOOKS) workbooks.delete(workbooks.keys().next().value!)
  return workbook
}

async function run(job: TableRequest) {
  const record = { cancelled: false }
  jobs.set(job.id, record)
  try {
    let value: TableResultValue
    if (job.type === 'delimited') value = parseDelimitedRows(job.text, job.delimiter)
    else if (job.type === 'workbook') value = { sheets: (await workbookFor(job)).sheets } satisfies TableWorkbookValue
    else value = await (await workbookFor(job)).readSheet(sourceFor(job.id, job.size), job.sheet, XLSX_MAX_ROWS)
    if (record.cancelled) return
    post({ type: 'result', id: job.id, value })
  } catch (error) {
    if (record.cancelled || isTableCancelled(error)) return
    post({ type: 'error', id: job.id, message: String((error as Error)?.message ?? error) })
  } finally {
    jobs.delete(job.id)
  }
}

self.onmessage = (event: MessageEvent<TableFromClient>) => {
  const message = event.data
  if (message.type === 'rangeData') {
    pending.get(message.requestId)?.resolve(message.data)
    pending.delete(message.requestId)
    return
  }
  if (message.type === 'rangeError') {
    const waiting = pending.get(message.requestId)
    pending.delete(message.requestId)
    waiting?.reject(new Error(message.message))
    return
  }
  if (message.type === 'cancel') {
    const record = jobs.get(message.id)
    if (!record) return
    record.cancelled = true
    // Abandoned read requests would otherwise hold the job forever.
    for (const [requestId, waiting] of pending) {
      if (waiting.job !== message.id) continue
      pending.delete(requestId)
      waiting.reject(new TableCancelled())
    }
    return
  }
  void run(message)
}
