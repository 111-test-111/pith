import { useCallback, useEffect, useRef, useState } from 'react'
import type { LibraryStatus } from '../../../../shared/library'

/** Push-fed metadata; page reads never trigger a filesystem scan. */
export function useLibraryStatus(active = true) {
  const [status, setStatus] = useState<LibraryStatus | null>(null)
  const [error, setError] = useState(false)
  const generation = useRef(0)
  const refresh = useCallback(async () => {
    const request = ++generation.current
    try {
      const result = await window.pi.libraryStatus()
      if (request !== generation.current) return
      setError(!result.ok)
      if (result.ok) setStatus(result.value)
    } catch { if (request === generation.current) setError(true) }
  }, [])
  useEffect(() => {
    if (!active) return
    void refresh()
    const off = window.pi.onLibraryChanged(() => void refresh())
    return () => { generation.current++; off() }
  }, [active, refresh])
  return { status, setStatus, error, refresh }
}
