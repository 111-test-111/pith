#!/usr/bin/env node
/** Keyless recorded regressions and fail-loud request/tool contract checks. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createReplayFixture } from './lib/session-replay-fixture.mjs'
import { assertReplayEqual, createReplayNormalizer, createSessionRecorder, createSessionReplay, loadSessionReplay, ReplayMismatch } from './lib/session-replay.mjs'
import { installReplayOfflineGuard } from './lib/session-replay-offline.mjs'

const restoreNetwork = installReplayOfflineGuard()
const fixturePath = name => fileURLToPath(new URL(`./fixtures/session-replay/${name}.json`, import.meta.url))
const saved = new Map()
async function replay(recorded, verify) {
  const fixture = await createReplayFixture({ scenario: recorded.scenario, streamFactory: normalizer => createSessionReplay({ normalizer, calls: recorded.calls }) })
  try {
    await fixture.run()
    if (verify) await verify(fixture)
    else {
      fixture.driver.assertConsumed()
      assertReplayEqual(await fixture.outcome(), recorded.expected, `${recorded.scenario.id} outcome`)
    }
  } finally { await fixture.close() }
}

async function rejectsContract(name, change, pattern) {
  const recorded = structuredClone(saved.get(name))
  change(recorded)
  await replay(recorded, fixture => {
    assert.throws(() => fixture.driver.assertConsumed(), error => error instanceof ReplayMismatch && pattern.test(error.message))
  })
}

try {
  assert.throws(() => fetch('https://example.com'), /network-disabled/)
  for (const name of ['ordinary-turn', 'read-write-present', 'failed-present', 'provider-retry', 'cancelled-stream', 'cancelled-retry']) {
    const path = fixturePath(name)
    const source = await readFile(path, 'utf8')
    assert(!source.includes('synthetic-secret-never-use'), `${name}: credentials are redacted`)
    assert(!/pith-session-replay-[\w]+\/|\/Users\/|\/private\/var\//.test(source), `${name}: no machine-specific roots`)
    const recorded = await loadSessionReplay(path)
    saved.set(name, recorded)
    await replay(recorded)
    console.log(`PASS ${name}: request contract, consumed stream, real tools/transcript/present/trajectory`)
  }
  const chain = saved.get('read-write-present').expected
  assert.deepEqual(chain.transcript.filter(value => value.role === 'toolResult').map(value => value.toolName), ['read', 'write', 'present'])
  assert.equal(chain.delivered.length, 1)
  assert.equal(chain.delivered[0].path, '{{pith:workspace}}/report.md')
  assert.equal(chain.outputFiles[0].content, '# Report\nRevenue: 42\n成本：17\n')
  const failed = saved.get('failed-present').expected
  assert.equal(failed.delivered.length, 0)
  assert(failed.transcript.some(value => value.role === 'toolResult' && value.isError))
  const retry = saved.get('provider-retry').expected
  assert.deepEqual(retry.trajectories.filter(value => value.kind === 'request').map(value => value.status), ['failed', 'failed', 'completed'])
  assert.deepEqual(retry.trajectories.filter(value => value.kind === 'retry').map(value => value.status), ['failed', 'completed'])
  assert.equal(retry.trajectories.filter(value => value.kind === 'run').length, 1)
  assert(retry.eventTypes.includes('auto_retry_start') && retry.eventTypes.includes('auto_retry_end'))
  assert.equal(retry.eventTypes.filter(value => value === 'agent_settled').length, 1)
  const cancelled = saved.get('cancelled-stream').expected
  assert.equal(cancelled.transcript.at(-1).stopReason, 'aborted')
  assert(cancelled.transcript.at(-1).content[0].text.length > 0)
  assert.equal(cancelled.trajectories.find(value => value.kind === 'run').status, 'cancelled')
  assert(saved.get('cancelled-stream').calls[0].exchanges.some(value => value.kind === 'abort'))
  const cancelledRetry = saved.get('cancelled-retry')
  assert.equal(cancelledRetry.calls.length, 1)
  assert.equal(cancelledRetry.expected.trajectories.find(value => value.kind === 'run').status, 'cancelled')
  assert.equal(cancelledRetry.expected.trajectories.find(value => value.kind === 'retry').status, 'cancelled')

  await rejectsContract('ordinary-turn', fixture => { fixture.scenario.prompts[0] = 'A semantically different instruction.' }, /Provider call 1 request.*content/)
  await rejectsContract('read-write-present', fixture => { fixture.calls[0].request.context.messages.find(message => message.role === 'system' && message.toolsAdded?.length).toolsAdded[0].parameters.properties.path.type = 'integer' }, /Provider call 1 request.*parameters/)
  await rejectsContract('read-write-present', fixture => { fixture.scenario.files[0].content = 'Revenue: 999\n' }, /Provider call 2 request.*content/)
  await rejectsContract('read-write-present', fixture => {
    const call = fixture.calls[1]
    const change = message => {
      for (const block of message?.content ?? []) if (block.type === 'toolCall' && block.name === 'write') block.arguments.content = 'Changed report content'
    }
    for (const exchange of call.exchanges) if (exchange.kind === 'chunk') {
      change(exchange.event.partial); change(exchange.event.message)
    }
    change(call.result)
  }, /Provider call 3 request.*(?:arguments|content)/)
  await rejectsContract('ordinary-turn', fixture => { fixture.calls.pop() }, /Replay exhausted at provider call 2/)
  await rejectsContract('ordinary-turn', fixture => { fixture.scenario.prompts.pop() }, /Replay incomplete: consumed 1\/2/)
  console.log('PASS fail-loud contracts: changed prompt, schema, actual tool result, tool argument, extra/unused call')

  const normalizer = createReplayNormalizer({ workspace: '/fixture/project', secretValues: ['do-not-retain'] })
  const normalized = normalizer.capture({ role: 'assistant', timestamp: 42, content: [{ type: 'toolCall', id: 'opaque-call', name: 'sample', arguments: { id: 'meaningful', timestamp: 9, password: 'argument-value' } }] })
  assert.equal(normalized.timestamp, 0)
  assert.equal(normalized.content[0].id, '{{pith:tool:1}}')
  assert.deepEqual(normalized.content[0].arguments, { id: 'meaningful', timestamp: 9, password: 'argument-value' })
  assert.deepEqual(normalizer.capture({ type: 'toolCall', id: 'second-call', arguments: { role: 'user', timestamp: 19, content: 'semantic', nested: { type: 'toolCall', id: 'semantic-id' } } }).arguments,
    { role: 'user', timestamp: 19, content: 'semantic', nested: { type: 'toolCall', id: 'semantic-id' } })
  assert.equal(normalizer.capture('/fixture/project/file.txt'), '{{pith:workspace}}/file.txt')
  assert.equal(normalizer.capture('/fixture/project-extra/file.txt'), '/fixture/project-extra/file.txt')
  const windows = createReplayNormalizer({ workspace: 'C:\\fixture\\project' })
  assert.equal(windows.capture({ path: 'C:\\fixture\\project\\report.md' }).path, '{{pith:workspace}}/report.md')
  assert.equal(windows.capture({ type: 'text', text: 'Presented C:\\fixture\\project\\report.md' }).text, 'Presented {{pith:workspace}}/report.md')
  assert.equal(windows.capture('Keep this \\code escape'), 'Keep this \\code escape')
  assert.equal(normalizer.capture({ authorization: 'do-not-retain' }, { redactCredentials: true }).authorization, '[redacted]')
  assert.throws(() => normalizer.capture({ role: 'user', content: 'do-not-retain', timestamp: 1 }), /secret-in-model-visible-data/)
  assert.deepEqual(normalizer.capture({ properties: { password: { type: 'string' } } }, { redactCredentials: true }), { properties: { password: { type: 'string' } } })
  assert.throws(() => normalizer.capture('Literal {{pith:workspace}}'), /reserved-token/)
  const proto = JSON.parse('{"__proto__":{"semantic":true}}')
  assert(Object.hasOwn(normalizer.capture(proto), '__proto__'))

  const ordinary = saved.get('ordinary-turn')
  const n = createReplayNormalizer({ workspace: '/different/root' })
  const handle = createSessionReplay({ calls: [ordinary.calls[0]], normalizer: n })
  const request = ordinary.calls[0].request
  const stream = await handle.streamFunction(n.restore(request.model), n.restore(request.context), { ...n.restore(request.options), onPayload: () => ({ changed: true }) })
  await assert.rejects(async () => { for await (const _ of stream) { /* consume */ } }, /final payload/)
  assert.throws(() => handle.assertConsumed(), /final payload/)
  const incomplete = structuredClone(ordinary.calls)
  incomplete[0].exchanges.pop()
  assert.throws(() => createSessionReplay({ calls: incomplete, normalizer: n }), /missing-terminal/)
  const invalidStop = structuredClone(ordinary.calls)
  invalidStop[0].exchanges.at(-1).event.reason = 'error'
  assert.throws(() => createSessionReplay({ calls: invalidStop, normalizer: n }), /invalid-terminal-message/)

  const mutable = { ...structuredClone(ordinary.calls[0].result), content: [], timestamp: 7 }
  const recordingNormalizer = createReplayNormalizer({ secretValues: ['do-not-retain'] })
  const recording = createSessionRecorder({ normalizer: recordingNormalizer, stream: (model, _, options) => ({
    async *[Symbol.asyncIterator]() {
      await options.onPayload({ content: 'original', authorization: 'do-not-retain' }, model)
      yield { type: 'start', partial: mutable }
      mutable.content.push({ type: 'text', text: 'Later mutation' })
      yield { type: 'done', reason: 'stop', message: mutable }
    },
    async result() { return mutable }
  }) })
  const recordedStream = await recording.streamFunction(request.model, { messages: [] }, { onPayload: () => ({ content: 'replacement', authorization: 'do-not-retain' }) })
  for await (const event of recordedStream) if (event.type === 'done') await recordedStream.result()
  recording.assertComplete()
  assert.deepEqual(recording.calls[0].exchanges[1].event.partial.content, [], 'Retained partial must precede a provider mutation')
  assert.equal(recording.calls[0].exchanges[0].actual.content, 'replacement')
  assert.equal(recording.calls[0].exchanges[0].actual.authorization, '[redacted]')
  console.log('PASS normalization/validation: non-semantic roots/times/correlation IDs only; payload replacement mismatch; malformed terminal; scoped credential redaction')
} finally { restoreNetwork() }
