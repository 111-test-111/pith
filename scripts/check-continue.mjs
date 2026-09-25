/** Real SDK, persisted branches and provider-normalized recovery context.
 * All files are temporary; the model stream is local and deterministic. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { createPlanFixture, submitFixturePlan, planRepoRoot } from './lib/plan-fixture.mjs'

const { transformMessages } = await import(new URL('../node_modules/@earendil-works/pi-ai/dist/api/transform-messages.js', import.meta.resolve('@earendil-works/pi-coding-agent')))
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const until = async predicate => {
  const deadline = Date.now() + 10000
  while (!predicate()) { assert(Date.now() < deadline, 'continuation timed out'); await delay(10) }
}
const f = await createPlanFixture({ withRewind: true })
try {
  await f.managed.lifecyclePromise
  const helpers = join(f.temporary, 'continuation-helpers.mjs')
  await build({ stdin: { contents: `export * from './src/shared/continuation'; export * from './src/main/pi/continuation'; export * from './src/renderer/src/lib/chat-turns';`, resolveDir: planRepoRoot }, outfile: helpers, bundle: true, format: 'esm', platform: 'node' })
  const { continuationTarget, continuationContent, buildTurns, collectChangeScopes } = await import(pathToFileURL(helpers))
  const model = f.session.model
  const originalStream = f.session.agent.streamFunction
  let time = Date.now(), calls = 0, waiting = false
  const round = (content, stopReason) => ({ role: 'assistant', content, stopReason, timestamp: ++time,
    api: model.api, provider: model.provider, model: model.id,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } })
  const partial = 'The file has been written. Next I will verify the saved result: '
  f.session.agent.streamFunction = (_model, _context, options) => {
    const first = ++calls === 1
    const message = round(first
      ? [{ type: 'toolCall', id: 'write-before-stop', name: 'write', arguments: { path: 'continued.txt', content: 'already saved\n' } }]
      : [{ type: 'text', text: partial }, { type: 'thinking', thinking: 'Inspect the existing file before proceeding.' }], first ? 'toolUse' : 'aborted')
    return {
      async *[Symbol.asyncIterator]() {
        if (!first) {
          yield { type: 'start', partial: message }
          waiting = true
          if (!options.signal.aborted) await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }))
          message.errorMessage = 'Request was aborted'
        }
        yield first ? { type: 'done', message } : { type: 'error', error: message }
      }, result: async () => message
    }
  }
  const running = f.session.prompt('Write continued.txt and verify it. Keep the original request and attachment context.')
  await until(() => waiting)
  f.app.abort()
  await running
  const before = f.app.snapshot()
  const target = continuationTarget(before.messages)
  assert.equal(target.stopReason, 'aborted')
  assert.equal(await readFile(join(f.project, 'continued.txt'), 'utf8'), 'already saved\n')
  const userCount = before.messages.filter(message => message.role === 'user').length
  const branchIds = f.manager.getBranch().map(entry => entry.id)
  const checkpoints = await f.app.rewindList(f.managed.path)
  const request = { sessionPath: f.managed.path, timestamp: target.timestamp }
  f.session.agent.streamFunction = originalStream
  f.setRespond(() => [{ type: 'text', text: 'Verified the saved result; the task is complete.' }])
  const continuing = f.app.continueMessage(request)
  await assert.rejects(f.app.continueMessage(request), /continue-busy/)
  await continuing
  const normalized = transformMessages(f.requests.at(-1).messages, model)
  assert(normalized.some(message => message.role === 'user' && JSON.stringify(message.content).includes(partial)), 'provider normalization must retain the partial reply')
  assert(JSON.stringify(normalized).includes('Inspect the existing file before proceeding.'))
  assert(JSON.stringify(normalized).includes('Keep the original request and attachment context.'))
  assert(normalized.some(message => message.role === 'toolResult' && message.toolCallId === 'write-before-stop' && !message.isError), 'committed tool results survive')
  const after = f.app.snapshot()
  assert.equal(after.messages.filter(message => message.role === 'user').length, userCount)
  assert.deepEqual(f.manager.getBranch().slice(0, branchIds.length).map(entry => entry.id), branchIds, 'Continue never rewinds or replaces history')
  assert.equal(buildTurns(after.messages).filter(turn => turn.role === 'assistant').length, 1)
  assert.equal(collectChangeScopes(buildTurns(after.messages)).size, 1)
  assert.equal(new Set(after.messages.filter(message => message.role === 'assistant').map(message => message.changeScopeId)).size, 1)
  assert.equal(continuationTarget(after.messages), null)
  assert.deepEqual(await f.app.rewindList(f.managed.path), checkpoints, 'a continuation adds no rewind checkpoint')
  await assert.rejects(f.app.continueMessage(request), /continue-stale-turn/)
  console.log('PASS: Stop → Continue preserves provider-visible partial output, original request, tool results, branch, turn, change ownership and checkpoint count; duplicate/stale clicks are rejected.')

  const storedPath = f.managed.path
  await f.app.disposeManaged(f.managed)
  const { SessionManager } = await import('@earendil-works/pi-coding-agent')
  const cold = await f.app.buildSession(SessionManager.open(storedPath))
  await cold.lifecyclePromise
  const restored = f.app.snapshot()
  assert.equal(buildTurns(restored.messages).filter(turn => turn.role === 'assistant').length, 1)
  assert.equal(collectChangeScopes(buildTurns(restored.messages)).size, 1)
  assert.equal(restored.messages.filter(message => message.role === 'custom' && message.customType === 'pith_turn_continuation')[0].display, false)
  console.log('PASS: cold reopen preserves the same turn and hidden continuation context.')

  // Both main admission and the UI use this pure frontier rule.
  for (const stopReason of ['aborted', 'error', 'length', 'toolUse']) {
    const interrupted = round([{ type: 'text', text: 'partial' }], stopReason)
    assert.equal(continuationTarget([interrupted]), interrupted)
    assert.equal(continuationTarget([interrupted, { role: 'user', content: 'next request', timestamp: ++time }]), null)
    assert.equal(continuationTarget([interrupted, round([], 'stop')]), null)
  }
  const incompleteCall = round([{ type: 'toolCall', id: 'partial', name: 'write', arguments: { path: 'unexecuted.txt' } }], 'error')
  assert.match(continuationContent(incompleteCall), /unexecutedToolCall/)
  assert.match(continuationContent(incompleteCall), /not evidence of execution/)

  // Seed another interruption in the real restored branch, then Stop while
  // lifecycle readiness is pending. No queued wake or model run may escape.
  const interrupted = round([{ type: 'text', text: 'pending continuation' }], 'error')
  cold.session.sessionManager.appendMessage(interrupted)
  cold.session.agent.state.messages = cold.session.sessionManager.buildSessionContext().messages
  let ready
  cold.lifecyclePromise = new Promise(resolve => { ready = resolve })
  const count = f.requests.length
  const preparing = f.app.continueMessage({ sessionPath: cold.path, timestamp: interrupted.timestamp })
  f.app.abort()
  ready()
  await preparing
  cold.lifecyclePromise = null
  assert.equal(f.requests.length, count)
  assert.equal(cold.continuationRequest, undefined)
  assert.equal(cold.notifications.canStart, false)
  await assert.rejects(f.app.continueMessage({ sessionPath: '/stale', timestamp: interrupted.timestamp }), /continue-stale-session/)
  cold.subagentChild = { parentPath: '/parent', toolCeiling: [] }
  await assert.rejects(f.app.continueMessage({ sessionPath: cold.path, timestamp: interrupted.timestamp }), /continue-stale-session/)
  cold.subagentChild = undefined
  console.log('PASS: interruption eligibility, stale session/read-only child admission and Stop during preparation.')
} finally { await f.close() }

const plan = await createPlanFixture()
try {
  await submitFixturePlan(plan)
  const target = plan.app.snapshot().messages.findLast(message => message.role === 'assistant')
  await assert.rejects(plan.app.continueMessage({ sessionPath: plan.managed.path, timestamp: target.timestamp }), /sealed|already-submitted/)
  assert.equal(plan.managed.plan.submissionLocked, true)
  console.log('PASS: Continue cannot bypass a submitted plan or its approval gate.')
} finally { await plan.close() }
