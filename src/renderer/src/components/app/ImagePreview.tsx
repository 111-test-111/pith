import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode
} from 'react'
import { motion, useReducedMotion } from 'motion/react'
import { ExternalLink, ZoomIn, ZoomOut } from 'lucide-react'
import {
  CenterMorphModal,
  CenterMorphModalContent
} from '@/components/motion/center-morph-modal'
import { Button } from '@/components/motion/button'
import { Tooltip } from '@/components/motion/tooltip'
import { useI18n } from '@/i18n'
import { basename } from '@/lib/format'
import { cn } from '@/lib/utils'

/**
 * Full-screen image preview for every image the app renders: composer
 * attachments, images inside user bubbles and images embedded in assistant
 * markdown. The overlay is beUI's CenterMorphModal (a surface that unfolds from
 * its own centre); everything inside it — zoom/pan, caption, controls — is
 * composed from beUI primitives and theme tokens.
 */

/** An image the preview can show. `src` must be browser-loadable: a `data:` or
 * blob URL, or a remote `http(s)` URL — workspace paths are resolved to data
 * URLs by their source (see `lib/markdown.tsx`). */
export interface PreviewImage {
  src: string
  /** Caption and accessible name (alt text, file name). */
  label?: string
  /** Absolute local path when the image lives in the workspace: enables
   * "open in default app". Browser-picked uploads have none. */
  path?: string
}

/** Fit-to-viewport is 100%; zooming below it is not offered. */
const ZOOM_MIN = 1
const ZOOM_MAX = 8
/** One click of the zoom controls. */
const ZOOM_STEP = 1.6
/** Scale factor per wheel delta: a mouse notch, and a trackpad pinch — which
 * Chromium reports as ctrl+wheel and needs a much larger gain. */
const WHEEL_GAIN = 0.0022
const PINCH_GAIN = 0.01
/** Arrow-key pan step, in px. */
const PAN_STEP = 48
/** A notched mouse wheel is quantised — macOS Chromium reports ~120px per notch
 * — while a trackpad (or a freely spinning wheel) sends small pixel deltas,
 * measured under ~20px even on a fast flick. Anything smaller is a swipe, and
 * swipes pan. `deltaMode` line/page deltas only come from a wheel. */
const WHEEL_NOTCH_PX = 40
/** Idle time that ends a wheel gesture, in ms. */
const WHEEL_GESTURE_IDLE = 150
/** Double-click zoom target. */
const ZOOM_DOUBLE = 2.5
const ZOOM_SPRING = { type: 'spring', stiffness: 420, damping: 36, mass: 0.7 } as const

interface ViewState {
  scale: number
  /** Offset from the centred, fit-sized image, in px. */
  x: number
  y: number
}

const REST: ViewState = { scale: 1, x: 0, y: 0 }

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

type OpenImage = (image: PreviewImage) => void

const ImagePreviewContext = createContext<OpenImage | null>(null)

/** Opens the image preview from anywhere in the app. */
export function useImagePreview(): OpenImage {
  const open = useContext(ImagePreviewContext)
  if (!open) throw new Error('useImagePreview must be used within <ImagePreviewProvider>')
  return open
}

/** Mounted once near the app root: provides `useImagePreview` and hosts the one
 * overlay instance every image on screen opens. */
export function ImagePreviewProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<{ id: number; image: PreviewImage } | null>(null)
  const open = useCallback<OpenImage>((image) => {
    if (!image?.src) return
    // The id remounts the viewer — a reopened image always starts at fit, at a
    // fresh centre, instead of inheriting the previous zoom/pan.
    setRequest((previous) => ({ id: (previous?.id ?? 0) + 1, image }))
  }, [])

  return (
    <ImagePreviewContext.Provider value={open}>
      {children}
      {/* While the overlay exits, AnimatePresence keeps rendering the element it
          was given, so clearing `request` here cannot blank the closing image. */}
      <ImagePreviewHost request={request} onClose={() => setRequest(null)} />
    </ImagePreviewContext.Provider>
  )
}

function ImagePreviewHost({
  request,
  onClose
}: {
  request: { id: number; image: PreviewImage } | null
  onClose: () => void
}) {
  const { t } = useI18n()
  return (
    <CenterMorphModal
      open={request !== null}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      {/* Chromeless-ish panel: the frame is beUI's own surface (border, radius,
          motion), only its size is the viewer's. `pr-14` on the caption keeps it
          clear of the modal's own close control. */}
      <CenterMorphModalContent
        ariaLabel={request?.image.label || t('imagePreview.dialogLabel')}
        closeButtonLabel={t('imagePreview.close')}
        className="h-[min(78vh,48rem)] max-w-[min(92vw,72rem)]"
      >
        {request ? <ImageZoom key={request.id} image={request.image} /> : null}
      </CenterMorphModalContent>
    </CenterMorphModal>
  )
}

function ImageZoom({ image }: { image: PreviewImage }) {
  const { t } = useI18n()
  const reduce = useReducedMotion() ?? false
  const viewportRef = useRef<HTMLDivElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  const dragRef = useRef<{
    pointerId: number
    startX: number
    startY: number
    originX: number
    originY: number
  } | null>(null)
  /** Mode lock for the current wheel gesture (see `WHEEL_NOTCH_PX`). */
  const wheelRef = useRef<{ mode: 'zoom' | 'pan' | null; timer: number | null }>({
    mode: null,
    timer: null
  })
  const [view, setView] = useState<ViewState>(REST)
  const [dragging, setDragging] = useState(false)
  const [size, setSize] = useState<{ width: number; height: number } | null>(null)
  const [failed, setFailed] = useState(false)

  /** Clamp scale to the zoom range and the offset so the zoomed image always
   * covers the viewport — no empty gutter can be dragged into view. */
  const clampView = useCallback((next: ViewState): ViewState => {
    const scale = clampNumber(next.scale, ZOOM_MIN, ZOOM_MAX)
    const box = viewportRef.current
    const img = imgRef.current
    // `offsetWidth/Height` is the fit-sized layout box: CSS transforms don't
    // affect it, so it is the right basis for the pan limits.
    const limitX = box && img ? Math.max(0, (img.offsetWidth * scale - box.clientWidth) / 2) : 0
    const limitY = box && img ? Math.max(0, (img.offsetHeight * scale - box.clientHeight) / 2) : 0
    return {
      scale,
      x: clampNumber(next.x, -limitX, limitX),
      y: clampNumber(next.y, -limitY, limitY)
    }
  }, [])

  /** Zoom by `factor`, keeping the point `anchor` (viewport-centred px, the
   * centre by default) under the same image pixel. */
  const zoomAt = useCallback(
    (factor: number, anchor: { x: number; y: number } = { x: 0, y: 0 }) => {
      setView((current) => {
        const scale = clampNumber(current.scale * factor, ZOOM_MIN, ZOOM_MAX)
        if (scale === current.scale) return current
        const ratio = scale / current.scale
        return clampView({
          scale,
          x: anchor.x - (anchor.x - current.x) * ratio,
          y: anchor.y - (anchor.y - current.y) * ratio
        })
      })
    },
    [clampView]
  )

  const reset = useCallback(() => setView(REST), [])
  const panBy = useCallback(
    (dx: number, dy: number) => {
      setView((current) => clampView({ ...current, x: current.x + dx, y: current.y + dy }))
    },
    [clampView]
  )

  // React registers wheel listeners passively, so this has to be a native
  // non-passive listener: without `preventDefault` the transcript behind the
  // overlay scrolls while the image zooms or pans.
  useEffect(() => {
    const box = viewportRef.current
    if (!box) return
    const zoomAtPointer = (event: WheelEvent, gain: number) => {
      const rect = box.getBoundingClientRect()
      zoomAt(Math.exp(-event.deltaY * gain), {
        x: event.clientX - (rect.left + rect.width / 2),
        y: event.clientY - (rect.top + rect.height / 2)
      })
    }
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()

      // A fresh gesture ends the previous classification after a short idle.
      const gesture = wheelRef.current
      if (gesture.timer !== null) window.clearTimeout(gesture.timer)
      gesture.timer = window.setTimeout(() => {
        gesture.mode = null
        gesture.timer = null
      }, WHEEL_GESTURE_IDLE)

      // Pinch-to-zoom arrives as ctrl+wheel: always a zoom, never a pan.
      if (event.ctrlKey) {
        zoomAtPointer(event, PINCH_GAIN)
        return
      }

      // The mode is decided by the gesture's first event and then held: a swipe
      // that accelerates into momentum must not flip over to zoom halfway.
      if (gesture.mode === null) {
        const notchedWheel = event.deltaMode !== 0 || Math.abs(event.deltaY) >= WHEEL_NOTCH_PX
        gesture.mode = notchedWheel ? 'zoom' : 'pan'
      }

      if (gesture.mode === 'zoom') {
        zoomAtPointer(event, WHEEL_GAIN)
        return
      }

      // A swipe moves the image with the fingers, on both axes, and stays put
      // where the image already fills the viewport (clamped by `clampView`).
      panBy(-event.deltaX, -event.deltaY)
    }
    box.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      box.removeEventListener('wheel', onWheel)
      const gesture = wheelRef.current
      if (gesture.timer !== null) window.clearTimeout(gesture.timer)
    }
  }, [panBy, zoomAt])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (
        target &&
        (target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')
      ) {
        return
      }
      switch (event.key) {
        case '+':
        case '=':
          zoomAt(ZOOM_STEP)
          break
        case '-':
        case '_':
          zoomAt(1 / ZOOM_STEP)
          break
        case '0':
          reset()
          break
        case 'ArrowLeft':
          panBy(PAN_STEP, 0)
          break
        case 'ArrowRight':
          panBy(-PAN_STEP, 0)
          break
        case 'ArrowUp':
          panBy(0, PAN_STEP)
          break
        case 'ArrowDown':
          panBy(0, -PAN_STEP)
          break
        default:
          return
      }
      event.preventDefault()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [panBy, reset, zoomAt])

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (view.scale <= ZOOM_MIN) return
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: view.x,
      originY: view.y
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    setDragging(true)
  }

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    setView((current) =>
      clampView({
        ...current,
        x: drag.originX + (event.clientX - drag.startX),
        y: drag.originY + (event.clientY - drag.startY)
      })
    )
  }

  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    dragRef.current = null
    setDragging(false)
  }

  const onDoubleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (view.scale > ZOOM_MIN) {
      reset()
      return
    }
    const rect = event.currentTarget.getBoundingClientRect()
    zoomAt(ZOOM_DOUBLE, {
      x: event.clientX - (rect.left + rect.width / 2),
      y: event.clientY - (rect.top + rect.height / 2)
    })
  }

  const zoomed = view.scale > ZOOM_MIN
  const subtitle = [size ? `${size.width} × ${size.height}` : null, image.path ? basename(image.path) : null]
    .filter(Boolean)
    .join(' · ')

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* h-16 centres this row on the modal's own close control (16px inset +
          32px button = 32px centre), which a h-14 row left 4px above. */}
      <div className="flex h-16 flex-none items-center gap-3 border-b border-border px-4 pr-14">
        <p className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
          {image.label || t('imagePreview.dialogLabel')}
        </p>
      </div>

      <div
        ref={viewportRef}
        role="group"
        tabIndex={0}
        aria-label={t('imagePreview.viewportAria')}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={onDoubleClick}
        className={cn(
          'relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-muted/30 [touch-action:none] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
          zoomed ? (dragging ? 'cursor-grabbing' : 'cursor-grab') : 'cursor-zoom-in'
        )}
      >
        <motion.img
          ref={imgRef}
          src={image.src}
          alt={image.label ?? ''}
          draggable={false}
          onLoad={(event) =>
            setSize({
              width: event.currentTarget.naturalWidth,
              height: event.currentTarget.naturalHeight
            })
          }
          onError={() => setFailed(true)}
          animate={{ scale: view.scale, x: view.x, y: view.y }}
          // Dragging must track the pointer 1:1; everything else springs.
          transition={dragging || reduce ? { duration: 0 } : ZOOM_SPRING}
          className="max-h-full max-w-full select-none object-contain will-change-transform"
        />
        {failed ? (
          <p className="absolute inset-x-6 text-center text-sm text-muted-foreground">
            {t('imagePreview.failed')}
          </p>
        ) : null}
      </div>

      <div className="flex h-14 flex-none items-center justify-end gap-2 border-t border-border px-4">
        {subtitle ? (
          <p className="mr-auto min-w-0 truncate text-xs tabular-nums text-muted-foreground">
            {subtitle}
          </p>
        ) : null}
        <Tooltip side="top" content={t('imagePreview.zoomOut')} wrapperClassName="shrink-0">
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('imagePreview.zoomOut')}
            disabled={!zoomed}
            onClick={() => zoomAt(1 / ZOOM_STEP)}
          >
            <ZoomOut className="size-4" aria-hidden="true" />
          </Button>
        </Tooltip>
        <Tooltip side="top" content={t('imagePreview.resetZoom')} wrapperClassName="shrink-0">
          <Button
            variant="ghost"
            size="sm"
            aria-label={t('imagePreview.resetZoom')}
            disabled={!zoomed}
            onClick={reset}
            className="min-w-14 justify-center tabular-nums text-xs"
          >
            {Math.round(view.scale * 100)}%
          </Button>
        </Tooltip>
        <Tooltip side="top" content={t('imagePreview.zoomIn')} wrapperClassName="shrink-0">
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('imagePreview.zoomIn')}
            disabled={view.scale >= ZOOM_MAX}
            onClick={() => zoomAt(ZOOM_STEP)}
          >
            <ZoomIn className="size-4" aria-hidden="true" />
          </Button>
        </Tooltip>
        {image.path ? (
          <>
            <span aria-hidden="true" className="mx-1 h-5 w-px shrink-0 bg-border" />
            <Tooltip side="top" content={image.path} wrapperClassName="shrink-0">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void window.pi.openPath(image.path as string)}
              >
                <ExternalLink className="size-3.5" aria-hidden="true" />
                {t('imagePreview.openFile')}
              </Button>
            </Tooltip>
          </>
        ) : null}
      </div>
    </div>
  )
}

/**
 * An image that opens the full-screen preview when clicked — the thumbnail
 * form for everything that is not rendered from markdown (composer
 * attachments, message-bubble images). Markdown images use this too once their
 * workspace path has been resolved to a data URL.
 */
export function PreviewThumb({
  src,
  alt,
  path,
  className,
  imageClassName
}: {
  src: string
  /** Image alt text — also the preview caption. */
  alt?: string
  path?: string
  /** Classes for the trigger (border/radius/size live here). */
  className?: string
  /** Classes for the `<img>` itself. */
  imageClassName?: string
}) {
  const openImage = useImagePreview()
  const { t } = useI18n()
  const name = alt ?? ''
  return (
    <button
      type="button"
      onClick={() => openImage({ src, label: name, path })}
      aria-label={t('imagePreview.open', { name })}
      className={cn(
        'group/preview inline-block cursor-zoom-in overflow-hidden border border-border align-middle transition-shadow hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        className
      )}
    >
      <img src={src} alt={alt ?? ''} className={cn('block', imageClassName)} />
    </button>
  )
}
