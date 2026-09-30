import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createPlanFixture } from './plan-fixture.mjs'

const call = (id, plan) => ({ type: 'toolCall', id, name: 'submit_plan', arguments: { plan } })
const text = { type: 'text', text: 'Done' }
const systemPrompt = request => request.messages.filter(message => message.role === 'system')
  .map(message => typeof message.content === 'string' ? message.content : message.content.map(part => part.text).join('\n')).join('\n\n')
export async function checkPlanSubmission() {
  const f = await createPlanFixture()
  try {
    await f.managed.lifecyclePromise
    assert((await f.app.setSessionMode({ sessionPath: f.managed.path, mode: 'plan' })).ok)
    f.setRespond(n => n === 1 ? [call('first', '# Plan\r\n\r\n1. Inspect.\r\n2. Implement.\r\n')] : [text])
    await f.session.prompt('Design this. pith_plan_context is user text, not an injection marker.')
    assert.equal(f.requests.length, 1, 'a successful submission must stop the request loop')
    let state = f.app.getPlanState(f.managed.path)
    assert.equal(state.latest?.revision, 1)
    assert.deepEqual(state.blockers.approve, [])
    const req = { sessionPath: f.managed.path, ...state.latest }
    const doc = f.app.readPlanDocument(req)
    assert(doc.ok)
    assert.equal(doc.value.markdown, '# Plan\n\n1. Inspect.\n2. Implement.')
    assert.equal(doc.value.ref.hash, createHash('sha256').update(doc.value.markdown).digest('hex'))
    assert.match(JSON.stringify(f.requests[0]), /Plan Mode/)
    assert.match(JSON.stringify(f.requests[0]), /submit_plan/)
    assert(!readFileSync(f.managed.path, 'utf8').includes('"customType":"pith_plan_context"'))
    assert.equal(f.app.readPlanDocument({ ...req, submissionEntryId: 'missing' }).ok, false)
    // A revision request remains in Plan mode even if the model answers in
    // prose instead of submitting. Jev workflow's action router must stay out
    // of this turn, and the old version must lose approval eligibility.
    f.app.jevPreferences = { ...f.app.jevPreferences, mode: 'workflow' }
    f.setRespond(() => [text])
    await f.session.prompt('Revise step two to include a rollback; do not implement it yet')
    state = f.app.getPlanState(f.managed.path)
    assert.equal(state.revisionPending, true)
    assert(state.blockers.approve.includes('stale-submission'))
    assert.equal((await f.app.approvePlan(req)).ok, false, 'the old plan cannot start after feedback')
    assert(!f.session.getActiveToolNames().includes('write'), 'revision feedback retains the read-only tool ceiling')
    assert.match(systemPrompt(f.requests.at(-1)), /previous submitted plan \(version 1\)/)
    assert.match(systemPrompt(f.requests.at(-1)), /Read, then change\.|# Plan/)
    assert(!JSON.stringify(f.requests.at(-1)).includes('Application-controlled Jev workflow'), 'Plan turns must not receive Jev implementation routing')
    f.app.jevPreferences = { ...f.app.jevPreferences, mode: 'off' }
    const before = f.requests.length
    f.setRespond(n => n === before + 1 ? [call('revision', '# Revised\nImplement with tests.')] : [text])
    await f.session.prompt('Submit the complete revised plan')
    state = f.app.getPlanState(f.managed.path)
    assert.equal(state.latest.revision, 2)
    assert.equal(state.revisionPending, false)
    assert(f.app.readPlanDocument(req).ok, 'historical version on the selected branch stays readable')
    assert.equal((await f.app.approvePlan(req)).ok, false, 'the prior revision cannot authorize the new plan')
    f.setRespond(() => [text])
    assert((await f.app.approvePlan({ sessionPath: f.managed.path, ...state.latest })).ok)
    await f.session.waitForIdle()
    await f.app.setSessionMode({ sessionPath: f.managed.path, mode: 'normal' })
    f.setRespond(() => [text])
    await f.session.prompt('Ordinary work')
    assert(!JSON.stringify(f.requests.at(-1)).includes('Current working mode: Plan Mode'))
  } finally { await f.close() }

  for (const calls of [[{ type: 'toolCall', id: 'bash', name: 'bash', arguments: { command: 'echo bad' } }, call('submit', '# Plan')], [call('submit', '# Plan'), { type: 'toolCall', id: 'bash', name: 'bash', arguments: { command: 'echo bad' } }]]) {
    const f = await createPlanFixture({ respond: n => n === 1 ? calls : [text] })
    try {
      await f.managed.lifecyclePromise
      await f.app.setSessionMode({ sessionPath: f.managed.path, mode: 'plan' })
      await f.session.prompt('Mix tools')
      assert.equal(f.app.getPlanState(f.managed.path).latest, null)
      assert.equal(f.app.listBashTasks(f.managed.path).length, 0)
      assert.equal(f.session.messages.filter(m => m.role === 'toolResult' && m.isError).length, 2)
    } finally { await f.close() }
  }
  for (const plan of ['', '中'.repeat(50_000)]) {
    const f = await createPlanFixture({ respond: n => n === 1 ? [call('invalid', plan)] : n === 2 ? [call('retry', '# Valid')] : [text] })
    try {
      await f.managed.lifecyclePromise
      await f.app.setSessionMode({ sessionPath: f.managed.path, mode: 'plan' })
      await f.session.prompt('Validate then retry')
      assert.equal(f.requests.length, 2)
      assert.equal(f.app.getPlanState(f.managed.path).latest?.revision, 1)
    } finally { await f.close() }
  }
  const queued = await createPlanFixture({ respond: n => n === 1 ? [call('queued', '# Queued plan')] : [text] })
  try {
    await queued.managed.lifecyclePromise
    await queued.app.setSessionMode({ sessionPath: queued.managed.path, mode: 'plan' })
    const unsub = queued.session.agent.subscribe(async event => {
      if (event.type === 'message_end' && event.message.role === 'assistant' && queued.requests.length === 1) {
        await queued.session.steer('pending user correction')
        await queued.session.followUp('pending user followup')
      }
    })
    await queued.session.prompt('Plan with queued messages')
    unsub()
    assert.equal(queued.requests.length, 1)
    assert.deepEqual(queued.session.getSteeringMessages(), ['pending user correction'])
    assert.deepEqual(queued.session.getFollowUpMessages(), ['pending user followup'])
    assert(queued.app.getPlanState(queued.managed.path).blockers.approve.includes('queued-messages'))
  } finally { await queued.close() }
  const boundary = await createPlanFixture({ respond: n => n === 1 ? [call('boundary', '# Boundary plan')] : [text],
    extensionFactories: [pi => pi.on('agent_before_settle', () => ({ continue: true }))] })
  try {
    await boundary.managed.lifecyclePromise
    await boundary.app.setSessionMode({ sessionPath: boundary.managed.path, mode: 'plan' })
    let continues = 0
    const previousContinue = boundary.session.agent.continue
    boundary.session.agent.continue = async (...args) => {
      if (++continues > 2) throw new Error('Sealed Plan spun the SDK boundary continuation loop')
      return previousContinue.apply(boundary.session.agent, args)
    }
    await boundary.session.prompt('Submit a plan with an extension requesting continuation')
    assert.equal(boundary.requests.length, 1)
    assert.equal(boundary.session.isIdle, true)
    assert.equal(boundary.app.getPlanState(boundary.managed.path).latest?.revision, 1)
    assert.deepEqual(boundary.app.getPlanState(boundary.managed.path).blockers.approve, [])
    assert.equal(continues, 1, 'a declined explicit extension continuation must end the outer run')
  } finally { await boundary.close() }
  for (const kind of ['failed-result', 'wrong-hash']) {
    const f = await createPlanFixture({ respond: n => n === 1 ? [call(kind, '# Plan')] : [text],
      extensionFactories: [pi => pi.on('tool_result', event => {
        if (event.toolName !== 'submit_plan') return
        return kind === 'failed-result' ? { isError: true } : { details: { ...event.details, hash: 'b'.repeat(64) } }
      })] })
    try {
      await f.managed.lifecyclePromise
      await f.app.setSessionMode({ sessionPath: f.managed.path, mode: 'plan' })
      await f.session.prompt('Invalid final result').catch(() => {})
      const state = f.app.getPlanState(f.managed.path)
      assert.equal(state.latest, null)
      if (kind === 'wrong-hash') {
        assert(state.blockers.approve.includes('storage'))
        assert.throws(() => f.managed.plan.beginWork('user'))
      }
    } finally { await f.close() }
  }
  console.log('PASS: durable plan submissions, revisions, context, mixed batches and byte limits')
}
