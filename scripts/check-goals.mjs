/** Real SDK receipts, autonomous runs and durable accounting in an isolated profile. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile, readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createPlanFixture, submitFixturePlan } from './lib/plan-fixture.mjs'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
function deferred() { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
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
const evidenceRead = (f, id = 'read-proof') => tool(id, 'read', { path: join(f.project, 'fixture-evidence.txt') })
const completion = (f, evidence) => ({ goalId: goal(f).id, criteriaRevision: goal(f).criteriaRevision, status: 'complete', evidence, claims: goal(f).criteria.map(c => ({ criterionId: c.id, evidence, evidenceIds: goal(f).evidenceResults.filter(r => r.status === 'success').slice(0, 1).map(r => r.id) })) })
const fixtures = []
async function fixture(options) { const f = await createPlanFixture(options); fixtures.push(f); await f.managed.lifecyclePromise; await writeFile(join(f.project, 'fixture-evidence.txt'), 'A committed verification fixture.\n'); return f }
try {
  const f = await fixture({ withRewind: true })
  await writeFile(join(f.project, 'baseline.txt'), 'baseline\n')
  f.setRespond(n => n === 1 ? [text('Continue implementing.')] : n === 2 ? [evidenceRead(f)] : n === 3 ?
    [tool('goal-complete', 'update_goal', completion(f, 'Acceptance criterion verified against the actual result.'))] : [text('Implemented and verified.')])
  assert.equal((await create(f)).ok, true)
  await until(() => goal(f)?.status === 'completed' && idle(f), 'completed goal')
  assert.equal(goal(f).autoRuns, 1)
  assert.equal(goal(f).tokens, 8)
  const branch = f.manager.getBranch()
  const completeResult=branch.find(e=>e.type==='message'&&e.message.role==='toolResult'&&e.message.toolName==='update_goal'&&!e.message.isError)
  assert(completeResult.message.content.some(c=>c.type==='text'&&c.text.includes('Completed in the Goal panel means finalization is already finished.')),'committed tool receipts explain automatic finalization instead of promising a later review')
  assert(JSON.stringify(f.requests.at(-1).messages).includes('there is no later system-review job'),'the model receives truthful final-reply guidance')
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
  assert.equal(goal(f).tokens, 8)
  assert.equal(goal(f).autoRuns, 1)
  await sleep(40)
  assert.equal(f.requests.length, 4, 'Rewind never wakes the restored historical active goal')

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
  const workerCall = f.app.rewindClient.call.bind(f.app.rewindClient)
  const restoreGate = deferred()
  let restorePreparing = false
  f.app.rewindClient.call = async (...args) => {
    if (args[0] === 'list') { restorePreparing = true; await restoreGate.promise }
    return workerCall(...args)
  }
  const restoringFiles = f.app.rewindRestore({ sessionPath: f.managed.path, token: livePreview.value.token, mode: 'files', operationId: randomUUID() })
  await until(() => restorePreparing, 'Rewind preparing under branch reservation')
  f.managed.goals.host.available = available
  for (const action of ['resume', 'pause', 'cancel']) assert.equal((await call(f, action)).code, 'busy', `${action} cannot modify Rewind's reviewed leaf`)
  assert.throws(() => f.app.prompt({ text: 'Racing user turn', images: [], files: [] }), /in progress/)
  f.app.abort()
  assert.equal(f.manager.getLeafId(), beforeFiles, 'Stop during Rewind cannot append a Goal transition')
  assert.equal(f.requests.length, 4)
  restoreGate.resolve()
  const filesRestore = await restoringFiles
  f.app.rewindClient.call = workerCall
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
  const recoveryLeaf = recovering.session.sessionManager.getLeafId()
  for (const action of ['resume', 'pause', 'cancel', 'limits', 'criteria']) {
    const result = await f.app.goalAction({ sessionPath: recovering.path, expectedSeq: recovering.goals.seq, goalId: recovering.goals.snapshot.id, action })
    assert.equal(result.code, 'busy', 'Rewind crash recovery fences every Goal mutation')
  }
  assert.equal(recovering.session.sessionManager.getLeafId(), recoveryLeaf)
  const recoveredRewind = await f.app.rewindRecover(recovering.path, operationId)
  assert.equal(recoveredRewind.error, undefined, 'Goal restoration preserves Rewind crash-journal endpoints')
  assert.equal(f.app.activeSession.goals.snapshot.tokens, 8)
  assert.equal(f.app.activeSession.goals.snapshot.autoRuns, 1)
  assert.equal(f.app.activeSession.goals.snapshot.status, 'paused')
  assert.equal(f.requests.length, 4)

  const changed = await fixture()
  changed.setRespond(n => n === 1 ? [evidenceRead(changed)] : n === 2 ? [tool('early-completion', 'update_goal', completion(changed, 'Original state verified.'))] :
    n === 3 ? [tool('after-completion-write', 'write', { path: join(changed.project, 'result.txt'), content: 'changed after the receipt\n' })] :
    n === 5 ? [tool('new-completion', 'update_goal', completion(changed, 'Rechecked the changed result.'))] : [text('Done.')])
  await create(changed)
  await until(() => goal(changed)?.status === 'completed' && idle(changed), 'fresh completion after mutation')
  assert.equal(changed.requests.length, 6)
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
  const stopped = await fixture({ withRewind: true, respond: () => [text('Unfinished')] })
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
  assert.equal(goal(stopped).autoRuns, 3, 'Resume of an unaccepted initial input still spends a new dispatch')
  assert.equal(stopped.manager.getBranch().filter(e => e.type === 'message' && e.message.role === 'user').length, 1)
  assert.equal((await stopped.app.rewindList(stopped.managed.path)).value.checkpoints.length, 1, 'Resume before first admission creates its normal Rewind checkpoint')

  // A killed process may have defined/claimed its first turn without committing
  // a user entry. Reopening grants no work; explicit Resume needs a checkpoint.
  const unaccepted = await fixture({ withRewind: true, respond: () => [text('Work remains.')] })
  unaccepted.managed.goals.host.available = () => false
  assert.equal((await create(unaccepted, { maxAutoRuns: 1, tokenBudget: null })).ok, true)
  const pendingModules = await import(pathToFileURL(join(unaccepted.temporary, 'modules.mjs')).href)
  const pendingStorage = new pendingModules.GoalStorage(unaccepted.userData, unaccepted.session.sessionId)
  const pendingId = goal(unaccepted).id
  pendingStorage.update(pendingId, l => { l.run = { id: 'unaccepted-first-claim', state: 'claimed', before: unaccepted.manager.getEntries().map(e => e.id) } })
  unaccepted.managed.unsubscribe(); unaccepted.session.dispose(); unaccepted.app.sessions.delete(unaccepted.managed.path)
  const reopened = await unaccepted.app.buildSession(pendingModules.SessionManager.open(unaccepted.managed.path))
  await reopened.lifecyclePromise
  const resumedFirst = { ...unaccepted, managed: reopened, session: reopened.session, manager: reopened.session.sessionManager }
  assert.equal(goal(resumedFirst).reason, 'interrupted')
  assert.equal(goal(resumedFirst).autoRuns, 0)
  assert.equal(pendingStorage.read(pendingId).run, null)
  const reopenedLeaf = resumedFirst.manager.getLeafId()
  reopened.goals.restore('interrupted')
  assert.equal(resumedFirst.manager.getLeafId(), reopenedLeaf, 'Goal recovery preserves the exact initialized branch leaf')
  assert.equal(resumedFirst.manager.getBranch().filter(e => e.type === 'custom' && e.customType === 'pith_goal_v1').length, 1, 'reopening never appends a Goal transition')
  await sleep(40)
  assert.equal(unaccepted.requests.length, 0, 'recovery never replays an unaccepted claim')
  assert.equal((await call(resumedFirst, 'resume')).ok, true)
  await until(() => goal(resumedFirst)?.reason === 'runs' && idle(resumedFirst), 'first input after process recovery')
  assert.equal(unaccepted.requests.length, 1)
  assert.equal(goal(resumedFirst).autoRuns, 1)
  assert.equal(resumedFirst.manager.getBranch().filter(e => e.type === 'message' && e.message.role === 'user').length, 1)
  assert.equal((await resumedFirst.app.rewindList(reopened.path)).value.checkpoints.length, 1)

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
    n === 3 ? [evidenceRead(answered)] : n === 4 ? [tool('answered-complete', 'update_goal', completion(answered, 'The preserved answer was consumed and the selected format verified.'))] : [text('Waiting or verified.')])
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
  assert.equal(answered.requests.length, 5)
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
  interrupted.setRespond(n => n === 3 ? [evidenceRead(interrupted)] : n === 4 ? [tool('interrupted-complete', 'update_goal', completion(interrupted, 'Continued the usable frontier and verified the result.'))] : [text('Verified.')])
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

  // Plan takes its lock before awaiting Goal drainage. Resume/End cannot
  // enter that gap, and rejected manual work cannot rewrite verification.
  const stalledAvailable = stalled.managed.goals.host.available
  stalled.managed.goals.host.available = () => false
  assert.equal((await call(stalled, 'resume')).ok, true)
  const goalIdle = stalled.managed.goals.idle.bind(stalled.managed.goals)
  const planGate = deferred()
  stalled.managed.goals.idle = () => planGate.promise
  const enteringPlan = stalled.app.setSessionMode({ sessionPath: stalled.managed.path, mode: 'plan' })
  assert.equal(stalled.managed.plan.transitionBusy, true, 'Plan locks synchronously before Goal drainage')
  for (const action of ['resume', 'pause', 'cancel']) assert.equal((await call(stalled, action)).code, 'busy')
  assert.equal(stalled.requests.length, 3)
  planGate.resolve()
  assert.equal((await enteringPlan).ok, true)
  stalled.managed.goals.idle = goalIdle
  assert.equal((await stalled.app.setSessionMode({ sessionPath: stalled.managed.path, mode: 'normal' })).ok, true)
  assert.equal(goal(stalled).status, 'paused')
  stalled.managed.goals.save({ status: 'verifying', reason: null, evidence: 'A committed verification candidate.' })
  const rejectedLeaf = stalled.manager.getLeafId()
  const transitionGate = deferred()
  const transitioning = stalled.managed.plan.transition(async () => {}, () => transitionGate.promise)
  assert.throws(() => stalled.app.prompt({ text: 'Rejected during transition', images: [], files: [] }), /in progress/)
  await assert.rejects(stalled.app.resendMessage({ timestamp: 1, text: 'Rejected resend', images: [] }), /in progress/)
  assert.equal(stalled.manager.getLeafId(), rejectedLeaf, 'rejected work must not append a Goal entry')
  assert.equal(goal(stalled).status, 'verifying')
  transitionGate.resolve(); await transitioning
  stalled.managed.goals.host.available = stalledAvailable
  await call(stalled, 'pause')

  // A manual prompt holds admission through async file preparation. Goal
  // wakes cannot spend a claim or insert a hidden step ahead of that prompt.
  const manual = await fixture({ respond: () => [text('More work remains.')] })
  await create(manual)
  await until(() => goal(manual)?.reason === 'no_progress' && idle(manual))
  const manualAvailable = manual.managed.goals.host.available
  manual.managed.goals.host.available = () => false
  await call(manual, 'resume')
  const manualGate = deferred()
  const readBlocks = manual.app.readFileBlocks.bind(manual.app)
  manual.app.readFileBlocks = async (...args) => { await manualGate.promise; return readBlocks(...args) }
  manual.app.prompt({ text: 'Inspect my new evidence', images: [], files: [] })
  manual.managed.goals.host.available = manualAvailable
  manual.managed.goals.flush()
  await sleep(20)
  assert.equal(manual.requests.length, 3)
  assert.equal(goal(manual).autoRuns, 2, 'preparation cannot spend automatic allowance')
  assert.equal((await call(manual, 'resume')).code, 'busy')
  assert.equal((await manual.app.setSessionMode({ sessionPath: manual.managed.path, mode: 'plan' })).code, 'busy')
  assert.equal(goal(manual).status, 'active', 'a refused Plan transition cannot interrupt admitted manual preparation')
  manual.setRespond(n => n === 4 ? [evidenceRead(manual)] : n === 5 ? [tool('manual-complete', 'update_goal', completion(manual, 'Verified the new user evidence.'))] : [text('Verified.')])
  manualGate.resolve()
  await until(() => goal(manual)?.status === 'completed' && idle(manual), 'manual work releases Goal verification')
  assert.equal(manual.requests.length, 6)
  assert.equal(goal(manual).autoRuns, 2)
  assert.equal(goal(manual).tokens, 12, 'a live Goal bills manual work once without counting an extra dispatch')
  assert(manual.requests[3].messages.some(message => message.role === 'user' && JSON.stringify(message.content).includes('Inspect my new evidence')))

  // Creation returns while attachments are still being read. The actual first
  // turn preserves the composer text/images, uses a user checkpoint, and is
  // excluded from the automatic continuation count.
  const attached = await fixture({ withRewind: true })
  const attachmentPath = join(attached.project, 'attachment.txt')
  await writeFile(attachmentPath, 'Attached evidence\n')
  const attachmentGate = deferred()
  let attachmentPreparing = false
  const attachmentInput = attached.managed.goals.inputs.load.bind(attached.managed.goals.inputs)
  attached.managed.goals.inputs.load = async (...args) => { attachmentPreparing = true; await attachmentGate.promise; return attachmentInput(...args) }
  attached.setRespond(n => n === 1 ? [evidenceRead(attached)] : n === 2 ? [tool('attachment-complete', 'update_goal', completion(attached, 'Verified the attached request.'))] : [text('Verified.')])
  const image = { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==' }
  assert.equal((await call(attached, 'create', { objective: 'Verify my attachments', acceptance: 'Verify my attachments', limits: { maxAutoRuns: 2, tokenBudget: null }, files: [attachmentPath], images: [image] })).ok, true)
  await until(() => attachmentPreparing, 'initial attachment preparation')
  assert.equal(attached.requests.length, 0, 'Goal IPC returns before the first provider request')
  assert.equal(goal(attached).status, 'active')
  attachmentGate.resolve()
  await until(() => goal(attached)?.status === 'completed' && idle(attached), 'attached Goal completed')
  assert.equal(goal(attached).autoRuns, 0)
  const attachedUser = attached.manager.getBranch().find(e => e.type === 'message' && e.message.role === 'user').message
  assert.deepEqual(attachedUser.content.filter(part => part.type === 'image'), [image])
  assert(attachedUser.content.find(part => part.type === 'text').text.startsWith('Verify my attachments\n\n'))
  assert(attachedUser.content.find(part => part.type === 'text').text.includes('Attached evidence'))
  assert.equal((await attached.app.rewindList(attached.managed.path)).value.checkpoints.length, 1)

  // A kill before the consumption tombstone plus Rewind must not make an
  // already accepted attachment look pending again on the historical branch.
  const savedInput=attached.managed.goals.inputs.directory(goal(attached).id)
  await unlink(join(savedInput,'consumed.json'))
  const attachmentCheckpoint=(await attached.app.rewindList(attached.managed.path)).value.checkpoints[0]
  const attachmentPreview=await attached.app.rewindPreview(attached.managed.path,attachmentCheckpoint.id)
  assert.equal((await attached.app.rewindRestore({sessionPath:attached.managed.path,token:attachmentPreview.value.token,mode:'conversation',operationId:randomUUID()})).error,undefined)
  assert.equal(goal(attached).pendingInput.available,false,'off-branch accepted input remains consumed even without its old tombstone')
  const beforeReplacement=attached.requests.length,attachmentUsage=goal(attached).tokens
  assert.equal((await call(attached,'resume')).code,'attachments')
  assert.equal(attached.requests.length,beforeReplacement)
  await unlink(join(savedInput,'receipt.json'))
  attached.setRespond(()=>[text('Replacement input retained.')])
  const replacement='Use this replacement input; the earlier attachment stays consumed.'
  attached.app.prompt({text:replacement,images:[],files:[]})
  await until(()=>attached.requests.length===beforeReplacement+1&&idle(attached),'manual replacement after unavailable saved input')
  assert.equal(goal(attached).pendingInput,undefined,'a new explicit prompt supersedes missing saved input')
  assert.equal(goal(attached).accountingAvailable,true,'a missing input receipt cannot corrupt lifetime accounting')
  assert.equal(goal(attached).tokens,attachmentUsage,'an ordinary prompt in a paused goal does not resume owned billing')
  assert.equal((await call(attached,'definition',{objective:'Verify the explicitly replaced input',criteriaRevision:goal(attached).criteriaRevision,
    criteria:goal(attached).criteria.map(c=>({id:c.id,text:'The new input is verified'}))})).ok,true)
  await call(attached,'limits',{limits:{maxAutoRuns:1,tokenBudget:null}})
  assert.equal((await call(attached,'resume')).ok,true)
  await until(()=>goal(attached).reason==='runs'&&idle(attached),'resume after manual replacement')
  assert.equal(attached.requests.length,beforeReplacement+2)
  assert.equal(attached.manager.getBranch().filter(e=>e.type==='message'&&e.message.role==='user').length,1,'Resume reuses the replacement user entry instead of the old attachment prompt')
  assert(JSON.stringify(attached.requests.at(-1).messages).includes(replacement))

  const transformed = await fixture({ extensionFactories: [pi => pi.on('input', event => ({ action: 'transform', text: `${event.text}\nExtension context.`, images: event.images }))] })
  transformed.setRespond(n => n === 1 ? [text('Work remains.')] : n === 2 ? [evidenceRead(transformed)] : n === 3 ? [tool('transformed-complete', 'update_goal', completion(transformed, 'Verified the transformed input.'))] : [text('Verified.')])
  await create(transformed)
  await until(() => goal(transformed)?.status === 'completed' && idle(transformed), 'transformed initial Goal')
  assert.equal(goal(transformed).autoRuns, 1, 'SDK input transformation cannot turn continuations into repeated uncharged initial prompts')
  assert.equal(transformed.manager.getBranch().filter(e => e.type === 'message' && e.message.role === 'user').length, 1)
  assert(JSON.stringify(transformed.requests[0]).includes('Extension context.'))

  const handled = await fixture({ extensionFactories: [pi => pi.on('input', () => ({ action: 'handled' }))] })
  await create(handled)
  await until(() => goal(handled)?.reason === 'error' && idle(handled), 'handled Goal input releases ownership')
  assert.equal(handled.requests.length, 0)
  assert.equal(goal(handled).autoRuns, 0)

  // Cancellation reaches the fresh SDK signal after async input hooks. A
  // later explicit prompt waits for that old preparation, then retains its
  // own async answer wakes without a duplicate Goal continuation.
  const hookGate = deferred()
  let hookPreparing = false, inputs = 0
  const hooked = await fixture({ extensionFactories: [pi => pi.on('input', async () => {
    if (++inputs === 1) { hookPreparing = true; await hookGate.promise }
  })] })
  await create(hooked)
  await until(() => hookPreparing, 'Goal SDK input hook preparation')
  hooked.setRespond(n => n === 1 ? [tool('hooked-question', 'ask_user_question', { mode: 'async', questions: [{ question: 'Choose output', options: [{ label: 'Text' }, { label: 'JSON' }] }] })] :
    n === 3 ? [evidenceRead(hooked)] : n === 4 ? [tool('hooked-complete', 'update_goal', completion(hooked, 'Consumed the superseding instructions and their answer.'))] : [text('Waiting or answered.')])
  hooked.app.prompt({ text: 'Superseding user instructions', images: [], files: [] })
  await sleep(20)
  assert.equal(hooked.requests.length, 0)
  hookGate.resolve()
  await until(() => hooked.requests.length === 2 && idle(hooked), 'new prompt after cancelled Goal hook')
  const hookedQuestion = hooked.events.findLast(e => e.type === 'ask_user' && e.requests.length)?.requests[0]
  assert(hookedQuestion)
  assert.equal(hooked.app.respondAskUser(hookedQuestion.requestId, hooked.managed.path, { answers: [{ question: 'Choose output', selected: ['JSON'] }] }), true)
  await until(() => hooked.requests.length === 5 && goal(hooked)?.status === 'completed' && idle(hooked), 'superseding prompt answer wake')
  assert(hooked.requests.every(request => !request.messages.some(message => message.role === 'user' && Array.isArray(message.content) && message.content.some(part => part.type === 'text' && part.text === 'Implement the requested change'))), 'the superseded initial prompt never reaches the provider')
  assert.equal(goal(hooked).autoRuns, 0)

  // Resend remains an ordinary explicit user turn in a paused Goal chat. Its
  // async answer owner must still be allowed to wake without resuming Goal.
  const resent = await fixture({ respond: () => [text('Work remains.')] })
  await create(resent, { maxAutoRuns: 1, tokenBudget: null })
  await until(() => goal(resent)?.reason === 'runs' && idle(resent))
  const resentUser = resent.manager.getBranch().find(e => e.type === 'message' && e.message.role === 'user').message
  resent.setRespond(n => n === 3 ? [tool('resent-question', 'ask_user_question', { mode: 'async', questions: [{ question: 'Choose a format', options: [{ label: 'Text' }, { label: 'JSON' }] }] })] : [text('Waiting or answered.')])
  await resent.app.resendMessage({ timestamp: resentUser.timestamp, text: resentUser.content, images: [] })
  await until(() => resent.requests.length === 4 && idle(resent), 'ordinary resend waits for its answer')
  const resentQuestion = resent.events.findLast(e => e.type === 'ask_user' && e.requests.length)?.requests[0]
  assert(resentQuestion)
  assert.equal(resent.app.respondAskUser(resentQuestion.requestId, resent.managed.path, { answers: [{ question: 'Choose a format', selected: ['JSON'] }] }), true)
  await until(() => resent.requests.length === 5 && idle(resent), 'Resend answer wakes the explicit user turn')
  assert.equal(goal(resent).status, 'paused')
  assert.equal(goal(resent).tokens, 4)
  assert.equal(goal(resent).autoRuns, 1)

  const todo = await fixture()
  todo.setRespond(n => n === 1 ? [evidenceRead(todo)] : n === 2 ? [tool('todo-pending', 'todo_write', { todos: [{ content: 'Verify result', status: 'pending' }] })] :
    n === 3 ? [tool('premature-complete', 'update_goal', completion(todo, 'Claimed completion with an unfinished task.'))] : [text('Not verified yet.')])
  await create(todo, { maxAutoRuns: 1, tokenBudget: null })
  await until(() => goal(todo)?.status === 'paused' && idle(todo), 'unfinished Todo keeps completion provisional')
  assert.notEqual(goal(todo).status, 'completed')
  assert.equal(todo.managed.todos.snapshot.items[0].status, 'pending')

  const reviewed = await fixture()
  let reviews = 0
  const reviewGoals = []
  reviewed.app.jevService.options.fetch = async (_url, init) => {
    const input = JSON.parse(init.body)
    if (input.questions.review) { reviews++; reviewGoals.push(JSON.parse(input.state).goal) }
    const answers = Object.fromEntries(Object.entries(input.questions).map(([id, question]) => {
      const choice = id === 'route' ? 'act' : 'complete'
      return [id, { type: 'choice', choice, confidence: 1, probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, key === choice ? 1 : 0])) }]
    }))
    return new Response(JSON.stringify({ model: 'jev-1.13.0', answers, usage: { input_tokens: 30, output_tokens: 5 } }), { status: 200 })
  }
  assert.equal((await reviewed.app.updateJevSettings({ apiKey: 'goal-fixture' })).ok, true)
  assert.equal((await reviewed.app.updateJevSettings({ preferences: { mode: 'workflow', choice: true, score: true, noul: true } })).ok, true)
  reviewed.setRespond(n => n === 1 ? [tool('reviewed-write', 'write', { path: join(reviewed.project, 'reviewed.txt'), content: 'verified change\n' })] :
    n === 2 ? [tool('reviewed-complete', 'update_goal', completion(reviewed, 'The requested file was written and verified.'))] : [text('Implemented and verified.')])
  await create(reviewed)
  await until(() => goal(reviewed)?.status === 'completed' && idle(reviewed), 'Goal waits for Jev review')
  assert(reviews > 0)
  assert.equal(reviewed.managed.jevWorkflow.snapshot.phase, 'completed')
  assert.equal(goal(reviewed).billing.jevTokens, reviewed.managed.jevWorkflow.snapshot.jevInput + reviewed.managed.jevWorkflow.snapshot.jevOutput, 'workflow router/review service usage joins the owned Goal pool independently of primary SDK tokens')
  assert.equal(goal(reviewed).billing.parentTokens, reviewed.requests.length * 2)
  assert.equal(goal(reviewed).tokens, goal(reviewed).billing.parentTokens + goal(reviewed).billing.jevTokens)
  assert(reviewGoals.every(g => g?.id === goal(reviewed).id && g.criteriaRevision === 1 && g.criteria.length === 1), 'Jev reviews the explicit Goal criteria')
  assert.equal(reviewed.managed.jevWorkflow.snapshot.goalReviewKey, reviewGoals.at(-1).key)
  const reviewedKey = reviewGoals.at(-1).key, reviewedTokens = goal(reviewed).tokens
  const reviewedAvailable = reviewed.managed.goals.host.available
  reviewed.managed.goals.host.available = () => false
  const criterion = goal(reviewed).criteria[0]
  assert.equal((await call(reviewed, 'criteria', { criteriaRevision: 1, criteria: [{ id: criterion.id, text: 'Verify the revised requested file' }] })).ok, true)
  assert.equal(goal(reviewed).criteria[0].proof, null)
  assert.equal(goal(reviewed).tokens, reviewedTokens)
  assert.equal(reviewed.managed.jevWorkflow.snapshot, null, 'criteria edits invalidate the old independent review')
  assert.equal((await call(reviewed, 'resume')).ok, true)
  assert.notEqual(reviewed.managed.goals.reviewKey(), reviewedKey)
  assert.equal(reviewed.managed.goals.host.review(), 'waiting', 'an old completed Jev phase cannot certify edited criteria')
  await call(reviewed, 'pause'); reviewed.managed.goals.host.available = reviewedAvailable

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
  fresh.goals.restore('interrupted')
  const freshCall = (action, data = {}) => recovered.app.goalAction({ sessionPath: fresh.path, expectedSeq: fresh.goals.seq, goalId: fresh.goals.snapshot.id, action, ...data })
  assert.equal((await freshCall('limits', { limits: { maxAutoRuns: 3, tokenBudget: null } })).ok, true)
  const durableUpdate = fresh.goals.store.update.bind(fresh.goals.store)
  let failClaim = true
  fresh.goals.store.update = (...args) => {
    const committed = durableUpdate(...args)
    // Model the crash/failure window after atomic replacement, before the
    // caller observes directory fsync success. Disk keeps the charged claim.
    if (failClaim && committed.run?.state === 'claimed') { failClaim = false; throw new Error('claim-fsync-response-lost') }
    return committed
  }
  assert.equal((await freshCall('resume')).ok, true)
  await until(() => fresh.goals.snapshot.reason === 'storage' && fresh.session.isIdle && !fresh.goals.preparing, 'lost durable claim acknowledgement')
  assert.equal(recovered.requests.length, 2, 'a failed claim acknowledgement cannot reach the provider')
  assert.equal(storage.read(oldGoal.id).autoRuns, 2)
  fresh.goals.store.update = durableUpdate
  fresh.goals.restore('interrupted')
  assert.equal(fresh.goals.snapshot.autoRuns, 2, 'recovery retains the durable charge, never the stale in-memory amount')
  assert.equal(fresh.goals.snapshot.tokens, 4)
  assert.equal(storage.read(oldGoal.id).run, null)
  assert.equal(recovered.requests.length, 2, 'claim recovery never automatically replays')
  console.log('PASS goals: receipts, Todo, continuation, quotas, Plan, revisions and crash accounting')
} finally {
  for (const f of fixtures.reverse()) await f.close()
}
