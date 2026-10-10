import assert from 'node:assert/strict'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { createPlanFixture, submitFixturePlan } from './plan-fixture.mjs'

const deferred = () => { let resolve; return { promise: new Promise(r => { resolve = r }), resolve: () => resolve() } }
export async function checkPlanLifecycle() {
  // `keepRecentTokens: 1` keeps the compaction-admission fixture above the
  // "nothing to summarize" floor: this case is about the shared transition
  // boundary, not about a session that is too small to compact at all.
  const f = await createPlanFixture({ keepRecentTokens: 1 })
  try {
    await f.managed.lifecyclePromise
    await f.session.prompt('Seed a saved session')
    const timestamp = f.session.messages.find(m => m.role === 'assistant').timestamp
    const barrier = deferred()
    const transition = f.managed.plan.transition(() => barrier.promise)
    try {
      await assert.rejects(f.app.compactSession(f.managed.path), e => e.blockers?.includes('transition'))
      await assert.rejects(f.app.reloadSession(f.managed.path), e => e.blockers?.includes('transition'))
      await assert.rejects(f.app.forkFromMessage(timestamp), e => e.blockers?.includes('transition'))
      const result = await f.app.rewindRestore({ sessionPath: f.managed.path, token: 'unreached', operationId: 'unreached', mode: 'conversation' })
      assert.equal(result.error?.code, 'busy', 'rewind must refuse before reaching the worker during a Plan transition')
    } finally { barrier.resolve(); await transition }

    const compactBarrier = deferred()
    const original = f.session.compactAtBoundary
    f.session.compactAtBoundary = () => compactBarrier.promise
    const compacting = f.app.compactSession(f.managed.path)
    try {
      const result = await f.app.setSessionMode({ sessionPath: f.managed.path, mode: 'plan' })
      assert.equal(result.ok, false, 'mode change must refuse during compaction preparation')
      assert(result.blockers.includes('busy'))
    } finally { compactBarrier.resolve(); await compacting; f.session.compactAtBoundary = original }
  } finally { await f.close() }
  await checkNothingToCompact()
  await checkRestoration()
  console.log('PASS: compaction/reload/fork/rewind share the Plan transition admission boundary')
}

/**
 * A session that fits inside `keepRecentTokens` has nothing to summarize. The
 * host must fail fast with the SDK's own message — and without emitting the
 * `compaction_start`/`compaction_end` pair a model-less compaction would never
 * settle, which is what put a transient "compressing" row in the transcript.
 */
async function checkNothingToCompact() {
  const f = await createPlanFixture({ keepRecentTokens: 1 })
  try {
    await f.managed.lifecyclePromise
    await f.session.prompt('Too small to summarize')
    f.session.settingsManager.applyOverrides({ compaction: {
      enabled: false, keepRecentTokens: 1,
      modelOverrides: { 'fixture/fixture': { keepRecentTokens: 20000 } }
    } })
    assert.equal(f.session.settingsManager.getCompactionSettings(f.session.model).keepRecentTokens, 20000)
    const events = []
    const unsubscribe = f.session.subscribe(event => events.push(event.type))
    await assert.rejects(
      f.app.compactSession(f.managed.path),
      error => String(error?.message ?? error).includes('Nothing to compact (session too small)')
    )
    unsubscribe()
    assert(
      !events.includes('compaction_start') && !events.includes('compaction_end'),
      'the selected model\'s recent-token override must prevent spurious compaction events'
    )
  } finally { await f.close() }
}

async function checkRestoration() {
  const f = await createPlanFixture({ withRewind: true, keepRecentTokens: 1 })
  const value = result => { assert(!result.error, JSON.stringify(result)); return result.value }
  try {
    const ref = await submitFixturePlan(f)
    const saved = SessionManager.open(f.managed.path)
    assert(saved.getBranch().some(e => e.id === ref.submissionEntryId))
    await f.managed.rewind.idle()
    assert.equal(value(await f.app.rewindList(f.managed.path)).error, undefined)
    const originalSeq = f.app.getPlanState(f.managed.path).seq
    await f.app.disposeManaged(f.managed)
    const cold = await f.app.buildSession(SessionManager.open(f.managed.path))
    await cold.lifecyclePromise
    assert(f.app.getPlanState(cold.path).seq > originalSeq)
    assert.equal(f.app.getPlanState(cold.path).latest.hash, ref.hash)
    assert(cold.plan.submissionLocked)
    assert(!cold.session.getActiveToolNames().includes('write'))
    assert(f.app.snapshot().messages.some(m => m.planSubmission?.submissionEntryId === ref.submissionEntryId))
    // Keep a newer turn so the SDK can cut away the original submission.
    f.setRespond(() => [{ type: 'text', text: 'Additional investigation completed.' }])
    await cold.session.prompt('Investigate alternatives')
    const transcriptBeforeCompaction = f.app.snapshot().messages
    f.setRespond(() => [{ type: 'text', text: 'Summary retaining the planning decision.' }])
    const before = f.requests.length
    const compacted = await f.app.compactSession(cold.path)
    assert(f.requests.length > before, 'manual compaction must exercise the real SDK summary stream')
    assert.match(JSON.stringify(f.requests.at(-1).messages.filter(message => message.role === 'system')), /Current working mode: Plan Mode/)
    assert(compacted.messages.some(m => m.role === 'compactionSummary'))
    const messageKey = message => `${message.role}:${message.timestamp}:${message.toolCallId ?? ''}`
    const contextKeys = new Set(cold.session.messages.map(messageKey))
    const compactedOut = transcriptBeforeCompaction.filter(message => !contextKeys.has(messageKey(message)))
    assert(compactedOut.length > 0, 'the SDK must still remove old messages from model context')
    const displayKeys = new Set(compacted.messages.map(messageKey))
    for (const message of compactedOut) {
      assert(displayKeys.has(messageKey(message)), 'a message removed from context must remain in the UI transcript')
    }
    const messageText = message => typeof message.content === 'string'
      ? message.content
      : Array.isArray(message.content)
        ? message.content.map(part => part.text ?? part.thinking ?? '').join('\n')
        : ''
    const excludedText = compactedOut.map(messageText).find(text => text.length >= 16)
    assert(excludedText, 'the fixture must compact out message text that can be checked in the next request')
    f.setRespond(() => [{ type: 'text', text: 'Continued from compacted context.' }])
    const nextRequestIndex = f.requests.length
    await cold.session.prompt('Continue after compaction')
    const nextMessages = JSON.stringify(f.requests[nextRequestIndex].messages)
    assert(!nextMessages.includes(excludedText), 'the next model request must not regain UI-only history')
    assert(nextMessages.includes('Summary retaining the planning decision.'), 'the next request must use the compaction summary')
    assert.equal(compacted.plan.latest.hash, ref.hash)
    assert(f.app.readPlanDocument({ sessionPath: cold.path, ...ref }).ok)

    const after = cold.session.messages.findLast(m => m.role === 'assistant').timestamp
    const fork = await f.app.forkFromMessage(after)
    assert.equal(fork.snapshot.plan.mode, 'plan')
    assert.equal(fork.snapshot.plan.latest.hash, ref.hash)
    assert(!f.app.activeSession.session.getActiveToolNames().includes('write'))
    const forkPath = fork.snapshot.sessionPath
    assert.notEqual(forkPath, cold.path)
    await f.app.activeSession.lifecyclePromise
    // Forking must not repoint the original manager or overwrite its document.
    assert.equal(cold.session.sessionManager.getSessionFile(), cold.path)
    assert((await readFile(cold.path, 'utf8')).includes(ref.hash))

    f.app.activateSession(cold)
    const current = f.app.getPlanState(cold.path)
    assert((await f.app.setSessionMode({ sessionPath: cold.path, mode: 'normal' })).ok)
    await cold.session.prompt('This turn starts in Normal')
    await cold.rewind.idle()
    const checkpoints = value(await f.app.rewindList(cold.path)).checkpoints
    const cp = checkpoints.find(c => c.messageEntryId === ref.planningTurnEntryId)
    assert(cp)
    const restore = async (id, action) => {
      const preview = value(await f.app.rewindPreview(cold.path, id, action))
      return value(await f.app.rewindRestore({ sessionPath: cold.path, token: preview.token, mode: 'conversation', operationId: randomUUID() }))
    }
    const restored = await restore(cp.id)
    assert.equal(f.app.getPlanState(cold.path).mode, 'plan')
    assert.equal(f.app.getPlanState(cold.path).latest, null)
    const undone = await restore(restored.operation.id, 'undo')
    assert.equal(f.app.getPlanState(cold.path).mode, 'normal')
    assert.equal(f.app.getPlanState(cold.path).latest.hash, current.latest.hash)
    await restore(undone.operation.id, 'redo')
    assert.equal(f.app.getPlanState(cold.path).mode, 'plan')
    assert.equal(f.app.getPlanState(cold.path).latest, null)

    // A sibling session in the same checkout keeps its own mode and tools.
    const sibling = await f.app.buildSession(SessionManager.create(f.project, join(f.temporary, 'sessions')))
    await sibling.lifecyclePromise
    assert.equal(sibling.plan.snapshot.mode, 'normal')
    assert(sibling.session.getActiveToolNames().includes('write'))
    assert.equal(cold.plan.snapshot.effectiveSandboxMode, 'read-only')
  } finally { await f.close() }
  console.log('PASS: real cold restore, compaction stream, fork, rewind/undo/redo and same-checkout session isolation')
}
