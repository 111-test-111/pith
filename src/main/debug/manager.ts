import { randomUUID } from 'node:crypto'
import { ToolFailure } from '../pi/tool-result'
import { createServer } from 'node:net'
import { checkoutRoot, type CheckoutCoordinator } from '../rewind/coordinator'
import type {
  DebugBreakpointDTO,
  DebugControlResultDTO,
  DebugOutputPageDTO,
  DebugScopeDTO,
  DebugSessionDTO,
  DebugSessionStatus,
  DebugStackFrameDTO,
  DebugThreadDTO,
  DebugVariableDTO,
  DebugVariablesPageDTO
} from '../../shared/types'
import type { DebugSourceDTO, DebugSourceContentDTO, DebugCapabilitiesDTO, DebugSteppingGranularity, DebugDisassemblyDTO, DebugMemoryDTO, DebugModulesPageDTO, DebugInstructionBreakpointInput, DebugFunctionBreakpointInput, DebugNativeBreakpointsDTO, DebugNativeBreakpointBinding, DebugInstructionBreakpointDTO } from '../../shared/types'
import { DapClient } from './dap-client'
import { debugAdapterSpec, type DebugAdapterSpec } from './adapters'
import { debugCapabilities, debugSource } from './identity'

/**
 * Owns DAP sessions: the lifecycle state machine, a bounded output ring, and
 * the blocking-step contract. Multiple independent targets may share a chat. Every action resolves an
 * explicit target or fails on ambiguity; it never guesses the newest live one.
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
  /** The owning chat's workspace, independent of the debuggee's cwd. */
  workspaceCwd: string
  cwd: string
  adapterId: string
  kind: 'launch' | 'attach' | 'core'
  coreFile?: string
  name?: string
  replacesId?: string
  signal?: AbortSignal
  canStart?: () => boolean
  initialBreakpoints?: Map<string, SourceBreakpoint[]>
  initialFunctionBreakpoints?: DebugFunctionBreakpointInput[]
  program?: string
  args?: string[]
  env?: Record<string, string>
  stopOnEntry?: boolean
  pid?: number
  /** Adapter-specific request keys (e.g. from a launch.json configuration),
   * merged into the launch/attach request after the adapter template. */
  extraArguments?: Record<string, unknown>
  /** Answers the adapter's runInTerminal reverse request with a sidebar
   * terminal tab. Absent handler means the capability is not advertised. */
  runInTerminal?: (input: { title: string; cwd: string; args: string[]; env?: Record<string, string | null>; signal?: AbortSignal }) => Promise<{ shellProcessId: number; terminalId: string; dispose?: () => Promise<void> }>
}

interface StoppedWaiter {
  resolve: () => void
  timer: ReturnType<typeof setTimeout>
}

/** Per-line breakpoint extras, parallel to `lines`: a stop condition, a
 * hit-count condition (e.g. ">=3"), or a logpoint message (logs, never stops).
 * An empty string marks "no extra on this line". */
export interface DebugBreakpointExtras {
  conditions?: string[]
  hitConditions?: string[]
  logMessages?: string[]
}

interface SourceBreakpoint { line: number; condition?: string; hitCondition?: string; logMessage?: string }
interface Session {
  controller: AbortController
  endpoint?: { host: string; port: number }
  requested: Map<string, SourceBreakpoint[]>
  /** Successful edits retained across adapter-owned target replacement. This
   * belongs to one launch tree; per-target binding ids remain in breakpoints. */
  launchBreakpoints?: Map<string, SourceBreakpoint[]>
  breakpointWork: Promise<unknown>
  releaseCheckout?: () => void
  cleanup?: Promise<void>
  stopping?: Promise<DebugSessionDTO>
  controlling?: boolean
  dto: DebugSessionDTO
  client?: DapClient
  outputTail: string
  /** Buffered setBreakpoints calls made before `initialized`. */
  pendingBreakpoints: { file: string; lines: number[]; extras?: DebugBreakpointExtras; resolve: (breakpoints: DebugBreakpointDTO[]) => void; reject: (error: Error) => void }[]
  breakpoints: DebugBreakpointDTO[]
  configurationReady: boolean
  /** Bumped on every stop, so a late top-frame fill cannot overwrite a newer stop's location. */
  stopEpoch: number
  /** In-flight top-frame fill for the current stop. `start()` awaits this so the first snapshot already has location and remapped stopReason. */
  filling?: Promise<void>
  /** The options this session was started with; `restart` re-runs them. */
  startOptions?: DebugStartOptions
  waiters: StoppedWaiter[]
  terminals: Set<() => Promise<void>>
  /** A one-item probe distinguishes adapters that ignore DAP paging. */
  variablePaging: Map<number, boolean>
  sources: Map<number, Record<string, unknown>>
  sourceCache: Map<number, { content: string; mimeType?: string }>
  nativeBreakpoints: DebugNativeBreakpointsDTO
  functionRequests: DebugFunctionBreakpointInput[]
  modulePaging?: boolean
  progressTimer?: ReturnType<typeof setTimeout>
  exitTimer?: ReturnType<typeof setTimeout>
  finishing: boolean
  done: Promise<void>
  resolveDone: () => void
}

const truncate = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max)}…` : text

const asString = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined
const asNumber = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined
const asBoolean = (value: unknown): boolean | undefined => typeof value === 'boolean' ? value : undefined

const LIVE_STATUSES: ReadonlySet<DebugSessionStatus> = new Set(['starting', 'running', 'stopped'])
/** Includes startup reservations as well as connected targets. */
const isLive = (session: Session): boolean => LIVE_STATUSES.has(session.dto.status)

/** DAP reserves 0 for "not expandable", and adapters hand back sentinels for a
 * NULL parent (lldb-dap answers 2^32 and up). Passing one through would chain a
 * caller through expansions that only ever say "<error: parent is NULL>". */
const asVariablesReference = (value: unknown): number => {
  const reference = asNumber(value)
  return reference !== undefined && Number.isInteger(reference) && reference > 0 && reference <= 0xffff_ffff
    ? reference
    : 0
}

export class DebugManager {
  private sessions = new Map<string, Session>()
  private changeWaiters = new Map<string, Set<() => void>>()
  private closing = false

  constructor(private changed: (dto: DebugSessionDTO) => void, private coordinator?: CheckoutCoordinator) {}

  list(sessionPath: string): DebugSessionDTO[] {
    return [...this.sessions.values()]
      .filter((session) => session.dto.sessionPath === sessionPath)
      .map((session) => ({ ...session.dto }))
      .sort((a, b) => a.startedAt - b.startedAt)
  }

  /** Explicit ids are scoped to the owning chat. Id-less calls require one
   * live target, or fall back to the newest retained console once all end. */
  private owned(sessionPath: string, id?: string): Session {
    const ordered = [...this.sessions.values()].reverse()
      .filter((session) => session.dto.sessionPath === sessionPath)
      .sort((a, b) => b.dto.startedAt - a.dto.startedAt)
    if (id !== undefined) {
      const session = ordered.find((entry) => entry.dto.id === id)
      if (!session) throw new ToolFailure('DEBUG_SESSION_NOT_FOUND', `No debug session with id "${id}" in this chat.`)
      return session
    }
    const live = ordered.filter(isLive)
    if (live.length > 1) throw new ToolFailure('DEBUG_TARGET_REQUIRED', 'Multiple debug sessions are active; pass debugId from action="sessions".')
    const session = live[0] ?? ordered[0]
    if (!session) throw new ToolFailure('DEBUG_SESSION_NOT_FOUND', 'No debug session in this chat. Start one first.')
    return session
  }

  get(sessionPath: string, id?: string): DebugSessionDTO {
    return { ...this.owned(sessionPath, id).dto }
  }

  /** Observe a target without sending a DAP control request. Registration and
   * the readiness check are synchronous, so fast stops cannot be missed. */
  async wait(sessionPath: string, id: string, options: { afterRevision?: number; waitMs?: number; until?: 'stopped' | 'changed'; signal?: AbortSignal } = {}) {
    const session = this.owned(sessionPath, id)
    const { afterRevision, signal } = options
    if (afterRevision !== undefined && (!Number.isSafeInteger(afterRevision) || afterRevision < 0 || afterRevision > session.dto.revision)) throw new ToolFailure('INVALID_DEBUG_CURSOR', 'afterRevision must be a revision already observed on this debugId')
    const waitMs = options.waitMs ?? 10_000
    if (!Number.isFinite(waitMs) || waitMs < 0 || waitMs > 60_000) throw new ToolFailure('INVALID_ARGUMENTS', 'waitMs must be between 0 and 60000')
    const baseline = afterRevision ?? session.dto.revision
    const settled = () => !isLive(session) || session.dto.status === 'stopped' && !session.filling
    const ready = () => !isLive(session) || (options.until === 'changed'
      ? session.dto.revision > baseline
      : settled() && (afterRevision === undefined || session.dto.revision > afterRevision))
    let timedOut = false
    await new Promise<void>((resolve, reject) => {
      const listeners = this.changeWaiters.get(id) ?? new Set<() => void>()
      this.changeWaiters.set(id, listeners)
      let timer: ReturnType<typeof setTimeout> | undefined
      const cleanup = () => {
        clearTimeout(timer); signal?.removeEventListener('abort', abort); listeners.delete(check)
        if (!listeners.size) this.changeWaiters.delete(id)
      }
      const check = () => { if (ready()) { cleanup(); resolve() } }
      const abort = () => { cleanup(); reject(new ToolFailure('CANCELLED', 'Debug wait cancelled')) }
      if (signal?.aborted) { abort(); return }
      listeners.add(check); signal?.addEventListener('abort', abort, { once: true })
      timer = setTimeout(() => { timedOut = true; cleanup(); resolve() }, waitMs)
      check()
    })
    return { session: { ...session.dto }, revision: session.dto.revision, changed: session.dto.revision > baseline, settled: settled(), timedOut }
  }

  /** Synchronous registration is the launch reservation. Stop can cancel it
   * during adapter discovery or while waiting for checkout admission. */
  async start(options: DebugStartOptions): Promise<DebugSessionDTO> {
    const spec = debugAdapterSpec(options.cwd, options.adapterId)
    if (!spec) throw new Error(`Unknown debug adapter ${options.adapterId}`)
    if (options.kind === 'attach' && options.pid === undefined) throw new Error('pid is required for attach')
    if (options.kind === 'core' && (spec.id !== 'lldb-dap' || !options.coreFile)) throw new Error('Core inspection requires lldb-dap and coreFile')
    if (options.kind === 'core' && options.extraArguments && Object.keys(options.extraArguments).length) throw new Error('Core inspection does not accept executable adapter commands')
    if (options.kind === 'core' && (options.initialBreakpoints?.size || options.initialFunctionBreakpoints?.length)) throw new Error('Core files cannot have breakpoints')
    const requestArguments = options.kind === 'core'
      ? { coreFile: options.coreFile, ...(options.program ? { program: options.program } : {}) }
      : options.kind === 'launch' ? {
        ...spec.launchArguments({ program: options.program, args: options.args ?? [], cwd: options.cwd, env: options.env, stopOnEntry: options.stopOnEntry }),
        ...(options.extraArguments ?? {}), ...(options.runInTerminal ? {} : { console: 'internalConsole' })
      } : { ...spec.attachArguments({ pid: options.pid }), ...(options.extraArguments ?? {}) }
    if (options.kind === 'launch') spec.validateLaunch(requestArguments)
    return this.startTarget(options, spec, requestArguments)
  }

  private admitted(session: Session): void {
    if (this.closing || session.finishing || session.controller.signal.aborted || session.startOptions?.canStart?.() === false) {
      throw new Error('Debug session cancelled before launch')
    }
  }

  private async startTarget(options: DebugStartOptions, spec: DebugAdapterSpec, requestArguments: Record<string, unknown>, parent?: Session): Promise<DebugSessionDTO> {
    if (this.closing || options.signal?.aborted || options.canStart?.() === false) throw new Error('Debug session cancelled before launch')
    const live = [...this.sessions.values()].filter(isLive)
    if (live.length >= 32 || live.filter(s => s.dto.sessionPath === options.sessionPath).length >= 16) throw new Error('Debug session limit reached (16 per chat, 32 total)')
    let resolveDone!: () => void
    const session: Session = {
      dto: {
        id: randomUUID(), sessionId: options.sessionId, sessionPath: options.sessionPath,
        adapterId: spec.id, adapterLabel: spec.label, kind: options.kind,
        ...(options.name ? { name: options.name } : {}), ...(parent ? { parentId: parent.dto.id } : {}),
        ...(!parent && options.replacesId ? { replacesId: options.replacesId } : {}),
        target: options.kind === 'core' ? options.coreFile! : options.kind === 'attach' ? `pid ${options.pid}` : options.program ?? asString(requestArguments.module) ?? options.name ?? spec.label,
        status: 'starting', startedAt: Date.now(), outputChars: 0, revision: 0, stopId: 0, sourceVersion: 0
      },
      controller: new AbortController(), startOptions: { ...options, signal: undefined },
      requested: new Map(options.initialBreakpoints ?? parent?.launchBreakpoints ?? parent?.requested),
      launchBreakpoints: parent?.launchBreakpoints ?? (spec.childSessions ? new Map(options.initialBreakpoints) : undefined),
      breakpointWork: Promise.resolve(),
      outputTail: '', pendingBreakpoints: [], breakpoints: [], configurationReady: false, stopEpoch: 0,
      waiters: [], terminals: new Set(), variablePaging: new Map(), sources: new Map(), sourceCache: new Map(), nativeBreakpoints: { instruction: [], function: [] }, functionRequests: options.initialFunctionBreakpoints ?? [], finishing: false, done: new Promise<void>(resolve => { resolveDone = resolve }), resolveDone: () => resolveDone()
    }
    this.sessions.set(session.dto.id, session)
    const abort = () => { void this.stop(options.sessionPath, session.dto.id) }
    options.signal?.addEventListener('abort', abort, { once: true })
    this.publish(session)
    const client = new DapClient()
    session.client = client
    client.onEvent = (event, body) => this.handleEvent(session, event, body)
    client.onClose = reason => {
      if (!session.finishing) {
        if (isLive(session)) session.dto.error = `adapter closed (${reason})`
        void this.finish(session, session.dto.status === 'starting' ? 'failed' : 'terminated')
      }
    }
    client.onReverseRequest = async (command, args) => {
      this.admitted(session)
      if (command === 'startDebugging' && spec.childSessions && session.endpoint) {
        const configuration = args?.configuration
        if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration)) throw new Error('Invalid child debug configuration')
        const config = configuration as Record<string, unknown>
        if (typeof config.__pendingTargetId !== 'string' || !config.__pendingTargetId || !['launch', 'attach'].includes(String(args?.request))) throw new Error('Invalid child debug target')
        // The adapter owns this target; never detect/spawn another server.
        await this.startTarget({ ...options, signal: session.controller.signal, kind: args!.request as 'launch' | 'attach', name: asString(config.name), initialBreakpoints: undefined }, spec, config, session)
        return {}
      }
      if (command !== 'runInTerminal' || !options.runInTerminal || options.kind === 'core') throw new Error('not supported')
      const argv = Array.isArray(args?.args) ? args.args.filter((item): item is string => typeof item === 'string') : []
      if (!argv.length) throw new Error('runInTerminal without args')
      const env = args?.env && typeof args.env === 'object'
        ? Object.fromEntries(Object.entries(args.env).map(([key, value]) => [key, value === null ? null : String(value)])) : undefined
      const answer = await options.runInTerminal({ title: asString(args?.title) ?? spec.label, cwd: asString(args?.cwd) ?? options.cwd, args: argv, env, signal: session.controller.signal })
      if (session.finishing) await answer.dispose?.()
      else if (answer.dispose) session.terminals.add(answer.dispose)
      this.admitted(session)
      session.dto.terminalId = answer.terminalId; this.publish(session)
      return { shellProcessId: answer.shellProcessId }
    }
    let launchError: unknown
    try {
      session.releaseCheckout = await this.acquireCheckouts(options, session.controller.signal)
      this.admitted(session)
      if (parent) {
        session.endpoint = parent.endpoint
        await client.connectTcp(session.endpoint!)
      } else {
        const resolved = await spec.detect(options.cwd, session.controller.signal)
        this.admitted(session)
        if (!resolved) throw new Error(`Debug adapter ${spec.label} is not available: ${spec.unavailableHint}`)
        if (spec.listen) {
          const port = spec.listen.port || await availablePort(spec.listen.host)
          this.admitted(session)
          session.endpoint = { host: spec.listen.host, port }
          await client.connectTcp({ ...session.endpoint, ...(spec.listen.spawn ? { spawn: { command: resolved.command, args: resolved.args.map(a => a.replaceAll('${port}', String(port))), cwd: options.cwd } } : {}) })
        } else await client.start({ command: resolved.command, args: resolved.args, cwd: options.cwd })
      }
      this.admitted(session)
      const initialized = client.waitForEvent('initialized', HANDSHAKE_TIMEOUT_MS)
      // Both promises are observed immediately, including early handshake failure.
      void initialized.catch(() => {})
      client.capabilities = await client.request('initialize', {
        clientID: 'pith', clientName: 'Pith', adapterID: spec.id, locale: 'en', linesStartAt1: true, columnsStartAt1: true, pathFormat: 'path',
        supportsRunInTerminalRequest: !!options.runInTerminal && options.kind !== 'core', supportsVariableType: true,
        supportsVariablePaging: true, supportsStartDebuggingRequest: spec.childSessions === true,
        supportsMemoryReferences: true, supportsInvalidatedEvent: true
      }) ?? {}
      session.dto.capabilities = debugCapabilities(client.capabilities)
      this.admitted(session)
      const launching = client.request(options.kind === 'launch' ? 'launch' : 'attach', requestArguments)
      // A launch failure can arrive before initialized. Remember its DAP detail
      // before disposal rejects the event waiter with a generic close error.
      void launching.catch(error => { launchError = error; void client.dispose() })
      await initialized
      this.admitted(session)
      for (const [file, points] of session.requested) await this.sendDefinitions(session, file, points, false)
      if (session.functionRequests.length) await this.sendFunctionBreakpoints(session, session.functionRequests)
      while (session.pendingBreakpoints.length) {
        const entry = session.pendingBreakpoints.shift()!
        await this.sendBreakpoints(session, entry.file, entry.lines, entry.extras).then(entry.resolve, entry.reject)
      }
      session.configurationReady = true
      if (client.capabilities.supportsConfigurationDoneRequest === true) await client.request('configurationDone')
      await launching
      if (session.finishing && session.dto.status === 'terminated' && !session.stopping) {
        await session.cleanup
        return { ...session.dto }
      }
      this.admitted(session)
      if (options.kind === 'core') {
        if (session.dto.activeThreadId === undefined) session.dto.activeThreadId = (await this.threads(options.sessionPath, session.dto.id))[0]?.id
        if (session.dto.status !== 'stopped') this.handleEvent(session, 'stopped', { reason: 'core', threadId: session.dto.activeThreadId })
      } else if (options.stopOnEntry && !(spec.childSessions && !parent) && session.dto.status !== 'stopped') await this.waitStopped(session, HANDSHAKE_TIMEOUT_MS)
      if (session.dto.status === 'stopped') await session.filling
      else if (session.dto.status === 'starting') { session.dto.status = 'running'; this.publish(session) }
      return { ...session.dto }
    } catch (error) {
      const cause = launchError ?? error
      const message = cause instanceof Error ? cause.message : String(cause)
      const stderr = client.stderrText.trim()
      const detail = message + (stderr ? `\nadapter stderr: ${truncate(stderr, 500)}` : '')
      if (!session.stopping && (!session.finishing || session.dto.status === 'failed')) {
        session.dto.error = detail
        this.publish(session)
      }
      if (!session.finishing) await this.finish(session, 'failed')
      await session.cleanup
      throw new Error(detail)
    } finally {
      options.signal?.removeEventListener('abort', abort)
      // A stop may win before an asynchronous lease acquisition returns.
      if (session.finishing) { await session.cleanup; session.releaseCheckout?.(); session.releaseCheckout = undefined }
    }
  }

  /** A launch cwd can be outside the chat's checkout. Fence both identities;
   * cancellation or failure while acquiring the second releases the first. */
  private async acquireCheckouts(options: DebugStartOptions, signal: AbortSignal): Promise<(() => void) | undefined> {
    if (!this.coordinator) return undefined
    const releases: (() => void)[] = []
    const release = () => { for (const done of releases.splice(0)) done() }
    try {
      for (const root of new Set([checkoutRoot(options.workspaceCwd), checkoutRoot(options.cwd)])) {
        releases.push(await this.coordinator.enter(root, 'process', options.sessionPath, signal))
      }
      return release
    } catch (error) {
      release()
      throw error
    }
  }

  /** Breakpoints replace the file's current set (DAP setBreakpoints semantics). */
  async setBreakpoints(sessionPath: string, file: string, lines: number[], extras?: DebugBreakpointExtras, id?: string): Promise<DebugBreakpointDTO[]> {
    const session = this.owned(sessionPath, id)
    if (session.finishing) throw new Error('The debug session has ended')
    if (!session.configurationReady) {
      return new Promise((resolve, reject) => {
        session.pendingBreakpoints.push({ file, lines, ...(extras ? { extras } : {}), resolve, reject })
      })
    }
    return this.serializeBreakpoints(session, () => this.sendBreakpoints(session, file, lines, extras))
  }

  private serializeBreakpoints<T>(session: Session, work: () => Promise<T>): Promise<T> {
    const next = session.breakpointWork.then(work)
    session.breakpointWork = next.catch(() => {})
    return next
  }

  async toggleBreakpoint(sessionPath: string, file: string, line: number, id: string): Promise<DebugBreakpointDTO[]> {
    const session = this.owned(sessionPath, id)
    if (!session.configurationReady) throw new Error('Debug session is still starting')
    return this.serializeBreakpoints(session, async () => {
      const current = session.requested.get(file) ?? []
      const requested = session.breakpoints.find(bp => bp.file === file && bp.line === line)?.requestedLine ?? line
      const points = current.some(bp => bp.line === requested) ? current.filter(bp => bp.line !== requested) : [...current, { line }].sort((a, b) => a.line - b.line)
      return this.sendDefinitions(session, file, points)
    })
  }

  private sendBreakpoints(session: Session, file: string, lines: number[], extras?: DebugBreakpointExtras): Promise<DebugBreakpointDTO[]> {
    return this.sendDefinitions(session, file, lines.map((line, i) => ({ line,
      ...(extras?.conditions?.[i] ? { condition: extras.conditions[i] } : {}),
      ...(extras?.hitConditions?.[i] ? { hitCondition: extras.hitConditions[i] } : {}),
      ...(extras?.logMessages?.[i] ? { logMessage: extras.logMessages[i] } : {})
    })))
  }

  private async sendDefinitions(session: Session, file: string, points: SourceBreakpoint[], remember = true): Promise<DebugBreakpointDTO[]> {
    if (session.dto.kind === 'core') throw new Error('Core files cannot have breakpoints')
    const body = await this.requireLive(session).request('setBreakpoints', { source: { path: file }, breakpoints: points })
    const verified = Array.isArray(body?.breakpoints) ? body.breakpoints : []
    const mapped = points.map((point, index): DebugBreakpointDTO => {
      const record = (verified[index] ?? {}) as Record<string, unknown>
      return { ...point, file, requestedLine: point.line, line: asNumber(record.line) ?? point.line,
        ...(asNumber(record.id) !== undefined ? { id: asNumber(record.id) } : {}), verified: asBoolean(record.verified) ?? false,
        ...(point.condition ? { conditionStatus: 'unvalidated' as const } : {}),
        ...(asString(record.message) ? { message: asString(record.message) } : {}) }
    })
    session.requested.set(file, points.map(point => ({ ...point })))
    // Configuration replay and per-target adapter removal events must not
    // erase a later edit or the launch tree's retained breakpoint intent.
    if (remember) session.launchBreakpoints?.set(file, points.map(point => ({ ...point })))
    session.breakpoints = [...session.breakpoints.filter(bp => bp.file !== file), ...mapped]
    this.publish(session)
    return mapped
  }

  async breakpoints(sessionPath: string, id?: string): Promise<DebugBreakpointDTO[]> {
    return [...this.owned(sessionPath, id).breakpoints]
  }

  /** Blocking step: sends the control request and waits for the next stop
   * (or termination) within waitMs. The result always carries the live DTO. */
  async control(sessionPath: string, action: 'continue' | 'pause' | 'next' | 'stepIn' | 'stepOut', threadId?: number, waitMs?: number, id?: string, stopId?: number, granularity?: DebugSteppingGranularity): Promise<DebugControlResultDTO> {
    const session = this.owned(sessionPath, id)
    const dto = session.dto
    if (granularity !== undefined) {
      if (action === 'continue' || action === 'pause') throw new Error('Stepping granularity is only valid for next/stepIn/stepOut')
      if (!['statement', 'line', 'instruction'].includes(granularity)) throw new Error('Invalid stepping granularity')
      this.requireCapability(session, 'supportsSteppingGranularity')
    }
    if (stopId !== undefined && stopId !== session.stopEpoch) throw new ToolFailure('DEBUG_STALE_STOP', 'Debug stop changed; refresh before controlling the target')
    if (dto.kind === 'core') throw new Error('Core files cannot execute')
    if (session.controlling) throw new Error('A debug control request is already in flight')
    const epoch = session.stopEpoch
    if (dto.status === 'terminated' || dto.status === 'failed') return { session: { ...dto }, settled: true }
    if (dto.status === 'starting') throw new Error('The debug session is still starting; try again shortly')
    const client = session.client
    if (!client?.isOpen) throw new Error('Debug adapter is not connected')
    const budget = Math.max(500, Math.min(MAX_CONTROL_WAIT_MS, Math.floor(waitMs ?? DEFAULT_CONTROL_WAIT_MS)))
    let thread = threadId ?? dto.activeThreadId
    const noThread = (): Error => new Error('No thread to control; pass a threadId from action="threads"')

    if (action === 'pause') {
      if (dto.status !== 'running') return { session: { ...dto }, settled: true }
      // A freshly attached process has never stopped, so no stop event has
      // recorded a current thread yet: interrupt the first one the adapter knows.
      thread ??= (await this.threads(sessionPath, id))[0]?.id
      if (thread === undefined) throw noThread()
      await client.request('pause', { threadId: thread })
    } else {
      if (dto.status !== 'stopped') throw new Error(`Cannot ${action} while the debuggee is ${dto.status}; pause it first`)
      if (thread === undefined) throw noThread()
      const command = action === 'continue' ? 'continue' : action
      session.controlling = true
      try {
        await session.breakpointWork
        this.assertStop(session, epoch)
        await client.request(command, { threadId: thread, ...(granularity ? { granularity } : {}) })
      } finally { session.controlling = false }
      if (session.stopEpoch === epoch && session.dto.status === 'stopped') {
        // Some adapters answer without a `continued` event.
        session.dto.status = 'running'
        this.clearStop(session)
        session.dto.location = undefined
        this.publish(session)
      }
    }

    const settled = await this.waitStopped(session, budget)
    return { session: { ...session.dto }, settled: settled && (session.dto.status === 'stopped' || !isLive(session)) }
  }

  async threads(sessionPath: string, id?: string): Promise<DebugThreadDTO[]> {
    const session = this.owned(sessionPath, id)
    const body = await this.requireLive(session).request('threads')
    const list = Array.isArray(body?.threads) ? body.threads : []
    return list.map((item) => {
      const record = item as Record<string, unknown>
      return { id: asNumber(record.id) ?? 0, name: asString(record.name) ?? `thread ${record.id}` }
    })
  }

  async stack(sessionPath: string, threadId: number, levels?: number, id?: string, stopId?: number): Promise<DebugStackFrameDTO[]> {
    const session = this.requireStopped(id, sessionPath, stopId)
    const epoch = session.stopEpoch
    const cap = Math.max(1, Math.min(STACK_LEVELS_MAX, Math.floor(levels ?? STACK_LEVELS_DEFAULT)))
    const body = await this.requireLive(session).request('stackTrace', { threadId, startFrame: 0, levels: cap })
    this.assertStop(session, epoch)
    const frames = Array.isArray(body?.stackFrames) ? body.stackFrames : []
    return frames.slice(0, cap).map((item) => this.mapFrame(session, item as Record<string, unknown>))
  }

  async scopes(sessionPath: string, frameId: number, id?: string, stopId?: number): Promise<DebugScopeDTO[]> {
    const session = this.requireStopped(id, sessionPath, stopId)
    const epoch = session.stopEpoch
    const body = await this.requireLive(session).request('scopes', { frameId })
    this.assertStop(session, epoch)
    const scopes = Array.isArray(body?.scopes) ? body.scopes : []
    return scopes.map((item) => {
      const record = item as Record<string, unknown>
      return {
        name: asString(record.name) ?? 'scope',
        variablesReference: asVariablesReference(record.variablesReference),
        ...(asString(record.presentationHint) ? { presentationHint: asString(record.presentationHint) } : {}),
        ...(asNumber(record.namedVariables) !== undefined ? { namedVariables: asNumber(record.namedVariables) } : {}),
        ...(asNumber(record.indexedVariables) !== undefined ? { indexedVariables: asNumber(record.indexedVariables) } : {}),
        ...(asBoolean(record.expensive) ? { expensive: true } : {})
      }
    })
  }

  /** One level of a variable's children. Unpaged calls return the first page
   * (VARIABLES_MAX_ITEMS); paged calls map to DAP start/count. `truncated`
   * tells the caller another page exists — detected with a one-row overfetch,
   * since DAP answers carry no total. */
  async variables(sessionPath: string, variablesReference: number, start?: number, count?: number, id?: string, stopId?: number): Promise<DebugVariablesPageDTO> {
    const session = this.requireStopped(id, sessionPath, stopId)
    const epoch = session.stopEpoch
    if (variablesReference === 0) return { variables: [], truncated: false }
    const startIndex = Math.max(0, Math.floor(start ?? 0))
    const wanted = Math.max(1, Math.min(500, Math.floor(count ?? VARIABLES_MAX_ITEMS)))
    const request = async (paging?: { start: number; count: number }): Promise<unknown[]> => {
      const body = await this.requireLive(session).request('variables', { variablesReference, ...paging })
      this.assertStop(session, epoch)
      return Array.isArray(body?.variables) ? body.variables : []
    }
    let paged = session.variablePaging.get(variablesReference)
    if (paged === undefined) {
      // Testing with the requested page's size is ambiguous when the complete
      // list has exactly count+1 entries (e.g. 51). Probe with count=1 instead.
      const probe = await request({ start: 0, count: 1 })
      paged = probe.length === 1
      if (probe.length === 1) {
        const second = await request({ start: 1, count: 1 })
        if (second.length > 1 || JSON.stringify(second) === JSON.stringify(probe)) paged = false
      }
      if (session.variablePaging.size >= 256) session.variablePaging.delete(session.variablePaging.keys().next().value!)
      session.variablePaging.set(variablesReference, paged)
    }
    const list = await request(paged ? { start: startIndex, count: wanted + 1 } : undefined)
    const from = paged ? 0 : startIndex
    return { variables: list.slice(from, from + wanted).map(item => this.mapVariable(item as Record<string, unknown>)), truncated: from + wanted < list.length }
  }

  private mapVariable(record: Record<string, unknown>): DebugVariableDTO {
    return {
      name: asString(record.name) ?? '?',
      value: truncate(asString(record.value) ?? '', VALUE_MAX_CHARS),
      ...(asString(record.memoryReference) ? { memoryReference: asString(record.memoryReference) } : {}),
      ...(asString(record.evaluateName) ? { evaluateName: asString(record.evaluateName) } : {}),
      ...(asString(record.type) ? { type: asString(record.type) } : {}),
      variablesReference: asVariablesReference(record.variablesReference),
      ...(asNumber(record.namedVariables) ? { namedVariables: asNumber(record.namedVariables) } : {}),
      ...(asNumber(record.indexedVariables) ? { indexedVariables: asNumber(record.indexedVariables) } : {})
    }
  }

  async evaluate(sessionPath: string, expression: string, frameId?: number, id?: string, stopId?: number, context: 'repl' | 'watch' = 'repl'): Promise<{ result: string; type?: string; variablesReference: number; memoryReference?: string }> {
    const session = this.requireStopped(id, sessionPath, stopId)
    const epoch = session.stopEpoch
    if (session.dto.kind === 'core') throw new Error('Core inspection exposes stack/scopes/variables, not executable expressions')
    // Some adapters refuse a frame-less evaluate — lldb-dap answers "can't
    // evaluate expressions when the process is running" even at a stop — so
    // default to the top frame of the thread that stopped.
    const frame = frameId ?? await this.topFrameId(session)
    this.assertStop(session, epoch)
    let body: Record<string, unknown> | undefined
    try {
      body = await this.requireLive(session).request('evaluate', {
        expression,
        ...(frame !== undefined ? { frameId: frame } : {}),
        context
      })
    } catch (error) {
      if (frame !== undefined) throw error
      // Frame-less failure reads as a contradiction at a stop; say what to do.
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(`${reason} (no frame to evaluate in — pass a frameId from action="stack")`)
    }
    this.assertStop(session, epoch)
    return {
      result: truncate(asString(body?.result) ?? '', EVALUATE_MAX_CHARS),
      ...(asString(body?.memoryReference) ? { memoryReference: asString(body?.memoryReference) } : {}),
      ...(asString(body?.type) ? { type: asString(body?.type) } : {}),
      variablesReference: asVariablesReference(body?.variablesReference)
    }
  }

  /** Frame to evaluate in when the caller pinned none: the top frame of the
   * thread that stopped. Undefined when the adapter reports no frame. */
  private async topFrameId(session: Session): Promise<number | undefined> {
    const threadId = session.dto.activeThreadId
    if (threadId === undefined) return undefined
    try {
      const body = await this.requireLive(session).request('stackTrace', { threadId, startFrame: 0, levels: 1 })
      const frames = Array.isArray(body?.stackFrames) ? body.stackFrames : []
      return asNumber((frames[0] as Record<string, unknown> | undefined)?.id)
    } catch {
      return undefined
    }
  }

  private requireCapability(session: Session, capability: keyof DebugCapabilitiesDTO): void {
    if (!session.dto.capabilities?.[capability]) throw new Error(`Debug adapter does not support ${capability}`)
  }

  async disassemble(sessionPath: string, memoryReference: string, instructionOffset = 0, count = 64, id?: string, stopId?: number, offset = 0): Promise<DebugDisassemblyDTO> {
    const session = this.requireStopped(id, sessionPath, stopId), epoch = session.stopEpoch
    this.requireCapability(session, 'supportsDisassembleRequest')
    const wanted = bounded(count, 200)
    validateReference(memoryReference); validateOffset(instructionOffset); validateOffset(offset)
    const body = await this.requireLive(session).request('disassemble', { memoryReference, offset, instructionOffset, instructionCount: wanted, resolveSymbols: true })
    this.assertStop(session, epoch)
    const list = Array.isArray(body?.instructions) ? body.instructions : []
    return { memoryReference, instructionOffset, instructions: list.slice(0, wanted).map(item => {
      const row = item as Record<string, unknown>
      return { address: asString(row.address) ?? '', instruction: truncate(asString(row.instruction) ?? '', 2048),
        instructionBytes: asString(row.instructionBytes), symbol: asString(row.symbol),
        source: this.mapSource(session, row.location), line: asNumber(row.line), presentationHint: asString(row.presentationHint) }
    }) }
  }

  async readMemory(sessionPath: string, memoryReference: string, offset = 0, count = 128, id?: string, stopId?: number): Promise<DebugMemoryDTO> {
    const session = this.requireStopped(id, sessionPath, stopId), epoch = session.stopEpoch
    this.requireCapability(session, 'supportsReadMemoryRequest')
    validateReference(memoryReference); validateOffset(offset)
    const wanted = bounded(count, 4096)
    const body = await this.requireLive(session).request('readMemory', { memoryReference, offset, count: wanted })
    this.assertStop(session, epoch)
    const encoded = asString(body?.data) ?? ''
    // Never turn absent/unreadable bytes into zero-filled memory.
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new Error('Invalid base64 memory response')
    const bytes = Buffer.from(encoded.slice(0, Math.ceil(wanted / 3) * 4), 'base64').subarray(0, wanted)
    const unreadableBytes = Math.min(wanted - bytes.length, Math.max(0, Math.floor(asNumber(body?.unreadableBytes) ?? 0)))
    return { address: asString(body?.address) ?? memoryReference, data: bytes.toString('base64'),
      hex: [...bytes].map(value => value.toString(16).padStart(2, '0')).join(' '), bytesRead: bytes.length,
      requestedCount: wanted, unreadableBytes, truncated: bytes.length < wanted }
  }

  async modules(sessionPath: string, start = 0, count = 50, id?: string, stopId?: number): Promise<DebugModulesPageDTO> {
    const session = this.requireStopped(id, sessionPath, stopId), epoch = session.stopEpoch
    this.requireCapability(session, 'supportsModulesRequest')
    if (!Number.isSafeInteger(start) || start < 0) throw new Error('Invalid module start')
    const wanted = bounded(count, 100)
    const request = async (startModule: number, moduleCount: number) => {
      const body = await this.requireLive(session).request('modules', { startModule, moduleCount })
      this.assertStop(session, epoch)
      return { rows: Array.isArray(body?.modules) ? body.modules as Record<string, unknown>[] : [], total: asNumber(body?.totalModules) }
    }
    let page
    if (session.modulePaging === undefined) {
      page = await request(0, 1)
      session.modulePaging = page.rows.length <= 1
      if (page.rows.length === 1) {
        const second = await request(1, 1)
        if (second.rows.length > 1 || second.rows[0]?.id === page.rows[0].id) {
          session.modulePaging = false
          page = undefined // count was honored but start was ignored; fetch the full list.
        }
      }
    }
    page = session.modulePaging ? await request(start, wanted + 1) : page ?? await request(0, 0)
    const from = session.modulePaging ? 0 : start
    const rows = page.rows.slice(from, from + wanted)
    const total = page.total ?? (!session.modulePaging ? page.rows.length : undefined)
    return { modules: rows.map(row => ({ id: asString(row.id) ?? asNumber(row.id) ?? '', name: asString(row.name) ?? '',
      path: asString(row.path), addressRange: asString(row.addressRange), symbolStatus: asString(row.symbolStatus),
      symbolFilePath: asString(row.symbolFilePath), version: asString(row.version) })), totalModules: total,
      truncated: from + wanted < page.rows.length || total !== undefined && start + rows.length < total }
  }

  nativeBreakpoints(sessionPath: string, id?: string): DebugNativeBreakpointsDTO {
    const points = this.owned(sessionPath, id).nativeBreakpoints
    return { instruction: points.instruction.map(point => ({ ...point })), function: points.function.map(point => ({ ...point })) }
  }

  private nativeBinding(record: unknown, condition?: string): DebugNativeBreakpointBinding {
    const row = (record ?? {}) as Record<string, unknown>
    return { id: asNumber(row.id), verified: asBoolean(row.verified) ?? false, message: asString(row.message),
      ...(condition ? { conditionStatus: 'unvalidated' } : {}) }
  }

  async setInstructionBreakpoints(sessionPath: string, points: DebugInstructionBreakpointInput[], id: string, stopId: number): Promise<DebugNativeBreakpointsDTO> {
    const session = this.requireStopped(id, sessionPath, stopId)
    if (session.dto.kind === 'core') throw new Error('Core files cannot have breakpoints')
    this.requireCapability(session, 'supportsInstructionBreakpoints')
    if (session.controlling) throw new Error('A debug control request is already in flight')
    return this.serializeBreakpoints(session, () => this.sendInstructionBreakpoints(session, points, stopId))
  }

  async toggleInstructionBreakpoint(sessionPath: string, instructionReference: string, id: string, stopId: number): Promise<DebugNativeBreakpointsDTO> {
    const session = this.requireStopped(id, sessionPath, stopId)
    if (session.dto.kind === 'core') throw new Error('Core files cannot have breakpoints')
    this.requireCapability(session, 'supportsInstructionBreakpoints')
    if (session.controlling) throw new Error('A debug control request is already in flight')
    return this.serializeBreakpoints(session, () => {
      const current = session.nativeBreakpoints.instruction
      const existing = current.find(point => instructionBreakpointMatches(point, instructionReference))
      const points = existing ? current.filter(point => point !== existing) : [...current, { instructionReference }]
      return this.sendInstructionBreakpoints(session, points, stopId)
    })
  }

  /** UI edits merge against the authoritative set inside the same write queue
   * as model replacements, never a renderer snapshot of the other points. */
  async updateInstructionBreakpoint(sessionPath: string, instructionReference: string, offset: number, enabled: boolean, id: string, stopId: number): Promise<DebugNativeBreakpointsDTO> {
    const session = this.requireStopped(id, sessionPath, stopId)
    if (session.dto.kind === 'core') throw new Error('Core files cannot have breakpoints')
    this.requireCapability(session, 'supportsInstructionBreakpoints')
    if (session.controlling) throw new Error('A debug control request is already in flight')
    validateReference(instructionReference); validateOffset(offset)
    return this.serializeBreakpoints(session, () => {
      const current = session.nativeBreakpoints.instruction
      const existing = current.find(point => point.instructionReference === instructionReference && (point.offset ?? 0) === offset)
      const points = enabled ? existing ? current : [...current, { instructionReference, offset }]
        : current.filter(point => point !== existing)
      return this.sendInstructionBreakpoints(session, points, stopId)
    })
  }

  private async sendInstructionBreakpoints(session: Session, points: DebugInstructionBreakpointInput[], epoch: number): Promise<DebugNativeBreakpointsDTO> {
    this.assertStop(session, epoch)
    if (points.length > 256) throw new Error('Too many instruction breakpoints')
    const requested = points.map(({ instructionReference, offset, condition, hitCondition }) => {
      validateReference(instructionReference); if (offset !== undefined) validateOffset(offset)
      return { instructionReference, offset, condition, hitCondition }
    })
    const body = await this.requireLive(session).request('setInstructionBreakpoints', { breakpoints: requested })
    this.assertStop(session, epoch)
    const rows = Array.isArray(body?.breakpoints) ? body.breakpoints : []
    session.nativeBreakpoints.instruction = requested.map((point, i) => ({ ...point, ...this.nativeBinding(rows[i], point.condition),
      boundInstructionReference: asString((rows[i] as Record<string, unknown> | undefined)?.instructionReference), boundOffset: asNumber((rows[i] as Record<string, unknown> | undefined)?.offset) }))
    this.publish(session)
    return this.nativeBreakpoints(session.dto.sessionPath, session.dto.id)
  }

  async setFunctionBreakpoints(sessionPath: string, points: DebugFunctionBreakpointInput[], id?: string, stopId?: number): Promise<DebugNativeBreakpointsDTO> {
    const session = this.requireStopped(id, sessionPath, stopId), epoch = session.stopEpoch
    if (session.dto.kind === 'core') throw new Error('Core files cannot have breakpoints')
    this.requireCapability(session, 'supportsFunctionBreakpoints')
    if (session.controlling) throw new Error('A debug control request is already in flight')
    return this.serializeBreakpoints(session, async () => {
      this.assertStop(session, epoch)
      await this.sendFunctionBreakpoints(session, points)
      this.assertStop(session, epoch)
      return this.nativeBreakpoints(sessionPath, session.dto.id)
    })
  }

  private async sendFunctionBreakpoints(session: Session, points: DebugFunctionBreakpointInput[]): Promise<void> {
    if (session.dto.kind === 'core') throw new Error('Core files cannot have breakpoints')
    this.requireCapability(session, 'supportsFunctionBreakpoints')
    if (points.length > 256) throw new Error('Too many function breakpoints')
    const requested = points.map(({ name, condition, hitCondition }) => { validateReference(name); return { name, condition, hitCondition } })
    const body = await this.requireLive(session).request('setFunctionBreakpoints', { breakpoints: requested })
    const rows = Array.isArray(body?.breakpoints) ? body.breakpoints : []
    session.functionRequests = requested
    session.nativeBreakpoints.function = requested.map((point, i) => ({ ...point, ...this.nativeBinding(rows[i], point.condition) }))
    this.publish(session)
  }

  async updateFunctionBreakpoint(sessionPath: string, name: string, enabled: boolean, id: string, stopId: number): Promise<DebugNativeBreakpointsDTO> {
    const session = this.requireStopped(id, sessionPath, stopId)
    if (session.dto.kind === 'core') throw new Error('Core files cannot have breakpoints')
    this.requireCapability(session, 'supportsFunctionBreakpoints')
    if (session.controlling) throw new Error('A debug control request is already in flight')
    validateReference(name)
    return this.serializeBreakpoints(session, async () => {
      this.assertStop(session, stopId)
      const current = session.functionRequests
      const points = enabled ? current.some(point => point.name === name) ? current : [...current, { name }]
        : current.filter(point => point.name !== name)
      await this.sendFunctionBreakpoints(session, points)
      this.assertStop(session, stopId)
      return this.nativeBreakpoints(sessionPath, id)
    })
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
    if (session.stopping) return session.stopping
    session.stopping = Promise.resolve().then(async () => {
      if (session.finishing) { await session.cleanup; return { ...session.dto } }
      session.controller.abort()
      const client = session.client
      if (client?.isOpen) {
        await client.request('disconnect', { terminateDebuggee: session.dto.kind === 'launch' }, 5000).catch(() => undefined)
      }
      await this.finish(session, 'terminated')
      return { ...session.dto }
    })
    return session.stopping
  }

  /** Restart the debuggee. Adapters advertising supportsRestartRequest get
   * the native path; everyone else gets stop+start with the recorded
   * options, which ends one session and begins the next (the id changes). */
  async restart(sessionPath: string, id?: string, signal?: AbortSignal, canStart?: () => boolean): Promise<DebugSessionDTO> {
    if (signal?.aborted || canStart?.() === false) throw new Error('Debug restart cancelled')
    const session = this.owned(sessionPath, id)
    if (session.dto.kind === 'core' || session.dto.parentId) throw new Error('Restart the launch session, not a core or adapter-owned target')
    if (session.dto.status === 'starting' || session.controlling) throw new Error('Debug session is busy')
    const options = session.startOptions
    if (!options) throw new Error('This session was not started by the app and cannot be restarted')
    const client = session.client
    const checkAdmission = (): void => {
      if (this.closing || signal?.aborted || canStart?.() === false) throw new Error('Debug restart cancelled')
    }
    // Reserve both restart paths before any await. Model and panel calls share
    // this guard through cleanup and the replacement target's entire startup.
    session.controlling = true
    try {
      if (!session.finishing && client?.isOpen && client.capabilities.supportsRestartRequest === true) {
        const epoch = session.stopEpoch
        const checkNativeAdmission = (): void => {
          checkAdmission()
          if (session.stopping || session.finishing || session.controller.signal.aborted || session.client !== client || !client.isOpen) {
            throw new Error('Debug restart cancelled')
          }
        }
        await session.breakpointWork
        checkNativeAdmission()
        // Absolute instruction references cannot survive relocation/ASLR.
        if (session.nativeBreakpoints.instruction.length) {
          await client.request('setInstructionBreakpoints', { breakpoints: [] })
          session.nativeBreakpoints.instruction = []
          this.publish(session)
        }
        checkNativeAdmission()
        await client.request('restart', {})
        if (!session.finishing && session.stopEpoch === epoch) {
          session.dto.location = undefined
          this.clearStop(session)
          session.dto.status = 'running'
          this.publish(session)
        }
        return { ...session.dto }
      }
      await this.stop(sessionPath, session.dto.id)
      checkAdmission()
      return await this.start({ ...options, signal, canStart: canStart ?? options.canStart, replacesId: session.dto.id, initialBreakpoints: new Map(session.launchBreakpoints ?? session.requested), initialFunctionBreakpoints: session.functionRequests.map(point => ({ ...point })) })
    } finally { session.controlling = false }
  }

  async stopSession(sessionPath: string): Promise<void> {
    await Promise.all([...this.sessions.values()].filter(s => s.dto.sessionPath === sessionPath).map(s => this.stop(sessionPath, s.dto.id)))
  }

  async dispose(): Promise<void> {
    this.closing = true
    await Promise.all([...this.sessions.values()].map(s => this.stop(s.dto.sessionPath, s.dto.id)))
  }

  /* ------------------------------ internals ------------------------------ */

  private requireStopped(id: string | undefined, sessionPath: string, stopId?: number): Session {
    const session = this.owned(sessionPath, id)
    if (!isLive(session)) throw new ToolFailure('DEBUG_SESSION_ENDED', 'The debug session has ended; start or restart it before inspection')
    if (session.dto.status !== 'stopped') throw new ToolFailure('DEBUG_NOT_STOPPED', `The debuggee is not stopped (status: ${session.dto.status}); use wait before inspection`)
    if (stopId !== undefined && stopId !== session.stopEpoch) throw new ToolFailure('DEBUG_STALE_STOP', 'Debug stop changed; refresh stack and variables')
    return session
  }

  private assertStop(session: Session, epoch: number): void {
    if (session.finishing || session.dto.status !== 'stopped' || session.stopEpoch !== epoch) throw new ToolFailure('DEBUG_STALE_STOP', 'Debug stop changed; refresh stack and variables')
  }

  /** The adapter connection of a session that can still be driven. */
  private requireLive(session: Session): DapClient {
    if (session.finishing || !isLive(session) || !session.client) throw new ToolFailure('DEBUG_SESSION_ENDED', 'The debug session has ended')
    return session.client
  }

  private mapSource(session: Session, raw: unknown): DebugSourceDTO | undefined {
    const source = debugSource(raw)
    if (source?.kind === 'adapter') {
      session.sources.set(source.sourceReference, raw as Record<string, unknown>)
      if (session.sources.size > 512) session.sources.delete(session.sources.keys().next().value!)
    }
    return source
  }

  async source(sessionPath: string, sourceReference: number, sourceVersion: number, id: string, stopId: number,
    startLine = 1, offset?: number, limit = 16_384): Promise<DebugSourceContentDTO> {
    const session = this.requireStopped(id, sessionPath, stopId)
    const epoch = session.stopEpoch
    if (sourceVersion !== session.dto.sourceVersion) throw new Error('Debug source changed; refresh stack')
    if (!Number.isSafeInteger(startLine) || startLine < 1 || offset !== undefined && (!Number.isSafeInteger(offset) || offset < 0)) throw new Error('Invalid source position')
    const source = session.sources.get(sourceReference)
    if (!source) throw new Error('Unknown adapter source; refresh stack or disassembly for this target')
    let document = session.sourceCache.get(sourceReference)
    if (!document) {
      const body = await this.requireLive(session).request('source', { sourceReference, source })
      this.assertStop(session, epoch)
      if (sourceVersion !== session.dto.sourceVersion) throw new Error('Debug source changed; refresh stack')
      document = { content: asString(body?.content) ?? '', ...(asString(body?.mimeType) ? { mimeType: asString(body?.mimeType) } : {}) }
      // Large adapter documents are refetched rather than retained without bound.
      if (document.content.length <= 1_048_576) {
        session.sourceCache.set(sourceReference, document)
        if (session.sourceCache.size > 8) session.sourceCache.delete(session.sourceCache.keys().next().value!)
      }
    }
    const text = document.content
    let from = 0, line = 1
    if (offset !== undefined) {
      from = Math.min(offset, text.length)
      if (from < text.length && /[\uDC00-\uDFFF]/.test(text[from])) from++
      for (let index = 0; index < from; index++) if (text[index] === '\n') line++
    } else {
      while (line < startLine && from < text.length) {
        const newline = text.indexOf('\n', from)
        if (newline < 0) { from = text.length; break }
        from = newline + 1; line++
      }
    }
    const budget = Math.max(2, Math.min(32_768, Math.floor(limit)))
    let to = from, lines = 0
    while (to < text.length && to - from < budget && lines < 100) {
      const newline = text.indexOf('\n', to)
      const lineEnd = newline < 0 ? text.length : newline + 1
      if (lineEnd - from > budget) {
        // Keep complete lines together; only a line longer than the budget
        // needs to continue in the next window.
        if (to === from) to = Math.min(text.length, from + budget)
        break
      }
      to = lineEnd; lines++
    }
    if (to < text.length && /[\uD800-\uDBFF]/.test(text[to - 1])) to--
    let previousOffset = Math.max(0, from - budget)
    if (previousOffset > 0) {
      const newline = text.indexOf('\n', previousOffset)
      if (newline >= 0 && newline + 1 < from) previousOffset = newline + 1
    }
    return { debugId: id, sourceReference, sourceVersion, content: text.slice(from, to),
      ...(document.mimeType ? { mimeType: document.mimeType } : {}),
      offset: from, nextOffset: to, totalChars: text.length, startLine: line, previousOffset,
      continuedLine: from > 0 && text[from - 1] !== '\n',
      truncated: from > 0 || to < text.length }
  }

  private invalidateSources(session: Session, identities = true): void {
    session.dto.sourceVersion = (session.dto.sourceVersion ?? 0) + 1
    if (identities) session.sources.clear()
    session.sourceCache.clear()
  }

  private mapFrame(session: Session, record: Record<string, unknown>): DebugStackFrameDTO {
    const source = this.mapSource(session, record.source)
    return {
      id: asNumber(record.id) ?? 0,
      name: asString(record.name) ?? '<anonymous>',
      ...(source ? { source } : {}),
      ...(source?.kind === 'file' ? { file: source.path } : {}),
      ...(asString(record.instructionPointerReference) ? { instructionPointerReference: asString(record.instructionPointerReference) } : {}),
      ...(asString(record.moduleId) !== undefined || asNumber(record.moduleId) !== undefined ? { moduleId: record.moduleId as string | number } : {}),
      ...(asNumber(record.line) !== undefined ? { line: asNumber(record.line) } : {}),
      ...(asNumber(record.column) !== undefined ? { column: asNumber(record.column) } : {})
    }
  }

  private handleEvent(session: Session, event: string, body: Record<string, unknown> | undefined): void {
    if (session.finishing) return
    if (session.dto.status === 'terminated' && !['output', 'terminated', 'exited'].includes(event)) return
    switch (event) {
      case 'initialized':
        break // The transport's event waiter owns the handshake.
      case 'capabilities':
        if (body?.capabilities && typeof body.capabilities === 'object' && session.client) {
          Object.assign(session.client.capabilities, body.capabilities)
          session.dto.capabilities = debugCapabilities(session.client.capabilities)
          this.publish(session)
        }
        break
      case 'loadedSource':
        this.invalidateSources(session, false)
        if (body?.reason === 'removed') {
          const source = debugSource(body.source)
          if (source?.kind === 'adapter') session.sources.delete(source.sourceReference)
        }
        this.publish(session)
        break
      case 'invalidated':
        // Frames and variable references can change without a continued event.
        this.invalidateSources(session)
        session.variablePaging.clear()
        if (session.dto.status === 'stopped') {
          session.dto.stopId = ++session.stopEpoch
          session.dto.location = undefined
          const epoch = session.stopEpoch
          const filling = this.fillTopFrame(session, epoch).then(() => {
            if (session.filling === filling) session.filling = undefined
            if (!session.finishing && session.dto.status === 'stopped' && session.stopEpoch === epoch) this.settleWaiters(session)
          })
          session.filling = filling
        }
        this.publish(session)
        break
      case 'module':
        session.modulePaging = undefined
        this.publish(session)
        break
      case 'stopped':
        this.clearStop(session)
        session.dto.status = 'stopped'
        session.dto.stopReason = asString(body?.reason) ?? 'stopped'
        session.dto.stopDescription = asString(body?.description)
        session.dto.stopText = asString(body?.text)
        session.dto.hitBreakpointIds = Array.isArray(body?.hitBreakpointIds) ? body.hitBreakpointIds.filter((id): id is number => typeof id === 'number') : undefined
        if (asNumber(body?.threadId) !== undefined) session.dto.activeThreadId = asNumber(body?.threadId)
        session.dto.location = undefined
        session.stopEpoch += 1
        session.dto.stopId = session.stopEpoch
        // Settle only once the top frame is resolved, so the control snapshot
        // reports where THIS stop happened instead of nothing or a stale line.
        const epoch = session.stopEpoch
        const filling = this.fillTopFrame(session, epoch).then(() => {
          if (session.filling === filling) session.filling = undefined
          if (!session.finishing && session.dto.status === 'stopped' && session.stopEpoch === epoch) this.settleWaiters(session)
        })
        session.filling = filling
        this.publish(session)
        break
      case 'continued':
        session.dto.status = 'running'
        this.clearStop(session)
        session.dto.location = undefined
        if (asNumber(body?.threadId) !== undefined) session.dto.activeThreadId = asNumber(body?.threadId)
        this.publish(session)
        break
      case 'output': {
        const text = asString(body?.output)
        if (text) {
          const category = asString(body?.category)
          this.append(session, category && category !== 'console' && category !== 'stdout' && category !== 'stderr' ? `[${category}] ${text}` : text)
          if (category === 'important' && session.dto.status === 'stopped') {
            session.dto.stopDiagnostics = ((session.dto.stopDiagnostics ?? '') + text).slice(-8192)
            // LLDB reports an expression error as an ordinary breakpoint stop.
            // Keep its reason verbatim, but never present this as a true condition.
            const match = session.dto.adapterId === 'lldb-dap' && /error evaluating condition of breakpoint (\d+)(?:\.\d+)?/i.exec(session.dto.stopDiagnostics)
            if (match) {
              session.dto.conditionError = true
              const breakpoint = [...session.breakpoints, ...session.nativeBreakpoints.instruction, ...session.nativeBreakpoints.function].find(bp => bp.id === Number(match[1]) && bp.condition)
              if (breakpoint) { breakpoint.conditionStatus = 'error'; breakpoint.conditionError = session.dto.stopDiagnostics }
            }
            this.publish(session)
          }
        }
        break
      }
      case 'breakpoint': {
        const record = body?.breakpoint as Record<string, unknown> | undefined
        const id = asNumber(record?.id)
        if (id === undefined) break
        const native = [...session.nativeBreakpoints.instruction, ...session.nativeBreakpoints.function].find(point => point.id === id)
        if (native) {
          if (body?.reason === 'removed') {
            session.nativeBreakpoints.instruction = session.nativeBreakpoints.instruction.filter(point => point.id !== id)
            session.nativeBreakpoints.function = session.nativeBreakpoints.function.filter(point => point.id !== id)
            if ('name' in native) session.functionRequests = session.functionRequests.filter(point => point.name !== native.name)
          } else {
            native.verified = asBoolean(record?.verified) ?? native.verified
            native.message = asString(record?.message)
            if ('instructionReference' in native) {
              native.boundInstructionReference = asString(record?.instructionReference) ?? native.boundInstructionReference
              native.boundOffset = asNumber(record?.offset) ?? native.boundOffset
            }
          }
          this.publish(session)
          break
        }
        const current = session.breakpoints.find(bp => bp.id === id)
        if (!current) {
          const source = record?.source as Record<string, unknown> | undefined
          const file = asString(source?.path), line = asNumber(record?.line)
          if (body?.reason === 'new' && file && line) {
            session.requested.set(file, [...(session.requested.get(file) ?? []).filter(bp => bp.line !== line), { line }])
            session.breakpoints.push({ id, file, line, requestedLine: line, verified: asBoolean(record?.verified) ?? false, message: asString(record?.message) })
            this.publish(session)
          }
          break
        }
        if (body?.reason === 'removed') {
          session.breakpoints = session.breakpoints.filter(bp => bp.id !== id)
          session.requested.set(current.file, (session.requested.get(current.file) ?? []).filter(bp => bp.line !== current.requestedLine))
        } else {
          current.line = asNumber(record?.line) ?? current.line
          current.verified = asBoolean(record?.verified) ?? current.verified
          current.message = asString(record?.message)
        }
        this.publish(session)
        break
      }
      case 'exited':
        // DAP may send final output AFTER exited. Keep the transport until
        // terminated/close, with a bounded grace period for incomplete peers.
        session.dto.status = 'terminated'
        session.dto.endedAt = Date.now()
        session.dto.location = undefined
        this.clearStop(session)
        this.settleWaiters(session)
        this.publish(session)
        session.exitTimer ??= setTimeout(() => { void this.finish(session, 'terminated') }, 2000)
        break
      case 'terminated':
        void this.finish(session, 'terminated')
        break
      default:
        break // Other adapter metadata is queried on demand.
    }
  }

  /** Best-effort top-frame location for the panel and the control snapshot.
   * `epoch` pins the fill to one stop: an answer that arrives after a newer
   * stop must not overwrite that stop's location. */
  private async fillTopFrame(session: Session, epoch: number): Promise<void> {
    const threadId = session.dto.activeThreadId
    const client = session.client
    if (threadId === undefined || !client?.isOpen) return
    let body: Record<string, unknown> | undefined
    try {
      body = await client.request('stackTrace', { threadId, startFrame: 0, levels: 1 })
    } catch {
      return // location is best-effort
    }
    if (epoch !== session.stopEpoch) return
    const frames = Array.isArray(body?.stackFrames) ? body.stackFrames : []
    const record = frames[0] as Record<string, unknown> | undefined
    if (!record || session.finishing || session.dto.status !== 'stopped') return
    const frame = this.mapFrame(session, record)
    session.dto.location = {
      ...(frame.file ? { file: frame.file } : {}),
      ...(frame.source ? { source: frame.source } : {}),
      ...(frame.instructionPointerReference ? { instructionPointerReference: frame.instructionPointerReference } : {}),
      ...(frame.moduleId !== undefined ? { moduleId: frame.moduleId } : {}),
      line: frame.line ?? 0,
      ...(frame.column !== undefined ? { column: frame.column } : {}),
      name: frame.name
    }
    // A stop at the process entry lands inside the dynamic linker on macOS,
    // and lldb-dap reports it with reason "exception" — which reads like a
    // crash. Report it for what it is.
    if (session.dto.stopReason === 'exception' && (frame.name === '_dyld_start' || (frame.file ?? '').includes('/dyld'))) {
      session.dto.stopReason = 'entry'
    }
    this.publish(session)
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

  private waitStopped(session: Session, budgetMs: number): Promise<boolean> {
    if (session.finishing || !isLive(session)) return Promise.resolve(true)
    if (session.dto.status === 'stopped' && !session.filling) return Promise.resolve(true)
    return new Promise((resolve) => {
      const waiter: StoppedWaiter = {
        resolve: () => resolve(true),
        timer: setTimeout(() => {
          session.waiters = session.waiters.filter((entry) => entry !== waiter)
          resolve(false)
        }, budgetMs)
      }
      session.waiters.push(waiter)
    })
  }

  private settleWaiters(session: Session): void {
    for (const check of this.changeWaiters.get(session.dto.id) ?? []) check()
    const waiters = session.waiters.splice(0)
    for (const waiter of waiters) {
      clearTimeout(waiter.timer)
      waiter.resolve()
    }
  }

  private clearStop(session: Session): void {
    this.invalidateSources(session)
    session.dto.stopReason = undefined
    session.dto.stopDescription = undefined
    session.dto.stopText = undefined
    session.dto.hitBreakpointIds = undefined
    session.dto.stopDiagnostics = undefined
    session.dto.conditionError = undefined
    session.variablePaging.clear()
    session.modulePaging = undefined
  }

  private publish(session: Session): void {
    session.dto = { ...session.dto, revision: session.dto.revision + 1 }
    this.changed({ ...session.dto })
    for (const check of this.changeWaiters.get(session.dto.id) ?? []) check()
  }

  private finish(session: Session, status: 'terminated' | 'failed'): Promise<void> {
    if (session.cleanup) return session.cleanup
    let complete!: () => void, failed!: (error: unknown) => void
    session.cleanup = new Promise<void>((resolve, reject) => { complete = resolve; failed = reject })
    void session.cleanup.catch(() => {})
    session.finishing = true
    session.controller.abort()
    clearTimeout(session.progressTimer)
    clearTimeout(session.exitTimer)
    session.dto.status = status; session.dto.endedAt = Date.now()
    session.dto.location = undefined; this.clearStop(session)
    this.settleWaiters(session)
    for (const pending of session.pendingBreakpoints.splice(0)) pending.reject(new Error('Debug session ended before configuration'))
    this.publish(session)
    session.resolveDone()
    const client = session.client
    session.client = undefined
    void Promise.all([
      client?.dispose(),
      ...[...session.terminals].map(dispose => dispose()),
      ...[...this.sessions.values()].filter(s => s.dto.parentId === session.dto.id).map(s => this.stop(s.dto.sessionPath, s.dto.id))
    ]).then(() => {
      session.releaseCheckout?.(); session.releaseCheckout = undefined
      this.prune()
      complete()
    }, error => {
      // Retain the process lease if cleanup cannot prove the tree exited.
      session.dto.status = 'failed'; session.dto.error = error instanceof Error ? error.message : String(error)
      this.publish(session)
      failed(error)
    })
    return session.cleanup
  }

  /** Settled sessions stay queryable (output pages) but bounded: the newest
   * few per app lifetime, mirroring the bash history retention spirit. */
  private prune(): void {
    const settled = [...this.sessions.values()].filter((session) => session.finishing && !session.releaseCheckout)
      .sort((a, b) => b.dto.startedAt - a.dto.startedAt)
    for (const session of settled.slice(10)) this.sessions.delete(session.dto.id)
  }
}

/** The short bind/release interval can race another local process; connection
 * failures remain bounded and fail visibly rather than selecting a fixed port. */
function availablePort(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, host, () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(error => error ? reject(error) : resolve(port))
    })
  })
}

function bounded(value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid debug page count')
  return Math.min(value, maximum)
}
function validateReference(value: string): void {
  if (typeof value !== 'string' || !value.length || value.length > 8192) throw new Error('Invalid debug reference')
}
function validateOffset(value: number): void {
  if (!Number.isSafeInteger(value) || value < -0x8000_0000 || value > 0x7fff_ffff) throw new Error('Invalid debug offset')
}

function instructionBreakpointMatches(point: DebugInstructionBreakpointDTO, address: string): boolean {
  const reference = point.boundInstructionReference ?? point.instructionReference
  const offset = point.boundInstructionReference ? point.boundOffset ?? 0 : point.offset ?? 0
  if (/^0x[\da-f]+$/i.test(reference) && /^0x[\da-f]+$/i.test(address)) return BigInt(reference) + BigInt(offset) === BigInt(address)
  return reference === address && offset === 0
}
