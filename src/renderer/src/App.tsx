import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react'
import { useTheme } from 'next-themes'
import { WindowTitlebar } from './components/app/WindowTitlebar'
import { ImagePreviewProvider } from './components/app/ImagePreview'
import { ToastProvider } from './components/app/ToastProvider'
import { Welcome } from './components/app/Welcome'
import { Workspace } from './components/app/Workspace'
import { PictureInPicture } from './components/app/PictureInPicture'
import { PiStore } from './state/pi-store'
import { useNotificationSoundEvents, useScheduledTaskCompletionCue } from './lib/notification-sounds'
import { I18nProvider, useI18n } from './i18n'
import { applyAccent, useAccent, useCustomAccent } from './lib/accent'
import { applyUiStyle, useUiStyle } from './lib/ui-style'
import type { SessionSnapshotDTO } from '../../shared/types'

function AppInner() {
  const { t } = useI18n()
  // Notification cues: mounted here (not in Workspace) so they also cover the
  // boot/ welcome phases, and so every session's events — background ones
  // included — reach one player.
  useNotificationSoundEvents()
  // Scheduled runs end through the tasks store's transition diff, not the
  // session event stream, so their cue mounts beside the session cues.
  useScheduledTaskCompletionCue()
  const { theme, resolvedTheme } = useTheme()
  useEffect(() => {
    // During renderer HMR the previous preload can stay alive until Electron
    // restarts. Keep that transition usable while the native frame catches up.
    if (theme === 'light' || theme === 'dark' || theme === 'system') window.pi.setWindowTheme?.(theme)
  }, [theme, resolvedTheme])
  const store = useMemo(() => new PiStore(), [])
  const [booted, setBooted] = useState(false)
  const [hasCwd, setHasCwd] = useState(false)
  const [initError, setInitError] = useState<string | null>(null)
  const [accent, setAccent] = useAccent()
  const [customAccent] = useCustomAccent()
  // A layout effect (not an effect) so the preset/custom tokens are on <html>
  // before the first paint: an effect would flash the default indigo on a
  // custom-accent boot.
  useLayoutEffect(() => {
    applyAccent(accent, customAccent)
  }, [accent, customAccent])

  const [uiStyle, setUiStyle] = useUiStyle()
  // A layout effect (not an effect) so the preset is on <html> before the
  // first paint: an effect would flash the square style on a squircle boot.
  useLayoutEffect(() => {
    applyUiStyle(uiStyle)
  }, [uiStyle])

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
        const snapshot: SessionSnapshotDTO = await window.pi.init(info.cwd ?? undefined)
        if (cancelled) return
        store.applySnapshot(snapshot)
        setHasCwd(true)
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
      <div className="window-page flex h-full flex-col text-sm text-muted-foreground">
        <WindowTitlebar><span>{t('app.name')}</span></WindowTitlebar>
        <div className="grid flex-1 place-items-center">{t('app.starting')}</div>
      </div>
    )
  }

  if (!hasCwd) {
    return (
      <div className="window-page flex h-full flex-col">
        <WindowTitlebar><span className="text-sm text-muted-foreground">{t('app.name')}</span></WindowTitlebar>
        <div className="min-h-0 flex-1">
          {initError ? (
            <div className="grid h-full place-items-center">
              <p className="max-w-sm rounded-xl border border-destructive/40 bg-destructive/10 p-4 text-center text-sm text-destructive">
                {initError}
              </p>
            </div>
          ) : null}
          {!initError ? <Welcome onPickFolder={pickAndInit} /> : null}
        </div>
      </div>
    )
  }

  return (
    <ImagePreviewProvider>
      <Workspace
        store={store}
        accent={accent}
        onAccentChange={setAccent}
        uiStyle={uiStyle}
        onUiStyleChange={setUiStyle}
      />
    </ImagePreviewProvider>
  )
}

/** The providers wrap the whole app so every string — including the boot
 * splash — resolves through the same dictionary and any pane can raise
 * transient feedback through the one toast stack. */
export default function App() {
  const compact = new URLSearchParams(window.location.search).get('view') === 'pip'
  return (
    <I18nProvider>
      <ToastProvider>
        {compact ? <PictureInPicture /> : <AppInner />}
      </ToastProvider>
    </I18nProvider>
  )
}
