import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject
} from 'react'
import { wheelPixels, WHEEL_GESTURE_IDLE, WHEEL_NOTCH_PX } from '@/lib/wheel-gesture'

/**
 * Zoom/pan interaction for an image that is laid out to fit its viewport.
 * Shared by the full-screen preview overlay and the file pane's media view, so
 * the wheel classification, clamping and double-click behaviour cannot drift
 * apart between the two.
 *
 * Fit-to-viewport is 100% and the range runs from half size to 8×. Because the
 * floor sits BELOW fit now, "off fit" and "can be dragged" are different
 * questions: `zoomed` answers the first (reset, double-click) and `pannable`
 * the second (cursor, pointer capture).
 */

/** Fit-to-viewport is 100%; a shrunk view may go down to half that. */
export const ZOOM_MIN = 0.5
export const ZOOM_MAX = 8
/** One click of the zoom controls. */
export const ZOOM_STEP = 1.6
/** Scale factor per wheel delta: a mouse notch, and a trackpad pinch — which
 * Chromium reports as ctrl+wheel and needs a much larger gain. */
const WHEEL_GAIN = 0.0022
const PINCH_GAIN = 0.01
/** Arrow-key pan step, in px. */
const PAN_STEP = 48
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
  /** Vector images resize their painted box on zoom. Their pan limits still
   * use this fixed fit size, rather than multiplying that resized box again. */
  getFitSize?: () => { width: number; height: number } | null
  /**
   * Where the +/-/arrow shortcuts are heard. The overlay owns the whole window,
   * so it listens on `window`; the file pane shares the window with the
   * composer, so it only listens while its own viewport has focus.
   */
  keyboard?: 'window' | 'element'
  /** A different group image starts at fit without remounting its controls. */
  resetKey?: string
  /** Group navigation owns horizontal arrows; vertical arrows still pan. */
  onNavigate?: (direction: -1 | 1) => void
}

export function useImageZoom({ viewportRef, imageRef, getFitSize, keyboard = 'window', resetKey, onNavigate }: ImageZoomOptions) {
  const dragRef = useRef<{
    pointerId: number
    startX: number
    startY: number
    originX: number
    originY: number
  } | null>(null)
  const [view, setView] = useState<ImageZoomView>(REST)
  const [dragging, setDragging] = useState(false)
  useLayoutEffect(() => {
    dragRef.current = null
    setDragging(false)
    setView(REST)
  }, [resetKey])
  /** Off the fit view: shrunk, enlarged, or panned away from the centre. */
  const zoomed = view.scale !== 1 || view.x !== 0 || view.y !== 0
  /** Grown past fit. At or below fit the scaled image is no bigger than its
   * box, so `clampView` allows no offset and a drag could never move it. */
  const pannable = view.scale > 1

  /** Clamp scale to the zoom range and the offset so the zoomed image always
   * covers the viewport — no empty gutter can be dragged into view. */
  const clampView = useCallback(
    (next: ImageZoomView): ImageZoomView => {
      const scale = clampNumber(next.scale, ZOOM_MIN, ZOOM_MAX)
      const box = viewportRef.current
      const img = imageRef.current
      // `offsetWidth/Height` is the fit-sized layout box: CSS transforms don't
      // affect it, so it is the right basis for the pan limits.
      const fit = getFitSize?.()
      const limitX = box && img ? Math.max(0, ((fit?.width ?? img.offsetWidth) * scale - box.clientWidth) / 2) : 0
      const limitY = box && img ? Math.max(0, ((fit?.height ?? img.offsetHeight) * scale - box.clientHeight) / 2) : 0
      return {
        scale,
        x: clampNumber(next.x, -limitX, limitX),
        y: clampNumber(next.y, -limitY, limitY)
      }
    },
    [getFitSize, imageRef, viewportRef]
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
    let mode: 'pan' | 'zoom' | null = null
    let lastWheel = -Infinity
    const zoomAtPointer = (event: WheelEvent, delta: number, gain: number) => {
      const rect = box.getBoundingClientRect()
      zoomAt(Math.exp(-delta * gain), {
        x: event.clientX - (rect.left + rect.width / 2),
        y: event.clientY - (rect.top + rect.height / 2)
      })
    }
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const input = wheelPixels(event, box)
      if (!input.deltaX && !input.deltaY) return
      const now = performance.now()
      if (now - lastWheel > WHEEL_GESTURE_IDLE || input.ctrlKey || input.shiftKey) mode = null
      lastWheel = now
      if (input.ctrlKey) {
        zoomAtPointer(event, input.deltaY, PINCH_GAIN)
        return
      }
      // A trackpad pan stays a pan as it accelerates. Horizontal/diagonal
      // input always permits panning, including immediately after wheel zoom.
      if (mode === null || input.deltaX) {
        mode = !input.deltaX && (input.deltaMode !== 0 || Math.abs(input.deltaY) >= WHEEL_NOTCH_PX) ? 'zoom' : 'pan'
      }
      if (mode === 'zoom') {
        zoomAtPointer(event, input.deltaY, WHEEL_GAIN)
        return
      }
      panBy(-input.deltaX, -input.deltaY)
    }
    box.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      box.removeEventListener('wheel', onWheel)
    }
  }, [panBy, resetKey, viewportRef, zoomAt])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (
        event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey ||
        viewportRef.current?.closest('[inert]') ||
        (target && (target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA'))
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
          if (onNavigate) onNavigate(-1)
          else panBy(PAN_STEP, 0)
          break
        case 'ArrowRight':
          if (onNavigate) onNavigate(1)
          else panBy(-PAN_STEP, 0)
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
  }, [keyboard, onNavigate, panBy, reset, viewportRef, zoomAt])

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pannable) return
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
    // Any view away from fit returns to it; only a fitted image is the
    // shortcut into the image (a shrunk one must not jump straight past fit).
    if (zoomed) {
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
    /** Away from the fit view — what reset and double-click act on. */
    zoomed,
    /** Grown past fit — the only state in which dragging moves the image. */
    pannable,
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
