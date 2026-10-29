/**
 * Pi can finish several codemode calls at different times but publish their
 * toolResult messages together. Their displayed durations must use each
 * tool_execution_end, rather than the batch's final message_end time.
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const temporary = await mkdtemp(join(tmpdir(), 'pith-tool-duration-'))
try {
  const outfile = join(temporary, 'store.mjs')
  await build({
    stdin: {
      contents: "export { PiStore } from './src/renderer/src/state/pi-store';",
      resolveDir: resolve('.')
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile
  })
  const { PiStore } = await import(pathToFileURL(outfile).href)
  const store = new PiStore()
  const sessionPath = '/fixture/tool-duration.jsonl'
  store.applySnapshot({
    sessionId: 'tool-duration', sessionPath, cwd: '/fixture', projectless: false,
    messages: [], model: null, thinkingLevel: 'off', isStreaming: true,
    eventSequence: 0
  })

  const originalNow = Date.now
  let now = 1000
  let sequence = 0
  Date.now = () => now
  const dispatch = (event) => store.dispatch({ ...event, sessionPath, eventSequence: ++sequence })
  const start = (id) => dispatch({ type: 'tool_execution_start', toolCallId: id, toolName: 'codemode', args: { code: id } })
  const end = (id, isError = false) => dispatch({ type: 'tool_execution_end', toolCallId: id, toolName: 'codemode', result: { content: [] }, isError })
  const result = (id, isError = false) => dispatch({
    type: 'message_end', message: {
      role: 'toolResult', toolCallId: id, toolName: 'codemode',
      content: [], isError, timestamp: now
    }
  })
  try {
    start('first')
    now = 1120
    end('first')
    const firstBeforeResult = store.getState().toolRuns.first

    now = 1300
    start('second')
    now = 2300
    end('second')
    const secondBeforeResult = store.getState().toolRuns.second

    // A third call whose end event was lost still gets a bounded fallback.
    now = 2400
    start('missing-end')
    now = 5000
    result('first')
    result('second')
    result('missing-end')

    const runs = store.getState().toolRuns
    assert.equal(runs.first.endedAt - runs.first.startedAt, 120)
    assert.equal(runs.second.endedAt - runs.second.startedAt, 1000)
    assert.equal(runs['missing-end'].endedAt - runs['missing-end'].startedAt, 2600)
    assert.equal(firstBeforeResult.endedAt, 1120, 'a result must not mutate the prior run object')
    assert.equal(secondBeforeResult.endedAt, 2300, 'later result must not mutate the prior run object')
    assert.equal(runs.first.status, 'success')
    assert.equal(runs.second.status, 'success')
    assert.equal(runs['missing-end'].status, 'success')

    now = 6000
    start('failed')
    now = 6100
    end('failed', true)
    now = 8000
    result('failed', true)
    assert.equal(store.getState().toolRuns.failed.endedAt - store.getState().toolRuns.failed.startedAt, 100)
    assert.equal(store.getState().toolRuns.failed.status, 'error')

    now = 9000
    start('aborted')
    now = 9100
    dispatch({ type: 'agent_settled', continuing: false })
    assert.equal(store.getState().toolRuns.aborted.endedAt, 9100)
    assert.equal(store.getState().toolRuns.aborted.status, 'error')
    now = 12000
    result('aborted', true)
    assert.equal(store.getState().toolRuns.aborted.endedAt, 9100, 'a late error result keeps the stop time')
  } finally {
    Date.now = originalNow
  }

  console.log('PASS: batched codemode results retain each call\'s own completion time.')
} finally {
  await rm(temporary, { recursive: true, force: true })
}
