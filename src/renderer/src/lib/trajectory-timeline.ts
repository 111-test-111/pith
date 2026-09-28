import { trajectoryPresentationKind, type TrajectoryRecord } from '../../../shared/trajectory'

export const TIMELINE_MIN_ZOOM = 0.25
export const TIMELINE_MAX_ZOOM = 8
const PIXELS_PER_SECOND = 48
const BLOCK_WIDTH = 24
const BLOCK_GAP = 4
const TURN_GAP = 24
const INSET = 4

export type TimelineLaneKey = 'request' | 'tool' | 'events'
export interface TimelineSpan {
  record: TrajectoryRecord
  left: number
  width: number
  waitingWidth: number
  row: number
}
export interface TimelineTurn {
  id: string
  startedAt: number
  finishedAt: number
  left: number
  width: number
  /** Wall time omitted before this turn. Never affects its horizontal size. */
  gapBefore: number
  anchors: Array<{ key: string; x: number }>
}
export interface TimelineAnchor { id: string; from: string; to: string; fraction: number }
export interface TrajectoryTimelineLayout {
  width: number
  turns: TimelineTurn[]
  lanes: Array<{ key: TimelineLaneKey; rows: number; spans: TimelineSpan[] }>
}

const laneOf = (record: TrajectoryRecord): TimelineLaneKey => trajectoryPresentationKind(record.kind) === 'request' ? 'request' : record.kind === 'tool' ? 'tool' : 'events'
const endOf = (record: TrajectoryRecord) => Math.max(record.startedAt, record.finishedAt ?? record.startedAt)

/** Recorded turn IDs survive filtering/paging. Older history has only user
 * boundaries; a partial page before its first user remains one partial turn.
 * Run summaries supply ownership only, and are never painted on the axis. */
function groupTurns(records: TrajectoryRecord[]): Array<{ id: string; items: TrajectoryRecord[] }> {
  const ordered = [...records].sort((a, b) => a.startedAt - b.startedAt || a.seq - b.seq)
  const runs = ordered.filter(record => record.kind === 'run').reverse()
  const groups = new Map<string, TrajectoryRecord[]>()
  let current = `partial:${ordered[0]?.id}`
  for (let i = 0; i < ordered.length; i++) {
    const record = ordered[i]
    if (record.kind === 'run') { current = record.id; continue }
    let id = record.turnId
    if (!id) {
      if (record.kind === 'user') {
        // A user message may precede agent_start. Bind it to the next recorded
        // turn, stopping at another user boundary (no wall-gap heuristics).
        for (const next of ordered.slice(i + 1)) {
          if (next.kind === 'user') break
          if (next.turnId || next.kind === 'run') { id = next.turnId ?? next.id; break }
        }
      }
      // Prefer ledger ownership at a user boundary: the previous turn may
      // have finished in the very same millisecond that this user was sent.
      id ??= runs.find(run => record.startedAt >= run.startedAt && record.startedAt <= endOf(run))?.id
      if (!id && record.kind === 'user') id = `user:${record.id}`
    }
    current = id ?? current
    const items = groups.get(current) ?? []
    items.push(record)
    groups.set(current, items)
  }
  return [...groups].map(([id, items]) => ({ id, items }))
    .sort((a, b) => a.items[0].startedAt - b.items[0].startedAt || a.items[0].seq - b.items[0].seq)
}

/** Vertical placement belongs to the recorded intervals, not scaled pixel
 * edges. Otherwise floating-point edges and minimum hit widths change track
 * membership during zoom, moving the overview and every pane below it. */
function recordTracks(items: TrajectoryRecord[]): Map<string, number> {
  const tracks = new Map<string, number>()
  for (const key of ['request', 'tool', 'events'] as const) {
    const previous: TrajectoryRecord[] = []
    for (const record of items.filter(record => laneOf(record) === key)) {
      const isPoint = endOf(record) === record.startedAt
      let row = previous.findIndex(prior => {
        if (endOf(prior) > record.startedAt) return false
        // Same-time points fan out horizontally. A duration starting at that
        // timestamp needs its own row so it cannot cover those point buttons.
        return isPoint || endOf(prior) !== prior.startedAt || prior.startedAt !== record.startedAt
      })
      if (row < 0) row = previous.length
      tracks.set(record.id, row)
      previous[row] = record
    }
  }
  return tracks
}

/** A shared, monotone time map for every lane of a turn. Short intervals expand
 * only enough to make their blocks clickable. Sequential blocks keep a gap;
 * true overlaps keep their times and their scale-independent track. */
function turnGeometry(items: TrajectoryRecord[], zoom: number) {
  const tracks = recordTracks(items)
  const minimum = BLOCK_WIDTH * Math.max(1, zoom)
  const gap = BLOCK_GAP * Math.max(1, zoom)
  const scale = PIXELS_PER_SECOND * zoom / 1000
  const times = [...new Set(items.flatMap(record => [record.startedAt, endOf(record)]))].sort((a, b) => a - b)
  const constraints = new Map<number, Array<{ from: number; distance: number }>>()
  const pointOffsets = new Map<string, number>()
  const constrain = (from: number, to: number, distance: number) => {
    if (to <= from) return
    const edges = constraints.get(to) ?? []
    edges.push({ from, distance }); constraints.set(to, edges)
  }
  for (const record of items) constrain(record.startedAt, endOf(record), minimum + gap)
  for (const key of ['request', 'tool', 'events'] as const) {
    const lane = items.filter(record => laneOf(record) === key)
    const points = new Map<number, TrajectoryRecord[]>()
    for (const record of lane.filter(record => endOf(record) === record.startedAt)) {
      const bucket = points.get(record.startedAt) ?? []
      bucket.push(record); points.set(record.startedAt, bucket)
    }
    // Millisecond timestamps cannot distinguish zero-duration events. Fan
    // those markers out in ledger order instead of building an 80-row pile.
    for (const [time, bucket] of points) {
      bucket.forEach((record, index) => pointOffsets.set(record.id, index * (minimum + gap)))
      const next = times[times.indexOf(time) + 1]
      if (next !== undefined) constrain(time, next, bucket.length * (minimum + gap))
    }
    for (let i = 0; i < lane.length; i++) {
      for (const previous of lane.slice(0, i)) {
        if (endOf(previous) <= lane[i].startedAt) constrain(previous.startedAt, lane[i].startedAt, minimum + gap)
      }
    }
  }
  const positions = new Map<number, number>()
  for (let i = 0; i < times.length; i++) {
    const time = times[i]
    let x = i ? positions.get(times[i - 1])! + (time - times[i - 1]) * scale : 0
    for (const edge of constraints.get(time) ?? []) x = Math.max(x, positions.get(edge.from)! + edge.distance)
    positions.set(time, x)
  }
  const spans = items.map(record => {
    const left = INSET + positions.get(record.startedAt)! + (pointOffsets.get(record.id) ?? 0)
    const width = Math.max(minimum, positions.get(endOf(record))! - positions.get(record.startedAt)! - gap)
    // A minimum hit width must not erase a sub-second wait segment. Preserve
    // the measured ratio inside each request, including expanded short blocks.
    const waitingWidth = record.kind !== 'request' || record.firstTokenAt === undefined || record.finishedAt === undefined ? 0
      : width * Math.max(0, Math.min(1, (record.firstTokenAt - record.startedAt) / Math.max(1, endOf(record) - record.startedAt)))
    return { record, left, width, waitingWidth, row: tracks.get(record.id)! }
  })
  const width = Math.max(80, INSET + positions.get(times.at(-1)!)! + INSET, ...spans.map(span => span.left + span.width + INSET))
  const anchors = [{ key: 'leading', x: 0 }, ...times.map(time => ({ key: String(time), x: INSET + positions.get(time)! })), { key: 'trailing', x: width }]
  return { spans, width, anchors }
}

export function buildTrajectoryTimeline(records: TrajectoryRecord[], zoom = 1): TrajectoryTimelineLayout {
  zoom = Math.min(TIMELINE_MAX_ZOOM, Math.max(TIMELINE_MIN_ZOOM, zoom))
  const turns: TimelineTurn[] = []
  const spans: TimelineSpan[] = []
  let left = 0
  for (const group of groupTurns(records)) {
    const geometry = turnGeometry(group.items, zoom)
    const startedAt = Math.min(...group.items.map(record => record.startedAt))
    const finishedAt = Math.max(...group.items.map(endOf))
    const previous = turns.at(-1)
    if (previous) left += TURN_GAP
    turns.push({ id: group.id, left, width: geometry.width, startedAt, finishedAt,
      gapBefore: previous ? Math.max(0, startedAt - previous.finishedAt) : 0, anchors: geometry.anchors })
    spans.push(...geometry.spans.map(span => ({ ...span, left: span.left + left })))
    left += geometry.width
  }
  const lanes = (['request', 'tool', 'events'] as const).map(key => {
    const items = spans.filter(span => laneOf(span.record) === key).sort((a, b) => a.left - b.left || a.record.seq - b.record.seq)
    return { key, rows: items.length ? Math.max(...items.map(span => span.row)) + 1 : 0, spans: items }
  }).filter(lane => lane.spans.length)
  return { width: left, turns, lanes }
}

/** Preserve the pointer's position within its turn while changing scale. Turn
 * separators stay fixed-width, so scaling the whole page would drift badly. */
export function timelineAnchor(layout: TrajectoryTimelineLayout, x: number): TimelineAnchor | null {
  const turn = layout.turns.find(turn => x < turn.left + turn.width) ?? layout.turns.at(-1)
  if (!turn) return null
  const local = Math.max(0, Math.min(turn.width, x - turn.left))
  const after = turn.anchors.findIndex(point => point.x > local)
  const to = turn.anchors[after < 0 ? turn.anchors.length - 1 : after]
  const from = turn.anchors[after < 0 ? turn.anchors.length - 2 : Math.max(0, after - 1)]
  return { id: turn.id, from: from.key, to: to.key, fraction: to.x === from.x ? 0 : (local - from.x) / (to.x - from.x) }
}
export function timelineAnchorPosition(layout: TrajectoryTimelineLayout, anchor: TimelineAnchor) {
  const turn = layout.turns.find(turn => turn.id === anchor.id)
  const from = turn?.anchors.find(point => point.key === anchor.from)
  const to = turn?.anchors.find(point => point.key === anchor.to)
  return turn && from && to ? turn.left + from.x + (to.x - from.x) * anchor.fraction : null
}
