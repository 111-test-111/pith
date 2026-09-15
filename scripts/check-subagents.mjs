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

    /** Minimal fake AgentSession whose prompt behaviour each test controls. */
    const fakeSession = (over = {}) => ({
      sessionId: 'child-session',
      subscribe: () => () => {},
      prompt: async () => {},
      abort: async () => {},
      steer: () => {},
      isIdle: true,
      messages: [],
      getLastAssistantText: () => undefined,
      getActiveToolNames: () => ['read', 'grep', 'edit', 'write', 'bash', 'todo_write'],
      sessionManager: parent,
      ...over
    })
    const parentSession = fakeSession({ sessionId: 'parent-session', getActiveToolNames: () => ['read', 'grep', 'edit', 'write', 'bash', 'todo_write'] })

    const leases = new Set()
    const emits = []
    const completionsDelivered = []
    let runtimeRef = null
    let stateRef = null
    const makeHost = (childSession) => ({
      isClosing: () => false,
      maxConcurrentSubagents: () => 4,
      subagentsEnabled: () => true,
      commandTasks: () => null,
      acquireRunLease: (_cwd, sessionPath) => { leases.add(sessionPath); return () => leases.delete(sessionPath) },
      createChildSession: async (options) => {
        // Real child file with the real parentSession header link.
        const manager = SessionManager.create(options.cwd, sessionsDir, { parentSession: options.parentSessionPath })
        materialize(manager)
        // The fake session's scripted messages live in the REAL branch too —
        // the runtime extracts written files (and status) from the persisted
        // branch, exactly like a real AgentSession would.
        for (const message of childSession.messages ?? []) manager.appendMessage(message)
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
      const session = fakeSession({ messages: [{ role: 'assistant', timestamp: 1, stopReason: 'error', error: 'provider 500' }] })
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
      let releaseCreate
      let prompted = 0
      const session = fakeSession({ prompt: async () => { prompted++ } })
      const host = makeHost(session)
      const originalCreate = host.createChildSession
      host.createChildSession = async (options) => {
        const handle = await originalCreate(options)
        // The stop lands while the launch is between creation and prompt.
        await runtimeRef.stopAll(stateRef)
        return handle
      }
      const runtime = new SubagentRuntime(host)
      runtimeRef = runtime
      const state = new SubagentParentState('parent-session')
      stateRef = state
      const controller = new AbortController()
      const startPromise = runtime.start(state, baseRequest(), controller.signal)
      // stopAll already ran inside creation: the launch resolves into an
      // ABORTED run instead of a rejection — no prompt may ever start, and
      // the run's own cleanup (lease, release) settles it.
      const { completion } = await startPromise
      const finished = await completion
      assert.equal(finished.status, 'aborted')
      assert.equal(prompted, 0, 'a launch cancelled during creation never prompts')
      assert.equal(leases.size, 0)
      assert.equal(state.countActive(), 0, 'the aborted run leaves no active roster card')
      runtimeRef = null
      stateRef = null
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
      // A FAILED delegation (the parent toolResult above isError: true) must
      // still surface the files its child committed before failing.
      const paths = await runtime.collectSubagentWritePaths(parent, dir, null, sessionsDir)
      assert.deepEqual(paths, [join(dir, 'src', 'a.ts')])
      // A named anchor that is not on the branch fails loudly instead of
      // silently widening the scan to the whole history.
      await assert.rejects(() => runtime.collectSubagentWritePaths(parent, dir, 'missing-entry', sessionsDir), /lost its checkpoint anchor/)
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

console.log('check-subagents: runtime integration assertions passed')
