import { spawn, type IPty } from 'node-pty'
import { userInfo } from 'node:os'
import { basename } from 'node:path'
import type { TerminalCommand, TerminalHostEvent } from '../../shared/types'

// Parsing/PTY reads run outside Electron main. Bound the *entire* path, including
// IPC and xterm's async parser, by ACKing only after xterm has consumed a batch.
const HIGH_WATER = 128 * 1024
const LOW_WATER = 32 * 1024
const BATCH_SIZE = 32 * 1024
const BATCH_DELAY_MS = 4
interface Session {
  closing?: boolean
  killTimer?: ReturnType<typeof setTimeout>
  pty: IPty
  chunks: string[]
  buffered: number
  outstanding: number
  paused: boolean
  timer?: ReturnType<typeof setTimeout>
}
const sessions = new Map<string, Session>()
let disposing = false
const send = (event: TerminalHostEvent): void => process.parentPort?.postMessage(event)

function flush(id: string, session: Session): void {
  clearTimeout(session.timer)
  session.timer = undefined
  if (!session.buffered) return
  const data = session.chunks.join('')
  session.chunks = []
  session.buffered = 0
  send({ type: 'data', id, data })
}

function close(id: string): void {
  const session = sessions.get(id)
  if (!session || session.closing) return
  session.closing = true
  clearTimeout(session.timer)
  if (session.paused) { session.paused = false; session.pty.resume() }
  // Signal the session's process group as well as the shell. ConPTY's kill
  // closes its console and owned processes on Windows.
  if (process.platform !== 'win32') {
    try { process.kill(-session.pty.pid, 'SIGHUP') } catch { /* already exited */ }
  }
  try { session.pty.kill() } catch { /* already exited */ }
  session.killTimer = setTimeout(() => {
    if (process.platform !== 'win32') { try { process.kill(-session.pty.pid, 'SIGKILL') } catch {} }
    try { session.pty.kill('SIGKILL') } catch {}
  }, 250)
}

process.parentPort?.on('message', ({ data }: { data: TerminalCommand }) => {
  if (data.type === 'dispose') {
    disposing = true
    for (const id of sessions.keys()) close(id)
    if (!sessions.size) process.exit(0)
    setTimeout(() => process.exit(0), 750)
    return
  }
  if (data.type === 'create') {
    const { id, cwd, cols, rows } = data.payload
    if (disposing || sessions.has(id)) return
    try {
      const shell = process.platform === 'win32'
        ? process.env.COMSPEC || 'cmd.exe'
        : process.env.SHELL || userInfo().shell || '/bin/sh'
      const env: NodeJS.ProcessEnv = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'Pith' }
      // Don't leak the Electron/Node launcher into commands run in the shell.
      delete env.ELECTRON_RUN_AS_NODE
      delete env.NODE_OPTIONS
      // An outer terminal’s static light/dark hint is stale in our own window.
      // Applications can query the live background through OSC 11 instead.
      delete env.COLORFGBG
      const pty = spawn(shell, process.platform === 'win32' ? [] : ['-l'], {
        name: 'xterm-256color', cols, rows, cwd: cwd!, env
      })
      const session: Session = { pty, chunks: [], buffered: 0, outstanding: 0, paused: false }
      sessions.set(id, session)
      pty.onData((chunk) => {
        if (sessions.get(id) !== session || session.closing) return
        session.chunks.push(chunk)
        session.buffered += chunk.length
        session.outstanding += chunk.length
        if (!session.paused && session.outstanding >= HIGH_WATER) {
          session.paused = true
          pty.pause()
        }
        if (session.buffered >= BATCH_SIZE) flush(id, session)
        else session.timer ??= setTimeout(() => flush(id, session), BATCH_DELAY_MS)
      })
      pty.onExit(({ exitCode, signal }) => {
        if (sessions.get(id) !== session) return
        clearTimeout(session.killTimer)
        if (session.closing && process.platform !== 'win32') { try { process.kill(-pty.pid, 'SIGKILL') } catch {} }
        flush(id, session)
        sessions.delete(id)
        send({ type: 'exit', id, exitCode, signal })
        if (disposing && !sessions.size) process.exit(0)
      })
      send({ type: 'ready', terminal: { id, cwd: cwd!, shell: basename(shell), pid: pty.pid } })
    } catch {
      send({ type: 'error', id, error: 'spawn' })
    }
    return
  }
  const session = sessions.get(data.id)
  if (!session) return
  if (session.closing && data.type !== 'ack') return
  try {
    switch (data.type) {
      case 'input':
        session.pty.write(data.binary ? Buffer.from(data.data, 'binary') : data.data)
        break
      case 'resize': session.pty.resize(data.cols, data.rows); break
      case 'ack':
        session.outstanding = Math.max(0, session.outstanding - data.chars)
        if (session.paused && session.outstanding <= LOW_WATER) {
          session.paused = false
          session.pty.resume()
        }
        break
      case 'close': close(data.id); break
    }
  } catch {
    close(data.id)
    send({ type: 'error', id: data.id, error: 'host' })
  }
})
process.on('exit', () => { for (const id of sessions.keys()) close(id) })
