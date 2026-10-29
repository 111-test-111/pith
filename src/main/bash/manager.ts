import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createWriteStream, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, type WriteStream } from 'node:fs'
import { join } from 'node:path'
import { open } from 'node:fs/promises'
import { once } from 'node:events'
import { StringDecoder } from 'node:string_decoder'
import type { BashTaskDTO, BashTaskOutputDTO, BashTaskLogOutputDTO, BashTaskStatus } from '../../shared/types'
import { utf8Page } from '../pi/utf8-page'
import type { CheckoutCoordinator } from '../rewind/coordinator'
import { confineShellArgv, runnerFailureMessage, sandboxDenied, sandboxPolicyFor, scrubbedParentEnv } from '../sandbox/broker'
import type { SandboxMode } from '../sandbox/types'

const TAIL_CHARS = 64 * 1024
const LOG_BYTES = 8 * 1024 * 1024
const HISTORY_LIMIT = 200
const RUNNING_LIMIT = 16
const KILL_GRACE_MS = 1500
const MAX_TIMER_MS = 2_147_483_647

import { taskIsLive } from './task-status'

export { taskIsLive }

interface Task {
  releaseCheckout?: () => void
  dto: BashTaskDTO
  tail: string
  child?: ChildProcess
  log?: WriteStream
  logBytes: number
  done: Promise<void>
  resolve: () => void
  killTimer?: ReturnType<typeof setTimeout>
  timeoutTimer?: ReturnType<typeof setTimeout>
  progressTimer?: ReturnType<typeof setTimeout>
  stopReason?: 'cancelled' | 'timed_out'
  finishing: boolean
}

export interface BashLaunch {
  canStart?: () => boolean
  sessionId: string
  sessionPath: string
  toolCallId: string
  command: string
  cwd: string
  shell: string
  args: string[]
  commandTransport?: 'argv' | 'stdin'
  env: NodeJS.ProcessEnv
  timeout?: number
  /** DSH file-sandbox mode for this launch; omitted means unconfined. */
  sandboxMode?: SandboxMode
}

/** Owns processes, bounded output and durable task records; never owns a model run. */
export class BashTaskManager {
  private tasks = new Map<string, Task>()
  private retained = new Set<string>()
  private closing = false

  constructor(
    private directory: string,
    private changed: (task: BashTaskDTO) => void,
    private completed: (task: BashTaskDTO) => void,
    private coordinator?: CheckoutCoordinator
  ) {
    mkdirSync(directory, { recursive: true })
    // A saved PID is not proof of process ownership. Reopening the app never
    // resumes/kills a process by PID or silently re-executes its command.
    for (const name of readdirSync(directory).filter((name) => /^[\da-f-]+\.json$/.test(name))) {
      try {
        const saved = JSON.parse(readFileSync(join(directory, name), 'utf8'))
        const dto = saved.task as BashTaskDTO
        if (!dto || `${dto.id}.json` !== name || typeof dto.sessionPath !== 'string') continue
        dto.logPath = join(directory, `${dto.id}.log`)
        if (taskIsLive(dto)) {
          dto.status = 'interrupted'
          dto.endedAt = Date.now()
          dto.revision += 1
        }
        const task: Task = { dto, tail: String(saved.tail ?? '').slice(-TAIL_CHARS), logBytes: 0,
          done: Promise.resolve(), resolve: () => {}, finishing: true }
        this.tasks.set(dto.id, task)
        this.persist(task)
      } catch { /* Ignore incomplete records; no command is ever replayed. */ }
    }
    this.prune()
  }

  list(sessionPath: string): BashTaskDTO[] {
    return [...this.tasks.values()].filter((task) => task.dto.sessionPath === sessionPath)
      .map((task) => ({ ...task.dto })).sort((a, b) => a.startedAt - b.startedAt)
  }

  private owned(sessionPath: string, id: string): Task {
    const task = this.tasks.get(id)
    if (!task || task.dto.sessionPath !== sessionPath) throw new Error('Unknown task in this session')
    return task
  }

  get(sessionPath: string, id: string): BashTaskDTO { return { ...this.owned(sessionPath, id).dto } }

  output(sessionPath: string, id: string, cursor?: number, maxChars = 16_384): BashTaskOutputDTO {
    const task = this.owned(sessionPath, id)
    const end = task.dto.outputChars
    if (cursor !== undefined && (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > end)) {
      throw new Error('Invalid output cursor')
    }
    const limit = Math.max(1, Math.min(TAIL_CHARS, Math.floor(maxChars)))
    const start = end - task.tail.length
    let from = Math.max(start, cursor ?? Math.max(start, end - limit))
    let to = Math.min(end, from + limit)
    // Cursors are character offsets; never split a UTF-16 surrogate pair.
    const low = (position: number) => {
      const code = task.tail.charCodeAt(position - start)
      return code >= 0xdc00 && code <= 0xdfff
    }
    if (low(from)) from++
    if (to < end && low(to)) to--
    if (to <= from && from < end) to = Math.min(end, from + 2)
    return { task: { ...task.dto }, output: task.tail.slice(from - start, to - start), cursor: to,
      truncated: cursor === undefined ? from > 0 : cursor < from,
      source: 'tail', cursorUnit: 'utf16', startCursor: from,
      hasMore: to < end, eof: to === end && !taskIsLive(task.dto),
      complete: from === 0 && to === end && !taskIsLive(task.dto) }
  }

  async start(options: BashLaunch): Promise<BashTaskDTO> {
    if (this.closing) throw new Error('Command manager is shutting down')
    if ([...this.tasks.values()].filter((task) => taskIsLive(task.dto)).length >= RUNNING_LIMIT) {
      throw new Error(`At most ${RUNNING_LIMIT} commands can run concurrently. Stop or await an existing task.`)
    }
    if (options.timeout !== undefined && (!Number.isFinite(options.timeout) || options.timeout <= 0 || options.timeout * 1000 > MAX_TIMER_MS)) {
      throw new Error('Invalid command timeout')
    }
    const id = randomUUID()
    const releaseCheckout = await this.coordinator?.enter(options.cwd, 'process', options.sessionPath)
    if (this.closing || options.canStart?.() === false) { releaseCheckout?.(); throw new Error('Command cancelled before launch') }
    if ([...this.tasks.values()].filter(task => taskIsLive(task.dto)).length >= RUNNING_LIMIT) { releaseCheckout?.(); throw new Error('Command concurrency limit reached') }
    // Fail closed before a task record exists: a confined mode with no usable
    // runner must not become a "running" task whose command actually ran on the
    // host. The same argv the shell would have received is what gets wrapped.
    // The lease is released on that refusal too: a leaked 'process' lease
    // would fence every future restore and checkpoint snapshot for this cwd.
    let confined: ReturnType<typeof confineShellArgv> = null
    let argv: string[]
    try {
      const innerArgv = options.commandTransport === 'stdin'
        ? [options.shell, ...options.args]
        : [options.shell, ...options.args, options.command]
      confined = options.sandboxMode
        ? confineShellArgv(innerArgv, sandboxPolicyFor(options.sandboxMode, options.cwd))
        : null
      argv = confined?.argv ?? innerArgv
    } catch (error) {
      releaseCheckout?.()
      throw error
    }
    // A confined shell still inherits an environment; ambient credentials are
    // not part of what the file policy granted.
    const env = confined ? scrubbedParentEnv(options.env) : options.env
    let resolve!: () => void
    const task: Task = {
      releaseCheckout,
      dto: { id, sessionId: options.sessionId, sessionPath: options.sessionPath, toolCallId: options.toolCallId,
        command: options.command, cwd: options.cwd, status: 'running', background: false,
        startedAt: Date.now(), outputChars: 0, logPath: join(this.directory, `${id}.log`),
        logTruncated: false, revision: 0, ...(options.sandboxMode ? { sandboxMode: options.sandboxMode } : {}) },
      tail: '', logBytes: 0, done: new Promise<void>((r) => { resolve = r }), resolve: () => resolve(), finishing: false
    }
    this.tasks.set(id, task)
    this.publish(task)
    try {
      const log = createWriteStream(task.dto.logPath, { flags: 'wx', mode: 0o600 })
      task.log = log
      log.on('error', () => {
        task.dto.logTruncated = true
        task.child?.stdout?.resume()
        task.child?.stderr?.resume()
      })
      const child = spawn(argv[0] as string, argv.slice(1), {
        cwd: options.cwd, env, detached: process.platform !== 'win32', windowsHide: true,
        stdio: [options.commandTransport === 'stdin' ? 'pipe' : 'ignore', 'pipe', 'pipe']
      })
      task.child = child
      const stdout = new StringDecoder('utf8')
      const stderr = new StringDecoder('utf8')
      // Bounded stderr copy: the exit is read against the runner's own
      // signatures, which are emitted on stderr and nowhere else.
      let stderrText = ''
      child.stdout?.on('data', (data: Buffer) => this.append(task, stdout.write(data), data))
      child.stderr?.on('data', (data: Buffer) => {
        const text = stderr.write(data)
        if (stderrText.length < 32_768) stderrText += text.slice(0, 32_768 - stderrText.length)
        this.append(task, text, data)
      })
      log.on('drain', () => { child.stdout?.resume(); child.stderr?.resume() })
      child.once('error', (error) => {
        task.dto.error = error.message
        void this.finish(task, 'failed', null, null)
      })
      child.once('exit', (code, signal) => {
        // If the shell exits while a descendant holds a pipe, do not leave a
        // task hung forever on Node's close event. Managed commands must not
        // daemonize themselves; clean up descendants in the owned group.
        const drain = setTimeout(() => {
          this.signalTree(task, true)
          child.stdout?.destroy()
          child.stderr?.destroy()
        }, 250)
        child.once('close', () => clearTimeout(drain))
        if (task.stopReason) this.signalTree(task, true)
      })
      child.once('close', (code, signal) => {
        this.append(task, stdout.end() + stderr.end())
        if (confined) {
          const failure = runnerFailureMessage(code, stderrText, confined.runnerFailureRules)
          if (failure) {
            // The runner broke, so this exit code says nothing about the
            // command — and re-running it on the host is what fail-closed
            // forbids. Report it as an environment failure, not a policy denial.
            task.dto.error = `sandbox runner failed: ${failure}`
          } else if (sandboxDenied(code, stderrText, confined)) {
            task.dto.denied = true
          }
        }
        void this.finish(task, task.stopReason ?? (code === 0 ? 'succeeded' : 'failed'), code, signal)
      })
      if (options.commandTransport === 'stdin') {
        child.stdin?.on('error', () => {})
        child.stdin?.end(options.command)
      }
      if (options.timeout !== undefined) {
        task.timeoutTimer = setTimeout(() => { void this.stop(options.sessionPath, id, 'timed_out') }, options.timeout * 1000)
      }
      // Explicit background mode still reports spawn failures before returning.
      await new Promise<void>((ready) => { child.once('spawn', ready); child.once('error', () => ready()) })
      if (task.dto.error) await task.done
    } catch (error) {
      task.dto.error = error instanceof Error ? error.message : String(error)
      await this.finish(task, 'failed', null, null)
    }
    return { ...task.dto }
  }

  /** Durable prefix, separate from the lossy UTF-16 tail cursor. The owner/id
   * resolves the path; callers cannot use this API to read arbitrary files. */
  async logOutput(sessionPath: string, id: string, byteOffset = 0, maxBytes = 16_384): Promise<BashTaskLogOutputDTO> {
    const task = this.owned(sessionPath, id)
    if (!Number.isSafeInteger(byteOffset) || byteOffset < 0) throw new Error('Invalid log byteOffset')
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 4 || maxBytes > TAIL_CHARS) throw new Error('Invalid log maxBytes (4–65536)')
    // A background spawn can resolve before the log's asynchronous open.
    // Await that file creation only; never await the command or future output.
    if (task.log?.pending && !task.log.destroyed) await once(task.log, 'open')
    const file = await open(task.dto.logPath, 'r')
    try {
      const endedBeforeRead = !taskIsLive(task.dto)
      let { size } = await file.stat()
      if (byteOffset > size) throw new Error('Log byteOffset is beyond availableBytes')
      const buffer = Buffer.alloc(Math.min(maxBytes + 4, size - byteOffset))
      const { bytesRead } = await file.read(buffer, 0, buffer.length, byteOffset)
      const page = utf8Page(buffer.subarray(0, bytesRead), maxBytes)
      const nextByteOffset = byteOffset + page.length
      const ended = !taskIsLive(task.dto)
      // finish() flushes the log before publishing a terminal status. If that
      // happened during the awaits above, the original size may omit the final
      // burst: refresh the now-stable size before promising EOF/completeness.
      if (ended && !endedBeforeRead) size = (await file.stat()).size
      const eof = nextByteOffset === size && ended
      return { task: { ...task.dto }, source: 'log', cursorUnit: 'utf8', output: page.toString('utf8'),
        byteOffset, nextByteOffset, availableBytes: size, hasMore: nextByteOffset < size, eof,
        truncated: task.dto.logTruncated, complete: eof && byteOffset === 0 && !task.dto.logTruncated }
    } finally { await file.close() }
  }

  private append(task: Task, text: string, bytes?: Buffer): void {
    // Decoder end() commonly returns an empty string. Process exit is not an
    // output event, especially for a silent command stopped by the model.
    if (task.finishing || (!text && !bytes?.length)) return
    task.tail = (task.tail + text).slice(-TAIL_CHARS)
    task.dto.outputChars += text.length
    task.dto.lastOutputAt = Date.now()
    if (text && task.log && !task.log.destroyed && !task.dto.logTruncated) {
      // Each pipe has its own decoder. Persist decoded text in merge order so
      // a stdout/stderr interleave cannot split a multibyte character in the log.
      const encoded = Buffer.from(text, 'utf8')
      const page = utf8Page(encoded, LOG_BYTES - task.logBytes)
      const count = page.length
      if (count > 0) {
        task.logBytes += count
        if (!task.log.write(page)) {
          task.child?.stdout?.pause()
          task.child?.stderr?.pause()
        }
      }
      if (count < encoded.length) task.dto.logTruncated = true
    }
    // Only metadata crosses IPC; logs are fetched when a disclosure is open.
    task.progressTimer ??= setTimeout(() => { task.progressTimer = undefined; this.publish(task) }, 1000)
  }

  detach(sessionPath: string, id: string, reason: 'requested' | 'wait_threshold'): BashTaskDTO {
    const task = this.owned(sessionPath, id)
    if (taskIsLive(task.dto)) {
      task.dto.background = true
      task.dto.reason = reason
      this.publish(task)
    }
    return { ...task.dto }
  }

  wait(sessionPath: string, id: string): Promise<void> { return this.owned(sessionPath, id).done }

  /** Undelivered completions must outlive the history retention window. */
  retain(id: string): void { this.retained.add(id) }
  release(id: string): void { this.retained.delete(id); this.prune() }

  async stop(sessionPath: string, id: string, reason: 'cancelled' | 'timed_out' = 'cancelled'): Promise<BashTaskDTO> {
    const task = this.owned(sessionPath, id)
    if (task.finishing) await task.done
    if (!taskIsLive(task.dto)) return { ...task.dto }
    if (!task.stopReason) {
      task.stopReason = reason
      task.dto.status = 'stopping'
      this.publish(task)
      this.signalTree(task, false)
      task.killTimer = setTimeout(() => this.signalTree(task, true), KILL_GRACE_MS)
    }
    await task.done
    return { ...task.dto }
  }

  private signalTree(task: Task, force: boolean): void {
    const pid = task.child?.pid
    if (!pid) return
    if (process.platform === 'win32') {
      const killer = spawn(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
        [...(force ? ['/F'] : []), '/T', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true })
      killer.on('error', () => {})
    } else {
      try { process.kill(-pid, force ? 'SIGKILL' : 'SIGTERM') } catch { /* Group already exited. */ }
    }
  }

  private async finish(task: Task, status: BashTaskStatus, exitCode: number | null, signal: string | null): Promise<void> {
    if (task.finishing) return
    task.finishing = true
    clearTimeout(task.timeoutTimer)
    clearTimeout(task.killTimer)
    clearTimeout(task.progressTimer)
    if (task.log && !task.log.destroyed && !task.log.writableFinished) {
      await new Promise<void>((resolve) => {
        task.log!.once('error', () => resolve())
        task.log!.end(resolve)
      })
    }
    task.dto = { ...task.dto, status, exitCode, signal, endedAt: Date.now() }
    task.releaseCheckout?.(); task.releaseCheckout = undefined
    this.publish(task)
    task.resolve()
    if (task.dto.background) this.completed({ ...task.dto })
    task.child = undefined
    task.log = undefined
    this.prune()
  }

  private persist(task: Task): void {
    const path = join(this.directory, `${task.dto.id}.json`)
    try {
      writeFileSync(`${path}.tmp`, JSON.stringify({ task: task.dto, tail: task.tail }), { mode: 0o600 })
      renameSync(`${path}.tmp`, path)
    } catch { /* Process control remains available if storage becomes unwritable. */ }
  }

  private publish(task: Task): void {
    task.dto = { ...task.dto, revision: task.dto.revision + 1 }
    this.persist(task)
    this.changed({ ...task.dto })
  }

  private prune(): void {
    const settled = [...this.tasks.values()].filter((task) => !taskIsLive(task.dto))
      .sort((a, b) => b.dto.startedAt - a.dto.startedAt)
    for (const task of settled.slice(HISTORY_LIMIT)) {
      if (this.retained.has(task.dto.id)) continue
      this.tasks.delete(task.dto.id)
      for (const suffix of ['json', 'log']) {
        try { rmSync(join(this.directory, `${task.dto.id}.${suffix}`), { force: true }) } catch {}
      }
    }
  }

  async stopSession(sessionPath: string): Promise<void> {
    await Promise.all(this.list(sessionPath).filter(taskIsLive).map((task) => this.stop(sessionPath, task.id)))
  }

  async dispose(): Promise<void> {
    this.closing = true
    await Promise.all([...this.tasks.values()].filter((task) => taskIsLive(task.dto))
      .map((task) => this.stop(task.dto.sessionPath, task.dto.id)))
  }
}
