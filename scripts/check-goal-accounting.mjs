/** Real managed SDK children and the official Jev client over an offline transport. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createPlanFixture } from './lib/plan-fixture.mjs'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(predicate, label) { for (let i = 0; i < 900; i++) { if (predicate()) return; await sleep(10) } assert.fail(`Timed out: ${label}`) }
const text = text => ({ type: 'text', text })
const tool = (name, args) => ({ type: 'toolCall', id: randomUUID(), name, arguments: args })
const usage = (n = 7) => ({ input: 2, output: n - 2, cacheRead: 0, cacheWrite: 0, totalTokens: n, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } })
const question = { state: 'Committed fixture evidence.', questions: { verified: { type: 'noul', instructions: 'Does this evidence establish the requirement?' } } }
const reply = { model: 'jev-1', answers: { verified: { type: 'noul', noul: 0.9 } }, usage: { input_tokens: 3, output_tokens: 5 } }
const call = (f, action, data = {}, m = f.managed) => f.app.goalAction({ sessionPath: m.path, expectedSeq: m.goals.seq, goalId: m.goals.snapshot?.id ?? null, action, ...data })
const idle = m => m.session.isIdle && !m.goals.preparing
const fixtures = []
async function fixture() {
  const f = await createPlanFixture({ withRewind: true, prepareAgentDir: async dir => {
    await mkdir(join(dir, 'agents'), { recursive: true })
    await writeFile(join(dir, 'agents', 'billing-child.md'), '---\ndescription: Isolated billing child\ntools: read,jev_decide\n---\nBILLING_CHILD: report committed evidence.\n')
  } })
  fixtures.push(f)
  await f.managed.lifecyclePromise
  const modules = await import(pathToFileURL(join(f.temporary, 'modules.mjs')).href)
  // Only the destination directory changes: children still use PiManager's
  // real managed-session construction, run records, ceilings and teardown.
  const createChild = f.app.createSubagentChildSession.bind(f.app)
  f.app.createSubagentChildSession = options => {
    if (options.mode !== 'new') return createChild(options)
    const child = modules.SessionManager.create(options.cwd, join(f.temporary, 'sessions'), { parentSession: options.parentSessionPath })
    f.app.materializeSession(child)
    return createChild({ ...options, mode: 'reopen', sessionPath: child.getSessionFile() })
  }
  f.app.subagentReuseFlag = true
  f.app.jevCredentials.key = async () => 'offline-fixture'
  let jevCalls = 0
  f.app.jevService.options.fetch = async () => {
    jevCalls++
    return new Response(JSON.stringify(reply), { headers: { 'Content-Type': 'application/json', 'x-typesafe-request-id': 'offline-provider-id' } })
  }
  assert.equal((await f.app.updateJevSettings({ preferences: { mode: 'tools', choice: true, score: true, noul: true } })).ok, true)
  return Object.assign(f, { modules, jevCalls: () => jevCalls })
}
async function records(f) {
  const dirs = join(f.userData, 'goals', 'charges')
  const directory = join(dirs, (await readdir(dirs)).find(asyncName => asyncName.length === 64))
  return Promise.all((await readdir(directory)).filter(name => name.endsWith('.charge.json')).map(async name => ({ path: join(directory, name), ...JSON.parse(await readFile(join(directory, name), 'utf8')) })))
}
try {
  const f = await fixture()
  let parentRounds = 0, childRounds = 0
  f.setRespond((_n, context) => {
    if (JSON.stringify(context.messages.find(m => m.role === 'system')).includes('BILLING_CHILD:')) return ++childRounds === 1 ? [tool('jev_decide', question)] : [text('Child verified the evidence.')]
    if (++parentRounds === 1) return [tool('agent', { subagent_type: 'billing-child', prompt: 'Verify the bounded fixture.', description: 'Verify fixture evidence', run_in_background: false })]
    if (parentRounds === 2) return [tool('jev_decide', question)]
    return [text('More goal work remains.')]
  })
  assert.equal((await call(f, 'create', { objective: 'Account for owned work', acceptance: 'All owned usage is retained', limits: { maxAutoRuns: 1, tokenBudget: null } })).ok, true)
  try { await until(() => f.managed.goals.snapshot?.reason === 'runs' && idle(f.managed), 'managed child and Jev goal') }
  catch (error) { console.error(JSON.stringify({ goal: f.managed.goals.snapshot, rounds: { parentRounds, childRounds }, messages: f.session.messages.filter(m => m.role !== 'system'), events: f.events.filter(e => e.type === 'pi_error') })); throw error }
  const g = f.managed.goals.snapshot
  assert.equal(childRounds, 2, JSON.stringify(f.session.messages))
  assert.equal(f.jevCalls(), 2, 'parent and child each use the official Jev service')
  assert.equal(g.tokens, parentRounds * 2 + childRounds * 2 + 16)
  assert.deepEqual(g.billing, { parentTokens: parentRounds * 2, subagentTokens: 4, jevTokens: 16, unresolved: 0 })
  assert(f.events.filter(e => e.type === 'goal_update').every(e => e.eventSequence === undefined))
  const charges = await records(f)
  assert.equal(charges.filter(c => c.kind === 'jev').length, 2, 'Jev result metadata does not create a nested SDK charge')
  assert(charges.filter(c => c.kind === 'jev').every(c => c.providerRequestId === 'offline-provider-id'))
  assert.equal(charges.filter(c => c.kind === 'subagent').length, 2, 'private response and committed SDK entries share request identity')
  const book = f.app.goalAccounting, owner = f.managed.goals.billingOwner()
  book.recover(owner); book.recover(owner); f.managed.goals.syncAccounting()
  assert.equal(f.managed.goals.snapshot.tokens, g.tokens, 'inspection/recovery is idempotent')

  // Human continuation after the parent pauses retains the originating pool.
  const child = [...f.managed.subagents.roster.values()][0]
  assert.equal(charges.find(c => c.kind === 'jev' && c.sessionId === child.sessionId).subagentRunId, child.runId, 'child Jev provenance pins the actual child run, independently of its parent dispatch')
  f.setRespond(() => [text('A fresh child continuation.')])
  await f.app.subagentAction({ sessionPath: f.managed.path, sessionId: child.sessionId, expectedRunId: child.runId, action: 'resume', message: 'Continue the owned child.' })
  await until(() => !f.managed.subagents.runs.size, 'resumed child settles')
  f.managed.goals.syncAccounting()
  assert.equal(f.managed.goals.snapshot.tokens, g.tokens + 2, 'a new run bills only its new SDK request')
  assert.equal(f.managed.goals.snapshot.billing.subagentTokens, 6)
  const retained = f.managed.goals.snapshot.tokens
  await unlink(child.sessionPath)
  book.recover(owner)
  f.managed.goals.syncAccounting()
  assert.equal(f.managed.goals.snapshot.tokens, retained, 'deleting a closed child cannot erase paid usage')

  const checkpoint = (await f.app.rewindList(f.managed.path)).value.checkpoints[0]
  const preview = await f.app.rewindPreview(f.managed.path, checkpoint.id)
  assert.equal((await f.app.rewindRestore({ sessionPath: f.managed.path, token: preview.value.token, mode: 'conversation', operationId: randomUUID() })).error, undefined)
  assert.equal(f.managed.goals.snapshot.tokens, retained, 'Rewind retains independent fees even after child deletion')
  f.app.activateSession(f.managed)
  const latestAssistant = f.manager.getBranch().findLast(e => e.type === 'message' && e.message.role === 'assistant')
  // Rewind may remove the final reply; use a fresh ordinary turn to fork.
  if (!latestAssistant) { const before = f.requests.length; f.app.prompt({ text: 'Establish a fork anchor.', images: [], files: [] }); await until(() => f.requests.length > before && idle(f.managed), 'fork anchor') }
  const anchor = f.manager.getBranch().findLast(e => e.type === 'message' && e.message.role === 'assistant')
  const fork = await f.app.forkFromMessage(anchor.message.timestamp)
  const forked = f.app.sessions.get(fork.snapshot.sessionPath)
  await forked.lifecyclePromise
  assert.deepEqual(forked.goals.snapshot.billing, f.managed.goals.snapshot.billing)
  assert.equal(forked.goals.snapshot.tokens, retained)
  const forkOwner = forked.goals.billingOwner()
  book.jev(forkOwner, forked.session.sessionId, randomUUID(), 'fork-review').record({ input: 2, output: 1, cacheRead: 0, cacheWrite: 0 })
  await sleep(0)
  assert.equal(f.managed.goals.snapshot.tokens, retained + 3)
  assert.equal(forked.goals.snapshot.tokens, retained + 3)
  await call(f, 'limits', { limits: { maxAutoRuns: 8, tokenBudget: retained + 3 } }, forked)
  assert.throws(() => book.jev(forked.goals.billingOwner(), forked.session.sessionId, randomUUID()), e => e.code === 'quota')
  assert.equal((await call(f, 'resume', {}, forked)).code, 'quota')
  console.log('PASS goal-accounting: managed child/tool Jev attribution, child Resume/deletion, Rewind, Fork shared cap and idempotent recovery')

  // SDK standalone, summary, cache and tool billing uses component totals.
  const sdk = f.modules.SessionManager.create(f.project, join(f.temporary, 'sessions'), { parentSession: f.managed.path })
  f.app.materializeSession(sdk)
  const runId = randomUUID(), manualOwner = { ...owner, tokenBudget: null }
  const billing = book.child(manualOwner, sdk, runId)
  sdk.appendCustomEntry('pith_subagent_run', { runId })
  const components = { ...usage(5), cacheRead: 3, cacheWrite: 4, totalTokens: 999, reasoning: 2 }
  sdk.appendUsage('standalone', 'fixture', 'fixture', components)
  sdk.appendCompaction('summary', null, 42, undefined, false, usage(7))
  sdk.appendMessage({ role: 'toolResult', toolName: 'fixture', toolCallId: 'fixture', content: [text('billed independently')], isError: false, timestamp: Date.now(), usage: usage(4) })
  billing.close(); billing.close(); book.recover(manualOwner)
  f.managed.goals.syncAccounting()
  assert.equal(f.managed.goals.snapshot.tokens, retained + 3 + 12 + 7 + 4)
  assert.equal(f.managed.goals.snapshot.billing.subagentTokens, 6 + 23, 'reasoning and totalTokens are not double-added')
  console.log('PASS goal-accounting: cache, standalone, summary and tool costs without total/reasoning duplication')

  // Known response usage must be charged before cancellation/semantic rejection.
  let allowed = true, serviceCalls = 0
  const service = new f.modules.JevService({ preferences: () => ({ mode: 'tools', choice: true, score: true, noul: true }), apiKey: async () => 'fixture',
    accounting: () => (id, callId) => book.jev(manualOwner, f.session.sessionId, id, callId), fetch: async () => {
      serviceCalls++; allowed = false
      return new Response(JSON.stringify(reply), { headers: { 'Content-Type': 'application/json' } })
    } })
  const beforeLate = new f.modules.GoalStorage(f.userData, owner.ownerSessionId).read(owner.goalId, true).tokens
  await assert.rejects(service.evaluate(question, { owner: f.managed.path, canStart: () => allowed }), e => e.code === 'cancelled')
  assert.equal(new f.modules.GoalStorage(f.userData, owner.ownerSessionId).read(owner.goalId, true).tokens, beforeLate + 8)
  service.options.fetch = async () => new Response(JSON.stringify({ ...reply, answers: {} }), { headers: { 'Content-Type': 'application/json' } })
  await assert.rejects(service.evaluate(question, { owner: f.managed.path }), e => e.code === 'invalid_response')
  assert.equal(new f.modules.GoalStorage(f.userData, owner.ownerSessionId).read(owner.goalId, true).tokens, beforeLate + 16)
  service.options.apiKey = async () => { allowed = false; return 'fixture' }
  allowed = true
  const beforeKeySources = new f.modules.GoalStorage(f.userData, owner.ownerSessionId).read(owner.goalId, true).independent.sources.length
  await assert.rejects(service.evaluate(question, { owner: f.managed.path, canStart: () => allowed }), e => e.code === 'cancelled')
  assert.equal(serviceCalls, 1, 'Stop during key lookup never claims or calls the provider')
  assert.equal(new f.modules.GoalStorage(f.userData, owner.ownerSessionId).read(owner.goalId, true).independent.sources.length, beforeKeySources)
  const beforeUnknown = new f.modules.GoalStorage(f.userData, owner.ownerSessionId).read(owner.goalId, true).tokens
  service.options.apiKey = async () => 'fixture'
  service.options.fetch = async () => { throw new Error('Lost remote response') }
  await assert.rejects(service.evaluate(question, { owner: f.managed.path }), e => e.code === 'network')
  f.managed.goals.syncAccounting()
  assert.equal(f.managed.goals.snapshot.tokens, beforeUnknown)
  assert.equal(f.managed.goals.snapshot.accountingAvailable, false)
  assert.equal(f.managed.goals.snapshot.billing.unresolved, 1)
  assert.equal((await call(f, 'resume')).code, 'accounting')
  assert.throws(() => book.check(manualOwner), e => e.code === 'unavailable')
  assert.equal((await call(f, 'limits', { limits: { maxAutoRuns: 99, tokenBudget: null } })).ok, true)
  assert.equal(f.managed.goals.snapshot.tokens, beforeUnknown)
  assert.equal(f.managed.goals.snapshot.billing.unresolved, 1, 'raising limits cannot clear unknown usage')
  console.log('PASS goal-accounting: cancelled/invalid Jev responses retain known usage; unreported usage blocks dispatch instead of becoming zero')

  // A zero-usage aborted SDK placeholder cannot mask a lost child request.
  const q = await fixture()
  q.managed.goals.host.available = () => false
  await call(q, 'create', { objective: 'Unknown request ownership', acceptance: 'Retain unresolved usage', limits: { maxAutoRuns: 2, tokenBudget: null } })
  const qOwner = q.managed.goals.billingOwner(), qBook = q.app.goalAccounting
  const cm = q.modules.SessionManager.create(q.project, join(q.temporary, 'sessions'), { parentSession: q.managed.path }); q.app.materializeSession(cm)
  const r = randomUUID(), cb = qBook.child(qOwner, cm, r)
  cm.appendCustomEntry('pith_subagent_run', { runId: r })
  const lateTicket = cb.beforeRequest()
  lateTicket.finish(undefined)
  assert.throws(() => cb.check(), e => e.code === 'unavailable', 'an errored unreported response blocks the next request immediately')
  cm.appendMessage({ role: 'assistant', content: [], provider: 'fixture', model: 'fixture', api: 'openai-completions', timestamp: Date.now(), stopReason: 'aborted', usage: { ...usage(2), input: 0, output: 0, totalTokens: 0 } })
  cm.appendUsage('standalone', 'fixture', 'fixture', usage(7))
  cb.close(); qBook.recover(qOwner); q.managed.goals.syncAccounting()
  assert.equal(q.managed.goals.snapshot.tokens, 7)
  assert.equal(q.managed.goals.snapshot.billing.unresolved, 1, 'unrelated standalone usage does not settle the missing primary response')
  assert.equal(q.managed.goals.snapshot.accountingAvailable, false)
  console.log('PASS goal-accounting: abort placeholders and later standalone fees never conceal unknown primary usage')
  lateTicket.finish(usage(7)); cb.close(); qBook.recover(qOwner); q.managed.goals.syncAccounting()
  assert.equal(q.managed.goals.snapshot.tokens, 14, 'a verifiable late receipt reconciles the unknown request once')
  assert.equal(q.managed.goals.snapshot.billing.unresolved, 0)
  assert.equal(q.managed.goals.snapshot.status, 'paused', 'reconciled usage cannot grant automatic execution')
  assert.equal(q.requests.length, 0)

  for (const action of ['pause', 'stop']) {
    const p = await fixture()
    let started = false, release
    const gate = new Promise(resolve => { release = resolve })
    p.modules.setPlanFixtureStream((_model, context) => {
      started = true
      p.requests.push(context)
      const message = { role: 'assistant', content: [text('Late paid child result.')], api: 'openai-completions', provider: 'fixture', model: 'fixture', timestamp: Date.now(), stopReason: 'stop', usage: usage(7) }
      return { async *[Symbol.asyncIterator]() { await gate; yield { type: 'done', message } }, result: async () => { await gate; return message } }
    })
    p.setRespond(n => n === 1 ? [tool('agent', { subagent_type: 'billing-child', prompt: 'Verify an owned result.', description: 'Paid child response', run_in_background: true })] : [text('Parent progress.')])
    await call(p, 'create', { objective: 'Retain late child costs', acceptance: 'Stop and Resume retain once-only charges', limits: { maxAutoRuns: 1, tokenBudget: null } })
    await until(() => started, `${action} child dispatched`)
    if (action === 'stop') p.app.abort()
    else assert.equal((await call(p, 'pause')).ok, true)
    release()
    await until(() => idle(p.managed) && !p.managed.subagents.runs.size, `${action} child drained`)
    p.managed.goals.syncAccounting()
    assert.equal(p.managed.goals.snapshot.billing.subagentTokens, 7, 'late known response is durable even if SDK discards it after abort')
    assert.equal(p.managed.goals.snapshot.accountingAvailable, true)
    const before = p.managed.goals.snapshot.tokens, runCount = p.managed.goals.snapshot.autoRuns
    assert.equal((await p.app.setSessionMode({ sessionPath: p.managed.path, mode: 'plan' })).ok, true)
    assert.equal((await call(p, 'resume')).code, 'plan')
    assert.equal(p.managed.goals.snapshot.tokens, before)
    assert.equal((await p.app.setSessionMode({ sessionPath: p.managed.path, mode: 'normal' })).ok, true)
    await call(p, 'limits', { limits: { maxAutoRuns: runCount + 1, tokenBudget: null } })
    assert.equal((await call(p, 'resume')).ok, true)
    await until(() => p.managed.goals.snapshot.reason === 'runs' && idle(p.managed), `${action} explicit resume`)
    p.app.goalAccounting.recover(p.managed.goals.billingOwner())
    p.managed.goals.syncAccounting()
    assert.equal(p.managed.goals.snapshot.billing.subagentTokens, 7)
    assert(p.managed.goals.snapshot.tokens > before)
    console.log(`PASS goal-accounting: live background child ${action}, late response, Plan admission and explicit Resume retain one charge`)
  }

  const capped = await fixture()
  let childCalls = 0
  capped.setRespond((_n, context) => {
    if (JSON.stringify(context.messages.find(m => m.role === 'system')).includes('BILLING_CHILD:')) { childCalls++; return [text('Should not dispatch.')] }
    return [tool('agent', { subagent_type: 'billing-child', prompt: 'Verify a fixture.', description: 'Denied child quota', run_in_background: false })]
  })
  await call(capped, 'create', { objective: 'Bound shared costs', acceptance: 'No new child request after cap', limits: { maxAutoRuns: 2, tokenBudget: 2 } })
  await until(() => capped.managed.goals.snapshot?.reason === 'tokens' && idle(capped.managed), 'child budget refusal')
  assert.equal(childCalls, 0)
  assert.equal(capped.managed.goals.snapshot.tokens, 2)
  assert.equal(capped.managed.goals.snapshot.billing.subagentTokens, 0)
  console.log('PASS goal-accounting: primary spend checks the shared cap before child provider admission')

  const broken = await fixture()
  broken.managed.goals.host.available = () => false
  await call(broken, 'create', { objective: 'Keep provenance', acceptance: 'Missing charge evidence fails closed', limits: { maxAutoRuns: 2, tokenBudget: null } })
  const brokenOwner = broken.managed.goals.billingOwner()
  broken.app.goalAccounting.jev(brokenOwner, broken.session.sessionId, randomUUID()).record({ input: 2, output: 3, cacheRead: 0, cacheWrite: 0 })
  broken.managed.goals.syncAccounting()
  const charged = (await records(broken))[0], leaf = broken.manager.getLeafId()
  await unlink(charged.path)
  broken.managed.goals.restore('interrupted')
  assert.equal(broken.managed.goals.snapshot.tokens, 5)
  assert.equal(broken.managed.goals.snapshot.accountingAvailable, false)
  assert.equal(broken.managed.goals.snapshot.reason, 'storage')
  assert.equal((await call(broken, 'resume')).code, 'storage')
  assert.equal(broken.manager.getLeafId(), leaf, 'corrupt accounting cannot append a replacement zero ledger/branch fact')
  console.log('PASS goal-accounting: deleted charge receipt retains spent amount and refuses further execution')
} finally { for (const f of fixtures.reverse()) await f.close() }
