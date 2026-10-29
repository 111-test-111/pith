/**
 * Session sidebar listing index (src/main/pi/session-list.ts).
 *
 * Hermetic check — no Electron, no network, everything under a temporary
 * PI_CODING_AGENT_DIR. Pins three properties:
 *
 * 1. Row parity with the SDK's SessionManager.listAll() — the index replaced
 *    that full-store scan as the sidebar's source, so membership, labels
 *    (name / firstMessage), messageCount, modified, and parentSessionPath
 *    must stay byte-compatible, including the SDK's exclusion quirks (files
 *    without a leading session header; a null-content user message throws
 *    inside buildSessionInfo and excludes the whole file).
 * 2. The two app-side derivations folded into the same pass: the persisted
 *    subagent run marker and the newest-message-vs-rewind-selection branch
 *    decision (session-branch.ts) — both from raw files and from a live
 *    SessionManager's parsed entries.
 * 3. Stat-keyed caching: unchanged (mtime, size) ⇒ the file is never re-read
 *    (proved by swapping a file's bytes for same-size garbage with the mtime
 *    pinned), changes ⇒ only that file re-read, deletions drop rows, and the
 *    persisted cache lets a fresh instance answer without reading files.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm, utimes, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { SessionManager } from '@earendil-works/pi-coding-agent'

const temporary = await mkdtemp(join(tmpdir(), 'pith-session-list-'))
const agentDir = join(temporary, 'agent')
process.env.PI_CODING_AGENT_DIR = agentDir
const sessionsRoot = join(agentDir, 'sessions')
const dirA = join(sessionsRoot, 'a'), dirB = join(sessionsRoot, 'b')
await mkdir(dirA, { recursive: true })
await mkdir(dirB, { recursive: true })

// The index is TypeScript; bundle it with the SDK external. The outfile
// lives under the project's out/ so Node resolves the external SDK import
// through the project's node_modules at runtime; the SDK's getAgentDir reads
// PI_CODING_AGENT_DIR at call time, so the real copy honors the isolated profile.
const outfile = resolve('out/check-session-list.mjs')
await build({
  entryPoints: [resolve('src/main/pi/session-list.ts')],
  bundle: true, platform: 'node', format: 'esm', outfile,
  external: ['@earendil-works/pi-coding-agent']
})
const { SessionListIndex, readSessionRow, rowFromSessionManager } = await import(pathToFileURL(outfile).href)

let nextId = 0
const entry = (fields) => ({ id: `e${nextId++}`, parentId: null, ...fields })
const header = (id, cwd, extra = {}) => ({ type: 'session', version: 3, id, timestamp: '2026-09-01T10:00:00.000Z', cwd, ...extra })
const user = (text, ts) => entry({ type: 'message', timestamp: ts, message: { role: 'user', content: text, timestamp: Date.parse(ts) } })
const assistant = (text, ts) => entry({ type: 'message', timestamp: ts, message: { role: 'assistant', content: [{ type: 'text', text }], timestamp: Date.parse(ts) } })
const toolResult = () => entry({ type: 'message', timestamp: '2026-09-01T10:02:00.000Z', message: { role: 'toolResult' } })
const info = (name) => entry({ type: 'session_info', timestamp: '2026-09-01T10:03:00.000Z', name })
const rewindSelection = (data) => entry({ type: 'custom', customType: 'pith_rewind_selection', timestamp: '2026-09-01T11:00:00.000Z', data })
const subagentRun = () => entry({ type: 'custom', customType: 'pith_subagent_run', timestamp: '2026-09-01T10:04:00.000Z', data: {} })
const scheduledRun = () => entry({ type: 'custom', customType: 'pith_scheduled_task', timestamp: '2026-09-01T10:04:30.000Z', data: { version: 1, taskId: 't', runId: 'r', taskName: 'n' } })

const writeSession = async (dir, name, entries) => {
  const path = join(dir, name)
  await writeFile(path, entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8')
  return path
}

const stampOf = async (path) => {
  const stats = await import('node:fs/promises').then((fs) => fs.stat(path))
  return { mtimeMs: stats.mtimeMs, size: stats.size }
}

const waitFor = async (predicate) => {
  for (let i = 0; i < 500; i++) {
    if (await predicate()) return
    await new Promise((r) => setTimeout(r, 10))
  }
  assert.fail('Timed out')
}

try {
  // ---- Fixtures -----------------------------------------------------------
  const normal = await writeSession(dirA, 'normal.jsonl', [
    header('s-normal', '/tmp/project-a'),
    user('first question', '2026-09-01T10:01:00.000Z'),
    assistant('an answer', '2026-09-01T10:01:30.000Z'),
    toolResult(), // counted by messageCount, ignored for activity/firstMessage
    user('second question', '2026-09-01T10:05:00.000Z')
  ])
  const named = await writeSession(dirA, 'named.jsonl', [
    header('s-named', '/tmp/project-a'),
    user('the message', '2026-09-01T10:06:00.000Z'),
    info('A kept name')
  ])
  const clearedName = await writeSession(dirA, 'cleared-name.jsonl', [
    header('s-cleared', '/tmp/project-a'),
    user('the message', '2026-09-01T10:06:00.000Z'),
    info('A name that gets cleared'),
    info('')
  ])
  const fresh = await writeSession(dirA, 'fresh.jsonl', [header('s-fresh', '/tmp/project-a')])
  const subagentChild = await writeSession(dirA, 'child.jsonl', [
    header('s-child', '/tmp/project-a', { parentSession: '/somewhere/parent.jsonl' }),
    subagentRun(),
    user('do the thing', '2026-09-01T10:10:00.000Z')
  ])
  const fork = await writeSession(dirA, 'fork.jsonl', [
    header('s-fork', '/tmp/project-a', { parentSession: '/somewhere/parent.jsonl' }),
    user('forked continuation', '2026-09-01T10:11:00.000Z')
  ])
  const scheduled = await writeSession(dirA, 'scheduled.jsonl', [
    header('s-scheduled', '/tmp/project-a'),
    scheduledRun(),
    user('scheduled turn', '2026-09-01T10:12:00.000Z')
  ])
  const restoredEmpty = await writeSession(dirA, 'restored-empty.jsonl', [
    header('s-restored', '/tmp/project-a'),
    user('before the restore', '2026-09-01T10:12:00.000Z'),
    assistant('lost answer', '2026-09-01T10:12:30.000Z'),
    rewindSelection({ operationId: 'op1', target: null, empty: true })
  ])
  const restoredContinued = await writeSession(dirA, 'restored-continued.jsonl', [
    header('s-continued', '/tmp/project-a'),
    user('before', '2026-09-01T10:13:00.000Z'),
    rewindSelection({ operationId: 'op2', target: null, empty: true }),
    user('after the restore', '2026-09-01T10:14:00.000Z')
  ])
  const noHeader = await writeSession(dirA, 'no-header.jsonl', [user('orphan', '2026-09-01T10:15:00.000Z')])
  const malformed = await writeSession(dirA, 'malformed.jsonl', [
    header('s-malformed', '/tmp/project-a'),
    { not: 'json' /* will be serialized as JSON — replaced below */ }
  ])
  // A genuinely malformed line plus a trailing non-empty one.
  await writeFile(malformed, [
    JSON.stringify(header('s-malformed', '/tmp/project-a')),
    '{ this is not json',
    JSON.stringify(user('after garbage', '2026-09-01T10:16:00.000Z')),
    ''
  ].join('\n'), 'utf8')
  const nullContent = await writeSession(dirA, 'null-content.jsonl', [
    header('s-null', '/tmp/project-a'),
    entry({ type: 'message', timestamp: '2026-09-01T10:17:00.000Z', message: { role: 'user', content: null } })
  ])
  const other = await writeSession(dirB, 'other.jsonl', [
    header('s-other', '/tmp/project-b'),
    user('other project', '2026-09-01T10:18:00.000Z')
  ])

  // ---- 1. Parity with the SDK's listAll -----------------------------------
  const index = new SessionListIndex(join(temporary, 'cache.json'))
  await index.refresh()
  const rows = new Map(index.list().map((row) => [row.path, row]))
  const sdk = new Map((await SessionManager.listAll()).map((info) => [info.path, info]))

  // Membership: the SDK excludes no-header and null-content files; so must the index.
  assert.deepEqual(
    [...rows.keys()].sort(),
    [normal, named, clearedName, fresh, subagentChild, fork, scheduled, restoredEmpty, restoredContinued, malformed, other].sort(),
    'index membership matches the listable fixtures'
  )
  assert(!sdk.has(noHeader) && !sdk.has(nullContent), 'SDK excludes the two pathological fixtures')
  assert(!rows.has(noHeader) && !rows.has(nullContent), 'index excludes them too')

  for (const [path, info] of sdk) {
    const row = rows.get(path)
    assert(row, `index has a row for ${path}`)
    assert.equal(row.name, info.name, `name parity for ${path}`)
    assert.equal(row.cwd, info.cwd, `cwd parity for ${path}`)
    assert.equal(row.messageCount, info.messageCount, `messageCount parity for ${path}`)
    assert.equal(row.firstMessage, info.firstMessage, `firstMessage parity for ${path}`)
    assert.equal(row.modified, info.modified.getTime(), `modified parity for ${path}`)
    assert.equal(row.created, info.created.getTime(), `created parity for ${path}`)
    assert.equal(row.parentSessionPath ?? undefined, info.parentSessionPath ?? undefined, `parentSessionPath parity for ${path}`)
  }
  const normalRow = rows.get(normal)
  assert.equal(normalRow.messageCount, 4)
  assert.equal(normalRow.firstMessage, 'first question')
  assert.equal(normalRow.modified, Date.parse('2026-09-01T10:05:00.000Z'), 'activity ignores the contentless toolResult')
  assert.equal(normalRow.created, Date.parse('2026-09-01T10:00:00.000Z'), 'creation uses the header rather than last activity or filesystem time')
  assert.equal(rows.get(fresh).messageCount, 0)
  assert.equal(rows.get(fresh).firstMessage, '(no messages)')
  assert.equal(rows.get(named).name, 'A kept name')
  assert.equal(rows.get(clearedName).name, undefined, 'an explicit clear wins as the latest session_info')
  assert.equal(rows.get(subagentChild).subagentChild, true, 'the persisted run marker marks a child')
  assert.equal(rows.get(fork).subagentChild, false, 'a fork (parentSessionPath without a marker) is not a child')
  assert.equal(rows.get(scheduled).scheduledTask, true, 'the scheduled marker marks a run session')
  assert.equal(rows.get(scheduled).subagentChild, false, 'the scheduled marker is independent of the subagent one')
  assert.equal(rows.get(normal).scheduledTask, false, 'ordinary sessions are not scheduled')
  assert.equal(rows.get(restoredEmpty).branchHasMessages, false, 'a tail rewind selection with empty:true hides the branch')
  assert.equal(rows.get(restoredContinued).branchHasMessages, true, 'a message after the selection re-shows the branch')

  // ---- 2. Live derivation parity ------------------------------------------
  for (const path of [normal, subagentChild, fork, scheduled, restoredEmpty, restoredContinued, named, fresh]) {
    const manager = SessionManager.open(path)
    const live = rowFromSessionManager(manager)
    const disk = await readSessionRow(path, await stampOf(path))
    assert(live && disk, `both paths derive ${path}`)
    assert.deepEqual({ ...live, modified: 0 }, { ...disk, modified: 0 }, `live row matches the disk row for ${path}`)
  }

  // A real SDK-written session: appendMessage/appendCustomEntry shapes.
  const liveCwd = join(temporary, 'live-project')
  await mkdir(liveCwd, { recursive: true })
  const liveManager = SessionManager.create(liveCwd)
  const livePath = liveManager.getSessionFile()
  liveManager.appendMessage({ role: 'user', content: 'live one', timestamp: Date.parse('2026-09-02T10:00:00.000Z') })
  const liveRow = rowFromSessionManager(liveManager)
  assert.equal(liveRow.messageCount, 1)
  assert.equal(liveRow.firstMessage, 'live one')
  assert.equal(liveRow.branchHasMessages, true)
  liveManager.appendCustomEntry('pith_rewind_selection', { operationId: 'op3', target: null, empty: true })
  assert.equal(rowFromSessionManager(liveManager).branchHasMessages, false, 'a live rewind selection flips the branch decision')

  // ---- 3. Stat-keyed caching -----------------------------------------------
  await waitFor(async () => {
    try { return (await readFile(join(temporary, 'cache.json'), 'utf8')).length > 0 } catch { return false }
  })

  // utimes(Date) is lossy on sub-millisecond stamps, so pins always go through
  // a whole-second target applied TWICE: the same Date input converts to the
  // same stored mtime, making the achieved stamp reproducible.
  const pinStamp = async (path, target) => {
    await utimes(path, target, target)
    return stampOf(path)
  }

  // An unchanged (mtime, size) is served from the cache without re-reading:
  // cache the row under a pinned stamp, then swap the bytes for same-size
  // garbage and re-pin — a re-read would exclude the file, a cache hit keeps it.
  const pinned = fork
  const forkTarget = new Date(Math.floor(Date.now() / 1000) * 1000)
  const forkPinned = await pinStamp(pinned, forkTarget)
  const forkBytes = await readFile(pinned, 'utf8')
  await index.refresh()
  await writeFile(pinned, 'x'.repeat(forkPinned.size), 'utf8')
  const rePinned = await pinStamp(pinned, forkTarget)
  assert.equal(rePinned.mtimeMs, forkPinned.mtimeMs, 'pinning is reproducible')
  await index.refresh()
  const afterPin = new Map(index.list().map((row) => [row.path, row]))
  assert(afterPin.has(pinned), 'an unchanged stamp is served from the cache, not re-read')
  assert.equal(afterPin.get(pinned).firstMessage, 'forked continuation')
  await writeFile(pinned, forkBytes, 'utf8')

  // A real change re-reads exactly that file.
  await writeFile(normal, (await readFile(normal, 'utf8')) + JSON.stringify(user('third question', '2026-09-01T10:20:00.000Z')) + '\n', 'utf8')
  await index.refresh()
  const afterAppend = new Map(index.list().map((row) => [row.path, row]))
  assert.equal(afterAppend.get(normal).messageCount, 5, 'an appended message is re-read')
  assert.equal(afterAppend.get(normal).modified, Date.parse('2026-09-01T10:20:00.000Z'))
  assert.equal(afterAppend.get(normal).created, normalRow.created, 'new activity never changes creation sorting')
  assert.equal(afterAppend.get(named).messageCount, rows.get(named).messageCount, 'other files keep their cached rows')

  // Deletion drops the row; a new file gains one.
  await rm(other)
  const added = await writeSession(dirB, 'added.jsonl', [header('s-added', '/tmp/project-b'), user('new file', '2026-09-01T10:21:00.000Z')])
  await index.refresh()
  const afterMutation = new Map(index.list().map((row) => [row.path, row]))
  assert(!afterMutation.has(other), 'a deleted file drops its row')
  assert(afterMutation.has(added), 'a new file gains a row')

  // A fresh instance serves from the persisted cache without reading files:
  // pin the added file's stamp, let the refresh + persist record it, then
  // swap its bytes for same-size garbage under the same pin — the cold
  // instance must answer from the persisted rows instead of re-reading.
  const addedTarget = new Date(Math.floor(Date.now() / 1000) * 1000)
  const addedPinned = await pinStamp(added, addedTarget)
  const addedBytes = await readFile(added, 'utf8')
  await index.refresh()
  await waitFor(async () => {
    const cached = JSON.parse(await readFile(join(temporary, 'cache.json'), 'utf8'))
    return cached.rows.some((row) => row.path === added && row.stamp.mtimeMs === addedPinned.mtimeMs)
  })
  await writeFile(added, 'y'.repeat(addedPinned.size), 'utf8')
  assert.equal((await pinStamp(added, addedTarget)).mtimeMs, addedPinned.mtimeMs)
  const persistedIndex = new SessionListIndex(join(temporary, 'cache.json'))
  await persistedIndex.refresh()
  const persistedRows = new Map(persistedIndex.list().map((row) => [row.path, row]))
  assert(persistedRows.has(added), 'the persisted cache serves rows without re-reading unchanged files')
  assert.equal(persistedRows.get(added).firstMessage, 'new file')
  await writeFile(added, addedBytes, 'utf8')

  // A corrupt cache is non-fatal: the refresh re-reads and answers correctly.
  await writeFile(join(temporary, 'corrupt.json'), '{not json', 'utf8')
  const corruptIndex = new SessionListIndex(join(temporary, 'corrupt.json'))
  await corruptIndex.refresh()
  assert.equal(corruptIndex.list().length, index.list().length, 'a corrupt cache falls back to a full read')

  console.log('check-session-list: all assertions passed')
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  delete process.env.PI_CODING_AGENT_DIR
  await rm(outfile, { force: true })
  await rm(temporary, { recursive: true, force: true })
}
