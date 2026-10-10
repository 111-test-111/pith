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

// --- image receipts survive persistence for Rewind without becoming code diffs ---
{
  const messages = [
    { role: 'assistant', content: [
      { type: 'toolCall', id: 'image', name: 'image', arguments: {} },
      { type: 'toolCall', id: 'edit', name: 'write', arguments: { path: 'picture.svg', content: '<svg />' } }
    ] },
    { role: 'toolResult', toolCallId: 'image', toolName: 'image', isError: true,
      details: { kind: 'pi-app-image', action: 'generate', model: 'fixture/image', protocol: 'native', prompt: 'test',
        files: [{ path: '/w/picture.svg', mimeType: 'image/svg+xml', size: 20, width: 1, height: 1 }] } }
  ]
  const writtenFiles = derive.extractSubagentWrittenFiles(messages, '/w')
  assert.equal(writtenFiles[0].kind, 'generated-image', 'even a partial failed batch retains its committed image')
  const restored = protocol.readDiskSubagentRuns(entriesOf(
    { customType: protocol.SUBAGENT_RUN_TYPE, data: run() },
    { customType: protocol.SUBAGENT_RESULT_TYPE, data: result({ writtenFiles }) }
  ))[0].result.writtenFiles
  assert.equal(restored[0].filePath, '/w/picture.svg')
  assert.equal(restored[0].kind, 'generated-image', 'reload preserves the image-only receipt marker')
  const edited = derive.extractSubagentWrittenFiles([...messages,
    { role: 'toolResult', toolCallId: 'edit', toolName: 'write', isError: false }
  ], '/w')
  assert.equal(edited[0].kind, undefined, 'a subsequent text edit to SVG remains reviewable')
  assert.match(edited[0].patch, /\+<svg \/>/)
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

// --- pi-web interop: `tool_preset` resolution and the conservative default.
//     pi-web writes `~/.pi/agent/agents/*.md` that declare their tools ONLY as
//     a preset; reading those as "no tools: → all" made a profile named
//     `explore` perfectly able to write files. ---
{
  const agentDir = await mkdtemp(join(tmpdir(), 'pith-subagent-agentdir-'))
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = agentDir
  try {
    const { mkdirSync } = await import('node:fs')
    const agentsDir = join(agentDir, 'agents')
    mkdirSync(agentsDir, { recursive: true })
    const { SUBAGENT_READ_ONLY_TOOLS } = await import('../src/shared/types.ts')
    const { subagentToolDescription } = await import('../src/main/pi/subagents/tools.ts')
    // pi-web's own preset file lives beside the profiles it feeds.
    await writeFile(join(agentDir, 'pi-web-tool-presets.json'), JSON.stringify([
      { id: 'piweb-agent-explore', name: 'Agent · Explore', selection: { mode: 'allow', names: ['find', 'grep', 'ls', 'read'] } },
      { id: 'piweb-agent-deny', name: 'Deny preset', selection: { mode: 'deny', names: ['bash'] } },
      { id: 'incomplete', name: 'No selection' }
    ]), 'utf8')
    const files = {
      'piweb-explore.md': '---\ndescription: pi-web explorer\ntool_preset: piweb-agent-explore\n---\n\nBody.',
      'piweb-deny.md': '---\ndescription: deny preset\ntool_preset: piweb-agent-deny\n---\n\nBody.',
      'piweb-unknown.md': '---\ndescription: unknown preset\ntool_preset: nope\n---\n\nBody.',
      'bare.md': '---\ndescription: no tools field\n---\n\nBody.',
      'explicit-all.md': '---\ndescription: explicit full access\ntools: all\n---\n\nBody.'
    }
    for (const [name, content] of Object.entries(files)) await writeFile(join(agentsDir, name), content, 'utf8')
    const byName = new Map(profiles.listSubagentProfiles(null).map((profile) => [profile.name, profile]))
    const explore = byName.get('piweb-explore')
    assert.deepEqual(explore.tools, ['find', 'grep', 'ls', 'read'], 'a resolvable tool_preset becomes the real ceiling')
    assert.equal(explore.toolsSource, 'preset')
    assert.equal(explore.toolPreset, 'piweb-agent-explore')
    const deny = byName.get('piweb-deny')
    assert.equal(deny.toolsSource, 'unresolved-preset', 'a deny selection cannot be expressed here')
    assert.deepEqual(deny.tools, [...SUBAGENT_READ_ONLY_TOOLS], 'and must never widen to full access')
    assert.equal(byName.get('piweb-unknown').toolsSource, 'unresolved-preset')
    const bare = byName.get('bare')
    assert.equal(bare.toolsSource, 'default', 'no tools: at all is least privilege, not full access')
    assert.deepEqual(bare.tools, [...SUBAGENT_READ_ONLY_TOOLS])
    assert.deepEqual(byName.get('explicit-all').tools, 'all', 'an explicit tools: still wins')
    const described = subagentToolDescription([...byName.values()])
    assert.match(described, /read-only default: no tools:/, 'the model is told why a set is read-only')
    assert.match(described, /unresolved tool_preset "nope"/)
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir
    await rm(agentDir, { recursive: true, force: true })
  }
}

// --- profile tools: the surgical `tools:` edit changes ONE line and nothing
//     else (Settings → Subagents writes through exactly this path) ---
{
  const agentDir = await mkdtemp(join(tmpdir(), 'pith-subagent-agentdir-tools-'))
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = agentDir
  try {
    const { mkdirSync, readFileSync } = await import('node:fs')
    const agentsDir = join(agentDir, 'agents')
    mkdirSync(agentsDir, { recursive: true })
    const original = [
      '---',
      'description: Keeps its shape',
      'display_name: Keeps Shape',
      'tool_preset: some-preset',
      'inherit_context: false',
      'max_turns: 12',
      '---',
      '',
      'You are the keeper.'
    ].join('\n')

    // Insert when no `tools:` line exists: everything else stays byte-identical.
    const inserted = profiles.setProfileToolsLine(original, ['read', 'grep'])
    assert.ok(inserted.startsWith('---\ntools: read,grep\ndescription: Keeps its shape\n'), 'a missing tools: line is inserted right after the opening fence')
    assert.ok(inserted.endsWith('You are the keeper.'), 'the body is untouched')
    assert.ok(inserted.includes('tool_preset: some-preset'), 'other frontmatter keys survive')

    // Replace in place keeps the surrounding lines and their order.
    const replaced = profiles.setProfileToolsLine(inserted, 'all')
    assert.ok(replaced.includes('tools: all\n'), 'the value is replaced in place')
    assert.ok(!replaced.includes('read,grep'), 'the old value is gone')
    assert.ok(replaced.includes('max_turns: 12'), 'later lines keep their place')

    // A quoted key is updated in place, never duplicated.
    const quoted = profiles.setProfileToolsLine('---\ndescription: q\n"tools": read\n---\n\nB.', ['grep'])
    assert.ok(quoted.includes('"tools": grep'), 'the quoted key itself is rewritten')
    assert.ok(!quoted.includes('"tools": read'), 'without a second tools key')

    // CRLF files keep their line endings.
    const crlf = profiles.setProfileToolsLine('---\r\ndescription: q\r\ntools: read\r\n---\r\n\r\nB.', ['grep'])
    assert.ok(crlf.includes('tools: grep\r\n'), 'CRLF is preserved')

    // The write path validates before it commits: dedupe + exact SDK identities, a
    // re-parse that must still be the SAME profile, and an empty set refused.
    await writeFile(join(agentsDir, 'keeper.md'), original, 'utf8')
    const written = profiles.writeSubagentProfileTools(join(agentsDir, 'keeper.md'), ['mcp', 'read', 'mcp', 'mcp__Docs_Server__Read_File', ''])
    assert.deepEqual(written.tools, ['mcp', 'read', 'mcp__Docs_Server__Read_File'], 'names are deduped without changing case-sensitive MCP identities')
    assert.equal(written.description, 'Keeps its shape')
    assert.equal(written.systemPrompt, 'You are the keeper.')
    const onDisk = readFileSync(join(agentsDir, 'keeper.md'), 'utf8')
    assert.ok(onDisk.includes('tools: mcp,read,mcp__Docs_Server__Read_File\n'), 'exactly one tools: line is written')
    assert.ok(onDisk.includes('tool_preset: some-preset'), 'an explicit list overrides a preset without deleting it')
    assert.equal((onDisk.match(/^tools:/gm) ?? []).length, 1, 'the line is never duplicated')
    let refused = false
    try { profiles.writeSubagentProfileTools(join(agentsDir, 'keeper.md'), []) } catch { refused = true }
    assert.ok(refused, 'an empty tool set never reaches the file')
    await writeFile(join(agentsDir, 'not-a-profile.md'), 'no frontmatter here', 'utf8')
    refused = false
    try { profiles.writeSubagentProfileTools(join(agentsDir, 'not-a-profile.md'), ['read']) } catch { refused = true }
    assert.ok(refused, 'a file that does not parse as a profile is refused')
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir
    await rm(agentDir, { recursive: true, force: true })
  }
}

// User defaults are surgical file edits, independent of tool and turn policies.
{
  const { readFileSync } = await import('node:fs')
  const dir = await mkdtemp(join(tmpdir(), 'pith-subagent-defaults-edit-'))
  const path = join(dir, 'role.md')
  const original = '---\r\ndescription: Keeps defaults\r\ntools: read,grep\r\nmax_turns: 12\r\ndebug: true\r\ncustom_key: untouched\r\n---\r\n\r\nPrompt stays exactly as written.\r\n'
  const defaults = { model: null, thinking: null, inheritContext: true, runInBackground: false }
  try {
    await writeFile(path, original)
    profiles.writeSubagentProfileDefaults(path, defaults)
    assert.equal(readFileSync(path, 'utf8'), original, 'saving unset values must not change current behavior or file bytes')
    const edited = profiles.writeSubagentProfileDefaults(path, { model: 'provider/model/id', thinking: 'high', inheritContext: false, runInBackground: true })
    assert.equal(edited.model, 'provider/model/id')
    assert.equal(edited.thinking, 'high')
    assert.equal(edited.inheritContext, false)
    assert.equal(edited.runInBackground, true)
    const stored = readFileSync(path, 'utf8')
    assert.ok(stored.includes('model: provider/model/id\r\n') && stored.includes('inherit_context: false\r\n'), 'the new keys keep CRLF')
    assert.ok(stored.includes('max_turns: 12\r\ndebug: true\r\ncustom_key: untouched\r\n'), 'legacy limits and other metadata are untouched')
    assert.ok(stored.endsWith('\r\n\r\nPrompt stays exactly as written.\r\n'), 'the prompt is byte-identical')
    profiles.writeSubagentProfileDefaults(path, defaults)
    const cleared = readFileSync(path, 'utf8')
    assert.ok(!/^model:|^thinking:/m.test(cleared), 'clearing removes optional defaults')
    assert.ok(cleared.includes('inherit_context: true\r\n') && cleared.includes('run_in_background: false\r\n'))
    for (const invalid of [
      { model: 'bad-format' }, { model: 'p/id\ninjected: true' }, { thinking: 'invalid' },
      { inheritContext: 'false' }, { runInBackground: null }
    ]) {
      assert.throws(() => profiles.writeSubagentProfileDefaults(path, { ...defaults, ...invalid }), /Invalid/)
      assert.equal(readFileSync(path, 'utf8'), cleared, 'invalid values cannot partially edit the file')
    }
    await writeFile(path, original.replace('custom_key: untouched', 'model: p/one\r\nmodel: p/two'))
    const duplicate = readFileSync(path, 'utf8')
    assert.throws(() => profiles.writeSubagentProfileDefaults(path, defaults), /Duplicate model/)
    assert.equal(readFileSync(path, 'utf8'), duplicate, 'ambiguous defaults are rejected without writing')
  } finally { await rm(dir, { recursive: true, force: true }) }
}

// A legacy `debug:` frontmatter line no longer grants anything: the parser
// ignores it, and the ordinary tools line is the only place the debugger
// lives (`tools: all`, or an explicit `debug` entry).
{
  const agentDir = await mkdtemp(join(tmpdir(), 'pith-subagent-agentdir-debug-'))
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = agentDir
  try {
    const { mkdirSync, readFileSync: _readFileSync } = await import('node:fs')
    const dir = join(agentDir, 'agents')
    mkdirSync(dir, { recursive: true })
    await writeFile(join(dir, 'role.md'), '---\r\ndescription: Debug role\r\ntools: read,debug\r\n"debug": false\r\n---\r\n\r\nKeep this prompt.\r\n')
    const parsed = profiles.listSubagentProfiles(null)
    assert.equal(parsed.length, 1, 'a file with a legacy debug line still parses')
    assert.ok(!('debugEnabled' in parsed[0]), 'the parser no longer reads a debug flag')
    assert.deepEqual(parsed[0].tools, ['read', 'debug'], 'the debugger rides the ordinary tools line')
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir
    await rm(agentDir, { recursive: true, force: true })
  }
}

// --- profile creation (Settings → Subagents): a least-privilege starter file
//     validated to the loader's own rules ---
{
  const agentDir = await mkdtemp(join(tmpdir(), 'pith-subagent-agentdir-create-'))
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = agentDir
  try {
    const { existsSync, readFileSync } = await import('node:fs')
    const dir = join(agentDir, 'agents')
    const created = profiles.createSubagentProfileFile(dir, {
      name: 'docs-writer', description: 'Writes docs.\nA newline is flattened', systemPrompt: 'You write docs.', scope: 'global'
    })
    assert.equal(created.name, 'docs-writer')
    assert.equal(created.description, 'Writes docs. A newline is flattened', 'newlines cannot enter flat frontmatter')
    assert.equal(created.systemPrompt, 'You write docs.')
    assert.equal(created.toolsSource, 'default', 'a new profile declares no tools: line — least privilege')
    assert.equal(created.scope, 'global')
    const onDisk = readFileSync(join(dir, 'docs-writer.md'), 'utf8')
    assert.ok(onDisk.startsWith('---\ndescription: Writes docs. A newline is flattened\n---\n\nYou write docs.\n'), 'the file is exactly the form plus its body')
    assert.ok(!onDisk.includes('tools:'), 'the starter file carries no tools line')
    // An existing file is never overwritten.
    let refused = false
    try { profiles.createSubagentProfileFile(dir, { name: 'docs-writer', description: 'Other', systemPrompt: '', scope: 'global' }) } catch { refused = true }
    assert.ok(refused, 'an existing file is never overwritten')
    // Names and descriptions follow the loader's own rules.
    refused = false
    try { profiles.createSubagentProfileFile(dir, { name: 'Bad Name', description: 'x', systemPrompt: '', scope: 'project' }) } catch { refused = true }
    assert.ok(refused, 'an invalid name is refused')
    refused = false
    try { profiles.createSubagentProfileFile(dir, { name: 'fresh', description: '   ', systemPrompt: '', scope: 'global' }) } catch { refused = true }
    assert.ok(refused, 'an empty description is refused — the file would be invisible')
    assert.equal(existsSync(join(dir, 'fresh.md')), false, 'a refused create writes nothing')
    assert.ok(existsSync(join(dir, 'docs-writer.md')), 'the one accepted create is on disk')
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir
    await rm(agentDir, { recursive: true, force: true })
  }
}

// --- extension ceilings + live roster: only an extension-attributed tool
//     makes a child load extensions, and the profile list a session reads
//     follows the files — a Settings save applies to the very next delegation ---
{
  const { ceilingNeedsExtensions, parentDelegableToolNames } = await import('../src/main/pi/subagents/runtime.ts')
  const { createSubagentTool } = await import('../src/main/pi/subagents/tools.ts')
  // REAL SDK shapes: extension tools carry their extension's origin tag
  // ("local"/"temporary"/"npm:…"), never a literal "extension"; the SDK's two
  // synthetic sources are "builtin" and "sdk". The fixtures must mirror the
  // loader or the test validates a predicate that can never fire.
  const parentTools = [
    { name: 'read', sourceInfo: { source: 'builtin' } },
    { name: 'todo_write', sourceInfo: { source: 'sdk' } },
    { name: 'ask_user_question', sourceInfo: { source: 'sdk' } },
    { name: 'web_search', sourceInfo: { source: 'local' } },
    { name: 'web_fetch', sourceInfo: { source: 'npm:tavily' } },
    { name: 'mcp', sourceInfo: { source: 'temporary' } }
  ]
  assert.equal(ceilingNeedsExtensions(['read', 'grep', 'todo_write', 'ask_user_question'], parentTools), false, 'built-in/app ceilings stay extension-free (no MCP hosts per explore run)')
  assert.equal(ceilingNeedsExtensions(['read', 'web_search'], parentTools), true, 'a "local"-tagged extension tool in the ceiling loads extensions — the checked-tools bug')
  assert.equal(ceilingNeedsExtensions(['read', 'web_fetch'], parentTools), true, 'an npm-tagged extension tool counts too')
  assert.equal(ceilingNeedsExtensions(['mcp', 'mcpScript', 'mcp__beui'], parentTools), true, 'the MCP family counts (any non-builtin/sdk tag)')
  assert.equal(ceilingNeedsExtensions(['read', 'unknown-tool'], parentTools), false, 'unknown names never count')
  const callable = ['read', 'mcp__beui__get_component', 'mcp__context7__resolve_library_id', 'list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource', 'mcp__legacy']
  assert.deepEqual(
    parentDelegableToolNames(['read', 'codemode'], callable, null),
    ['read', 'codemode', 'mcp__beui__get_component', 'mcp__context7__resolve_library_id', 'list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource'],
    'registered native MCP and resource tools can be delegated even when codemode exposure keeps them out of the active set'
  )
  assert.deepEqual(
    parentDelegableToolNames(['read', 'codemode'], callable, ['read', 'mcp__beui__get_component']),
    ['read', 'mcp__beui__get_component'],
    'a child may delegate only names in its frozen role ceiling; codemode alone never widens it'
  )

  const profileOf = (name, tools) => ({ name, displayName: name, description: `${name} profile`, systemPrompt: 'x', tools,
    toolsSource: 'explicit', inheritContext: false, runInBackground: false, enabled: true, scope: 'global', filePath: `/${name}.md` })
  let roster = [profileOf('scout', ['read'])]
  const dispatched = []
  const started = { run: { runId: 'r1', sessionId: 'c1', sessionPath: '/c.jsonl', parentToolCallId: 'tc', profile: 'scout',
      description: 'd', task: 't', runInBackground: true, status: 'running', createdAt: new Date().toISOString(), seq: 1 },
    completion: Promise.resolve({ status: 'completed', runId: 'r1', sessionId: 'c1', description: 'd', profile: 'scout' }) }
  let reuseAllowed = false
  let turnLimitOverrideAllowed = false
  const requestedLimits = []
  const resumed = []
  const tool = createSubagentTool({
    runtime: {
      start: async (_state, request) => { dispatched.push(request.profile); requestedLimits.push(request.maxTurns); return started },
      resume: async (_state, _session, sessionId, message, options) => { resumed.push({ sessionId, message, options }); return started }
    },
    state: { roster: new Map([['c1', { sessionId: 'c1', profile: 'scout', status: 'completed' }]]) },
    parentSessionRef: { session: { getActiveToolNames: () => [] } },
    parentSessionPath: '/p.jsonl',
    profiles: () => roster,
    canStart: () => true,
    canReuse: () => reuseAllowed,
    canSetMaxTurns: () => turnLimitOverrideAllowed,
    canSteer: () => false
  })
  assert.match(tool.description, /scout profile/, 'the roster renders')
  await tool.execute('tc1', { subagent_type: 'scout', prompt: 'p', description: 'd', run_in_background: true }, undefined, undefined)
  assert.equal(dispatched[0].tools.join(','), 'read', 'a dispatch resolves the roster live')
  // A Settings save replaces the roster; the SAME tool instance follows it —
  // for the description the model reads AND the profile a dispatch resolves.
  roster = [profileOf('scout', ['read', 'web_search'])]
  assert.match(tool.description, /read,web_search/, 'the roster re-derives from the files without rebuilding the session')
  await tool.execute('tc2', { subagent_type: 'scout', prompt: 'p', description: 'd', run_in_background: true }, undefined, undefined)
  assert.equal(dispatched[1].tools.join(','), 'read,web_search', 'the NEXT delegation uses the saved tool set, not the build-time one')
  roster = []
  let vanished = false
  try { await tool.execute('tc3', { subagent_type: 'scout', prompt: 'p', description: 'd', run_in_background: true }, undefined, undefined) } catch { vanished = true }
  assert.ok(vanished, 'a removed/disabled profile stops dispatching immediately')

  // --- continue_session_id: reuse is its own switch, and a continuation
  //     carries the NEW dispatch's identity into resume() ---
  let reuseRefused = false
  try { await tool.execute('tc4', { subagent_type: 'scout', prompt: 'second half', description: 'Follow-up', continue_session_id: 'c1' }, undefined, undefined) } catch (error) {
    reuseRefused = /disabled in Settings/.test(String(error?.message))
  }
  assert.ok(reuseRefused, 'continuing an existing subagent is refused while reuse is off')
  reuseAllowed = true
  await tool.execute('tc5', { subagent_type: 'scout', prompt: 'second half now', description: 'Follow-up', continue_session_id: 'c1' }, undefined, undefined)
  assert.equal(resumed.length, 1)
  assert.equal(resumed[0].sessionId, 'c1')
  assert.equal(resumed[0].message, 'second half now')
  assert.equal(resumed[0].options.parentToolCallId, 'tc5', 'the continuation records the NEW tool call (receipt barrier + dispatch record)')
  assert.equal(resumed[0].options.description, 'Follow-up')
  assert.equal(resumed[0].options.runInBackground, false, 'a continuation without run_in_background follows the tool contract: foreground')
  let mismatched = false
  try { await tool.execute('tc6', { subagent_type: 'reviewer', prompt: 'x', description: 'd', continue_session_id: 'c1' }, undefined, undefined) } catch (error) {
    mismatched = /profile "scout"/.test(String(error?.message))
  }
  assert.ok(mismatched, 'a continuation names the profile the child was actually created with')

  roster = [profileOf('scout', ['read'])]
  assert.ok(!('max_turns' in tool.parameters.properties), 'the model cannot see a turn override while the grant is off')
  assert.match(tool.description, /The user controls the turn limit/)
  await tool.execute('tc7', { subagent_type: 'scout', prompt: 'p', description: 'd', max_turns: 200 }, undefined, undefined)
  assert.equal(requestedLimits.at(-1), undefined, 'a stale or fabricated override is discarded when the grant is off')
  turnLimitOverrideAllowed = true
  assert.ok('max_turns' in tool.parameters.properties, 'the SAME tool exposes max_turns when the grant turns on')
  await tool.execute('tc8', { subagent_type: 'scout', prompt: 'p', description: 'd', max_turns: 3 }, undefined, undefined)
  assert.equal(requestedLimits.at(-1), 3)
  await tool.execute('tc9', { subagent_type: 'scout', prompt: 'p', description: 'd', max_turns: 4, continue_session_id: 'c1' }, undefined, undefined)
  assert.equal(resumed.at(-1).options.maxTurns, 4, 'permitted continuations also carry the override')
  turnLimitOverrideAllowed = false
  assert.ok(!('max_turns' in tool.parameters.properties), 'revocation removes max_turns without rebuilding the tool')
  await tool.execute('tc10', { subagent_type: 'scout', prompt: 'p', description: 'd', max_turns: 200, continue_session_id: 'c1' }, undefined, undefined)
  assert.equal(resumed.at(-1).options.maxTurns, undefined, 'held continuation calls also lose the override')
  roster = [{ ...profileOf('scout', ['read']), runInBackground: true }]
  await tool.execute('tc11', { subagent_type: 'scout', prompt: 'p', description: 'd', continue_session_id: 'c1' }, undefined, undefined)
  assert.equal(resumed.at(-1).options.runInBackground, true, 'model continuation reads the current role background default')
  await tool.execute('tc12', { subagent_type: 'scout', prompt: 'p', description: 'd', run_in_background: false, continue_session_id: 'c1' }, undefined, undefined)
  assert.equal(resumed.at(-1).options.runInBackground, false, 'an explicit foreground continuation overrides the role default')
}

// --- agent_steer / message_parent: the communications tools ---
{
  const { createAgentSteerTool, createMessageParentTool } = await import('../src/main/pi/subagents/tools.ts')
  let steered = null
  let allowSteer = true
  const steerTool = createAgentSteerTool({
    runtime: { steer: (_state, sessionId, message) => { if (sessionId !== 'live') throw new Error('Subagent is not running'); steered = { sessionId, message } } },
    state: {},
    canSteer: () => allowSteer
  })
  let result = await steerTool.execute('t1', { session_id: 'live', message: 'wrap up now and report' }, undefined, undefined)
  assert.equal(steered.sessionId, 'live')
  assert.equal(steered.message, 'wrap up now and report')
  assert.match(result.content[0].text, /queued/, 'a delivered steer says so')
  assert.equal(result.details.delivered, true)
  result = await steerTool.execute('t2', { session_id: 'finished', message: 'x' }, undefined, undefined)
  assert.match(result.content[0].text, /Not delivered/, 'a finished subagent cannot be steered')
  assert.equal(result.details.delivered, false)
  allowSteer = false
  let steerRefused = false
  try { await steerTool.execute('t3', { session_id: 'live', message: 'x' }, undefined, undefined) } catch { steerRefused = true }
  assert.ok(steerRefused, 'steering is refused while the setting is off')

  let delivered = null
  const parentTool = createMessageParentTool({
    deliver: async (message) => { delivered = message; return { delivered: true } },
    canUse: () => true
  })
  result = await parentTool.execute('t4', { message: 'halfway done; is X in scope?' }, undefined, undefined)
  assert.equal(delivered, 'halfway done; is X in scope?')
  assert.match(result.content[0].text, /delivered/)
  assert.equal(result.details.delivered, true)
  const failing = createMessageParentTool({
    deliver: async () => ({ delivered: false, reason: 'the parent session is stopped' }),
    canUse: () => true
  })
  result = await failing.execute('t5', { message: 'hello?' }, undefined, undefined)
  assert.match(result.content[0].text, /could not receive/, 'a dropped message says so and tells the child to continue')
  assert.equal(result.details.delivered, false)
  let emptyRefused = false
  try { await parentTool.execute('t6', { message: '   ' }, undefined, undefined) } catch { emptyRefused = true }
  assert.ok(emptyRefused, 'an empty message is refused')
}

// --- starter profiles: the marker beside the files heals a drifted agent dir
//     and still respects a deliberate removal ---
{
  const root = await mkdtemp(join(tmpdir(), 'pith-subagent-defaults-'))
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = join(root, 'agent')
  try {
    const { existsSync, readdirSync } = await import('node:fs')
    const agentsDir = join(root, 'agent', 'agents')
    const stateDir = join(root, 'state')
    const marker = join(agentsDir, '.pi-app-defaults-v1.json')
    const names = () => { try { return readdirSync(agentsDir).filter((file) => file.endsWith('.md')).sort() } catch { return [] } }
    // 1) First run: the starters plus both markers.
    profiles.ensureDefaultProfiles(stateDir)
    assert.equal(names().length, 4)
    assert.ok(existsSync(marker) && existsSync(join(stateDir, 'subagent-defaults-v1.json')))
    // 2) Pruning one starter does not resurrect it.
    await rm(join(agentsDir, 'reviewer.md'), { force: true })
    profiles.ensureDefaultProfiles(stateDir)
    assert.equal(names().includes('reviewer.md'), false, 'a deleted starter stays deleted')
    // 3) Drift: the files are gone but the LEGACY userData marker remains —
    //    the old marker-only guard left the app with ZERO profiles here.
    for (const file of names()) await rm(join(agentsDir, file), { force: true })
    await rm(marker, { force: true })
    profiles.ensureDefaultProfiles(stateDir)
    assert.equal(names().length, 4, 'an empty agent dir with only the legacy marker heals')
    // 4) Deleting EVERY profile on purpose (marker beside the files) is respected.
    for (const file of names()) await rm(join(agentsDir, file), { force: true })
    profiles.ensureDefaultProfiles(stateDir)
    assert.equal(names().length, 0, 'a deliberate full removal is not undone')
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir
    await rm(root, { recursive: true, force: true })
  }
}

// --- model spec errors: "not configured" must never read as "wrong syntax".
//     A real parent model was told `Unknown subagent model "x/y" (expected
//     "provider/modelId")` for a perfectly well-formed spec — the parenthetical
//     sent it chasing its own syntax instead of the real cause. ---
{
  const { subagentModelSpecError } = await import('../src/main/pi/subagents/model-spec.ts')
  const lookup = {
    providers: ['deepseek', 'openai-codex'],
    modelsOf: (id) => (id === 'deepseek' ? ['deepseek-flash', 'deepseek-pro'] : null)
  }
  assert.match(subagentModelSpecError('nope', lookup), /Invalid subagent model "nope": expected "provider\/modelId"/)
  assert.match(subagentModelSpecError('deepseek/', lookup), /Invalid subagent model/)
  assert.match(subagentModelSpecError('/flash', lookup), /Invalid subagent model/)
  const unknownProvider = subagentModelSpecError('totally-fake-provider/does-not-exist-model-xyz', lookup)
  assert.match(unknownProvider, /Unknown subagent model provider "totally-fake-provider"/)
  assert.match(unknownProvider, /well-formed/, 'the message says the spec itself was fine')
  assert.match(unknownProvider, /Configured providers: deepseek, openai-codex/)
  assert.match(unknownProvider, /Omit "model"/, 'and offers the way out')
  assert.ok(!/expected "provider\/modelId"/.test(unknownProvider), 'a well-formed spec is never reported as a syntax error')
  const unknownModel = subagentModelSpecError('deepseek/nope', lookup)
  assert.match(unknownModel, /Provider "deepseek" has no model "nope"/)
  assert.match(unknownModel, /deepseek-flash, deepseek-pro/)
  // A large catalog is capped so the message cannot flood the model's context.
  const many = Array.from({ length: 40 }, (_, index) => `m${index}`)
  const capped = subagentModelSpecError('big/missing', { providers: ['big'], modelsOf: () => many })
  assert.match(capped, /has no model "missing"/)
  assert.match(capped, /m0, m1/)
  assert.match(capped, /…/)
  assert.ok(!capped.includes('m30'), 'available models are truncated')
}

// --- terminal status rules: only a STOP is aborted; a turn limit and an
//     unpersisted result are reported, never masked ---
{
  const { deriveRunOutcome } = await import('../src/main/pi/subagents/runtime.ts')
  const base = { userAborted: false, turnLimitReached: false }
  assert.deepEqual(deriveRunOutcome({ ...base, stopReason: 'stop' }), { status: 'completed' })
  assert.deepEqual(deriveRunOutcome({ ...base, stopReason: 'aborted' }), { status: 'aborted' })
  // The runtime's own turn-limit abort is a designed end: the run reports the
  // answer it produced (and a marker) instead of masquerading as a user stop —
  // which would also suppress the parent's completion notification.
  assert.deepEqual(deriveRunOutcome({ ...base, turnLimitReached: true, stopReason: 'aborted' }),
    { status: 'completed', limitReached: true })
  assert.deepEqual(deriveRunOutcome({ ...base, stopReason: 'error', errorMessage: 'provider 500' }),
    { status: 'failed', error: 'provider 500' })
  assert.deepEqual(deriveRunOutcome({ ...base, promptError: 'model unavailable' }),
    { status: 'failed', error: 'model unavailable' })
  const unpersisted = deriveRunOutcome({ ...base, persistenceError: 'The run result could not be persisted (disk full)' })
  assert.equal(unpersisted.status, 'failed', 'a terminal record that cannot be written is never a silent success')
  assert.match(unpersisted.error, /could not be persisted/)
  // A user stop outranks everything; the limit marker survives a failure.
  assert.deepEqual(deriveRunOutcome({ ...base, userAborted: true, persistenceError: 'x' }), { status: 'aborted' })
  const limitedUnpersisted = deriveRunOutcome({ ...base, turnLimitReached: true, persistenceError: 'x' })
  assert.equal(limitedUnpersisted.status, 'failed')
  assert.equal(limitedUnpersisted.limitReached, true)
}

// --- roster rows are panel metadata: patch bodies never ride them ---
{
  const withPatch = { sessionId: 'c1', runId: 'r1', seq: 1, status: 'completed', createdAt: '2026-01-01T00:00:00Z',
    writtenFiles: [{ filePath: '/w/a.ts', displayPath: 'a.ts', added: 1, removed: 2, patch: '+++ a diff body' },
      { filePath: '/w/generated.png', displayPath: 'generated.png', kind: 'generated-image' }] }
  const slim = protocol.slimRunForRoster(withPatch)
  assert.equal(slim.writtenFiles[0].patch, undefined, 'the roster payload carries no patch body')
  assert.equal(slim.writtenFiles[0].displayPath, 'a.ts')
  assert.equal(slim.writtenFiles[0].added, 1)
  assert.equal(slim.writtenFiles[0].removed, 2)
  assert.equal(slim.writtenFiles[1].kind, 'generated-image', 'slimming keeps image receipt classification')
  assert.equal(protocol.slimRunForRoster(slim), slim, 'slimming an already-slim row is a no-op')
  const withoutFiles = { ...withPatch, writtenFiles: undefined }
  assert.equal(protocol.slimRunForRoster(withoutFiles), withoutFiles, 'a row without files is untouched')
  assert.equal(withPatch.writtenFiles[0].patch, '+++ a diff body', 'the caller\'s full row is not mutated')
}

// --- a turn-limit marker persists and reads back; junk markers are ignored ---
{
  const limited = entriesOf(
    { customType: protocol.SUBAGENT_RUN_TYPE, data: run() },
    { customType: protocol.SUBAGENT_RESULT_TYPE, data: result({ limitReached: true }) }
  )
  const dto = protocol.currentDiskRun(limited, 'child', '/p/child.jsonl')
  assert.equal(dto.status, 'completed')
  assert.equal(dto.limitReached, true)
  assert.equal(protocol.readDiskSubagentRuns(limited)[0].result.limitReached, true)
  const junk = protocol.readDiskSubagentRuns(entriesOf(
    { customType: protocol.SUBAGENT_RUN_TYPE, data: run() },
    { customType: protocol.SUBAGENT_RESULT_TYPE, data: result({ limitReached: 'yes' }) }
  ))
  assert.equal(junk[0].result.limitReached, undefined, 'non-boolean markers are dropped')
}

// --- subagent session marker: children only, and only from the bounded head ---
{
  const { isSubagentSessionFile } = await import('../src/main/pi/subagents/session-filter.ts')
  const markerDir = await mkdtemp(join(tmpdir(), 'pith-subagent-marker-'))
  try {
    const header = JSON.stringify({ type: 'session', id: 'c', parentSession: '/p/parent.jsonl' })
    const childFile = join(markerDir, 'child.jsonl')
    await writeFile(childFile, `${header}\n${JSON.stringify({ type: 'custom', customType: 'pith_subagent_run', data: {} })}\n`)
    assert.equal(isSubagentSessionFile(childFile), true)
    // Forks carry the same parentSession header and MUST stay visible.
    const forkFile = join(markerDir, 'fork.jsonl')
    await writeFile(forkFile, `${header}\n`)
    assert.equal(isSubagentSessionFile(forkFile), false)
    const lateFile = join(markerDir, 'late.jsonl')
    await writeFile(lateFile, `${'x'.repeat(129 * 1024)}\n${JSON.stringify({ type: 'custom', customType: 'pith_subagent_run' })}\n`)
    assert.equal(isSubagentSessionFile(lateFile), false, 'the marker must sit inside the bounded head read')
    assert.equal(isSubagentSessionFile(join(markerDir, 'missing.jsonl')), false)
  } finally {
    await rm(markerDir, { recursive: true, force: true })
  }
}

console.log('check-subagents: all assertions passed')

// ===========================================================================
// Runtime integration checks (real SDK SessionManager files, mock host).
// These close the loop the pure-protocol tests above cannot: what the runtime
// actually PERSISTS must be readable by its own recovery paths.
// ===========================================================================
{
  const { SubagentRuntime, SubagentParentState } = await import('../src/main/pi/subagents/runtime.ts')
  const { SessionManager } = await import('@earendil-works/pi-coding-agent')
  const { mkdirSync, writeFileSync, existsSync } = await import('node:fs')

  const dir = await mkdtemp(join(tmpdir(), 'pith-subagents-e2e-'))
  const profile = { name: 'explore', displayName: 'Explore', description: 'd', systemPrompt: 'You explore.', tools: ['read', 'grep'], inheritContext: false, runInBackground: false, enabled: true }
  try {
    // A real parent file (start() refuses unsaved parents). The sessionDir
    // keeps the test's files out of the user's ~/.pi/agent/sessions tree.
    const sessionsDir = join(dir, 'sessions')
    mkdirSync(sessionsDir, { recursive: true })
    const materialize = (manager) => {
      writeFileSync(manager.getSessionFile(), `${JSON.stringify(manager.getHeader())}\n`, { flag: 'wx' })
      // Mark the session flushed (what PiManager.materializeSession does), so
      // later appendCustomEntry calls write incrementally to the real file.
      manager.setSessionFile(manager.getSessionFile())
    }
    const parent = SessionManager.create(dir, sessionsDir)
    materialize(parent)

    /** Minimal fake AgentSession whose prompt behaviour each test controls.
     * `emit` drives the runtime's own event subscription (turn limits, progress). */
    const fakeSession = (over = {}) => {
      const listeners = new Set()
      return {
        sessionId: 'child-session',
        subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
        emit: (event) => { for (const listener of [...listeners]) listener(event) },
        prompt: async () => {},
        abort: async () => {},
        steer: () => {},
        isIdle: true,
        messages: [],
        getLastAssistantText: () => undefined,
        getActiveToolNames: () => ['read', 'grep', 'edit', 'write', 'bash', 'todo_write'],
        getCallableToolNames: () => [],
        getAllTools: () => [],
        sessionManager: parent,
        ...over
      }
    }
    const parentSession = fakeSession({ sessionId: 'parent-session', getActiveToolNames: () => ['read', 'grep', 'edit', 'write', 'bash', 'todo_write'] })

    const leases = new Set()
    const emits = []
    const completionsDelivered = []
    const childPaths = []
    // Subagent communications default OFF here (the shipped default);
    // flipping it is a per-test, restorable action read live by the host.
    let commsEnabled = false
    let turnLimitOverrideEnabled = false
    let userMaxTurns = null
    let planRestricted = false
    const makeHost = (childSession) => ({
      isClosing: () => false,
      maxConcurrentSubagents: () => 4,
      subagentsEnabled: () => true,
      subagentReuseEnabled: () => true,
      subagentCommsEnabled: () => commsEnabled,
      subagentTurnLimitOverrideEnabled: () => turnLimitOverrideEnabled,
      subagentMaxTurns: () => userMaxTurns,
      planRestricted: () => planRestricted,
      frozenToolCeiling: () => null,
      commandTasks: () => null,
      acquireRunLease: (_cwd, sessionPath) => { leases.add(sessionPath); return () => leases.delete(sessionPath) },
      createChildSession: async (options) => {
        // Real child file with the real parentSession header link; a reopen
        // continues the EXISTING child file instead of creating another.
        const manager = options.mode === 'reopen'
          ? SessionManager.open(options.sessionPath)
          : SessionManager.create(options.cwd, sessionsDir, { parentSession: options.parentSessionPath })
        if (options.mode === 'reopen') manager.setSessionFile(options.sessionPath)
        else materialize(manager)
        // The fake session's scripted messages live in the REAL branch too —
        // the runtime extracts written files (and status) from the persisted
        // branch, exactly like a real AgentSession would.
        const prompt = childSession.prompt
        childSession.prompt = async (...args) => {
          for (const message of childSession.messages ?? []) manager.appendMessage(message)
          return prompt(...args)
        }
        childSession.sessionManager = manager
        return {
          session: childSession, sessionManager: manager, path: manager.getSessionFile(), cwd: options.cwd,
          runId: options.runId, parentSessionId: options.parentSessionId, resource: options.resource,
          halt: async () => { await childSession.abort() },
          release: () => {}
        }
      },
      emitSubagents: (_id, _path, runs) => emits.push(runs),
      resolveModelSpec: async () => ({ spec: 'test/model' }),
      notifySubagentChildWrite: () => {}
    })
    const baseRequest = (over = {}) => ({
      parentSession, parentSessionPath: parent.getSessionFile(), parentToolCallId: 'call-1',
      profile, description: 'Map modules', task: 'Map them', runInBackground: false, ...over
    })

    // --- 1) Real persistence round-trip: what start() wrote must read back ---
    {
      const session = fakeSession({ getLastAssistantText: () => 'All mapped.' })
      const runtime = new SubagentRuntime(makeHost(session))
      const state = new SubagentParentState('parent-session')
      const { completion } = await runtime.start(state, baseRequest())
      const finished = await completion
      assert.equal(finished.status, 'completed')
      assert.equal(finished.result, 'All mapped.')
      assert.equal(leases.size, 0, 'run lease released at completion')
      const childPath = finished.sessionPath
      assert.ok(existsSync(childPath))
      const runs = runtime.readChildRuns(childPath)
      assert.equal(runs.length, 1, 'run start+result persisted to the real child file')
      assert.equal(runs[0].start.parentSessionId, 'parent-session', 'real parent session id persisted')
      assert.equal(runs[0].start.parentSessionPath, parent.getSessionFile())
      assert.equal(runs[0].result?.status, 'completed')
      assert.deepEqual(runs[0].start.resource.tools.sort(), ['grep', 'read'])
    }

    // The debug grant rides the profile's ordinary tool set: `all` inherits
    // the parent's debug availability, an explicit `debug` entry grants it,
    // the parent's active set stays the ceiling, and a resume only narrows
    // the frozen set.
    {
      const debugParent = fakeSession({ sessionId: 'parent-session', getActiveToolNames: () => ['read', 'debug'] })
      const host = makeHost(fakeSession({ getLastAssistantText: () => 'done' }))
      let allowed = true
      host.profileDebugEnabled = () => allowed
      const runtime = new SubagentRuntime(host), state = new SubagentParentState('parent-session')
      const all = await (await runtime.start(state, baseRequest({ parentSession: debugParent, profile: { ...profile, tools: 'all' } }))).completion
      assert.deepEqual(runtime.readChildRuns(all.sessionPath)[0].start.resource.tools, ['read', 'debug'], 'tools: all inherits the parent debug availability')
      const off = await (await runtime.start(state, baseRequest({ parentSession: debugParent, profile: { ...profile, tools: ['read'] } }))).completion
      assert.deepEqual(runtime.readChildRuns(off.sessionPath)[0].start.resource.tools, ['read'], 'an explicit list without debug stays without it')
      const on = await (await runtime.start(state, baseRequest({ parentSession: debugParent, profile: { ...profile, tools: ['read', 'debug'] } }))).completion
      assert.deepEqual(runtime.readChildRuns(on.sessionPath)[0].start.resource.tools, ['read', 'debug'], 'an explicit debug entry grants it when the parent has it')
      allowed = false
      await (await runtime.resume(state, debugParent, on.sessionId, 'continue')).completion
      assert.deepEqual(runtime.readChildRuns(on.sessionPath)[0].start.resource.tools, ['read'])
      allowed = true
      await (await runtime.resume(state, debugParent, on.sessionId, 'continue again')).completion
      assert.deepEqual(runtime.readChildRuns(on.sessionPath)[0].start.resource.tools, ['read'], 'resume cannot widen a frozen ceiling')
      const missing = await (await runtime.start(state, baseRequest({ profile: { ...profile, tools: ['read', 'debug'] } }))).completion
      assert.ok(!runtime.readChildRuns(missing.sessionPath)[0].start.resource.tools.includes('debug'), 'parent active set is still the upper ceiling')
    }

    // Native MCP tools are callable through codemode without entering the
    // parent model's active declarations. Explicit grants and `all` must see
    // them, while a nested parent's frozen ceiling remains an upper bound.
    {
      const mcpParent = fakeSession({
        sessionId: 'parent-session',
        getActiveToolNames: () => ['read', 'codemode', 'tool_search'],
        getCallableToolNames: () => ['read', 'mcp__beui__get_component', 'mcp__context7__resolve_library_id', 'list_mcp_resources'],
        getAllTools: () => [
          { name: 'read', sourceInfo: { source: 'builtin' } },
          { name: 'codemode', sourceInfo: { source: 'temporary' } },
          { name: 'tool_search', sourceInfo: { source: 'temporary' } },
          { name: 'mcp__beui__get_component', sourceInfo: { source: 'temporary' } },
          { name: 'mcp__context7__resolve_library_id', sourceInfo: { source: 'temporary' } },
          { name: 'list_mcp_resources', sourceInfo: { source: 'temporary' } }
        ]
      })
      const host = makeHost(fakeSession({ getLastAssistantText: () => 'done' }))
      let parentFrozen = null
      host.frozenToolCeiling = () => parentFrozen
      const runtime = new SubagentRuntime(host), state = new SubagentParentState('parent-session')
      const explicit = await (await runtime.start(state, baseRequest({ parentSession: mcpParent, profile: { ...profile, tools: ['read', 'mcp__beui__get_component'] } }))).completion
      const firstResource = runtime.readChildRuns(explicit.sessionPath)[0].start.resource
      assert.deepEqual(firstResource.tools, ['read', 'mcp__beui__get_component'], 'an explicit native MCP grant survives dispatch despite codemode exposure')
      assert.equal(firstResource.extensions, true, 'the child loads the extension defining its MCP grant')
      parentFrozen = ['read']
      await (await runtime.resume(state, mcpParent, explicit.sessionId, 'continue')).completion
      assert.deepEqual(runtime.readChildRuns(explicit.sessionPath)[0].start.resource.tools, ['read'], 'resume narrows a frozen MCP grant when the parent ceiling narrows')
      parentFrozen = null
      const all = await (await runtime.start(state, baseRequest({ parentSession: mcpParent, profile: { ...profile, tools: 'all' } }))).completion
      assert.deepEqual(runtime.readChildRuns(all.sessionPath)[0].start.resource.tools,
        ['read', 'codemode', 'tool_search', 'mcp__beui__get_component', 'mcp__context7__resolve_library_id', 'list_mcp_resources'],
        'tools: all includes every callable native MCP and resource tool')
      parentFrozen = ['read', 'mcp__beui__get_component']
      const nested = await (await runtime.start(state, baseRequest({ parentSession: mcpParent, profile: { ...profile, tools: 'all' } }))).completion
      assert.deepEqual(runtime.readChildRuns(nested.sessionPath)[0].start.resource.tools,
        ['read', 'mcp__beui__get_component'], 'nested all cannot expand past its parent role ceiling')
    }

    // --- 1b) message_parent injection follows the communications flag ---
    {
      const session = fakeSession({ getLastAssistantText: () => 'done' })
      const runtime = new SubagentRuntime(makeHost(session))
      const state = new SubagentParentState('parent-session')
      const off = await (await runtime.start(state, baseRequest())).completion
      childPaths.push(off.sessionPath)
      assert.ok(!runtime.readChildRuns(off.sessionPath)[0].start.resource.tools.includes('message_parent'),
        'communications off: the ceiling stays exactly the profile set')

      commsEnabled = true
      try {
        const runtimeOn = new SubagentRuntime(makeHost(fakeSession({ getLastAssistantText: () => 'done' })))
        const stateOn = new SubagentParentState('parent-session')
        const on = await (await runtimeOn.start(stateOn, baseRequest())).completion
        childPaths.push(on.sessionPath)
        assert.ok(runtimeOn.readChildRuns(on.sessionPath)[0].start.resource.tools.includes('message_parent'),
          'communications on: every dispatched ceiling gains message_parent (frozen into the run record)')
      } finally { commsEnabled = false }
    }

    // Four role defaults apply only when the parent omits the argument.
    {
      const role = { ...profile, model: 'role/default', thinking: 'high', inheritContext: false, runInBackground: true }
      const execute = async overrides => {
        const host = makeHost(fakeSession({ getLastAssistantText: () => 'done' }))
        let modelSpec
        host.resolveModelSpec = async spec => { modelSpec = spec; return { spec: spec ?? 'parent/live' } }
        const runtime = new SubagentRuntime(host)
        const state = new SubagentParentState('parent-session')
        const finished = await (await runtime.start(state, baseRequest({ profile: role, runInBackground: undefined, ...overrides }))).completion
        childPaths.push(finished.sessionPath)
        return { finished, modelSpec, resource: runtime.readChildRuns(finished.sessionPath)[0].start.resource }
      }
      const inherited = await execute({})
      assert.equal(inherited.modelSpec, 'role/default')
      assert.equal(inherited.resource.thinkingLevel, 'high')
      assert.equal(inherited.resource.inheritContext, false)
      assert.equal(inherited.finished.runInBackground, true, 'an omitted background choice uses the role default')
      const overridden = await execute({ modelSpec: 'parent/override', thinkingLevel: 'off', inheritContext: true, runInBackground: false })
      assert.equal(overridden.modelSpec, 'parent/override')
      assert.equal(overridden.resource.thinkingLevel, 'off')
      assert.equal(overridden.resource.inheritContext, true)
      assert.equal(overridden.finished.runInBackground, false, 'an explicit false overrides a background role')
      const unchanged = await execute({ profile })
      assert.equal(unchanged.modelSpec, undefined)
      assert.equal(unchanged.resource.model, 'parent/live')
      assert.equal(unchanged.resource.thinkingLevel, undefined)
      assert.equal(unchanged.resource.inheritContext, profile.inheritContext)
      assert.equal(unchanged.finished.runInBackground, false, 'unconfigured background behavior stays foreground')
    }

    // User turn-limit authority survives profile values, forged args and reuse.
    {
      const runtime = new SubagentRuntime(makeHost(fakeSession({ getLastAssistantText: () => 'done' })))
      const state = new SubagentParentState('parent-session')
      const limitOf = (finished) => runtime.readChildRuns(finished.sessionPath)[0].start.resource.maxTurns
      const start = async (over = {}) => {
        const finished = await (await runtime.start(state, baseRequest({ profile: { ...profile, maxTurns: 1 }, ...over }))).completion
        childPaths.push(finished.sessionPath)
        return finished
      }
      try {
        userMaxTurns = 6
        assert.equal(limitOf(await start({ maxTurns: 200 })), 6, 'a locked user limit overrides both the parent and the profile')
        userMaxTurns = null
        assert.equal(limitOf(await start({ maxTurns: 0 })), undefined, 'blank means unlimited even with a profile limit and a fabricated argument')
        userMaxTurns = 6
        turnLimitOverrideEnabled = true
        const permitted = await start({ maxTurns: 2 })
        assert.equal(limitOf(permitted), 2, 'an explicit grant lets the parent override the user default')
        assert.equal(limitOf(await start()), 6, 'omitting the override uses the user default')
        const resume = async (maxTurns) => (await runtime.resume(state, parentSession, permitted.sessionId, 'continue', { maxTurns })).completion
        assert.equal(limitOf(await resume(3)), 3, 'a permitted continuation can choose a fresh limit')
        turnLimitOverrideEnabled = false
        userMaxTurns = 9
        assert.equal(limitOf(await resume(200)), 9, 'revoking the grant replaces the persisted override on resume')
        userMaxTurns = null
        assert.equal(limitOf(await resume(1)), undefined, 'clearing the user setting removes any persisted limit on resume')
      } finally { turnLimitOverrideEnabled = false; userMaxTurns = null }
    }

    // --- 1c) resume() shares start's { run, completion } shape and honors
    //         the model-driven overrides ---
    {
      const session = fakeSession({ getLastAssistantText: () => 'continued.' })
      const runtime = new SubagentRuntime(makeHost(session))
      const state = new SubagentParentState('parent-session')
      const first = await (await runtime.start(state, baseRequest())).completion
      childPaths.push(first.sessionPath)
      const resumed = await runtime.resume(state, parentSession, first.sessionId, 'now do the second half', {
        parentToolCallId: 'call-9', description: 'Second half', runInBackground: false
      })
      assert.equal(resumed.run.sessionId, first.sessionId, 'the continuation reopens the same child session')
      const finished = await resumed.completion
      childPaths.push(finished.sessionPath)
      assert.equal(finished.status, 'completed')
      const runs = runtime.readChildRuns(first.sessionPath)
      assert.equal(runs.length, 2, 'a resume appends a fresh run record to the child file')
      assert.equal(runs[0].start.parentToolCallId, 'call-9', 'the model path records its own dispatch tool call (readChildRuns is newest-first)')
      assert.equal(runs[0].start.description, 'Second half')
      assert.equal(runs[0].start.runInBackground, false)
    }

    // Plan resume narrows the frozen resource, including a cold read.
    {
      const session = fakeSession({ getLastAssistantText: () => 'investigated' })
      const runtime = new SubagentRuntime(makeHost(session))
      const state = new SubagentParentState('parent-session')
      const first = await (await runtime.start(state, baseRequest({ profile: { ...profile, tools: ['read', 'write'] } }))).completion
      const original = runtime.readChildRuns(first.sessionPath)[0].start.resource
      assert(original.tools.includes('write'))
      planRestricted = true
      const narrowParent = { ...parentSession, getActiveToolNames: () => ['read', 'submit_plan'] }
      await (await runtime.resume(state, narrowParent, first.sessionId, 'Investigate only')).completion
      const reopened = runtime.readChildRuns(first.sessionPath)[0].start.resource
      assert.equal(reopened.planRestricted, true)
      assert.deepEqual(reopened.tools, ['read'])
      assert(original.tools.includes('write'), 'historical resource was mutated')
      planRestricted = false
      await (await runtime.resume(state, parentSession, first.sessionId, 'Continue investigation')).completion
      const frozen = runtime.readChildRuns(first.sessionPath)[0].start.resource
      assert.equal(frozen.planRestricted, true)
      assert.deepEqual(frozen.tools, ['read'])
      childPaths.push(first.sessionPath)
    }

    // --- 2) Startup cancellation: an aborted signal never reaches creation ---
    {
      let created = 0
      const host = makeHost(fakeSession())
      host.createChildSession = async (options) => { created++; return (await makeHost(fakeSession()).createChildSession(options)) }
      const runtime = new SubagentRuntime(host)
      const state = new SubagentParentState('parent-session')
      const controller = new AbortController()
      controller.abort()
      await assert.rejects(
        () => runtime.start(state, baseRequest(), controller.signal),
        /cancelled before launch/
      )
      assert.equal(created, 0, 'no child session is created for a cancelled launch')
      assert.equal(leases.size, 0)
    }

    // --- 3) Errored final round resolves prompt normally: status must fail ---
    {
      const session = fakeSession({ messages: [{ role: 'assistant', content: [], timestamp: 1, stopReason: 'error', error: 'provider 500' }] })
      const runtime = new SubagentRuntime(makeHost(session))
      const state = new SubagentParentState('parent-session')
      const finished = await (await runtime.start(state, baseRequest())).completion
      assert.equal(finished.status, 'failed')
      assert.match(finished.error, /provider 500/)
    }

    // --- 4) prompt() rejection surfaces as failed, lease still released ---
    {
      const session = fakeSession({ prompt: async () => { throw new Error('model unavailable') } })
      const runtime = new SubagentRuntime(makeHost(session))
      const state = new SubagentParentState('parent-session')
      const finished = await (await runtime.start(state, baseRequest())).completion
      assert.equal(finished.status, 'failed')
      assert.match(finished.error, /model unavailable/)
      assert.equal(leases.size, 0)
    }

    // --- 5) Abort mid-run: complete stop, suppressed notification, aborted status ---
    {
      // The fake wires abort() to the pending prompt the way the real SDK
      // does: abort settles the in-flight prompt, the run's completion then
      // derives its aborted status from the abort bookkeeping.
      let rejectPrompt
      let halted = 0
      const session = fakeSession({
        prompt: () => new Promise((_resolve, reject) => { rejectPrompt = reject }),
        abort: async () => { rejectPrompt?.(new Error('aborted by user')); rejectPrompt = undefined }
      })
      const host = makeHost(session)
      const runtime = new SubagentRuntime(host)
      const state = new SubagentParentState('parent-session')
      state.notifications = { complete: (run) => completionsDelivered.push(run), drop: () => {}, canStart: true }
      const { completion } = await runtime.start(state, baseRequest({ runInBackground: true }))
      await runtime.stopAll(state)
      const finished = await completion
      assert.equal(finished.status, 'aborted')
      assert.equal(completionsDelivered.length, 0, 'a stopped run never wakes the parent')
      assert.equal(leases.size, 0, 'halt releases the run lease')
      void halted
    }

    // --- 5b) Cancellation DURING creation: no prompt may ever start ---
    {
      let releaseCreate, enteredCreate
      const entered = new Promise(resolve => { enteredCreate = resolve })
      const creationGate = new Promise(resolve => { releaseCreate = resolve })
      let prompted = 0
      const session = fakeSession({ prompt: async () => { prompted++ } })
      const host = makeHost(session)
      const originalCreate = host.createChildSession
      host.createChildSession = async (options) => {
        const handle = await originalCreate(options)
        enteredCreate()
        await creationGate
        return handle
      }
      const runtime = new SubagentRuntime(host)
      const state = new SubagentParentState('parent-session')
      const controller = new AbortController()
      const startPromise = runtime.start(state, baseRequest(), controller.signal)
      await entered
      let stopped = false
      const stop = runtime.stopAll(state).then(() => { stopped = true })
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(stopped, false, 'stop waits for in-flight creation')
      releaseCreate()
      // The cancelled launch resolves into an
      // ABORTED run instead of a rejection — no prompt may ever start, and
      // the run's own cleanup (lease, release) settles it.
      const { completion } = await startPromise
      const finished = await completion
      await stop
      assert.equal(finished.status, 'aborted')
      assert.equal(prompted, 0, 'a launch cancelled during creation never prompts')
      assert.equal(leases.size, 0)
      assert.equal(state.countActive(), 0, 'the aborted run leaves no active roster card')
      assert.equal(state.runs.size, 0, 'cancelled-before-prompt runs release registry ownership')
      assert.equal(state.launching.size, 0)
      assert.equal(state.starting.size, 0)
    }

    // --- 5c) Foreground tool signal abort MID-RUN halts the whole run ---
    {
      let haltCount = 0
      const controller = new AbortController()
      let rejectPrompt
      const session = fakeSession({
        prompt: () => new Promise((_resolve, reject) => { rejectPrompt = reject }),
        abort: async () => { rejectPrompt?.(new Error('aborted by signal')); rejectPrompt = undefined }
      })
      const host = makeHost(session)
      const originalHalt = host.createChildSession
      host.createChildSession = async (options) => {
        const handle = await originalHalt(options)
        const innerHalt = handle.halt
        handle.halt = async () => { haltCount++; await innerHalt() }
        return handle
      }
      const runtime = new SubagentRuntime(host)
      const state = new SubagentParentState('parent-session')
      const { completion } = await runtime.start(state, baseRequest(), controller.signal)
      controller.abort()
      const finished = await completion
      assert.equal(finished.status, 'aborted')
      assert.ok(haltCount >= 1, 'the tool signal halts the run, not just the launch')
      assert.equal(leases.size, 0)
    }

    // --- 5d) Start-entry write failure: lease, halt and release all unwind ---
    {
      const session = fakeSession()
      const host = makeHost(session)
      const originalCreate = host.createChildSession
      let halted = 0, released = 0
      host.createChildSession = async (options) => {
        const handle = await originalCreate(options)
        handle.sessionManager.appendCustomEntry = (type) => { if (type === 'pith_subagent_run') throw new Error('disk full') }
        handle.halt = async () => { halted++ }
        handle.release = () => { released++ }
        return handle
      }
      const runtime = new SubagentRuntime(host)
      const state = new SubagentParentState('parent-session')
      await assert.rejects(() => runtime.start(state, baseRequest()), /disk full/)
      assert.equal(leases.size, 0, 'a failed start entry must not leak the run lease')
      assert.equal(halted, 1, 'the child is halted')
      assert.equal(released, 1, 'the child is released')
      assert.equal(state.countActive(), 0)
    }

    // --- 6) collectSubagentWritePaths: child writes from disk, parent branch anchored ---
    {
      // Parent branch: an agent toolCall + successful result.
      parent.appendMessage({ role: 'user', content: 'delegate', timestamp: 1 })
      parent.appendMessage({ role: 'assistant', content: [{ type: 'toolCall', id: 'agent-call-1', name: 'agent', arguments: { subagent_type: 'explore' } }], timestamp: 2 })
      parent.appendMessage({ role: 'toolResult', toolCallId: 'agent-call-1', toolName: 'agent', isError: true, content: [{ type: 'text', text: 'final round errored' }], timestamp: 3 })
      // The fake child performs a real (fake-session) write so the run's own
      // result record carries its writtenFiles naturally.
      const session = fakeSession({
        messages: [
          { role: 'assistant', content: [{ type: 'toolCall', id: 'w1', name: 'write', arguments: { path: 'src/a.ts', content: 'x\ny\n' } }], timestamp: 10 },
          { role: 'toolResult', toolCallId: 'w1', toolName: 'write', isError: false, content: [{ type: 'text', text: 'ok' }], timestamp: 11 }
        ]
      })
      const runtime = new SubagentRuntime(makeHost(session))
      const state = new SubagentParentState(parent.getSessionId())
      const { completion } = await runtime.start(state, baseRequest({ parentToolCallId: 'agent-call-1' }))
      const finished = await completion
      assert.equal(finished.writtenFiles?.length, 1)
      assert.equal(finished.status, 'completed', 'fixture sanity: the run itself finished')
      // The full payload keeps the patch (this is what the changed-files list
      // and rewind coverage read) while the ROSTER row — re-serialized on
      // every progress tick — carries only paths and counts.
      assert.ok(finished.writtenFiles[0].patch, 'the tool-result payload keeps the patch')
      const rosterRow = emits.at(-1).find((row) => row.runId === finished.runId)
      assert.equal(rosterRow.writtenFiles[0].patch, undefined, 'roster rows never carry patch bodies')
      assert.equal(rosterRow.writtenFiles[0].displayPath, 'src/a.ts')
      childPaths.push(finished.sessionPath)
      // A FAILED delegation (the parent toolResult above isError: true) must
      // still surface the files its child committed before failing.
      const paths = await runtime.collectSubagentWritePaths(parent, dir, null, sessionsDir)
      assert.deepEqual(paths, [join(dir, 'src', 'a.ts')])
      // A named anchor that is not on the branch fails loudly instead of
      // silently widening the scan to the whole history.
      await assert.rejects(() => runtime.collectSubagentWritePaths(parent, dir, 'missing-entry', sessionsDir), /lost its checkpoint anchor/)
    }

    // --- 7) A terminal record that cannot be written is a FAILED run ---
    {
      const session = fakeSession({ getLastAssistantText: () => 'All mapped.' })
      const host = makeHost(session)
      const originalCreate = host.createChildSession
      host.createChildSession = async (options) => {
        const handle = await originalCreate(options)
        const real = handle.sessionManager.appendCustomEntry.bind(handle.sessionManager)
        // Only the TERMINAL record fails: the start entry still lands, which is
        // what makes the run exist at all.
        handle.sessionManager.appendCustomEntry = (type, data) => {
          if (type === 'pith_subagent_result') throw new Error('result disk full')
          return real(type, data)
        }
        return handle
      }
      const runtime = new SubagentRuntime(host)
      const state = new SubagentParentState('parent-session')
      const delivered = []
      state.notifications = { complete: (finished) => delivered.push(finished), drop: () => {}, canStart: true }
      const { completion } = await runtime.start(state, baseRequest({ runInBackground: true }))
      const finished = await completion
      childPaths.push(finished.sessionPath)
      assert.equal(finished.status, 'failed', 'an unpersisted result is never reported as success')
      assert.match(finished.error, /could not be persisted/)
      assert.equal(finished.result, 'All mapped.', 'the answer still rides the DTO for triage')
      assert.equal(delivered.length, 1, 'a failed-to-persist background run still reports to the parent')
      assert.equal(delivered[0].status, 'failed')
      const reread = runtime.readChildRuns(finished.sessionPath)
      assert.equal(reread.length, 1, 'only the start entry survived')
      assert.equal(reread[0].result, null, 'a reopened child reads the run as interrupted, not completed')
      assert.equal(leases.size, 0)
    }

    // --- 7b) Turn limit: a designed end reports its answer and still notifies ---
    {
      let steers = 0
      let aborts = 0
      const session = fakeSession({
        isIdle: false,
        getLastAssistantText: () => 'wrapped up within the limit',
        steer: () => { steers++ },
        abort: async () => { aborts++ },
        prompt: async () => {
          session.emit({ type: 'message_end', message: { role: 'assistant', content: [], timestamp: 1, stopReason: 'stop' } })
          session.emit({ type: 'message_end', message: { role: 'assistant', content: [], timestamp: 2, stopReason: 'aborted' } })
          // The runtime keeps the child alive until it is idle again.
          session.isIdle = true
          session.messages = [{ role: 'assistant', content: [], timestamp: 2, stopReason: 'aborted' }]
        }
      })
      const runtime = new SubagentRuntime(makeHost(session))
      const state = new SubagentParentState('parent-session')
      const delivered = []
      state.notifications = { complete: (finished) => delivered.push(finished), drop: () => {}, canStart: true }
      userMaxTurns = 1
      const { completion } = await runtime.start(state, baseRequest({ maxTurns: 200, runInBackground: true }))
      const finished = await completion
      userMaxTurns = null
      childPaths.push(finished.sessionPath)
      assert.equal(steers, 1, 'the child is told to wrap up at the limit')
      assert.equal(aborts, 1, 'the runtime ends the run one round later')
      assert.equal(finished.status, 'completed', 'a limit-ended run is not a user stop')
      assert.equal(finished.limitReached, true)
      assert.equal(finished.result, 'wrapped up within the limit')
      assert.equal(delivered.length, 1, 'a limit-ended background run still wakes its parent')
      assert.equal(delivered[0].limitReached, true)
      assert.equal(leases.size, 0)
    }

    // --- 8) A missing child file degrades to the parent's own evidence ---
    {
      const runtime = new SubagentRuntime(makeHost(fakeSession()))
      parent.appendMessage({ role: 'assistant', content: [{ type: 'toolCall', id: 'agent-call-2', name: 'agent', arguments: { subagent_type: 'explore' } }], timestamp: 20 })
      parent.appendMessage({ role: 'toolResult', toolCallId: 'agent-call-2', toolName: 'agent', isError: false, content: [{ type: 'text', text: 'ok' }], timestamp: 21,
        details: { kind: 'pi-app-subagent', subagent: { writtenFiles: [{ filePath: join(dir, 'from-parent.ts'), displayPath: 'from-parent.ts' }] } } })
      const readable = await runtime.collectSubagentWritePaths(parent, dir, null, sessionsDir)
      assert.ok(readable.includes(join(dir, 'src', 'a.ts')), 'readable children still contribute their branch writes')
      for (const path of childPaths) await rm(path, { force: true })
      // Deleting a child file must not make the whole rewind scan fail (it used
      // to throw): the parent's own records are the surviving evidence.
      const degraded = await runtime.collectSubagentWritePaths(parent, dir, null, sessionsDir)
      assert.ok(degraded.includes(join(dir, 'from-parent.ts')), 'parent-branch evidence survives a deleted child file')
      assert.ok(!degraded.includes(join(dir, 'src', 'a.ts')), 'the unreadable child no longer contributes')
      // The integrity check is unaffected by the degraded child scan.
      await assert.rejects(() => runtime.collectSubagentWritePaths(parent, dir, 'missing-entry', sessionsDir), /lost its checkpoint anchor/)
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

console.log('check-subagents: runtime integration assertions passed')
