import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject
} from 'react'

/**
 * Zoom/pan interaction for an image that is laid out to fit its viewport.
 * Shared by the full-screen preview overlay and the file pane's media view, so
 * the wheel classification, clamping and double-click behaviour cannot drift
 * apart between the two.
 */

/** Fit-to-viewport is 100%; zooming below it is not offered. */
export const ZOOM_MIN = 1
export const ZOOM_MAX = 8
/** One click of the zoom controls. */
export const ZOOM_STEP = 1.6
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
/** Animation for every view change that is not dragging or reduced motion. */
export const ZOOM_SPRING = { type: 'spring', stiffness: 420, damping: 36, mass: 0.7 } as const

export interface ImageZoomView {
  scale: number
  /** Offset from the centred, fit-sized image, in px. */
  x: number
  y: number
}

const REST: ImageZoomView = { scale: 1, x: 0, y: 0 }

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

interface ImageZoomOptions {
  /** The clipping box the image is centred in. */
  viewportRef: RefObject<HTMLDivElement | null>
  imageRef: RefObject<HTMLImageElement | null>
  /**
   * Where the +/-/arrow shortcuts are heard. The overlay owns the whole window,
   * so it listens on `window`; the file pane shares the window with the
   * composer, so it only listens while its own viewport has focus.
   */
  keyboard?: 'window' | 'element'
}

export function useImageZoom({ viewportRef, imageRef, keyboard = 'window' }: ImageZoomOptions) {
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
  const [view, setView] = useState<ImageZoomView>(REST)
  const [dragging, setDragging] = useState(false)

  /** Clamp scale to the zoom range and the offset so the zoomed image always
   * covers the viewport — no empty gutter can be dragged into view. */
  const clampView = useCallback(
    (next: ImageZoomView): ImageZoomView => {
      const scale = clampNumber(next.scale, ZOOM_MIN, ZOOM_MAX)
      const box = viewportRef.current
      const img = imageRef.current
      // `offsetWidth/Height` is the fit-sized layout box: CSS transforms don't
      // affect it, so it is the right basis for the pan limits.
      const limitX = box && img ? Math.max(0, (img.offsetWidth * scale - box.clientWidth) / 2) : 0
      const limitY = box && img ? Math.max(0, (img.offsetHeight * scale - box.clientHeight) / 2) : 0
      return {
        scale,
        x: clampNumber(next.x, -limitX, limitX),
        y: clampNumber(next.y, -limitY, limitY)
      }
    },
    [imageRef, viewportRef]
  )

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
  // non-passive listener: without `preventDefault` the surface behind the image
  // scrolls while the image zooms or pans.
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
  }, [panBy, viewportRef, zoomAt])

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
    if (keyboard === 'element') {
      const box = viewportRef.current
      if (!box) return
      box.addEventListener('keydown', onKeyDown)
      return () => box.removeEventListener('keydown', onKeyDown)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [keyboard, panBy, reset, viewportRef, zoomAt])

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
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

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
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

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    dragRef.current = null
    setDragging(false)
  }

  const onDoubleClick = (event: ReactMouseEvent<HTMLDivElement>) => {
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

  return {
    view,
    dragging,
    zoomed: view.scale > ZOOM_MIN,
    zoomAt,
    panBy,
    reset,
    /** Spread onto the viewport element. */
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: endDrag,
      onPointerCancel: endDrag,
      onDoubleClick
    }
  }
}
