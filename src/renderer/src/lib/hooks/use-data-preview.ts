import { useCallback, useEffect, useRef, useState } from 'react'
import type { DataIndex, DataRows, DataTable, PreviewError } from '../../../../shared/file-preview'
import { DATA_MAX_ROWS } from '../../../../shared/file-preview'
import type { TablePreview } from './use-table-preview'
import type { TableSnapshot } from '@/state/file-browser-cache'
import type { FileBrowserStore, FileTab } from '@/state/file-browser-store'

const MAX_RETAINED_CHARS = 4 * 1024 * 1024
export function useDataPreview(tab: FileTab, store: FileBrowserStore, generation: number, index: DataIndex | undefined, table: DataTable | undefined): TablePreview & { dataError?: PreviewError } {
  const key = `${tab.cwd}\0${tab.path}\0data:${generation}:${index?.revision ?? ''}:${table?.id ?? ''}`
  const [state, setState] = useState<{ key: string; value: TableSnapshot } | null>(null)
  const [failure, setFailure] = useState<{ key: string; error: PreviewError } | null>(null)
  const [busy, setBusy] = useState(false)
  const token = useRef(0)
  const active = useRef<{ cancel(): void } | null>(null)
  const reading = useRef(false)
  const value = state?.key === key ? state.value : store.cache.table(key)
  const latest = useRef(value); latest.current = value
  const commit = useCallback((snapshot: TableSnapshot) => { store.cache.setTable(key, snapshot); setState({ key, value: snapshot }) }, [store, key])
  const read = useCallback((offset: number) => {
    if (!index || !table) return null
    return store.cache.readBinary(`${key}\0${offset}`, tab, { type: 'data-rows', table: table.id, offset, revision: index.revision })
  }, [key, index, table, tab.cwd, tab.path, store])
  useEffect(() => {
    const mine = ++token.current
    active.current?.cancel(); active.current = null
    reading.current = false; setBusy(false); setFailure(null)
    if (!index || !table) return
    const cached = store.cache.table(key)
    if (cached) { setState({ key, value: cached }); return () => { token.current++; active.current?.cancel() } }
    const job = read(0)
    if (!job) return
    active.current = job; reading.current = true; setBusy(true)
    void job.promise.then(result => {
      if (mine !== token.current) return
      if (!result.value || result.value.type !== 'data-rows') { setFailure({ key, error: result.error ?? 'invalid' }); return }
      const page = result.value
      commit({ rows: [table.columns.map(column => column.name), ...page.rows], rowNumbers: [0, ...page.rows.map((_, i) => i + 1)],
        columns: table.columns.length, sheets: [], sheet: table.id, totalRows: table.totalRows, truncated: page.truncated, eof: page.eof,
        offset: page.rows.length, delimiter: '', size: 0 })
    }).finally(() => { if (mine === token.current) { reading.current = false; setBusy(false) } })
    return () => { token.current++; active.current?.cancel() }
  }, [key, read, commit, index, table])
  const loadMore = useCallback(() => {
    const current = latest.current
    if (!current || current.eof || current.truncated || reading.current || current.offset >= DATA_MAX_ROWS) return
    const job = read(current.offset)
    if (!job) return
    const mine = token.current
    reading.current = true; setBusy(true); active.current = job
    void job.promise.then(result => {
      if (mine !== token.current) return
      if (!result.value || result.value.type !== 'data-rows') { setFailure({ key, error: result.error ?? 'invalid' }); return }
      const page = result.value as DataRows
      const rows = current.rows.concat(page.rows)
      const chars = rows.reduce((total, row) => total + row.reduce((count, cell) => count + cell.length, 0), 0)
      if (chars > MAX_RETAINED_CHARS) { commit({ ...current, truncated: true }); return }
      commit({ ...current, rows, rowNumbers: (current.rowNumbers ?? []).concat(page.rows.map((_, i) => current.offset + i + 1)), offset: current.offset + page.rows.length,
        eof: page.eof, truncated: page.truncated, totalRows: table?.totalRows ?? (page.eof ? current.offset + page.rows.length : null) })
    }).finally(() => { if (mine === token.current) { reading.current = false; setBusy(false) } })
  }, [read, key, commit, table])
  useEffect(() => () => { token.current++; active.current?.cancel() }, [])
  const dataError = failure?.key === key ? failure.error : undefined
  return { status: value ? 'ready' : dataError ? 'error' : 'loading', dataError, error: dataError ? 'unreadable' : undefined, busy,
    rows: value?.rows ?? [], rowNumbers: value?.rowNumbers ?? null, columns: table?.columns.length ?? 0,
    sheets: [], sheet: table?.id ?? null, totalRows: value?.totalRows ?? null, truncated: value?.truncated ?? false, eof: value?.eof ?? true,
    loadMore, selectSheet: () => {} }
}
