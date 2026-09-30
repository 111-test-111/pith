/** SDK nested calls must not run outside the app's tool lifecycle. */
import assert from 'node:assert/strict'
import { createPlanFixture } from './lib/plan-fixture.mjs'

let effects = 0
const f = await createPlanFixture({ extensionFactories: [pi => {
  pi.registerTool({ name: 'fixture_effect', label: 'Fixture effect', description: 'Count calls',
    parameters: { type: 'object', properties: {} },
    async execute() { effects++; return { content: [{ type: 'text', text: 'Executed' }], details: {} } } })
  pi.registerTool({ name: 'fixture_outer', label: 'Fixture nested call', description: 'Call a tool through the SDK',
    parameters: { type: 'object', properties: {} },
    async execute(_id, _args, _signal, _update, ctx) {
      const outcome = await ctx.executeTool('fixture_effect', {})
      return { ...outcome.result, isError: outcome.isError }
    } })
}] })
try {
  await f.managed.lifecyclePromise
  let appHookCalls = 0
  const previous = f.session.agent.beforeToolCall
  f.session.agent.beforeToolCall = async (...args) => {
    if (args[0].toolCall.name === 'fixture_effect') appHookCalls++
    return previous?.(...args)
  }
  for (const reload of [false, true]) {
    if (reload) await f.app.reloadSession(f.managed.path)
    const next = f.requests.length + 1
    f.setRespond(n => n === next
      ? [{ type: 'toolCall', id: `outer-${n}`, name: 'fixture_outer', arguments: {} }]
      : [{ type: 'text', text: 'Finished' }])
    await f.session.prompt('Run the nested fixture')
    const result = f.session.messages.findLast(m => m.role === 'toolResult')
    assert.equal(result.isError, true, 'unsupported nested calls must return an explicit error')
    assert.match(JSON.stringify(result.content), /directly/)
    assert.equal(effects, 0, 'raw SDK registry execution must not bypass app admission and Rewind leases')
    assert.equal(appHookCalls, 0, 'the SDK nested pipeline does not invoke the public agent hook')
  }
  const next = f.requests.length + 1
  f.setRespond(n => n === next
    ? [{ type: 'toolCall', id: 'direct', name: 'fixture_effect', arguments: {} }]
    : [{ type: 'text', text: 'Finished' }])
  await f.session.prompt('Run the tool directly')
  assert.equal(effects, 1)
  assert.equal(appHookCalls, 1, 'ordinary extension calls retain the app lifecycle')
  console.log('PASS: SDK nested calls fail explicitly before side effects, including after reload; direct extension calls keep app hooks.')
} finally { await f.close() }
