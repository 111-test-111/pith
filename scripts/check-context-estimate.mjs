/**
 * The composer's context ring must survive a compaction.
 *
 * `AgentSession.getContextUsage()` deliberately reports no token count once a
 * compaction boundary exists — the only provider usage it can see belongs to an
 * assistant that answered before that boundary, and that number describes the
 * context that was just summarized away. Main therefore falls back to the
 * estimate the SDK itself uses for a compaction's `estimatedTokensAfter`:
 * `src/main/pi/context-estimate.ts`, checked here against the real SDK
 * estimator and a real compacted session file. No Electron.
 */
import assert from 'node:assert/strict'
import { mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { estimateTokens, SessionManager } from '@earendil-works/pi-coding-agent'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// Built inside the repo: a bundle in the OS temp dir cannot resolve the SDK
// package back to this project's node_modules.
const scratch = join(repo, 'node_modules', '.cache', 'pith-context-estimate')
try {
  await rm(scratch, { recursive: true, force: true })
  await mkdir(scratch, { recursive: true })
  const bundle = join(scratch, 'context-estimate.mjs')
  await build({
    entryPoints: [join(repo, 'src/main/pi/context-estimate.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    outfile: bundle
  })
  const { compactedContextTokens } = await import(bundle)

  const user = (timestamp, text) => ({ role: 'user', timestamp, content: text })
  const assistant = (timestamp, text) => ({
    role: 'assistant',
    timestamp,
    content: [{ type: 'text', text }]
  })
  const summary = (text, tokensBefore, timestamp = 900) => ({
    role: 'compactionSummary',
    summary: text,
    tokensBefore,
    timestamp
  })

  // A session that was never compacted keeps its blank ring: this estimate
  // covers neither the system prompt nor the tool schemas, so inventing one
  // would be worse than the honest `—`.
  assert.equal(compactedContextTokens([]), null, 'an empty session has nothing to estimate')
  assert.equal(
    compactedContextTokens([user(1, 'hello'), assistant(2, 'hi')]),
    null,
    'a session without a compaction summary never takes the fallback'
  )

  // The metric has to be the SDK's own: a compaction's `estimatedTokensAfter`
  // is the summed per-message estimate over the compacted list, so the ring
  // shows the same number the SDK computed while compacting.
  const compacted = [
    summary('Long summary of everything that happened.', 204325),
    user(1, 'kept request'),
    assistant(2, 'kept answer'),
    user(3, 'another kept request'),
    assistant(4, 'another kept answer')
  ]
  const expected = compacted.reduce((total, message) => total + estimateTokens(message), 0)
  assert.equal(compactedContextTokens(compacted), expected, 'the estimate matches the SDK estimator')
  assert.ok(expected > 0 && expected < 204325, `a compacted context is smaller than what it replaced: ${expected}`)

  // The summary is part of the context that will be sent, so a bigger summary
  // must move the ring — it is not a constant standing in for "unknown".
  const bigger = [
    summary('Long summary of everything that happened. '.repeat(400), 204325),
    ...compacted.slice(1)
  ]
  assert.ok(
    compactedContextTokens(bigger) > expected,
    'a longer summary raises the estimate'
  )

  // End to end on a real session file, when one exists: the context the SDK
  // rebuilt for a compacted session is what the ring shows.
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
  for (const file of files.slice(0, 400)) {
    const raw = await readFile(file, 'utf8').catch(() => '')
    if (!raw.includes('"type":"compaction"')) continue
    const manager = SessionManager.open(file)
    const { messages } = manager.buildSessionContext()
    const tokens = compactedContextTokens(messages)
    assert.ok(tokens !== null, `a compacted session yields an estimate: ${file}`)
    const before = manager.getEntries().filter((entry) => entry.type === 'compaction').at(-1)?.tokensBefore ?? 0
    assert.ok(tokens > 0, `the estimate is a real number: ${file}`)
    assert.ok(tokens < before, `the ring drops after a compaction (${tokens} < ${before}): ${file}`)
    checked++
    if (checked === 3) break
  }
  console.log(
    `PASS: compaction context estimate (metric identical to the SDK's, no fallback without a summary` +
      `${checked ? `, ${checked} real compacted session${checked === 1 ? '' : 's'} verified` : ', no real compacted session on this machine to check'})`
  )
} finally {
  await rm(scratch, { recursive: true, force: true })
}
