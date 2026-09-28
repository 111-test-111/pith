/** Deterministic time geometry: dense records, idle turns and true overlaps. */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const temporary = await mkdtemp(join(tmpdir(), 'pith-timeline-'))
try {
  const outfile = join(temporary, 'timeline.mjs')
  await build({ entryPoints: [fileURLToPath(new URL('../src/renderer/src/lib/trajectory-timeline.ts', import.meta.url))], bundle: true, platform: 'node', format: 'esm', outfile })
  const { buildTrajectoryTimeline: layout, timelineAnchor, timelineAnchorPosition } = await import(pathToFileURL(outfile).href)
  let seq = 0
  const record = (id, kind, startedAt, finishedAt, turnId) => ({ id, kind, name: id, startedAt, finishedAt, turnId, seq: ++seq, captured: true, status: finishedAt === undefined ? 'running' : 'completed' })
  const spans = model => model.lanes.flatMap(lane => lane.spans)
  const dense = Array.from({ length: 40 }, (_, i) => record(`tool-${i}`, 'tool', 1000 + i, 1001 + i, 'first'))
  const first = [record('first', 'run', 1000, 1041), record('prompt', 'user', 1000, 1000, 'first'), ...dense]
  const later = offset => [record('second', 'run', offset, offset + 3000), record('request', 'request', offset, offset + 3000, 'second')]
  const close = layout([...first, ...later(2000)])
  const days = layout([...first, ...later(30 * 86400000)])
  assert.equal(days.width, close.width, '30 days of idle time cannot squeeze useful work or widen the axis')
  assert.equal(days.turns.length, 2)
  assert(days.turns[1].gapBefore > 29 * 86400000)
  assert.equal(days.turns[1].left - days.turns[0].width, 24, 'only a fixed separator separates turns')
  assert(!spans(days).some(span => span.record.kind === 'run'))
  assert(!days.lanes.some(lane => lane.key === 'run'))
  assert.equal(days.lanes.find(lane => lane.key === 'tool').rows, 1, 'dense sequential blocks remain one readable row')
  assert(spans(days).every(span => span.width >= 24), 'every block has a usable hit width')
  for (const lane of days.lanes) {
    for (let row = 0; row < lane.rows; row++) {
      const items = lane.spans.filter(span => span.row === row)
      for (let i = 1; i < items.length; i++) assert(items[i].left >= items[i - 1].left + items[i - 1].width + 4 - 0.001, 'blocks cannot conceal each other')
    }
  }
  const intra = layout([record('a', 'request', 0, 1000, 'same'), record('b', 'request', 11000, 12000, 'same')])
  const noIntra = layout([record('a', 'request', 0, 1000, 'same'), record('b', 'request', 1000, 2000, 'same')])
  assert(intra.width > noIntra.width + 400, 'real time within a turn is preserved')
  const parallel = layout([record('a', 'tool', 0, 5000, 'same'), record('b', 'tool', 1000, 4000, 'same')])
  assert.equal(parallel.lanes[0].rows, 2, 'parallel work has independently clickable tracks')
  const instant = layout(Array.from({ length: 80 }, (_, i) => record(`event-${i}`, 'notification', 0, undefined, 'same')))
  assert.equal(instant.lanes[0].rows, 1, 'identical millisecond point events fan out rather than forming an 80-row pile')
  assert.equal(spans(instant).length, 80)
  assert(instant.width > 80 * 24)
  // Fractional scales used to turn a touching block edge into a tiny pixel
  // overlap, move it to another row and change the overview's height.
  const stableRecords = [
    ...Array.from({ length: 30 }, (_, i) => record(`adjacent-${i}`, 'tool', 1000 + i, 1001 + i, 'same')),
    ...Array.from({ length: 30 }, (_, i) => record(`point-${i}`, 'assistant', 1000, 1000, 'same')),
    record('overlap-a', 'tool', 2000, 5000, 'same'), record('overlap-b', 'tool', 2100, 4900, 'same'),
    record('event-interval', 'compaction', 1000, 1100, 'same'), record('point-after', 'notification', 1100, 1100, 'same')
  ]
  const signature = model => model.lanes.map(lane => ({ key: lane.key, rows: lane.rows, records: lane.spans.map(span => [span.record.id, span.row]) }))
  const baseTracks = signature(layout(stableRecords))
  for (const zoom of [0.25, 0.49, 0.99, 1, 1.001, 1.03, 1.11, 1.2, 1.414, 1.99, 3.17, 7.99, 8]) {
    const model = layout(stableRecords, zoom)
    assert.deepEqual(signature(model), baseTracks, `row count and record tracks stay fixed at ${zoom}x zoom`)
    for (const lane of model.lanes) {
      for (let row = 0; row < lane.rows; row++) {
        const items = lane.spans.filter(span => span.row === row)
        for (let i = 1; i < items.length; i++) assert(items[i].left >= items[i - 1].left + items[i - 1].width - 0.001, 'stable tracks still keep hit targets separate at every scale')
      }
    }
  }
  const wait = layout([{ ...record('wait', 'request', 0, 3000, 'same'), firstTokenAt: 1000 }])
  assert(spans(wait)[0].waitingWidth > 0 && spans(wait)[0].waitingWidth < spans(wait)[0].width)
  const shortWait = layout([{ ...record('wait-short', 'request', 0, 2, 'same'), firstTokenAt: 1 }])
  assert.equal(spans(shortWait)[0].waitingWidth / spans(shortWait)[0].width, 0.5, 'minimum widths preserve the measured wait ratio')
  const filtered = layout([...dense, ...later(2000).filter(record => record.kind !== 'run')])
  assert.equal(filtered.turns.length, 2, 'turn IDs work without run or user records on a filtered page')
  const history = layout([record('u1', 'user', 0), record('a1', 'assistant', 3000), record('u2', 'user', 86400000), record('a2', 'assistant', 86403000)])
  assert.equal(history.turns.length, 2, 'old history uses user boundaries without guessing from wall gaps')
  assert.deepEqual(history.lanes.find(lane => lane.key === 'request').spans.map(span => span.record.id), ['a1', 'a2'], 'historical model output uses the request lane')
  const beforeStart = layout([record('u', 'user', 0, 0), record('run', 'run', 1, 1000), record('req', 'request', 2, 1000, 'run')])
  assert.equal(beforeStart.turns.length, 1, 'user preceding agent_start joins its turn')
  const boundary = layout([record('old', 'run', 0, 1000), record('prior', 'request', 0, 1000, 'old'), record('next-user', 'user', 1000, 1000), record('new', 'run', 1001, 2000), record('next-request', 'request', 1002, 2000, 'new')])
  assert.equal(boundary.turns[1].startedAt, 1000, 'same-millisecond user boundary cannot belong to the preceding run')
  const running = layout([record('live', 'request', 0, undefined, 'same')])
  assert.equal(spans(running)[0].waitingWidth, 0, 'unknown finish times are not invented')
  const zoomed = layout([...first, ...later(2000)], 2)
  assert(zoomed.width > close.width * 1.5)
  const anchor = timelineAnchor(close, close.turns[1].left + close.turns[1].width / 2)
  assert.equal(anchor.id, 'second')
  const resolved = timelineAnchorPosition(zoomed, anchor)
  const roundTrip = timelineAnchor(zoomed, resolved)
  assert.equal(roundTrip.from, anchor.from)
  assert.equal(roundTrip.to, anchor.to)
  assert(Math.abs(roundTrip.fraction - anchor.fraction) < 1e-8, 'zoom anchors between the same time points, excluding fixed separators')
  const mixed = [record('tiny', 'tool', 0, 1, 'same'), record('large', 'tool', 1000, 9000, 'same')]
  const atTiny = timelineAnchor(layout(mixed), 16)
  assert.equal(timelineAnchorPosition(layout(mixed, 0.5), atTiny), 16, 'a minimum-width block stays under the pointer while longer intervals shrink')
  const original = JSON.stringify(first)
  layout(first, 8)
  assert.equal(JSON.stringify(first), original, 'geometry never mutates IPC summaries')
  console.log('PASS timeline: stable tracks across 25–800% fractional zoom, 30-day idle gaps, dense intervals, simultaneous markers, parallel tracks, turn ownership/history/filtering, wait segment, anchored zoom and immutable records')
} finally {
  await rm(temporary, { recursive: true, force: true })
}
