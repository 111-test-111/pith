/** SDK billing records must survive cross-session aggregation, including non-chat requests. */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { SessionManager } from '@earendil-works/pi-coding-agent'

const temporary = await mkdtemp(join(tmpdir(), 'pith-usage-stats-'))
try {
  const outfile = join(temporary, 'usage.mjs')
  await build({ entryPoints: [fileURLToPath(new URL('../src/main/pi/usage-stats.ts', import.meta.url))],
    bundle: true, platform: 'node', format: 'esm', outfile })
  const { createUsageAccumulator, accumulateSessionFile, finalizeUsage } = await import(pathToFileURL(outfile).href)
  const usage = n => ({ input: n, output: n, cacheRead: n, cacheWrite: n, totalTokens: n * 4,
    cost: { input: n, output: n, cacheRead: n, cacheWrite: n, total: n * 4 } })
  const manager = SessionManager.inMemory(temporary)
  manager.appendModelChange('chat-provider', 'chat-model')
  const user = manager.appendMessage({ role: 'user', content: 'First turn', timestamp: Date.now() })
  manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'Answer' }],
    provider: 'chat-provider', model: 'chat-model', api: 'openai-completions', stopReason: 'stop',
    timestamp: Date.now(), usage: usage(1) })
  manager.appendUsage('cache_warm', 'warm-provider', 'warm-model', usage(2))
  manager.appendCompaction('Summary', user, 100, undefined, false, usage(3))
  manager.branchWithSummary(user, 'Branch summary', undefined, false, usage(4))
  manager.appendMessage({ role: 'user', content: 'Second turn', timestamp: Date.now() })
  manager.appendMessage({ role: 'toolResult', toolName: 'classifier', toolCallId: 'nested-usage',
    content: [{ type: 'text', text: 'Judged' }], isError: false, timestamp: Date.now(), usage: usage(5) })
  manager.appendMessage({ role: 'toolResult', toolName: 'vision_analyze', toolCallId: 'legacy',
    content: [{ type: 'text', text: 'Image read' }], isError: false, timestamp: Date.now(), usage: usage(6),
    details: { kind: 'pi-web-vision', provider: 'vision-provider', modelId: 'vision-model' } })
  manager.appendCustomEntry('pi-web:model-space-usage', { provider: 'space-provider', modelId: 'space-model', usage: usage(7) })
  // Persisted source usage counts exactly once: metadata and nested summaries
  // can carry copies, which are not additional billed requests.
  manager.appendCustomEntry('copied-usage', { usage: usage(100) })
  const text = manager.getEntries().map(e => JSON.stringify(e)).join('\n') + '\n{"type":"usage"'
  const acc = createUsageAccumulator(123)
  accumulateSessionFile(acc, text)
  const result = finalizeUsage(acc, 100)
  assert.equal(result.totalTokens, 112)
  assert.equal(result.totalCost, 112)
  assert.equal(result.totalRequests, 7)
  assert.deepEqual(result.records.map(r => r.tokens).sort((a, b) => a - b), [40, 72])
  const bucket = key => result.models.find(m => m.key === key)
  assert.equal(bucket('warm-provider/warm-model').totalTokens, 8)
  assert.equal(bucket('chat-provider/chat-model').totalTokens, 32)
  assert.equal(bucket('vision-provider/vision-model').totalTokens, 24)
  assert.equal(bucket('unknown/unknown').totalTokens, 20, 'unattributed tool usage must not be charged to the chat model')
  console.log('PASS: SDK cache-warming, compaction, branch summaries, tool usage and legacy records count once with correct turn/model attribution; torn lines are ignored.')
} finally {
  await rm(temporary, { recursive: true, force: true })
}
