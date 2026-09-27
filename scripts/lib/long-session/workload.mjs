import { createHash } from 'node:crypto'
import { open, stat } from 'node:fs/promises'
import { join } from 'node:path'

// Fixed input, independent of clocks, user files, network and random seeds.
export const WORKLOAD_VERSION = 1
export const EPOCH = 1_800_000_000_000
export const LARGE_RESULT_CHARS = 1_048_576
export const SESSION_ID = 'long-session-benchmark-v1'
const usage = { input: 120, output: 24, cacheRead: 20, cacheWrite: 0, totalTokens: 164,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
const log = 'PASS fixture suite · 中文😀\n'
const source = 'export function value() { return "中文😀" }\n'
const fill = (text, chars) => text.repeat(Math.ceil(chars / text.length)).slice(0, chars).toWellFormed()

export function *syntheticMessages(turns) {
  for (let turn = 0; turn < turns; turn++) {
    const timestamp = EPOCH + turn * 10
    const read = `read-${turn}`, bash = `bash-${turn}`
    const assistant = (content, offset, stopReason) => ({ role: 'assistant', content,
      api: 'openai-completions', provider: 'benchmark', model: 'offline-fixture', usage,
      stopReason, timestamp: timestamp + offset, completedAt: timestamp + offset + 1,
      changeScopeId: `scope-${turn}` })
    yield { role: 'user', content: `Inspect src/module-${turn}.ts and run the deterministic check.`, timestamp }
    yield assistant([{ type: 'thinking', thinking: 'Read the source, inspect the check, and report the result.' },
      { type: 'toolCall', id: read, name: 'read', arguments: { path: `src/module-${turn}.ts` } },
      { type: 'toolCall', id: bash, name: 'bash', arguments: { command: `node check-${turn}.mjs` } }], 1, 'toolUse')
    yield { role: 'toolResult', toolCallId: read, toolName: 'read', isError: false, timestamp: timestamp + 2,
      content: [{ type: 'text', text: fill(source, 1024) }] }
    yield { role: 'toolResult', toolCallId: bash, toolName: 'bash', isError: false, timestamp: timestamp + 3,
      content: [{ type: 'text', text: fill(log, turn === turns - 1 ? LARGE_RESULT_CHARS : turn % 100 === 0 ? 65536 : 2048) }] }
    yield assistant([{ type: 'text', text: `Module ${turn} checked.\n\n- Source inspected\n- Check passed\n\nResult: **${turn % 7}**.` }], 4, 'stop')
  }
}

export function snapshot(messages, sessionPath) {
  return { sessionId: SESSION_ID, sessionPath, cwd: '/benchmark', projectless: false,
    model: null, thinkingLevel: 'off', isStreaming: false, eventSequence: 0, messages }
}

export async function writeWorkload(directory, turns) {
  const sessionPath = join(directory, 'session.jsonl')
  const file = await open(sessionPath, 'w', 0o600)
  const hash = createHash('sha256')
  let parentId = null, count = 0, bytes = 0
  const write = async value => {
    const line = JSON.stringify(value) + '\n'; hash.update(line); bytes += Buffer.byteLength(line)
    await file.writeFile(line)
  }
  try {
    await write({ type: 'session', version: 3, id: SESSION_ID,
      timestamp: new Date(EPOCH).toISOString(), cwd: '/benchmark' })
    for (const message of syntheticMessages(turns)) {
      const id = `e${String(++count).padStart(8, '0')}`
      await write({ type: 'message', id, parentId, timestamp: new Date(message.timestamp).toISOString(), message })
      parentId = id
    }
  } finally { await file.close() }
  return { sessionPath, sessionId: SESSION_ID, leafId: parentId, turns, messages: count,
    sessionBytes: (await stat(sessionPath)).size, sha256: hash.digest('hex'),
    toolCalls: turns * 2, largeResultChars: LARGE_RESULT_CHARS,
    largeResultLines: fill(log, LARGE_RESULT_CHARS).split('\n').length, version: WORKLOAD_VERSION,
    regularResultChars: [1024, 2048], occasionalResultChars: 65536, occasionalEveryTurns: 100 }
}
