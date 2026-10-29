/** Actual OS SIGKILL/restart matrix over native goals, SDK JSONL and Rewind. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile, rm, writeFile, utimes, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPlanFixture } from './lib/plan-fixture.mjs'

const worker = fileURLToPath(new URL('./lib/goal-recovery-worker.mjs', import.meta.url))
const seed = await createPlanFixture({ withRewind: true, keepFiles: true })
const root = seed.temporary
await seed.close()
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const children = new Set()
function launch(input) {
  const child = spawn(process.execPath, [worker, JSON.stringify({ root, ...input })], { stdio: ['ignore', 'pipe', 'pipe'] })
  children.add(child)
  let stdout = '', stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  const done = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => { children.delete(child); resolve({ code, signal, stdout, stderr }) })
  })
  return { child, done, errors: () => stderr }
}
async function kill(phase, attachments = false) {
  await rm(join(root, 'checkpoint.json'), { force: true })
  const running = launch({ mode: 'start', phase, attachments })
  let checkpoint
  for (let i=0;i<1000;i++) {
    try { checkpoint = JSON.parse(await readFile(join(root, 'checkpoint.json'), 'utf8')); break } catch {}
    if (running.child.exitCode !== null) throw new Error(running.errors())
    await sleep(10)
  }
  assert(checkpoint, `Checkpoint ${phase} was not reached: ${running.errors()}`)
  assert.equal(checkpoint.phase, phase)
  assert(running.child.kill('SIGKILL'))
  assert.equal((await running.done).signal, 'SIGKILL', 'the OS killed the actual owned process')
  return checkpoint
}
async function recover(checkpoint, resume = false) {
  const running = launch({ mode: 'recover', sessionPath: checkpoint.sessionPath, resume })
  const out = await running.done
  assert.equal(out.code, 0, out.stderr)
  const result = JSON.parse(out.stdout.trim())
  assert.equal(result.before.leaf, checkpoint.leaf, 'recovery retains the exact durable SDK leaf')
  assert.equal(result.before.goalEntries, checkpoint.goalEntries, 'recovery never appends a Goal transition')
  assert.equal(result.before.userCount, checkpoint.userCount, 'accepted prompts are not replayed')
  assert.equal(result.before.requests.length, 0)
  if (result.before.goal.accountingAvailable) {
    assert(result.before.goal.tokens >= checkpoint.goal.tokens, 'tokens are never refunded')
    assert(result.before.goal.autoRuns >= checkpoint.goal.autoRuns, 'dispatch allowance is never refunded')
    assert.equal(result.ledger.run, null, 'old claims reconcile rather than replay')
  }
  return result
}
try {
  for (const phase of ['definition', 'initial-claim', 'claim', 'user', 'usage', 'receipt', 'final', 'dismiss', 'plan', 'stop', 'rewind', 'disk-write', 'fork']) {
    const checkpoint = await kill(phase)
    const result = await recover(checkpoint)
    assert.equal(result.before.goal.status, ['final','dismiss'].includes(phase) ? 'completed' : 'paused', phase)
    assert.equal(result.before.goal.accountingAvailable, true, phase)
    if (phase === 'usage' || phase === 'receipt' || phase === 'final') {
      const again = await recover({ ...checkpoint, goal: result.before.goal })
      assert.equal(again.before.goal.tokens, result.before.goal.tokens, 'reopening bills each committed charge once')
    }
    if (phase === 'claim') {
      const resumed = await recover(checkpoint, true)
      assert.equal(resumed.after.userCount, checkpoint.userCount)
      assert.equal(resumed.after.requests.length, 1)
      assert.equal(resumed.after.goal.autoRuns, result.before.goal.autoRuns + 1)
      assert(!resumed.after.hiddenDispatches.includes(checkpoint.dispatchId), 'explicit Resume mints a fresh dispatch instead of replaying a claim')
    }
    if (phase === 'receipt') assert(result.before.goal.criteria.every(c => c.state === 'verified'), 'committed receipt folds after a crash before the redundant state entry')
    assert.equal(result.before.goalUI.submitted,phase!=='dismiss','all retained goals remain discoverable after restart until explicit End')
    if(phase==='dismiss')assert.equal(result.before.goal.dismissed,true,'End survives a process kill without changing the completed outcome')
    if (phase === 'plan') assert.equal(result.before.plan, 'plan')
    if (phase === 'rewind') {
      const committed = result.rewind.operations.find(op => op.status === 'committed')
      assert(committed, 'durable Rewind journal survived the process kill')
      assert.equal(await readFile(join(root, 'project', 'baseline.txt'), 'utf8'), 'Baseline before the goal.\n')
    }
    if (phase === 'fork') { assert.equal(result.before.goal.autoRuns, 1); assert.equal(result.before.goal.tokens, 4); assert.equal(result.before.goal.reason, 'interrupted') }
    console.log(`PASS goal-recovery: SIGKILL after ${phase}`)
  }
  const locked = await kill('lock')
  const refused = await recover(locked)
  assert.equal(refused.before.goal.accountingAvailable, false, 'a live-looking stale lock fails closed')
  assert.equal(refused.before.goal.reason, 'storage')
  const old = new Date(Date.now() - 30_000)
  await utimes(locked.ledgerPath + '.lock', old, old)
  const unlocked = await recover(locked)
  assert.equal(unlocked.before.goal.accountingAvailable, true)
  assert.equal(unlocked.before.goal.autoRuns, 1)
  console.log('PASS goal-recovery: killed lock owner refuses before expiry and reconciles once after stale recovery')

  const pending = await kill('definition', true)
  const saved = await recover(pending)
  assert.equal(saved.before.goal.pendingInput.available, true)
  assert.deepEqual(saved.before.goal.pendingInput.files, ['input.txt','input.bin','large.txt'].map(name=>join(root,'project',name)))
  assert.equal(saved.before.goal.pendingInput.imageCount, 1)
  for(const name of ['input.txt','input.bin','large.txt'])await rm(join(root,'project',name))
  const resumed = await recover(pending, true)
  assert.equal(resumed.result.ok, true)
  assert.equal(resumed.after.requests.length, 1)
  const user = resumed.after.userInputs[0]
  assert(user.some(part => part.type === 'text' && part.text.includes('Captured initial attachment.')))
  assert(user.some(part => part.type === 'image' && part.mimeType === 'image/png'))
  const initialText=user.filter(part=>part.type==='text').map(part=>part.text).join('\n')
  const savedCopies=[...initialText.matchAll(/Saved input copy for inspection: ("[^"\n]+"). The original path/g)].map(match=>JSON.parse(match[1]))
  assert.equal(savedCopies.length,2,'binary and truncated text retain accessible immutable copies')
  assert(savedCopies[0].endsWith('.bin'),'the immutable copy preserves the file type')
  assert.deepEqual(await readFile(savedCopies[0]),Buffer.from([0,1,2,3,254,255]))
  assert.equal((await readFile(savedCopies[1],'utf8')).slice(512*1024),'\nRetained beyond the inline limit.\n')
  assert.equal(resumed.after.userCount, 1)
  assert.equal(resumed.after.goal.autoRuns, 1)
  console.log('PASS goal-recovery: pending immutable file/image input survives SIGKILL and deletion of the original')

  const damaged = await kill('definition', true)
  const inputRoot = join(root, 'userData', 'goals', 'input')
  let receiptPath
  for (const directory of await readdir(inputRoot)) {
    const path = join(inputRoot, directory, 'receipt.json')
    let receipt
    try { receipt = JSON.parse(await readFile(path, 'utf8')) } catch(error) { if(error.code==='ENOENT')continue;throw error }
    if (receipt.goalId === damaged.goal.id) { receiptPath = path; break }
  }
  assert(receiptPath)
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'))
  const blob = join(receiptPath, '..', receipt.files[0].hash + (receipt.files[0].extension ?? ''))
  await writeFile(blob, Buffer.alloc(receipt.files[0].bytes, 65))
  const corrupt = await recover(damaged, true)
  assert.equal(corrupt.after.requests.length, 0)
  assert.equal(corrupt.after.goal.reason, 'input')
  assert.equal(corrupt.after.goal.autoRuns, 0)
  await rm(blob)
  // The preceding explicit Resume persisted limits/input refusal. The next
  // restart must retain that new endpoint, not the earlier kill checkpoint.
  const missing = await recover({ ...damaged, ...corrupt.after }, true)
  assert.equal(missing.result.code, 'attachments')
  assert.equal(missing.after.requests.length, 0)
  console.log('PASS goal-recovery: missing/tampered immutable input cannot dispatch or consume allowance')
  const accepted = await kill('user', true)
  await rm(join(root, 'project', 'input.txt'))
  const continued = await recover(accepted, true)
  assert.equal(continued.after.requests.length, 1)
  assert.equal(continued.after.userCount, 1, 'a committed attachment-bearing prompt is never replayed')
  assert.equal(continued.after.hiddenDispatches.length, 1)
  console.log('PASS goal-recovery: committed attachments stay in context and explicit Resume never replays the initial input')
  for (const kind of ['missing', 'corrupt']) {
    const unavailable = await kill('definition')
    if (kind === 'missing') await rm(unavailable.ledgerPath)
    else await writeFile(unavailable.ledgerPath, '{invalid accounting')
    const refused = await recover(unavailable, true)
    assert.equal(refused.before.goal.accountingAvailable, false)
    assert.equal(refused.result.code, 'storage')
    assert.equal(refused.after.requests.length, 0)
  }
  console.log('PASS goal-recovery: missing/corrupt accounting never becomes a zero-usage allowance')
} finally {
  for (const child of children) child.kill('SIGKILL')
  await rm(root, { recursive: true, force: true })
}
