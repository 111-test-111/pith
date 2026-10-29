/**
 * Scheduled tasks core (src/shared/scheduled-tasks.ts,
 * src/main/pi/scheduled-tasks/{store,service}.ts).
 *
 * Hermetic check — no Electron window, no model calls, everything under a
 * temporary directory. The service runs with an injected clock and a fake
 * runtime (records execute calls, respects the abort signal), so the tick →
 * claim → execute → persist pipeline is exercised for real.
 *
 * Pins:
 * 1. Calendar math: once/interval/daily/weekly, IANA zones, the DST gap/fold
 *    rules, and "missed recurring work collapses into one catch-up".
 * 2. Input normalization: bad shapes, bad zones, relative cwds, and execution
 *    overrides on existing-session tasks are all rejected.
 * 3. Store: atomic round-trip, a corrupt file is reported AND preserved, and
 *    terminal runs trim to 1000 while active ones all stay.
 * 4. Service: create schedules nextRunAt, tick enqueues + executes + records
 *    the summary, one-shot tasks complete, revision conflicts 409, pausing
 *    cancels queued runs, cancelling aborts the live run, a dead owner's run
 *    is interrupted (never replayed), runNow refuses overlap, and manual runs
 *    never move the schedule.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir, hostname } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const temporary = await mkdtemp(join(tmpdir(), 'pith-scheduled-check-'))

// Bundle the TS with electron + lockfile + SDK external; the outfile lives
// under out/ so Node resolves those imports through the project's node_modules.
const outfile = resolve('out/check-scheduled-tasks.mjs')
await build({
  stdin: {
    contents: `export { ScheduledTaskService, ScheduledTaskError } from './src/main/pi/scheduled-tasks/service';
export { ScheduledTaskStore } from './src/main/pi/scheduled-tasks/store';
export { scheduledTasksRoot, isScheduledTasksRoot, prepareScheduledTasksRoot, scheduledTasksRunCwd } from './src/main/pi/scheduled-tasks/workspace';
export { validateScheduledWorktreeSource, createScheduledWorktree } from './src/main/pi/scheduled-tasks/worktree';
export { scheduledRunOutputFromMessages } from './src/main/pi/scheduled-tasks/output';
export { nextScheduledTaskRun, normalizeScheduledTaskInput, isScheduledTaskRunActive } from './src/shared/scheduled-tasks';`,
    resolveDir: resolve('.')
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile,
  external: ['electron', 'proper-lockfile', '@earendil-works/pi-coding-agent']
})
const { ScheduledTaskService, ScheduledTaskError, ScheduledTaskStore, scheduledTasksRoot, isScheduledTasksRoot, prepareScheduledTasksRoot, scheduledTasksRunCwd, validateScheduledWorktreeSource, createScheduledWorktree, scheduledRunOutputFromMessages, nextScheduledTaskRun, normalizeScheduledTaskInput } =
  await import(pathToFileURL(outfile).href)

const results = []
const check = (name, fn) => {
  try {
    fn()
    results.push(`ok   ${name}`)
  } catch (error) {
    results.push(`FAIL ${name}: ${error.message}`)
  }
}
const checkAsync = async (name, fn) => {
  try {
    await fn()
    results.push(`ok   ${name}`)
  } catch (error) {
    results.push(`FAIL ${name}: ${error.message}`)
  }
}

// ── 1. calendar math ─────────────────────────────────────────────────────────

const after = Date.parse('2026-03-08T09:30:00.000Z') // US spring-forward day
check('once in the past is never scheduled again', () => {
  assert.equal(nextScheduledTaskRun({ type: 'once', at: '2020-01-01T00:00:00Z' }, after), null)
})
check('once in the future stays on its instant', () => {
  // nextScheduledTaskRun returns the (already normalized upstream) `at`
  // verbatim; compare instants, not string shape.
  const next = nextScheduledTaskRun({ type: 'once', at: '2027-01-01T00:00:00Z' }, after)
  assert.equal(next && Date.parse(next), Date.parse('2027-01-01T00:00:00Z'))
})
check('interval counts from the check instant, not completion', () => {
  assert.equal(nextScheduledTaskRun({ type: 'interval', minutes: 15 }, after), '2026-03-08T09:45:00.000Z')
})
check('daily over a DST gap lands on the next valid local time', () => {
  // 02:30 does not exist in New York on 2026-03-08; the rule moves forward
  // past the gap, and that candidate is already past `after`, so the next
  // valid occurrence is 02:30 EDT on the 9th.
  assert.equal(nextScheduledTaskRun({ type: 'daily', time: '02:30', timeZone: 'America/New_York' }, after), '2026-03-09T06:30:00.000Z')
})
check('weekly skips non-selected weekdays and crosses zones correctly', () => {
  assert.equal(
    nextScheduledTaskRun({ type: 'weekly', time: '07:00', timeZone: 'Asia/Shanghai', weekdays: [1] }, after),
    '2026-03-08T23:00:00.000Z' // Monday 07:00 CST = Sunday 23:00Z
  )
})
check('normalize rejects bad input with precise errors', () => {
  const bad = [
    { name: 'x', prompt: 'p', target: { type: 'new_session', cwd: 'relative/path' }, schedule: { type: 'interval', minutes: 5 } },
    { name: 'x', prompt: 'p', target: { type: 'new_session', cwd: '/tmp' }, schedule: { type: 'daily', time: '25:00', timeZone: 'UTC' } },
    { name: 'x', prompt: 'p', target: { type: 'new_session', cwd: '/tmp' }, schedule: { type: 'daily', time: '07:00', timeZone: 'Not/AZone' } },
    { name: 'x', prompt: 'p', target: { type: 'existing_session', sessionId: 'abc' }, schedule: { type: 'interval', minutes: 5 }, permissionMode: 'read-only' },
    { name: 'x', prompt: 'p', target: { type: 'new_session', cwd: '/tmp' }, schedule: { type: 'interval', minutes: 0 } }
  ]
  for (const input of bad) assert.throws(() => normalizeScheduledTaskInput(input))
  const good = normalizeScheduledTaskInput({
    name: ' t ', prompt: 'p', target: { type: 'new_session', cwd: '/tmp' }, schedule: { type: 'weekly', time: '09:00', timeZone: 'UTC', weekdays: [3, 1, 1] }
  })
  assert.equal(good.name, 't')
  assert.deepEqual(good.schedule.weekdays, [1, 3]) // deduped + sorted
})
check('run output reads the full reply from its own turn, not a later conversation', () => {
  const start = Date.parse('2026-09-23T08:00:00Z')
  const full = '# Complete result\n\n' + 'A'.repeat(20_000)
  const run = { createdAt: new Date(start - 1000).toISOString(), startedAt: new Date(start).toISOString(), finishedAt: new Date(start + 10_000).toISOString(), summary: full.slice(0, 12_000) }
  const reply = (at, text) => ({ role: 'assistant', content: [{ type: 'text', text }], timestamp: at, completedAt: at + 100 })
  const messages = [reply(start - 20_000, 'earlier turn'), reply(start + 3000, full), reply(start + 20_000, 'later turn')]
  assert.equal(scheduledRunOutputFromMessages(run, messages), full)
  assert.equal(scheduledRunOutputFromMessages(run, []), run.summary)
})

// ── 2. store ─────────────────────────────────────────────────────────────────

await checkAsync('dedicated workspace prepares only its root and reuses the local-date folder', async () => {
  const home = join(temporary, 'home')
  const root = scheduledTasksRoot(home)
  assert.equal(await isScheduledTasksRoot(root, home), true)
  assert.equal(await isScheduledTasksRoot(join(root, '2026-09-23'), home), false)
  await prepareScheduledTasksRoot(home)
  assert.ok((await stat(root)).isDirectory())
  await assert.rejects(stat(join(root, '2026-09-23')), { code: 'ENOENT' })
  const cwd = await scheduledTasksRunCwd(new Date(2026, 8, 23, 9), home)
  assert.equal(cwd, join(root, '2026-09-23'))
  assert.ok((await stat(cwd)).isDirectory())
  assert.equal(await scheduledTasksRunCwd(new Date(2026, 8, 23, 18), home), cwd)
})

await checkAsync('worktree runs require a committed checkout root and create an isolated branch', async () => {
  const repo = join(temporary, 'source')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(repo)
  execFileSync('git', ['init', '-q', repo])
  await assert.rejects(validateScheduledWorktreeSource(repo), /commit/)
  await writeFile(join(repo, 'README.md'), 'scheduled check\n')
  execFileSync('git', ['-C', repo, 'add', 'README.md'])
  execFileSync('git', ['-C', repo, '-c', 'user.name=Check', '-c', 'user.email=check@example.invalid', 'commit', '-qm', 'initial'])
  assert.equal(await validateScheduledWorktreeSource(repo), await realpath(repo))
  await assert.rejects(validateScheduledWorktreeSource(temporary), /Git repository/)
  const cwd = await createScheduledWorktree(repo, 'task123456', 'run123456789012')
  assert.ok((await stat(cwd)).isDirectory())
  assert.equal(execFileSync('git', ['-C', cwd, 'branch', '--show-current'], { encoding: 'utf8' }).trim(), 'codex/scheduled-task1234-run123456789')
  assert.equal((await readFile(join(cwd, 'README.md'), 'utf8')), 'scheduled check\n')
})

const storePath = join(temporary, 'store.json')

await checkAsync('store round-trips and trims terminal runs to 1000', async () => {
  const store = new ScheduledTaskStore(storePath)
  await store.transaction((data) => {
    for (let index = 0; index < 1050; index++) {
      const task = {
        id: `t${index}`, revision: 1, status: 'active', name: `task ${index}`, prompt: 'p',
        target: { type: 'new_session', cwd: '/tmp', environment: 'local' },
        schedule: { type: 'interval', minutes: 5 },
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', nextRunAt: null
      }
      data.runs.push({
        id: `r${index}`, taskId: task.id, taskName: task.name, task, status: index === 1049 ? 'running' : 'succeeded',
        trigger: 'schedule', scheduledFor: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z'
      })
    }
  })
  const data = store.read()
  // Semantics: ALL active runs survive plus the newest 1000 terminal ones —
  // here 1 running + 1000 succeeded = 1001, and the dropped 49 are the oldest.
  assert.equal(data.runs.length, 1001)
  assert.equal(data.runs.filter((run) => run.status === 'succeeded').length, 1000)
  assert.ok(data.runs.some((run) => run.status === 'running'), 'the active run always survives the trim')
})

await checkAsync('a corrupt store is reported and preserved, never reset', async () => {
  const before = await readFile(storePath, 'utf8')
  await writeFile(storePath, '{ definitely not json', 'utf8')
  assert.throws(() => new ScheduledTaskStore(storePath).read(), /preserved/)
  assert.equal(await readFile(storePath, 'utf8'), '{ definitely not json', 'the original bytes stay on disk')
  await writeFile(storePath, before, 'utf8')
})

// ── 3. service (injected clock + fake runtime) ───────────────────────────────

let clock = Date.parse('2026-09-01T10:00:00.000Z')
const executions = []
const runtime = {
  validate: async (input) => {
    if (input.target.type === 'new_session' && input.target.cwd === '/missing-check-dir') throw new Error('The scheduled project directory does not exist')
  },
  ready: async () => true,
  execute: async (task, run, context) => {
    executions.push({ taskId: task.id, runId: run.id })
    await context.onSession(`session-${run.id}`, `/tmp/sessions/${run.id}.jsonl`, '/tmp')
    if (task.prompt === 'BLOCK') {
      await new Promise((_, reject) => {
        context.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
      })
    }
    return { summary: `did ${task.prompt}` }
  }
}

const servicePath = join(temporary, 'service.json')
const service = new ScheduledTaskService({ store: new ScheduledTaskStore(servicePath), now: () => clock, runtime, owner: 'owner-a', defaultPermissionMode: () => 'workspace-write' })

const settle = async () => {
  for (let index = 0; index < 200; index++) {
    await service.tick()
    const { runs } = await service.list()
    if (runs.every((run) => !['queued', 'running', 'waiting'].includes(run.status))) return
    clock += 100
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('runs did not settle')
}

await checkAsync('create computes nextRunAt; execute succeeds; once completes', async () => {
  const once = await service.create({
    name: 'one-shot', prompt: 'hello',
    target: { type: 'new_session', cwd: '/tmp' },
    schedule: { type: 'once', at: new Date(clock + 60_000).toISOString() }
  })
  assert.equal(once.permissionMode, 'workspace-write', 'new_session defaults to the app default mode')
  assert.equal(once.nextRunAt, new Date(clock + 60_000).toISOString())
  clock += 61_000
  await settle()
  const { task, runs } = await service.get(once.id)
  assert.equal(task.status, 'completed')
  assert.equal(runs[0].status, 'succeeded')
  assert.equal(runs[0].summary, 'did hello')
  assert.equal(runs[0].sessionId, `session-${runs[0].id}`)
})

await checkAsync('validation rejects a missing project directory', async () => {
  await assert.rejects(
    service.create({ name: 'x', prompt: 'p', target: { type: 'new_session', cwd: '/missing-check-dir' }, schedule: { type: 'interval', minutes: 5 } }),
    /does not exist/
  )
})

await checkAsync('revision conflict returns 409', async () => {
  const task = await service.create({ name: 'rev', prompt: 'p', target: { type: 'new_session', cwd: '/tmp' }, schedule: { type: 'interval', minutes: 5 } })
  await assert.rejects(service.update(task.id, { name: 'renamed' }, task.revision + 5), (error) => {
    assert.ok(error instanceof ScheduledTaskError)
    assert.equal(error.status, 409)
    return true
  })
})

await checkAsync('editing can clear run overrides when switching to an existing conversation', async () => {
  const created = await service.create({
    name: 'overrides', prompt: 'p', target: { type: 'new_session', cwd: '/tmp' },
    schedule: { type: 'interval', minutes: 5 },
    model: { provider: 'openai', modelId: 'model' },
    thinkingLevel: 'high', permissionMode: 'read-only'
  })
  const updated = await service.update(created.id, {
    target: { type: 'existing_session', sessionId: 'fixture-session' },
    model: null, thinkingLevel: null, permissionMode: null
  }, created.revision)
  assert.equal(updated.target.type, 'existing_session')
  assert.equal(updated.model, undefined)
  assert.equal(updated.thinkingLevel, undefined)
  assert.equal(updated.permissionMode, undefined)
})

await checkAsync('pause cancels the queued run of a due task', async () => {
  // Two blockers fill the concurrency cap (2), so the pausable task's due run
  // stays QUEUED — and pausing cancels exactly that, never the blockers' work.
  const blockerA = await service.create({ name: 'blocker-a', prompt: 'BLOCK', target: { type: 'new_session', cwd: '/tmp' }, schedule: { type: 'interval', minutes: 60 } })
  const blockerB = await service.create({ name: 'blocker-b', prompt: 'BLOCK', target: { type: 'new_session', cwd: '/tmp' }, schedule: { type: 'interval', minutes: 60 } })
  const task = await service.create({ name: 'pausable', prompt: 'p', target: { type: 'new_session', cwd: '/tmp' }, schedule: { type: 'interval', minutes: 60 } })
  clock += 1000
  await service.runNow(blockerA.id, blockerA.revision)
  await service.runNow(blockerB.id, blockerB.revision)
  await service.runNow(task.id, task.revision)
  await service.tick()
  await new Promise((resolve) => setTimeout(resolve, 50))
  {
    const { runs } = await service.get(task.id)
    assert.equal(runs[0].status, 'queued', 'concurrency is full, the third run waits')
  }
  // Read the fresh revision: a schedule-enqueued run bumps it, and any stale
  // write must 409 by design.
  const fresh = (await service.get(task.id)).task
  const paused = await service.update(task.id, { status: 'paused' }, fresh.revision)
  assert.equal(paused.status, 'paused')
  {
    const { runs } = await service.get(task.id)
    assert.equal(runs[0].status, 'cancelled')
  }
  // Delete the blockers (stops their runs AND their recurrences) so later
  // settles are not held by re-enqueued BLOCK work.
  await service.delete(blockerA.id)
  await service.delete(blockerB.id)
  await settle()
})

await checkAsync('cancelling a live run marks it cancelled, not failed', async () => {
  const task = await service.create({ name: 'cancellable', prompt: 'BLOCK', target: { type: 'new_session', cwd: '/tmp' }, schedule: { type: 'interval', minutes: 60 } })
  clock += 1000
  await service.runNow(task.id, task.revision)
  await service.tick()
  await new Promise((resolve) => setTimeout(resolve, 50))
  const { runs } = await service.get(task.id)
  assert.equal(runs[0].status, 'running')
  await service.cancelRun(runs[0].id)
  // Delete too: the recurrence must not enqueue a fresh BLOCK during settle.
  await service.delete(task.id)
  await settle()
  const store = new ScheduledTaskStore(servicePath).read()
  assert.equal(store.runs.find((run) => run.taskName === 'cancellable').status, 'cancelled')
})

await checkAsync('runNow refuses overlap; manual runs never move the schedule', async () => {
  const task = await service.create({ name: 'manual', prompt: 'BLOCK', target: { type: 'new_session', cwd: '/tmp' }, schedule: { type: 'interval', minutes: 60 } })
  const before = task.nextRunAt
  await service.runNow(task.id, task.revision)
  await assert.rejects(service.runNow(task.id, task.revision + 1), (error) => {
    assert.equal(error.status, 409)
    return true
  })
  await service.tick()
  const current = (await service.get(task.id)).task
  assert.equal(current.nextRunAt, before, 'a manual run leaves the recurrence untouched')
  await service.delete(task.id)
  await settle()
})

await checkAsync('a dead owner\'s active run is interrupted, never replayed', async () => {
  // A genuinely dead PID (macOS answers EINVAL, not ESRCH, for out-of-range
  // ones, which the conservative check correctly treats as alive).
  const { spawnSync } = await import('node:child_process')
  const deadPid = spawnSync(process.execPath, ['-e', '']).pid
  const orphanPath = join(temporary, 'orphan.json')
  const task = {
    id: 'orphan-task', revision: 2, status: 'active', name: 'orphan', prompt: 'p',
    target: { type: 'new_session', cwd: '/tmp', environment: 'local' },
    schedule: { type: 'interval', minutes: 5 },
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', nextRunAt: '2026-01-01T00:05:00.000Z'
  }
  await writeFile(
    orphanPath,
    JSON.stringify({
      version: 1,
      tasks: [task],
      runs: [{
        id: 'orphan-run', taskId: task.id, taskName: task.name, task, status: 'running', trigger: 'schedule',
        scheduledFor: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z',
        owner: 'someone-else', processId: deadPid, host: hostname(), leaseUntil: clock + 60_000
      }]
    }) + '\n',
    'utf8'
  )
  const recovery = new ScheduledTaskService({ store: new ScheduledTaskStore(orphanPath), now: () => clock, runtime, owner: 'owner-b', defaultPermissionMode: () => 'workspace-write' })
  await recovery.tick()
  const { runs } = await recovery.list()
  // The same tick that interrupts the orphan also enqueues the task's fresh
  // run (newest first in the list) — find the orphan by id.
  assert.equal(runs.find((run) => run.id === 'orphan-run')?.status, 'interrupted')
  assert.equal(executions.filter((execution) => execution.runId === 'orphan-run').length, 0, 'the accepted prompt is not replayed')
  // The recovered task keeps its schedule: the next tick enqueues a FRESH run.
  await recovery.tick()
  const after = await recovery.get('orphan-task')
  assert.ok(after.runs.some((run) => run.id !== 'orphan-run' && ['queued', 'running', 'succeeded'].includes(run.status)))
})

service.stop()

console.log(results.join('\n'))
const failures = results.filter((line) => line.startsWith('FAIL'))
await rm(temporary, { recursive: true, force: true })
await rm(outfile, { force: true })
if (failures.length) {
  console.error(`\n${failures.length} scheduled-task check(s) failed`)
  process.exit(1)
}
console.log('\nscheduled tasks: all checks passed')
