import { randomUUID } from 'node:crypto'
import type {
  DebugBreakpointDTO,
  DebugControlResultDTO,
  DebugOutputPageDTO,
  DebugScopeDTO,
  DebugSessionDTO,
  DebugStackFrameDTO,
  DebugThreadDTO,
  DebugVariableDTO
} from '../../shared/types'
import { DapClient } from './dap-client'
import { debugAdapterSpec } from './adapters'

/**
 * Owns DAP sessions: the lifecycle state machine, a bounded output ring, and
 * the blocking-step contract. P0 admits one live session per chat; the tool
 * surfaces that as an explicit error so the model stops the old one first.
 *
 * State machine: starting → running ⇄ stopped → terminated | failed.
 * `starting` covers the DAP handshake (initialize → launch/attach →
 * configurationDone). Breakpoints submitted before the adapter's `initialized`
 * event are buffered and flushed before `configurationDone`.
 */

const TAIL_CHARS = 64 * 1024
const OUTPUT_PAGE_MAX_CHARS = 65_536
const DEFAULT_CONTROL_WAIT_MS = 10_000
const MAX_CONTROL_WAIT_MS = 120_000
const STACK_LEVELS_DEFAULT = 20
const STACK_LEVELS_MAX = 100
const VARIABLES_MAX_ITEMS = 50
const VALUE_MAX_CHARS = 256
const EVALUATE_MAX_CHARS = 2048
const HANDSHAKE_TIMEOUT_MS = 15_000

export interface DebugStartOptions {
  sessionId: string
  sessionPath: string
  cwd: string
  adapterId: string
  kind: 'launch' | 'attach'
  program?: string
  args?: string[]
  env?: Record<string, string>
  stopOnEntry?: boolean
  pid?: number
  /** Answers the adapter's runInTerminal reverse request with a sidebar
   * terminal tab. Absent handler means the capability is not advertised. */
  runInTerminal?: (input: { title: string; cwd: string; args: string[]; env?: Record<string, string | null> }) => Promise<{ shellProcessId: number; terminalId: string }>
}

interface StoppedWaiter {
  resolve: () => void
  timer: ReturnType<typeof setTimeout>
}

interface Session {
  dto: DebugSessionDTO
  client?: DapClient
  outputTail: string
  /** Buffered setBreakpoints calls made before `initialized`. */
  pendingBreakpoints: { file: string; lines: number[]; resolve: (breakpoints: DebugBreakpointDTO[]) => void; reject: (error: Error) => void }[]
  breakpoints: DebugBreakpointDTO[]
  configurationReady: boolean
  waiters: StoppedWaiter[]
  progressTimer?: ReturnType<typeof setTimeout>
  finishing: boolean
  done: Promise<void>
  resolveDone: () => void
}

const truncate = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max)}…` : text

const asString = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined
const asNumber = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined
const asBoolean = (value: unknown): boolean | undefined => typeof value === 'boolean' ? value : undefined

export class DebugManager {
  private sessions = new Map<string, Session>()

  constructor(private changed: (dto: DebugSessionDTO) => void) {}

  list(sessionPath: string): DebugSessionDTO[] {
    return [...this.sessions.values()]
      .filter((session) => session.dto.sessionPath === sessionPath)
      .map((session) => ({ ...session.dto }))
      .sort((a, b) => a.startedAt - b.startedAt)
  }

  private owned(sessionPath: string, id?: string): Session {
    const candidates = [...this.sessions.values()].filter((session) =>
      session.dto.sessionPath === sessionPath && (id === undefined || session.dto.id === id))
    const session = candidates[0]
    if (!session) throw new Error('No debug session in this chat. Start one first.')
    return session
  }

  get(sessionPath: string, id?: string): DebugSessionDTO {
    return { ...this.owned(sessionPath, id).dto }
  }

  private live(sessionPath: string): Session | undefined {
    return [...this.sessions.values()].find((session) =>
      session.dto.sessionPath === sessionPath &&
      (session.dto.status === 'starting' || session.dto.status === 'running' || session.dto.status === 'stopped'))
  }

  async start(options: DebugStartOptions): Promise<DebugSessionDTO> {
    const existing = this.live(options.sessionPath)
    if (existing) {
      throw new Error(`A debug session is already active (${existing.dto.adapterLabel}, status ${existing.dto.status}). Stop it first with action="stop".`)
    }
    const spec = debugAdapterSpec(options.cwd, options.adapterId)
    if (!spec) throw new Error(`Unknown debug adapter "${options.adapterId}". Call action="adapters" to list what is available.`)
    if (options.kind === 'launch' && !options.program) throw new Error('program is required for a launch session')
    if (options.kind === 'attach' && options.pid === undefined) throw new Error('pid is required for an attach session')
    const resolved = await spec.detect(options.cwd)
    if (!resolved) throw new Error(`Debug adapter "${spec.label}" is not available: ${spec.unavailableHint}`)

    const id = randomUUID()
    const dto: DebugSessionDTO = {
      id,
      sessionId: options.sessionId,
      sessionPath: options.sessionPath,
      adapterId: spec.id,
      adapterLabel: spec.label,
      kind: options.kind,
      target: options.kind === 'launch' ? options.program! : `pid ${options.pid}`,
      status: 'starting',
      startedAt: Date.now(),
      outputChars: 0,
      revision: 0
    }
    let resolveDone!: () => void
    const session: Session = {
      dto,
      outputTail: '',
      pendingBreakpoints: [],
      breakpoints: [],
      configurationReady: false,
      waiters: [],
      finishing: false,
      done: new Promise<void>((resolve) => { resolveDone = resolve }),
      resolveDone: () => resolveDone()
    }
    this.sessions.set(id, session)
    this.publish(session)

    const client = new DapClient()
    session.client = client
    client.onEvent = (event, body) => this.handleEvent(session, event, body)
    client.onClose = (reason) => {
      if (session.finishing) return
      session.dto.error = session.dto.error ?? `adapter closed (${reason})`
      void this.finish(session, session.dto.status === 'starting' ? 'failed' : 'terminated')
    }
    client.onReverseRequest = async (command, args) => {
      if (command !== 'runInTerminal' || !options.runInTerminal) throw new Error('not supported')
      const argv = Array.isArray(args?.args) ? args.args.filter((item): item is string => typeof item === 'string') : []
      if (argv.length === 0) throw new Error('runInTerminal without args')
      const env = args?.env && typeof args.env === 'object'
        ? Object.fromEntries(Object.entries(args.env as Record<string, unknown>).map(([key, value]) => [key, value === null ? null : String(value)]))
        : undefined
      const answer = await options.runInTerminal({
        title: asString(args?.title) ?? spec.label,
        cwd: asString(args?.cwd) ?? options.cwd,
        args: argv,
        env
      })
      session.dto.terminalId = answer.terminalId
      this.publish(session)
      return { shellProcessId: answer.shellProcessId }
    }

    try {
      await client.start({ command: resolved.command, args: resolved.args, cwd: options.cwd })
      const initialized = this.waitEvent(session, 'initialized', HANDSHAKE_TIMEOUT_MS)
      const body = await client.request('initialize', {
        clientID: 'pith',
        clientName: 'Pith',
        adapterID: spec.id,
        locale: 'en',
        linesStartAt1: true,
        columnsStartAt1: true,
        pathFormat: 'path',
        supportsRunInTerminalRequest: options.runInTerminal !== undefined,
        supportsVariableType: true,
        supportsProgressReporting: false
      })
      client.capabilities = body ?? {}
      if (options.kind === 'launch') {
        await client.request('launch', spec.launchArguments({
          program: options.program!,
          args: options.args ?? [],
          cwd: options.cwd,
          ...(options.env ? { env: options.env } : {}),
          ...(options.stopOnEntry ? { stopOnEntry: true } : {})
        }))
      } else {
        await client.request('attach', spec.attachArguments({ pid: options.pid }))
      }
      await initialized
      session.configurationReady = true
      // Buffered breakpoints land before configurationDone so the adapter
      // binds them before the debuggee runs.
      const pending = session.pendingBreakpoints.splice(0)
      for (const entry of pending) {
        await this.sendBreakpoints(session, entry.file, entry.lines).then(entry.resolve, entry.reject)
      }
      if (client.capabilities.supportsConfigurationDoneRequest !== false) {
        await client.request('configurationDone').catch(() => undefined)
      }
      if (!session.finishing) {
        session.dto.status = 'running'
        this.publish(session)
      }
      return { ...session.dto }
    } catch (error) {
      session.dto.error = error instanceof Error ? error.message : String(error)
      const stderr = client.stderrText.trim()
      if (stderr) session.dto.error += `\nadapter stderr: ${truncate(stderr, 500)}`
      await this.finish(session, 'failed')
      throw new Error(session.dto.error)
    }
  }

  /** Breakpoints replace the file's current set (DAP setBreakpoints semantics). */
  async setBreakpoints(sessionPath: string, file: string, lines: number[], id?: string): Promise<DebugBreakpointDTO[]> {
    const session = this.owned(sessionPath, id)
    if (session.finishing) throw new Error('The debug session has ended')
    if (!session.configurationReady) {
      return new Promise((resolve, reject) => {
        session.pendingBreakpoints.push({ file, lines, resolve, reject })
      })
    }
    return this.sendBreakpoints(session, file, lines)
  }

  private async sendBreakpoints(session: Session, file: string, lines: number[]): Promise<DebugBreakpointDTO[]> {
    const client = session.client
    if (!client?.isOpen) throw new Error('Debug adapter is not connected')
    const body = await client.request('setBreakpoints', {
      source: { path: file },
      breakpoints: lines.map((line) => ({ line }))
    })
    const verified = Array.isArray(body?.breakpoints) ? body.breakpoints : []
    const mapped: DebugBreakpointDTO[] = verified.map((item, index) => {
      const record = item as Record<string, unknown>
      const source = record.source as Record<string, unknown> | undefined
      return {
        ...(asNumber(record.id) !== undefined ? { id: asNumber(record.id) } : {}),
        file: asString(source?.path) ?? file,
        line: asNumber(record.line) ?? lines[index] ?? 0,
        verified: asBoolean(record.verified) ?? false,
        ...(asString(record.message) ? { message: asString(record.message) } : {})
      }
    })
    session.breakpoints = [...session.breakpoints.filter((bp) => bp.file !== file), ...mapped]
    return mapped
  }

  async breakpoints(sessionPath: string, id?: string): Promise<DebugBreakpointDTO[]> {
    return [...this.owned(sessionPath, id).breakpoints]
  }

  /** Blocking step: sends the control request and waits for the next stop
   * (or termination) within waitMs. The result always carries the live DTO. */
  async control(sessionPath: string, action: 'continue' | 'pause' | 'next' | 'stepIn' | 'stepOut', threadId?: number, waitMs?: number, id?: string): Promise<DebugControlResultDTO> {
    const session = this.owned(sessionPath, id)
    const dto = session.dto
    if (dto.status === 'terminated' || dto.status === 'failed') return { session: { ...dto }, settled: true }
    if (dto.status === 'starting') throw new Error('The debug session is still starting; try again shortly')
    const client = session.client
    if (!client?.isOpen) throw new Error('Debug adapter is not connected')
    const budget = Math.max(500, Math.min(MAX_CONTROL_WAIT_MS, Math.floor(waitMs ?? DEFAULT_CONTROL_WAIT_MS)))
    const thread = threadId ?? dto.activeThreadId
    if (thread === undefined) throw new Error('No thread to control; call action="threads" first')

    if (action === 'pause') {
      if (dto.status !== 'running') return { session: { ...dto }, settled: true }
      await client.request('pause', { threadId: thread })
    } else {
      if (dto.status !== 'stopped') throw new Error(`Cannot ${action} while the debuggee is ${dto.status}; pause it first`)
      const command = action === 'continue' ? 'continue' : action
      await client.request(command, { threadId: thread })
      if (dto.status === 'stopped') {
        // Some adapters answer without a `continued` event.
        dto.status = 'running'
        dto.stopReason = undefined
        dto.location = undefined
        this.publish(session)
      }
    }

    const settled = await this.waitStopped(session, budget)
    return { session: { ...session.dto }, settled }
  }

  async threads(sessionPath: string, id?: string): Promise<DebugThreadDTO[]> {
    const session = this.owned(sessionPath, id)
    const body = await session.client!.request('threads')
    const list = Array.isArray(body?.threads) ? body.threads : []
    return list.map((item) => {
      const record = item as Record<string, unknown>
      return { id: asNumber(record.id) ?? 0, name: asString(record.name) ?? `thread ${record.id}` }
    })
  }

  async stack(sessionPath: string, threadId: number, levels?: number, id?: string): Promise<DebugStackFrameDTO[]> {
    const session = this.requireStopped(id, sessionPath)
    const cap = Math.max(1, Math.min(STACK_LEVELS_MAX, Math.floor(levels ?? STACK_LEVELS_DEFAULT)))
    const body = await session.client!.request('stackTrace', { threadId, startFrame: 0, levels: cap })
    const frames = Array.isArray(body?.stackFrames) ? body.stackFrames : []
    return frames.map((item) => this.mapFrame(item as Record<string, unknown>))
  }

  async scopes(sessionPath: string, frameId: number, id?: string): Promise<DebugScopeDTO[]> {
    const session = this.requireStopped(id, sessionPath)
    const body = await session.client!.request('scopes', { frameId })
    const scopes = Array.isArray(body?.scopes) ? body.scopes : []
    return scopes.map((item) => {
      const record = item as Record<string, unknown>
      return {
        name: asString(record.name) ?? 'scope',
        variablesReference: asNumber(record.variablesReference) ?? 0,
        ...(asBoolean(record.expensive) ? { expensive: true } : {})
      }
    })
  }

  async variables(sessionPath: string, variablesReference: number, id?: string): Promise<DebugVariableDTO[]> {
    const session = this.requireStopped(id, sessionPath)
    if (variablesReference === 0) return []
    const body = await session.client!.request('variables', { variablesReference })
    const list = Array.isArray(body?.variables) ? body.variables : []
    return list.slice(0, VARIABLES_MAX_ITEMS).map((item) => {
      const record = item as Record<string, unknown>
      return {
        name: asString(record.name) ?? '?',
        value: truncate(asString(record.value) ?? '', VALUE_MAX_CHARS),
        ...(asString(record.type) ? { type: asString(record.type) } : {}),
        variablesReference: asNumber(record.variablesReference) ?? 0,
        ...(asNumber(record.namedVariables) ? { namedVariables: asNumber(record.namedVariables) } : {}),
        ...(asNumber(record.indexedVariables) ? { indexedVariables: asNumber(record.indexedVariables) } : {})
      }
    })
  }

  async evaluate(sessionPath: string, expression: string, frameId?: number, id?: string): Promise<{ result: string; type?: string; variablesReference: number }> {
    const session = this.requireStopped(id, sessionPath)
    const body = await session.client!.request('evaluate', {
      expression,
      ...(frameId !== undefined ? { frameId } : {}),
      context: 'repl'
    })
    return {
      result: truncate(asString(body?.result) ?? '', EVALUATE_MAX_CHARS),
      ...(asString(body?.type) ? { type: asString(body?.type) } : {}),
      variablesReference: asNumber(body?.variablesReference) ?? 0
    }
  }

  /** Cursor-paged console output; same contract as bash_task output. */
  output(sessionPath: string, cursor?: number, maxChars = 16_384, id?: string): DebugOutputPageDTO {
    const session = this.owned(sessionPath, id)
    const end = session.dto.outputChars
    if (cursor !== undefined && (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > end)) {
      throw new Error('Invalid output cursor')
    }
    const limit = Math.max(1, Math.min(OUTPUT_PAGE_MAX_CHARS, Math.floor(maxChars)))
    const start = end - session.outputTail.length
    let from = Math.max(start, cursor ?? Math.max(start, end - limit))
    let to = Math.min(end, from + limit)
    const lowSurrogate = (position: number) => {
      const code = session.outputTail.charCodeAt(position - start)
      return code >= 0xdc00 && code <= 0xdfff
    }
    if (lowSurrogate(from)) from++
    if (to < end && lowSurrogate(to)) to--
    if (to <= from && from < end) to = Math.min(end, from + 2)
    return {
      session: { ...session.dto },
      output: session.outputTail.slice(from - start, to - start),
      cursor: to,
      truncated: cursor === undefined ? from > 0 : cursor < from
    }
  }

  async stop(sessionPath: string, id?: string): Promise<DebugSessionDTO> {
    const session = this.owned(sessionPath, id)
    if (session.finishing) return { ...session.dto }
    const client = session.client
    if (client?.isOpen) {
      // Attach detaches; launch terminates the debuggee.
      await client.request('disconnect', { terminateDebuggee: session.dto.kind === 'launch' }, 5000).catch(() => undefined)
    }
    await this.finish(session, 'terminated')
    return { ...session.dto }
  }

  async stopSession(sessionPath: string): Promise<void> {
    for (const session of this.sessions.values()) {
      if (session.dto.sessionPath === sessionPath && !session.finishing) await this.stop(sessionPath, session.dto.id)
    }
  }

  async dispose(): Promise<void> {
    for (const session of [...this.sessions.values()]) {
      if (!session.finishing) await this.stop(session.dto.sessionPath, session.dto.id)
    }
  }

  /* ------------------------------ internals ------------------------------ */

  private requireStopped(id: string | undefined, sessionPath: string): Session {
    const session = this.owned(sessionPath, id)
    if (session.dto.status !== 'stopped') {
      throw new Error(`The debuggee is not stopped (status: ${session.dto.status}); inspect works only at a stop`)
    }
    return session
  }

  private mapFrame(record: Record<string, unknown>): DebugStackFrameDTO {
    const source = record.source as Record<string, unknown> | undefined
    return {
      id: asNumber(record.id) ?? 0,
      name: asString(record.name) ?? '<anonymous>',
      ...(asString(source?.path) ? { file: asString(source?.path) } : {}),
      ...(asNumber(record.line) !== undefined ? { line: asNumber(record.line) } : {}),
      ...(asNumber(record.column) !== undefined ? { column: asNumber(record.column) } : {})
    }
  }

  private handleEvent(session: Session, event: string, body: Record<string, unknown> | undefined): void {
    if (session.finishing) return
    switch (event) {
      case 'initialized':
        break // The handshake's waitEvent listener consumes this.
      case 'stopped':
        session.dto.status = 'stopped'
        session.dto.stopReason = asString(body?.reason) ?? 'stopped'
        if (asNumber(body?.threadId) !== undefined) session.dto.activeThreadId = asNumber(body?.threadId)
        session.dto.location = undefined
        this.fillTopFrame(session)
        this.publish(session)
        this.settleWaiters(session)
        break
      case 'continued':
        session.dto.status = 'running'
        session.dto.stopReason = undefined
        session.dto.location = undefined
        if (asNumber(body?.threadId) !== undefined) session.dto.activeThreadId = asNumber(body?.threadId)
        this.publish(session)
        break
      case 'output': {
        const text = asString(body?.output)
        if (text) {
          const category = asString(body?.category)
          this.append(session, category && category !== 'console' && category !== 'stdout' && category !== 'stderr' ? `[${category}] ${text}` : text)
        }
        break
      }
      case 'terminated':
      case 'exited':
        void this.finish(session, 'terminated')
        break
      default:
        break // thread/module/process events need no state change in P0.
    }
  }

  /** Best-effort top-frame location for the panel and the control snapshot. */
  private fillTopFrame(session: Session): void {
    const threadId = session.dto.activeThreadId
    const client = session.client
    if (threadId === undefined || !client?.isOpen) return
    void client.request('stackTrace', { threadId, startFrame: 0, levels: 1 }).then((body) => {
      const frames = Array.isArray(body?.stackFrames) ? body.stackFrames : []
      const record = frames[0] as Record<string, unknown> | undefined
      if (!record || session.finishing || session.dto.status !== 'stopped') return
      const frame = this.mapFrame(record)
      session.dto.location = {
        file: frame.file ?? frame.name,
        line: frame.line ?? 0,
        ...(frame.column !== undefined ? { column: frame.column } : {}),
        name: frame.name
      }
      this.publish(session)
    }).catch(() => { /* location is best-effort */ })
  }

  private append(session: Session, text: string): void {
    session.outputTail = (session.outputTail + text).slice(-TAIL_CHARS)
    session.dto.outputChars += text.length
    session.dto.lastOutputAt = Date.now()
    session.progressTimer ??= setTimeout(() => {
      session.progressTimer = undefined
      if (!session.finishing) this.publish(session)
    }, 1000)
  }

  private waitEvent(session: Session, name: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const previous = session.client!.onEvent
      const timer = setTimeout(() => {
        session.client!.onEvent = previous
        reject(new Error(`Timed out waiting for the adapter's "${name}" event`))
      }, timeoutMs)
      session.client!.onEvent = (event, body) => {
        previous(event, body)
        if (event === name) {
          clearTimeout(timer)
          session.client!.onEvent = previous
          resolve()
        }
      }
    })
  }

  private waitStopped(session: Session, budgetMs: number): Promise<boolean> {
    if (session.dto.status === 'stopped' || session.finishing) return Promise.resolve(true)
    return new Promise((resolve) => {
      const waiter: StoppedWaiter = {
        resolve: () => resolve(true),
        timer: setTimeout(() => {
          session.waiters = session.waiters.filter((entry) => entry !== waiter)
          resolve(false)
        }, budgetMs)
      }
      session.waiters.push(waiter)
      void session.done.then(() => resolve(true)) // termination settles the wait too
    })
  }

  private settleWaiters(session: Session): void {
    const waiters = session.waiters.splice(0)
    for (const waiter of waiters) {
      clearTimeout(waiter.timer)
      waiter.resolve()
    }
  }

  private publish(session: Session): void {
    session.dto = { ...session.dto, revision: session.dto.revision + 1 }
    this.changed({ ...session.dto })
  }

  private async finish(session: Session, status: 'terminated' | 'failed'): Promise<void> {
    if (session.finishing) return
    session.finishing = true
    clearTimeout(session.progressTimer)
    session.dto.status = status
    session.dto.endedAt = Date.now()
    session.dto.location = undefined
    session.dto.stopReason = undefined
    session.client?.dispose()
    session.client = undefined
    this.settleWaiters(session)
    for (const pending of session.pendingBreakpoints.splice(0)) {
      pending.reject(new Error('The debug session ended before the adapter was ready'))
    }
    this.publish(session)
    session.resolveDone()
    this.prune()
  }

  /** Settled sessions stay queryable (output pages) but bounded: the newest
   * few per app lifetime, mirroring the bash history retention spirit. */
  private prune(): void {
    const settled = [...this.sessions.values()].filter((session) => session.finishing)
      .sort((a, b) => b.dto.startedAt - a.dto.startedAt)
    for (const session of settled.slice(10)) this.sessions.delete(session.dto.id)
  }
}
