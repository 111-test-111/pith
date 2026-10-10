import { useEffect, useState, type RefObject } from 'react'

const INITIAL_PROGRESS = 8
const MAX_ESTIMATED_PROGRESS = 92
const FINISH_DISPLAY_MS = 220

const isContentNavigation = (url: string) => /^https?:\/\//i.test(url)

/** One estimate per main-document navigation. Spinner events also cover late
 * iframe loads, so only main-frame navigation can start/rearm the bar. */
export function useBrowserLoadingProgress(ref: RefObject<HTMLWebViewElement | null>, restart?: number) {
  const [progress, setProgress] = useState<number | null>(null)
  useEffect(() => {
    const element = ref.current
    if (!element) return
    let loading = false
    let value = INITIAL_PROGRESS
    let tick: number | undefined
    let hide: number | undefined
    const clearTimers = () => {
      window.clearInterval(tick)
      window.clearTimeout(hide)
      tick = hide = undefined
    }
    const start = () => {
      if (loading) return
      clearTimers()
      loading = true
      value = INITIAL_PROGRESS
      setProgress(value)
      tick = window.setInterval(() => {
        value = Math.min(MAX_ESTIMATED_PROGRESS, value + Math.max(0.5, (MAX_ESTIMATED_PROGRESS - value) * 0.08))
        setProgress(value)
        if (value === MAX_ESTIMATED_PROGRESS) window.clearInterval(tick)
      }, 300)
    }
    const advance = (minimum: number) => {
      if (!loading) return
      value = Math.max(value, minimum)
      setProgress(value)
    }
    const finish = () => {
      if (!loading) return
      clearTimers()
      loading = false
      setProgress(100)
      hide = window.setTimeout(() => setProgress(null), FINISH_DISPLAY_MS)
    }
    const reset = () => {
      clearTimers()
      loading = false
      setProgress(null)
    }
    const navigating = (event: Event) => {
      const navigation = event as Event & { url: string; isMainFrame: boolean; isInPlace: boolean }
      if (!navigation.isMainFrame || navigation.isInPlace) return
      // about:blank, including the registration marker, has no page to load.
      if (!isContentNavigation(navigation.url)) {
        reset()
        return
      }
      start()
    }
    const ready = () => advance(65)
    const committed = (event: Event) => {
      if (isContentNavigation((event as Event & { url: string }).url)) advance(40)
      else reset()
    }
    const failed = (event: Event) => {
      const failure = event as Event & { isMainFrame?: boolean; errorCode?: number }
      // ERR_ABORTED belongs to a superseded navigation; its successor owns the bar.
      if (failure.isMainFrame !== false && failure.errorCode !== -3) finish()
    }
    element.addEventListener('did-start-navigation', navigating)
    element.addEventListener('did-stop-loading', finish)
    element.addEventListener('did-navigate', committed)
    element.addEventListener('dom-ready', ready)
    element.addEventListener('did-fail-load', failed)
    element.addEventListener('render-process-gone', reset)
    setProgress(null)
    try {
      const guest = element as unknown as { getURL(): string; isLoadingMainFrame(): boolean }
      if (guest.isLoadingMainFrame() && isContentNavigation(guest.getURL())) start()
    } catch { /* guest not ready; did-start-navigation initializes it */ }
    return () => {
      clearTimers()
      element.removeEventListener('did-start-navigation', navigating)
      element.removeEventListener('did-stop-loading', finish)
      element.removeEventListener('did-navigate', committed)
      element.removeEventListener('dom-ready', ready)
      element.removeEventListener('did-fail-load', failed)
      element.removeEventListener('render-process-gone', reset)
    }
  }, [ref, restart])
  return progress
}
