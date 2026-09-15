/** Pure-logic checks for the subagent engine's persistence protocol and
 * derivation helpers — the layer where the three upstream defects lived.
 * Plain node (no Electron, no SDK host, no model calls):
 *   node scripts/check-subagents.mjs */
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const protocol = await import('../src/main/pi/subagents/protocol.ts')
const derive = await import('../src/main/pi/subagents/derive.ts')
const profiles = await import('../src/main/pi/subagents/profiles.ts')

const run = (over = {}) => ({
  version: 1, runId: 'run-1', parentSessionId: 'p1', parentSessionPath: '/p/session.jsonl',
  parentToolCallId: 'call-1', profile: 'explore', description: 'Map the module graph',
  task: 'Map it', runInBackground: false, createdAt: '2026-01-01T00:00:00.000Z',
  resource: { tools: ['read', 'grep'], inheritContext: false },
  ...over
})
const result = (over = {}) => ({
  version: 1, runId: 'run-1', status: 'completed', completedAt: '2026-01-01T00:01:00.000Z',
  result: 'Done', ...over
})
const entriesOf = (...records) => records.map((record, index) => ({
  type: 'custom', id: `e${index}`, parentId: null, timestamp: new Date(index).toISOString(), ...record
}))

// --- per-run persistence: a result closes ONLY the run it names ---
{
  const entries = entriesOf(
    { customType: protocol.SUBAGENT_RUN_TYPE, data: run() },
    { customType: protocol.SUBAGENT_RESULT_TYPE, data: result() },
    { customType: protocol.SUBAGENT_RUN_TYPE, data: run({ runId: 'run-2', createdAt: '2026-01-02T00:00:00.000Z' }) }
  )
  const runs = protocol.readDiskSubagentRuns(entries)
  assert.equal(runs.length, 2)
  assert.equal(runs[0].result?.status, 'completed')
  assert.equal(runs[1].result, null)
  // Defect 1 (upstream): a resumed session mid-run must read as interrupted,
  // never as its previous terminal state.
  const current = protocol.currentDiskRun(entries, 'child', '/p/child.jsonl')
  assert.equal(current.status, 'interrupted')
  assert.equal(current.runId, 'run-2')
}

// --- malformed records never crash the reader ---
{
  const entries = entriesOf(
    { customType: protocol.SUBAGENT_RUN_TYPE, data: { version: 2 } },
    { customType: protocol.SUBAGENT_RUN_TYPE, data: run() },
    { customType: protocol.SUBAGENT_RESULT_TYPE, data: { version: 1, runId: 'other', status: 'completed', completedAt: 'x' } },
    { customType: protocol.SUBAGENT_RESULT_TYPE, data: result({ status: 'weird' }) }
  )
  const runs = protocol.readDiskSubagentRuns(entries)
  assert.equal(runs.length, 1)
  assert.equal(runs[0].result, null)
  assert.equal(protocol.currentDiskRun(entries, 'child', 'p').status, 'interrupted')
}

// --- roster seq guard: a stale update from a superseded run is dropped ---
{
  const roster = new Map()
  assert.equal(protocol.applyRunToRoster(roster, { sessionId: 'c1', runId: 'r2', status: 'running', seq: 5, createdAt: '2026-01-01T00:00:00Z' }), true)
  // Defect 3 (upstream): the OLD run's terminal event arrives late (seq 4 < 5).
  assert.equal(protocol.applyRunToRoster(roster, { sessionId: 'c1', runId: 'r1', status: 'completed', seq: 4, createdAt: '2026-01-01T00:00:00Z' }), false)
  assert.equal(roster.get('c1').status, 'running')
  // The current run's own terminal event applies.
  assert.equal(protocol.applyRunToRoster(roster, { sessionId: 'c1', runId: 'r2', status: 'completed', seq: 6, createdAt: '2026-01-01T00:00:00Z' }), true)
  assert.equal(roster.get('c1').status, 'completed')
}

// --- written-file extraction: successes only, write synthesized, merge, cap ---
{
  const messages = [
    { role: 'assistant', timestamp: 1, content: [
      { type: 'toolCall', id: 'a', name: 'edit', arguments: { path: 'src/a.ts' } },
      { type: 'toolCall', id: 'b', name: 'edit', arguments: { path: 'src/a.ts' } },
      { type: 'toolCall', id: 'c', name: 'write', arguments: { path: 'docs/new.md', content: 'hello\nworld\n' } },
      { type: 'toolCall', id: 'd', name: 'edit', arguments: { path: 'src/broken.ts' } }
    ] },
    { role: 'toolResult', toolCallId: 'a', toolName: 'edit', isError: false, timestamp: 2,
      details: { patch: '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1,2 @@\n-old\n+new\n+more\n' } },
    { role: 'toolResult', toolCallId: 'b', toolName: 'edit', isError: false, timestamp: 3,
      details: { patch: '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -2 +2 @@\n-x\n+y\n' } },
    { role: 'toolResult', toolCallId: 'c', toolName: 'write', isError: false, timestamp: 4 },
    { role: 'toolResult', toolCallId: 'd', toolName: 'edit', isError: true, timestamp: 5,
      details: { patch: '+++ never counted' } }
  ]
  const files = derive.extractSubagentWrittenFiles(messages, '/w')
  assert.equal(files.length, 2)
  const a = files.find((file) => file.filePath === '/w/src/a.ts')
  assert.equal(a.added, 3)
  assert.equal(a.removed, 2)
  assert.equal(a.patch.split('\n').filter((line) => line.startsWith('+') && !line.startsWith('+++')).length, 3)
  const created = files.find((file) => file.filePath === '/w/docs/new.md')
  assert.equal(created.added, 2)
  assert.match(created.patch, /@@ -0,0 \+1,2 @@/)
  assert.ok(!files.some((file) => file.filePath.includes('broken')))
}

// --- patch budget: beyond-cap patches keep counts but drop the body ---
{
  const big = `--- a/big.txt\n+++ b/big.txt\n@@ -1 +1 @@\n-${'x'.repeat(40)}\n+${'y'.repeat(40)}\n`
  const messages = [
    { role: 'assistant', timestamp: 1, content: [
      { type: 'toolCall', id: 'a', name: 'edit', arguments: { path: 'one.txt' } },
      { type: 'toolCall', id: 'b', name: 'edit', arguments: { path: 'two.txt' } }
    ] },
    { role: 'toolResult', toolCallId: 'a', toolName: 'edit', isError: false, timestamp: 2, details: { patch: 'x'.repeat(65_500) } },
    { role: 'toolResult', toolCallId: 'b', toolName: 'edit', isError: false, timestamp: 3, details: { patch: big } }
  ]
  const files = derive.extractSubagentWrittenFiles(messages, '/w')
  const two = files.find((file) => file.filePath === '/w/two.txt')
  assert.equal(two.added, 1)
  assert.equal(two.removed, 1)
  assert.equal(two.patch, undefined) // over budget
  void big
}

// --- parent context: capped, images stripped, newest tail survives ---
{
  // Three per-message-capped (20k) texts exceed the 50k budget; the newest
  // tail must survive the cut.
  const messages = [
    { role: 'user', timestamp: 1, content: [{ type: 'text', text: 'OLD1'.repeat(20_000) }] },
    { role: 'user', timestamp: 2, content: [{ type: 'text', text: 'OLD2'.repeat(20_000) }] },
    { role: 'user', timestamp: 3, content: [{ type: 'text', text: 'OLD3'.repeat(20_000) }] },
    { role: 'user', timestamp: 4, content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }, { type: 'text', text: 'NEWEST' }] }
  ]
  const text = derive.parentContextText(messages)
  assert.ok(text.length <= derive.SUBAGENT_CONTEXT_LIMIT + 200)
  assert.match(text, /truncated/)
  assert.ok(!text.includes('AAAA'))
  assert.ok(text.endsWith('NEWEST"]}') || text.includes('NEWEST'), 'newest content survives the cap')
}

// --- input files: confinement, budget, utf-8, dedupe ---
{
  const dir = await mkdtemp(join(tmpdir(), 'pith-subagents-'))
  try {
    const good = join(dir, 'good.txt')
    await writeFile(good, 'hello', 'utf8')
    const appended = derive.loadSubagentInputFiles(['good.txt'], dir)
    assert.match(appended, /<documents>/)
    assert.match(appended, /<document path="good\.txt">/)
    // An EXISTING file outside the workspace trips the confinement check (a
    // missing path reports not-found first — realpath runs before the check).
    const outside = join(tmpdir(), 'pith-subagents-escape.txt')
    await writeFile(outside, 'nope', 'utf8')
    assert.throws(
      () => derive.loadSubagentInputFiles([join('..', 'pith-subagents-escape.txt')], dir),
      /outside the workspace/
    )
    await rm(outside, { force: true })
    assert.throws(() => derive.loadSubagentInputFiles(['missing.txt'], dir), /not found/)
    // Duplicate paths collapse to one document.
    const once = derive.loadSubagentInputFiles(['good.txt', 'good.txt'], dir)
    assert.equal((once.match(/<document /g) ?? []).length, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// --- profiles: frontmatter round-trip + scope shadowing ---
{
  const dir = await mkdtemp(join(tmpdir(), 'pith-subagent-profiles-'))
  try {
    await writeFile(join(dir, 'custom.md'), [
      '---',
      'description: Local override',
      'display_name: Overridden',
      'tools: read, grep',
      'inherit_context: false',
      'max_turns: 12',
      '---',
      '',
      'You are the override.'
    ].join('\n'), 'utf8')
    // The project scope directory is `.pi/agents` under the cwd; simulate it.
    const projectDir = join(dir, '.pi', 'agents')
    await rm(projectDir, { force: true })
    const { mkdirSync } = await import('node:fs')
    mkdirSync(projectDir, { recursive: true })
    await writeFile(join(projectDir, 'custom.md'), '---\ndescription: Project wins\ntools: read\n---\n\nProject body.', 'utf8')
    const { listSubagentProfiles } = profiles
    const found = listSubagentProfiles(dir)
    const custom = found.find((profile) => profile.name === 'custom')
    assert.equal(custom.scope, 'project', 'project scope shadows the global file')
    assert.equal(custom.description, 'Project wins')
    assert.equal(custom.tools.length, 1)
    const serialized = profiles.serializeProfile({ ...custom, tools: ['read', 'bash'], inheritContext: true, runInBackground: false, enabled: true })
    assert.match(serialized, /tools: read,bash/)
    assert.match(serialized, /---\n\nProject body\./)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

console.log('check-subagents: all assertions passed')
