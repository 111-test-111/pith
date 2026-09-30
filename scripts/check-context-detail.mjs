/**
 * The rail's context pane is derived, not reported: the SDK's `SessionStats`
 * has counts, cumulative tokens and cost, but no reasoning split and no
 * per-role context accounting. `src/main/pi/context-detail.ts` builds those two,
 * and this check pins each of them — the bucketing and how the residue
 * reconciles with the ring's provider-anchored total, the reasoning aggregation
 * (message usage AND summary/standalone usage entries, with a real 0 kept distinct
 * from "no provider reported"), and, the accuracy pin, that the disk fallback's
 * `statsFromEntries` reproduces a REAL `AgentSession.getSessionStats()` exactly
 * on a session file that carries usage, tool results and a compaction. No
 * Electron.
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
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

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const scratch = join(repo, 'node_modules', '.cache', 'pith-context-detail')
const temporary = await mkdtemp(join(tmpdir(), 'pith-context-detail-'))
try {
  await rm(scratch, { recursive: true, force: true })
  await mkdir(scratch, { recursive: true })
  const bundle = join(scratch, 'context-detail.mjs')
  await build({
    entryPoints: [join(repo, 'src/main/pi/context-detail.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    outfile: bundle
  })
  const { buildBreakdown, buildContextDetail, reasoningTokens, statsFromEntries } = await import(bundle)

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
  const noWindow = buildBreakdown(messages, null)
  assert.equal(noWindow.user, estimateTokens(messages[0]), 'user messages land in the user bucket')
  assert.equal(noWindow.assistant, estimateTokens(messages[1]), 'assistant messages land in theirs')
  assert.equal(noWindow.toolResults, estimateTokens(messages[2]), 'tool results land in theirs')
  assert.equal(noWindow.other, estimateTokens(messages[3]), 'a summary is "other"')
  assert.equal(noWindow.total, summed, 'without a provider total the buckets ARE the total')

  // 2. Reconciliation: the provider-anchored context size the ring shows is the
  //    total, and the system prompt + tool schemas ride along in "other" — a bar
  //    whose segments do not add up to the ring would be worse than no bar.
  const anchored = buildBreakdown(messages, summed + 12_000)
  assert.equal(anchored.total, summed + 12_000, 'the ring total wins over the estimate')
  assert.equal(anchored.other, estimateTokens(messages[3]) + 12_000, 'the residue is "other"')
  assert.equal(
    anchored.user + anchored.assistant + anchored.toolResults + anchored.other,
    anchored.total,
    'the four buckets always sum to the total'
  )
  // A provider total SMALLER than the estimate must not shrink the buckets into
  // negative widths; the estimate is then the honest total.
  const smaller = buildBreakdown(messages, 1)
  assert.equal(smaller.total, summed, 'a stale/small usage never cuts the estimate down')

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
      { type: 'compaction', id: 'k1', parentId: 't1', timestamp: stamp(), summary: 'sum', firstKeptEntryId: 't1', tokensBefore: 5000, usage: usage(300, 400, 20, 5, 250, 0.25) },
      { type: 'usage', id: 'g1', parentId: 'k1', timestamp: stamp(), kind: 'fixture', provider: 'fixture', model: 'fixture-model', usage: usage(40, 80, 0, 0, 11, 0.1) },
      { type: 'message', id: 'u2', parentId: 'g1', timestamp: stamp(), message: { role: 'user', timestamp: Date.now(), content: 'again' } },
      { type: 'thinking_level_change', id: 'x1', parentId: 'u2', timestamp: stamp(), thinkingLevel: 'high' }
    ].map((line) => JSON.stringify(line)).join('\n') + '\n'
  )
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

  // The whole DTO over that session: the counts are the stats' own, the
  // breakdown is anchored to the ring's total, and no message body is carried.
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
  assert.equal(detail.breakdown.total, 9000, 'the ring total anchors the breakdown')
  assert.equal(
    detail.breakdown.user + detail.breakdown.assistant + detail.breakdown.toolResults + detail.breakdown.other,
    detail.breakdown.total,
    'and the four buckets sum to it'
  )
  assert.ok(!('messages' in detail), 'no message body rides the DTO any more')

  // 5. Real session files from this machine, to keep the shape honest against
  //    sessions this app did not write: the reasoning split matches an
  //    independent JSONL parse, and the breakdown always sums to the ring.
  const sessionsRoot = join(process.env.HOME ?? '', '.pi', 'agent', 'sessions')
  const files = []
  const walk = async (dir, depth = 0) => {
    if (depth > 3) return
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await walk(path, depth + 1)
      else if (entry.name.endsWith('.jsonl')) files.push(path)
    }
  }
  await walk(sessionsRoot)

  let checked = 0
  for (const sessionFile of files.slice(0, 400)) {
    const text = await readFile(sessionFile, 'utf8').catch(() => '')
    if (!text.includes('"toolCallId"')) continue // a session with a real tool round
    const disk = SessionManager.open(sessionFile)

    // The oracle: straight off the file, no SDK interpretation.
    let expectedReasoning = 0
    let reasoningReported = false
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      let entry
      try {
        entry = JSON.parse(line)
      } catch {
        continue // a torn last line of a live session
      }
      const entryUsage = entry.type === 'message' ? entry.message?.usage : entry.usage
      if (typeof entryUsage?.reasoning === 'number') {
        reasoningReported = true
        expectedReasoning += entryUsage.reasoning
      }
    }

    const diskEntries = disk.getEntries()
    const diskStats = statsFromEntries(diskEntries)
    const { messages: diskMessages } = disk.buildSessionContext()
    const diskDetail = buildContextDetail({
      messages: diskMessages,
      entries: diskEntries,
      stats: diskStats,
      usage: { tokens: 500_000, contextWindow: 1_000_000, percent: 50, sessionCost: diskStats.cost, cacheHitRate: null },
      meta: {
        sessionId: disk.getSessionId(),
        sessionPath: sessionFile,
        title: null,
        cwd: disk.getCwd(),
        projectless: false,
        provider: null,
        model: null,
        thinkingLevel: null,
        createdAt: null,
        lastActivity: null
      }
    })

    assert.equal(
      diskDetail.tokens.reasoning,
      reasoningReported ? expectedReasoning : null,
      `reasoning matches the file's own usage reports: ${sessionFile}`
    )
    assert.equal(diskDetail.breakdown.total, 500_000, `the ring total anchors the breakdown: ${sessionFile}`)
    assert.equal(
      diskDetail.breakdown.user + diskDetail.breakdown.assistant + diskDetail.breakdown.toolResults + diskDetail.breakdown.other,
      diskDetail.breakdown.total,
      `the breakdown sums to the ring: ${sessionFile}`
    )
    assert.ok(diskDetail.breakdown.toolResults > 0, `a tool-using session has tool bytes in context: ${sessionFile}`)
    checked++
    if (checked === 3) break
  }

  console.log(
    'PASS: context detail (bucket math and reconciliation, reasoning incl. summary entries and a real 0,' +
      ` stats identical to a real AgentSession.getSessionStats(), no message bodies in the DTO${checked ? `, ${checked} real session file${checked === 1 ? '' : 's'} against an independent JSONL oracle` : ', no real tool-using session on this machine to check'})`
  )
} finally {
  await rm(temporary, { recursive: true, force: true })
  await rm(scratch, { recursive: true, force: true })
}
