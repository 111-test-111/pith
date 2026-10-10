import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import type { ImageReplayRecord, ImageReplaySnapshot } from '../../../shared/image-replay'
import type { PresentedFile } from '../../../shared/present'

interface ReplayContext {
  items: ImageReplayRecord[]
  disabled: boolean
  retry(file: PresentedFile, restoreId: string | null): void
  cancel(replay: ImageReplayRecord): void
}
const Context = createContext<ReplayContext | null>(null)
export const useImageReplays = () => useContext(Context)

/** One subscription per transcript; request/event races are revision checked.
 * Switching views never cancels a paid operation owned by another session. */
export function ImageReplaysProvider({ sessionPath, disabled, children }: { sessionPath: string | null; disabled: boolean; children: ReactNode }) {
  const [snapshot, setSnapshot] = useState<ImageReplaySnapshot | null>(null)
  const current = useRef(sessionPath)
  const inFlight = useRef<string | null>(null)
  current.current = sessionPath
  useEffect(() => {
    setSnapshot(null)
    if (!sessionPath || !window.pi.onImageReplays || !window.pi.imageReplays) return
    let disposed = false
    const accept = (next: ImageReplaySnapshot) => {
      if (disposed || next.sessionPath !== sessionPath) return
      setSnapshot(previous => previous?.sessionPath === next.sessionPath && previous.revision > next.revision ? previous : next)
    }
    const unsubscribe = window.pi.onImageReplays(accept)
    void window.pi.imageReplays(sessionPath).then(accept).catch(() => {})
    return () => { disposed = true; unsubscribe() }
  }, [sessionPath])
  const items = snapshot?.sessionPath === sessionPath ? snapshot.items : []
  const active = items.some(item => item.status === 'queued' || item.status === 'generating')
  const retry = (file: PresentedFile, restoreId: string | null) => {
    if (!sessionPath || !file.generation || disabled || active || inFlight.current === sessionPath) return
    inFlight.current = sessionPath
    const previous = restoreId === null ? undefined : items.find(value => value.id === restoreId && value.generationId === file.generation!.id && value.sourcePath === file.path)
    const previousResult = previous?.status === 'complete' && previous.result?.files.length ? previous.result : previous?.previousResult
    const pendingId = `pending:${crypto.randomUUID()}`
    const item: ImageReplayRecord = { version: 1, id: pendingId, generationId: file.generation.id, sourcePath: file.path, restoreId, status: 'queued', startedAt: Date.now(),
      ...(previousResult ? { previousResult } : {}) }
    setSnapshot(previous => ({ sessionPath, revision: previous?.sessionPath === sessionPath ? previous.revision : 0,
      items: [...items, item] }))
    void window.pi.retryPresentedImage({ sessionPath, generationId: file.generation.id, path: file.path, restoreId }).catch(error => {
      if (current.current !== sessionPath) return
      setSnapshot(previous => previous && ({ ...previous, items: previous.items.map(value => value.id === pendingId
        ? { ...value, status: 'error', endedAt: Date.now(), error: error instanceof Error ? error.message : String(error) } : value) }))
    }).finally(() => { if (inFlight.current === sessionPath) inFlight.current = null })
  }
  const cancel = (replay: ImageReplayRecord) => {
    if (sessionPath && !replay.id.startsWith('pending:')) void window.pi.cancelImageReplay(sessionPath, replay.id).catch(() => {})
  }
  return <Context.Provider value={{ items, disabled: disabled || active || !sessionPath, retry, cancel }}>{children}</Context.Provider>
}
