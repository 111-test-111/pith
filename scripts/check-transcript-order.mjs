/**
 * Transcript ordering with the real PiStore/`buildTurns`: a message that reaches
 * the store after rows it chronologically precedes must still land in its own
 * slot. Regression for the auto-retry error row: `_prepareRetry` strips the
 * errored round from the live agent state, so it re-enters the renderer as a
 * plain event while the retry's rounds are already in the transcript — appending
 * it put that round (and its error disclosure) at the live edge, below content it
 * belongs above. No model calls, no user data.
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const temporary = await mkdtemp(join(tmpdir(), 'pith-order-'))
try {
  const outfile = join(temporary, 'modules.mjs')
  await build({
    stdin: {
      contents: `export { PiStore } from './src/renderer/src/state/pi-store';\nexport { buildTurns, collectChangeScopes } from './src/renderer/src/lib/chat-turns';`,
      resolveDir: resolve('.')
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile
  })
  const { PiStore, buildTurns, collectChangeScopes } = await import(pathToFileURL(outfile).href)

  const user = (timestamp, content = 'keep going') => ({ role: 'user', content, timestamp })
  const round = (timestamp, content, extra = {}) => ({
    role: 'assistant',
    content,
    provider: 'fixture',
    model: 'fixture',
    stopReason: 'toolUse',
    timestamp,
    ...extra
  })
  const call = (id) => ({ type: 'toolCall', id, name: 'read', arguments: { path: 'a.ts' } })
  const result = (timestamp, id) => ({
    role: 'toolResult',
    toolCallId: id,
    toolName: 'read',
    content: [],
    isError: false,
    timestamp
  })
  const errored = (timestamp, errorMessage) =>
    round(timestamp, [{ type: 'thinking', thinking: 'half a thought' }], {
      stopReason: 'error',
      errorMessage
    })
  const snapshot = (sessionPath, messages, eventSequence, isStreaming = true) => ({
    sessionId: 'fixture-session',
    sessionPath,
    cwd: '/fixture',
    projectless: false,
    messages,
    model: null,
    thinkingLevel: 'off',
    isStreaming,
    eventSequence
  })
  const event = (sessionPath, eventSequence, message) => ({
    type: 'message_end',
    sessionPath,
    eventSequence,
    message
  })
  const assistants = (store) =>
    store.getState().messages.filter((message) => message.role === 'assistant').map((message) => message.timestamp)

  // 1. The errored round is not in the rebuilt list (agent state drops it); its
  //    event arrives afterwards, once the retry's rounds are already rendered.
  const live = new PiStore()
  live.applySnapshot(
    snapshot(
      '/live',
      [user(100), round(105, [call('c1')]), result(106, 'c1'), round(107, [call('c2')]), result(108, 'c2')],
      20
    )
  )
  live.dispatch(event('/live', 21, errored(101, 'terminated')))
  assert.deepEqual(assistants(live), [101, 105, 107], 'a late round keeps its chronological slot')
  const messages = live.getState().messages
  assert.deepEqual(
    messages.map((message) => message.timestamp),
    [100, 101, 105, 106, 107, 108],
    'every entry, not just the assistant rounds, stays ordered'
  )
  const turn = buildTurns(messages).find((candidate) => candidate.role === 'assistant')
  assert.deepEqual(
    turn.assistants.map((message) => message.timestamp),
    [101, 105, 107],
    'the errored round opens the retry rounds instead of trailing them'
  )
  assert.notEqual(turn.assistants[turn.assistants.length - 1].timestamp, 101, 'the error row never trails the live edge')
  console.log('PASS: a round arriving after the retry keeps its slot, so its error row renders above the new content.')

  // 2. The path that produced the drift: the event was retained for a background
  //    session and replayed once the rebuilt snapshot was applied.
  const replay = new PiStore()
  replay.applySnapshot(snapshot('/replay', [user(100)], 5, false))
  replay.applySnapshot(snapshot('/other', [user(200)], 9, false))
  replay.dispatch(event('/replay', 10, errored(101, 'terminated')))
  assert.equal(replay.getState().messages.length, 1, 'a background event never touches the visible session')
  replay.applySnapshot(
    snapshot('/replay', [user(100), round(105, [call('c1')]), result(106, 'c1')], 9)
  )
  assert.deepEqual(assistants(replay), [101, 105], 'a replayed event is inserted, not appended')
  console.log('PASS: retained events replayed after a snapshot rebuild land in order.')

  // 3. Equal creation times keep arrival order (rounds can share a millisecond).
  const ties = new PiStore()
  ties.applySnapshot(snapshot('/ties', [user(100), result(101, 'c1')], 1))
  ties.dispatch(event('/ties', 2, result(101, 'c2')))
  assert.deepEqual(
    ties.getState().messages.map((message) => message.role),
    ['user', 'toolResult', 'toolResult'],
    'equal timestamps keep arrival order'
  )
  console.log('PASS: equal timestamps keep arrival order.')

  // 4. Sent messages still replace their optimistic echo (the documented path
  //    that compares against the transcript tail).
  const echo = new PiStore()
  echo.applySnapshot(snapshot('/echo', [], 1, false))
  echo.appendOptimisticUser('hello', [])
  assert.equal(echo.getState().messages[0].__optimistic, true)
  echo.dispatch(event('/echo', 2, { role: 'user', content: 'hello', timestamp: Date.now() }))
  assert.equal(echo.getState().messages.length, 1, 'the echo is replaced, never duplicated')
  assert.equal(echo.getState().messages[0].__optimistic, undefined)
  console.log('PASS: the optimistic user echo is still replaced by its persisted message.')

  // 5. A manual summary is an ordinary process row inside an ongoing turn.
  //    It fixes its position between rounds without ending the display group.
  const compact = new PiStore()
  const before = round(110, [call('before')], { changeScopeId: 'scope', completedAt: 115 })
  const checkpoint = {
    role: 'compactionSummary', timestamp: 120, sessionEntryId: 'checkpoint',
    summary: 'Keep the completed inspection.', tokensBefore: 1000
  }
  const compacted = [user(100), before, result(116, 'before'), checkpoint]
  compact.applySnapshot(snapshot('/compact', compacted, 1))
  const atCompletion = buildTurns(compact.getState().messages)
  assert.deepEqual(atCompletion.map(turn => turn.role), ['user', 'assistant'],
    'compaction must not end the assistant display group')
  assert.deepEqual(atCompletion[1].insertions, [{ beforeRound: 1, message: checkpoint }])
  const after = round(130, [{ type: 'text', text: 'Continued after compaction.' }], {
    changeScopeId: 'scope', completedAt: 140, stopReason: 'stop'
  })
  compact.dispatch(event('/compact', 2, after))
  compact.dispatch({ type: 'agent_settled', sessionPath: '/compact', eventSequence: 3 })
  const afterContinuation = buildTurns(compact.getState().messages)
  assert.deepEqual(afterContinuation.map(turn => turn.role), ['user', 'assistant'],
    'compaction and continuation belong to one assistant display group')
  assert.deepEqual(afterContinuation.map(turn => turn.key), atCompletion.map(turn => turn.key),
    'the original assistant group keeps its identity')
  assert.deepEqual(afterContinuation[1].assistants, [before, after])
  assert.deepEqual(afterContinuation[1].insertions, atCompletion[1].insertions,
    'the summary stays between the original output and the continued round')
  const scope = collectChangeScopes(afterContinuation).get('scope')
  assert.deepEqual(scope.assistants, [before, after], 'a summary boundary does not split file ownership')
  assert.equal(scope.ownerKey, afterContinuation.at(-1).key)
  assert.equal(scope.prompt, compacted[0], 'the scope retains its original checkpoint prompt')
  const reopened = new PiStore()
  reopened.applySnapshot(snapshot('/compact', [...compacted, after], 3, false))
  assert.deepEqual(buildTurns(reopened.getState().messages), afterContinuation, 'reopening keeps the same summary boundary')
  console.log('PASS: manual summaries stay between rounds in the same turn through continuation, settlement and reopening.')

  // 6. Persisted branch order wins over timing: a queued steer can have been
  //    created while compaction was running, before the summary was saved.
  const steering = { ...user(118, 'A queued steer delivered after the summary.'), queuedDelivery: 'steer' }
  const secondSteer = { ...steering, content: 'Another steer at the same round boundary.' }
  const steered = buildTurns([...compacted, steering, secondSteer, after])
  assert.deepEqual(steered.map(turn => turn.role), ['user', 'assistant'], 'queued steers share the opening turn')
  assert.deepEqual(steered[1].assistants, [before, after])
  assert.deepEqual(steered[1].insertions.map(({ beforeRound, message }) => [beforeRound, message]),
    [[1, checkpoint], [1, steering], [1, secondSteer]], 'steers retain their delivered order after compaction')
  assert.equal(collectChangeScopes(steered).get('scope').prompt, compacted[0], 'review stays anchored to the opening user')
  const sameTick = buildTurns([user(100), before, checkpoint, { ...after, timestamp: 120 }])
  assert.deepEqual(sameTick[1].insertions, [{ beforeRound: 1, message: checkpoint }],
    'a summary and its continuation sharing a millisecond keep persisted order')
  const delivery = { role: 'custom', customType: 'bash_task_completion', display: true, timestamp: 121, content: 'Finished' }
  const withDelivery = buildTurns([...compacted, delivery, after])
  assert.deepEqual(withDelivery[1].insertions, [{ beforeRound: 1, message: checkpoint }, { beforeRound: 1, message: delivery }],
    'compaction and background completion rows share persisted order at the same round boundary')
  console.log('PASS: summaries respect persisted branch order across queued steering and equal timestamps.')

  // 7. Older model-context snapshots put the summary first. Place that legacy
  //    header by message time before grouping, retaining its slot in the turn.
  const legacy = { ...checkpoint, sessionEntryId: undefined }
  const legacyTurns = buildTurns([legacy, ...compacted.slice(0, -1), after])
  assert.deepEqual(legacyTurns.map(turn => turn.role), ['user', 'assistant'])
  assert.deepEqual(legacyTurns[1].insertions, [{ beforeRound: 1, message: legacy }])
  const branch = { role: 'branchSummary', timestamp: 120, summary: 'Branch checkpoint.', fromId: null }
  assert.deepEqual(buildTurns([branch, ...compacted.slice(0, -1), after]).map(turn => turn.role),
    ['user', 'assistant', 'info', 'assistant'], 'legacy branch summaries use the same boundary rule')
  console.log('PASS: legacy context headers retain their historical slot inside the turn; branch summaries retain their own boundary.')

  const followUp = { ...user(101, 'Queued before the opening response started.'), queuedDelivery: 'followUp', completedAt: 150 }
  compact.dispatch({ ...event('/compact', 4, followUp), changeScopeId: 'follow-up-scope' })
  assert.equal(compact.getState().activeChangeScopeId, 'follow-up-scope', 'delivery switches the scope before the next partial')
  const later = round(155, [{ type: 'text', text: 'Follow-up reply.' }], { changeScopeId: 'follow-up-scope' })
  compact.dispatch(event('/compact', 5, later))
  const retry = { ...errored(145, 'late retry'), changeScopeId: 'scope' }
  compact.dispatch(event('/compact', 6, retry))
  const followed = buildTurns(compact.getState().messages)
  assert.deepEqual(followed.map(turn => turn.role), ['user', 'assistant', 'user', 'assistant'])
  assert.deepEqual(followed[1].assistants, [before, after, retry], 'late retry stays above the queued follow-up')
  assert.deepEqual(followed[3].assistants, [later])
  assert.equal(collectChangeScopes(followed).get('follow-up-scope').prompt, followUp)
  console.log('PASS: follow-up delivery opens a separate scope and preserves earlier assistant history.')
} finally {
  await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
