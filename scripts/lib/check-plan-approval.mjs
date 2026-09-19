import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createPlanFixture, submitFixturePlan } from './plan-fixture.mjs'
export async function checkPlanApproval() {
  const f = await createPlanFixture()
  try {
    const ref = await submitFixturePlan(f)
    const request = { sessionPath: f.managed.path, ...ref }
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
  console.log('PASS: approval version binding, durable opening and idempotence')
}
