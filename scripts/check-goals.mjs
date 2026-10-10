/** Real SDK receipts, autonomous runs and durable accounting in an isolated profile. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile, readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createPlanFixture, submitFixturePlan } from './lib/plan-fixture.mjs'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(predicate, label = 'condition') {
  for (let i = 0; i < 600; i++) { if (await predicate()) return; await sleep(10) }
  assert.fail(`Timed out: ${label}`)
}
const call = (f, action, data = {}) => f.app.goalAction({ sessionPath: f.managed.path, expectedSeq: f.managed.goals.seq, goalId: f.managed.goals.snapshot?.id ?? null, action, ...data })
const create = (f, limits = { maxAutoRuns: 20, tokenBudget: null }) => call(f, 'create', { objective: 'Implement the requested change', acceptance: 'Verify the actual result', limits })
const idle = f => f.session.isIdle && !f.managed.goals.preparing
const tool = (id, name, args) => ({ type: 'toolCall', id, name, arguments: args })
const text = text => ({ type: 'text', text })
const goal = f => f.managed.goals.snapshot
const fixtures = []
async function fixture(options) { const f = await createPlanFixture(options); fixtures.push(f); await f.managed.lifecyclePromise; return f }
try {
  const f = await fixture({ withRewind: true })
  await writeFile(join(f.project, 'baseline.txt'), 'baseline\n')
  f.setRespond(n => n === 1 ? [text('Continue implementing.')] : n === 2 ?
    [tool('goal-complete', 'update_goal', { goalId: goal(f).id, status: 'complete', evidence: 'Acceptance criterion verified against the actual result.' })] : [text('Implemented and verified.')])
  assert.equal((await create(f)).ok, true)
  await until(() => goal(f)?.status === 'completed' && idle(f), 'completed goal')
  assert.equal(goal(f).autoRuns, 1)
  assert.equal(goal(f).tokens, 6)
  const branch = f.manager.getBranch()
  assert.equal(branch.filter(e => e.type === 'message' && e.message.role === 'user').length, 1, 'only the explicit goal start adds a user turn')
  assert.equal(branch.filter(e => e.type === 'custom_message' && e.customType === 'pith_goal_step_v1').length, 1, 'automatic runs are hidden continuations')
  assert.equal(f.store.getState().goal.status, 'completed')
  assert.equal(f.store.getState().isStreaming, false, 'completion clears the autonomous run hint')
  assert(f.events.filter(e => e.type === 'goal_update').every(e => e.eventSequence === undefined), 'goal revisions never consume transcript sequence')
  const seq = f.managed.goals.seq
  assert.equal((await f.app.goalAction({ sessionPath: f.managed.path, expectedSeq: seq - 1, goalId: goal(f).id, action: 'pause' })).code, 'stale')
  const completed = goal(f)
  f.store.dispatch({ type: 'goal_update', sessionPath: f.managed.path, goal: { ...completed, status: 'paused' }, goalSeq: seq - 1 })
  assert.equal(f.store.getState().goal.status, 'completed', 'older metadata cannot revert the goal')
  f.store.applySnapshot({ ...f.app.snapshot(), goal: null, goalSeq: seq - 1 })
  assert.equal(f.store.getState().goal.status, 'completed', 'older snapshots cannot clear the goal')
  const checkpoints = await f.app.rewindList(f.managed.path)
  assert.equal(checkpoints.error, undefined)
  assert.equal(checkpoints.value.checkpoints.length, 1, 'hidden goal continuations never create a checkpoint')
  const preview = await f.app.rewindPreview(f.managed.path, checkpoints.value.checkpoints[0].id)
  assert.equal(preview.error, undefined)
  const rewind = await f.app.rewindRestore({ sessionPath: f.managed.path, token: preview.value.token, mode: 'conversation', operationId: randomUUID() })
  assert.equal(rewind.error, undefined)
  assert.equal(goal(f).status, 'paused')
  assert.equal(goal(f).reason, 'rewound')
  assert.equal(goal(f).tokens, 6)
  assert.equal(goal(f).autoRuns, 1)
  await sleep(40)
  assert.equal(f.requests.length, 3, 'Rewind never wakes the restored historical active goal')

  // Hold wake admission while the goal is live: the reviewed leaf must remain
  // valid, and file-only restore must preserve the exact conversation leaf.
  const available = f.managed.goals.host.available
  f.managed.goals.host.available = () => false
  assert.equal((await call(f, 'resume')).ok, true)
  assert.equal(goal(f).status, 'active')
  await writeFile(join(f.project, 'baseline.txt'), 'user change\n')
  const livePreview = await f.app.rewindPreview(f.managed.path, checkpoints.value.checkpoints[0].id)
  assert.equal(livePreview.error, undefined)
  const beforeFiles = f.manager.getLeafId()
  const filesRestore = await f.app.rewindRestore({ sessionPath: f.managed.path, token: livePreview.value.token, mode: 'files', operationId: randomUUID() })
  assert.equal(filesRestore.error, undefined, 'suspending a live goal cannot invalidate its reviewed preview')
  assert.equal(f.manager.getLeafId(), beforeFiles, 'file-only Rewind preserves the exact SDK leaf')
  assert.equal(goal(f).status, 'paused')
  assert.equal(await readFile(join(f.project, 'baseline.txt'), 'utf8'), 'baseline\n')
  f.managed.goals.host.available = available

  // Interrupted Rewind owns exact before/after endpoints. Reopening an active
  // goal must not append a pause entry ahead of transaction recovery.
  const checkpoint = checkpoints.value.checkpoints[0]
  const recoveryPreview = await f.app.rewindPreview(f.managed.path, checkpoint.id)
  assert.equal(recoveryPreview.error, undefined)
  const operationId = randomUUID()
  await f.app.rewindClient.call('prepare', f.project, f.session.sessionId, recoveryPreview.value.token, 'conversation', operationId, f.manager.getLeafId(), checkpoint.entryId, f.managed.path)
  await f.app.rewindLeaf(f.managed, checkpoint.entryId, operationId)
  assert.equal(f.manager.getLeafEntry().customType, 'pith_rewind_selection')
  f.app.checkoutCoordinator.setRecovery(f.project, operationId)
  const firstModules = await import(pathToFileURL(join(f.temporary, 'modules.mjs')).href)
  await f.app.disposeManaged(f.managed)
  const recovering = await f.app.buildSession(firstModules.SessionManager.open(f.managed.path))
  await recovering.lifecyclePromise
  assert.equal(recovering.recoveryOnly, true)
  assert.equal(recovering.goals.snapshot.status, 'paused')
  const recoveredRewind = await f.app.rewindRecover(recovering.path, operationId)
  assert.equal(recoveredRewind.error, undefined, 'Goal restoration preserves Rewind crash-journal endpoints')
  assert.equal(f.app.activeSession.goals.snapshot.tokens, 6)
  assert.equal(f.app.activeSession.goals.snapshot.autoRuns, 1)
  assert.equal(f.app.activeSession.goals.snapshot.status, 'paused')
  assert.equal(f.requests.length, 3)

  const changed = await fixture()
  changed.setRespond(n => n === 1 ? [tool('early-completion', 'update_goal', { goalId: goal(changed).id, status: 'complete', evidence: 'Original state verified.' })] :
    n === 2 ? [tool('after-completion-write', 'write', { path: join(changed.project, 'result.txt'), content: 'changed after the receipt\n' })] :
    n === 4 ? [tool('new-completion', 'update_goal', { goalId: goal(changed).id, status: 'complete', evidence: 'Rechecked the changed result.' })] : [text('Done.')])
  await create(changed)
  await until(() => goal(changed)?.status === 'completed' && idle(changed), 'fresh completion after mutation')
  assert.equal(changed.requests.length, 5)
  assert.equal(goal(changed).evidence, 'Rechecked the changed result.', 'a later mutation invalidates an earlier completion receipt')
  assert.equal(await readFile(join(changed.project, 'result.txt'), 'utf8'), 'changed after the receipt\n')

  const capped = await fixture({ respond: () => [text('Some work remains.')] })
  await create(capped, { maxAutoRuns: 1, tokenBudget: null })
  await until(() => goal(capped)?.reason === 'runs' && idle(capped), 'run cap')
  assert.equal(capped.requests.length, 2)
  assert.equal(goal(capped).tokens, 4)
  assert.equal((await call(capped, 'resume')).code, 'quota')
  assert.equal((await call(capped, 'limits', { limits: { maxAutoRuns: 2, tokenBudget: null } })).ok, true)
  assert.equal((await call(capped, 'resume')).ok, true)
  await until(() => goal(capped)?.reason === 'runs' && idle(capped), 'resumed cap')
  assert.equal(goal(capped).autoRuns, 2)
  assert.equal(goal(capped).tokens, 6, 'resume never replenishes usage')
  assert.equal((await capped.app.setSessionMode({ sessionPath: capped.managed.path, mode: 'plan' })).ok, true)
  assert.equal((await call(capped, 'resume')).code, 'plan')
  assert.equal((await capped.app.setSessionMode({ sessionPath: capped.managed.path, mode: 'normal' })).ok, true)
  assert.equal(goal(capped).status, 'paused', 'leaving Plan does not silently resume')
  const capFiles = await readdir(join(capped.userData, 'goals'))
  await unlink(join(capped.userData, 'goals', capFiles.find(name => name.endsWith('.json'))))
  assert.equal((await call(capped, 'limits', { limits: { maxAutoRuns: 4, tokenBudget: null } })).ok, true)
  assert.equal((await call(capped, 'resume')).code, 'storage')
  assert.equal(goal(capped).accountingAvailable, false)
  assert.equal(capped.requests.length, 3, 'a deleted existing ledger never becomes a zero-usage goal')
  capped.app.prompt({ text: 'Explain the committed results', images: [], files: [] })
  await until(() => capped.requests.length === 4 && idle(capped), 'ordinary explicit work remains available with a failed goal ledger')
  assert.equal(goal(capped).reason, 'storage')

  // Stop closes ownership even in the gap before the SDK starts its turn.
  const stopped = await fixture({ respond: () => [text('Unfinished')] })
  const enter = stopped.app.checkoutCoordinator.enter.bind(stopped.app.checkoutCoordinator)
  let releasePreparation
  const prepared = new Promise(resolve => { releasePreparation = resolve })
  stopped.app.checkoutCoordinator.enter = async (...args) => { await prepared; return enter(...args) }
  await create(stopped)
  stopped.app.abort()
  releasePreparation()
  await until(() => idle(stopped), 'Stop during goal preparation')
  assert.equal(goal(stopped).status, 'paused')
  assert.equal(goal(stopped).reason, 'stopped')
  assert.equal(stopped.requests.length, 0)
  stopped.app.checkoutCoordinator.enter = enter
  assert.equal((await call(stopped, 'resume')).ok, true)
  await until(() => goal(stopped)?.reason === 'no_progress' && idle(stopped), 'explicit resume after Stop')
  assert.equal(stopped.requests.length, 3)

  const quitting = await fixture({ respond: () => [text('Must not run after Quit')] })
  const quitEnter = quitting.app.checkoutCoordinator.enter.bind(quitting.app.checkoutCoordinator)
  let releaseQuitPreparation
  const quitPreparation = new Promise(resolve => { releaseQuitPreparation = resolve })
  quitting.app.checkoutCoordinator.enter = async (...args) => { await quitPreparation; return quitEnter(...args) }
  await create(quitting)
  const shutdown = quitting.app.dispose()
  releaseQuitPreparation()
  await shutdown; await quitting.managed.goals.idle()
  assert.equal(quitting.requests.length, 0)
  assert.equal(goal(quitting).reason, 'interrupted')
  assert.equal((await call(stopped, 'cancel')).ok, true)
  assert.equal(goal(stopped).status, 'cancelled')
  await sleep(40)
  assert.equal(stopped.requests.length, 3)

  const answered = await fixture()
  answered.setRespond(n => n === 1 ? [tool('async-goal-question', 'ask_user_question', { mode: 'async', questions: [{ question: 'Choose the output format', options: [{ label: 'Text' }, { label: 'JSON' }] }] })] :
    n === 3 ? [tool('answered-complete', 'update_goal', { goalId: goal(answered).id, status: 'complete', evidence: 'The preserved answer was consumed and the selected format verified.' })] : [text('Waiting or verified.')])
  await create(answered, { maxAutoRuns: 1, tokenBudget: null })
  await until(() => goal(answered)?.waiting && idle(answered), 'goal waits for async question')
  assert.equal(answered.requests.length, 2)
  const question = answered.events.findLast(e => e.type === 'ask_user' && e.requests.length)?.requests[0]
  assert(question)
  assert.equal((await call(answered, 'pause')).ok, true)
  assert.equal(answered.app.respondAskUser(question.requestId, answered.managed.path, { answers: [{ question: 'Choose the output format', selected: ['JSON'] }] }), true)
  await sleep(30)
  assert.equal(answered.requests.length, 2, 'answer cannot wake a paused goal')
  assert.equal((await call(answered, 'resume')).ok, true)
  await until(() => goal(answered)?.status === 'completed' && idle(answered), 'Resume consumes preserved async answer')
  assert.equal(answered.requests.length, 4)
  assert.equal(answered.manager.getBranch().filter(e => e.type === 'custom_message' && e.customType === 'ask_user_answer').length, 1)
  assert.equal(goal(answered).autoRuns, 0, 'the existing answer wake is not a duplicate goal continuation')

  const interrupted = await fixture({ respond: () => [text('Work remains.')] })
  await create(interrupted, { maxAutoRuns: 1, tokenBudget: null })
  await until(() => goal(interrupted)?.reason === 'runs' && idle(interrupted))
  const prior = interrupted.manager.getBranch().findLast(e => e.type === 'message' && e.message.role === 'assistant').message
  const unfinished = { ...structuredClone(prior), timestamp: Date.now(), stopReason: 'aborted', content: [text('Usable partial goal progress.'),
    { type: 'thinking', thinking: 'Quoted partial reasoning.' }, { type: 'thinking', thinking: 'redacted-private', redacted: true },
    tool('never-executed', 'write', { path: join(interrupted.project, 'unfinished.txt'), content: 'must not be executed' })],
    usage: { ...prior.usage, input: 0, output: 0, totalTokens: 0 } }
  interrupted.manager.appendMessage(unfinished)
  interrupted.session.agent.state.messages = [...interrupted.session.messages, unfinished]
  interrupted.managed.goals.restore('interrupted')
  assert.equal((await call(interrupted, 'limits', { limits: { maxAutoRuns: 3, tokenBudget: null } })).ok, true)
  interrupted.setRespond(n => n === 3 ? [tool('interrupted-complete', 'update_goal', { goalId: goal(interrupted).id, status: 'complete', evidence: 'Continued the usable frontier and verified the result.' })] : [text('Verified.')])
  assert.equal((await call(interrupted, 'resume')).ok, true)
  await until(() => goal(interrupted)?.status === 'completed' && idle(interrupted), 'Resume preserves interrupted frontier')
  const quoted = interrupted.requests[2].messages.findLast(m => m.role === 'user' && JSON.stringify(m.content).includes('unexecutedToolCall'))
  assert(quoted, 'Goal Resume reuses Continue\'s partial-output context')
  assert(JSON.stringify(quoted.content).includes('Usable partial goal progress.'))
  assert(!JSON.stringify(quoted.content).includes('redacted-private'))
  await assert.rejects(readFile(join(interrupted.project, 'unfinished.txt')), { code: 'ENOENT' })

  const tokenCapped = await fixture()
  await writeFile(join(tokenCapped.project, 'input.txt'), 'real input\n')
  tokenCapped.setRespond(() => [tool('read-budget', 'read', { path: join(tokenCapped.project, 'input.txt') })])
  await create(tokenCapped, { maxAutoRuns: 20, tokenBudget: 2 })
  await until(() => goal(tokenCapped)?.reason === 'tokens' && idle(tokenCapped), 'token cap inside SDK turn')
  assert.equal(tokenCapped.requests.length, 1, 'the next primary request never reaches the provider')
  assert.equal(goal(tokenCapped).tokens, 2)
  assert.equal(goal(tokenCapped).autoRuns, 0)

  const stalled = await fixture({ respond: () => [text('Still working, without new evidence.')] })
  await create(stalled)
  await until(() => goal(stalled)?.reason === 'no_progress' && idle(stalled), 'no progress')
  assert.equal(stalled.requests.length, 3, 'three settled runs without new evidence pause')
  assert.equal(stalled.store.getState().isStreaming, false, 'a pause decided after settlement clears the continuation hint')

  const todo = await fixture()
  todo.setRespond(n => n === 1 ? [tool('todo-pending', 'todo_write', { todos: [{ content: 'Verify result', status: 'pending' }] })] :
    n === 2 ? [tool('premature-complete', 'update_goal', { goalId: goal(todo).id, status: 'complete', evidence: 'Claimed completion with an unfinished task.' })] : [text('Not verified yet.')])
  await create(todo, { maxAutoRuns: 1, tokenBudget: null })
  await until(() => goal(todo)?.status === 'paused' && idle(todo), 'unfinished Todo keeps completion provisional')
  assert.notEqual(goal(todo).status, 'completed')
  assert.equal(todo.managed.todos.snapshot.items[0].status, 'pending')

  const reviewed = await fixture()
  let reviews = 0
  reviewed.app.jevService.options.fetch = async (_url, init) => {
    const input = JSON.parse(init.body)
    if (input.questions.review) reviews++
    const answers = Object.fromEntries(Object.entries(input.questions).map(([id, question]) => {
      const choice = id === 'route' ? 'act' : 'complete'
      return [id, { type: 'choice', choice, confidence: 1, probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, key === choice ? 1 : 0])) }]
    }))
    return new Response(JSON.stringify({ model: 'jev-1.13.0', answers, usage: { input_tokens: 30, output_tokens: 5 } }), { status: 200 })
  }
  assert.equal((await reviewed.app.updateJevSettings({ apiKey: 'goal-fixture' })).ok, true)
  assert.equal((await reviewed.app.updateJevSettings({ preferences: { mode: 'workflow', choice: true, score: true, noul: true } })).ok, true)
  reviewed.setRespond(n => n === 1 ? [tool('reviewed-write', 'write', { path: join(reviewed.project, 'reviewed.txt'), content: 'verified change\n' })] :
    n === 2 ? [tool('reviewed-complete', 'update_goal', { goalId: goal(reviewed).id, status: 'complete', evidence: 'The requested file was written and verified.' })] : [text('Implemented and verified.')])
  await create(reviewed)
  await until(() => goal(reviewed)?.status === 'completed' && idle(reviewed), 'Goal waits for Jev review')
  assert(reviews > 0)
  assert.equal(reviewed.managed.jevWorkflow.snapshot.phase, 'completed')

  const plan = await fixture()
  assert.equal((await plan.app.setSessionMode({ sessionPath: plan.managed.path, mode: 'plan' })).ok, true)
  assert.equal((await create(plan)).code, 'plan')
  assert(plan.session.getActiveToolNames().includes('get_goal'))
  assert(!plan.session.getActiveToolNames().includes('update_goal'), 'Plan cannot mutate the goal through model tools')
  await submitFixturePlan(plan)
  assert.equal((await call(plan, 'create', { objective: 'Do work', acceptance: 'Verified', limits: { maxAutoRuns: 2, tokenBudget: null } })).code, 'plan', 'goal cannot bypass exact approval')

  // Simulate a hard crash between committed SDK usage and accounting, then reopen.
  const recovered = await fixture({ respond: () => [text('Not complete.')] })
  await create(recovered, { maxAutoRuns: 1, tokenBudget: null })
  await until(() => goal(recovered)?.reason === 'runs' && idle(recovered))
  const modules = await import(pathToFileURL(join(recovered.temporary, 'modules.mjs')).href)
  const storage = new modules.GoalStorage(recovered.userData, recovered.session.sessionId)
  const oldGoal = goal(recovered)
  const entries = recovered.manager.getEntries()
  const latestAssistant = entries.findLast(e => e.type === 'message' && e.message.role === 'assistant')
  storage.update(oldGoal.id, l => {
    l.tokens -= 2; l.billed = l.billed.filter(id => id !== latestAssistant.id)
    l.run = { id: 'crashed-dispatch', state: 'started', before: entries.filter(e => e.id !== latestAssistant.id).map(e => e.id) }
  })
  recovered.manager.appendCustomEntry('pith_goal_v1', { ...oldGoal, status: 'active', reason: null })
  // Disconnect without orderly goal teardown; ledger and branch mimic a killed process.
  recovered.managed.unsubscribe(); recovered.session.dispose(); recovered.app.sessions.delete(recovered.managed.path)
  const fresh = await recovered.app.buildSession(modules.SessionManager.open(recovered.managed.path))
  await fresh.lifecyclePromise
  assert.equal(fresh.goals.snapshot.status, 'paused')
  assert.equal(fresh.goals.snapshot.reason, 'interrupted')
  assert.equal(fresh.goals.snapshot.autoRuns, 1)
  storage.update(oldGoal.id, l => { l.run = { id: 'claimed-before-crash', state: 'claimed', before: recovered.manager.getEntries().map(e => e.id) } })
  fresh.goals.restore('interrupted')
  assert.equal(storage.read(oldGoal.id).run, null)
  assert.equal(fresh.goals.snapshot.tokens, 4)
  assert.equal(recovered.requests.length, 2, 'a claimed dispatch is never replayed either')
  assert.equal(fresh.goals.snapshot.tokens, 4, 'crash recovery bills the committed result once')
  assert.equal(storage.read(oldGoal.id).run, null, 'old claimed/started dispatch is consumed, never replayed')
  await sleep(40)
  assert.equal(recovered.requests.length, 2)
  fresh.goals.restore('rewound')
  assert.equal(fresh.goals.snapshot.tokens, 4, 'branch restores cannot refund usage')
  assert.equal(fresh.goals.snapshot.autoRuns, 1)

  const ledgerFiles = await readdir(join(recovered.userData, 'goals'))
  const ledgerPath = join(recovered.userData, 'goals', ledgerFiles.find(name => name.endsWith('.json')))
  const original = await readFile(ledgerPath, 'utf8')
  await writeFile(ledgerPath, '{broken')
  fresh.goals.restore('interrupted')
  assert.equal(fresh.goals.snapshot.reason, 'storage', 'corrupt accounting fails closed')
  await writeFile(ledgerPath, original)
  console.log('PASS goals: receipts, Todo, continuation, quotas, Plan, revisions and crash accounting')
} finally {
  for (const f of fixtures.reverse()) await f.close()
}
