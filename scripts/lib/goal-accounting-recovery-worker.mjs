/** SIGKILL barriers around real SDK files and fsynced independent charge receipts. */
import assert from 'node:assert/strict'
import { closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createPlanFixture } from './plan-fixture.mjs'

const input = JSON.parse(process.argv[2])
const f = await createPlanFixture({ temporaryRoot: input.root, reuseBundle: true, keepFiles: true, sessionPath: input.sessionPath })
await f.managed.lifecyclePromise
const modules = await import(pathToFileURL(join(f.temporary, 'modules.mjs')).href)
const call = (action, data = {}) => f.app.goalAction({ sessionPath: f.managed.path, expectedSeq: f.managed.goals.seq, goalId: f.managed.goals.snapshot?.id ?? null, action, ...data })
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
function facts(managed = f.managed) {
  return { sessionPath: managed.path, leaf: managed.session.sessionManager.getLeafId(), goal: managed.goals.snapshot,
    userCount: managed.session.sessionManager.getEntries().filter(e => e.type === 'message' && e.message.role === 'user').length }
}
function barrier(managed = f.managed) {
  writeFileSync(join(input.root, 'accounting-checkpoint.tmp'), JSON.stringify({ phase: input.phase, ...facts(managed) }))
  renameSync(join(input.root, 'accounting-checkpoint.tmp'), join(input.root, 'accounting-checkpoint.json'))
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
}
if (input.mode === 'recover') {
  await f.managed.goals.inspect()
  await sleep(30)
  assert.equal(f.requests.length, 0, 'reopening never calls a provider')
  const before = facts(), result = await call('resume')
  const out = { before, result, requests: f.requests.length }
  // Refuse exhausted/unknown allowance so the recovery test never executes.
  assert.equal(result.ok, false)
  await f.close()
  await new Promise(resolve => process.stdout.write(JSON.stringify(out) + '\n', resolve))
  process.exit(0)
}
assert.equal((await call('create', { objective: 'Retain independent accounting', acceptance: 'Each fee survives process loss once', limits: { maxAutoRuns: 1, tokenBudget: null } })).ok, true)
for (let i = 0; i < 900 && !(f.managed.goals.snapshot?.reason === 'runs' && f.session.isIdle && !f.managed.goals.preparing); i++) await sleep(10)
assert.equal(f.managed.goals.snapshot.reason, 'runs')
const owner = f.managed.goals.billingOwner(), book = f.app.goalAccounting
const usage = { input: 2, output: 3, cacheRead: 1, cacheWrite: 1 }
if (input.phase.startsWith('jev')) {
  if (input.phase === 'jev-receipt') book.apply = () => barrier()
  const service = new modules.JevService({ preferences: () => ({ mode: 'tools', choice: true, score: true, noul: true }), apiKey: async () => 'offline-fixture',
    accounting: () => (id, callId) => book.jev(owner, f.session.sessionId, id, callId), fetch: async () => {
      if (input.phase === 'jev-claim') barrier()
      return new Response(JSON.stringify({ model: 'jev-1', answers: { checked: { type: 'noul', noul: 0.9 } }, usage: { input_tokens: 2, output_tokens: 5 } }),
        { headers: { 'Content-Type': 'application/json', 'x-typesafe-request-id': 'known-provider-request' } })
    } })
  await service.evaluate({ state: 'Committed fixture evidence.', questions: { checked: { type: 'noul', instructions: 'Does this establish the requirement?' } } },
    { owner: f.managed.path, callId: 'persisted-review-call' })
  f.managed.goals.syncAccounting()
  barrier()
}
const child = modules.SessionManager.create(f.project, join(f.temporary, 'sessions'), { parentSession: f.managed.path })
f.app.materializeSession(child)
const runId = randomUUID(), billing = book.child(owner, child, runId)
child.appendCustomEntry('pith_subagent_run', { runId })
billing.check()
const ticket = billing.beforeRequest()
if (input.phase === 'child-claim') barrier()
if (input.phase === 'child-receipt') book.apply = () => barrier()
if (input.phase !== 'child-entry') ticket.finish(usage)
if (input.phase !== 'child-response') {
  child.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'Committed child result.' }], api: 'openai-completions', provider: 'fixture', model: 'fixture', timestamp: Date.now(), stopReason: 'stop', usage: { ...usage, totalTokens: 7, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } })
  const fd = openSync(child.getSessionFile(), 'r+'); try { fsyncSync(fd) } finally { closeSync(fd) }
}
if (input.phase === 'child-entry') barrier()
if (input.phase !== 'child-response') billing.close()
if (input.phase === 'child-deleted') unlinkSync(child.getSessionFile())
f.managed.goals.syncAccounting()
if (input.phase === 'fork') {
  const assistant = f.manager.getBranch().findLast(e => e.type === 'message' && e.message.role === 'assistant')
  const fork = await f.app.forkFromMessage(assistant.message.timestamp)
  const managed = f.app.sessions.get(fork.snapshot.sessionPath)
  await managed.lifecyclePromise
  barrier(managed)
}
barrier()
