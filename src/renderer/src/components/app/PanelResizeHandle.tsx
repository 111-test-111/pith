import { useCallback, useEffect, useRef, useState } from 'react'
import { useDragResize } from '@/lib/hooks/use-drag-resize'
import { cn } from '@/lib/utils'

interface PanelResizeHandleProps {
  /** Which direction grows the first panel as the pointer travels. */
  grow: 'right' | 'left' | 'down' | 'up'
  /** Accessible name — this strip is the panel's resize affordance. */
  label: string
  /** Total pointer travel since the press, in the panel's growth direction. */
  onResize: (delta: number) => void
  onResizeStart?: () => void
  onResizeEnd?: () => void
  /** A press that never resized: the same strip toggles the panel, which is the
   * gesture the vendored rail used to own. */
  onToggle?: () => void
  /** True while the strip is hovered or dragging, so the panel can light up the
   * border line it already has instead of drawing a second one. */
  onActiveChange?: (active: boolean) => void
  className?: string
  /** Edge handles straddle their panel border; an in-grid divider does not. */
  inset?: boolean
  /** Optional keyboard support for a nested split. */
  value?: number
  minValue?: number
  maxValue?: number
  onStep?: (delta: number) => void
}

/**
 * A six-pixel drag strip for a panel edge or an in-grid divider. Edge handles
 * show nothing of their own and can recolour the adjacent panel border through
 * `onActiveChange`; nested dividers may draw their rule through a CSS class.
 *
 * It lives *outside* the panel (as a flex sibling) rather than inside it,
 * because the panel clips its own content to slide open — anything hanging off
 * its inner edge would be half-clipped, which is exactly how the vendored rail
 * ended up with a two-pixel hit area. The gesture itself is tracked on the
 * window (see useDragResize), so the pointer is free to leave the strip.
 */
export function PanelResizeHandle({
  grow,
  label,
  onResize,
  onResizeStart,
  onResizeEnd,
  onToggle,
  onActiveChange,
  className,
  inset = true,
  value,
  minValue,
  maxValue,
  onStep
}: PanelResizeHandleProps) {
  const vertical = grow === 'right' || grow === 'left'
  const drag = useDragResize<HTMLDivElement>({
    grow,
    onResize,
    onStart: onResizeStart,
    onEnd: onResizeEnd
  })
  const [hovered, setHovered] = useState(false)
  // A drag outlives the hover (the pointer goes wherever it likes), so the
  // active flag is the union of the two.
  const active = hovered || drag.dragging
  // Through a ref, and keyed on `active` alone: the callback is usually an inline
  // arrow, and an effect that re-ran for it would push a parent update on every
  // render — which is a render loop, not a resize.
  const notify = useRef(onActiveChange)
  notify.current = onActiveChange
  useEffect(() => {
    notify.current?.(active)
  }, [active])
  useEffect(() => () => notify.current?.(false), [])

  const handleEnter = useCallback(() => setHovered(true), [])
  const handleLeave = useCallback(() => setHovered(false), [])

  return (
    <>
      {/* While the edge is dragged, one transparent sheet covers the app: it
          keeps the resize cursor wherever the pointer travels and stops the
          gesture from starting a text selection in the transcript. Deliberately
          an element rather than a rule on <body> — toggling a style-affecting
          attribute up there invalidates the computed style of the whole shell
          (~25k elements in a long session), which is a 100ms freeze at each end
          of the drag. */}
      {drag.dragging ? (
        <div aria-hidden="true" className={cn('fixed inset-0 z-50', vertical ? 'cursor-col-resize' : 'cursor-row-resize')} />
      ) : null}
      <div
      role="separator"
      aria-orientation={vertical ? 'vertical' : 'horizontal'}
      aria-label={label}
      data-panel-handle={grow}
      data-panel-handle-dragging={drag.dragging}
      tabIndex={onStep ? 0 : -1}
      aria-valuenow={value === undefined ? undefined : Math.round(value)}
      aria-valuemin={minValue === undefined ? undefined : Math.round(minValue)}
      aria-valuemax={maxValue === undefined ? undefined : Math.round(maxValue)}
      onKeyDown={event => {
        if (!onStep || !(vertical ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown']).includes(event.key)) return
        event.preventDefault()
        onStep((event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1) * (event.shiftKey ? 40 : 10))
      }}
      onPointerDown={drag.onPointerDown}
      onPointerEnter={handleEnter}
      onPointerLeave={handleLeave}
      onClick={() => {
        // The click that ends a resize must not also toggle the panel.
        if (drag.consumeDrag()) return
        onToggle?.()
      }}
      className={cn(
        'relative z-10 hidden shrink-0 touch-none select-none outline-none md:block',
        vertical ? 'w-1.5 cursor-col-resize' : 'h-1.5 w-full cursor-row-resize',
        // Straddle the line the panel itself draws: the strip's six pixels
        // otherwise begin where that border ends, so a pointer sitting exactly
        // ON the line lands on the panel and the drag never starts. On the left
        // the strip overlaps the sidebar (`-ml`, and the inset pulls the
        // transcript back by the same 3px). On the right it must straddle BOTH
        // columns instead (`-mx`): pulling the rail left is not an option — it
        // has to keep its own edge on the window — and the strip is what
        // decides where the boundary sits, so the transcript's own rules (the
        // task strip's bottom border) end exactly on the rail's left border
        // instead of stopping three pixels short of it.
        inset && (grow === 'right' ? '-ml-[3px]' : grow === 'left' ? '-mx-[3px]' : grow === 'down' ? '-mt-[3px]' : '-my-[3px]'),
        className
      )}
      />
    </>
  )
}
