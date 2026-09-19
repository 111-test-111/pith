import assert from 'node:assert/strict'
import { createPlanFixture } from './plan-fixture.mjs'
export async function checkPlanState() {
  const f = await createPlanFixture()
  try {
    await f.managed.lifecyclePromise
    const snapshot = f.app.snapshot()
    const plan = f.app.getPlanState(f.managed.path)
    f.store.dispatch({ type: 'plan_state_update', sessionPath: f.managed.path, sessionId: snapshot.sessionId, plan: { ...plan, mode: 'plan', seq: 90 } })
    f.store.applySnapshot({ ...snapshot, plan: { ...plan, seq: 80 } })
    assert.equal(f.store.getState().plan.seq, 90)
    f.store.applySnapshot({ ...snapshot, eventSequence: 999, plan: { ...plan, seq: 95 } })
    f.store.applySnapshot({ ...snapshot, eventSequence: 1, plan: { ...plan, seq: 100 } })
    assert.equal(f.store.getState().plan.seq, 100, 'metadata must merge before stale transcript early-return')
    f.store.dispatch({ type: 'plan_state_update', sessionPath: '/other', plan: { ...plan, seq: 2 } })
    f.store.applySnapshot({ ...snapshot, sessionPath: '/other', plan: { ...plan, seq: 1 } })
    assert.equal(f.store.getState().plan.seq, 2)
    f.store.activateCachedSession(f.managed.path)
    assert.equal(f.store.getState().plan.seq, 100)
  } finally { await f.close() }
  console.log('PASS: Plan metadata merges independently across snapshots, events and cached sessions')
}
