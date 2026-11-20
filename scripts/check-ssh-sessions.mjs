/** Real SSH password/key authentication, tmux PTYs, transport loss and SDK ownership. */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { createSshFixture, fixturePassword, hasTmux, sshFixtureExternal } from './lib/ssh-fixture.mjs'
import { createPlanFixture } from './lib/plan-fixture.mjs'
import { checkSshLifecycle } from './lib/check-ssh-lifecycle.mjs'
import headless from '@xterm/headless'

const temporary = await mkdtemp(join(tmpdir(), 'pith-ssh-'))
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const until = async (predicate, label, timeout = 15000) => {
  const deadline = Date.now() + timeout
  while (!await predicate()) { assert(Date.now() < deadline, label); await pause(20) }
}
let remote, manager, f
try {
  if (!hasTmux()) { console.log('SKIP: SSH persistence fixture requires tmux on PATH'); process.exitCode = 0 }
  else {
    const outfile = join(temporary, 'ssh.mjs')
    await build({ stdin: { contents: `export { SshSessionManager } from './src/main/ssh/manager'; export { createSshTools } from './src/main/pi/ssh-tools';`, resolveDir: resolve('.') },
      bundle: true, platform: 'node', format: 'esm', outfile, plugins: [sshFixtureExternal] })
    const { SshSessionManager, createSshTools } = await import(pathToFileURL(outfile).href)
    remote = await createSshFixture(temporary)
    const passwordPath = join(temporary, 'credentials.json')
    await writeFile(passwordPath, JSON.stringify({ password: fixturePassword }), { mode: 0o600 })
    const events = [], keysPath = join(temporary, 'known-hosts.json')
    manager = new SshSessionManager(keysPath, event => events.push(event), 20)
    const options = { host: '127.0.0.1', port: remote.port, username: 'fixture', credentialsFile: passwordPath, keepaliveIntervalMs: 1000 }
    const owner = '/fixture/chat-a'
    let allow = true
    const connected = await manager.connect(owner, temporary, options, () => allow)
    assert.equal(connected.status, 'connected')
    assert.equal(connected.persistence, 'tmux')
    assert.match(connected.fingerprint, /^SHA256:/)
    assert.equal(manager.liveCount('/fixture/chat-b'), 0)
    assert.throws(() => manager.status('/fixture/chat-b', connected.id), /Unknown SSH/)
    await assert.rejects(() => manager.output('/fixture/chat-b', connected.id), /Unknown SSH/)
    await until(async () => (await manager.output(owner, connected.id)).screen.includes('fixture>'), 'tmux shell prompt')
    manager.write(owner, connected.id, "export PITH_SSH_STATE=kept; cd /tmp; printf 'READY:'; pwd\r", connected.generation)
    await until(async () => (await manager.output(owner, connected.id)).screen.includes('READY:/tmp'), 'command execution and remote cwd')
    const counter = join(temporary, 'once')
    manager.write(owner, connected.id, `printf 'ONCE\\n' >> '${counter}'; sleep 0.5; printf 'AFTER_DROP_%s\\n' "$PITH_SSH_STATE"\r`, connected.generation)
    await until(async () => { try { return (await readFile(counter, 'utf8')) === 'ONCE\n' } catch { return false } }, 'command started before transport loss')
    remote.drop()
    await until(() => manager.status(owner, connected.id).generation > connected.generation && manager.status(owner, connected.id).status === 'connected', 'automatic transport reconnection')
    await until(async () => (await manager.output(owner, connected.id)).screen.includes('AFTER_DROP_kept'), 'tmux preserves in-flight work and environment')
    assert.equal(await readFile(counter, 'utf8'), 'ONCE\n', 'transport reconnect must never replay a command')
    assert.throws(() => manager.write(owner, connected.id, 'printf STALE\r', connected.generation), /generation changed/)
    const generation = manager.status(owner, connected.id).generation
    assert.equal((await manager.reconnect(owner, connected.id)).generation, generation + 1)
    const resized = manager.resize(owner, connected.id, 92, 26)
    assert.equal(resized.cols, 92); assert.equal(resized.rows, 26)
    await until(async () => (await manager.output(owner, connected.id)).screen.includes('AFTER_DROP_kept'), 'screen after explicit reconnection')
    await pause(1250)
    assert.equal(manager.status(owner, connected.id).status, 'connected', 'SSH keepalive responses must retain an idle connection')
    const cursor = manager.status(owner, connected.id).outputChars
    const waiting = manager.output(owner, connected.id, cursor, 16384, 3000)
    manager.write(owner, connected.id, "printf 'OUTPUT_%s\\n' '中文🙂'\r", manager.status(owner, connected.id).generation)
    assert((await waiting).cursor > cursor, 'read wakes on new output')
    await until(async () => (await manager.output(owner, connected.id)).screen.includes('OUTPUT_中文🙂'), 'Unicode output')
    await assert.rejects(() => manager.output(owner, connected.id, Number.MAX_SAFE_INTEGER), /cursor/)
    await assert.rejects(() => manager.output(owner, connected.id, 0, 1000000), /bounds/)
    const abortRead = new AbortController()
    const idleRead = manager.output(owner, connected.id, manager.status(owner, connected.id).outputChars, 16384, 30000, abortRead.signal)
    abortRead.abort(); await assert.rejects(() => idleRead, /cancelled/)

    // Key authentication uses a local key path, never public secret arguments.
    const keyPath = join(temporary, 'id_ecdsa')
    await writeFile(keyPath, remote.userKey.private, { mode: 0o600 })
    const shell = await manager.connect(owner, temporary, { host: '127.0.0.1', port: remote.port, username: 'fixture', privateKeyPath: keyPath, persistence: 'shell' }, () => allow)
    assert.equal(shell.persistence, 'shell')
    manager.write(owner, shell.id, `export TRANSIENT_STATE=present; printf 'SHELL_%s\\n' "$TRANSIENT_STATE"\r`, shell.generation)
    await until(async () => (await manager.output(owner, shell.id)).screen.includes('SHELL_present'), 'key authentication and interactive shell')
    const fresh = await manager.reconnect(owner, shell.id)
    manager.write(owner, shell.id, "printf 'RESET_%s\\n' " + '"${TRANSIENT_STATE:-empty}"' + '\r', fresh.generation)
    await until(async () => (await manager.output(owner, shell.id)).screen.includes('RESET_empty'), 'explicit shell persistence reports a new shell')
    // The parser is asynchronous: bytes received after a snapshot barrier
    // must remain live deltas, even if they parse before its promise resumes.
    const connection = manager.sessions.get(shell.id)
    await manager.output(owner, shell.id)
    const frontier = manager.status(owner, shell.id).outputChars
    const beforeFrame = '\x1b[2J\x1b[H\x1b[31mBEFORE\x1b[4;8H', afterFrame = '\x1b[32mAFTER'
    manager.append(connection, beforeFrame)
    const capturing = manager.output(owner, shell.id, undefined, 65536, 0, undefined, true)
    manager.append(connection, afterFrame)
    const snapshot = (await capturing).snapshot
    assert(snapshot)
    assert.equal(snapshot.cursor, frontier + beforeFrame.length, 'framebuffer is bound to its parsed frontier, not all received bytes')
    const replay = new headless.Terminal({ cols: snapshot.cols, rows: snapshot.rows, allowProposedApi: true })
    try {
      await new Promise(resolve => replay.write(snapshot.data, resolve))
      assert.equal(replay.buffer.active.cursorX, 7)
      assert.equal(replay.buffer.active.cursorY, 3)
      const later = await manager.output(owner, shell.id, snapshot.cursor)
      assert.equal(later.output, afterFrame)
      await new Promise(resolve => replay.write(later.output, resolve))
      assert.equal(replay.buffer.active.getLine(replay.buffer.active.viewportY + 3).translateToString(true), '       AFTER')
      assert.equal(replay.buffer.active.getLine(replay.buffer.active.viewportY).getCell(0).getFgColor(), 1)
    } finally { replay.dispose() }
    await manager.close(owner, shell.id)

    let reservations = 0
    const tools = createSshTools({ manager, sessionPath: owner, cwd: temporary, canStart: () => allow,
      beginWork: () => { reservations++; return () => reservations-- } })
    const read = await tools[1].execute('read', { request: { action: 'read', id: connected.id } })
    assert.equal(read.structuredContent.ok, true)
    assert.equal(read.structuredContent.data.output, undefined, 'model projection excludes raw ANSI')
    assert.equal(read.structuredContent.data.snapshot, undefined, 'model projection excludes viewer framebuffer snapshots')
    assert.equal(reservations, 0)
    allow = false
    const denied = await tools[1].execute('held', { request: { action: 'write', id: connected.id, generation: manager.status(owner, connected.id).generation, data: 'printf DENIED\r' } })
    assert.equal(denied.isError, true)
    assert.throws(() => manager.write(owner, connected.id, 'printf DENIED\r', manager.status(owner, connected.id).generation), /admission/)
    allow = true
    const cancelled = new AbortController()
    const stalled = manager.connect(owner, temporary, { ...options, username: 'stall' }, () => allow, cancelled.signal)
    await until(() => remote.auth.some(a => a.username === 'stall'), 'stalled login reached authentication')
    cancelled.abort(); await assert.rejects(() => stalled, /cancelled/)
    assert(manager.list(owner).some(s => s.username === 'stall' && s.status === 'closed'))
    const wrongPassword = join(temporary, 'wrong.json')
    await writeFile(wrongPassword, JSON.stringify({ password: 'synthetic-wrong-password' }))
    await assert.rejects(() => manager.connect(owner, temporary, { ...options, credentialsFile: wrongPassword }, () => true), /authentication|authenticate/i)
    const failed = manager.list(owner).find(s => s.status === 'failed')
    const authAttempts = remote.auth.length
    await pause(150)
    assert.equal(remote.auth.length, authAttempts, 'authentication failure never retries automatically')
    await manager.close(owner, failed.id)
    const postLoginCancel = new AbortController(), cancelOwner = '/fixture/cancel-ready'
    const cancelManager = new SshSessionManager(keysPath, event => {
      if (event.type === 'state' && event.session.status === 'connected') postLoginCancel.abort()
    })
    try {
      await assert.rejects(() => cancelManager.connect(cancelOwner, temporary, options, () => true, postLoginCancel.signal), /cancelled/)
      await cancelManager.stopSession(cancelOwner)
      assert.equal(cancelManager.list(cancelOwner)[0].remoteTerminated, true, 'cancel at PTY readiness kills the newly created remote tmux')
    } finally { await cancelManager.dispose() }
    assert(!JSON.stringify(events).includes(fixturePassword), 'credentials never enter metadata/output events')
    assert(!await readFile(keysPath, 'utf8').then(text => text.includes(fixturePassword)), 'host-key storage never contains credentials')
    console.log('PASS: password/key login, real SSH/tmux PTYs, persistent cwd/jobs, keepalive, Unicode/cursors, cancellation, owner/generation isolation and no command replay.')

    // A stalled viewer must not stall remote output or model reads. Resuming
    // delivery reports a cursor gap so the renderer can hydrate a full screen.
    manager.watchViewer(900, true)
    const eventOffset = events.length
    manager.write(owner, connected.id, "for ((i=0;i<12000;i++)); do printf 'FLOOD_%05d_中文🙂\\n' \"$i\"; done; printf 'FLOOD_%s\\n' DONE\r", manager.status(owner, connected.id).generation)
    await until(async () => (await manager.output(owner, connected.id)).screen.includes('FLOOD_DONE'), 'model reads progress while viewer is stalled')
    const page = await manager.output(owner, connected.id, 0, 1024)
    assert(page.truncated && page.hasMore)
    assert(page.startCursor > 0 && page.output.length <= 1024)
    assert(!/[\uD800-\uDBFF]$|^[\uDC00-\uDFFF]/.test(page.output), 'retained cursor pages preserve Unicode pairs')
    const batches = () => events.slice(eventOffset).filter(e => e.type === 'data' && e.id === connected.id)
    assert(batches().reduce((sum, e) => sum + e.data.length, 0) <= 196608, 'unacknowledged viewer output is bounded')
    for (let i = 0; i < 4; i++) manager.ackViewer(900, connected.id, 65536)
    await until(() => batches().at(-1)?.cursor === manager.status(owner, connected.id).outputChars, 'viewer resumes at newest output cursor')
    assert(batches().some((e, i, all) => i > 0 && e.startCursor > all[i - 1].cursor), 'bounded delivery exposes missing history explicitly')
    manager.watchViewer(900, false)
    console.log('PASS: bounded output history and viewer backpressure preserve model progress, Unicode paging and recoverable cursor gaps.')

    // Exercise the actual SDK tool surface, Plan gates and Stop cleanup.
    f = await createPlanFixture()
    await f.managed.lifecyclePromise
    assert(f.session.getActiveToolNames().includes('ssh_connect'))
    assert(f.session.getActiveToolNames().includes('ssh_session'))
    const normalDefinition = f.session.agent.state.tools.find(t => t.name === 'ssh_connect')
    await f.app.setSessionMode({ sessionPath: f.managed.path, mode: 'plan' })
    assert(!f.session.getActiveToolNames().includes('ssh_connect'))
    await assert.rejects(() => normalDefinition.execute('held-plan', options), /Plan|plan|unavailable|admitted/)
    await f.app.setSessionMode({ sessionPath: f.managed.path, mode: 'normal' })
    f.setRespond(n => n === 1 ? [{ type: 'toolCall', id: 'ssh-login', name: 'ssh_connect', arguments: options }] : [{ type: 'text', text: 'SSH connected' }])
    await f.session.prompt('Connect to the loopback SSH fixture')
    const sdkResult = f.session.messages.find(m => m.role === 'toolResult' && m.toolCallId === 'ssh-login')
    assert.equal(sdkResult.isError, false, JSON.stringify(sdkResult))
    const sdkSession = JSON.parse(sdkResult.content[0].text).session
    assert.equal(sdkSession.status, 'connected')
    const blockedPlan = await f.app.setSessionMode({ sessionPath: f.managed.path, mode: 'plan' })
    assert.equal(blockedPlan.ok, false, 'an open remote owner blocks a Plan transition')
    await f.app.reloadSession(f.managed.path)
    assert.equal(f.app.listSshSessions().find(s => s.id === sdkSession.id).generation, sdkSession.generation, 'resource reload retains the same connection')
    f.app.abort()
    await until(() => f.app.listSshSessions().find(s => s.id === sdkSession.id).status === 'closed', 'Stop closes SSH and automatic retries')
    await until(() => f.app.listSshSessions().find(s => s.id === sdkSession.id).remoteTerminated === true, 'Stop acknowledges remote tmux termination')
    assert(!await readFile(f.managed.path, 'utf8').then(text => text.includes(fixturePassword)), 'SDK history retains references, not credential bytes')
    console.log('PASS: production SDK tools, held-call Plan denial, transition ownership, resource reload and Stop.')

    const child = await f.app.createSubagentChildSession({ mode: 'new', cwd: f.project,
      parentSessionPath: f.managed.path, parentSessionId: f.session.sessionId, runId: 'fixture-ssh-child',
      resource: { tools: ['ssh_connect', 'ssh_session'], inheritContext: false } })
    const next = f.requests.length + 1
    f.setRespond(n => n === next ? [{ type: 'toolCall', id: 'child-ssh-login', name: 'ssh_connect', arguments: options }] : [{ type: 'text', text: 'Child SSH connected' }])
    await child.session.prompt('Connect to the loopback SSH fixture')
    const childResult = child.session.messages.find(m => m.role === 'toolResult' && m.toolCallId === 'child-ssh-login')
    assert.equal(childResult.isError, false, JSON.stringify(childResult))
    const childSsh = JSON.parse(childResult.content[0].text).session
    assert.equal(child.isSettled(), false, 'open child SSH work blocks completion')
    assert.equal(f.app.listSshSessions().find(s => s.id === childSsh.id).readOnly, true)
    assert.deepEqual(await f.app.sshPanelAction({ action: 'close', sessionPath: child.path, id: childSsh.id, terminateRemote: true }), { error: 'unavailable' }, 'human child panels cannot mutate SSH')
    const childControl = child.session.agent.state.tools.find(t => t.name === 'ssh_session')
    const childClosed = await childControl.execute('child-close', { request: { action: 'close', id: childSsh.id, terminateRemote: true } })
    assert.equal(childClosed.isError, false)
    assert.equal(child.isSettled(), true, 'completed remote cleanup releases child ownership')
    await child.release()
    console.log('PASS: frozen child SSH grants, read-only human controls and remote-work completion ownership.')

    const beforeStop = remote.auth.length
    const closing = manager.close(owner, connected.id, true)
    assert.equal(manager.liveCount(owner), 1, 'closing remote work remains owned until cleanup acknowledges')
    await manager.stopSession(owner)
    await closing
    assert.equal(manager.liveCount(owner), 0)
    assert.equal(manager.status(owner, connected.id).remoteTerminated, true)
    await pause(120)
    assert.equal(remote.auth.length, beforeStop, 'closed owners never reconnect')
    await checkSshLifecycle(remote, options, temporary)
    // A transient login failure must not mask a subsequent credential error.
    const retryOwner = '/fixture/retry'
    const retry = await manager.connect(retryOwner, temporary, { ...options, persistence: 'shell' }, () => true)
    await writeFile(passwordPath, JSON.stringify({ password: 'synthetic-wrong-password' }))
    remote.faults.handshakeDrops = 1; remote.drop()
    await until(() => manager.status(retryOwner, retry.id).status === 'failed', 'authentication failure stops reconnect after transport failure')
    assert.equal(remote.faults.handshakeDrops, 0)
    const rejectedAttempts = remote.auth.length
    await pause(150)
    assert.equal(remote.auth.length, rejectedAttempts, 'credential rejection ends the retry loop')
    await writeFile(passwordPath, JSON.stringify({ password: fixturePassword }))
    const recovered = await manager.reconnect(retryOwner, retry.id)
    assert.equal(recovered.status, 'connected', 'manual reconnect reloads corrected credentials')
    await rm(passwordPath); remote.drop()
    await until(() => manager.status(retryOwner, retry.id).status === 'failed', 'unavailable credential reference stops reconnect')
    await manager.close(retryOwner, retry.id)
    await writeFile(passwordPath, JSON.stringify({ password: fixturePassword }))
    console.log('PASS: reconnect stops on rejected/missing credentials after a transport failure and reloads corrected credentials.')
    const refusedKey = await manager.connect('/fixture/key', temporary, options, () => true)
    await manager.close('/fixture/key', refusedKey.id, true)
    const port = remote.port
    await remote.dispose(); remote = await createSshFixture(temporary, { port })
    await assert.rejects(() => manager.connect('/fixture/key', temporary, { ...options, port }, () => true), /host key changed/)
    assert.equal(remote.auth.length, 0, 'changed host keys fail before credentials are submitted')
    console.log('PASS: remote termination, bounded idempotent cleanup and host-key rotation refusal.')
  }
} finally {
  await f?.close()
  await manager?.dispose()
  await remote?.dispose()
  await rm(temporary, { recursive: true, force: true })
}
