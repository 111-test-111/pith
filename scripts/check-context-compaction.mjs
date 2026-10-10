/** Real SDK: requested compaction waits for persisted tool batches, preserves
 * continuation/steering and stays owned by the requested session. Offline. */
import assert from 'node:assert/strict'
import { Type } from 'typebox'
import { copyFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { createPlanFixture } from './lib/plan-fixture.mjs'

const deferred = () => {
  let resolve
  return { promise: new Promise(done => { resolve = done }), resolve: value => resolve(value) }
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const until = async predicate => {
  const deadline = Date.now() + 10000
  while (!predicate()) { assert(Date.now() < deadline, 'compaction fixture timed out'); await delay(10) }
}
const gates = new Map(), entered = new Set()
let holdSummary = null
const f = await createPlanFixture({ keepRecentTokens: 1, extensionFactories: [api => {
  api.registerTool({
    name: 'compaction_gate', label: 'Compaction gate', description: 'Wait for an offline test barrier.',
    parameters: Type.Object({ slot: Type.String() }),
    execute: async (_id, { slot }) => {
      entered.add(slot)
      await gates.get(slot)?.promise
      return { content: [{ type: 'text', text: `Finished gate ${slot}` }], details: {} }
    }
  })
  api.on('session_before_compact', async () => { if (holdSummary) await holdSummary.promise })
}] })
const tool = slot => ({ type: 'toolCall', id: `gate-${slot}`, name: 'compaction_gate', arguments: { slot } })
const summaries = () => f.events.filter(event => event.type === 'compaction_start' && event.reason === 'manual')
const queueUpdates = () => f.events.filter(event => event.type === 'compaction_queue_update')
const queued = () => queueUpdates().filter(event => event.compactionQueue.queued)
const rejected = promise => promise.then(() => null, error => error)
const branchResults = () => f.manager.getBranch().filter(entry => entry.type === 'message' && entry.message.role === 'toolResult')

try {
  await f.managed.lifecyclePromise
  f.session.setActiveToolsByName([...f.session.getActiveToolNames(), 'compaction_gate'])
  await f.session.prompt('First history to summarize. '.repeat(30))
  await f.session.prompt('Second history to summarize. '.repeat(30))
  const userCount = () => f.app.snapshot().messages.filter(message => message.role === 'user').length
  const historyUsers = userCount()
  const assistantCount = () => f.manager.getBranch().filter(entry => entry.type === 'message' && entry.message.role === 'assistant').length
  const historyAssistants = assistantCount()
  const start = f.requests.length + 1
  f.setRespond(n => n === start ? [tool('a'), tool('b')] : [{ type: 'text', text: n === start + 1 ? 'Boundary summary.' : 'Continued after the tools.' }])
  f.session.agent.toolExecution = 'sequential'
  gates.set('a', deferred()); gates.set('b', deferred())
  const running = f.session.prompt('Run both tools and then finish.')
  await until(() => entered.has('a'))
  const request = f.app.compactSession(f.managed.path)
  const duplicate = f.app.compactSession(f.managed.path)
  assert.equal(queued().length, 1, 'repeated clicks acknowledge one request')
  assert.equal(queued()[0].eventSequence, undefined, 'queue acknowledgement is metadata')
  const waitingSnapshot = f.app.snapshot()
  assert.equal(waitingSnapshot.compactionQueue.queued, true, 'snapshots carry the pending action')
  assert.equal(f.store.getShell().compactionQueue.queued, true, 'the composer shell receives pending metadata')
  assert.equal(summaries().length, 0, 'an executing tool must not be interrupted for compaction')
  gates.get('a').resolve()
  await until(() => entered.has('b'))
  assert.equal(summaries().length, 0, 'do not compact between calls in the same assistant batch')
  const onSummary = f.session.subscribe(event => {
    if (event.type === 'compaction_start') {
      assert.deepEqual(branchResults().map(entry => entry.message.toolCallId), ['gate-a', 'gate-b'])
      assert.equal(f.session.isStreaming, true, 'compaction does not end the run')
      assert.equal(f.store.getShell().compactionQueue.queued, false, 'starting execution clears the queued action')
    }
  })
  gates.get('b').resolve()
  const [snapshot] = await Promise.all([request, duplicate, running])
  onSummary()
  assert.equal(summaries().length, 1)
  assert.equal(assistantCount(), historyAssistants + 2, 'the tool response and ordinary continuation are the only new assistant messages')
  assert(JSON.stringify(f.requests.at(-1).messages).includes('Boundary summary.'))
  assert.equal(userCount(), historyUsers + 1, 'manual compaction adds no user prompt')
  assert(snapshot.messages.some(message => message.role === 'compactionSummary'))
  assert(branchResults().every(entry => !entry.message.isError), 'both calls complete normally')
  assert.equal(f.store.getShell().isStreaming, false)
  assert.equal(snapshot.compactionQueue.queued, false)
  assert.equal(queueUpdates().length, 2, 'one admission and one clear, even for duplicate clicks')
  assert(queueUpdates().every(event => event.eventSequence === undefined))
  const summary = snapshot.messages.find(message => message.role === 'compactionSummary')
  const process = summary.process
  assert.equal(process.status, 'success', 'the saved summary carries its completed process')
  assert.equal(process.reason, 'manual')
  assert(process.range.summarizedMessages > 0 && process.range.keptMessages > 0)
  assert.equal(process.range.splitTurn, true, 'the real SDK cut splits the current turn')
  assert.equal(process.requestCount, 2, 'history and the turn prefix have separate actual requests')
  assert.equal(process.requests.length, 2)
  assert(process.requests.every(request => request.status === 'success' && request.model === 'fixture' && request.endedAt >= request.startedAt))
  assert.equal(process.requests.reduce((sum, request) => sum + request.inputTokens, 0), 2)
  assert.equal(process.requests.reduce((sum, request) => sum + request.outputTokens, 0), 2)
  assert(process.tokensBefore > 0 && process.tokensAfter > 0 && process.endedAt >= process.startedAt)
  const processUpdates = f.events.filter(event => event.type === 'compaction_process_update')
  assert(processUpdates.every(event => event.eventSequence === undefined), 'process metadata never changes the transcript sequence')
  assert(processUpdates.every((event, index) => index === 0 || event.compactionProcess.revision > processUpdates[index - 1].compactionProcess.revision))
  const persisted = f.manager.getBranch().find(entry => entry.type === 'custom' && entry.customType === 'pi-app:compaction-process')
  assert.equal(persisted.data.entryId, summary.sessionEntryId)
  assert.equal(JSON.stringify(persisted.data).includes('First history to summarize.'), false, 'the receipt contains statistics, not a duplicate transcript')
  const coldPath = join(f.temporary, 'cold-compaction.jsonl')
  await copyFile(f.managed.path, coldPath)
  const coldSummary = f.app.peekSession(coldPath).messages.find(message => message.role === 'compactionSummary')
  assert.deepEqual(coldSummary.process, process, 'a disk-only transcript recovers the process by compaction entry identity')
  assert.equal(JSON.parse((await readFile(coldPath, 'utf8')).trim().split('\n').at(-1)).type, 'custom', 'durable metadata stays outside model messages')
  assert(!f.session.messages.some(message => message.customType === 'pi-app:compaction-process'))
  const runningProcess = processUpdates.find(event => event.compactionProcess.process?.status === 'running')
  const completedProcess = processUpdates.find(event => event.compactionProcess.process?.status === 'success')
  const processStore = new f.store.constructor()
  processStore.dispatch(completedProcess)
  processStore.applySnapshot({ ...waitingSnapshot, compactionProcess: runningProcess.compactionProcess })
  processStore.dispatch(runningProcess)
  assert.equal(processStore.getState().compactionProcess.process.status, 'success', 'stale metadata cannot revive a completed process')
  processStore.applySnapshot({ ...waitingSnapshot, sessionPath: '/fixture/another-process' })
  processStore.dispatch(completedProcess)
  assert.equal(processStore.getState().compactionProcess.process, null, 'background process data stays with its owning session')
  processStore.activateCachedSession(waitingSnapshot.sessionPath)
  assert.equal(processStore.getState().compactionProcess.process.id, process.id)
  console.log('PASS: actual split-summary requests, bounded statistics, disk recovery and independent metadata revisions reach the transcript.')
  console.log('PASS: duplicate requests compact once after every tool result persists, then continue from the summary without an extra user turn.')

  // A queue update may overtake an IPC snapshot and can arrive while another
  // chat is visible. Neither stale snapshots nor stale events revive it.
  const cleared = queueUpdates().at(-1), admitted = queued()[0]
  const coldStore = new f.store.constructor()
  coldStore.applySnapshot(waitingSnapshot)
  assert.equal(coldStore.getShell().compactionQueue.queued, true, 'snapshot alone restores a pending action')
  coldStore.clearQueue()
  assert.equal(coldStore.getShell().compactionQueue.queued, true, 'message recall does not consume the action')
  coldStore.applySnapshot({ ...waitingSnapshot, sessionPath: '/fixture/other', compactionQueue: { queued: false, revision: 0 } })
  const otherSequence = coldStore.getState().eventSequence
  coldStore.dispatch(cleared)
  assert.equal(coldStore.getState().eventSequence, otherSequence, 'background queue metadata has no transcript revision')
  assert.equal(coldStore.getShell().compactionQueue.queued, false, 'background actions do not appear in the visible chat')
  coldStore.activateCachedSession(waitingSnapshot.sessionPath)
  assert.equal(coldStore.getShell().compactionQueue.queued, false, 'cached navigation uses the latest clear')
  coldStore.applySnapshot(waitingSnapshot)
  coldStore.dispatch(admitted)
  assert.equal(coldStore.getShell().compactionQueue.queued, false, 'stale snapshot/event cannot revive the action')
  const overtakenStore = new f.store.constructor()
  overtakenStore.dispatch(cleared)
  overtakenStore.applySnapshot(waitingSnapshot)
  assert.equal(overtakenStore.getShell().compactionQueue.queued, false, 'an event before the first snapshot is retained')
  console.log('PASS: queue snapshots, recall, background navigation and independent revisions preserve pending-action ownership.')

  // Steering queued while summary generation is waiting still reaches the
  // ordinary next request. It must not be drained, cleared or re-prompted.
  const beforeSteer = f.requests.length
  gates.set('steer', deferred())
  f.setRespond(n => n === beforeSteer + 1 ? [tool('steer')] : [{ type: 'text', text: 'Steering summary and answer.' }])
  const steeringRun = f.session.prompt('Inspect before accepting steering.')
  await until(() => entered.has('steer'))
  holdSummary = deferred()
  const steeringCompact = f.app.compactSession(f.managed.path)
  gates.get('steer').resolve()
  await until(() => summaries().length === 2)
  await f.session.steer('Keep this queued instruction intact.')
  holdSummary.resolve(); holdSummary = null
  await Promise.all([steeringCompact, steeringRun])
  assert(JSON.stringify(f.requests.at(-1).messages).includes('Keep this queued instruction intact.'))
  assert.equal(f.session.pendingMessageCount, 0)
  console.log('PASS: steering sent during summary generation reaches the next model request.')

  // A final text-only response also supplies a complete boundary.
  const baseStream = f.session.agent.streamFunction
  const textGate = deferred(), textStarted = deferred()
  let held = false
  f.setRespond(() => [{ type: 'text', text: 'Final reply or its summary.' }])
  f.session.agent.streamFunction = (model, context, options) => {
    const innerPromise = Promise.resolve(baseStream(model, context, options))
    const wait = !held
    held = true
    return {
      async *[Symbol.asyncIterator]() {
        if (wait) { textStarted.resolve(); await textGate.promise }
        yield* await innerPromise
      }, result: async () => (await innerPromise).result()
    }
  }
  const finalRun = f.session.prompt('Reply directly without any tools.')
  await textStarted.promise
  const finalCompact = f.app.compactSession(f.managed.path)
  const beforeFinal = assistantCount()
  textGate.resolve()
  await Promise.all([finalCompact, finalRun])
  f.session.agent.streamFunction = baseStream
  assert.equal(assistantCount(), beforeFinal + 1, 'final reply compacts without starting another assistant response')
  assert.equal(summaries().length, 3)
  console.log('PASS: a queued request also compacts after a final reply without waking a new turn.')

  // Stop cancels an unstarted request; it cannot survive onto a later turn.
  const beforeStop = f.requests.length, compactCount = summaries().length
  gates.set('stop', deferred())
  f.setRespond(n => n === beforeStop + 1 ? [tool('stop')] : [{ type: 'text', text: 'Stopped or resumed.' }])
  const stoppedRun = f.session.prompt('Wait until the user stops.')
  await until(() => entered.has('stop'))
  const cancelled = rejected(f.app.compactSession(f.managed.path))
  f.app.abort()
  assert.match(String(await cancelled), /cancelled/)
  assert.equal(f.store.getShell().compactionQueue.queued, false, 'Stop clears the pending notice')
  gates.get('stop').resolve()
  await stoppedRun
  assert.equal(summaries().length, compactCount)
  f.setRespond(() => [{ type: 'text', text: 'A fresh turn.' }])
  await f.session.prompt('Resume without the cancelled compaction.')
  assert.equal(summaries().length, compactCount)
  console.log('PASS: Stop cancels the pending request and a later turn does not replay it.')

  // Stop during summary generation aborts the summary, without committing it.
  const beforeSummaryStop = f.requests.length
  const savedCompactions = f.manager.getBranch().filter(entry => entry.type === 'compaction').length
  gates.set('summary-stop', deferred())
  f.setRespond(n => n === beforeSummaryStop + 1 ? [tool('summary-stop')] : [{ type: 'text', text: 'Should not commit this summary.' }])
  const summaryRun = f.session.prompt('Wait while the context is summarized.')
  await until(() => entered.has('summary-stop'))
  holdSummary = deferred()
  const abortedSummary = rejected(f.app.compactSession(f.managed.path))
  gates.get('summary-stop').resolve()
  await until(() => summaries().length === compactCount + 1)
  f.app.abort()
  holdSummary.resolve(); holdSummary = null
  assert(await abortedSummary)
  await summaryRun
  assert.equal(f.manager.getBranch().filter(entry => entry.type === 'compaction').length, savedCompactions)
  assert(f.events.some(event => event.type === 'compaction_end' && event.reason === 'manual' && event.aborted))
  assert.equal(f.store.getState().compactionProcess.process.status, 'cancelled', 'Stop settles the visualized process')
  assert.equal(f.store.getState().compactionProcess.process.tokensAfter, undefined, 'cancelled summaries do not report an applied context')
  console.log('PASS: Stop during compaction aborts it without appending a summary.')

  // Navigation never retargets the request or its completion snapshot.
  const ownerPath = f.managed.path
  const beforeNavigation = f.requests.length
  gates.set('navigation', deferred())
  f.setRespond(n => n === beforeNavigation + 1 ? [tool('navigation')] : [{ type: 'text', text: 'Summary for the original session.' }])
  const navigationRun = f.session.prompt('Keep working while another chat is visible.')
  await until(() => entered.has('navigation'))
  const navigationCompact = f.app.compactSession(ownerPath)
  const other = await f.app.buildSession(SessionManager.create(f.project))
  await other.lifecyclePromise
  f.app.activateSession(other)
  gates.get('navigation').resolve()
  const [originalSnapshot] = await Promise.all([navigationCompact, navigationRun])
  assert.equal(originalSnapshot.sessionPath, ownerPath)
  assert.equal(f.app.snapshot().sessionPath, other.path)
  assert.equal(other.session.messages.length, 0)
  f.app.activateSession(f.managed)
  console.log('PASS: changing the visible session preserves the original compaction owner.')

  // Too-small live sessions still fail at admission, with no queued/start row.
  f.session.settingsManager.applyOverrides({ compaction: { enabled: false, keepRecentTokens: 1_000_000 } })
  const beforeSmall = f.requests.length, beforeSmallQueued = queued().length, beforeSmallSummary = summaries().length
  gates.set('small', deferred())
  f.setRespond(n => n === beforeSmall + 1 ? [tool('small')] : [{ type: 'text', text: 'No summary needed.' }])
  const smallRun = f.session.prompt('Try summarizing a small running session.')
  await until(() => entered.has('small'))
  await assert.rejects(f.app.compactSession(ownerPath), /Nothing to compact \(session too small\)/)
  assert.equal(queued().length, beforeSmallQueued)
  assert.equal(summaries().length, beforeSmallSummary)
  assert.equal(f.store.getShell().compactionQueue.queued, false, 'too-small admission cannot display a pending action')
  gates.get('small').resolve()
  await smallRun
  console.log('PASS: session-too-small refuses immediately while running, without queue acknowledgement or compaction events.')

  f.session.settingsManager.applyOverrides({ compaction: { enabled: false, keepRecentTokens: 1 } })
  // A failed model response gets its normal SDK recovery/settlement first.
  const errorGate = deferred(), errorStarted = deferred()
  let failOnce = true
  f.setRespond(() => [{ type: 'text', text: 'Summary after the failed response.' }])
  f.session.agent.streamFunction = async (model, context, options) => {
    const inner = await baseStream(model, context, options)
    if (!failOnce) return inner
    failOnce = false
    const message = await inner.result()
    message.stopReason = 'error'; message.errorMessage = 'Fixture model failure'
    return {
      async *[Symbol.asyncIterator]() {
        errorStarted.resolve(); await errorGate.promise
        yield { type: 'error', error: message }
      }, result: async () => message
    }
  }
  const erroredRun = f.session.prompt('Handle a failed response without disturbing recovery.')
  await errorStarted.promise
  const errorCompact = f.app.compactSession(ownerPath)
  const errorEventStart = f.events.length
  errorGate.resolve()
  await Promise.all([erroredRun, errorCompact])
  f.session.agent.streamFunction = baseStream
  const errorEvents = f.events.slice(errorEventStart)
  assert(errorEvents.findIndex(event => event.type === 'agent_settled') < errorEvents.findIndex(event => event.type === 'compaction_start'))
  console.log('PASS: failed responses settle before the pending manual summary, preserving SDK recovery priority.')

  // A summary failure must not fail the enclosing tool run or drop its next response.
  const beforeFailure = f.requests.length, assistantsBeforeFailure = assistantCount()
  gates.set('summary-failure', deferred())
  f.setRespond(n => n === beforeFailure + 1 ? [tool('summary-failure')] : [{ type: 'text', text: 'Continue despite summary failure.' }])
  f.session.agent.streamFunction = async (model, context, options) => {
    const inner = await baseStream(model, context, options)
    if (!f.session.isCompacting) return inner
    const message = await inner.result()
    message.stopReason = 'error'; message.errorMessage = 'Fixture summary failure'
    return { async *[Symbol.asyncIterator]() { yield { type: 'error', error: message } }, result: async () => message }
  }
  const failedSummaryRun = f.session.prompt('Complete the work even if the requested summary fails.')
  await until(() => entered.has('summary-failure'))
  const failedSummary = rejected(f.app.compactSession(ownerPath))
  gates.get('summary-failure').resolve()
  assert.match(String(await failedSummary), /Fixture summary failure/)
  assert.equal(f.store.getShell().compactionQueue.queued, false, 'failed summaries leave no pending notice')
  await failedSummaryRun
  f.session.agent.streamFunction = baseStream
  assert.equal(assistantCount(), assistantsBeforeFailure + 2)
  assert(f.events.some(event => event.type === 'compaction_end' && event.errorMessage?.includes('Fixture summary failure')))
  assert(f.events.some(event => event.type === 'compaction_process_update' && event.compactionProcess.process?.status === 'error'), 'the failed process retains its outcome before continuation starts')
  console.log('PASS: a failed summary reports its error while the original tool run continues normally.')

  // Re-check eligibility after admission without painting a false summary row.
  const beforeRecheck = f.requests.length, summariesBeforeRecheck = summaries().length
  gates.set('recheck', deferred())
  f.setRespond(n => n === beforeRecheck + 1 ? [tool('recheck')] : [{ type: 'text', text: 'No summary after recheck.' }])
  const recheckRun = f.session.prompt('Recheck compaction eligibility at the boundary.')
  await until(() => entered.has('recheck'))
  const rechecked = rejected(f.app.compactSession(ownerPath))
  f.session.settingsManager.applyOverrides({ compaction: { enabled: false, keepRecentTokens: 1_000_000 } })
  gates.get('recheck').resolve()
  assert.match(String(await rechecked), /Nothing to compact \(session too small\)/)
  await recheckRun
  assert.equal(summaries().length, summariesBeforeRecheck)
  assert.equal(f.app.snapshot().compactionQueue.queued, false, 'boundary rejection also clears snapshot state')
  console.log('PASS: boundary eligibility is rechecked before any compaction execution event.')

  // Disposal settles the waiting IPC and cannot restart the disposed session.
  f.session.settingsManager.applyOverrides({ compaction: { enabled: false, keepRecentTokens: 1 } })
  const beforeDispose = f.requests.length, summariesBeforeDispose = summaries().length
  gates.set('dispose', deferred())
  f.setRespond(n => n === beforeDispose + 1 ? [tool('dispose')] : [{ type: 'text', text: 'Disposed.' }])
  const disposingRun = f.session.prompt('Dispose before the requested summary starts.')
  await until(() => entered.has('dispose'))
  const disposedRequest = rejected(f.app.compactSession(ownerPath))
  const disposal = f.app.disposeManaged(f.managed)
  assert.match(String(await disposedRequest), /cancelled/)
  gates.get('dispose').resolve()
  await Promise.all([disposingRun, disposal])
  assert.equal(summaries().length, summariesBeforeDispose)
  assert.equal(f.store.getShell().compactionQueue.queued, false, 'disposal clears the pending action')
  console.log('PASS: session disposal cancels pending compaction and settles its caller.')
} finally {
  for (const gate of gates.values()) gate.resolve()
  holdSummary?.resolve()
  await f.close()
}
