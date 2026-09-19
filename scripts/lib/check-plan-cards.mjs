import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { submittedPlanRef, visibleSubmissionIds } from '../../src/renderer/src/lib/plan-submissions.ts'
import { exportPlan } from '../../src/main/pi/plan-export.ts'
import { createPlanFixture, submitFixturePlan } from './plan-fixture.mjs'
export async function checkPlanCards() {
  const f = await createPlanFixture()
  try {
    const ref = await submitFixturePlan(f)
    const snapshot = f.app.snapshot()
    const result = snapshot.messages.find(m => m.role === 'toolResult' && m.toolName === 'submit_plan')
    assert.deepEqual(submittedPlanRef(result), ref)
    assert.equal(submittedPlanRef({ ...result, isError: true }), null)
    assert.equal(submittedPlanRef({ ...result, planSubmission: undefined }), null)
    assert.equal(submittedPlanRef({ role: 'assistant', content: [{ type: 'toolCall', name: 'submit_plan', id: 'pending', arguments: {} }] }), null)
    assert.equal(visibleSubmissionIds([result, result]).size, 1)
    assert.deepEqual(result.planSubmission, ref, 'restored messages need the durable entry stamp')
    const event = f.events.find(e => e.type === 'message_end' && e.message?.toolName === 'submit_plan')
    assert.deepEqual(event.message.planSubmission, ref, 'live result must be stamped only after persistence')
    const request = { sessionPath: f.managed.path, ...ref }
    const before = f.manager.getLeafId()
    const cancelled = await exportPlan(request, r => f.app.readPlanDocument(r), async () => ({ canceled: true }))
    assert.deepEqual(cancelled, { ok: true, value: { cancelled: true } })
    assert.equal(f.manager.getLeafId(), before)
    const path = join(f.temporary, 'export.md')
    const exported = await exportPlan(request, r => f.app.readPlanDocument(r), async () => ({ canceled: false, filePath: path }))
    assert(exported.ok)
    assert.equal(await readFile(path, 'utf8'), f.app.readPlanDocument(request).value.markdown)
    assert.equal((await exportPlan({ ...request, revision: 99 }, r => f.app.readPlanDocument(r), async () => { throw new Error('must not choose a path') })).ok, false)
  } finally { await f.close() }
  console.log('PASS: durable submission stamps on live and restored transcripts')
}
