/** SDK nested calls must cross app admission, Rewind leases and coverage. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createPlanFixture } from './lib/plan-fixture.mjs'

let effects = 0
let outsidePath = ''
let bashStartedResolve
let releaseBashOuter
const bashStarted = new Promise(resolve => { bashStartedResolve = resolve })
const bashOuterHold = new Promise(resolve => { releaseBashOuter = resolve })
const f = await createPlanFixture({ extensionFactories: [pi => {
  pi.registerTool({ name: 'fixture_effect', label: 'Fixture effect', description: 'Count calls',
    parameters: { type: 'object', properties: { fail: { type: 'boolean' } } },
    async execute(_id, args) {
      if (args.fail) throw new Error('nested failure')
      effects++
      return { content: [{ type: 'text', text: 'Executed' }], details: {} }
    } })
  pi.registerTool({ name: 'fixture_outer', label: 'Fixture nested call', description: 'Call a tool through the SDK',
    parameters: { type: 'object', properties: { mode: { type: 'string' } } },
    async execute(_id, args, _signal, _update, ctx) {
      if (args.mode === 'todo') {
        const outcome = await ctx.executeTool('todo_write', { todos: [] })
        return { ...outcome.result, isError: outcome.isError }
      }
      if (args.mode === 'bash') {
        const outcome = await ctx.executeTool('bash', { command: 'printf nested-bash', mode: 'background' })
        assert.equal(outcome.isError, false, JSON.stringify(outcome.result))
        bashStartedResolve(outcome.result.details.bashTask.id)
        await bashOuterHold
        throw new Error('outer failed after background bash')
      }
      if (args.mode === 'write') {
        const outcome = await ctx.executeTool('write', { path: outsidePath, content: 'nested file' })
        assert.equal(outcome.isError, false, JSON.stringify(outcome.result))
        throw new Error('outer failed after the nested write')
      }
      const aborted = new AbortController()
      if (args.mode === 'aborted') aborted.abort()
      const outcome = await ctx.executeTool('fixture_effect', { fail: args.mode === 'fail' },
        args.mode === 'aborted' ? { signal: aborted.signal } : undefined)
      return { ...outcome.result, isError: outcome.isError }
    } })
}] })
try {
  await f.managed.lifecyclePromise
  outsidePath = `${f.temporary}/outside-nested.txt`
  let appHookCalls = 0
  let nestedLeases = 0
  const previous = f.session.agent.beforeToolCall
  f.session.agent.beforeToolCall = async (...args) => {
    if (args[0].toolCall.name === 'fixture_effect') appHookCalls++
    return previous?.(...args)
  }
  const originalLease = f.managed.rewind.beginNestedToolCall.bind(f.managed.rewind)
  f.managed.rewind.beginNestedToolCall = async (...args) => {
    nestedLeases++
    return originalLease(...args)
  }
  const run = async (name, args = {}) => {
    const next = f.requests.length + 1
    f.setRespond(n => n === next
      ? [{ type: 'toolCall', id: `${name}-${n}`, name, arguments: args }]
      : [{ type: 'text', text: 'Finished' }])
    await f.session.prompt('Run the fixture')
    return f.session.messages.findLast(m => m.role === 'toolResult')
  }
  for (const reload of [false, true]) {
    if (reload) await f.app.reloadSession(f.managed.path)
    const result = await run('fixture_outer')
    assert.equal(result.isError, false, JSON.stringify(result.content))
    assert.equal(effects, reload ? 2 : 1, 'nested calls must execute after boundary admission, including reload')
    assert.equal(nestedLeases, reload ? 2 : 1, 'every nested call owns a Rewind tool lease')
    assert.equal(f.app.checkoutCoordinator.restoreBlockers(f.project).writers, 0, 'nested lease must release after settlement')
    assert.equal(appHookCalls, 0, 'nested calls use the SDK private hooks, not the public agent hook')
  }
  const failed = await run('fixture_outer', { mode: 'fail' })
  assert.equal(failed.isError, true)
  assert.equal(f.app.checkoutCoordinator.restoreBlockers(f.project).writers, 0, 'throwing nested calls must release leases')
  const aborted = await run('fixture_outer', { mode: 'aborted' })
  assert.equal(aborted.isError, true)
  assert.equal(effects, 2, 'aborted nested calls must not execute')
  assert.equal(f.app.checkoutCoordinator.restoreBlockers(f.project).writers, 0, 'aborted nested calls must release leases')

  const write = await run('fixture_outer', { mode: 'write' })
  assert.equal(write.isError, true)
  assert.deepEqual(write.details.piAppNestedWrites, { version: 1, paths: [outsidePath] },
    'a successful nested write remains coverage evidence even if its parent fails')
  assert.match(await readFile(f.managed.path, 'utf8'), /piAppNestedWrites/,
    'nested write coverage must survive the persisted session file')
  assert.equal(f.app.checkoutCoordinator.restoreBlockers(f.project).writers, 0)

  f.app.setSessionSandboxMode(f.managed.path, 'danger-full-access')
  const bashNext = f.requests.length + 1
  f.setRespond(n => n === bashNext
    ? [{ type: 'toolCall', id: 'outer-bash', name: 'fixture_outer', arguments: { mode: 'bash' } }]
    : [{ type: 'text', text: 'Finished' }])
  const bashPrompt = f.session.prompt('Run nested background bash')
  const bashTaskId = await bashStarted
  await f.app.commandTasks.wait(f.managed.path, bashTaskId)
  assert.equal(f.managed.notifications.hasPendingCompletions, true)
  assert.equal(f.events.some(e => e.type === 'message_end' && e.message?.customType === 'bash_task_completion'), false,
    'completion must wait for the enclosing tool result to commit')
  releaseBashOuter()
  await bashPrompt
  const bashResult = f.session.messages.findLast(m => m.role === 'toolResult' && m.toolCallId === 'outer-bash')
  assert.equal(bashResult.isError, true)
  assert.deepEqual(bashResult.details.piAppNestedBashCalls, { version: 1, ids: ['outer-bash/1'] })
  for (let i = 0; i < 200 && !f.events.some(e => e.type === 'message_end' && e.message?.customType === 'bash_task_completion'); i++) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert(f.events.some(e => e.type === 'message_end' && e.message?.customType === 'bash_task_completion'),
    'committed parent result must release the nested bash completion even on error')

  const direct = await run('fixture_effect')
  assert.equal(direct.isError, false)
  assert.equal(effects, 3)
  assert.equal(appHookCalls, 1, 'ordinary extension calls retain the app lifecycle')

  const todo = await run('fixture_outer', { mode: 'todo' })
  assert.equal(todo.isError, true, 'model-only state tools must be absent from the SDK nested registry')
  assert.equal(f.managed.todos.snapshot, null, 'a nested todo attempt must not change committed task state')

  const definition = f.session.getToolDefinition('fixture_effect')
  assert.match(f.managed.gate.admitNested('fixture_effect', {}, { ...definition }), /changed/,
    'a same-name replacement cannot inherit a trusted definition')
  assert.match(f.managed.gate.admitNested('todo_write', { todos: [] }, f.session.getToolDefinition('todo_write')), /direct model call/,
    'stateful app tools cannot lose their committed-result lifecycle inside codemode')
  f.managed.subagentChild = { toolCeiling: ['fixture_outer'] }
  assert.match(f.managed.gate.admitNested('fixture_effect', {}, definition), /outside this subagent/,
    'nested calls must honor the frozen child ceiling')
  f.managed.subagentChild = undefined
  const entered = await f.app.setSessionMode({ sessionPath: f.managed.path, mode: 'plan' })
  assert.equal(entered.ok, true)
  assert.match(f.managed.gate.admitNested('fixture_effect', {}, definition), /not callable|plan:/,
    'unreviewed extension effects are refused in Plan')
  assert.match(f.managed.gate.admitNested('read', { path: 'x' }, f.session.getToolDefinition('read')), /nested execution/,
    'Plan must not dispatch the raw registry read instead of its substituted definition')
  console.log('PASS: SDK nested calls execute under live Plan/identity admission, Rewind leases, cancellation and coverage.')
} finally { releaseBashOuter(); await f.close() }
