import { useEffect, useState } from 'react'
import type { BinaryPreviewQuery, BinaryPreviewValue, PreviewResult } from '../../../../shared/file-preview'
import type { FileBrowserStore, FileTab } from '@/state/file-browser-store'

export function useBinaryPreview<T extends BinaryPreviewValue>(tab: FileTab, store: FileBrowserStore, generation: number, query: BinaryPreviewQuery | null) {
  const serialized = JSON.stringify(query)
  const key = `${tab.cwd}\0${tab.path}\0${generation}\0${serialized}`
  const [state, setState] = useState<{ key: string; result: PreviewResult }>({ key, result: { error: 'cancelled' } })
  const [busy, setBusy] = useState(true)
  useEffect(() => {
    if (!query) { setBusy(false); return }
    let cancelled = false
    setBusy(true)
    const job = store.cache.readBinary(key, tab, JSON.parse(serialized) as BinaryPreviewQuery)
    void job.promise.then(result => { if (!cancelled) { setState({ key, result }); setBusy(false) } })
    return () => { cancelled = true; job.cancel() }
  }, [key, serialized, tab.visit, store])
  const cached = store.cache.binary(key) as T | undefined
  const result = state.key === key && state.result.error !== 'cancelled' ? state.result : cached ? { value: cached } : null
  return { value: (query ? result?.value : undefined) as T | undefined, error: query ? result?.error : undefined, busy: !!query && (busy || !result) }
}
