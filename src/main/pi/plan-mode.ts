/**
 * Plan Mode's session-level state machine: the working mode, the admission
 * rules every entry point shares, and the live metadata the renderer reads.
 *
 * Three separations are load-bearing and easy to undo by accident:
 *
 * - **Mode is not sandbox.** `SessionMode` never joins `SandboxMode`. Plan
 *   overlays `read-only` on the effective value (what the tools read) while the
 *   session's stored/default choice stays what the user picked; leaving plan
 *   restores that choice instead of guessing a new one.
 * - **Restriction is fail-closed.** An unknown `pith_plan_mode` version folds to
 *   `mode: normal` plus `unsupported: true`, so every restriction and admission
 *   decision checks `unsupported` too — never `mode` alone. A record we cannot
 *   explain stays restricted and cannot approve or execute anything.
 * - **The lock is not a flag.** `transition()` takes the session lock
 *   synchronously and admission (`checkWorkAdmission`, `beginWork`) refuses
 *   while it is held, so a mode change cannot interleave with a prompt whose
 *   preparation the SDK still considers idle.
 *
 * Business rules live here; PiManager only wires lifecycle and facts.
 */
import { hasPlanOpening } from './plan-approval-access'
import { randomUUID } from 'node:crypto'
import type { SessionManager } from '@earendil-works/pi-coding-agent'
import type { PlanBlocker, PlanStateDTO, SessionMode } from '../../shared/plan'
import type { SandboxMode } from '../sandbox/types'
import { PLAN_MODE_ENTRY, isCurrentPlan, isRevisionPending, parsePlanSubmission, planExecutionTurnId, reconstructPlan, type PlanBranchState } from './plan-protocol'
import { normalizePlan } from './plan-submission'
import type { PlanStorage } from './plan-storage'

/**
 * The live facts a controller needs. Every field is app-owned (PiManager
 * derives it from the SDK, the task manager and the notification owners); the
 * controller never reaches into the SDK itself, so the same rules are testable
 * without a model or a sandbox.
 */
export interface PlanLiveFacts {
  /** Session initialization (extension startup) or a resource reload is running. */
  initializing: boolean
  closing: boolean
  /** This session is a subagent child: it follows its parent and has no mode. */
  child: boolean
  /** A rewind recovery is unresolved for this session's workspace. */
  recovery: boolean
  /** The SDK is genuinely idle — never `agent_end` or `!isStreaming` alone. */
  sdkIdle: boolean
  /** Live/stopping bash processes owned by this session. */
  tasks: number
  /** Subagent runs that are starting, launching or live. */
  subagents: number
  /** Undelivered/timed-out notification deliveries still owed to the model. */
  deliveries: number
  /** Structured questions the user has not answered. */
  questions: number
  /** One-shot sandbox escalation requests awaiting an answer. */
  escalations: number
  /** User steering/follow-up messages still queued in the SDK. */
  queuedMessages: number
  /** The user's own stored sandbox choice (not the plan overlay). */
  configuredSandboxMode: SandboxMode
  /** Frozen/current parent plan restriction, for a subagent child. */
  inheritedPlanRestriction: boolean
  /** What a confined shell can enforce right now, for the read-only overlay. */
  shellEnforcement: 'full' | 'partial' | 'unavailable'
}

/**
 * Raised when work cannot be admitted or a mode change cannot be applied.
 * `blockers` is the machine-readable reason list (`PlanActionResult.blockers`).
 */
export class PlanAdmissionError extends Error {
  readonly blockers: PlanBlocker[]

  constructor(message: string, blockers: readonly PlanBlocker[], cause?: unknown) {
    super(message)
    this.name = 'PlanAdmissionError'
    this.blockers = [...blockers]
    if (cause !== undefined) this.cause = cause
  }
}

export interface PlanControllerOptions {
  manager: SessionManager
  storage: PlanStorage
  facts: () => PlanLiveFacts
  /** Called whenever the published metadata changed (the manager emits it). */
  changed: () => void
  /**
   * Manager-allocated session-state clock. A managed rebuild of the same
   * session path must continue the sequence rather than restart it: the
   * renderer drops a `seq` it has already seen. Defaults to a process-wide
   * per-path clock, which keeps a four-field construction usable.
   */
  nextSeq?: () => number
}

/** Fallback clock for callers that do not own a manager-level one. */
const defaultClocks = new Map<string, number>()

function nextDefaultSeq(path: string): number {
  const next = (defaultClocks.get(path) ?? 0) + 1
  defaultClocks.set(path, next)
  return next
}

/**
 * Which `code` an admission refusal reports. A caller (IPC, tool gate) renders
 * it, so the most actionable reason wins; `blocked` is the generic fallback.
 */
const ERROR_CODE_PRIORITY: readonly PlanBlocker[] = [
  'storage',
  'unsupported-version',
  'transition',
  'child-session',
  'closing',
  'initializing',
  'recovery',
  'busy',
  'tasks',
  'subagents',
  'deliveries',
  'questions',
  'escalations',
  'queued-messages',
  'not-plan',
  'no-submission',
  'stale-submission',
  'already-submitted',
  'sandbox-unavailable',
  'sandbox-partial'
]

export function planErrorCode(blockers: readonly PlanBlocker[]): string {
  return ERROR_CODE_PRIORITY.find((code) => blockers.includes(code)) ?? 'blocked'
}

export class PlanController {
  private branchState: PlanBranchState
  private seq: number
  private publishedKey: string
  /** The session lock. Taken and released synchronously around `operation`. */
  private lock = false
  /** In-flight work registrations that must be over before a mode change. */
  private readonly reservations = new Set<symbol>()
  private branchReservations = 0
  /** App-owned user-turn registrations, the only key that opens the seal. */
  private userReservations = 0
  private sealed = false
  private sealedToolCallId: string | null = null
  /** Last observed wake admission, so the app is told only when it OPENS. */
  private wakeWasOpen = true
  private readonly nextSeq: () => number

  /** The session's own manager/storage/facts; a plain field, not a parameter
   *  property, so this module stays loadable by Node's type-stripping checks. */
  private readonly options: PlanControllerOptions

  /**
   * Called when background wakes become admissible again — a genuinely admitted
   * user turn lifted the submission seal, or a mode transition ended. The app
   * then re-flushes the notification owners so deferred completions are
   * delivered through their ordinary acknowledge discipline.
   */
  onWakeOpened?: () => void

  constructor(options: PlanControllerOptions) {
    this.options = options
    const path = this.sessionPath()
    this.nextSeq = options.nextSeq ?? (() => nextDefaultSeq(path))
    // Seed from the manager clock so a rebuilt controller can never republish a
    // sequence the renderer has already accepted.
    this.seq = this.nextSeq()
    this.branchState = reconstructPlan(options.manager.getBranch())
    // No `build()` here: `facts` reads the session object that is still being
    // constructed, so the first refresh/restore publishes the initial state.
    this.publishedKey = ''
  }

  private sessionPath(): string {
    return this.options.manager.getSessionFile() ?? `memory:${this.options.manager.getSessionId()}`
  }

  /** The folded state of the session's COMPLETE selected branch. */
  get branch(): PlanBranchState {
    return this.branchState
  }

  /** True while a mode transition holds the session lock. */
  get transitionBusy(): boolean {
    return this.lock
  }

  get workCount(): number { return this.reservations.size }
  get branchWork(): boolean { return this.branchReservations > 0 }
  /** Preparation ended; session-owned goal admission may be retried. */
  onWorkSettled?: () => void

  /**
   * True after a successful `submit_plan` committed in the current planning
   * turn. New background work must not pass it; a user turn lifts it.
   */
  get submissionLocked(): boolean {
    return this.sealed
  }

  /** The tool call that sealed the turn (exempt from its own submit blockers). */
  get submissionToolCallId(): string | null {
    return this.sealedToolCallId
  }

  /**
   * Fail-closed restriction: plan mode, an unexplained protocol version, or a
   * parent's live/frozen plan restriction (subagent children).
   */
  get restricted(): boolean {
    return this.isRestricted(this.build())
  }

  /** Current metadata. Blockers are read live; `seq` is the last published one. */
  get snapshot(): PlanStateDTO {
    return this.build()
  }

  /**
   * Re-fold the complete selected branch and republish. Called at managed
   * creation, after a reload, and after every branch move (resend's
   * navigateTree, rewind apply/undo/redo) — the mode is a fact about the
   * branch, so a stale live value would silently widen on the next reopen.
   */
  restore(): void {
    this.branchState = reconstructPlan(this.options.manager.getBranch())
    this.sealed = isCurrentPlan(this.branchState)
    this.publish(this.build())
  }

  /** Republish only when the metadata actually changed. */
  refresh(): void {
    const next = this.build()
    const key = this.contentKey(next)
    if (key === this.publishedKey) return
    this.publish(next)
  }

  /**
   * Run an operation under the session lock. The lock is taken synchronously
   * (before the first await) and the switch facts are checked while holding it,
   * so prompt/queue/branch/task/child admission cannot interleave with the
   * mode change. The operation should stay synchronous: that is what makes
   * check → save → apply atomic in a single event-loop turn.
   */
  async transition<T>(operation: () => Promise<T>, prepare?: () => Promise<void>): Promise<T> {
    return this.withTransition(operation, prepare, false)
  }

  /** Goal definition edits stop/drain work under the same admission lock.
   * Paused questions/deliveries stay owned for explicit Resume; they cannot wake here. */
  async editGoal<T>(operation: () => Promise<T>, prepare: () => Promise<void>): Promise<T> {
    return this.withTransition(operation, prepare, true)
  }

  private async withTransition<T>(operation: () => Promise<T>, prepare: (() => Promise<void>) | undefined, goalEdit: boolean): Promise<T> {
    if (this.lock) throw new PlanAdmissionError('A session mode change is already in progress', ['transition'])
    this.lock = true
    this.trackWakeAdmission()
    try {
      // Cancellation/draining of a session-owned wake happens under the same
      // lock, before checking the final idle facts. No Resume may enter here.
      if (prepare) await prepare()
      const blockers = this.factBlockers(this.options.facts(), false).filter(blocker =>
        !goalEdit || !['questions', 'deliveries', 'escalations'].includes(blocker))
      if (blockers.length) throw new PlanAdmissionError('The session is not ready for a mode change', blockers)
      return await operation()
    } finally {
      this.lock = false
      this.refresh()
      this.trackWakeAdmission()
      if (!this.reservations.size) this.onWorkSettled?.()
    }
  }

  /**
   * Switch this session's working mode. Durable before it is applied: the mode
   * entry is appended and fsynced first, and a failure rolls the in-memory leaf
   * back and publishes nothing.
   */
  async setMode(mode: SessionMode, prepare?: () => Promise<void>): Promise<PlanStateDTO> {
    if (mode !== 'normal' && mode !== 'plan') throw new Error(`Unknown session mode: ${String(mode)}`)
    await this.transition(async () => {
      if (this.approvalRecovery) throw new PlanAdmissionError('plan-recovery-required', ['recovery'])
      if (this.branchState.unsupported) {
        throw new PlanAdmissionError('This session was written by a newer plan protocol version', ['unsupported-version'])
      }
      const manager = this.options.manager
      const previousLeaf = manager.getLeafId()
      const data = mode === 'plan'
        ? { version: 1, mode: 'plan', planId: randomUUID(), via: 'toggle' }
        : { version: 1, mode: 'normal' }
      try {
        this.options.storage.append(PLAN_MODE_ENTRY, data)
      } catch (error) {
        // The SDK records the entry in memory BEFORE its write throws. Move the
        // leaf back so the failed entry cannot leak into a later fold or a
        // rewritten file, and publish nothing: a mode we could not persist is
        // not a mode we hold.
        this.rollback(previousLeaf)
        throw new PlanAdmissionError('The mode change could not be persisted', ['storage'], error)
      }
      // A mode change ends the previous planning cycle: its submission seal and
      // recorded tool call must not survive into the new mode.
      this.sealed = false
      this.sealedToolCallId = null
      this.branchState = reconstructPlan(manager.getBranch())
      this.publish(this.build())
      this.trackWakeAdmission()
    }, prepare)
    return this.build()
  }

  /**
   * Entry guard for every path that starts new work (prompt, queue surgery,
   * resend, a side-effecting tool, a process/child launch, a branch move).
   * Refuses a held transition lock, closing, storage/version failure or an
   * unresolved recovery. Kind-specific rules live in `beginWork` and in the
   * restriction itself.
   */
  checkWorkAdmission(): void {
    const facts = this.options.facts()
    if (this.approvalRecovery) throw new PlanAdmissionError('plan-recovery-required', ['recovery'])
    if (this.options.storage.failed) throw new PlanAdmissionError('plan-storage-locked', ['storage'])
    if (this.branchState.unsupported) throw new PlanAdmissionError('plan-unsupported-version', ['unsupported-version'])
    if (facts.recovery) throw new PlanAdmissionError('plan-recovery-required', ['recovery'])
    if (facts.closing) throw new PlanAdmissionError('The session is closing', ['closing'])
    if (this.lock) throw new PlanAdmissionError('A session mode change is in progress', ['transition'])
  }

  /**
   * Register in-flight work BEFORE the first await of its preparation, so a
   * mode change cannot slip into the window where the SDK still reports idle
   * (file reads, session materialization, reload barriers). The returned
   * release is idempotent and belongs in a `finally`.
   *
   * `background` may not pass a sealed planning turn (the model is done); a
   * `user` turn may always be requested, and only the app-owned user
   * registration can lift that seal.
   */
  beginWork(kind: 'user' | 'background' | 'branch'): () => void {
    this.checkWorkAdmission()
    if (kind === 'background' && this.sealed) {
      throw new PlanAdmissionError('This planning turn is already sealed by a plan submission', ['already-submitted'])
    }
    const token = Symbol(kind)
    this.reservations.add(token)
    if (kind === 'branch') this.branchReservations += 1
    if (kind === 'user') this.userReservations += 1
    this.refresh()
    let released = false
    return () => {
      if (released) return
      released = true
      this.reservations.delete(token)
      if (kind === 'branch') this.branchReservations = Math.max(0, this.branchReservations - 1)
      if (kind === 'user') this.userReservations = Math.max(0, this.userReservations - 1)
      this.refresh()
      if (!this.reservations.size) this.onWorkSettled?.()
    }
  }

  /**
   * A committed user message is the authoritative new planning turn: it
   * records the turn identity (what makes a submission current) and lifts the
   * submission seal. The entry must exist on this session's manager and be a
   * user message — an arbitrary id is not evidence.
   */
  observeCommittedUser(entryId: string): void {
    const id = entryId.trim()
    if (!id) return
    const entry = this.options.manager.getEntry(id)
    if (!entry || entry.type !== 'message') return
    if ((entry.message as { role?: string } | undefined)?.role !== 'user') return
    this.branchState = { ...this.branchState, planningTurnEntryId: id }
    this.clearSeal()
    this.refresh()
  }

  /**
   * A successful `submit_plan` result was committed to the selected branch:
   * seal the planning turn. Called only for a parsed, persisted submission.
   */
  observeCommittedSubmission(toolCallId: string): void {
    const id = toolCallId.trim()
    const entry = this.options.manager.getBranch().findLast(e => e.type === 'message' && e.message.role === 'toolResult' && e.message.toolCallId === id)
    if (!entry || entry.type !== 'message') throw new Error('plan-submission-not-persisted')
    const details = parsePlanSubmission(entry.message)
    if (!details) return
    try {
      const normalized = normalizePlan(details.plan)
      if (normalized.hash !== details.hash || normalized.plan !== details.plan ||
          details.planId !== this.branchState.planId || details.planningTurnEntryId !== this.branchState.planningTurnEntryId ||
          details.revision !== (this.branchState.latest?.ref.revision ?? 0) + 1) throw new Error('invalid-plan-submission')
      this.options.storage.sync()
      this.branchState = reconstructPlan(this.options.manager.getBranch())
    } catch (error) {
      this.options.storage.failed = true
      this.refresh()
      throw error
    }
    this.sealed = true
    this.sealedToolCallId = id
    this.refresh()
    this.trackWakeAdmission()
  }

  /**
   * The user's own turn actually started (the SDK admitted a user message).
   * Requires an app-owned user registration from the current prompt path: an
   * outside caller cannot lift the seal, and a preprocessing failure, an
   * extension-handled request or a background wake never reaches this at all.
   */
  releaseSubmissionForUser(): void {
    if (this.userReservations <= 0) return
    this.clearSeal()
  }

  private clearSeal(): void {
    if (!this.sealed) return
    this.sealed = false
    this.sealedToolCallId = null
    this.refresh()
    // A sealed planning turn may have deferred background wakes: opening the
    // seal is the app's cue to deliver them (never dropped, never doubled).
    this.trackWakeAdmission()
  }

  /**
   * Roll the selected branch back over an entry the SDK appended in memory but
   * failed to write. The stray entry stays off-branch, so every later fold
   * (which reads `getBranch()`) ignores it.
   */
  private rollback(previousLeaf: string | null): void {
    const manager = this.options.manager
    if (manager.getLeafId() === previousLeaf) return
    try {
      if (previousLeaf) manager.branch(previousLeaf)
      else manager.resetLeaf()
    } catch {
      // Nothing to roll back: the append never reached the in-memory tree.
    }
  }

  private get approvalRecovery(): boolean {
    return !hasPlanOpening(this) && (this.branchState.approval?.status === 'requested' || this.branchState.approval?.status === 'interrupted')
  }

  private isRestricted(dto: PlanStateDTO): boolean {
    return dto.mode === 'plan'
  }

  private build(): PlanStateDTO {
    const facts = this.options.facts()
    const restricted =
      this.branchState.mode === 'plan' || this.branchState.unsupported || facts.inheritedPlanRestriction || this.approvalRecovery
    return {
      seq: this.seq,
      // Reported mode follows the EFFECTIVE restriction, so the UI can never
      // show a writable sandbox under a restriction it failed to notice; the
      // specific reason (unsupported version, child session) rides blockers.
      mode: restricted ? 'plan' : 'normal',
      planId: this.branchState.planId,
      latest: this.branchState.latest?.ref ?? null,
      revisionPending: isRevisionPending(this.branchState),
      approval: this.branchState.approval,
      // Read from the live branch: the assistant message this maps to lands
      // after the approval entry, so it cannot come from the folded state.
      executionTurnId: this.branchState.approval?.status === 'started'
        ? planExecutionTurnId(this.options.manager.getBranch(), this.branchState.approval)
        : null,
      configuredSandboxMode: facts.configuredSandboxMode,
      effectiveSandboxMode: restricted ? 'read-only' : facts.configuredSandboxMode,
      shellEnforcement: facts.shellEnforcement,
      blockers: {
        switch: [...this.factBlockers(facts, true), ...(this.approvalRecovery ? ['recovery' as const] : [])],
        submit: this.submitBlockers(facts),
        approve: this.approveBlockers(facts)
      }
    }
  }

  /**
   * Everything that must be quiet before the session may change mode. Submit
   * and approve deliberately do NOT reuse this list: a submit happens INSIDE a
   * tool call, so its own SDK busy state (and the call that carries it) can
   * never be its own blocker.
   */
  private factBlockers(facts: PlanLiveFacts, includeTransition: boolean): PlanBlocker[] {
    const blockers: PlanBlocker[] = []
    if (facts.initializing) blockers.push('initializing')
    if (facts.closing) blockers.push('closing')
    if (facts.child) blockers.push('child-session')
    if (facts.recovery) blockers.push('recovery')
    if (includeTransition && this.lock) blockers.push('transition')
    if (!facts.sdkIdle || this.reservations.size > 0) blockers.push('busy')
    if (facts.tasks > 0) blockers.push('tasks')
    if (facts.subagents > 0) blockers.push('subagents')
    if (facts.deliveries > 0) blockers.push('deliveries')
    if (facts.questions > 0) blockers.push('questions')
    if (facts.escalations > 0) blockers.push('escalations')
    if (facts.queuedMessages > 0) blockers.push('queued-messages')
    if (this.options.storage.failed) blockers.push('storage')
    if (this.branchState.unsupported) blockers.push('unsupported-version')
    return blockers
  }

  /**
   * Whether the model may submit a plan: the root session is really in plan,
   * its identity is established, and no investigation is still outstanding.
   * SDK busy and the current tool call are exempt (the submit IS the call).
   */
  private submitBlockers(facts: PlanLiveFacts): PlanBlocker[] {
    const blockers: PlanBlocker[] = []
    if (facts.initializing) blockers.push('initializing')
    if (facts.closing) blockers.push('closing')
    if (facts.child) blockers.push('child-session')
    if (facts.recovery) blockers.push('recovery')
    if (facts.tasks > 0) blockers.push('tasks')
    if (facts.subagents > 0) blockers.push('subagents')
    if (facts.deliveries > 0) blockers.push('deliveries')
    if (facts.questions > 0) blockers.push('questions')
    if (facts.escalations > 0) blockers.push('escalations')
    if (this.options.storage.failed) blockers.push('storage')
    if (this.branchState.unsupported) blockers.push('unsupported-version')
    else if (this.branchState.mode !== 'plan') blockers.push('not-plan')
    if (this.sealed) blockers.push('already-submitted')
    return blockers
  }

  /** Whether the user may start executing the latest submission. */
  private approveBlockers(facts: PlanLiveFacts): PlanBlocker[] {
    const blockers = this.factBlockers(facts, true)
    if (this.approvalRecovery) blockers.push('recovery')
    if (this.branchState.mode !== 'plan') blockers.push('not-plan')
    if (!this.branchState.unsupported) {
      if (!this.branchState.latest) blockers.push('no-submission')
      else if (!isCurrentPlan(this.branchState)) blockers.push('stale-submission')
    }
    return blockers
  }

  private contentKey(dto: PlanStateDTO): string {
    return JSON.stringify({ ...dto, seq: 0 })
  }

  private publish(dto: PlanStateDTO): void {
    this.publishedKey = this.contentKey(dto)
    this.seq = this.nextSeq()
    this.options.changed()
    this.trackWakeAdmission()
  }

  /**
   * Whether a background wake would be admitted right now. This is the exact
   * predicate of `beginWork('background')` (no lock, no submission seal, not
   * closing); it exists separately so the controller can report an OPEN
   * admission transition to the app (see `onWakeOpened`).
   */
  private backgroundWakeOpen(): boolean {
    return !this.lock && !this.sealed && !this.approvalRecovery && !this.options.storage.failed && !this.branchState.unsupported && !this.options.facts().closing
  }

  private trackWakeAdmission(): void {
    const open = this.backgroundWakeOpen()
    if (open === this.wakeWasOpen) return
    this.wakeWasOpen = open
    if (open) this.onWakeOpened?.()
  }
}
