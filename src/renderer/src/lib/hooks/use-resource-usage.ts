import { useCallback, useEffect, useRef, useState } from 'react'
import type { ResourceRuntimeDTO, ResourceStorageDTO } from '../../../../shared/resources'

/** Keep the settings panel mounted, but poll only while it is actually visible.
 * Each request finishes before scheduling another; hidden tabs never accumulate
 * requests and leaving the section fences late responses. */
export function useResourceUsage(active: boolean) {
  const [runtime, setRuntime] = useState<ResourceRuntimeDTO | null>(null)
  const [runtimeError, setRuntimeError] = useState(false)
  const [storage, setStorage] = useState<ResourceStorageDTO | null>(null)
  const [storageError, setStorageError] = useState(false)
  const [scanning, setScanning] = useState(false)
  const scanBusy = useRef(false), initialScan = useRef(false), mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  const scan = useCallback(async () => {
    if (scanBusy.current) return
    scanBusy.current = true; setScanning(true); setStorageError(false)
    try {
      const result = await window.pi.resourceStorage()
      if (!mounted.current) return
      if (result.ok) setStorage(result.value)
      else setStorageError(true)
    } catch { if (mounted.current) setStorageError(true) }
    finally { scanBusy.current = false; if (mounted.current) setScanning(false) }
  }, [])

  useEffect(() => {
    if (active && !initialScan.current) { initialScan.current = true; void scan() }
  }, [active, scan])

  useEffect(() => {
    if (!active) return
    let disposed = false, pending = false, timer: ReturnType<typeof setTimeout> | undefined
    const visible = () => document.visibilityState !== 'hidden'
    const poll = async () => {
      clearTimeout(timer)
      if (disposed || pending || !visible()) return
      pending = true
      try {
        const result = await window.pi.resourceRuntime()
        if (disposed || !visible()) return
        if (result.ok) { setRuntime(result.value); setRuntimeError(false) }
        else setRuntimeError(true)
      } catch { if (!disposed) setRuntimeError(true) }
      finally {
        pending = false
        if (!disposed && visible()) timer = setTimeout(() => void poll(), 2_000)
      }
    }
    const visibility = () => { clearTimeout(timer); if (document.visibilityState !== 'hidden') void poll() }
    document.addEventListener('visibilitychange', visibility)
    void poll()
    return () => { disposed = true; clearTimeout(timer); document.removeEventListener('visibilitychange', visibility) }
  }, [active])

  return { runtime, runtimeError, storage, storageError, scanning, scan }
}
