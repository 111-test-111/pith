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
      contents: `export { PiStore } from './src/renderer/src/state/pi-store';\nexport { buildTurns } from './src/renderer/src/lib/chat-turns';`,
      resolveDir: resolve('.')
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile
  })
  const { PiStore, buildTurns } = await import(pathToFileURL(outfile).href)

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
} finally {
  await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
