/**
 * The rail's context pane is derived, not reported: the SDK's `SessionStats`
 * has counts, cumulative tokens and cost, but no reasoning split and no
 * context composition. This check pins independent estimates, system replay,
 * exact request provenance and reasoning aggregation
 * (message usage AND summary/standalone usage entries, with a real 0 kept distinct
 * from "no provider reported"), and, the accuracy pin, that the disk fallback's
 * `statsFromEntries` reproduces a REAL `AgentSession.getSessionStats()` exactly
 * on a real session file with usage, compaction, context edits and branches.
 * No Electron or live provider calls.
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  estimateTokens,
  SessionManager,
  SettingsManager
} from '@earendil-works/pi-coding-agent'
import { convertToLlm } from '@earendil-works/pi-coding-agent'
import { createPlanFixture } from './lib/plan-fixture.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const scratch = join(repo, 'node_modules', '.cache', 'pith-context-detail')
const temporary = await mkdtemp(join(tmpdir(), 'pith-context-detail-'))
let fixture
try {
  await rm(scratch, { recursive: true, force: true })
  await mkdir(scratch, { recursive: true })
  const bundle = join(scratch, 'context-detail.mjs')
  await build({
    stdin: { contents: "export * from './src/main/pi/context-detail'; export { contextComposition } from './src/main/pi/context-composition';", resolveDir: repo },
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    outfile: bundle
  })
  const { buildBreakdown, buildContextDetail, cacheHitRate, contextComposition, reasoningTokens, statsFromEntries } = await import(bundle)
  const { getCurrentSystemMessage } = await import(new URL('../node_modules/@earendil-works/pi-ai/dist/index.js', import.meta.resolve('@earendil-works/pi-coding-agent')))

  const user = (text) => ({ role: 'user', content: text })
  const assistant = (text, extra = {}) => ({ role: 'assistant', content: [{ type: 'text', text }], ...extra })
  const toolResult = (text) => ({ role: 'toolResult', toolCallId: 'c1', content: text })

  // 1. Bucketing: the three named roles get their own bucket, everything else
  //    (summaries, extension state, bash executions) lands in "other".
  const messages = [user('u'), assistant('a'), toolResult('t'), { role: 'compactionSummary', summary: 's' }]
  const summed =
    estimateTokens(messages[0]) +
    estimateTokens(messages[1]) +
    estimateTokens(messages[2]) +
    estimateTokens(messages[3])
  const noWindow = buildBreakdown(messages)
  assert.equal(noWindow.user, estimateTokens(messages[0]), 'user messages land in the user bucket')
  assert.equal(noWindow.assistant, estimateTokens(messages[1]), 'assistant messages land in theirs')
  assert.equal(noWindow.toolResults, estimateTokens(messages[2]), 'tool results land in theirs')
  assert.equal(noWindow.other, estimateTokens(messages[3]), 'a summary is "other"')
  assert.equal(noWindow.total, summed, 'without a provider total the buckets ARE the total')

  // 2. Replay against the SDK, including replacements, removals and re-adds.
  const patches = [
    { role: 'system', timestamp: 0, content: 'base', sections: { files: 'x'.repeat(12000), removed: 'gone' }, toolsAdded: [{ name: 'read', description: 'x'.repeat(1000), parameters: {} }] },
    { role: 'system', timestamp: 1, content: 'append', sections: { files: 'short', removed: null }, toolsRemoved: [{ name: 'read' }] },
    { role: 'system', timestamp: 2, content: '', toolsAdded: [{ name: 'read', description: 'new', parameters: {} }] }
  ]
  const patched = buildBreakdown([...patches, ...messages])
  const expectedSystem = estimateTokens(getCurrentSystemMessage(patches))
  assert.equal(patched.other, expectedSystem + estimateTokens(messages[3]), 'superseded prompts and removed schemas do not accumulate')
  assert.equal(patched.total, summed + expectedSystem, 'system is measured once, independently of usage')
  assert.equal(cacheHitRate({ input: 0, output: 1000, cacheRead: 100, cacheWrite: 100, total: 1200 }), 0.5, 'cache writes are misses; output is excluded')
  assert.equal(cacheHitRate({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }), null)

  const splitMessages = [...patches,
    { role: 'system', timestamp: 3, content: '', sections: { project_context: '<project_context>instructions</project_context>', skills: '<skills>descriptions</skills>' } },
    { role: 'user', content: [{ type: 'text', text: 'user' }, { type: 'image', data: 'x'.repeat(100000), mimeType: 'image/png' }], timestamp: 4 },
    { role: 'assistant', content: [{ type: 'text', text: 'answer' }, { type: 'thinking', thinking: 'visible reasoning', thinkingSignature: 'opaque'.repeat(20000) }, { type: 'toolCall', name: 'read', id: 'split', arguments: { path: 'file' } }], timestamp: 5 },
    { role: 'toolResult', toolName: 'read', content: [{ type: 'text', text: 'output' }], timestamp: 6 }
  ]
  const split = contextComposition(splitMessages)
  assert.equal(split.categories.reduce((n, c) => n + c.tokens, 0), split.breakdown.total)
  for (const kind of ['projectFiles', 'skills', 'toolSchemas', 'images', 'thinking', 'toolCalls', 'toolResults']) assert(split.categories.some(c => c.kind === kind), kind)
  assert.equal(split.categories.find(c => c.kind === 'images').tokens, 1200, 'images use the SDK fixed estimate, not base64 length')
  const shortImage = contextComposition([{ role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'image', data: 'AA', mimeType: 'image/png' }], timestamp: 1 }])
  assert.equal(shortImage.categories.find(c => c.kind === 'images').tokens, 1200, 'text rounding cannot consume or enlarge the fixed image estimate')
  assert.equal(shortImage.categories.find(c => c.kind === 'userText').tokens, 1)
  splitMessages.find(m => m.role === 'assistant').content.find(b => b.type === 'thinking').thinkingSignature = 'changed'
  assert.deepEqual(contextComposition(splitMessages), split, 'opaque signatures do not inflate visible reasoning')
  const sources = [
    { role: 'custom', customType: 'fixture', content: 'custom state', display: false, timestamp: 7 },
    { role: 'compactionSummary', summary: 'summary', timestamp: 8 },
    { role: 'branchSummary', summary: 'branch', timestamp: 9 }
  ]
  const converted = convertToLlm(sources)
  const attributed = contextComposition([...converted, converted[0]], sources)
  assert(attributed.categories.some(c => c.kind === 'extensions'))
  assert(attributed.categories.some(c => c.kind === 'summaries'))
  assert.equal(attributed.categories.find(c => c.kind === 'requestOnly').tokens, estimateTokens(converted[0]), 'exact multiplicities distinguish additional request content from saved custom messages')
  const schemas = Array.from({ length: 50 }, (_, i) => ({ name: `schema-${i}`, description: 'definition', parameters: {} }))
  const many = contextComposition([{ role: 'system', content: '', toolsAdded: schemas, timestamp: 0 }])
  assert.equal(many.categories[0].items.length, 24)
  assert.equal(many.categories[0].omittedItems, 26)
  assert.equal(many.breakdown.total, estimateTokens({ role: 'system', content: '', toolsAdded: schemas, timestamp: 0 }), 'bounded names retain the full token total')

  // 3. Reasoning: message usage and the summary entries' own usage, and a real
  //    0 stays 0 instead of reading as "unknown".
  const entries = [
    { type: 'message', message: assistant('a', { usage: { reasoning: 300 } }) },
    { type: 'message', message: assistant('b', { usage: { reasoning: 12 } }) },
    { type: 'message', message: user('u') },
    { type: 'compaction', usage: { reasoning: 7 } },
    { type: 'branch_summary', usage: { reasoning: 1 } },
    { type: 'usage', usage: { reasoning: 5 } },
    { type: 'custom', data: { anything: true } }
  ]
  assert.equal(reasoningTokens(entries), 325, 'reasoning sums message, summary and standalone usage')
  assert.equal(reasoningTokens([{ type: 'message', message: { role: 'assistant' } }]), null, 'no split reported reads as unknown')
  assert.equal(
    reasoningTokens([{ type: 'message', message: assistant('a', { usage: { reasoning: 0 } }) }]),
    0,
    'a reported zero is a number, not "unknown"'
  )

  // 4. The accuracy pin: `statsFromEntries` (the fallback for a session file
  //    nobody holds open) has to reproduce the SDK's own stats, down to the
  //    summary entries' usage. A synthetic file with real usage reports, a tool
  //    round and a compaction, read through a real AgentSession.
  const project = join(temporary, 'project')
  const agentDir = join(temporary, 'agent')
  const sessions = join(temporary, 'sessions')
  await mkdir(project, { recursive: true })
  await mkdir(agentDir, { recursive: true })
  await mkdir(sessions, { recursive: true })
  const usage = (input, output, cacheRead, cacheWrite, reasoning, cost) => ({
    input,
    output,
    cacheRead,
    cacheWrite,
    reasoning,
    totalTokens: input + output + cacheRead + cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost }
  })
  const file = join(sessions, 'probe.jsonl')
  const stamp = () => new Date().toISOString()
  await writeFile(
    file,
    [
      { type: 'session', version: 3, id: 'probe', timestamp: stamp(), cwd: project },
      { type: 'message', id: 'u1', parentId: null, timestamp: stamp(), message: { role: 'user', timestamp: Date.now(), content: 'hello' } },
      {
        type: 'message',
        id: 'a1',
        parentId: 'u1',
        timestamp: stamp(),
        message: {
          role: 'assistant',
          timestamp: Date.now(),
          provider: 'fixture',
          model: 'fixture-model',
          stopReason: 'stop',
          content: [{ type: 'text', text: 'hi' }, { type: 'toolCall', id: 'c1', name: 'read', arguments: {} }],
          usage: usage(100, 200, 50, 10, 120, 0.5)
        }
      },
      {
        type: 'message',
        id: 't1',
        parentId: 'a1',
        timestamp: stamp(),
        message: { role: 'toolResult', toolCallId: 'c1', toolName: 'read', content: 'ok', timestamp: Date.now(), usage: usage(1000, 5, 800, 0, 3, 0.02) }
      },
      { type: 'compaction', id: 'k1', parentId: 't1', timestamp: stamp(), summary: 'sum', firstKeptEntryId: 't1', tokensBefore: 5000, usage: usage(300, 400, 20, 5, 250, 0.25), systemMessage: patches[0] },
      { type: 'usage', id: 'g1', parentId: 'k1', timestamp: stamp(), kind: 'fixture', provider: 'fixture', model: 'fixture-model', usage: usage(40, 80, 0, 0, 11, 0.1) },
      { type: 'message', id: 'u2', parentId: 'g1', timestamp: stamp(), message: { role: 'user', timestamp: Date.now(), content: 'again' } },
      { type: 'thinking_level_change', id: 'x1', parentId: 'u2', timestamp: stamp(), thinkingLevel: 'high' }
    ].map((line) => JSON.stringify(line)).join('\n') + '\n'
  )
  await writeFile(file, [
    { type: 'message', id: 's2', parentId: 'x1', timestamp: stamp(), message: patches[1] },
    { type: 'custom_message', id: 'c2', parentId: 's2', timestamp: stamp(), customType: 'fixture', content: 'custom state'.repeat(100), display: false },
    { type: 'branch_summary', id: 'b2', parentId: 'c2', timestamp: stamp(), fromId: 'a1', summary: 'branch summary'.repeat(100) },
    { type: 'context_edit', id: 'e2', parentId: 'b2', timestamp: stamp(), targetId: 'u2', replacement: { content: 'z' } },
    { type: 'model_change', id: 'selected-model', parentId: 'e2', timestamp: stamp(), provider: 'selected-provider', modelId: 'selected-model' },
    { type: 'message', id: 'abandoned', parentId: 'x1', timestamp: stamp(), message: assistant('old branch', { timestamp: Date.now(), provider: 'abandoned-provider', model: 'abandoned-model', api: 'openai-completions', stopReason: 'stop', usage: usage(0, 0, 0, 0, 0, 0) }) },
    { type: 'thinking_level_change', id: 'abandoned-level', parentId: 'abandoned', timestamp: stamp(), thinkingLevel: 'off' },
    { type: 'custom', id: 'selected-leaf', parentId: 'selected-model', timestamp: stamp(), customType: 'fixture', data: {} }
  ].map(line => JSON.stringify(line)).join('\n') + '\n', { flag: 'a' })
  const manager = SessionManager.open(file)
  const fileEntries = manager.getEntries()
  const services = await createAgentSessionServices({
    cwd: project,
    agentDir,
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
    resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true }
  })
  const { session } = await createAgentSessionFromServices({ services, sessionManager: manager })
  const sdkStats = session.getSessionStats()
  const mine = statsFromEntries(fileEntries)
  assert.equal(mine.userMessages, sdkStats.userMessages, 'user count matches the SDK')
  assert.equal(mine.assistantMessages, sdkStats.assistantMessages, 'assistant count matches the SDK')
  assert.equal(mine.toolCalls, sdkStats.toolCalls, 'tool calls match the SDK')
  assert.equal(mine.toolResults, sdkStats.toolResults, 'tool results match the SDK')
  assert.equal(mine.totalMessages, sdkStats.totalMessages, 'message count matches the SDK')
  assert.deepEqual(mine.tokens, sdkStats.tokens, 'cumulative tokens match the SDK, summary and standalone usage included')
  assert.equal(mine.cost, sdkStats.cost, 'cost matches the SDK')
  assert.equal(
    reasoningTokens(fileEntries),
    120 + 3 + 250 + 11,
    'reasoning counts the assistant round, tool result, compaction and standalone usage'
  )

  // Billing, live usage and composition remain independent; no body is carried.
  const { messages: contextMessages } = manager.buildSessionContext()
  const detail = buildContextDetail({
    messages: contextMessages,
    entries: fileEntries,
    stats: mine,
    usage: { tokens: 9000, contextWindow: 20_000, percent: 45, sessionCost: mine.cost, cacheHitRate: 0.9 },
    meta: {
      sessionId: manager.getSessionId(),
      sessionPath: file,
      title: 'probe',
      cwd: project,
      projectless: false,
      provider: 'fixture',
      model: 'fixture-model',
      thinkingLevel: 'high',
      createdAt: Date.now(),
      lastActivity: Date.now()
    }
  })
  assert.equal(detail.totalMessages, sdkStats.totalMessages, 'the DTO carries the stats verbatim')
  assert.equal(detail.userMessages, sdkStats.userMessages)
  assert.equal(detail.assistantMessages, sdkStats.assistantMessages)
  assert.equal(detail.toolCalls, sdkStats.toolCalls)
  assert.equal(detail.toolResults, sdkStats.toolResults)
  assert.equal(detail.tokens.input, sdkStats.tokens.input)
  assert.equal(detail.cost, sdkStats.cost)
  assert.equal(detail.tokens.reasoning, 384)
  assert.equal(detail.breakdown.total, buildBreakdown(contextMessages).total, 'composition has its own estimate total')
  assert.notEqual(detail.breakdown.total, detail.usage.tokens, 'provider residual is not attributed to system content')
  assert.equal(
    detail.breakdown.user + detail.breakdown.assistant + detail.breakdown.toolResults + detail.breakdown.other,
    detail.breakdown.total,
    'and the four buckets sum to it'
  )
  assert.ok(!('messages' in detail), 'no message body rides the DTO any more')

  fixture = await createPlanFixture()
  await fixture.managed.lifecyclePromise
  const cold = await fixture.app.contextDetail(file)
  const canonical = manager.buildSessionProjection().messages
  assert(canonical.some(m => m.role === 'compactionSummary') && canonical.some(m => m.role === 'custom') && canonical.some(m => m.role === 'branchSummary'))
  assert(canonical.some(m => m.role === 'user' && m.content === 'z'), 'context edit is applied to the projection')
  assert.deepEqual(cold.breakdown, buildBreakdown(canonical), 'cold detail includes checkpoints, summaries, custom messages and context edits')
  assert.equal(cold.request, null, 'older logs never pretend their saved history was a captured request')
  assert.equal(cold.provider, 'selected-provider')
  assert.equal(cold.model, 'selected-model')
  assert.equal(cold.thinkingLevel, 'high', 'abandoned branch metadata cannot replace selected branch settings')
  assert.deepEqual(cold.tokens, detail.tokens, 'billing still includes every branch')

  console.log(
    'PASS: context detail (SDK system replay, independent estimates, cache writes, reasoning incl. summary entries and a real 0,' +
      ' stats identical to a real AgentSession.getSessionStats(), no message bodies in the DTO)'
  )
} finally {
  await fixture?.close()
  await rm(temporary, { recursive: true, force: true })
  await rm(scratch, { recursive: true, force: true })
}
