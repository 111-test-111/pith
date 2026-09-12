import { useCallback, useEffect, useMemo, useState } from 'react'
import { ImagePreviewProvider } from './components/app/ImagePreview'
import { Welcome } from './components/app/Welcome'
import { Workspace } from './components/app/Workspace'
import { PiStore } from './state/pi-store'
import { I18nProvider, useI18n } from './i18n'
import type { SessionSnapshotDTO } from '../../shared/types'

const ACCENT_KEY = 'pi-app:accent'
const DEFAULT_ACCENT = 'indigo'

function applyAccent(accent: string): void {
  document.documentElement.dataset.accent = accent
  window.localStorage.setItem(ACCENT_KEY, accent)
}

function AppInner() {
  const { t } = useI18n()
  const store = useMemo(() => new PiStore(), [])
  const [booted, setBooted] = useState(false)
  const [hasCwd, setHasCwd] = useState(false)
  const [initError, setInitError] = useState<string | null>(null)
  const [accent, setAccent] = useState<string>(() => {
    const stored = window.localStorage.getItem(ACCENT_KEY)
    return stored ?? DEFAULT_ACCENT
  })

  useEffect(() => {
    applyAccent(accent)
  }, [accent])

  useEffect(() => {
    const offEvent = window.pi.onEvent((event) => store.dispatch(event))
    return () => {
      offEvent()
    }
  }, [store])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const info = await window.pi.appInfo()
        if (cancelled) return
        if (info.cwd) {
          const snapshot: SessionSnapshotDTO = await window.pi.init(info.cwd)
          if (cancelled) return
          store.applySnapshot(snapshot)
          setHasCwd(true)
        }
      } catch (error) {
        if (!cancelled) {
          setInitError(error instanceof Error ? error.message : String(error))
        }
      } finally {
        if (!cancelled) setBooted(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [store])

  const pickAndInit = useCallback(async () => {
    const result = await window.pi.pickDirectory()
    if ('cancelled' in result) return
    const snapshot = await window.pi.init(result.cwd)
    store.applySnapshot(snapshot)
    setHasCwd(true)
  }, [store])

  if (!booted) {
    return (
      <div className="grid h-full place-items-center bg-background text-sm text-muted-foreground">
        {t('app.starting')}
      </div>
    )
  }

  if (!hasCwd) {
    return (
      <div className="h-full">
        {initError ? (
          <div className="grid h-full place-items-center">
            <p className="max-w-sm rounded-xl border border-destructive/40 bg-destructive/10 p-4 text-center text-sm text-destructive">
              {initError}
            </p>
          </div>
        ) : null}
        {!initError ? <Welcome onPickFolder={pickAndInit} /> : null}
      </div>
    )
  }

  return (
    <ImagePreviewProvider>
      <Workspace store={store} accent={accent} onAccentChange={setAccent} />
    </ImagePreviewProvider>
  )
}

/** The provider wraps the whole app so every string — including the boot
 * splash — resolves through the same dictionary. */
export default function App() {
  return (
    <I18nProvider>
      <AppInner />
    </I18nProvider>
  )
}
