import assert from 'node:assert/strict'
import fs, { existsSync, readFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { createPlanFixture, submitFixturePlan } from './plan-fixture.mjs'
export async function checkPlanApproval() {
  const f = await createPlanFixture()
  try {
    const ref = await submitFixturePlan(f)
    const request = { sessionPath: f.managed.path, ...ref }
    assert.equal(f.app.getPlanState(f.managed.path).executionTurnId, null, 'a submission has no execution turn yet')
    f.setRespond(() => [{ type: 'text', text: 'Execution accepted' }])
    const beforeUsers = f.manager.getBranch().filter(e => e.type === 'message' && e.message.role === 'user').length
    assert.equal((await f.app.approvePlan({ ...request, revision: 9 })).ok, false)
    const [a, b] = await Promise.all([f.app.approvePlan(request), f.app.approvePlan(request)])
    assert(a.ok, JSON.stringify(a))
    assert(b.ok || b.blockers.includes('transition'))
    await f.session.waitForIdle()
    const state = f.app.getPlanState(f.managed.path)
    assert.equal(state.mode, 'normal')
    assert.equal(state.effectiveSandboxMode, 'workspace-write')
    const started = f.manager.getBranch().filter(e => e.type === 'custom' && e.customType === 'pith_plan_approval' && e.data.status === 'started')
    assert.equal(started.length, 1)
    assert(started[0].data.executionEntryId)
    assert.equal(f.manager.getBranch().filter(e => e.type === 'message' && e.message.role === 'user').length, beforeUsers + 1)
    assert((await f.app.approvePlan(request)).ok)
    assert.equal(f.manager.getBranch().filter(e => e.type === 'message' && e.message.role === 'user').length, beforeUsers + 1)
    const entries = readFileSync(f.managed.path, 'utf8').trim().split('\n').map(JSON.parse)
    assert(entries.some(e => e.id === started[0].data.executionEntryId))
    // The review pane groups a turn by its first assistant message timestamp,
    // while the approval records only the opening user entry id: main derives
    // the mapping from the selected branch, and a branch that no longer holds
    // the opening (rewind, resend, compaction) maps to null.
    const executionEntryId = started[0].data.executionEntryId
    const branch = f.manager.getBranch()
    const openingIndex = branch.findIndex(e => e.type === 'message' && e.id === executionEntryId)
    assert(openingIndex >= 0, 'the opening user entry is on the selected branch')
    const executionAssistant = branch.slice(openingIndex + 1).find(e => e.type === 'message' && e.message.role === 'assistant')
    assert(executionAssistant, 'the approved execution produced an assistant message')
    assert.equal(state.executionTurnId, executionAssistant.message.timestamp, 'a started approval maps to its execution turn')
    f.manager.branch(branch[openingIndex - 1].id)
    f.managed.plan.restore()
    assert.equal(f.app.getPlanState(f.managed.path).executionTurnId, null, 'a rewound-away opening has no execution turn')
  } finally { await f.close() }
  for (const mode of ['workspace-write', 'read-only']) {
    const f = await createPlanFixture()
    try {
      await f.managed.lifecyclePromise
      f.app.setSessionSandboxMode(f.managed.path, mode)
      const ref = await submitFixturePlan(f)
      const next = f.requests.length + 1
      const target = join(f.project, 'approved.txt')
      f.setRespond(n => {
        if (n !== next) return [{ type: 'text', text: 'Verified' }]
        const disk = readFileSync(f.managed.path, 'utf8').trim().split('\n').map(JSON.parse)
        assert(disk.some(e => e.customType === 'pith_plan_approval' && e.data.status === 'started'), 'model request preceded durable acceptance')
        return [{ type: 'toolCall', id: 'approved-write', name: 'write', arguments: { path: target, content: 'approved' } }]
      })
      assert((await f.app.approvePlan({ sessionPath: f.managed.path, ...ref })).ok)
      await f.session.waitForIdle()
      assert.equal(existsSync(target), mode === 'workspace-write')
    } finally { await f.close() }
  }
  let handled = false
  const denied = await createPlanFixture({ extensionFactories: [pi => pi.on('input', () => handled ? { action: 'handled' } : undefined)] })
  try {
    const ref = await submitFixturePlan(denied)
    const request = { sessionPath: denied.managed.path, ...ref }
    handled = true
    assert.equal((await denied.app.approvePlan(request)).ok, false)
    assert.equal(denied.app.getPlanState(denied.managed.path).mode, 'plan')
    assert.equal(denied.app.getPlanState(denied.managed.path).approval.status, 'failed')
    handled = false
    denied.setRespond(() => [{ type: 'text', text: 'Accepted on explicit retry' }])
    assert((await denied.app.approvePlan(request)).ok)
    await denied.session.waitForIdle()
  } finally { await denied.close() }
  const cold = await createPlanFixture()
  try {
    const ref = await submitFixturePlan(cold)
    const request = { sessionPath: cold.managed.path, ...ref }
    cold.manager.appendCustomEntry('pith_plan_approval', { version: 1, approvalId: 'lost-opening', ref, status: 'requested' })
    cold.managed.plan.restore()
    const before = cold.requests.length
    cold.managed.planApproval.recover()
    assert.equal(cold.requests.length, before)
    assert.equal(cold.app.getPlanState(cold.managed.path).approval.status, 'interrupted')
    assert.equal(cold.app.getPlanState(cold.managed.path).executionTurnId, null, 'an interrupted approval has no execution turn')
    assert.equal((await cold.app.setSessionMode({ sessionPath: cold.managed.path, mode: 'normal' })).ok, false)
    assert.equal((await cold.app.approvePlan(request)).ok, false)
    assert((await cold.app.resetPlanApproval(request)).ok)
    assert.equal(cold.app.getPlanState(cold.managed.path).latest, null)
    assert.equal(cold.app.getPlanState(cold.managed.path).mode, 'plan')
  } finally { await cold.close() }
  const broken = await createPlanFixture()
  try {
    const ref = await submitFixturePlan(broken)
    const before = broken.requests.length
    const append = broken.manager.appendCustomEntry.bind(broken.manager)
    broken.manager.appendCustomEntry = (type, data) => {
      if (type === 'pith_plan_approval') throw new Error('simulated append failure')
      return append(type, data)
    }
    const result = await broken.app.approvePlan({ sessionPath: broken.managed.path, ...ref })
    assert.equal(result.ok, false)
    assert(result.blockers.includes('storage'))
    assert.equal(broken.requests.length, before)
    assert.equal(broken.app.getPlanState(broken.managed.path).effectiveSandboxMode, 'read-only')
  } finally { await broken.close() }
  await checkApprovalFailures()
  console.log('PASS: approval version binding, durable opening and idempotence')
}

async function checkApprovalFailures() {
  // Throw at each approval fsync: requested, Normal transition, and started.
  // Replace the native boundary only inside this isolated fixture, then restore it.
  for (const at of [1, 2, 3]) {
    const f = await createPlanFixture()
    const nativeSync = fs.fsyncSync
    try {
      const ref = await submitFixturePlan(f)
      const request = { sessionPath: f.managed.path, ...ref }
      const before = f.requests.length
      let count = 0
      fs.fsyncSync = fd => { if (++count === at) throw new Error('injected-fsync'); return nativeSync(fd) }
      syncBuiltinESMExports()
      const result = await f.app.approvePlan(request)
      assert.equal(result.ok, false, `fsync ${at} falsely accepted`)
      assert(result.blockers.includes('storage'))
      assert.equal(f.requests.length, before, 'failed durable admission reached the model')
      assert.throws(() => f.managed.plan.checkWorkAdmission())
      assert.equal((await f.app.approvePlan(request)).ok, false, 'a failed started append cannot become an idempotent success')
    } finally { fs.fsyncSync = nativeSync; syncBuiltinESMExports(); await f.close() }
  }
  let hold = false, entered, resume
  const inputStarted = new Promise(r => { entered = r })
  const inputReleased = new Promise(r => { resume = r })
  const stopped = await createPlanFixture({ extensionFactories: [pi => pi.on('input', async () => {
    if (hold) { entered(); await inputReleased }
  })] })
  try {
    const ref = await submitFixturePlan(stopped)
    hold = true
    const before = stopped.requests.length
    const opening = stopped.app.approvePlan({ sessionPath: stopped.managed.path, ...ref })
    await inputStarted
    stopped.app.abort()
    assert.equal((await opening).ok, false)
    resume()
    await stopped.managed.planApproval.execution
    assert.equal(stopped.requests.length, before, 'late input completion resurrected a stopped approval')
    assert.equal(stopped.app.getPlanState(stopped.managed.path).mode, 'plan')
  } finally { resume(); await stopped.close() }

  const accepted = await createPlanFixture({ withRewind: true })
  try {
    const ref = await submitFixturePlan(accepted)
    accepted.setRespond(() => { throw new Error('injected-model-failure-after-admission') })
    const request = { sessionPath: accepted.managed.path, ...ref }
    const result = await accepted.app.approvePlan(request)
    assert(result.ok, JSON.stringify(result))
    await accepted.session.waitForIdle()
    await accepted.managed.rewind.idle()
    const list = await accepted.app.rewindList(accepted.managed.path)
    assert(!list.error, JSON.stringify(list))
    assert.equal(list.value.checkpoints.filter(c => c.messageEntryId === result.value.executionEntryId).length, 1)
    const before = accepted.requests.length
    assert((await accepted.app.approvePlan(request)).ok)
    assert.equal(accepted.requests.length, before, 'started execution was silently retried')
    assert.equal(accepted.app.getPlanState(accepted.managed.path).approval.status, 'started')
  } finally { await accepted.close() }
  console.log('PASS: approval fsync failures, Stop during async input, accepted model failure and exact user checkpoint')
}
