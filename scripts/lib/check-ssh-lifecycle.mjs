/** SSH ownership crosses real scheduled SDK turns and Rewind transactions. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createPlanFixture } from './plan-fixture.mjs'

const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const until = async (predicate, label) => {
  const deadline = Date.now() + 15000
  while (!await predicate()) { assert(Date.now() < deadline, label); await pause(20) }
}
const value = reply => { assert(!reply.error, JSON.stringify(reply)); return reply.value }
const toolData = reply => { assert(!reply.isError, JSON.stringify(reply)); return JSON.parse(reply.content[0].text) }
const exists = async path => readFile(path).then(() => true, () => false)

export async function checkSshLifecycle(remote, options, directory) {
  const f = await createPlanFixture({ withRewind: true })
  const { app, managed, session, manager } = f
  const connectOptions = { ...options, autoReconnect: false }
  try {
    await managed.lifecyclePromise
    await managed.rewind.idle()
    const file = join(f.project, 'file.txt')
    await writeFile(file, 'BEFORE\n')
    f.setRespond(n => n === 1
      ? [{ type: 'toolCall', id: 'rewind-write', name: 'write', arguments: { path: 'file.txt', content: 'AFTER\n' } }]
      : [{ type: 'text', text: 'Local edit complete' }])
    await session.prompt('Edit the checkpointed local file')
    await managed.rewind.idle()
    const checkpoint = value(await app.rewindList(managed.path)).checkpoints[0]
    assert(checkpoint)
    const preview = value(await app.rewindPreview(managed.path, checkpoint.id))
    const beforeLeaf = manager.getLeafId()
    const connect = session.agent.state.tools.find(t => t.name === 'ssh_connect')
    const connected = toolData(await connect.execute('rewind-ssh', connectOptions)).session
    await until(async () => (await app.sshOutput({ sessionPath: managed.path, id: connected.id })).screen.includes('fixture>'), 'Rewind remote shell ready')
    const restore = mode => app.rewindRestore({ sessionPath: managed.path, token: preview.token, mode, operationId: randomUUID() })
    const assertBlocked = async label => {
      const list = value(await app.rewindList(managed.path))
      assert.equal(list.busy, true, label)
      assert.equal(list.busyReason, 'work', label)
      for (const mode of ['files', 'conversation', 'all']) {
        assert.equal((await restore(mode)).error?.code, 'busy', label + ': ' + mode)
        assert.equal(await readFile(file, 'utf8'), 'AFTER\n', 'blocked restore leaves file bytes intact')
        assert.equal(manager.getLeafId(), beforeLeaf, 'blocked restore leaves branch intact')
      }
    }
    await assertBlocked('connected SSH blocks actual restore submission')
    remote.drop()
    await until(() => app.listSshSessions().find(s => s.id === connected.id).status === 'disconnected', 'SSH disconnected without retry')
    await assertBlocked('disconnected tmux work still blocks restore')
    valuePanel(await app.sshPanelAction({ action: 'reconnect', sessionPath: managed.path, id: connected.id }))
    await until(async () => (await app.sshOutput({ sessionPath: managed.path, id: connected.id })).screen.includes('fixture>'), 'tmux reattached before cleanup')
    const closing = app.sshPanelAction({ action: 'close', sessionPath: managed.path, id: connected.id, terminateRemote: true })
    assert.equal((await restore('files')).error?.code, 'busy', 'cleanup in flight remains a restore blocker')
    assert.equal(valuePanel(await closing).remoteTerminated, true)

    // A connection admitted while the restore waits for its recorder must be
    // caught again inside the exclusive transaction, before any mutation.
    const originalIdle = managed.rewind.idle.bind(managed.rewind)
    let raced
    managed.rewind.idle = async () => {
      await originalIdle()
      raced = toolData(await connect.execute('rewind-racing-ssh', connectOptions)).session
    }
    try { assert.equal((await restore('all')).error?.code, 'busy', 'restore rechecks ownership after async preparation') }
    finally { managed.rewind.idle = originalIdle }
    assert.equal(await readFile(file, 'utf8'), 'AFTER\n')
    assert.equal(manager.getLeafId(), beforeLeaf)
    valuePanel(await app.sshPanelAction({ action: 'close', sessionPath: managed.path, id: raced.id, terminateRemote: true }))

    const authBefore = remote.auth.length, ownersBefore = app.listSshSessions().length
    await app.checkoutCoordinator.withExclusive(f.project, 'restore', async () => {
      const denied = await connect.execute('ssh-during-restore', connectOptions)
      assert.equal(denied.isError, true, 'held SSH tool cannot start in the restore window')
    })
    assert.equal(remote.auth.length, authBefore, 'restore admission fails before authentication')
    assert.equal(app.listSshSessions().length, ownersBefore, 'restore admission creates no remote owner')
    const committed = value(await restore('files'))
    assert.equal(committed.operation.status, 'committed')
    assert.equal(await readFile(file, 'utf8'), 'BEFORE\n', 'closing SSH releases the normal restore path')
    assert.equal(manager.getLeafId(), beforeLeaf, 'files-only restore retains the conversation')
    console.log('PASS: Rewind submissions refuse connected, disconnected, closing and racing SSH owners; restore windows reject new SSH and closed owners release restoration.')

    const startRun = label => {
      const started = join(directory, label + '-started'), release = join(directory, label + '-release'), finished = join(directory, label + '-finished')
      const prefix = 'scheduled-' + label
      f.setRespond((n, context) => {
        const result = id => context.messages.find(m => m.role === 'toolResult' && m.toolCallId === id)
        const login = result(prefix + '-connect')
        if (!login) return [{ type: 'toolCall', id: prefix + '-connect', name: 'ssh_connect', arguments: connectOptions }]
        assert.equal(login.isError, false, JSON.stringify(login))
        const ssh = JSON.parse(login.content[0].text).session
        const reads = context.messages.filter(m => m.role === 'toolResult' && m.toolCallId.startsWith(prefix + '-read-'))
        if (!reads.some(r => JSON.parse(r.content[0].text).screen?.includes('fixture>'))) return [{
          type: 'toolCall', id: prefix + '-read-' + n, name: 'ssh_session',
          arguments: { request: { action: 'read', id: ssh.id, waitMs: 100, cursor: reads.length ? JSON.parse(reads.at(-1).content[0].text).cursor : 0 } }
        }]
        if (!result(prefix + '-write')) return [{ type: 'toolCall', id: prefix + '-write', name: 'ssh_session', arguments: { request: {
          action: 'write', id: ssh.id, generation: ssh.generation,
          data: `printf STARTED > '${started}'; while [ ! -f '${release}' ]; do sleep 0.02; done; printf FINISHED > '${finished}'\r`
        } } }]
        return [{ type: 'text', text: 'Scheduled remote work dispatched' }]
      })
      const controller = new AbortController()
      let returned = false
      const result = app.runScheduledTurn(managed, { name: label, prompt: 'Start the remote fixture job' }, { signal: controller.signal, onWaiting: async () => {} })
      // Attach handlers immediately so a deliberately aborted run cannot create
      // an unhandled rejection while the assertions inspect remote cleanup.
      void result.then(() => { returned = true }, () => { returned = true })
      return { result, controller, started, release, finished, returned: () => returned }
    }
    const liveOwner = () => app.listSshSessions().find(s => s.sessionPath === managed.path && s.status !== 'closed')
    const successful = startRun('ssh-drain')
    await until(async () => session.isIdle && await exists(successful.started), 'scheduled prompt settled while remote work remains')
    await pause(100)
    assert.equal(successful.returned(), false, 'scheduled completion waits for owned SSH after the final reply')
    const scheduledSsh = liveOwner()
    assert(scheduledSsh)
    remote.drop()
    await until(() => liveOwner()?.status === 'disconnected', 'scheduled remote owner disconnected')
    await pause(100)
    assert.equal(successful.returned(), false, 'disconnected tmux ownership also delays the outcome')
    valuePanel(await app.sshPanelAction({ action: 'reconnect', sessionPath: managed.path, id: scheduledSsh.id }))
    await until(async () => (await app.sshOutput({ sessionPath: managed.path, id: scheduledSsh.id })).screen.length > 0, 'scheduled tmux reattachment')
    valuePanel(await app.sshPanelAction({ action: 'close', sessionPath: managed.path, id: scheduledSsh.id, terminateRemote: true }))
    assert.equal((await successful.result).summary, 'Scheduled remote work dispatched')
    assert(!liveOwner(), 'successful scheduled outcome has no live remote owners')

    const cancelled = startRun('ssh-cancel')
    await until(async () => session.isIdle && await exists(cancelled.started), 'remote job started before cancellation')
    const cancelledSsh = liveOwner()
    assert(cancelledSsh)
    cancelled.controller.abort()
    await assert.rejects(cancelled.result, error => error.name === 'AbortError')
    assert.equal(app.listSshSessions().find(s => s.id === cancelledSsh.id).status, 'closed')
    assert.equal(app.listSshSessions().find(s => s.id === cancelledSsh.id).remoteTerminated, true, 'cancel waits for acknowledged remote termination')
    assert.equal(managed.notifications.canStart, false, 'cancellation closes new-work/reconnect admission')
    assert.equal((await connect.execute('late-scheduled-ssh', connectOptions)).isError, true, 'late held calls cannot reopen cancelled work')
    await writeFile(cancelled.release, 'release\n')
    await pause(150)
    assert.equal(await exists(cancelled.finished), false, 'cancelled remote job cannot execute its later side effect')
    console.log('PASS: existing-session scheduled runs drain SSH, retain disconnected ownership and close remote tmux/admission on cancellation before publishing an outcome.')
  } finally { await f.close() }
}

function valuePanel(reply) { assert(!reply.error, JSON.stringify(reply)); return reply.session }
