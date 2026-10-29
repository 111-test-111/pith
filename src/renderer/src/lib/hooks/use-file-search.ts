import { useEffect, useMemo, useState } from 'react'
import { EMPTY_FILE_SEARCH, type FileSearchOptions, type FileSearchResult } from '../file-search'

export function useFileSearch(text: string, query: string, options: FileSearchOptions, enabled: boolean) {
  const request = useMemo(() => ({ text, query: enabled ? query : '', options }), [text, query, options, enabled])
  const [value, setValue] = useState<{ request: typeof request; result: FileSearchResult }>()
  useEffect(() => {
    if (!request.query) return
    let worker: Worker | undefined, deadline: ReturnType<typeof setTimeout> | undefined
    let cancelled = false
    const finish = (result: FileSearchResult) => {
      worker?.terminate(); clearTimeout(deadline)
      if (!cancelled) setValue({ request, result })
    }
    const debounce = setTimeout(() => {
      try {
        worker = new Worker(new URL('../file-search-worker.ts', import.meta.url), { type: 'module' })
        worker.onmessage = (event: MessageEvent<FileSearchResult>) => finish(event.data)
        worker.onerror = event => { event.preventDefault(); finish({ ...EMPTY_FILE_SEARCH, error: 'unavailable' }) }
        deadline = setTimeout(() => finish({ ...EMPTY_FILE_SEARCH, error: 'timeout' }), 1000)
        worker.postMessage(request)
      } catch { finish({ ...EMPTY_FILE_SEARCH, error: 'unavailable' }) }
    }, 60)
    return () => { cancelled = true; clearTimeout(debounce); clearTimeout(deadline); worker?.terminate() }
  }, [request])
  const ready = value?.request === request
  return { result: request.query && ready ? value.result : EMPTY_FILE_SEARCH, searching: !!request.query && !ready }
}
