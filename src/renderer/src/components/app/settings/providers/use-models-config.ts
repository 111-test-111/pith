import { useCallback, useEffect, useRef, useState } from 'react'
import type { ModelsConfigDTO } from '../../../../../../shared/types'

/** Field edits coalesce; structural changes (add/delete) save immediately. */
const SAVE_DEBOUNCE_MS = 500

export type ModelsConfigMutate = (
  updater: (draft: ModelsConfigDTO) => ModelsConfigDTO,
  immediate?: boolean
) => void

/**
 * Draft state for ~/.pi/agent/models.json. The whole file lives in memory;
 * edits mutate the draft and persist through the debounced `saveModelsConfig`
 * IPC (which sanitizes, writes atomically and reloads the SDK runtime). The
 * sanitized result is adopted back as long as nothing newer was typed in the
 * meantime, so entries the sanitizer drops disappear from the UI too.
 */
export function useModelsConfig() {
  const [config, setConfig] = useState<ModelsConfigDTO | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  /** Bumped after every successful save; effects refetch derived data on it. */
  const [savedAt, setSavedAt] = useState(0)

  const configRef = useRef<ModelsConfigDTO | null>(null)
  const dirtyRef = useRef(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const epochRef = useRef(0)
  const pendingRef = useRef<Promise<boolean> | null>(null)

  const flush = useCallback((): Promise<boolean> => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    const snapshot = configRef.current
    if (!snapshot) return Promise.resolve(false)
    if (!dirtyRef.current) return pendingRef.current ?? Promise.resolve(true)
    dirtyRef.current = false
    const epoch = ++epochRef.current
    const payload = JSON.stringify(snapshot)
    setSaving(true)
    const pending = (async () => {
      try {
        const written = await window.pi.saveModelsConfig(snapshot)
        if (epoch !== epochRef.current) return true
        if (configRef.current && JSON.stringify(configRef.current) === payload) {
          configRef.current = written
          setConfig(written)
        }
        setSaveError(null)
        setSavedAt(Date.now())
        return true
      } catch (error) {
        if (epoch === epochRef.current) {
          setSaveError(error instanceof Error ? error.message : String(error))
          dirtyRef.current = true
        }
        return false
      } finally {
        if (epoch === epochRef.current) {
          setSaving(false)
          pendingRef.current = null
        }
      }
    })()
    pendingRef.current = pending
    return pending
  }, [])

  const mutate = useCallback<ModelsConfigMutate>(
    (updater, immediate = false) => {
      const current = configRef.current
      if (!current) return
      const next = updater(current)
      configRef.current = next
      dirtyRef.current = true
      setConfig(next)
      if (immediate) {
        void flush()
        return
      }
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        void flush()
      }, SAVE_DEBOUNCE_MS)
    },
    [flush]
  )

  const reload = useCallback(() => {
    setLoadError(null)
    return window.pi
      .modelsConfig()
      .then((fresh) => {
        configRef.current = fresh
        setConfig(fresh)
      })
      .catch(error => setLoadError(error instanceof Error ? error.message : String(error)))
  }, [])

  useEffect(() => {
    void reload()
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
      // The section is unmounting; push any pending edit without waiting.
      const snapshot = configRef.current
      if (snapshot && dirtyRef.current) {
        void window.pi.saveModelsConfig(snapshot).catch(() => {})
      }
    }
  }, [reload])

  return { config, mutate, flush, saving, saveError, savedAt, loadError, reload }
}
