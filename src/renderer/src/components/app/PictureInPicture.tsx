import { useEffect, useState } from 'react'
import { Button } from '@/components/motion/button'
import { Tooltip } from '@/components/motion/tooltip'
import { Maximize2, PictureInPicture2, Pin, PinOff, ZoomIn, ZoomOut } from '@/lib/icons'
import { applyAccent, useAccent, useCustomAccent } from '@/lib/accent'
import { applyUiStyle, useUiStyle } from '@/lib/ui-style'
import { useI18n } from '@/i18n'
import type { PictureInPictureFrameDTO, PictureInPictureStateDTO } from '../../../../shared/types'

export function PictureInPicture() {
  const { t } = useI18n()
  const [windowState, setWindowState] = useState<PictureInPictureStateDTO | null>(null)
  const [frame, setFrame] = useState<PictureInPictureFrameDTO | null>(null)
  const [focused, setFocused] = useState(() => document.hasFocus())
  const [loadError, setLoadError] = useState(false)
  const [pending, setPending] = useState(false)
  const [accent] = useAccent()
  const [customAccent] = useCustomAccent()
  const [uiStyle] = useUiStyle()

  useEffect(() => { applyAccent(accent, customAccent) }, [accent, customAccent])
  useEffect(() => { applyUiStyle(uiStyle) }, [uiStyle])

  useEffect(() => {
    const onFocus = () => setFocused(true)
    const onBlur = () => setFocused(false)
    window.addEventListener('focus', onFocus)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('blur', onBlur)
    }
  }, [])

  useEffect(() => {
    if (frame) return
    const timeout = window.setTimeout(() => setLoadError(true), 5000)
    return () => window.clearTimeout(timeout)
  }, [frame])

  useEffect(() => {
    let mounted = true
    const acceptFrame = (next: PictureInPictureFrameDTO) => {
      if (mounted) setFrame((current) => !current || next.sequence > current.sequence ? next : current)
    }
    const offFrame = window.pi.onPictureInPictureFrame(acceptFrame)
    const offState = window.pi.onPictureInPictureState((next) => {
      if (mounted) setWindowState(next)
    })
    void window.pi.pictureInPictureState()
      .then((state) => {
        if (!state) throw new Error('Missing picture-in-picture state')
        if (mounted) setWindowState(state)
      })
      .catch(() => { if (mounted) setLoadError(true) })
    void window.pi.pictureInPictureFrame().then((snapshot) => {
      if (snapshot) acceptFrame(snapshot)
    }).catch(() => { /* The next live frame will fill the view. */ })
    return () => { mounted = false; offFrame(); offState() }
  }, [])

  const togglePinned = async () => {
    if (!windowState || pending) return
    setPending(true)
    try {
      const next = await window.pi.setPictureInPicturePinned(!windowState.pinned)
      if (next) setWindowState(next)
    } catch { /* The small window may have closed while this action was pending. */
    } finally { setPending(false) }
  }

  const zoom = async (direction: 'in' | 'out') => {
    if (!windowState || pending) return
    setPending(true)
    try {
      const next = await window.pi.zoomPictureInPicture(direction)
      if (next) setWindowState(next)
    } catch { /* The small window may have closed while this action was pending. */
    } finally { setPending(false) }
  }

  return (
    <div data-pip-window data-pip-drag className="relative h-full w-full overflow-hidden rounded-window border border-border bg-background text-foreground">
      {frame ? (
        <img
          data-pip-frame
          data-frame-sequence={frame.sequence}
          src={frame.dataUrl}
          alt={t('pip.mirrorAlt')}
          draggable={false}
          className="block h-full w-full object-contain"
        />
      ) : (
        <div className="grid h-full w-full place-items-center text-center text-xs text-muted-foreground">
          {t(loadError ? 'pip.loadError' : 'pip.loading')}
        </div>
      )}

      <header
        data-pip-controls
        data-focused={focused}
        inert={!focused}
        className={`absolute inset-x-2 top-2 z-10 flex h-10 items-center gap-1 rounded-control border border-border bg-background/90 px-1.5 shadow-overlay backdrop-blur-md transition-opacity duration-150 motion-reduce:transition-none ${focused ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
      >
        <span className="flex min-w-0 flex-1 items-center gap-1.5 pl-1 text-caption font-medium">
          <PictureInPicture2 aria-hidden="true" className="size-3.5 shrink-0" />
          <span className="truncate">{t('pip.title')}</span>
        </span>
        <Tooltip content={t(windowState?.pinned ? 'pip.unpin' : 'pip.pin')}>
          <Button
            size="icon" variant="ghost" className="size-7 shrink-0"
            aria-label={t(windowState?.pinned ? 'pip.unpin' : 'pip.pin')}
            aria-pressed={windowState?.pinned ?? false}
            disabled={!windowState || pending}
            onClick={() => void togglePinned()}
          >
            {windowState?.pinned ? <Pin className="size-3.5" /> : <PinOff className="size-3.5" />}
          </Button>
        </Tooltip>
        <Tooltip content={t('pip.zoomOut')}>
          <Button
            size="icon" variant="ghost" className="size-7 shrink-0"
            aria-label={t('pip.zoomOut')}
            disabled={!windowState?.canZoomOut || pending}
            onClick={() => void zoom('out')}
          >
            <ZoomOut className="size-3.5" />
          </Button>
        </Tooltip>
        <Tooltip content={t('pip.zoomIn')}>
          <Button
            size="icon" variant="ghost" className="size-7 shrink-0"
            aria-label={t('pip.zoomIn')}
            disabled={!windowState?.canZoomIn || pending}
            onClick={() => void zoom('in')}
          >
            <ZoomIn className="size-3.5" />
          </Button>
        </Tooltip>
        <Tooltip content={t('pip.restore')}>
          <Button
            size="icon" variant="ghost" className="size-7 shrink-0"
            aria-label={t('pip.restore')}
            onClick={() => void window.pi.restoreFromPictureInPicture()}
          >
            <Maximize2 className="size-3.5" />
          </Button>
        </Tooltip>
      </header>
    </div>
  )
}
