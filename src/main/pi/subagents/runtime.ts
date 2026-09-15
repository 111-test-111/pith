import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import type { AgentSession, AgentSessionEvent, SessionManager as SessionManagerType } from '@earendil-works/pi-coding-agent'
import type { BashTaskManager } from '../../bash/manager'
import { taskIsLive } from '../../bash/task-status.ts'
import type { ChatMessage, SubagentRunDTO, SubagentRunStatus, SubagentWrittenFileDTO, ThinkingLevel } from '../../../shared/types'
import type { SubagentProfile } from './profiles.ts'
import { extractSubagentWrittenFiles, loadSubagentInputFiles, parentContextText } from './derive.ts'
import { SubagentError } from './errors.ts'
import {
  applyRunToRoster,
  currentDiskRun,
  readDiskSubagentRuns,
  SUBAGENT_EXCLUDED_TOOLS,
  SUBAGENT_RESULT_TYPE,
  SUBAGENT_RUN_TYPE,
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

/** Everything a start needs, resolved by the tool layer. */
export interface StartSubagentRequest {
  parentSession: AgentSession
  parentSessionPath: string
  parentToolCallId: string
  profile: SubagentProfile
  description: string
  task: string
  runInBackground: boolean
  modelSpec?: string
  thinkingLevel?: ThinkingLevel
  maxTurns?: number
  inheritContext?: boolean
  inputFiles?: string[]
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
  /** Stop everything the child owns: its notification wake path, its queues,
   * its background bash processes and its SDK run. Awaitable. */
  halt: () => Promise<void>
  /** Dispose the child (abort + shutdown) unless the user is viewing it. */
  release: () => void
}

/** Host capabilities the runtime needs from PiManager; keeps this module free
 * of a manager import (no module cycle). */
export interface SubagentHost {
  isClosing(): boolean
  maxConcurrentSubagents(): number
  subagentsEnabled(): boolean
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
  private seqCounter = 0
  private startingCount = 0
  readonly runs = new Map<string, LiveRun>()
  readonly starting = new Set<AbortController>()
  notifications: SubagentNotifications | null = null

  readonly sessionId: string

  constructor(sessionId: string) { this.sessionId = sessionId }

  nextSeq(): number { return ++this.seqCounter }

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
    let active = 0
    for (const run of this.roster.values()) if (run.status === 'running') active++
    return active
  }

  snapshot(): SubagentRunDTO[] {
    return [...this.roster.values()].sort(
      (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.seq - a.seq
    )
  }

  apply(run: SubagentRunDTO): boolean {
    return applyRunToRoster(this.roster, run)
  }
}

function sleep(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)) }

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
    // Register for cancellation BEFORE any await: a Stop issued while the
    // model/session is still being resolved must abort the launch, not race it.
    const controller = new AbortController()
    state.starting.add(controller)
    const onSignalAbort = () => controller.abort()
    signal?.addEventListener('abort', onSignalAbort, { once: true })
    const releaseSlot = state.reserve(this.host.maxConcurrentSubagents())
    let releaseCreationLease: (() => void) | null = null
    try {
      if (signal?.aborted || controller.signal.aborted) throw new SubagentError('Subagent cancelled before launch')
      const cwd = request.parentSession.sessionManager.getCwd()
      releaseCreationLease = this.host.acquireRunLease(cwd, request.parentSessionPath)
      const parentActive = new Set(request.parentSession.getActiveToolNames())
      const ceiling = (request.profile.tools === 'all'
        ? [...parentActive]
        : request.profile.tools.filter((tool) => parentActive.has(tool)))
        .filter((tool) => !(SUBAGENT_EXCLUDED_TOOLS as readonly string[]).includes(tool))
      if (!ceiling.length) throw new SubagentError(`Profile "${request.profile.name}" resolves to an empty tool set for this session`)
      const task = `${request.task}${loadSubagentInputFiles(request.inputFiles, cwd)}`
      const inherit = request.inheritContext ?? request.profile.inheritContext
      const { spec } = await this.host.resolveModelSpec(request.modelSpec ?? request.profile.model, request.parentSession)
      const maxTurns = request.maxTurns ?? request.profile.maxTurns
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
        ...(spec ? { model: spec } : {}),
        ...(thinking ? { thinkingLevel: thinking } : {}),
        ...(maxTurns !== undefined && Number.isInteger(maxTurns) && maxTurns > 0 ? { maxTurns } : {}),
        inheritContext: inherit,
        appendSystemPrompt
      }
      if (controller.signal.aborted) throw new SubagentError('Subagent cancelled before launch')
      const runId = randomUUID()
      const child = await this.host.createChildSession({
        mode: 'new', cwd,
        parentSessionPath: request.parentSessionPath,
        parentSessionId: request.parentSession.sessionId,
        runId, resource
      })
      // Swap the creation lease for a child-keyed run lease: it now covers the
      // whole run (model work, background drain, cleanup) and additionally
      // fences the parent's own checkpoint snapshots against live child writes.
      const releaseRunLease = this.host.acquireRunLease(cwd, child.path)
      releaseCreationLease()
      releaseCreationLease = null
      const tracked = this.trackRun(state, child, {
        parentToolCallId: request.parentToolCallId,
        profile: request.profile.name,
        description: request.description,
        task,
        runInBackground: request.runInBackground || request.profile.runInBackground,
        maxTurns
      }, releaseRunLease)
      if (controller.signal.aborted) {
        // Stop raced the launch: halt the run we just registered.
        void this.haltLiveRun(state, this.liveRunOf(state, child.session.sessionId))
      }
      return tracked
    } finally {
      state.starting.delete(controller)
      signal?.removeEventListener('abort', onSignalAbort)
      releaseCreationLease?.()
      releaseSlot()
    }
  }

  /**
   * Continue a finished child session under a fresh runId. Shares the start
   * path's admission (slot + lease + enabled checks + cancellation) and
   * re-applies the dispatched turn limit from the persisted resource snapshot.
   */
  async resume(state: SubagentParentState, parentSession: AgentSession, sessionId: string, message: string): Promise<SubagentRunDTO> {
    if (this.host.isClosing()) throw new SubagentError('Application is shutting down')
    if (!this.host.subagentsEnabled()) throw new SubagentError('Subagents are disabled in Settings')
    const text = message.trim()
    if (!text) throw new SubagentError('Resume message is required')
    const rosterEntry = state.roster.get(sessionId)
    if (!rosterEntry) throw new SubagentError(`Subagent session not found: ${sessionId}`)
    if (rosterEntry.status === 'running') throw new SubagentError('Subagent is already running')
    const cwd = parentSession.sessionManager.getCwd()
    const current = this.readChildRuns(rosterEntry.sessionPath)[0]
    if (!current) throw new SubagentError(`Subagent session not found: ${sessionId}`)
    const controller = new AbortController()
    state.starting.add(controller)
    const releaseSlot = state.reserve(this.host.maxConcurrentSubagents())
    let releaseCreationLease: (() => void) | null = null
    try {
      releaseCreationLease = this.host.acquireRunLease(cwd, current.start.parentSessionPath)
      if (controller.signal.aborted) throw new SubagentError('Subagent cancelled before launch')
      const runId = randomUUID()
      const child = await this.host.createChildSession({
        mode: 'reopen', cwd,
        parentSessionPath: current.start.parentSessionPath,
        parentSessionId: parentSession.sessionId,
        runId,
        resource: current.start.resource,
        sessionPath: rosterEntry.sessionPath
      })
      const releaseRunLease = this.host.acquireRunLease(cwd, child.path)
      releaseCreationLease()
      releaseCreationLease = null
      const { completion } = this.trackRun(state, child, {
        parentToolCallId: current.start.parentToolCallId,
        profile: current.start.profile,
        description: current.start.description,
        task: current.start.task,
        runInBackground: current.start.runInBackground,
        maxTurns: current.start.resource.maxTurns,
        createdAt: current.start.createdAt
      }, releaseRunLease, text)
      if (controller.signal.aborted) void this.haltLiveRun(state, this.liveRunOf(state, child.session.sessionId))
      return completion
    } finally {
      state.starting.delete(controller)
      releaseCreationLease?.()
      releaseSlot()
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

  steer(state: SubagentParentState, sessionId: string, message: string): void {
    const live = this.liveRunOf(state, sessionId)
    if (!live) throw new SubagentError('Subagent is not running')
    live.child.session.steer(message)
  }

  /** Abort one run. Suppression keeps the completion from waking the parent:
   * a stopped task must not restart the conversation. Fire-and-forget; use
   * {@link stopAll} when the caller must wait for the halt to settle. */
  abort(state: SubagentParentState, sessionId: string): void {
    const live = this.liveRunOf(state, sessionId)
    if (live) void this.haltLiveRun(state, live)
    this.abortStarting(state)
  }

  abortAll(state: SubagentParentState | null): void {
    if (!state) return
    for (const live of [...state.runs.values()]) void this.haltLiveRun(state, live)
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
    const halts = [...state.runs.values()].map((live) => this.haltLiveRun(state, live))
    if (halts.length) await Promise.race([Promise.all(halts), sleep(STOP_SETTLE_MS)])
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
    try { await live.child.halt() } catch { /* the completion below still settles */ }
    await Promise.race([live.completion.catch(() => {}), sleep(STOP_SETTLE_MS)])
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
    void Promise.resolve(infos).then((list) => {
      for (const info of list) {
        if (info.parentSessionPath !== parentSessionPath) continue
        try {
          const child = SessionManager.open(info.path)
          const dto = currentDiskRun(child.getEntries() as any[], child.getSessionId(), info.path)
          if (dto && state.apply(dto)) {
            this.host.emitSubagents(state.sessionId, parentSessionPath, state.snapshot())
          }
        } catch { /* unreadable child stays off the roster */ }
      }
    })
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
    const agentCallIds = new Set<string>()
    for (const entry of branch) {
      if (entry.type !== 'message') continue
      const message = entry.message as ChatMessage
      if (message.role !== 'assistant') continue
      for (const part of message.content) {
        if (part.type === 'toolCall' && part.name === 'agent') agentCallIds.add(part.id)
      }
    }
    if (!agentCallIds.size) return []
    // Only calls whose result arrived and did not fail delegated real work.
    const succeeded = new Set<string>()
    for (const entry of branch.slice(anchor + 1)) {
      if (entry.type !== 'message') continue
      const message = entry.message as ChatMessage
      if (message.role === 'toolResult' && !message.isError && agentCallIds.has(message.toolCallId)) {
        succeeded.add(message.toolCallId)
      }
    }
    if (!succeeded.size) return []
    const parentFile = parentSessionManager.getSessionFile()
    if (!parentFile) return []
    const paths = new Set<string>()
    let infos
    try { infos = await SessionManager.list(cwd, sessionDir) } catch { return [] }
    for (const info of infos) {
      if (info.parentSessionPath !== parentFile) continue
      for (const run of this.readChildRuns(info.path)) {
        if (!succeeded.has(run.start.parentToolCallId) || !run.result) continue
        for (const file of run.result.writtenFiles ?? []) paths.add(file.filePath)
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
  private trackRun(
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
    promptOverride?: string
  ): { run: SubagentRunDTO; completion: Promise<SubagentRunDTO> } {
    const runId = child.runId
    const createdAt = identity.createdAt ?? new Date().toISOString()
    const parentSessionPath = this.parentPathOf(child)
    const startData: SubagentRunStartData = {
      version: 1,
      runId,
      parentSessionId: child.parentSessionId,
      parentSessionPath,
      parentToolCallId: identity.parentToolCallId,
      profile: identity.profile,
      description: identity.description,
      task: identity.task,
      runInBackground: identity.runInBackground,
      createdAt,
      resource: child.resource
    }
    // A run without its persisted start record has no recoverable identity:
    // fail the dispatch instead of running untracked.
    child.sessionManager.appendCustomEntry(SUBAGENT_RUN_TYPE, startData)

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
      seq: 0
    }
    const publish = (patch: Partial<SubagentRunDTO>): SubagentRunDTO => {
      const run = { ...base, ...patch, seq: state.nextSeq() }
      if (state.apply(run)) this.host.emitSubagents(state.sessionId, parentSessionPath, state.snapshot())
      return run
    }
    publish({})

    let tokens = 0
    let toolUses = 0
    let assistantRounds = 0
    let maxTurnsReached = false
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
        if (usage && typeof usage.totalTokens === 'number') tokens = usage.totalTokens
        else if (usage && typeof usage.tokens === 'number') tokens = usage.tokens
        if (identity.maxTurns !== undefined && identity.maxTurns > 0) {
          if (assistantRounds === identity.maxTurns && !child.session.isIdle) {
            maxTurnsReached = true
            void child.session.steer('You have reached your turn limit. Wrap up immediately with your best current answer; do not start new work.')
          } else if (assistantRounds > identity.maxTurns) {
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
    const completion = (async (): Promise<SubagentRunDTO> => {
      let promptError: string | undefined
      try {
        await child.session.prompt(promptOverride ?? identity.task, { source: 'rpc' })
        await this.drainChildBackgroundTasks(child)
      } catch (error) {
        promptError = error instanceof Error ? error.message : String(error)
      } finally {
        unsubscribe()
        if (progressTimer) clearTimeout(progressTimer)
      }

      // Status derivation never trusts prompt() resolving on its own: an
      // errored final assistant round resolves normally, so the SDK's own
      // stopReason (plus our abort bookkeeping) decides.
      const messages = child.session.messages as ChatMessage[]
      const last = [...messages].reverse().find((message) => message.role === 'assistant')
      const stopReason = (last as any)?.stopReason
      let status: SubagentRunStatus
      let error: string | undefined
      if (live.userAborted || stopReason === 'aborted') status = 'aborted'
      else if (maxTurnsReached) status = 'completed'
      else if (stopReason === 'error') {
        status = 'failed'
        error = String((last as any)?.error ?? (last as any)?.errorMessage ?? 'The subagent ended with an error')
      } else if (promptError !== undefined) {
        status = 'failed'
        error = promptError
      } else status = 'completed'
      const text = child.session.getLastAssistantText()?.trim()
      let writtenFiles: SubagentWrittenFileDTO[] | undefined
      try {
        // The full message list (not the live context) so compaction of the
        // child's context cannot lose earlier writes.
        writtenFiles = extractSubagentWrittenFiles(child.session.sessionManager.getBranch().map((entry) => (entry.type === 'message' ? entry.message as ChatMessage : null)).filter((message): message is ChatMessage => message !== null), child.cwd) || undefined
        if (writtenFiles?.length) this.host.notifySubagentChildWrite(child.cwd)
      } catch { writtenFiles = undefined }

      const resultData: SubagentRunResultData = {
        version: 1,
        runId,
        status,
        completedAt: new Date().toISOString(),
        ...(text ? { result: text } : {}),
        ...(error ? { error } : {}),
        ...(writtenFiles ? { writtenFiles } : {})
      }
      try { child.sessionManager.appendCustomEntry(SUBAGENT_RESULT_TYPE, resultData) } catch { /* best-effort; reads back as interrupted */ }

      const finished = publish({
        status,
        completedAt: resultData.completedAt,
        ...(text ? { result: text } : {}),
        ...(error ? { error } : {}),
        ...(writtenFiles ? { writtenFiles } : {}),
        tokens,
        toolUses
      })
      state.runs.delete(runId)
      if (!live.suppressNotify && identity.runInBackground && status !== 'aborted') {
        state.notifications?.complete(finished)
      }
      child.release()
      return finished
    })().finally(() => releaseRunLease())
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
    if (!tasks) return
    for (let cycle = 0; cycle < DRAIN_MAX_CYCLES; cycle++) {
      const live = tasks.list(child.path).filter((task) => task.background && taskIsLive(task))
      if (!live.length) return
      await Promise.race([tasks.wait(child.path, live[0].id).catch(() => {}), sleep(60_000)])
      await this.waitForChildSettle(child)
    }
  }

  private waitForChildSettle(child: ChildSessionHandle): Promise<void> {
    if (child.session.isIdle) return Promise.resolve()
    return new Promise<void>((resolve) => {
      const timer = setTimeout(done, 120_000)
      const unsubscribe = child.session.subscribe((event: AgentSessionEvent) => {
        if (event.type === 'agent_settled') done()
      })
      function done(): void {
        clearTimeout(timer)
        unsubscribe()
        resolve()
      }
    })
  }
}
