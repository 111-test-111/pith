import assert from 'node:assert/strict'
import { writeFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { snapshot, syntheticMessages, writeWorkload, SESSION_ID, EPOCH } from './workload.mjs'

// One fresh process per sample; imports/build/input generation are outside timing.
const [repo, modulesPath, directory, turnsText] = process.argv.slice(2)
const turns = Number(turnsText)
const sdk = await import('@earendil-works/pi-coding-agent')
const { PiStore, buildTurns, collectChangeScopes, TrajectoryClient, selectedBranchHasMessages,
  TRAJECTORY_PAGE_SIZE, TRAJECTORY_CHILDREN_SIZE, TRAJECTORY_TEXT_SIZE } = await import(pathToFileURL(modulesPath).href)
const workload = await writeWorkload(directory, turns)
const metrics = {}, counts = {}, checks = []
const measure = async (name, fn) => {
  const start = performance.now(); const value = await fn(); metrics[name] = performance.now() - start; return value
}
const check = (name, actual, limit, relation = 'lte') => {
  const passed = relation === 'eq' ? actual === limit : actual <= limit
  checks.push({ name, actual, limit, relation, passed })
  assert(passed, `${name}: ${actual} ${relation} ${limit}`)
}
globalThis.gc?.()
const memoryStart = process.memoryUsage()
const manager = await measure('sessionOpenMs', () => sdk.SessionManager.open(workload.sessionPath))
const branch = await measure('selectedBranchMs', () => manager.getBranch())
const messages = await measure('displayProjectionMs', () => branch.flatMap(sdk.sessionEntryToContextMessages))
await measure('modelContextMs', () => manager.buildSessionContext())
assert.equal(await measure('sidebarTailReadMs', () => selectedBranchHasMessages(workload.sessionPath)), true)
check('restoredMessages', messages.length, turns * 5, 'eq')
const store = new PiStore()
await measure('storeSnapshotMs', () => store.applySnapshot(snapshot(messages, workload.sessionPath)))
const groups = await measure('turnGroupingMs', () => buildTurns(store.getState().messages))
const scopes = await measure('changeScopesMs', () => collectChangeScopes(groups))
check('displayTurns', groups.length, turns * 2, 'eq')
check('changeScopes', scopes.size, turns, 'eq')
// Live incremental work is measured against the whole restored history. This
// includes streamed overlays, two real tool lifecycles and committed messages.
const events = []
let seq = 0
for (const message of syntheticMessages(1)) {
  const live = structuredClone(message)
  live.timestamp += turns * 10
  if (live.role === 'assistant') {
    live.changeScopeId = 'scope-live'
    live.content.forEach(part => { if (part.type === 'toolCall') part.id += '-live' })
    events.push({ type: 'message_start', message: live }, { type: 'message_update', message: live })
  }
  if (live.role === 'toolResult') {
    live.toolCallId += '-live'
    events.push({ type: 'tool_execution_start', toolCallId: live.toolCallId, toolName: live.toolName, args: {} },
      { type: 'tool_execution_update', toolCallId: live.toolCallId, partialResult: { content: live.content } },
      { type: 'tool_execution_end', toolCallId: live.toolCallId, isError: false, result: live })
  }
  events.push({ type: 'message_end', message: live })
}
events.unshift({ type: 'agent_start', changeScopeId: 'live' }); events.push({ type: 'agent_settled' })
await measure('storeLiveTurnMs', () => {
  for (const event of events) store.dispatch({ ...event, sessionPath: workload.sessionPath, eventSequence: ++seq })
})
counts.liveEvents = events.length
check('liveMessages', store.getState().messages.length, turns * 5 + 5, 'eq')
// A late retry round exercises the store's chronological insertion path.
await measure('storeLateRoundMs', () => store.dispatch({ type: 'message_end', sessionPath: workload.sessionPath,
  eventSequence: ++seq, message: { role: 'assistant', content: [{ type: 'text', text: 'late retry' }],
    timestamp: EPOCH + 5, provider: 'benchmark', model: 'offline-fixture', stopReason: 'stop' } }))
await writeFile(join(directory, 'snapshot.json'), JSON.stringify(snapshot(messages, workload.sessionPath)))
const client = new TrajectoryClient(join(directory, 'trajectory.sqlite'))
const access = { sessionPath: workload.sessionPath, sessionId: SESSION_ID }
try {
  const first = await measure('trajectoryHistoryFirstPageMs', () => client.page(access, {}))
  check('trajectoryTotal', first.total, turns * 5, 'eq')
  check('trajectoryPageRows', first.items.length, TRAJECTORY_PAGE_SIZE)
  const last = await measure('trajectoryLatestPageMs', () => client.page(access, {}))
  check('trajectoryLatestRows', last.items.length, TRAJECTORY_PAGE_SIZE)
  if (last.older !== null) {
    const older = await measure('trajectoryOlderPageMs', () => client.page(access, { before: last.older }))
    check('trajectoryOlderRows', older.items.length, TRAJECTORY_PAGE_SIZE)
    check('trajectoryPageOverlap', older.items.filter(row => last.items.some(other => other.id === row.id)).length, 0, 'eq')
  }
  const id = `entry:${SESSION_ID}:e${String(turns * 5 - 1).padStart(8, '0')}`
  const detail = await measure('trajectoryDetailMs', () => client.detail(access, id))
  const root = detail.documents.find(doc => doc.kind === 'event').node
  const firstFields = await client.node(access, { recordId: id, trail: [root.id] })
  check('trajectoryFields', firstFields.children.length, TRAJECTORY_CHILDREN_SIZE)
  const content = firstFields.children.find(child => child.key === 'content').node
  const array = await client.node(access, { recordId: id, trail: [root.id, content.id] })
  const part = array.children[0].node
  const partFields = await client.node(access, { recordId: id, trail: [root.id, content.id, part.id] })
  const text = partFields.children.find(child => child.key === 'text').node
  const trail = [root.id, content.id, part.id, text.id]
  const fragment = await measure('trajectoryLargeFragmentMs', () => client.node(access, { recordId: id, trail }))
  check('trajectoryFragmentCodepoints', [...fragment.text].length, TRAJECTORY_TEXT_SIZE)
  assert(fragment.nextOffset !== null, 'large result must require bounded continuation')
  counts.largeNodeBytes = text.bytes
  counts.firstFragmentBytes = Buffer.byteLength(fragment.text)
  const next = await measure('trajectoryLargeNextFragmentMs', () => client.node(access, { recordId: id, trail, offset: fragment.nextOffset }))
  check('trajectoryNextFragmentCodepoints', [...next.text].length, TRAJECTORY_TEXT_SIZE)
} finally { await client.dispose() }
globalThis.gc?.()
const memoryEnd = process.memoryUsage()
counts.sessionBytes = workload.sessionBytes
counts.databaseBytes = (await stat(join(directory, 'trajectory.sqlite'))).size
await writeFile(join(directory, 'node-result.json'), JSON.stringify({ workload, metrics, counts, checks,
  memory: { start: memoryStart, endpoint: memoryEnd, rssDeltaBytes: memoryEnd.rss - memoryStart.rss,
    maxRssBytes: process.resourceUsage().maxRSS * 1024, gcRequested: typeof globalThis.gc === 'function',
    note: 'RSS includes worker/native SQLite and process overhead; endpoint after worker exit and requested GC. maxRSS is process lifetime high-water, including untimed fixture setup; neither is retained JS heap.' } }))
