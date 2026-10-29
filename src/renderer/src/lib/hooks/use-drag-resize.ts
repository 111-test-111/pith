import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'

export interface DragResizeHandlers<T extends HTMLElement> {
  onPointerDown: (event: ReactPointerEvent<T>) => void
  /** True while a resize gesture is in progress (for the handle's own styling). */
  dragging: boolean
  /**
   * True exactly once, immediately after a gesture that resized — so the click
   * that ends a drag does not also run the handle's plain click action (the
   * panel toggle).
   */
  consumeDrag: () => boolean
}

/**
 * Pointer drag for a panel edge, reported as the TOTAL travel since the press
 * (not a per-event delta), so the caller only has to remember the size it
 * started from — and so a drag that wanders off the strip still lands where the
 * pointer is.
 *
 * The move/up listeners live on `window`, not on the handle: a 6px strip is left
 * immediately, and `setPointerCapture` is not something every input path honours
 * (synthetic events in particular do not), which would silently end the drag at
 * the first pixel.
 */
export function useDragResize<T extends HTMLElement>(options: {
  /** Which way the panel grows: with the pointer, or against it. */
  grow: 'right' | 'left' | 'down' | 'up'
  onResize: (delta: number) => void
  onStart?: () => void
  onEnd?: () => void
  /** Travel that turns a press into a drag rather than a click. */
  threshold?: number
}): DragResizeHandlers<T> {
  const [dragging, setDragging] = useState(false)
  const gesture = useRef<{ startX: number; startY: number; moved: boolean } | null>(null)
  const dragged = useRef(false)
  const listeners = useRef<{ move: (event: PointerEvent) => void; end: () => void } | null>(null)
  // Keep the callbacks in refs: the handlers stay identity-stable, so the DOM
  // listeners are attached once per gesture instead of churning per render.
  const optionsRef = useRef(options)
  optionsRef.current = options

  const detach = useCallback(() => {
    const active = listeners.current
    if (!active) return
    window.removeEventListener('pointermove', active.move, true)
    window.removeEventListener('pointerup', active.end, true)
    window.removeEventListener('pointercancel', active.end, true)
    listeners.current = null
  }, [])

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<T>) => {
      if (event.button !== 0 || gesture.current) return
      gesture.current = { startX: event.clientX, startY: event.clientY, moved: false }
      optionsRef.current.onStart?.()

      const move = (native: PointerEvent) => {
        const current = gesture.current
        if (!current) return
        const grow = optionsRef.current.grow
        const travel = (grow === 'right' || grow === 'left' ? native.clientX - current.startX : native.clientY - current.startY)
          * (grow === 'right' || grow === 'down' ? 1 : -1)
        if (!current.moved) {
          if (Math.abs(travel) < (optionsRef.current.threshold ?? 3)) return
          current.moved = true
          setDragging(true)
        }
        optionsRef.current.onResize(travel)
      }
      const end = () => {
        detach()
        const moved = gesture.current?.moved ?? false
        gesture.current = null
        if (!moved) return
        dragged.current = true
        setDragging(false)
        optionsRef.current.onEnd?.()
      }

      listeners.current = { move, end }
      window.addEventListener('pointermove', move, true)
      window.addEventListener('pointerup', end, true)
      window.addEventListener('pointercancel', end, true)
    },
    [detach]
  )

  // A gesture that outlives its handle (the panel was closed mid-drag) must not
  // keep listening for moves.
  useEffect(() => () => detach(), [detach])

  const consumeDrag = useCallback(() => {
    if (!dragged.current) return false
    dragged.current = false
    return true
  }, [])

  return { onPointerDown, dragging, consumeDrag }
}
