/**
 * ask_user_question, exercised at the layers that own its behaviour: the
 * protocol normalizers (pure), the pending registry (wait/answer/cancel/
 * teardown — including the subagent source-scoped split) and the tool's
 * execute against stub deps. No Electron, no model calls, no user data.
 *
 * The renderer halves (panel, transcript card, PiStore) are covered by their
 * own UI regressions; this check pins the semantics everything downstream
 * depends on: no timeout in production, every teardown path settles, answers
 * validate against the entry's own question list, and a skip is a
 * non-error result the model can continue past.
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const temporary = await mkdtemp(join(tmpdir(), 'pith-ask-user-check-'))

const outfile = join(temporary, 'modules.mjs')
await build({
  stdin: {
    contents: `export { ASK_USER_ANSWER_TYPE, ASK_USER_KIND, ASK_USER_TOOL_NAME, askUserAnswerText, askUserRecordKind, firstAskUserQuestionText, formatAskUserResultText, isAskUserToolDetails, normalizeAskUserAnswers, normalizeAskUserQuestions, normalizePendingAskUser, normalizePendingAskUserList } from './src/shared/ask-user';
export { askUserDetailsOf, clearSessionAskUserRequests, clearSubagentAskUserRequests, createAskUserTool, engageAskUser, listPendingAskUser, respondAskUserRequest, waitForAskUser } from './src/main/pi/ask-user';
export { AskUserNotifications } from './src/main/pi/ask-user-notifications';
export { AskUserRecords, askUserRecordOf, askUserRecordsFromEntries } from './src/main/pi/ask-user-records';`,
    resolveDir: resolve('.')
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile
})

const sandbox = await import(pathToFileURL(outfile).href)
const {
  ASK_USER_ANSWER_TYPE,
  ASK_USER_KIND,
  ASK_USER_TOOL_NAME,
  askUserAnswerText,
  askUserRecordKind,
  firstAskUserQuestionText,
  formatAskUserResultText,
  isAskUserToolDetails,
  normalizeAskUserAnswers,
  normalizeAskUserQuestions,
  normalizePendingAskUser,
  normalizePendingAskUserList,
  askUserDetailsOf,
  AskUserNotifications,
  AskUserRecords,
  askUserRecordOf,
  askUserRecordsFromEntries,
  clearSessionAskUserRequests,
  clearSubagentAskUserRequests,
  createAskUserTool,
  engageAskUser,
  listPendingAskUser,
  respondAskUserRequest,
  waitForAskUser
} = sandbox

const delay = (ms) => new Promise((resolve_) => setTimeout(resolve_, ms))
const OWNER = '/tmp/owner-session.jsonl'
const OTHER = '/tmp/other-session.jsonl'
const CHILD = '/tmp/child-session.jsonl'

const sampleQuestions = [
  {
    question: 'Which database should the migration target?',
    header: 'a-very-long-header-value',
    options: [
      { label: 'Postgres', description: '  Already in staging  ' },
      { label: 'SQLite' }
    ]
  },
  {
    question: 'Ship behind a flag?',
    options: [{ label: 'Yes' }, { label: 'No' }, { label: 'Later', description: 'next sprint' }],
    multiSelect: true
  }
]

// ---- protocol normalizers ----

{
  const normalized = normalizeAskUserQuestions(sampleQuestions)
  assert.ok(normalized, 'valid questions normalize')
  assert.equal(normalized.length, 2)
  assert.equal(normalized[0].question, 'Which database should the migration target?')
  // Header truncates at 12 chars (Claude Code's cap), descriptions trim.
  assert.equal(normalized[0].header, 'a-very-long-')
  assert.equal(normalized[0].options[0].description, 'Already in staging')
  assert.equal(normalized[0].multiSelect, undefined)
  assert.equal(normalized[1].multiSelect, true)
  // No stray fields survive.
  assert.deepEqual(Object.keys(normalized[0]).sort(), ['header', 'options', 'question'])

  // Cap at 4 questions / 4 options.
  const many = normalizeAskUserQuestions(
    Array.from({ length: 6 }, (_, i) => ({ question: `q${i}`, options: [{ label: 'a' }, { label: 'b' }, { label: 'c' }, { label: 'd' }, { label: 'e' }] }))
  )
  assert.equal(many.length, 4)
  assert.equal(many[0].options.length, 4)

  // Anything structurally wrong rejects the WHOLE call — a half-delivered
  // question list is worse than an error.
  for (const bad of [
    undefined, null, 'x', [], [null],
    [{ question: ' ', options: [{ label: 'a' }, { label: 'b' }] }],
    [{ question: 'q', options: [] }],
    [{ question: 'q', options: [{ label: 'a' }] }],
    [{ question: 'q', options: [{ label: 'a' }, { label: ' ' }] }],
    [{ question: 'q' }],
    [{ options: [{ label: 'a' }, { label: 'b' }] }]
  ]) {
    assert.equal(normalizeAskUserQuestions(bad), null, `rejects ${JSON.stringify(bad)}`)
  }
}

{
  const questions = normalizeAskUserQuestions(sampleQuestions)
  const answers = normalizeAskUserAnswers(questions, [
    { selected: ['Postgres', 'Postgres', 'SQLite', 'Nope'], custom: '  ' },
    { selected: ['Yes', 'No'], custom: ' depends on load ' }
  ])
  assert.ok(answers, 'answers normalize')
  // Unknown labels drop, duplicates dedupe, blank custom drops.
  assert.deepEqual(answers[0], { question: questions[0].question, selected: ['Postgres', 'SQLite'] })
  assert.deepEqual(answers[1], { question: questions[1].question, selected: ['Yes', 'No'], custom: 'depends on load' })
  // A question may come back empty (partial answers are honest, not errors).
  const partial = normalizeAskUserAnswers(questions, [{ selected: [] }, {}])
  assert.ok(partial)
  assert.deepEqual(partial[0].selected, [])
  // Alignment is by count and per-entry shape.
  assert.equal(normalizeAskUserAnswers(questions, [{ selected: [] }]), null)
  assert.equal(normalizeAskUserAnswers(questions, 'x'), null)
  assert.equal(normalizeAskUserAnswers(questions, [null, {}]), null)
}

{
  const pending = normalizePendingAskUser({
    requestId: 'r1',
    sessionPath: OWNER,
    questions: sampleQuestions,
    createdAt: 123,
    source: { kind: 'subagent', sessionPath: CHILD, profile: 'explore' }
  })
  assert.ok(pending, 'pending normalizes')
  assert.equal(pending.source.profile, 'explore')
  assert.equal(pending.source.sessionPath, CHILD)
  assert.deepEqual(normalizePendingAskUserList([pending, { junk: true }, null]).map((entry) => entry.requestId), ['r1'])
  for (const bad of [
    {}, { requestId: 'r', sessionPath: OWNER, questions: sampleQuestions, createdAt: 'x' },
    { requestId: 'r', sessionPath: ' ', questions: sampleQuestions, createdAt: 1 },
    { requestId: 'r', sessionPath: OWNER, questions: [], createdAt: 1 }
  ]) {
    assert.equal(normalizePendingAskUser(bad), null, `rejects ${JSON.stringify(bad)}`)
  }
}

{
  assert.ok(isAskUserToolDetails({ kind: ASK_USER_KIND, status: 'answered', questions: [], answers: [] }))
  assert.ok(isAskUserToolDetails({ kind: ASK_USER_KIND, status: 'cancelled', questions: [], answers: null }))
  assert.equal(isAskUserToolDetails({ kind: 'pi-web-ask-user', status: 'answered' }), false)
  assert.equal(isAskUserToolDetails({ kind: ASK_USER_KIND, status: 'timeout' }), false)

  assert.equal(askUserAnswerText({ question: 'q', selected: ['a', 'b'], custom: 'c' }), 'a、b；c')
  assert.equal(askUserAnswerText({ question: 'q', selected: [], custom: undefined }), null)

  assert.equal(firstAskUserQuestionText({ questions: sampleQuestions }), sampleQuestions[0].question)
  assert.equal(firstAskUserQuestionText({ questions: [] }), null)
  assert.equal(firstAskUserQuestionText({ questions: [{ options: [] }] }), null)
  assert.equal(firstAskUserQuestionText('x'), null)

  const cancelledText = formatAskUserResultText('cancelled', sampleQuestions, null)
  assert.ok(cancelledText.includes('dismissed'), 'cancelled text says the user dismissed')
  assert.ok(cancelledText.includes('assumptions'), 'cancelled text tells the model to continue on assumptions')
  const answeredText = formatAskUserResultText('answered', sampleQuestions, [
    { question: 'q', selected: ['Postgres'] },
    { question: 'q', selected: [] }
  ])
  assert.ok(answeredText.includes('2 question(s)'), 'answered text counts questions')
  assert.ok(answeredText.includes('-> Postgres'), 'answered text lists picks')
  assert.ok(answeredText.includes('-> (no answer)'), 'answered text marks unanswered parts')
}

// ---- registry lifecycle ----

{
  // Registration publishes, answering settles with validated answers.
  let changes = 0
  const wait = waitForAskUser({ sessionPath: OWNER, questions: normalizeAskUserQuestions(sampleQuestions) }, () => { changes++ })
  await delay(1)
  assert.equal(listPendingAskUser(OWNER).length, 1)
  assert.equal(changes, 1, 'onChanged fires on registration')
  const entry = listPendingAskUser(OWNER)[0]
  assert.ok(entry.requestId)
  assert.equal(entry.questions.length, 2)
  assert.equal(entry.source, undefined)

  // Wrong owner cannot settle; malformed answers cannot settle.
  assert.equal(respondAskUserRequest(entry.requestId, OTHER, { answers: [] }), false)
  assert.equal(respondAskUserRequest(entry.requestId, OWNER, { answers: [{ selected: [] }] }), false, 'misaligned answers rejected')
  assert.equal(listPendingAskUser(OWNER).length, 1, 'still pending after bad answers')

  // Wrong owner cannot settle; malformed answers cannot settle.
  assert.equal(respondAskUserRequest(entry.requestId, OTHER, { answers: [] }), false)
  assert.equal(respondAskUserRequest(entry.requestId, OWNER, { answers: [{ selected: [] }] }), false, 'misaligned answers rejected')
  assert.equal(listPendingAskUser(OWNER).length, 1, 'still pending after bad answers')

  // A valid answer settles the wait promptly — the race guards against a
  // registry that accepts the answer but never resolves the promise.
  assert.equal(respondAskUserRequest(entry.requestId, OWNER, {
    answers: [
      { question: 'q', selected: ['Postgres'] },
      { question: 'q', selected: ['No'], custom: 'later' }
    ]
  }), true)
  const outcome = await Promise.race([
    wait,
    delay(200).then(() => ({ status: 'hang' }))
  ])
  assert.notEqual(outcome.status, 'hang', 'answer settles the wait')
  assert.equal(outcome.status, 'answered')
  assert.deepEqual(outcome.answers[0].selected, ['Postgres'])
  assert.deepEqual(outcome.answers[1].custom, 'later')
  assert.equal(listPendingAskUser(OWNER).length, 0)
  assert.equal(changes, 2, 'onChanged fires on settle')
}

{
  // Skip (explicit cancel) is a first-class outcome.
  const wait = waitForAskUser({ sessionPath: OWNER, questions: normalizeAskUserQuestions(sampleQuestions) }, () => {})
  const requestId = listPendingAskUser(OWNER)[0].requestId
  assert.equal(respondAskUserRequest(requestId, OWNER, { cancelled: true }), true)
  assert.equal((await wait).status, 'cancelled')
  assert.equal(listPendingAskUser(OWNER).length, 0)
}

{
  // An aborted signal (Stop/Esc/rewind/resend) settles as cancelled and
  // deregisters — the agent loop never hangs on a question.
  const controller = new AbortController()
  const wait = waitForAskUser({ sessionPath: OWNER, questions: normalizeAskUserQuestions(sampleQuestions) }, () => {}, controller.signal)
  controller.abort()
  assert.equal((await wait).status, 'cancelled')
  assert.equal(listPendingAskUser(OWNER).length, 0)

  // A pre-aborted signal never registers at all.
  const pre = new AbortController()
  pre.abort()
  const wait2 = waitForAskUser({ sessionPath: OWNER, questions: normalizeAskUserQuestions(sampleQuestions) }, () => {}, pre.signal)
  assert.equal((await wait2).status, 'cancelled')
  assert.equal(listPendingAskUser(OWNER).length, 0)
}

{
  // clearSessionAskUserRequests is scoped per owning chat.
  const a = waitForAskUser({ sessionPath: OWNER, questions: normalizeAskUserQuestions(sampleQuestions) }, () => {})
  const b = waitForAskUser({ sessionPath: OTHER, questions: normalizeAskUserQuestions(sampleQuestions) }, () => {})
  clearSessionAskUserRequests(OWNER)
  assert.equal((await a).status, 'cancelled')
  assert.equal(listPendingAskUser(OWNER).length, 0)
  assert.equal(listPendingAskUser(OTHER).length, 1, "another chat's question survives")
  clearSessionAskUserRequests(OTHER)
  assert.equal((await b).status, 'cancelled')
}

{
  // A subagent child registers under the PARENT's path with a source marker;
  // child teardown clears only its own questions, the parent key clears both.
  const parentOwn = waitForAskUser({ sessionPath: OWNER, questions: normalizeAskUserQuestions(sampleQuestions) }, () => {})
  const childQuestion = waitForAskUser(
    { sessionPath: OWNER, questions: normalizeAskUserQuestions(sampleQuestions), source: { kind: 'subagent', sessionPath: CHILD, profile: 'explore' } },
    () => {}
  )
  const listed = listPendingAskUser(OWNER)
  assert.equal(listed.length, 2)
  const childEntry = listed.find((entry) => entry.source?.kind === 'subagent')
  assert.ok(childEntry, 'child question listed under the parent path')
  assert.equal(childEntry.source.profile, 'explore')

  clearSubagentAskUserRequests(CHILD)
  assert.equal((await childQuestion).status, 'cancelled')
  assert.equal(listPendingAskUser(OWNER).length, 1, "the parent's own question survives child teardown")

  const secondChild = waitForAskUser(
    { sessionPath: OWNER, questions: normalizeAskUserQuestions(sampleQuestions), source: { kind: 'subagent', sessionPath: CHILD } },
    () => {}
  )
  clearSessionAskUserRequests(OWNER)
  assert.equal((await parentOwn).status, 'cancelled')
  assert.equal((await secondChild).status, 'cancelled', 'owner-key teardown also clears child-sourced questions')
  assert.equal(listPendingAskUser(OWNER).length, 0)
}

// ---- the tool ----

{
  const deps = () => ({ ownerPath: OWNER, onChanged: () => {}, canStart: () => true, timeoutMs: () => 0 })
  const tool = createAskUserTool(deps())

  // Structural arguments.
  assert.equal(tool.name, ASK_USER_TOOL_NAME)
  assert.equal(tool.executionMode, 'sequential')

  // Invalid questions are an error result, not a throw — the model reads the
  // constraint and can fix its next call.
  const invalid = await tool.execute('call-1', { questions: [{ question: 'q', options: [{ label: 'only' }] }] }, undefined)
  assert.equal(invalid.isError, true)
  assert.ok(invalid.content[0].text.includes('Error'))

  // A session mid-teardown resolves as a dismissal instead of registering a
  // question nothing will ever answer.
  const closing = createAskUserTool({ ownerPath: OWNER, onChanged: () => {}, canStart: () => false, timeoutMs: () => 0 })
  const closed = await closing.execute('call-2', { questions: sampleQuestions }, undefined)
  assert.equal(closed.isError, undefined)
  assert.equal(closed.details.status, 'cancelled')
  assert.equal(listPendingAskUser(OWNER).length, 0, 'nothing registered while closing')

  // Answered flow: register → answer → result carries the Q&A details.
  const waitTool = tool.execute('call-3', { questions: sampleQuestions }, undefined)
  await delay(1)
  const pending = listPendingAskUser(OWNER)
  assert.equal(pending.length, 1)
  assert.equal(pending[0].questions[0].question, sampleQuestions[0].question)
  assert.ok(respondAskUserRequest(pending[0].requestId, OWNER, {
    answers: [{ question: 'q', selected: ['Postgres'] }, { question: 'q', selected: ['Yes'] }]
  }))
  const answered = await waitTool
  assert.equal(answered.isError, undefined)
  assert.equal(answered.details.kind, ASK_USER_KIND)
  assert.equal(answered.details.status, 'answered')
  assert.equal(answered.details.answers.length, 2)
  assert.deepEqual(answered.details.answers[0].selected, ['Postgres'])
  assert.ok(answered.content[0].text.includes('-> Postgres'))

  // Skip flow: non-error, model-facing guidance.
  const waitSkip = tool.execute('call-4', { questions: sampleQuestions }, undefined)
  await delay(1)
  const skipEntry = listPendingAskUser(OWNER)[0]
  assert.ok(respondAskUserRequest(skipEntry.requestId, OWNER, { cancelled: true }))
  const skipped = await waitSkip
  assert.equal(skipped.isError, undefined)
  assert.equal(skipped.details.status, 'cancelled')
  assert.equal(skipped.details.answers, null)
  assert.ok(skipped.content[0].text.includes('dismissed'))

  // A child's tool registers under the parent's owner path with its source.
  const childTool = createAskUserTool({
    ownerPath: OWNER,
    source: { kind: 'subagent', sessionPath: CHILD, profile: 'reviewer' },
    onChanged: () => {},
    canStart: () => true,
    timeoutMs: () => 0
  })
  const waitChild = childTool.execute('call-5', { questions: sampleQuestions }, undefined)
  await delay(1)
  const childPending = listPendingAskUser(OWNER)[0]
  assert.equal(childPending.source.sessionPath, CHILD)
  assert.equal(childPending.source.profile, 'reviewer')
  clearSubagentAskUserRequests(CHILD)
  const childOutcome = await waitChild
  assert.equal(childOutcome.details.status, 'cancelled')
}

// ---- engagement, the deadline and async dispatch ----

{
  // The countdown measures ENGAGEMENT: the user's first real interaction
  // cancels it for good, and the fact is published so a re-mounted panel stops
  // drawing one.
  let changes = 0
  const wait = waitForAskUser(
    { sessionPath: OWNER, questions: normalizeAskUserQuestions(sampleQuestions), timeoutMs: 40 },
    () => { changes++ }
  )
  await delay(1)
  const entry = listPendingAskUser(OWNER)[0]
  assert.equal(entry.timeoutMs, 40, 'the deadline travels with the pending set')
  assert.equal(entry.engaged, undefined, 'a fresh question is not engaged')
  assert.equal(engageAskUser(entry.requestId, OTHER), false, 'another chat cannot engage it')
  assert.equal(engageAskUser(entry.requestId, OWNER), true, 'the owning chat engages it')
  assert.equal(changes, 2, 'engagement is republished')
  assert.equal(listPendingAskUser(OWNER)[0].engaged, true, 'the published set carries it')
  assert.equal(engageAskUser(entry.requestId, OWNER), false, 'engaging twice is a no-op')
  await delay(60)
  assert.equal(listPendingAskUser(OWNER).length, 1, 'an engaged question never expires')
  respondAskUserRequest(entry.requestId, OWNER, { answers: [{ selected: ['Postgres'] }, { selected: [] }] })
  assert.equal((await wait).status, 'answered', 'and still answers normally')
}

{
  // Nobody ever touched it: the deadline settles the set itself.
  const wait = waitForAskUser(
    { sessionPath: OWNER, questions: normalizeAskUserQuestions(sampleQuestions), timeoutMs: 30 },
    () => {}
  )
  const outcome = await Promise.race([wait, delay(600).then(() => ({ status: 'hang' }))])
  assert.equal(outcome.status, 'cancelled', 'an untouched question closes itself')
  assert.equal(outcome.reason, 'timeout', 'and says why')
  assert.equal(listPendingAskUser(OWNER).length, 0, 'and leaves the pending list')
  const timeoutText = formatAskUserResultText('cancelled', normalizeAskUserQuestions(sampleQuestions), null, { reason: 'timeout', timeoutSeconds: 30 })
  assert.ok(timeoutText.includes('did not answer'), 'the model is told it timed out')
  assert.ok(timeoutText.includes('30 seconds'), 'with the deadline it waited on')
  assert.ok(timeoutText.includes('assumptions'), 'and to continue on assumptions, not to re-ask')
}

{
  // A zero deadline means no timer at all; the question waits like it always did.
  const wait = waitForAskUser(
    { sessionPath: OWNER, questions: normalizeAskUserQuestions(sampleQuestions), timeoutMs: 0 },
    () => {}
  )
  await delay(30)
  assert.equal(listPendingAskUser(OWNER).length, 1, 'no deadline configured keeps it open')
  respondAskUserRequest(listPendingAskUser(OWNER)[0].requestId, OWNER, { cancelled: true })
  assert.equal((await wait).reason, 'dismissed', 'a user dismissal reports itself as one')
}

{
  // An interrupted run reads as interrupted, not as a user choice.
  const controller = new AbortController()
  const wait = waitForAskUser(
    { sessionPath: OWNER, questions: normalizeAskUserQuestions(sampleQuestions), timeoutMs: 5_000 },
    () => {},
    controller.signal
  )
  controller.abort()
  const outcome = await wait
  assert.equal(outcome.status, 'cancelled')
  assert.equal(outcome.reason, 'aborted', 'an aborted signal is not a dismissal')
  assert.equal(listPendingAskUser(OWNER).length, 0)
}

{
  // Async mode: the call returns a receipt at once and the outcome is handed to
  // the session's outbox later — the question stays answerable either way.
  const deliveries = []
  const tool = createAskUserTool({
    ownerPath: OWNER,
    onChanged: () => {},
    canStart: () => true,
    timeoutMs: () => 5_000,
    deliverAsync: (delivery) => deliveries.push(delivery)
  })
  const receipt = await tool.execute('call-async', { mode: 'async', questions: sampleQuestions }, undefined)
  assert.equal(receipt.isError, undefined, 'an async dispatch is not an error')
  assert.equal(receipt.details.status, 'pending', 'it answers with a receipt')
  assert.equal(receipt.details.mode, 'async', 'marked async')
  assert.equal(receipt.details.answers, null, 'with no answers yet')
  assert.equal(isAskUserToolDetails(receipt.details), true, 'the receipt is a valid tool-details payload')
  assert.ok(receipt.content[0].text.includes('did not block'), 'the model is told it is not blocking')
  assert.ok(receipt.content[0].text.includes('arrive as a message'), 'and where the answer will show up')
  assert.equal(deliveries.length, 0, 'nothing is delivered before the user answers')

  const pending = listPendingAskUser(OWNER)
  assert.equal(pending.length, 1, 'the async question is still registered for the panel')
  assert.equal(pending[0].mode, 'async', 'the panel can tell it is async')
  assert.equal(pending[0].timeoutMs, 5_000, 'and carries the deadline')
  assert.equal(respondAskUserRequest(pending[0].requestId, OWNER, {
    answers: [{ selected: ['Postgres'] }, { selected: ['Yes'] }]
  }), true)
  await delay(1)
  assert.equal(deliveries.length, 1, 'the answer is handed to the outbox')
  assert.equal(deliveries[0].toolCallId, 'call-async', 'anchored to the receipt it answers')
  assert.equal(deliveries[0].details.status, 'answered')
  assert.equal(deliveries[0].details.mode, 'async')
  assert.ok(deliveries[0].text.includes('-> Postgres'), 'with the answers in the text')
  assert.equal(listPendingAskUser(OWNER).length, 0, 'and the question is gone')
}

{
  // An async question OUTLIVES the call that asked it: the call's abort signal
  // belongs to the call, and the user may answer long after it returned.
  const deliveries = []
  const controller = new AbortController()
  const tool = createAskUserTool({
    ownerPath: OWNER,
    onChanged: () => {},
    canStart: () => true,
    timeoutMs: () => 0,
    deliverAsync: (delivery) => deliveries.push(delivery)
  })
  const receipt = await tool.execute('call-detached', { mode: 'async', questions: sampleQuestions }, controller.signal)
  assert.equal(receipt.details.status, 'pending')
  controller.abort()
  await delay(1)
  assert.equal(listPendingAskUser(OWNER).length, 1, 'aborting the finished call leaves the question open')
  assert.equal(deliveries.length, 0, 'and delivers nothing')
  // Teardown is what ends it — and it says the run went away, not that the user
  // said no.
  clearSessionAskUserRequests(OWNER)
  await delay(1)
  assert.equal(listPendingAskUser(OWNER).length, 0)
  assert.equal(deliveries.length, 1, 'teardown delivers the cancellation')
  assert.equal(deliveries[0].details.reason, 'aborted')
}

{
  // The tool's own mode parameter defaults to blocking, and an unknown value
  // falls back to it rather than silently going async.
  const tool = createAskUserTool({
    ownerPath: OWNER,
    onChanged: () => {},
    canStart: () => true,
    timeoutMs: () => 0
  })
  const calls = [tool.execute('call-block', { questions: sampleQuestions }, undefined)]
  await delay(1)
  assert.equal(listPendingAskUser(OWNER)[0].mode, 'blocking', 'the default mode is blocking')
  respondAskUserRequest(listPendingAskUser(OWNER)[0].requestId, OWNER, { cancelled: true })
  const blocked = await calls[0]
  assert.equal(blocked.details.mode, 'blocking', 'and the result says so')
  assert.equal(blocked.details.status, 'cancelled')

  const weird = createAskUserTool({
    ownerPath: OWNER,
    onChanged: () => {},
    canStart: () => true,
    timeoutMs: () => 0
  })
  const orphan = weird.execute('call-weird', { mode: 'whenever', questions: sampleQuestions }, undefined)
  await delay(1)
  assert.equal(listPendingAskUser(OWNER)[0].mode, 'blocking', 'an unknown mode falls back to blocking')
  respondAskUserRequest(listPendingAskUser(OWNER)[0].requestId, OWNER, { cancelled: true })
  await orphan
}

{
  // The details helper maps an outcome (or a receipt) onto the transcript card's payload.
  const questions = normalizeAskUserQuestions(sampleQuestions)
  const answered = askUserDetailsOf(questions, 'async', { status: 'answered', answers: [{ question: 'q', selected: ['Yes'] }] })
  assert.equal(answered.status, 'answered')
  assert.equal(answered.mode, 'async')
  assert.equal(answered.reason, undefined)
  const timedOut = askUserDetailsOf(questions, 'blocking', { status: 'cancelled', reason: 'timeout' })
  assert.equal(timedOut.status, 'cancelled')
  assert.equal(timedOut.reason, 'timeout')
  assert.equal(timedOut.answers, null)
  assert.equal(ASK_USER_ANSWER_TYPE, 'ask_user_answer', 'the async notice keeps its custom type')
}

// ---- the async delivery outbox ----
// The class drives the session only through `messages`/`isStreaming`/`isIdle`
// and `sendCustomMessage`, so a fake session exercises every rule that matters:
// the receipt gate, steer-vs-wake, the stopped-run hold and branch loss.

function fakeSession() {
  const received = []
  return {
    messages: [],
    isStreaming: false,
    isIdle: true,
    received,
    sendCustomMessage(message, options) {
      received.push({ message, options })
      return Promise.resolve()
    }
  }
}

const receipt = (toolCallId) => ({ role: 'toolResult', toolCallId, toolName: 'ask_user_question' })
const answerDetails = (questions) => ({
  kind: ASK_USER_KIND,
  status: 'answered',
  questions,
  answers: [{ question: 'q', selected: ['Yes'] }],
  mode: 'async'
})
const timeoutDetails = (questions) => ({
  kind: ASK_USER_KIND,
  status: 'cancelled',
  questions,
  answers: null,
  mode: 'async',
  reason: 'timeout'
})

{
  const questions = normalizeAskUserQuestions(sampleQuestions)
  const session = fakeSession()
  const outbox = new AskUserNotifications(session)
  let wakes = 0
  outbox.onWake = () => { wakes += 1 }
  outbox.settle({ toolCallId: 't1', details: answerDetails(questions), text: 'The user answered 1 question(s): 1. q -> Yes' })
  await delay(1)
  assert.equal(session.received.length, 0, 'nothing is steered before the receipt is in history')
  assert.equal(outbox.hasPendingDeliveries, true, 'but the delivery is owed')

  session.messages.push(receipt('t1'))
  outbox.observe({ type: 'message_end', message: receipt('t1') })
  assert.equal(session.received.length, 1, 'the receipt releases it')
  const [delivery] = session.received
  assert.equal(delivery.message.customType, ASK_USER_ANSWER_TYPE, 'it rides the answer custom type')
  assert.equal(delivery.message.display, true, 'and is visible in the transcript')
  assert.equal(delivery.message.details.toolCallId, 't1', 'anchored to the call it answers')
  assert.equal(delivery.message.details.askUser.status, 'answered', 'carrying the card payload')
  assert.match(delivery.message.content, /not a user instruction/, 'and says it is tool data')
  assert.match(delivery.message.content, /-> Yes/, 'with the answer text')
  assert.equal(delivery.options.deliverAs, 'steer', 'steer, never follow-up')
  assert.equal(delivery.options.triggerTurn, true, 'an answer wakes an idle session')
  assert.equal(wakes, 1, 'and the idle wake reopens the settled turn\u2019s scope')
  assert.equal(outbox.continuesAtSettled, true, 'so the run is not visually over yet')

  // Acknowledged by the SDK consuming it, not by the send resolving.
  outbox.observe({ type: 'message_start', message: { role: 'custom', customType: ASK_USER_ANSWER_TYPE, details: { toolCallId: 't1' } } })
  assert.equal(outbox.continuesAtSettled, false, 'the drain ends the owed wake')
  outbox.observe({ type: 'message_end', message: { role: 'custom', customType: ASK_USER_ANSWER_TYPE, details: { toolCallId: 't1' } } })
  assert.equal(outbox.hasPendingDeliveries, false, 'and the delivery is done')
  outbox.dispose()
}

{
  // A timeout is recorded, never a reason to restart an idle session.
  const questions = normalizeAskUserQuestions(sampleQuestions)
  const session = fakeSession()
  session.messages.push(receipt('t2'))
  const outbox = new AskUserNotifications(session)
  let wakes = 0
  outbox.onWake = () => { wakes += 1 }
  outbox.settle({ toolCallId: 't2', details: timeoutDetails(questions), text: 'The user did not answer within 120 seconds.' })
  assert.equal(session.received.length, 1, 'a settled timeout is delivered at once')
  assert.equal(session.received[0].options.triggerTurn, false, 'without waking an idle session')
  assert.equal(wakes, 0, 'so no turn is reopened for it')
  assert.equal(session.received[0].options.deliverAs, 'steer', 'still a steer, so a live turn sees it')
  assert.equal(outbox.continuesAtSettled, false, 'and nothing looks like it is still running')
  outbox.dispose()
}

{
  // While the model is streaming, both kinds join the live turn.
  const questions = normalizeAskUserQuestions(sampleQuestions)
  const session = fakeSession()
  session.isStreaming = true
  session.isIdle = false
  session.messages.push(receipt('t3'))
  const outbox = new AskUserNotifications(session)
  let wakes = 0
  outbox.onWake = () => { wakes += 1 }
  outbox.settle({ toolCallId: 't3', details: timeoutDetails(questions), text: 'timed out' })
  assert.equal(session.received[0].options.triggerTurn, true, 'a timeout steers into the running turn')
  assert.equal(wakes, 0, 'a steer into the live turn is not a wake')
  outbox.dispose()
}

{
  // Stop/Esc: the answer is kept, but nothing may wake the stopped run.
  const questions = normalizeAskUserQuestions(sampleQuestions)
  const session = fakeSession()
  session.messages.push(receipt('t4'))
  const outbox = new AskUserNotifications(session)
  outbox.pause()
  outbox.settle({ toolCallId: 't4', details: answerDetails(questions), text: 'answered' })
  assert.equal(session.received.length, 0, 'a stopped run is never woken by an answer')
  assert.equal(outbox.hasPendingDeliveries, false, 'and it does not hold the run open')
  outbox.resume()
  assert.equal(session.received.length, 1, 'the next prompt delivers what was owed')
  assert.equal(session.received[0].options.triggerTurn, true, 'a user answer still repays the wake')
  outbox.dispose()
}

{
  // Prompt preparation holds the wake; the hold is released into the prompt.
  const questions = normalizeAskUserQuestions(sampleQuestions)
  const session = fakeSession()
  session.messages.push(receipt('t5'))
  const outbox = new AskUserNotifications(session)
  outbox.holdWake()
  outbox.settle({ toolCallId: 't5', details: answerDetails(questions), text: 'answered' })
  assert.equal(session.received.length, 0, 'a user prompt in preparation is not raced')
  outbox.releaseWake()
  assert.equal(session.received.length, 1, 'releasing the hold delivers')
  outbox.dispose()
}

{
  // A rewind that removed the ask drops the delivery instead of injecting an
  // answer into a branch that no longer asked anything.
  const questions = normalizeAskUserQuestions(sampleQuestions)
  const session = fakeSession()
  const outbox = new AskUserNotifications(session)
  outbox.settle({ toolCallId: 't6', details: answerDetails(questions), text: 'answered' })
  await delay(1)
  assert.equal(session.received.length, 0, 'the receipt never existed')
  outbox.observe({ type: 'agent_settled' })
  assert.equal(outbox.hasPendingDeliveries, false, 'a settled boundary without a receipt drops it')
  session.messages.push(receipt('t6'))
  outbox.flush()
  assert.equal(session.received.length, 0, 'and it stays dropped')
  outbox.dispose()
}

{
  // Teardown throws the outbox away; a disposed session receives nothing.
  const questions = normalizeAskUserQuestions(sampleQuestions)
  const session = fakeSession()
  session.messages.push(receipt('t7'))
  const outbox = new AskUserNotifications(session)
  outbox.dispose()
  outbox.settle({ toolCallId: 't7', details: answerDetails(questions), text: 'answered' })
  outbox.flush()
  assert.equal(session.received.length, 0, 'a disposed session gets nothing')
  assert.equal(outbox.canStart, false)
}

// ---- the Q&A record projection ----
// The panel reads the branch, not the transcript: every ask must stay
// reviewable after a compaction removed it from context, and an async outcome
// must replace the receipt it answers rather than adding a second row.

const questionsForRecords = normalizeAskUserQuestions(sampleQuestions)
const recordToolResult = (toolCallId, details, at) => ({
  type: 'message',
  message: { role: 'toolResult', toolName: 'ask_user_question', toolCallId, details, timestamp: at }
})
const recordNoticeEntry = (toolCallId, details, at) => ({
  // The PERSISTED shape the branch holds: a custom message IS the entry, it is
  // not wrapped in `message` like a user/assistant/toolResult entry.
  type: 'custom_message',
  customType: ASK_USER_ANSWER_TYPE,
  display: true,
  details: { toolCallId, askUser: details },
  timestamp: at
})
const recordNoticeMessage = (toolCallId, details, at) => ({
  // The LIVE shape the observer sees on message_end.
  role: 'custom',
  customType: ASK_USER_ANSWER_TYPE,
  display: true,
  details: { toolCallId, askUser: details },
  timestamp: at
})
const recordAnswered = {
  kind: ASK_USER_KIND,
  status: 'answered',
  questions: questionsForRecords,
  answers: [{ question: questionsForRecords[0].question, selected: ['Postgres'] }]
}
const recordTimeout = { kind: ASK_USER_KIND, status: 'cancelled', questions: questionsForRecords, answers: null, reason: 'timeout' }
const recordReceipt = { kind: ASK_USER_KIND, status: 'pending', questions: questionsForRecords, answers: null, mode: 'async' }

{
  const branch = [
    { type: 'message', message: { role: 'user', content: 'hi', timestamp: 0 } },
    { type: 'custom', customType: 'pith_sandbox_mode' },
    recordToolResult('c1', recordAnswered, 1_000),
    recordToolResult('c2', recordTimeout, 2_000),
    recordToolResult('c3', recordReceipt, 3_000),
    recordNoticeEntry('c3', { ...recordAnswered, mode: 'async' }, 4_000),
    // A legacy pi-web kind, a FAILED call and a hand-mangled question list must
    // all stay out of the record.
    recordToolResult('c4', { ...recordAnswered, kind: 'pi-web-ask-user' }, 5_000),
    { type: 'message', message: { role: 'toolResult', toolName: 'ask_user_question', toolCallId: 'c5', details: recordAnswered, isError: true, timestamp: 6_000 } },
    recordToolResult('c6', { kind: ASK_USER_KIND, status: 'answered', questions: [{ question: 'x', options: [{ label: 'only' }] }] }, 7_000)
  ]
  const records = askUserRecordsFromEntries(branch)
  assert.deepEqual(records.map((record) => record.toolCallId), ['c1', 'c2', 'c3'], 'one record per asking call, oldest first')
  assert.equal(records[0].status, 'answered')
  assert.deepEqual(records[0].answers[0].selected, ['Postgres'], 'the answers are kept')
  assert.equal(records[0].at, 1_000, 'and so is when it settled')
  assert.equal(records[0].questions.length, 2, 'with the questions it asked')
  assert.equal(records[1].status, 'cancelled')
  assert.equal(records[2].status, 'answered', 'an async outcome replaces its own receipt')
  assert.equal(records[2].mode, 'async', 'and is still marked async')
  assert.equal(records[2].at, 4_000, 'with the outcome’s own time')
  assert.equal(records[2].questions.length, 2, 'keeping the questions it answers')
  assert.equal(records.length, 3, 'legacy kinds, failed calls and malformed questions are skipped')

  assert.equal(askUserRecordKind(records[0]), 'answered')
  assert.equal(askUserRecordKind(records[1]), 'timeout')
  assert.equal(askUserRecordKind({ status: 'pending' }), 'pending')
  assert.equal(askUserRecordKind({ status: 'cancelled', reason: 'dismissed' }), 'dismissed')
  assert.equal(askUserRecordKind({ status: 'cancelled', reason: 'aborted' }), 'aborted')
  assert.equal(askUserRecordKind({ status: 'cancelled' }), 'dismissed', 'a legacy cancel reads as a dismissal')

  // The single-message extractor the live observer uses agrees with the fold,
  // and it accepts BOTH shapes: the persisted entry and the live message.
  assert.equal(askUserRecordOf({ role: 'assistant', content: [] }), null)
  assert.equal(askUserRecordOf(recordToolResult('c1', recordAnswered, 1_000).message).toolCallId, 'c1')
  assert.equal(askUserRecordOf(recordNoticeEntry('c1', recordAnswered, 1_000)).at, 1_000, 'the persisted entry shape folds')
  assert.equal(askUserRecordOf(recordNoticeMessage('c1', recordAnswered, 1_000)).at, 1_000, 'and so does the live message shape')
}

{
  // The session-owned projection: incremental on committed results, rebuilt
  // from the branch on a new turn (reopen, rewind, manual leaf move).
  const branch = []
  const state = new AskUserRecords({ getBranch: () => branch })
  assert.deepEqual(state.snapshot, [], 'a fresh session has no records')

  branch.push(recordToolResult('c1', recordAnswered, 1_000))
  state.observe({ type: 'message_end', message: branch[0].message })
  assert.equal(state.snapshot.length, 1, 'a committed result is recorded')
  assert.equal(state.snapshot[0].status, 'answered')

  const before = state.snapshot
  state.observe({ type: 'message_end', message: { role: 'assistant', content: [], timestamp: 10 } })
  assert.equal(state.snapshot, before, 'an unrelated message does not rebuild the list')

  branch.push(recordNoticeEntry('c1', { ...recordAnswered, mode: 'async' }, 2_000))
  state.observe({ type: 'message_end', message: recordNoticeMessage('c1', { ...recordAnswered, mode: 'async' }, 2_000) })
  assert.equal(state.snapshot.length, 1, 'an async outcome updates its own record in place')
  assert.equal(state.snapshot[0].mode, 'async')
  assert.equal(state.snapshot[0].at, 2_000)

  branch.push(recordToolResult('c2', recordTimeout, 3_000))
  state.observe({ type: 'agent_start' })
  assert.equal(state.snapshot.length, 2, 'a new turn re-folds the whole branch')
  assert.deepEqual(state.snapshot.map((record) => askUserRecordKind(record)), ['answered', 'timeout'])

  branch.length = 1
  state.restore()
  assert.equal(state.snapshot.length, 1, 'a rewind drops the record that left the branch')
}

await rm(temporary, { recursive: true, force: true })
console.log('check-ask-user: all assertions passed')