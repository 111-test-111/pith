import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import type { AgentSession, AgentSessionEvent, SessionManager as SessionManagerType } from '@earendil-works/pi-coding-agent'
import type { BashTaskManager } from '../../bash/manager'
import { taskIsLive } from '../../bash/task-status.ts'
import type { ChatMessage, SubagentRunDTO, SubagentRunStatus, SubagentWrittenFileDTO, ThinkingLevel } from '../../../shared/types'
import { SUBAGENT_MAX_TURNS_LIMIT } from '../../../shared/types.ts'
import type { SubagentProfile } from './profiles.ts'
import { extractSubagentWrittenFiles, loadSubagentInputFiles, parentContextText } from './derive.ts'
import { SubagentError } from './errors.ts'
import {
  applyRunToRoster,
  currentDiskRun,
  readDiskSubagentRuns,
  slimRunForRoster,
  SUBAGENT_COMPLETION_TYPE,
  SUBAGENT_EXCLUDED_TOOLS,
  SUBAGENT_RESULT_TYPE,
  SUBAGENT_RUN_TYPE,
  SUBAGENT_DISPATCH_TYPE,
  SUBAGENT_TOOL_NAME,
  MESSAGE_PARENT_TOOL_NAME,
  type DiskSubagentRun,
  type SubagentRunResultData,
  type SubagentRunStartData
} from './protocol.ts'
import { SubagentNotifications } from './notifications.ts'

export const MAX_CONCURRENT_SUBAGENTS_DEFAULT = 4
export const MAX_CONCURRENT_SUBAGENTS_LIMIT = 16
/** How long a coordinated stop waits for a run's completion before giving the
 * caller back control (the halt itself keeps settling in the background). */
const STOP_SETTLE_MS = 5000
/** How many extra child wake cycles the drain loop tolerates before giving
 * up on the child's own background commands. */
const DRAIN_MAX_CYCLES = 100
// Monotonic across parent reloads in this process, including cached renderer
// snapshots from a previously disposed ManagedSession.
let rosterSequence = 0

/** Whether a frozen ceiling names at least one tool the parent attributes to
 * an extension — in which case the child's loader must load extensions or
 * the tool has no definition to call (the checked-tools bug). Attribution
 * follows the SDK's own tagging: extension-registered tools carry their
 * extension's sourceInfo whose `source` is the extension's ORIGIN TAG
 * ("local", "temporary", "npm:…") — never a literal "extension" — while the
 * SDK reserves exactly two synthetic sources for non-extension tools:
 * "builtin" for the built-ins and "sdk" for customTools (the app's own
 * bash/todo_write/ask_user). Anything else is an extension tool, the same
 * rule the tools catalog attributes by. Every other ceiling stays
 * extension-free, so ordinary read-only delegations never multiply MCP
 * hosts. Pure and script-checked. */
export function ceilingNeedsExtensions(
  ceiling: readonly string[],
  parentTools: ReadonlyArray<{ name: string; sourceInfo?: { source?: string } }>
): boolean {
  const attributed = new Map(parentTools.map((tool) => [tool.name, tool.sourceInfo?.source ?? 'sdk']))
  return ceiling.some((name) => {
    const source = attributed.get(name)
    return source !== undefined && source !== 'builtin' && source !== 'sdk'
  })
}

/** Native MCP definitions remain callable from codemode while absent from
 * `getActiveToolNames()` (the model-facing declaration set). A role may name
 * those definitions explicitly, and `tools: all` includes them. Historical
 * adapter proxies have only one separator and remain governed by the active
 * set. Resource tools are callable MCP definitions without an `mcp__` prefix. */
function isNativeMcpCallable(name: string): boolean {
  if (name === 'list_mcp_resources' || name === 'list_mcp_resource_templates' || name === 'read_mcp_resource') return true
  return /^mcp__.+__.+$/.test(name)
}

/** The tool names a parent may pass to a new or resumed child. A nested
 * parent's frozen ceiling remains the upper bound, even though the SDK's
 * callable set includes every registered codemode/deferred definition. */
export function parentDelegableToolNames(
  active: readonly string[],
  callable: readonly string[],
  frozenCeiling: readonly string[] | null
): string[] {
  const frozen = frozenCeiling ? new Set(frozenCeiling) : null
  const names = new Set(active.filter(name => !frozen || frozen.has(name)))
  for (const name of callable) {
    if (isNativeMcpCallable(name) && (!frozen || frozen.has(name))) names.add(name)
  }
  return [...names]
}

/** Everything a start needs, resolved by the tool layer. */
export interface StartSubagentRequest {
  parentSession: AgentSession
  parentSessionPath: string
  parentToolCallId: string
  profile: SubagentProfile
  description: string
  task: string
  runInBackground?: boolean
  modelSpec?: string
  thinkingLevel?: ThinkingLevel
  maxTurns?: number
  inheritContext?: boolean
  inputFiles?: string[]
}

/** Model-driven overrides for a continuation: the fresh dispatch's tool
 * call id (receipt barrier + dispatch record), the new description and the
 * new background choice. The panel's IPC path passes only `expectedRunId` —
 * the stored run's own dispatch values still apply. */
export interface ResumeSubagentOptions {
  parentToolCallId?: string
  description?: string
  runInBackground?: boolean
  /** Model request only; runtime rechecks the user's override grant. */
  maxTurns?: number
  /** Panel-only optimistic concurrency token. Model-driven reuse omits it. */
  expectedRunId?: string
  /** The continuing tool call's abort signal (a foreground dispatch): wired
   * for the run's WHOLE lifetime, exactly like `start`'s external signal. */
  foregroundSignal?: AbortSignal
}

/** Handle to a live child ManagedSession, produced by the host (PiManager). */
export interface ChildSessionHandle {
  session: AgentSession
  sessionManager: SessionManagerType
  path: string
  cwd: string
  /** Identity of the run this handle was created for. */
  runId: string
  parentSessionId: string
  /** Resource snapshot actually applied — what a later reopen must restore. */
  resource: SubagentRunStartData['resource']
  goalOwner?: SubagentRunStartData['goalOwner']
  /** Stop everything the child owns: its notification wake path, its queues,
   * its background bash processes and its SDK run. Awaitable. */
  halt: () => Promise<void>
  /** Dispose the child (abort + shutdown) unless the user is viewing it. */
  release: () => void | Promise<void>
  /** Includes the child's pending background-completion handoff. */
  isSettled?: () => boolean
}

/** Host capabilities the runtime needs from PiManager; keeps this module free
 * of a manager import (no module cycle). */
export interface SubagentHost {
  isClosing(): boolean
  maxConcurrentSubagents(): number
  subagentsEnabled(): boolean
  /** Settings → Subagents: the parent model may continue finished children. */
  subagentReuseEnabled(): boolean
  /** Settings → Subagents: parent↔child steering is enabled. */
  subagentCommsEnabled(): boolean
  subagentTurnLimitOverrideEnabled(): boolean
  subagentMaxTurns(): number | null
  profileDebugEnabled?(cwd: string, name: string): boolean
  planRestricted(parentSessionPath: string): boolean
  /** Null for a root session; child sessions return their persisted, narrowed
   * role ceiling. The SDK's callable registry alone does not carry this fact. */
  frozenToolCeiling(sessionPath: string): readonly string[] | null
  commandTasks(): BashTaskManager | null
  /**
   * Register a run lease so rewind restores and foreign snapshots cannot
   * start under live runs. The lease is keyed to `sessionPath`: the creation
   * phase leases the PARENT (before the child file exists), the run phase
   * leases the CHILD — which additionally blocks the parent's own checkpoint
   * snapshots while its subagent is writing.
   */
  acquireRunLease(cwd: string, sessionPath: string): () => void
  createChildSession(options: {
    mode: 'new' | 'reopen'
    cwd: string
    parentSessionPath: string
    parentSessionId: string
    runId: string
    resource: SubagentRunStartData['resource']
    /** Profile name, for the ask-user source badge in the parent's panel. */
    profile?: string
    /** Child session file, required for `reopen`. */
    sessionPath?: string
  }): Promise<ChildSessionHandle>
  emitSubagents(parentSessionId: string, parentSessionPath: string, runs: SubagentRunDTO[]): void
  /** Resolve/validate a "provider/modelId" spec. With no spec, returns the
   * PARENT's live model as a spec so children inherit it instead of falling
   * back to the default model selection. */
  resolveModelSpec(spec: string | undefined, fallback: AgentSession): Promise<{ spec?: string }>
  notifySubagentChildWrite(cwd: string): void
}

interface LiveRun {
  run: SubagentRunDTO
  child: ChildSessionHandle
  suppressNotify: boolean
  userAborted: boolean
  completion: Promise<SubagentRunDTO>
  halting?: Promise<void>
}

/**
 * Per-parent subagent state: the roster the renderer sees, slot accounting
 * and the live run registry. Attached to a ManagedSession like TodoState.
 *
 * `starting` holds the controllers of runs that are still being CREATED —
 * Stop must reach them too, not only runs whose session already exists.
 */
export class SubagentParentState {
  readonly roster = new Map<string, SubagentRunDTO>()
  private startingCount = 0
  readonly runs = new Map<string, LiveRun>()
  readonly starting = new Set<AbortController>()
  /** Resolves when each in-flight launch finished its cleanup — `stopAll`
   * awaits these so a cancelled launch cannot still be mid-creation after
   * the stop returned. */
  readonly launching = new Set<Promise<void>>()
  readonly resuming = new Set<string>()
  notifications: SubagentNotifications | null = null

  readonly sessionId: string

  constructor(sessionId: string) { this.sessionId = sessionId }

  nextSeq(): number { return ++rosterSequence }

  /** Reserve one concurrency slot (starting + active are both counted). */
  reserve(max: number): () => void {
    if (this.startingCount + this.countActive() >= max) {
      throw new SubagentError(`Subagent concurrency limit reached (${max}). Wait for a running subagent to finish, or stop one, before starting another.`)
    }
    this.startingCount++
    let released = false
    return () => { if (!released) { released = true; this.startingCount-- } }
  }

  countActive(): number {
    return this.runs.size
  }

  /**
   * Zero/non-zero admission fact for Plan mode: true while any run is
   * starting, launching or live, even before it reaches `runs`. The three
   * sources overlap on purpose (a launching run is also counted as starting);
   * callers only ask whether the parent is quiet.
   */
  get hasLiveRuns(): boolean {
    return this.startingCount > 0 || this.launching.size > 0 || this.runs.size > 0
  }

  /** Roster payload for the renderer: newest first, patch-free (roster rows
   * re-serialize on every progress tick; see slimRunForRoster). */
  snapshot(): SubagentRunDTO[] {
    return [...this.roster.values()].sort(
      (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.seq - a.seq
    ).map(slimRunForRoster)
  }

  apply(run: SubagentRunDTO): boolean {
    return applyRunToRoster(this.roster, run)
  }
}

function sleep(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)) }

/**
 * Terminal status rules, pure so they can be checked without an app instance.
 * Two decisions are load-bearing:
 *
 * - Only a USER stop (Stop/Esc, rewind/resend/delete, quit) yields `aborted`.
 *   The runtime's own turn-limit abort is a designed end, so that run reports
 *   the answer it produced plus `limitReached` instead of masquerading as a
 *   stop — a stop also suppresses the parent's completion notification.
 * - A terminal record that could not be persisted is a FAILED run, never a
 *   silent success: the answer text still rides the DTO for triage, but a
 *   caller (or the parent model) must not believe the outcome was recorded.
 */
export interface RunOutcomeInput {
  userAborted: boolean
  turnLimitReached: boolean
  stopReason?: string
  errorMessage?: string
  promptError?: string
  persistenceError?: string
}

export function deriveRunOutcome(input: RunOutcomeInput): { status: SubagentRunStatus; error?: string; limitReached?: true } {
  if (input.userAborted) return { status: 'aborted' }
  if (input.persistenceError) {
    return { status: 'failed', error: input.persistenceError, ...(input.turnLimitReached ? { limitReached: true as const } : {}) }
  }
  if (input.turnLimitReached) return { status: 'completed', limitReached: true }
  if (input.stopReason === 'error') {
    return { status: 'failed', error: input.errorMessage ?? 'The subagent ended with an error' }
  }
  if (input.stopReason === 'aborted') return { status: 'aborted' }
  if (input.promptError !== undefined) return { status: 'failed', error: input.promptError }
  return { status: 'completed' }
}

function runMessages(manager: SessionManagerType, startEntryId: string | undefined, resultEntryId?: string): ChatMessage[] {
  const branch = manager.getBranch(resultEntryId)
  const anchor = startEntryId ? branch.findIndex(entry => entry.id === startEntryId) : -1
  if (startEntryId && anchor < 0) throw new SubagentError('Subagent run is missing its persisted branch anchor')
  const messages: ChatMessage[] = []
  for (const entry of branch.slice(anchor + 1)) {
    if (entry.type === 'custom' && entry.customType === SUBAGENT_RUN_TYPE) break
    if (entry.type === 'message') messages.push(entry.message as ChatMessage)
  }
  return messages
}

/** The single subagent engine. One instance per app, held by PiManager. */
export class SubagentRuntime {
  private readonly host: SubagentHost

  constructor(host: SubagentHost) { this.host = host }

  /** Start a new run on a fresh child session. */
  async start(state: SubagentParentState, request: StartSubagentRequest, signal?: AbortSignal): Promise<{ run: SubagentRunDTO; completion: Promise<SubagentRunDTO> }> {
    if (this.host.isClosing()) throw new SubagentError('Application is shutting down')
    if (!this.host.subagentsEnabled()) throw new SubagentError('Subagents are disabled in Settings')
    if (!request.profile.enabled) throw new SubagentError(`Profile "${request.profile.name}" is disabled`)
    if (!existsSync(request.parentSessionPath)) throw new SubagentError('The parent session has not been saved yet')
    const releaseSlot = state.reserve(this.host.maxConcurrentSubagents())
    // Register for cancellation BEFORE any await: a Stop issued while the
    // model/session is still being resolved must abort the launch, not race it.
    const controller = new AbortController()
    state.starting.add(controller)
    let launchSettled: () => void
    const launchDone = new Promise<void>((resolve) => { launchSettled = resolve })
    state.launching.add(launchDone)
    const onSignalAbort = () => controller.abort()
    signal?.addEventListener('abort', onSignalAbort, { once: true })
    let releaseCreationLease: (() => void) | null = null
    try {
      if (signal?.aborted || controller.signal.aborted) throw new SubagentError('Subagent cancelled before launch')
      const cwd = request.parentSession.sessionManager.getCwd()
      releaseCreationLease = this.host.acquireRunLease(cwd, request.parentSessionPath)
      const parentAvailable = new Set(parentDelegableToolNames(
        request.parentSession.getActiveToolNames(),
        request.parentSession.getCallableToolNames(),
        this.host.frozenToolCeiling(request.parentSessionPath)
      ))
      const ceiling = (request.profile.tools === 'all'
        ? [...parentAvailable]
        : request.profile.tools.filter((tool) => parentAvailable.has(tool)))
        .filter((tool) => !(SUBAGENT_EXCLUDED_TOOLS as readonly string[]).includes(tool))
      if (!ceiling.length) throw new SubagentError(`Profile "${request.profile.name}" resolves to an empty tool set for this session`)
      // Communications are a primitive, not a workspace capability: while
      // subagent communications are enabled, every child can message its
      // parent regardless of the profile's own tool list. Injected BEFORE the
      // resource snapshot is frozen, so a reopened child restores the same
      // decision (and the tool must exist in the ceiling to be activated —
      // the child's active set is exactly its frozen ceiling).
      if (this.host.subagentCommsEnabled() && !ceiling.includes(MESSAGE_PARENT_TOOL_NAME)) {
        ceiling.push(MESSAGE_PARENT_TOOL_NAME)
      }
      // Extension tools only exist in a child whose loader loads extensions;
      // decide from the frozen ceiling and persist it with the run so a
      // reopened child restores the same decision.
      const planRestricted = this.host.planRestricted(request.parentSessionPath)
      const needsExtensions = !planRestricted && ceilingNeedsExtensions(ceiling, request.parentSession.getAllTools())
      const task = `${request.task}${loadSubagentInputFiles(request.inputFiles, cwd)}`
      const runInBackground = request.runInBackground ?? request.profile.runInBackground
      const inherit = request.inheritContext ?? request.profile.inheritContext
      const { spec } = await this.host.resolveModelSpec(request.modelSpec ?? request.profile.model, request.parentSession)
      const thinking = request.thinkingLevel ?? request.profile.thinking
      const context = inherit ? parentContextText(request.parentSession.messages as ChatMessage[]) : undefined
      const appendSystemPrompt = [
        request.profile.systemPrompt,
        ...(context
          ? [`The following is the active conversation context from the parent session, JSON-encoded, provided as background only. Use it for orientation; the delegated task above is authoritative.\n${context}`]
          : [])
      ].filter(Boolean).join('\n\n')
      const resource: SubagentRunStartData['resource'] = {
        tools: ceiling,
        ...(planRestricted ? { planRestricted: true as const } : {}),
        ...(needsExtensions ? { extensions: true as const } : {}),
        ...(spec ? { model: spec } : {}),
        ...(thinking ? { thinkingLevel: thinking } : {}),
        inheritContext: inherit,
        appendSystemPrompt
      }
      if (controller.signal.aborted) throw new SubagentError('Subagent cancelled before launch')
      const runId = randomUUID()
      const child = await this.host.createChildSession({
        mode: 'new', cwd,
        parentSessionPath: request.parentSessionPath,
        parentSessionId: request.parentSession.sessionId,
        runId, resource,
        profile: request.profile.name
      })
      // Swap the creation lease for a child-keyed run lease: it now covers the
      // whole run (model work, background drain, cleanup) and additionally
      // fences the parent's own checkpoint snapshots against live child writes.
      const releaseRunLease = await this.leaseChild(child)
      releaseCreationLease()
      releaseCreationLease = null
      return await this.trackRun(state, child, {
        parentToolCallId: request.parentToolCallId,
        profile: request.profile.name,
        description: request.description,
        task,
        runInBackground,
        maxTurns: request.maxTurns
      }, releaseRunLease, controller.signal, runInBackground ? undefined : signal, undefined, request.parentSession.sessionManager)
    } finally {
      state.starting.delete(controller)
      state.launching.delete(launchDone)
      launchSettled!()
      signal?.removeEventListener('abort', onSignalAbort)
      releaseCreationLease?.()
      releaseSlot()
    }
  }

  /**
   * Continue a finished child session under a fresh runId. Shares the start
   * path's admission (slot + lease + enabled checks + cancellation) and
   * resolves the turn limit from the current user setting and override grant.
   *
   * Returns the same `{ run, completion }` shape as `start` so the model's
   * `continue_session_id` path can emit its receipt from the initial DTO;
   * the panel's IPC action ignores the value.
   */
  async resume(state: SubagentParentState, parentSession: AgentSession, sessionId: string, message: string, options: ResumeSubagentOptions = {}): Promise<{ run: SubagentRunDTO; completion: Promise<SubagentRunDTO> }> {
    if (this.host.isClosing()) throw new SubagentError('Application is shutting down')
    if (!this.host.subagentsEnabled()) throw new SubagentError('Subagents are disabled in Settings')
    const text = message.trim()
    if (!text) throw new SubagentError('Resume message is required')
    const rosterEntry = state.roster.get(sessionId)
    if (options.expectedRunId !== undefined && rosterEntry?.runId !== options.expectedRunId) {
      throw new SubagentError('Subagent run changed; choose the action again')
    }
    if (!rosterEntry) throw new SubagentError(`Subagent session not found: ${sessionId}`)
    if (rosterEntry.status === 'running' || state.resuming.has(sessionId) || this.liveRunOf(state, sessionId)) throw new SubagentError('Subagent is already running')
    const cwd = parentSession.sessionManager.getCwd()
    const current = this.readChildRuns(rosterEntry.sessionPath)[0]
    if (options.expectedRunId !== undefined && current?.start.runId !== options.expectedRunId) {
      throw new SubagentError('Subagent run changed; choose the action again')
    }
    if (!current) throw new SubagentError(`Subagent session not found: ${sessionId}`)
    // B1: the child's latest run is only continuable while the parent's
    // SELECTED branch still owns its dispatch — a resume after a rewind past
    // the dispatch would continue a branch the conversation abandoned.
    if (!this.dispatchOwnedByBranch(parentSession.sessionManager.getBranch(), current)) {
      throw new SubagentError('This subagent run is no longer part of the current conversation branch')
    }
    const releaseSlot = state.reserve(this.host.maxConcurrentSubagents())
    state.resuming.add(sessionId)
    const controller = new AbortController()
    const onSignalAbort = () => controller.abort()
    options.foregroundSignal?.addEventListener('abort', onSignalAbort, { once: true })
    state.starting.add(controller)
    let launchSettled: () => void
    const launchDone = new Promise<void>((resolve) => { launchSettled = resolve })
    state.launching.add(launchDone)
    let releaseCreationLease: (() => void) | null = null
    try {
      releaseCreationLease = this.host.acquireRunLease(cwd, current.start.parentSessionPath)
      if (controller.signal.aborted) throw new SubagentError('Subagent cancelled before launch')
      const runId = randomUUID()
      const parentAvailable = new Set(parentDelegableToolNames(
        parentSession.getActiveToolNames(),
        parentSession.getCallableToolNames(),
        this.host.frozenToolCeiling(current.start.parentSessionPath)
      ))
      const planRestricted = current.start.resource.planRestricted === true || this.host.planRestricted(current.start.parentSessionPath)
      const tools = current.start.resource.tools.filter(name =>
        (name !== 'debug' || this.host.profileDebugEnabled?.(cwd, current.start.profile) === true) &&
        (parentAvailable.has(name) || (name === MESSAGE_PARENT_TOOL_NAME && this.host.subagentCommsEnabled())) &&
        !(SUBAGENT_EXCLUDED_TOOLS as readonly string[]).includes(name))
      const { extensions: _extensions, maxTurns: _previousMaxTurns, ...previousResource } = current.start.resource
      const resource: SubagentRunStartData['resource'] = { ...previousResource, tools,
        ...(planRestricted ? { planRestricted: true as const } : {}),
        ...(!planRestricted && ceilingNeedsExtensions(tools, parentSession.getAllTools()) ? { extensions: true as const } : {}) }
      if (!tools.length) throw new SubagentError('The resumed subagent has no tools within the current parent ceiling')
      const child = await this.host.createChildSession({
        mode: 'reopen', cwd,
        parentSessionPath: current.start.parentSessionPath,
        parentSessionId: parentSession.sessionId,
        runId,
        resource,
        profile: current.start.profile,
        sessionPath: rosterEntry.sessionPath
      })
      const releaseRunLease = await this.leaseChild(child)
      releaseCreationLease()
      releaseCreationLease = null
      const { run, completion } = await this.trackRun(state, child, {
        parentToolCallId: options.parentToolCallId ?? current.start.parentToolCallId,
        profile: current.start.profile,
        description: options.description ?? current.start.description,
        task: current.start.task,
        runInBackground: options.runInBackground ?? current.start.runInBackground,
        maxTurns: options.maxTurns,
        createdAt: current.start.createdAt
      }, releaseRunLease, controller.signal, options.foregroundSignal, text, parentSession.sessionManager)
      return { run, completion }
    } finally {
      state.resuming.delete(sessionId)
      state.starting.delete(controller)
      state.launching.delete(launchDone)
      launchSettled!()
      options.foregroundSignal?.removeEventListener('abort', onSignalAbort)
      releaseCreationLease?.()
      releaseSlot()
    }
  }

  /** Whether a child run's dispatch is still owned by the parent's selected
   * branch: an explicit `pith_subagent_dispatch` entry for the runId, or —
   * for legacy records written before dispatch entries existed — a visible
   * `agent` tool result carrying its parent tool call id. */
  private dispatchOwnedByBranch(branch: readonly unknown[], run: DiskSubagentRun): boolean {
    if (run.start.parentDispatch === true) {
      return branch.some((entry) => {
        if ((entry as any).type !== 'custom' || (entry as any).customType !== SUBAGENT_DISPATCH_TYPE) return false
        const data = (entry as any).data as { runId?: unknown } | undefined
        return data?.runId === run.start.runId
      })
    }
    return branch.some((entry) => {
      if ((entry as any).type !== 'message') return false
      const message = (entry as any).message as ChatMessage
      return message.role === 'toolResult' && message.toolCallId === run.start.parentToolCallId
    })
  }

  private async leaseChild(child: ChildSessionHandle): Promise<() => void> {
    try { return this.host.acquireRunLease(child.cwd, child.path) }
    catch (error) {
      try { await child.halt() } finally { await child.release() }
      throw error
    }
  }

  /** Newest-first run records of a child session file. */
  readChildRuns(sessionPath: string): DiskSubagentRun[] {
    try {
      const child = SessionManager.open(sessionPath)
      return readDiskSubagentRuns(child.getEntries() as any[]).reverse()
    } catch {
      return []
    }
  }

  steer(state: SubagentParentState, sessionId: string, message: string, expectedRunId?: string): void {
    const live = this.liveRunOf(state, sessionId)
    if (expectedRunId !== undefined && live?.run.runId !== expectedRunId) {
      throw new SubagentError('Subagent run changed; choose the action again')
    }
    if (!live) throw new SubagentError('Subagent is not running')
    live.child.session.steer(message)
  }

  /** Abort one run. Suppression keeps the completion from waking the parent:
   * a stopped task must not restart the conversation. Fire-and-forget; use
   * {@link stopAll} when the caller must wait for the halt to settle. */
  abort(state: SubagentParentState, sessionId: string, expectedRunId?: string): void {
    const live = this.liveRunOf(state, sessionId)
    if (expectedRunId !== undefined && live?.run.runId !== expectedRunId) {
      throw new SubagentError('Subagent run changed; choose the action again')
    }
    if (live) void this.haltLiveRun(state, live).catch(() => {})
  }

  abortAll(state: SubagentParentState | null): void {
    if (!state) return
    for (const live of [...state.runs.values()]) void this.haltLiveRun(state, live).catch(() => {})
    this.abortStarting(state)
  }

  /** Abort launches that have not produced a session yet. */
  private abortStarting(state: SubagentParentState): void {
    for (const controller of [...state.starting]) controller.abort()
  }

  /**
   * Stop every run of a parent and WAIT (bounded) for their halts to settle —
   * the entry point for rewind/resend/delete, where proceeding while a child
   * still writes files (or still holds its coordinator lease) would race the
   * operation that follows.
   */
  async stopAll(state: SubagentParentState | null): Promise<void> {
    if (!state) return
    this.abortStarting(state)
    // Wait for in-flight launches to unwind (their finally releases slots,
    // leases and controllers) before declaring the stop settled — a launch
    // that is still creating would otherwise start its prompt right after.
    const launches = [...state.launching]
    if (launches.length) await this.awaitStop(Promise.all(launches))
    this.abortStarting(state)
    const halts = [...state.runs.values()].map((live) => this.haltLiveRun(state, live))
    if (halts.length) await this.awaitStop(Promise.all(halts))
  }

  private async awaitStop(operation: Promise<unknown>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([operation, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new SubagentError('Subagent is still stopping; retry after it settles')), STOP_SETTLE_MS)
      })])
    } finally { clearTimeout(timer) }
  }

  /**
   * Suppress + halt one live run: mark it stopped, drop its pending
   * notification, then stop everything the child owns (wake path, queues,
   * background processes, SDK run) and wait for the run's completion.
   */
  private async haltLiveRun(state: SubagentParentState, live: LiveRun | undefined): Promise<void> {
    if (!live) return
    live.suppressNotify = true
    live.userAborted = true
    state.notifications?.drop(live.run.runId)
    live.halting ??= Promise.resolve().then(() => live.child.halt())
    await live.halting
    await live.completion
  }

  liveRunOf(state: SubagentParentState, sessionId: string): LiveRun | undefined {
    for (const live of state.runs.values()) if (live.run.sessionId === sessionId) return live
    return undefined
  }

  /** Restore a parent's roster from disk children. Interrupted runs surface
   * as `interrupted` cards — v1 does not wake them automatically. */
  recover(state: SubagentParentState, cwd: string, parentSessionPath: string, sessionDir?: string): void {
    let infos
    try { infos = SessionManager.list(cwd, sessionDir) } catch { return }
    void Promise.resolve(infos).then(async (list) => {
      for (const info of list) {
        if (info.parentSessionPath !== parentSessionPath) continue
        // Opening a session file and reading all of its entries is synchronous
        // IO: yield between children so a large roster cannot stall the main
        // process for the whole scan.
        await new Promise<void>((resolve) => setImmediate(resolve))
        try {
          const child = SessionManager.open(info.path)
          const dto = currentDiskRun(child.getEntries() as any[], child.getSessionId(), info.path)
          // A live seq (not 0): the renderer merges roster state by seq, and a
          // disk row must outrank any stale cached card it replaces.
          if (dto && !state.roster.has(dto.sessionId)) {
            dto.seq = state.nextSeq()
            if (state.apply(slimRunForRoster(dto))) {
              this.host.emitSubagents(state.sessionId, parentSessionPath, state.snapshot())
            }
          }
        } catch { /* unreadable child stays off the roster */ }
      }
    }).catch(() => { /* a failed scan must not surface as an unhandled rejection */ })
  }

  /**
   * File paths that subagent runs wrote into the working tree after
   * `afterEntryId` on the parent's selected branch — the evidence base rewind
   * coverage needs for child-session writes (the parent branch only sees the
   * `agent` tool call, never the child's edit/write results).
   *
   * Only runs whose `agent` tool call succeeded on the branch after the
   * anchor contribute, and only their persisted successful-written records.
   */
  async collectSubagentWritePaths(parentSessionManager: SessionManagerType, cwd: string, afterEntryId: string | null, sessionDir?: string): Promise<string[]> {
    const branch = parentSessionManager.getBranch()
    const anchor = afterEntryId === null ? -1 : branch.findIndex((entry) => entry.id === afterEntryId)
    // A named anchor that no longer exists means the branch moved under us:
    // silently scanning from the root would attribute OLD runs to this
    // checkpoint. Fail loudly instead.
    if (afterEntryId !== null && anchor < 0) throw new Error('Subagent write scan lost its checkpoint anchor')
    // EVERY agent call after the anchor contributes evidence — a run that
    // failed, was stopped or crashed may still have committed writes before
    // its terminal state; the run's outcome never erases file side effects.
    const agentCallIds = new Set<string>()
    for (const entry of branch.slice(anchor + 1)) {
      if (entry.type !== 'message') continue
      const message = entry.message as ChatMessage
      if (message.role !== 'assistant') continue
      for (const part of message.content) {
        if (part.type === 'toolCall' && part.name === 'agent') agentCallIds.add(part.id)
      }
    }
    const dispatches = new Map<string, string>()
    for (const entry of branch.slice(anchor + 1)) {
      if (entry.type !== 'custom' || entry.customType !== SUBAGENT_DISPATCH_TYPE) continue
      const data = entry.data as { runId?: string; sessionPath?: string } | undefined
      if (typeof data?.runId === 'string' && typeof data.sessionPath === 'string') dispatches.set(data.runId, data.sessionPath)
    }
    if (!agentCallIds.size && !dispatches.size) return []
    const parentFile = parentSessionManager.getSessionFile()
    if (!parentFile) return []
    const paths = new Set<string>()
    // 1) Evidence persisted on the PARENT branch: the `agent` tool result
    // (foreground runs — a failed delegation keeps its details through the
    // error hook) and the `subagent_completion` notice (background runs) both
    // carry the run's writtenFiles. This survives a child file that was
    // deleted or is unreadable, and it is what keeps one missing file from
    // making the whole rewind preview fail.
    for (const entry of branch.slice(anchor + 1)) {
      if (entry.type !== 'message') continue
      const message = entry.message as ChatMessage & { details?: unknown }
      const completion = message.role === 'custom' && message.customType === SUBAGENT_COMPLETION_TYPE
      if (!completion && !(message.role === 'toolResult' && message.toolName === SUBAGENT_TOOL_NAME)) continue
      const run = (message.details as { subagent?: SubagentRunDTO } | undefined)?.subagent
      for (const written of run?.writtenFiles ?? []) if (written?.filePath) paths.add(written.filePath)
    }
    // 2) The children's own branches: the only source for runs the parent never
    // recorded a terminal payload for (interrupted/crashed, or a background run
    // whose notice never arrived). A missing file is SKIPPED, never fatal: the
    // parent's CAS never covered child writes, so an unreadable child degrades
    // this diagnostic to the parent's own record instead of blocking every
    // rewind of the session.
    const infos = await SessionManager.list(cwd, sessionDir)
    const files = new Set([...dispatches.values(), ...infos.filter(info => info.parentSessionPath === parentFile).map(info => info.path)])
    for (const file of files) {
      if (!existsSync(file)) continue
      let child: SessionManagerType
      try { child = SessionManager.open(file) } catch { continue }
      if (child.getHeader()?.parentSession !== parentFile) continue
      for (const run of readDiskSubagentRuns(child.getEntries())) {
        if (run.start.parentDispatch ? dispatches.get(run.start.runId) !== file : !agentCallIds.has(run.start.parentToolCallId)) continue
        // Read committed operation evidence, including failures and interrupted
        // runs, from this run's own branch interval. Never borrow later resumes.
        for (const written of extractSubagentWrittenFiles(runMessages(child, run.startEntryId, run.resultEntryId), child.getCwd())) {
          paths.add(written.filePath)
        }
        // A terminal record that survived the branch read also names its files.
        for (const written of run.result?.writtenFiles ?? []) if (written?.filePath) paths.add(written.filePath)
      }
    }
    return [...paths]
  }

  /**
   * Drive one run to completion on a prepared child session. All status
   * transitions funnel through here, and every roster mutation happens on a
   * runId-owned record with a fresh seq, so a late event from a superseded
   * run can never overwrite the current card.
   *
   * `releaseRunLease` is held for the ENTIRE run — model work, background
   * drain and cleanup — and released only in the completion's finally.
   */
  private async trackRun(
    state: SubagentParentState,
    child: ChildSessionHandle,
    identity: {
      parentToolCallId: string
      profile: string
      description: string
      task: string
      runInBackground: boolean
      createdAt?: string
      maxTurns?: number
    },
    releaseRunLease: () => void,
    /** Cancellation of the LAUNCH (controller signal): checked again right
     * before the prompt, inside the completion — a stop that landed while the
     * child session was being created must not still start the run. */
    launchSignal?: AbortSignal,
    /** The tool call's abort signal (foreground runs): wired for the run's
     * WHOLE lifetime, not just the launch. */
    externalSignal?: AbortSignal,
    promptOverride?: string,
    parentManager?: SessionManagerType
  ): Promise<{ run: SubagentRunDTO; completion: Promise<SubagentRunDTO> }> {
    const runId = child.runId
    const createdAt = identity.createdAt ?? new Date().toISOString()
    const parentSessionPath = this.parentPathOf(child)
    const startData: SubagentRunStartData = {
      version: 1,
      ...(parentManager ? { parentDispatch: true as const } : {}),
      runId,
      parentSessionId: child.parentSessionId,
      parentSessionPath,
      parentToolCallId: identity.parentToolCallId,
      profile: identity.profile,
      description: identity.description,
      task: identity.task,
      runInBackground: identity.runInBackground,
      createdAt,
      ...(child.goalOwner ? { goalOwner: child.goalOwner } : {}),
      resource: child.resource
    }
    // A run without its persisted start record has no recoverable identity:
    // fail the dispatch instead of running untracked. Until the completion
    // below takes ownership, THIS scope owns the lease and the child — a
    // throw here must release both or every later restore stays blocked.
    let startEntryId: string
    let maxTurns: number | undefined
    try {
      // Resolve after all launch awaits: revoking the grant during session
      // creation also revokes a held override. Neither a profile nor an old
      // run snapshot can supply a limit when the user's setting is blank.
      maxTurns = this.host.subagentTurnLimitOverrideEnabled()
        ? identity.maxTurns ?? this.host.subagentMaxTurns() ?? undefined
        : this.host.subagentMaxTurns() ?? undefined
      if (maxTurns !== undefined && (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > SUBAGENT_MAX_TURNS_LIMIT)) {
        throw new SubagentError('Invalid subagent turn limit')
      }
      if (maxTurns === undefined) delete child.resource.maxTurns
      else child.resource.maxTurns = maxTurns
      startEntryId = child.sessionManager.appendCustomEntry(SUBAGENT_RUN_TYPE, startData)
      parentManager?.appendCustomEntry(SUBAGENT_DISPATCH_TYPE, { version: 1, runId,
        sessionId: child.session.sessionId, sessionPath: child.path, parentToolCallId: identity.parentToolCallId })
    } catch (error) {
      try { await child.halt() } finally {
        try { await child.release() } finally { releaseRunLease() }
      }
      throw error
    }

    const base: SubagentRunDTO = {
      runId,
      sessionId: child.session.sessionId,
      sessionPath: child.path,
      parentToolCallId: identity.parentToolCallId,
      profile: identity.profile,
      description: identity.description,
      task: identity.task,
      runInBackground: identity.runInBackground,
      status: 'running',
      createdAt,
      model: child.resource.model,
      tools: [...child.resource.tools],
      seq: 0
    }
    const publish = (patch: Partial<SubagentRunDTO>): SubagentRunDTO => {
      const run = { ...base, ...patch, seq: state.nextSeq() }
      // The full row goes back to the caller (the `agent` tool result and the
      // subagent_completion notice carry the patches); the roster keeps only
      // the panel metadata that every tick re-serializes.
      if (state.apply(slimRunForRoster(run))) this.host.emitSubagents(state.sessionId, parentSessionPath, state.snapshot())
      return run
    }
    publish({})

    let tokens = 0
    let toolUses = 0
    let assistantRounds = 0
    // The runtime ended the run at the dispatched turn limit: a designed end,
    // distinct from a user stop (see deriveRunOutcome).
    let turnLimitReached = false
    let progressTimer: ReturnType<typeof setTimeout> | null = null
    let lastPublish = 0
    const publishProgress = (): void => {
      const elapsed = Date.now() - lastPublish
      if (elapsed < 1000) {
        if (!progressTimer) progressTimer = setTimeout(() => { progressTimer = null; publishProgress() }, 1000 - elapsed)
        return
      }
      if (progressTimer) { clearTimeout(progressTimer); progressTimer = null }
      lastPublish = Date.now()
      publish({ tokens, toolUses })
    }
    const unsubscribe = child.session.subscribe((event: AgentSessionEvent) => {
      const message = 'message' in event ? (event as any).message as ChatMessage | undefined : undefined
      if (event.type === 'message_end' && message?.role === 'assistant') {
        assistantRounds++
        const usage = (message as any).usage
        if (usage && typeof usage.totalTokens === 'number') tokens += usage.totalTokens
        else if (usage && typeof usage.tokens === 'number') tokens += usage.tokens
        if (maxTurns !== undefined) {
          if (assistantRounds === maxTurns && !child.session.isIdle) {
            void child.session.steer('You have reached your turn limit. Wrap up immediately with your best current answer; do not start new work.')
          } else if (assistantRounds > maxTurns) {
            turnLimitReached = true
            void child.session.abort().catch(() => {})
          }
        }
        publishProgress()
      } else if (event.type === 'tool_execution_end') {
        toolUses++
        publishProgress()
      }
    })

    const live: LiveRun = { run: base, child, suppressNotify: false, userAborted: false, completion: null as any }
    // The tool call's abort is live for the WHOLE run (a foreground parent
    // round aborted mid-run must halt its subagent, not just its launch).
    const onExternalAbort = () => { void this.haltLiveRun(state, live).catch(() => {}) }
    externalSignal?.addEventListener('abort', onExternalAbort, { once: true })
    // Register ownership before even a cancelled/empty prompt can complete.
    const completion = Promise.resolve().then(async (): Promise<SubagentRunDTO> => {
      let promptError: string | undefined
      if (launchSignal?.aborted || externalSignal?.aborted || live.userAborted) {
        // The stop raced the launch: never prompt, settle as aborted.
        live.userAborted = true
        live.suppressNotify = true
        await child.halt()
      } else {
        try {
          await child.session.prompt(promptOverride ?? identity.task, { source: 'rpc' })
          await this.drainChildBackgroundTasks(child)
        } catch (error) {
          promptError = error instanceof Error ? error.message : String(error)
          await child.halt()
        }
      }

      // Status derivation never trusts prompt() resolving on its own: an
      // errored final assistant round resolves normally, so the SDK's own
      // stopReason (plus our abort bookkeeping) decides.
      const messages = child.session.messages as ChatMessage[]
      const last = [...messages].reverse().find((message) => message.role === 'assistant')
      const stopReason = (last as any)?.stopReason
      const outcomeInput = {
        userAborted: live.userAborted,
        turnLimitReached,
        stopReason,
        errorMessage: String((last as any)?.error ?? (last as any)?.errorMessage ?? '') || undefined,
        promptError
      }
      const outcome = deriveRunOutcome(outcomeInput)
      const text = child.session.getLastAssistantText()?.trim()
      let writtenFiles: SubagentWrittenFileDTO[] | undefined
      try {
        // The full message list (not the live context) so compaction of the
        // child's context cannot lose earlier writes.
        writtenFiles = extractSubagentWrittenFiles(runMessages(child.sessionManager, startEntryId), child.cwd) || undefined
        if (writtenFiles?.length) this.host.notifySubagentChildWrite(child.cwd)
      } catch { writtenFiles = undefined }

      const resultData: SubagentRunResultData = {
        version: 1,
        runId,
        writtenFilesScope: 'run',
        status: outcome.status,
        completedAt: new Date().toISOString(),
        ...(text ? { result: text } : {}),
        ...(outcome.error ? { error: outcome.error } : {}),
        ...(outcome.limitReached ? { limitReached: true as const } : {}),
        ...(writtenFiles ? { writtenFiles } : {})
      }
      // A terminal record that cannot be written is NOT a silent success: the
      // run reports `failed` with the reason and keeps its answer for triage.
      let persistenceError: string | undefined
      try {
        child.sessionManager.appendCustomEntry(SUBAGENT_RESULT_TYPE, resultData)
      } catch (cause) {
        persistenceError = `The run result could not be persisted (${cause instanceof Error ? cause.message : String(cause)}); reopening this child reads it as interrupted.`
      }
      const finalOutcome = persistenceError ? deriveRunOutcome({ ...outcomeInput, persistenceError }) : outcome

      const finished = publish({
        status: finalOutcome.status,
        completedAt: resultData.completedAt,
        writtenFilesScope: 'run',
        ...(text ? { result: text } : {}),
        ...(finalOutcome.error ? { error: finalOutcome.error } : {}),
        ...(finalOutcome.limitReached ? { limitReached: true } : {}),
        ...(writtenFiles ? { writtenFiles } : {}),
        tokens,
        toolUses
      })
      // Only a USER stop (or a branch operation) suppresses delivery; a run the
      // runtime itself ended — including one whose record could not be written
      // — still reports to the parent.
      if (!live.suppressNotify && !live.userAborted && identity.runInBackground) {
        state.notifications?.complete(finished)
      }
      return finished
    }).finally(async () => {
      unsubscribe()
      if (progressTimer) clearTimeout(progressTimer)
      externalSignal?.removeEventListener('abort', onExternalAbort)
      try { await child.release() } finally {
        state.runs.delete(runId)
        releaseRunLease()
      }
    })
    live.completion = completion
    state.runs.set(runId, live)
    return { run: base, completion }
  }

  private parentPathOf(child: ChildSessionHandle): string {
    const header: any = child.sessionManager.getHeader()
    return header?.parentSession ?? child.path
  }

  /**
   * Wait for the child's own background bash tasks. The child's notification
   * machinery steers completions back into the child with triggerTurn, which
   * wakes it for another round; the run is only over when the child is idle
   * AND has no live background commands. Bounded cycles guard a pathological
   * task that keeps re-arming.
   */
  private async drainChildBackgroundTasks(child: ChildSessionHandle): Promise<void> {
    const tasks = this.host.commandTasks()
    const deadline = Date.now() + 5 * 60_000
    for (let cycle = 0; cycle < DRAIN_MAX_CYCLES; cycle++) {
      // Process completion and its notification are separate handoffs. Give
      // queued delivery a turn before deciding that an empty task list is done.
      await sleep(0)
      const live = tasks?.list(child.path).filter((task) => task.background && taskIsLive(task)) ?? []
      if (!live.length && (child.isSettled?.() ?? child.session.isIdle)) return
      if (live.length && tasks) {
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          await Promise.race([tasks.wait(child.path, live[0].id), new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new SubagentError('Subagent background work did not settle')), Math.max(0, deadline - Date.now()))
          })])
        } finally { clearTimeout(timer) }
      }
      await this.waitForChildSettle(child, deadline)
    }
    throw new SubagentError('Subagent background work exceeded its continuation limit')
  }

  private async waitForChildSettle(child: ChildSessionHandle, deadline: number): Promise<void> {
    while (!(child.isSettled?.() ?? child.session.isIdle)) {
      if (Date.now() >= deadline) throw new SubagentError('Subagent completion delivery did not settle')
      await sleep(25)
    }
  }
}
