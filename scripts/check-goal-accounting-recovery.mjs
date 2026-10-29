/** Actual process kills before/after child and Jev receipts and pool application. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPlanFixture } from './lib/plan-fixture.mjs'

const worker = fileURLToPath(new URL('./lib/goal-accounting-recovery-worker.mjs', import.meta.url))
const seed = await createPlanFixture({ keepFiles: true })
const root = seed.temporary
await seed.close()
const children = new Set(), sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
function launch(input) {
  const child = spawn(process.execPath, [worker, JSON.stringify({ root, ...input })], { stdio: ['ignore', 'pipe', 'pipe'] })
  children.add(child)
  let stdout = '', stderr = ''
  child.stdout.on('data', bytes => { stdout += bytes }); child.stderr.on('data', bytes => { stderr += bytes })
  const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => { children.delete(child); resolve({ stdout, stderr, code, signal }) }) })
  return { child, done, errors: () => stderr }
}
async function kill(phase) {
  await rm(join(root, 'accounting-checkpoint.json'), { force: true })
  const running = launch({ mode: 'start', phase })
  let checkpoint
  for (let i = 0; i < 1200; i++) {
    try { checkpoint = JSON.parse(await readFile(join(root, 'accounting-checkpoint.json'), 'utf8')); break } catch {}
    if (running.child.exitCode !== null) throw new Error(running.errors())
    await sleep(10)
  }
  assert(checkpoint, running.errors()); assert.equal(checkpoint.phase, phase)
  assert(running.child.kill('SIGKILL')); assert.equal((await running.done).signal, 'SIGKILL')
  return checkpoint
}
async function recover(checkpoint) {
  const result = await launch({ mode: 'recover', sessionPath: checkpoint.sessionPath }).done
  assert.equal(result.code, 0, result.stderr)
  const out = JSON.parse(result.stdout.trim())
  assert.equal(out.before.leaf, checkpoint.leaf, 'no recovery fact changes the reviewed SDK leaf')
  assert.equal(out.before.userCount, checkpoint.userCount, 'accepted turns are not replayed')
  assert.equal(out.requests, 0)
  return out
}
try {
  for (const phase of ['jev-claim', 'jev-receipt', 'jev-applied', 'child-claim', 'child-receipt', 'child-response', 'child-entry', 'child-applied', 'child-deleted', 'fork']) {
    const checkpoint = await kill(phase)
    const first = await recover(checkpoint), second = await recover(checkpoint)
    const unknown = phase.endsWith('-claim')
    assert.equal(first.before.goal.accountingAvailable, !unknown, phase)
    assert.equal(first.result.code, unknown ? 'accounting' : 'quota', phase)
    assert.equal(first.before.goal.tokens, 4 + (unknown ? 0 : 7), phase)
    assert.deepEqual(second.before.goal.billing, first.before.goal.billing, 'repeat restart keeps independent sums and unresolved ownership')
    assert.equal(second.before.goal.tokens, first.before.goal.tokens)
    assert.equal(first.before.goal.billing.parentTokens, 4)
    assert.equal(first.before.goal.billing.unresolved, unknown ? 1 : 0)
    assert.equal(first.before.goal.billing[phase.startsWith('jev') ? 'jevTokens' : 'subagentTokens'], unknown ? 0 : 7)
    console.log(`PASS goal-accounting-recovery: SIGKILL after ${phase}, recovered twice without replay/double charge`)
  }
} finally { for (const child of children) child.kill('SIGKILL'); await rm(root, { recursive: true, force: true }) }
