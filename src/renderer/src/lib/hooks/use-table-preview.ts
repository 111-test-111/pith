import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { DELIMITED_MAX_ROWS, INITIAL_ROWS, type TableFormat, type TableSheet } from '../../../../shared/table'
import type { FileBrowserError } from '../../../../shared/types'
import { TableAbort, tableClient, type TableJob } from '../table-client'
import type { TableSnapshot } from '@/state/file-browser-cache'
import type { FileBrowserStore, FileTab } from '@/state/file-browser-store'

/**
 * The grid's data source. Delimited files are pulled slice by slice and grow as
 * the window approaches their tail; a workbook is opened once and one sheet is
 * parsed at a time. Every result lands in the pane's bounded cache, so a tab
 * switch back to a table repaints from memory instead of re-reading the file.
 */

export interface TablePreview {
  status: 'loading' | 'ready' | 'error'
  error?: FileBrowserError
  /** A further slice or sheet is in flight; the current rows stay on screen. */
  busy: boolean
  rows: string[][]
  rowNumbers: number[] | null
  columns: number
  sheets: TableSheet[]
  sheet: string | null
  totalRows: number | null
  truncated: boolean
  eof: boolean
  loadMore(): void
  selectSheet(sheet: string): void
}

const EMPTY: TableSnapshot = {
  rows: [], rowNumbers: null, columns: 0, sheets: [], sheet: null,
  totalRows: null, truncated: false, eof: true, offset: 0, delimiter: ',', size: 0
}

export function useTablePreview(tab: FileTab, format: TableFormat, generation: number, store: FileBrowserStore): TablePreview {
  const request = useMemo(() => ({ cwd: tab.cwd, path: tab.path, encoding: tab.encoding }), [tab.cwd, tab.path, tab.encoding])
  const key = `${tab.cwd}\0${tab.path}\0${generation}${tab.encoding && tab.encoding !== 'auto' ? ':' + tab.encoding : ''}`
  const [snapshot, setSnapshot] = useState<TableSnapshot | null>(() => store.cache.table(key) ?? null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>(() => (store.cache.table(key) ? 'ready' : 'loading'))
  const [error, setError] = useState<FileBrowserError>()
  const [busy, setBusy] = useState(false)
  const token = useRef(0)
  const job = useRef<TableJob<unknown> | null>(null)
  const busyRef = useRef(false)
  const latest = useRef<TableSnapshot | null>(snapshot)
  latest.current = snapshot
  // The rows already on screen, per file. A revalidation (window focus, a
  // settled run) must not blank the grid while it re-reads: the flash was the
  // loading state replacing a table that was still perfectly good.
  const shown = useRef<TableSnapshot | null>(null)
  const shownPath = useRef<string | null>(null)

  const commit = useCallback((value: TableSnapshot) => {
    store.cache.setTable(key, value)
    shownPath.current = tab.path
    shown.current = value
    setSnapshot(value)
    setStatus('ready')
  }, [key, store, tab.path])

  useEffect(() => {
    const cached = store.cache.table(key)
    if (cached) {
      shownPath.current = tab.path
      shown.current = cached
      setSnapshot(cached); setError(undefined); setStatus('ready')
      busyRef.current = false; setBusy(false)
      return
    }
    const current = ++token.current
    const track = <T,>(next: TableJob<T>) => { job.current = next as TableJob<unknown>; return next.promise }
    const previous = shownPath.current === tab.path ? shown.current : null
    let cancelled = false
    const fail = (value: FileBrowserError) => {
      if (cancelled) return
      setError(value)
      // With rows already on screen the failure only stops the refresh; the
      // footer reports it instead of replacing the table with a notice.
      setStatus(previous ? 'ready' : 'error')
    }
    setError(undefined)
    if (previous) { setSnapshot(previous); setStatus('ready'); busyRef.current = true; setBusy(true) }
    else { setSnapshot(null); setStatus('loading') }
    void (async () => {
      try {
        const stat = await window.pi.tableStat(request)
        if (cancelled || current !== token.current) return
        if (stat.error || !stat.format) { fail(stat.error ?? 'unreadable'); return }
        if (stat.format === 'xlsx') {
          const workbook = await track(tableClient.openWorkbook(request, stat.size, generation))
          if (cancelled || current !== token.current) return
          const first = workbook.sheets[0]
          if (!first) { fail('unreadable'); return }
          // Revalidating keeps the worksheet the user was reading.
          const wanted = previous?.sheet && workbook.sheets.some(candidate => candidate.path === previous.sheet) ? previous.sheet : first.path
          const sheet = await track(tableClient.readSheet(request, stat.size, generation, wanted))
          if (cancelled || current !== token.current) return
          commit({
            rows: sheet.rows, rowNumbers: sheet.rowNumbers, columns: sheet.columns, sheets: workbook.sheets,
            sheet: wanted, totalRows: sheet.totalRows, truncated: sheet.truncated, eof: true,
            offset: 0, delimiter: '', size: stat.size
          })
          return
        }
        const delimiter = stat.delimiter ?? ','
        let rows: string[][] = []
        let columns = 0
        let offset = 0
        let eof = false
        while (!eof && rows.length < INITIAL_ROWS) {
          const slice = await window.pi.tableSlice(request, offset)
          if (cancelled || current !== token.current) return
          if (slice.error) { fail(slice.error); return }
          const parsed = await track(tableClient.parseRows(request, slice.text, delimiter))
          if (cancelled || current !== token.current) return
          rows = rows.concat(parsed.rows)
          columns = Math.max(columns, parsed.columns)
          offset = slice.nextOffset
          eof = slice.eof
        }
        commit({ rows, rowNumbers: null, columns, sheets: [], sheet: null, totalRows: null, truncated: false, eof, offset, delimiter, size: stat.size })
      } catch (caught) {
        if (cancelled || caught instanceof TableAbort) return
        fail('unreadable')
      } finally {
        if (current === token.current) { busyRef.current = false; setBusy(false) }
      }
    })()
    return () => { cancelled = true; job.current?.cancel() }
  }, [key, request, generation, format, store, commit, tab.path])

  // A closed tab must not leave a workbook inflating in the worker.
  useEffect(() => () => { token.current++; job.current?.cancel() }, [])

  const loadMore = useCallback(() => {
    const current = latest.current
    if (!current || format !== 'delimited' || busyRef.current) return
    if (current.eof || current.truncated || current.rows.length >= DELIMITED_MAX_ROWS) return
    const mine = token.current
    busyRef.current = true
    setBusy(true)
    void (async () => {
      try {
        let { rows, columns, offset, eof } = current
        const target = rows.length + INITIAL_ROWS
        while (!eof && rows.length < target && rows.length < DELIMITED_MAX_ROWS) {
          const slice = await window.pi.tableSlice(request, offset)
          if (mine !== token.current) return
          if (slice.error) break
          const parsed = await tableClient.parseRows(request, slice.text, current.delimiter).promise
          if (mine !== token.current) return
          rows = rows.concat(parsed.rows)
          columns = Math.max(columns, parsed.columns)
          offset = slice.nextOffset
          eof = slice.eof
        }
        // The row cap is what keeps a huge export from filling the renderer.
        commit({ ...current, rows, columns, offset, eof, truncated: !eof && rows.length >= DELIMITED_MAX_ROWS })
      } catch (caught) {
        if (caught instanceof TableAbort) return
      } finally {
        busyRef.current = false
        if (mine === token.current) setBusy(false)
      }
    })()
  }, [commit, format, request])

  const selectSheet = useCallback((sheet: string) => {
    const current = latest.current
    if (!current || format !== 'xlsx' || current.sheet === sheet || busyRef.current) return
    const mine = token.current
    busyRef.current = true
    setBusy(true)
    const next = tableClient.readSheet(request, current.size, generation, sheet)
    job.current = next as TableJob<unknown>
    void next.promise.then(result => {
      if (mine !== token.current) return
      commit({ ...current, rows: result.rows, rowNumbers: result.rowNumbers, columns: result.columns, sheet, totalRows: result.totalRows, truncated: result.truncated })
    }).catch(() => {}).finally(() => {
      busyRef.current = false
      if (mine === token.current) setBusy(false)
    })
  }, [commit, format, generation, request])

  return {
    status, error, busy, rows: snapshot?.rows ?? EMPTY.rows, rowNumbers: snapshot?.rowNumbers ?? null,
    columns: snapshot?.columns ?? 0, sheets: snapshot?.sheets ?? EMPTY.sheets, sheet: snapshot?.sheet ?? null,
    totalRows: snapshot?.totalRows ?? null, truncated: snapshot?.truncated ?? false, eof: snapshot?.eof ?? true,
    loadMore, selectSheet
  }
}
