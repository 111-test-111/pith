/**
 * The composer's context ring must survive a compaction.
 *
 * `AgentSession.getContextUsage()` deliberately reports no token count once a
 * compaction boundary exists — the only provider usage it can see belongs to an
 * assistant that answered before that boundary, and that number describes the
 * context that was just summarized away. The fallback folds current system
 * state and estimates the canonical projection with the installed SDK. No
 * Electron or provider calls.
 */
import assert from 'node:assert/strict'
import { mkdir, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { estimateTokens } from '@earendil-works/pi-coding-agent'

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
  const { getCurrentSystemMessage } = await import(new URL('../node_modules/@earendil-works/pi-ai/dist/index.js', import.meta.resolve('@earendil-works/pi-coding-agent')))

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

  // Only post-compaction unknown usage needs this fallback.
  assert.equal(compactedContextTokens([]), null, 'an empty session has nothing to estimate')
  assert.equal(
    compactedContextTokens([user(1, 'hello'), assistant(2, 'hi')]),
    null,
    'a session without a compaction summary never takes the fallback'
  )

  // Without system patches this is the SDK's summed compacted-message estimate.
  const compacted = [
    summary('Long summary of everything that happened.', 204325),
    user(1, 'kept request'),
    assistant(2, 'kept answer'),
    user(3, 'another kept request'),
    assistant(4, 'another kept answer')
  ]
  const expected = compacted.reduce((total, message) => total + estimateTokens(message), 0)
  assert.equal(compactedContextTokens(compacted), expected, 'the estimate matches the SDK estimator')
  const systemUpdates = [
    { role: 'system', timestamp: 0, content: 'base', sections: { large: 'x'.repeat(12000) }, toolsAdded: [{ name: 'read', description: 'old', parameters: {} }] },
    { role: 'system', timestamp: 1, content: '', sections: { large: 'small' }, toolsRemoved: [{ name: 'read' }] }
  ]
  assert.equal(compactedContextTokens([...systemUpdates, ...compacted]), expected + estimateTokens(getCurrentSystemMessage(systemUpdates)), 'post-compaction estimate folds checkpoints and subsequent system patches like the SDK')
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

  console.log(
    "PASS: compaction context estimate (metric identical to the SDK's, no fallback without a summary, larger summaries raise the estimate)"
  )
} finally {
  await rm(scratch, { recursive: true, force: true })
}
