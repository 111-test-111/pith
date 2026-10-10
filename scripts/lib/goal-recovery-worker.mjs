/** Owned child process for SIGKILL checks. Barriers follow real fsync/SDK commits. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createPlanFixture } from './plan-fixture.mjs'

const input = JSON.parse(process.argv[2])
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const text = value => ({ type: 'text', text: value })
const tool = (name, args) => ({ type: 'toolCall', id: randomUUID(), name, arguments: args })
const image = { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==' }
const f = await createPlanFixture({ temporaryRoot: input.root, reuseBundle: true, keepFiles: true, sessionPath: input.sessionPath, withRewind: true })
await f.managed.lifecyclePromise
const modules = await import(pathToFileURL(join(f.temporary, 'modules.mjs')).href)
const call = (action, data = {}) => f.app.goalAction({ sessionPath: f.managed.path, expectedSeq: f.managed.goals.seq, goalId: f.managed.goals.snapshot?.id ?? null, action, ...data })
async function until(predicate) { for (let i=0;i<1000;i++) { if (predicate()) return; await sleep(10) }; throw new Error('Goal recovery worker timed out') }
const idle = () => f.session.isIdle && !f.managed.goals.preparing
function facts(managed = f.managed) {
  const manager = managed.session.sessionManager, goal = managed.goals.snapshot
  let dispatchId = null
  if (goal) try { dispatchId = new modules.GoalStorage(f.userData, managed.session.sessionId).read(goal.id, true).run?.id ?? null } catch {}
  return { sessionPath: managed.path, sessionId: managed.session.sessionId, goal, leaf: manager.getLeafId(),
    goalEntries: manager.getBranch().filter(e => e.type === 'custom' && e.customType === 'pith_goal_v1').length,
    userCount: manager.getBranch().filter(e => e.type === 'message' && e.message.role === 'user').length,
    userInputs: manager.getBranch().filter(e => e.type === 'message' && e.message.role === 'user').map(e => e.message.content), dispatchId,
    hiddenDispatches: manager.getBranch().filter(e => e.type === 'custom_message' && e.customType === 'pith_goal_step_v1').map(e => e.details.dispatchId),
    requests: f.requests.map(context => ({ messages: context.messages })), plan: managed.plan.snapshot.mode,
    goalUI: managed === f.managed ? f.store.getState().goalUI : null,
    ledgerPath: goal ? join(f.userData, 'goals', createHash('sha256').update(`${new modules.GoalStorage(f.userData, managed.session.sessionId).owner(goal.id)}\0${goal.id}`).digest('hex') + '.json') : null }
}
function boundary(phase, managed = f.managed) {
  const payload = { phase, ...facts(managed) }
  const file = join(input.root, 'checkpoint.json')
  fs.writeFileSync(file + '.tmp', JSON.stringify(payload)); fs.renameSync(file + '.tmp', file)
  // The parent sends actual SIGKILL. This blocks JS without faking teardown,
  // disposing the SDK, releasing locks or permitting a second dispatch.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
}
if (input.mode === 'recover') {
  await f.managed.goals.inspect()
  const before = facts()
  await sleep(70)
  assert.equal(f.requests.length, 0, 'restart never calls a provider')
  assert.equal(f.manager.getLeafId(), before.leaf, 'inspection does not append a recovery goal fact')
  let result = null
  if (input.resume) {
    f.setRespond(() => [text('New dispatch after explicit Resume.')])
    if (before.goal.accountingAvailable) await call('limits', { limits: { maxAutoRuns: before.goal.autoRuns + 1, tokenBudget: null } })
    result = await call('resume')
    if (result.ok) await until(idle)
  }
  const out = { before, after: facts(), result,
    ledger: before.goal?.accountingAvailable ? new modules.GoalStorage(f.userData, f.session.sessionId).read(before.goal.id, true) : null,
    rewind: (await f.app.rewindList(f.managed.path)).value }
  await f.close()
  await new Promise(resolve => process.stdout.write(JSON.stringify(out) + '\n', resolve))
  process.exit(0)
}

await fs.promises.writeFile(join(f.project, 'input.txt'), 'Captured initial attachment.\n')
await fs.promises.writeFile(join(f.project, 'input.bin'), Buffer.from([0, 1, 2, 3, 254, 255]))
await fs.promises.writeFile(join(f.project, 'large.txt'), 'A'.repeat(512 * 1024) + '\nRetained beyond the inline limit.\n')
await fs.promises.writeFile(join(f.project, 'verified.txt'), 'Independently inspected result.\n')
await fs.promises.writeFile(join(f.project, 'baseline.txt'), 'Baseline before the goal.\n')
const append = modules.PlanStorage.prototype.append
modules.PlanStorage.prototype.append = function (type, data) {
  const value = append.call(this, type, data)
  if (input.phase === 'definition' && type === 'pith_goal_v1' && data.criteriaRevision === 1) boundary('definition')
  if (input.phase === 'final' && type === 'pith_goal_v1' && data.status === 'completed') boundary('final')
  if (input.phase === 'dismiss' && type === 'pith_goal_v1' && data.dismissed) boundary('dismiss')
  if (input.phase === 'plan' && type === 'pith_plan_mode' && data.mode === 'plan') boundary('plan')
  if (input.phase === 'stop' && type === 'pith_goal_v1' && data.reason === 'stopped') boundary('stop')
  return value
}
const sync = modules.PlanStorage.prototype.sync
modules.PlanStorage.prototype.sync = function () {
  const value = sync.call(this)
  const entry = f.manager.getLeafEntry()
  if (input.phase === 'user' && entry?.type === 'message' && entry.message.role === 'user') boundary('user')
  if (input.phase === 'receipt' && entry?.type === 'message' && entry.message.role === 'toolResult' && entry.message.toolName === 'update_goal') boundary('receipt')
  return value
}
const update = modules.GoalStorage.prototype.update
let failedOnce = false
modules.GoalStorage.prototype.update = function (...args) {
  const value = update.apply(this, args)
  if (input.phase === 'claim' && value.run?.state === 'claimed' && value.autoRuns === 1) boundary('claim')
  if (input.phase === 'initial-claim' && value.run?.state === 'claimed') boundary('initial-claim')
  if (input.phase === 'usage' && value.tokens > 0) boundary('usage')
  if (input.phase === 'disk-write' && value.run?.state === 'claimed' && value.autoRuns === 1 && !failedOnce) {
    failedOnce = true
    setImmediate(() => { assert.equal(f.managed.goals.snapshot.reason, 'storage'); assert.equal(f.requests.length, 1); boundary('disk-write') })
    throw Object.assign(new Error('Injected EIO after durable claim'), { code: 'EIO' })
  }
  return value
}
if (input.phase === 'lock') {
  let charged = false
  const rename = fs.renameSync, fsync = fs.fsyncSync
  fs.renameSync = function (from, to) {
    const value = rename.call(this, from, to)
    if (String(to).endsWith('.json') && String(to).startsWith(join(f.userData, 'goals') + '/') && !String(to).includes('/input/')) {
      const ledger = JSON.parse(fs.readFileSync(to, 'utf8'))
      if (ledger.run?.state === 'claimed' && ledger.autoRuns === 1) charged = true
    }
    return value
  }
  fs.fsyncSync = function (fd) { const value = fsync.call(this, fd); if (charged) boundary('lock'); return value }
  syncBuiltinESMExports()
}
if (input.phase === 'plan') f.managed.goals.host.available = () => false
f.setRespond(n => {
  if (input.phase === 'stop') { queueMicrotask(() => f.app.abort()); return [text('In-flight result.')] }
  if (['receipt', 'final', 'dismiss', 'rewind'].includes(input.phase)) {
    if (n === 1) return [tool('read', { path: join(f.project, 'verified.txt') })]
    if (n === 2) {
      const g = f.managed.goals.snapshot
      return [tool('update_goal', { goalId: g.id, criteriaRevision: g.criteriaRevision, status: 'complete', evidence: 'Checked the committed file.',
        claims: g.criteria.map(c => ({ criterionId: c.id, evidence: 'Committed read matches the current version.', evidenceIds: g.evidenceResults.filter(r => r.status === 'success').map(r => r.id).slice(0, 1) })) })]
    }
    return [text('Verified.')]
  }
  return [text('Continue from committed progress.')]
})
const result = await call('create', { objective: 'Implement and verify the goal.', acceptance: 'Result matches the committed inspection.',
  limits: { maxAutoRuns: input.phase === 'fork' ? 1 : 4, tokenBudget: null }, files: input.attachments ? ['input.txt','input.bin','large.txt'].map(name=>join(f.project,name)) : [], images: input.attachments ? [image] : [] })
assert.equal(result.ok, true)
if(input.phase==='dismiss'){
  await until(()=>f.managed.goals.snapshot.status==='completed'&&idle())
  await call('dismiss')
}
if (input.phase === 'plan') await f.app.setSessionMode({ sessionPath: f.managed.path, mode: 'plan' })
if (input.phase === 'rewind') {
  await until(() => f.managed.goals.snapshot.status === 'completed' && idle())
  const checkpoints = (await f.app.rewindList(f.managed.path)).value.checkpoints
  await fs.promises.writeFile(join(f.project, 'baseline.txt'), 'Changed after the goal.\n')
  const preview = await f.app.rewindPreview(f.managed.path, checkpoints[0].id)
  const workerCall = f.app.rewindClient.call.bind(f.app.rewindClient)
  f.app.rewindClient.call = async (...args) => {
    const value = await workerCall(...args)
    if (args[0] === 'finish' && args[4] === true) boundary('rewind')
    return value
  }
  const restored = await f.app.rewindRestore({ sessionPath: f.managed.path, token: preview.value.token, mode: 'all', operationId: randomUUID() })
  assert.equal(restored.error, undefined)
}
if (input.phase === 'fork') {
  await until(() => f.managed.goals.snapshot.reason === 'runs' && idle())
  const assistant = f.manager.getBranch().findLast(e => e.type === 'message' && e.message.role === 'assistant')
  const forked = await f.app.forkFromMessage(assistant.message.timestamp)
  boundary('fork', f.app.sessions.get(forked.snapshot.sessionPath))
}
await until(() => false)
