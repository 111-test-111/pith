/** Offline request budgeting: pure policy + real SDK/Plan/trajectory boundary. */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { estimateTokens, SettingsManager } from '@earendil-works/pi-coding-agent'
import { build } from 'esbuild'
import { createPlanFixture, planRepoRoot } from './lib/plan-fixture.mjs'

const temporary = await mkdtemp(join(tmpdir(), 'pith-context-budget-'))
let fixture
try {
  const outfile = join(temporary, 'budget.mjs')
  await build({ entryPoints: [join(planRepoRoot, 'src/main/pi/context-budget.ts')], bundle: true, platform: 'node', format: 'esm', outfile,
    plugins: [{ name: 'external-sdk', setup(builder) {
      builder.onResolve({ filter: /^@earendil-works\/pi-coding-agent$/ }, () => ({ path: fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')), external: true }))
    } }] })
  const { budgetRequestContext, installContextBudgetOverlay } = await import(pathToFileURL(outfile).href)
  const model = { contextWindow: 16000, maxTokens: 2048 }
  const settings = { reserveTokens: 2048, keepRecentTokens: 128 }
  const call = (id, toolName = 'read') => ({ role: 'assistant', content: [{ type: 'toolCall', id, name: toolName, arguments: { path: `${id}.txt` } }], timestamp: 1 })
  const result = (id, text, toolName = 'read', more = []) => ({ role: 'toolResult', toolCallId: id, toolName, content: [{ type: 'text', text }, ...more], isError: false, timestamp: 2 })
  const user = text => ({ role: 'user', content: text, timestamp: 3 })
  const system = (content, toolsAdded) => ({ role: 'system', content, toolsAdded, timestamp: 0 })
  const systemText = messages => messages.filter(message => message.role === 'system')
    .map(message => typeof message.content === 'string' ? message.content : message.content.map(block => block.text).join('\n')).join('\n\n')
  const huge = '开始🧠\n'.repeat(18000) + '\nTAIL: retain this error location'
  const image = { type: 'image', data: 'AAAA', mimeType: 'image/png' }
  const context = { messages: [system('system instructions', [{ name: 'read', description: 'Read', parameters: { type: 'object' } }]), user('Original user instruction'), call('old'), result('old', huge, 'read', [image, { type: 'text', text: '第二段'.repeat(6000) }]), user('Newest instruction must survive'), call('fresh'), result('fresh', 'latest result')] }
  const before = JSON.stringify(context)
  const budgeted = budgetRequestContext(model, context, undefined, settings)
  assert.equal(JSON.stringify(context), before, 'request projection cannot mutate the supplied history')
  assert.equal(budgeted.messages.length, context.messages.length)
  assert.deepEqual(budgeted.messages.map(m => [m.role, m.toolCallId]), context.messages.map(m => [m.role, m.toolCallId]))
  assert.equal(budgeted.messages[0], context.messages[0])
  assert.equal(budgeted.messages[4], context.messages[4])
  assert.equal(budgeted.messages[5], context.messages[5])
  assert.equal(budgeted.messages[6], context.messages[6], 'latest call/result batch remains complete')
  assert.equal(budgeted.messages[3].content[1], image, 'images remain at their original position')
  const shortenedText = budgeted.messages[3].content.filter(x => x.type === 'text').map(x => x.text).join('')
  assert(shortenedText.startsWith('开始🧠'))
  assert(shortenedText.endsWith('第二段'))
  assert.equal(shortenedText.match(/Earlier tool result shortened/g).length, 1)
  assert(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(shortenedText), 'Unicode truncation must not produce lone surrogates')
  const report = budgeted.contextBudget
  assert.equal(report.estimation, 'heuristic')
  assert.equal(report.shortenedToolResultCount, 1)
  assert.equal(report.status, 'shortened')
  assert(report.requestInputTokensEstimate <= report.inputBudgetTokens)
  assert.equal(report.originalInputTokensEstimate, report.systemTokensEstimate + report.toolDefinitionTokensEstimate + report.dialogueTokensEstimate + report.toolResultTokensBeforeEstimate)
  assert.equal(report.requestInputTokensEstimate, report.systemTokensEstimate + report.toolDefinitionTokensEstimate + report.dialogueTokensEstimate + report.toolResultTokensAfterEstimate)
  assert.equal(budgetRequestContext(model, budgeted, undefined, settings).contextBudget.shortenedToolResultCount, 0, 'projection is idempotent')

  const parallel = { ...context, messages: [context.messages[0], call('old'), result('old', huge), user('Latest user'), { role: 'assistant', content: [{ type: 'toolCall', id: 'a', name: 'read', arguments: {} }, { type: 'toolCall', id: 'b', name: 'read', arguments: {} }] }, result('a', huge), result('b', huge)] }
  const protectedBudget = budgetRequestContext(model, parallel, undefined, settings)
  assert.equal(protectedBudget.contextBudget.status, 'protected-over-budget')
  assert.equal(protectedBudget.contextBudget.shortenedToolResultCount, 1)
  assert.equal(protectedBudget.messages[5], parallel.messages[5])
  assert.equal(protectedBudget.messages[6], parallel.messages[6])
  assert(protectedBudget.contextBudget.remainingOverBudgetTokensEstimate > 0)
  const pastBatch = { ...context, messages: [context.messages[0], user('Old turn'), call('old'), result('old', huge), user('Another turn'), { role: 'assistant', content: [{ type: 'text', text: 'Short answer' }] }, user('Newest pure dialogue turn')] }
  const aged = budgetRequestContext(model, pastBatch, undefined, settings)
  assert.equal(aged.contextBudget.shortenedToolResultCount, 1, 'old batch is not permanently protected after later pure dialogue turns')
  assert.equal(aged.messages.at(-1), pastBatch.messages.at(-1))
  const reminded = { ...parallel, messages: [...parallel.messages, { ...user('<system-reminder>Todo state</system-reminder>'), timestamp: 10 }] }
  const withReminder = budgetRequestContext(model, reminded, undefined, { ...settings, latestUserTimestamp: 3 })
  assert.equal(withReminder.contextBudget.shortenedToolResultCount, 1)
  assert.equal(withReminder.messages[5], reminded.messages[5], 'ephemeral Todo user reminder cannot make the current tool batch old')
  assert.equal(withReminder.messages[6], reminded.messages[6])
  const unknown = budgetRequestContext({ ...model, contextWindow: 0 }, context, undefined, settings)
  assert.equal(unknown.contextBudget.status, 'unknown-window')
  assert.equal(unknown.messages, context.messages)
  const noTextBudget = budgetRequestContext(model, { ...context, messages: [context.messages[0], user(huge)] }, undefined, settings)
  assert.equal(noTextBudget.contextBudget.status, 'protected-over-budget')
  assert.equal(noTextBudget.messages[1].content, huge)
  const schemas = budgetRequestContext(model, { ...context, messages: [system(huge, [{ name: 'large', description: huge, parameters: {} }]), ...context.messages.slice(1)] }, { maxTokens: 4096 }, settings)
  assert.equal(schemas.contextBudget.replyReserveTokens, 4096)
  assert(schemas.contextBudget.systemTokensEstimate > 10000)
  assert(schemas.contextBudget.toolDefinitionTokensEstimate > 10000)
  const state = budgetRequestContext(model, { ...context, messages: [call('todo', 'todo_write'), result('todo', huge, 'todo_write'), call('fresh'), result('fresh', 'latest')] }, undefined, settings)
  assert.equal(state.contextBudget.shortenedToolResultCount, 0)
  const orphan = budgetRequestContext(model, { ...context, messages: [result('unmatched', huge), call('fresh'), result('fresh', 'latest')] }, undefined, settings)
  assert.equal(orphan.contextBudget.shortenedToolResultCount, 0)
  const small = budgetRequestContext({ ...model, contextWindow: 200000 }, context, undefined, settings)
  assert.equal(small.messages, context.messages)
  assert.equal(small.contextBudget.status, 'within-budget')
  let received
  const originalStream = (_model, ctx) => { received = ctx; return {} }
  const fakeSession = { agent: { streamFunction: originalStream }, messages: context.messages }
  const dispose = installContextBudgetOverlay(fakeSession, () => settings)
  fakeSession.agent.streamFunction(model, context)
  assert.equal(received.contextBudget.shortenedToolResultCount, 1)
  dispose()
  assert.equal(fakeSession.agent.streamFunction, originalStream)
  const perModelSettings = SettingsManager.create(temporary, temporary)
  perModelSettings.applyOverrides({ compaction: {
    reserveTokens: 1024, keepRecentTokens: 128,
    modelOverrides: { 'openai/budget-a': { reserveTokens: 4096, keepRecentTokens: 512 } }
  } })
  const disposePerModel = installContextBudgetOverlay(fakeSession, requestModel => perModelSettings.getCompactionSettings(requestModel))
  const budgetModel = { ...model, provider: 'openai', id: 'budget-a', maxTokens: 8192 }
  fakeSession.agent.streamFunction(budgetModel, context)
  assert.equal(received.contextBudget.replyReserveTokens, 4096, 'request budget uses the dispatched model override')
  assert.equal(received.contextBudget.recentBudgetTokens, 512)
  fakeSession.agent.streamFunction({ ...budgetModel, id: 'budget-b' }, context)
  assert.equal(received.contextBudget.replyReserveTokens, 1024, 'other models retain the base setting')
  assert.equal(received.contextBudget.recentBudgetTokens, 128)
  disposePerModel()
  assert.equal(fakeSession.agent.streamFunction, originalStream)
  console.log('PASS pure budgets: layers, Unicode, no mutation, paired history, recent parallel batch, protected overflow, unknown windows and wrapper disposal')

  const fullOutput = 'BEGIN LARGE OUTPUT\n' + 'a'.repeat(48000) + '\nEND LARGE OUTPUT'
  fixture = await createPlanFixture({
    providerCallbacks: true,
    respond: n => n <= 4 ? [{ type: 'toolCall', id: `large-${n}`, name: 'read', arguments: { path: 'large.txt' } }] : [{ type: 'text', text: 'done' }]
  })
  await fixture.managed.lifecyclePromise
  await writeFile(join(fixture.project, 'large.txt'), fullOutput)
  fixture.session.agent.state.model = { ...fixture.session.model, contextWindow: 42000, maxTokens: 4096 }
  const entered = await fixture.app.setSessionMode({ sessionPath: fixture.managed.path, mode: 'plan' })
  assert(entered.ok)
  await fixture.session.prompt('Inspect four large read results; preserve this instruction.')
  await fixture.managed.trajectory.flush()
  assert.equal(fixture.requests.length, 5)
  const last = fixture.requests.at(-1)
  const lastSystemPrompt = systemText(last.messages)
  assert(lastSystemPrompt.includes('Investigate, clarify and design'), 'Plan instructions reach the budget wrapper before estimates/capture')
  assert.equal(last.contextBudget.status, 'shortened')
  assert.equal(last.contextBudget.shortenedToolResultCount, 2)
  assert(last.contextBudget.systemTokensEstimate >= Math.ceil(lastSystemPrompt.length / 4))
  const requestResults = last.messages.filter(m => m.role === 'toolResult')
  assert.equal(requestResults.length, 4)
  assert(requestResults[0].content[0].text.includes('Earlier tool result shortened'))
  assert.equal(requestResults.at(-1).content[0].text, fullOutput)
  const savedResults = fixture.session.messages.filter(m => m.role === 'toolResult')
  assert.equal(savedResults.length, 4)
  assert(savedResults.every(m => m.content[0].text === fullOutput), 'SDK model state and session history keep original results')
  const persisted = (await readFile(fixture.managed.path, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert(persisted.filter(e => e.type === 'message' && e.message.role === 'toolResult').every(e => e.message.content[0].text === fullOutput))
  const page = await fixture.app.trajectoryPage({ sessionPath: fixture.managed.path })
  const request = page.items.filter(item => item.kind === 'request').at(-1)
  const statistics = await fixture.app.contextDetail(fixture.managed.path)
  assert.equal(statistics.request.id, request.id)
  assert.equal(statistics.request.inputTokens, 1, 'request input excludes output')
  assert.equal(statistics.request.payloadCaptured, true)
  assert.equal(statistics.breakdown.toolResults, requestResults.reduce((n, message) => n + estimateTokens(message), 0), 'composition measures budgeted request copies, not full persisted outputs')
  assert(statistics.projectionEstimate > statistics.breakdown.total, 'the unbudgeted projection remains independently visible')
  assert.equal(statistics.categories.reduce((n, c) => n + c.tokens, 0), statistics.breakdown.total)
  assert(!JSON.stringify(statistics).includes(fullOutput), 'statistics do not expose tool bodies')
  const selectedModel = fixture.session.model
  fixture.session.agent.state.model = { ...selectedModel, contextWindow: 0 }
  const unknownUsage = fixture.app.snapshot().contextUsage
  assert.equal(unknownUsage.tokens, null)
  assert.equal(unknownUsage.percent, null)
  assert.equal(unknownUsage.contextWindow, 0)
  assert.equal(unknownUsage.revision, statistics.usage.revision, 'unknown windows still publish request metadata revisions')
  fixture.session.agent.state.model = selectedModel
  const revision = fixture.store.getShell().contextUsage
  fixture.store.dispatch({ type: 'context_usage', sessionId: fixture.session.sessionId, sessionPath: fixture.managed.path,
    contextUsage: { ...revision, revision: 'new-request-same-numbers' } })
  assert.equal(fixture.store.getShell().contextUsage.revision, 'new-request-same-numbers', 'PiStore preserves request metadata revisions even when numeric usage is unchanged')
  const exportFile = join(temporary, 'request.json')
  await fixture.app.exportTrajectory(fixture.managed.path, request.id, exportFile)
  const exported = JSON.parse(await readFile(exportFile, 'utf8'))
  assert.equal(exported.documents.context.contextBudget.shortenedToolResultCount, 2)
  assert.equal(exported.documents.payload.messages.filter(m => m.role === 'toolResult')[0].content[0].text, requestResults[0].content[0].text)
  assert.equal(exported.documents.payload.contextBudget, undefined, 'budget diagnostics are not part of the serialized provider payload')
  const firstTool = page.items.find(item => item.kind === 'tool' && item.name === 'read')
  await fixture.app.exportTrajectory(fixture.managed.path, firstTool.id, exportFile)
  const toolExport = JSON.parse(await readFile(exportFile, 'utf8'))
  assert.equal(toolExport.documents.output.content[0].text, fullOutput, 'full output remains inspectable independently of the request projection')
  console.log('PASS real SDK: request-only reduction, original session/tool trace, provider payload, and Plan → budget → trajectory wrapper order')
} finally {
  await fixture?.close()
  await rm(temporary, { recursive: true, force: true })
}
