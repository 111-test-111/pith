import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/motion/button'
import { ZoomIn, ZoomOut } from '@/lib/icons'
import { useScrollFade } from '@/lib/hooks/use-scroll-fade'
import { buildTrajectoryTimeline, timelineAnchor, timelineAnchorPosition, TIMELINE_MIN_ZOOM, TIMELINE_MAX_ZOOM } from '@/lib/trajectory-timeline'
import type { TimelineAnchor } from '@/lib/trajectory-timeline'
import { createWheelGesture, wheelPixels } from '@/lib/wheel-gesture'
import { useI18n } from '@/i18n'
import { trajectoryPresentationKind, type TrajectoryRecord } from '../../../../shared/trajectory'
import { LabelTooltip } from './LabelTooltip'

const duration = (ms: number) => `${(Math.max(0, ms) / 1000).toFixed(2)} s`

export function TrajectoryTimeline({ records, selectedId, onSelect }: { records: TrajectoryRecord[]; selectedId?: string; onSelect(record: TrajectoryRecord): void }) {
  const { t, locale } = useI18n()
  const [zoom, setZoom] = useState(1)
  const layout = useMemo(() => buildTrajectoryTimeline(records, zoom), [records, zoom])
  const viewportRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const pendingAnchor = useRef<(TimelineAnchor & { offset: number }) | null>(null)
  const current = useRef({ layout, zoom })
  current.current = { layout, zoom }
  const { maskImage } = useScrollFade(viewportRef, { axis: 'horizontal', contentRef, dependsOn: layout })
  const changeZoom = (next: number, offset?: number) => {
    const viewport = viewportRef.current
    if (!viewport) return
    next = Math.min(TIMELINE_MAX_ZOOM, Math.max(TIMELINE_MIN_ZOOM, next))
    if (next === current.current.zoom) return
    // Pointer coordinates include the scrollport's focus-ring padding, while
    // the time map starts at the content origin inside that padding.
    const anchorOffset = (offset ?? viewport.clientWidth / 2) - parseFloat(getComputedStyle(viewport).paddingLeft)
    const anchor = timelineAnchor(current.current.layout, viewport.scrollLeft + anchorOffset)
    pendingAnchor.current = anchor ? { ...anchor, offset: anchorOffset } : null
    setZoom(next)
  }
  const zoomHandler = useRef(changeZoom)
  zoomHandler.current = changeZoom
  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const gesture = createWheelGesture((_input, axis) => axis === 'x' ? 'pan' : 'zoom')
    const wheel = (event: WheelEvent) => {
      event.preventDefault()
      const input = gesture.read(wheelPixels(event, viewport))
      if (!input) return
      if (input.mode === 'pan') {
        viewport.scrollLeft += input.deltaX
      } else if (input.deltaY) {
        const offset = Math.max(0, Math.min(viewport.clientWidth, event.clientX - viewport.getBoundingClientRect().left))
        zoomHandler.current(current.current.zoom * Math.exp(-input.deltaY * 0.003), offset)
      }
    }
    // React's root wheel listener is passive. This canvas owns vertical wheel
    // zoom and horizontal pan without scrolling the ledger or covered chat.
    viewport.addEventListener('wheel', wheel, { passive: false })
    return () => viewport.removeEventListener('wheel', wheel)
  }, [layout.lanes.length > 0])
  useLayoutEffect(() => {
    const anchor = pendingAnchor.current
    if (!anchor || !viewportRef.current) return
    const x = timelineAnchorPosition(layout, anchor)
    if (x !== null) viewportRef.current.scrollLeft = x - anchor.offset
    pendingAnchor.current = null
  }, [layout])
  useLayoutEffect(() => {
    const viewport = viewportRef.current
    const span = layout.lanes.flatMap(lane => lane.spans).find(span => span.record.id === selectedId)
    if (!viewport || !span) return
    const edge = 4 + parseFloat(getComputedStyle(viewport).paddingLeft)
    if (span.left < viewport.scrollLeft + 4) viewport.scrollLeft = span.left - 4
    else if (span.left + Math.min(span.width, viewport.clientWidth - edge * 2) > viewport.scrollLeft + viewport.clientWidth - edge) {
      viewport.scrollLeft = span.left + Math.min(span.width, viewport.clientWidth - edge * 2) - viewport.clientWidth + edge
    }
    // Selection reveals the block, while a subsequent zoom/pan stays where
    // the user put it. Do not keep dragging the viewport back to selection.
  }, [selectedId, records])
  if (!layout.lanes.length) return null
  const kindLabel = (record: TrajectoryRecord) => record.kind === 'user' ? t('trajectory.kind.user') : record.kind === 'assistant'
    ? `${t('trajectory.kind.request')}${record.model ? ` · ${record.model}` : ''}` : `${t(`trajectory.kind.${trajectoryPresentationKind(record.kind)}`)} · ${record.name}`
  const laneLabel = (key: 'request' | 'tool' | 'events') => key === 'events' ? t('trajectory.events') : t(`trajectory.kind.${key}`)
  const clock = (time: number) => new Date(time).toLocaleTimeString(locale, { hour12: false })
  const gapDuration = (ms: number) => {
    const unit = ms >= 86400000 ? 'day' : ms >= 3600000 ? 'hour' : ms >= 60000 ? 'minute' : 'second'
    const divisor = unit === 'day' ? 86400000 : unit === 'hour' ? 3600000 : unit === 'minute' ? 60000 : 1000
    return new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: 'short', maximumFractionDigits: 1 }).format(ms / divisor)
  }
  return <div data-trajectory-timing className="min-w-0 shrink-0 border-b border-border px-3 py-2">
    <div className="mb-1 flex flex-wrap items-center gap-x-4 gap-y-1">
      <p className="text-xs text-muted-foreground">{t('trajectory.overview')}</p>
      <div data-trajectory-legend className="flex flex-wrap gap-x-3 gap-y-1">
        {[...new Set(records.filter(record => record.kind !== 'run').map(record => trajectoryPresentationKind(record.kind)))].map(kind =>
          <span key={kind} className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span aria-hidden="true" data-trajectory-kind={kind} className="trajectory-tone trajectory-legend-dot size-2 shrink-0 rounded-full" />
            {t(`trajectory.kind.${kind}`)}
          </span>)}
      </div>
      <div className="ml-auto flex items-center gap-0.5">
        <Button data-trajectory-zoom-out variant="ghost" size="icon" className="size-6" disabled={zoom <= TIMELINE_MIN_ZOOM} title={t('trajectory.zoomOut')} aria-label={t('trajectory.zoomOut')} onClick={() => changeZoom(zoom / 1.25)}><ZoomOut className="size-3.5" /></Button>
        <Button data-trajectory-zoom-reset variant="ghost" size="sm" className="h-6 min-w-12 px-1 tabular-nums" title={t('trajectory.zoomReset')} aria-label={t('trajectory.zoomReset')} onClick={() => changeZoom(1)}>{new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }).format(zoom)}</Button>
        <Button data-trajectory-zoom-in variant="ghost" size="icon" className="size-6" disabled={zoom >= TIMELINE_MAX_ZOOM} title={t('trajectory.zoomIn')} aria-label={t('trajectory.zoomIn')} onClick={() => changeZoom(zoom * 1.25)}><ZoomIn className="size-3.5" /></Button>
      </div>
    </div>
    <div className="flex min-w-0 gap-2">
      <div aria-hidden="true" className="w-20 shrink-0 pt-6">
        {layout.lanes.map(lane => <div key={lane.key} data-trajectory-lane-label={lane.key} className="flex items-center text-xs text-muted-foreground" style={{ height: lane.rows * 28 }}>
          <span className="truncate" title={laneLabel(lane.key)}>{laneLabel(lane.key)}</span>
        </div>)}
      </div>
      <div ref={viewportRef} data-trajectory-axis data-trajectory-zoom={zoom} tabIndex={0} role="region" aria-label={t('trajectory.timeline')}
        className="min-w-0 flex-1 overflow-x-auto overflow-y-hidden overscroll-x-contain p-1 outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
        style={{ maskImage }} onKeyDown={event => {
          if (event.target !== event.currentTarget) return
          if (event.key === '+' || event.key === '=') { event.preventDefault(); changeZoom(zoom * 1.25) }
          else if (event.key === '-') { event.preventDefault(); changeZoom(zoom / 1.25) }
          else if (event.key === '0') { event.preventDefault(); changeZoom(1) }
          else if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
            event.preventDefault()
            event.currentTarget.scrollLeft = event.key === 'Home' ? 0 : event.key === 'End' ? event.currentTarget.scrollWidth : event.currentTarget.scrollLeft + (event.key === 'ArrowLeft' ? -80 : 80)
          }
        }}>
        <div ref={contentRef} className="relative" style={{ width: layout.width, minWidth: '100%' }}>
          <div className="relative h-5 text-[10px] tabular-nums text-muted-foreground">
            {layout.turns.map(turn => <span key={turn.id} data-trajectory-turn={turn.id} className="absolute truncate px-1" style={{ left: turn.left, width: turn.width }} title={t('trajectory.turnStart', { time: new Date(turn.startedAt).toLocaleString(locale) })}>{clock(turn.startedAt)}</span>)}
          </div>
          {layout.turns.slice(1).map(turn => <div key={turn.id} data-trajectory-separator data-trajectory-gap={turn.gapBefore} className="absolute inset-y-0 border-l border-dashed border-border" style={{ left: turn.left - 12 }} role="separator" aria-orientation="vertical"
            title={turn.gapBefore ? t('trajectory.turnGap', { duration: gapDuration(turn.gapBefore) }) : t('trajectory.turnBoundary')} aria-label={turn.gapBefore ? t('trajectory.turnGap', { duration: gapDuration(turn.gapBefore) }) : t('trajectory.turnBoundary')} />)}
          {layout.lanes.map(lane => <div key={lane.key} data-trajectory-lane={lane.key} className="relative" style={{ height: lane.rows * 28 }}>
            {lane.spans.map(span => {
              const record = span.record
              const label = t('trajectory.span', { name: kindLabel(record), time: new Date(record.startedAt).toLocaleString(locale), duration: record.finishedAt === undefined ? t(`trajectory.status.${record.status}`) : duration(record.finishedAt - record.startedAt) })
              return <div key={record.id} className="absolute h-6" style={{ left: span.left, top: span.row * 28, width: span.width }}>
                <LabelTooltip content={label} wrap wrapperClassName="h-full w-full">
                  <Button data-trajectory-span={record.id} data-trajectory-kind={trajectoryPresentationKind(record.kind)} variant="ghost" size="sm" className="trajectory-tone trajectory-span h-6 w-full overflow-hidden rounded-inner p-0"
                    aria-label={label} aria-pressed={selectedId === record.id} onClick={() => onSelect(record)}>
                    {span.waitingWidth > 0 ? <span aria-hidden="true" className="trajectory-wait absolute inset-y-0 left-0 transition-colors" style={{ width: span.waitingWidth }} /> : null}
                  </Button>
                </LabelTooltip>
              </div>
            })}
          </div>)}
        </div>
      </div>
    </div>
  </div>
}
