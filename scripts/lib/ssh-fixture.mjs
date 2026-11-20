/** Loopback SSH with real PTYs and isolated remote tmux state; never contacts a real server. */
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import ssh2 from 'ssh2'
import pty from 'node-pty'

export const fixturePassword = 'synthetic-ssh-password'
export function hasTmux() { return spawnSync('tmux', ['-V'], { encoding: 'utf8' }).status === 0 }
export async function createSshFixture(directory, { key = ssh2.utils.generateKeyPairSync('ecdsa', { bits: 256 }).private, port = 0 } = {}) {
  const clients = new Set(), processes = new Set()
  // ssh2 1.17's Ed25519 generator drops leading zero public-key bytes.
  // ECDSA avoids malformed random fixture keys; production consumes user files.
  const userKey = ssh2.utils.generateKeyPairSync('ecdsa', { bits: 256 })
  const publicKey = ssh2.utils.parseKey(userKey.public)
  const socketPath = `/tmp/pith_ssh_${randomUUID().slice(0, 16)}`
  const requests = [], auth = [], wires = []
  const faults = { handshakeDrops: 0 }
  const server = new ssh2.Server({ hostKeys: [key] }, client => {
    clients.add(client)
    client.on('error', () => {})
    client.on('close', () => clients.delete(client))
    if (faults.handshakeDrops > 0) { faults.handshakeDrops--; client.end(); return }
    client.on('authentication', ctx => {
      auth.push({ username: ctx.username, method: ctx.method })
      if (ctx.username === 'stall') return
      if (ctx.method === 'password' && ctx.password === fixturePassword && ctx.username === 'fixture') return ctx.accept()
      if (ctx.method === 'publickey' && ctx.key.data.equals(publicKey.getPublicSSH()) &&
        (!ctx.signature || publicKey.verify(ctx.blob, ctx.signature, ctx.hashAlgo))) return ctx.accept()
      ctx.reject(['password', 'publickey'])
    })
    client.on('ready', () => client.on('session', accept => {
      const session = accept()
      let dimensions = { cols: 100, rows: 30 }
      session.on('pty', (accept, _reject, info) => { dimensions = { cols: info.cols, rows: info.rows }; accept() })
      const terminal = (stream, command, args) => {
        const process = pty.spawn(command, args, { ...dimensions, name: 'xterm-256color', cwd: directory,
          env: { ...globalThis.process.env, HOME: directory, TERM: 'xterm-256color', PS1: 'fixture> ', TMUX_TMPDIR: directory } })
        processes.add(process)
        const out = process.onData(data => { if (!stream.destroyed) stream.write(data) })
        process.onExit(({ exitCode }) => { processes.delete(process); if (!stream.destroyed) { stream.exit(exitCode); stream.end() } })
        stream.on('data', data => { wires.push(data.toString('utf8')); process.write(data.toString('utf8')) })
        stream.on('error', () => {})
        stream.on('close', () => { out.dispose(); process.kill() })
        session.on('window-change', (accept, _reject, info) => { process.resize(info.cols, info.rows); accept?.() })
      }
      session.on('shell', accept => { requests.push('shell'); terminal(accept(), '/bin/bash', ['--noprofile', '--norc', '-i']) })
      session.on('exec', (accept, _reject, info) => {
        requests.push(info.command)
        const stream = accept()
        const attach = /^exec tmux -u new-session -A -s '([A-Za-z0-9_-]+)'$/.exec(info.command)
        const kill = /^tmux kill-session -t '=([A-Za-z0-9_-]+)'$/.exec(info.command)
        if (attach) terminal(stream, 'tmux', ['-S', socketPath, '-f', '/dev/null', '-u', 'new-session', '-A', '-s', attach[1], '/bin/bash --noprofile --norc -i'])
        else if (kill) {
          const result = spawnSync('tmux', ['-S', socketPath, 'kill-session', '-t', '=' + kill[1]], { env: { ...process.env, TMUX_TMPDIR: directory } })
          stream.exit(result.status ?? 1); stream.end()
        } else { stream.exit(127); stream.end('unsupported fixture command') }
      })
    }))
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve) })
  return {
    port: server.address().port, key, userKey, clients, requests, auth, wires, faults,
    drop() { for (const client of clients) client.end() },
    async dispose() {
      for (const client of clients) client.end()
      for (const process of processes) { try { process.kill() } catch {} }
      spawnSync('tmux', ['-S', socketPath, 'kill-server'], { env: { ...process.env, TMUX_TMPDIR: directory }, stdio: 'ignore' })
      await new Promise(resolve => server.close(resolve))
    }
  }
}

export const sshFixtureExternal = { name: 'ssh-fixture-dependencies', setup(builder) {
  builder.onResolve({ filter: /^ssh2$|^@xterm\/(headless|addon-serialize)$|^typebox(\/.*)?$|^@earendil-works\/pi-coding-agent$/ }, args => ({ path: createRequire(import.meta.url).resolve(args.path), external: true }))
} }
