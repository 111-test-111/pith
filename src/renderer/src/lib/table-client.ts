import type { TableSheet, TableSheetRows, TableRows } from '../../../shared/table'
import type { FileBrowserRequest } from '../../../shared/types'
import type { TableFromClient, TableRangeAsk, TableResponse } from './table-worker-protocol'

/**
 * The renderer's handle on the table parse worker: one worker for the whole
 * app, one job per request, and the range bridge the spreadsheet reader needs
 * (a worker cannot reach `window.pi`). Jobs are cancellable, because a closed
 * tab must stop inflating a workbook instead of finishing the work first.
 */

export class TableAbort extends Error {
  constructor() {
    super('aborted')
    this.name = 'TableAbort'
  }
}

export interface TableJob<T> {
  promise: Promise<T>
  cancel(): void
}

interface Tracked {
  request: FileBrowserRequest
  settle: (value: never) => void
  fail: (error: Error) => void
}

class TableClient {
  private worker: Worker | null = null
  private jobs = new Map<number, Tracked>()
  private nextId = 1

  private ensure(): Worker {
    if (this.worker) return this.worker
    const worker = new Worker(new URL('./table-worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (event: MessageEvent<TableResponse>) => this.receive(event.data)
    worker.onerror = event => {
      event.preventDefault()
      this.failAll(new Error('worker'))
    }
    this.worker = worker
    return worker
  }

  private receive(message: TableResponse) {
    if (message.type === 'range') {
      void this.fulfil(message)
      return
    }
    const job = this.jobs.get(message.id)
    if (!job) return
    this.jobs.delete(message.id)
    if (message.type === 'result') job.settle(message.value as never)
    else job.fail(new Error(message.message))
  }

  /** Reads the bytes the worker asked for and hands them straight back. */
  private async fulfil(message: TableRangeAsk) {
    const job = this.jobs.get(message.id)
    try {
      if (!job) throw new Error('aborted')
      const data = await window.pi.tableRange(job.request, message.begin, message.end)
      this.answer({ type: 'rangeData', requestId: message.requestId, data })
    } catch (error) {
      this.answer({ type: 'rangeError', requestId: message.requestId, message: String((error as Error)?.message ?? error) })
    }
  }

  private answer(message: TableFromClient) {
    this.worker?.postMessage(message)
  }

  private failAll(error: Error) {
    for (const job of this.jobs.values()) job.fail(error)
    this.jobs.clear()
  }

  private send<T>(request: FileBrowserRequest, build: (id: number) => TableFromClient): TableJob<T> {
    const worker = this.ensure()
    const id = this.nextId++
    const promise = new Promise<T>((settle, fail) => {
      this.jobs.set(id, { request, settle: settle as (value: never) => void, fail })
    })
    worker.postMessage(build(id))
    return {
      promise,
      cancel: () => {
        const job = this.jobs.get(id)
        if (!job) return
        this.jobs.delete(id)
        // Settle the caller's await: the work is over, and a rejected promise
        // that nobody settles would leak into the next mount.
        job.fail(new TableAbort())
        worker.postMessage({ type: 'cancel', id })
      }
    }
  }

  /** Rows of one delimited slice (the main process already aligned them). */
  parseRows(request: FileBrowserRequest, text: string, delimiter: string): TableJob<TableRows> {
    return this.send(request, id => ({ type: 'delimited', id, text, delimiter }))
  }

  openWorkbook(request: FileBrowserRequest, size: number, generation: number): TableJob<{ sheets: TableSheet[] }> {
    return this.send(request, id => ({ type: 'workbook', id, path: request.path, size, generation }))
  }

  readSheet(request: FileBrowserRequest, size: number, generation: number, sheet: string): TableJob<TableSheetRows> {
    return this.send(request, id => ({ type: 'sheet', id, path: request.path, size, generation, sheet }))
  }
}

export const tableClient = new TableClient()
