import { useLayoutEffect, useRef, useState } from 'react'

type SplitRange = { value: number; min: number; max: number }
type SplitDrag = SplitRange & { start: number; commit: (width: number) => void }

/** Named-container CSS owns orientation; only the grid receives drag writes. */
export function useWidePaneSplit({ preferred, onCommit, scope, enabled = true }: {
  preferred: number | undefined
  onCommit: (width: number) => void
  scope: string
  enabled?: boolean
}) {
  const [workspace, setWorkspace] = useState<HTMLDivElement | null>(null)
  const [range, setRange] = useState<SplitRange>()
  const drag = useRef<SplitDrag | null>(null)
  const measure = (): SplitRange | undefined => {
    const master = workspace?.querySelector<HTMLElement>('[data-pane-master]')
    const handle = workspace?.querySelector<HTMLElement>(':scope > [data-panel-handle]')
    if (!workspace || !master || !handle || getComputedStyle(handle).display === 'none') return
    const em = parseFloat(getComputedStyle(document.documentElement).fontSize)
    const min = 16 * em, divider = handle.getBoundingClientRect().width
    return { value: master.getBoundingClientRect().width, min, max: Math.max(min, workspace.clientWidth - 20 * em - divider) }
  }
  useLayoutEffect(() => {
    if (!workspace) return
    drag.current = null
    if (preferred === undefined) workspace.style.removeProperty('--pane-master-width')
    else workspace.style.setProperty('--pane-master-width', `${preferred}px`)
  }, [workspace, scope, preferred, enabled])
  useLayoutEffect(() => {
    if (!workspace) return
    const update = () => {
      if (drag.current && workspace.querySelector('[data-panel-handle-dragging="true"]')) return
      const next = enabled ? measure() : undefined
      setRange(previous => previous?.value === next?.value && previous?.min === next?.min && previous?.max === next?.max ? previous : next)
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(workspace)
    return () => observer.disconnect()
  }, [workspace, scope, enabled, preferred])
  const start = () => {
    const current = measure()
    drag.current = current ? { ...current, start: current.value, commit: onCommit } : null
  }
  const resize = (delta: number) => {
    const current = drag.current
    if (!current) return
    current.value = Math.min(current.max, Math.max(current.min, current.start + delta))
    workspace?.style.setProperty('--pane-master-width', `${current.value}px`)
  }
  const end = () => {
    const current = drag.current
    drag.current = null
    if (!current) return
    current.commit(current.value)
    setRange(measure())
  }
  return {
    ref: setWorkspace,
    handleProps: {
      grow: 'right' as const, inset: false, className: 'wide-pane-split-handle pane-split-handle',
      value: range?.value, minValue: range?.min, maxValue: range?.max,
      onResizeStart: start, onResize: resize, onResizeEnd: end,
      onStep: (delta: number) => { start(); resize(delta); end() }
    }
  }
}
