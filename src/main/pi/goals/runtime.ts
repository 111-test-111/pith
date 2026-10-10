import { createHash, randomUUID } from 'node:crypto'
import type { AgentSession, AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import type { GoalCriterionInput, GoalInput, GoalLimits, GoalRecord, GoalReason, GoalSnapshotDTO, GoalPendingInputDTO, GoalBillingOwner } from '../../../shared/goal'
import { statsFromEntries } from '../context-detail'
import { collectJevEvidence, jevExcerpt } from '../jev/evidence'
import { BASH_COMPLETION_TYPE } from '../task-notifications'
import { SUBAGENT_COMPLETION_TYPE } from '../subagents/protocol'
import { ASK_USER_ANSWER_TYPE } from '../../../shared/ask-user'
import type { PlanStorage } from '../plan-storage'
import { GOAL_ENTRY, GOAL_EVIDENCE, GOAL_GET, GOAL_UPDATE, applyGoalReceipt, parseGoalReceipt, goalFromBranch, goalLive, type GoalReceipt, type GoalUpdateInput } from './protocol'
import { collectGoalEvidence, currentGoalSource, goalEvidenceView, makeGoalStamps, readGoalVersions, type GoalEvidenceState } from './evidence'
import { GoalStorage, type GoalLedger } from './storage'
import { GoalInputStorage } from './input'
import { GoalAccounting } from './accounting'

interface Host {
  session: AgentSession
  storage: PlanStorage
  userData: string
  cwd: string
  nextSeq(): number
  changed(goal: GoalSnapshotDTO | null, seq: number): void
  accountingChanged?(goalId: string): void
  accounting?: GoalAccounting
  /** Checked before reservation AND again immediately before dispatch. */
  available(): boolean
  pending(): boolean
  unfinishedTodos(): boolean
  review(): 'ready' | 'waiting' | 'paused'
  reserve(): () => void
  stop(reason: GoalReason): void
  run(content: string, initial: boolean, dispatchId: string, signal: AbortSignal, accepted: () => boolean, input?: GoalInput & { fileBlocks?: string }): Promise<void>
}

/** Session-owned wake owner. Neither model tools nor restored entries can resume it. */
export class GoalRuntime {
  private goal: GoalRecord | null = null
  private ledger: GoalLedger | null = null
  private store: GoalStorage
  private inputs: GoalInputStorage
  private accounting: GoalAccounting
  private inputController: AbortController | null = null
  private inputPromise: Promise<boolean> | null = null
  private pendingInput: GoalPendingInputDTO | null = null
  private job: AbortController | null = null
  private jobPromise: Promise<void> | null = null
  private manualWakes = false
  private generation = 0
  private disposed = false
  private failed = false
  private evaluate = false
  private scheduled = false
  private previous = ''
  private initialInput: (GoalInput & { fileBlocks?: string }) | null = null
  private countInitial = false
  private resumeAfterCheckout = false
  private disposeStream: (() => void) | null = null
  private proofState: GoalEvidenceState | null = null
  private proofEpoch = 0
  private beforeVersions = new Map<string, Record<string, string>>()
  private disposeProofGuard: (() => void) | null = null
  seq = 0
  constructor(private host: Host) {
    this.store = new GoalStorage(host.userData, host.session.sessionId)
    this.inputs = new GoalInputStorage(host.userData, host.session.sessionId)
    this.accounting = host.accounting ?? new GoalAccounting(host.userData)
    this.restore('interrupted')
  }
  get preparing(): boolean { return !!this.job || !!this.inputController }
  get continuesAtSettled(): boolean {
    return this.live && !this.quota() && this.host.review() !== 'paused' &&
      (this.goal?.status !== 'verifying' || this.host.pending() || this.host.unfinishedTodos() || this.host.review() !== 'ready' ||
        this.snapshot?.criteria.some(c => c.state !== 'verified') || !!this.snapshot?.evidenceBlocked)
  }
  get live(): boolean { return !this.failed && goalLive(this.goal) }
  get stopsWakes(): boolean { return !this.manualWakes && !!this.goal && !this.live && this.goal.status !== 'completed' }
  async idle(): Promise<void> { await Promise.allSettled([this.inputPromise, this.jobPromise]) }
  get snapshot(): GoalSnapshotDTO | null {
    const record = this.goal && structuredClone(this.goal)
    const view = record && this.proofState && goalEvidenceView(this.proofState, record)
    return record ? { ...record, criteria: view?.criteria ?? record.criteria.map(c => ({ ...c, state: c.proof ? 'stale' as const : 'pending' as const })),
      evidenceResults: view?.results ?? [], evidenceOmitted: this.proofState?.evidence.omitted ?? 0, evidenceBlocked: view?.blocked ?? false,
      seq: this.seq, autoRuns: this.ledger?.autoRuns ?? 0,
      tokens: this.ledger?.tokens ?? 0, accountingAvailable: !this.failed && !!this.ledger && !this.ledger.independent?.unresolved.length,
      ...(this.ledger ? { billing: { parentTokens: this.ledger.tokens - (this.ledger.independent?.subagentTokens ?? 0) - (this.ledger.independent?.jevTokens ?? 0),
        subagentTokens: this.ledger.independent?.subagentTokens ?? 0, jevTokens: this.ledger.independent?.jevTokens ?? 0, unresolved: this.ledger.independent?.unresolved.length ?? 0 } } : {}),
      executing: !this.host.session.isIdle || this.preparing, waiting: this.live && this.host.pending(),
      ...(this.pendingInput ? { pendingInput: structuredClone(this.pendingInput) } : {}) } : null
  }
  private publish(force = false): void {
    const snapshot = this.snapshot
    const key = JSON.stringify(snapshot && { ...snapshot, seq: 0 })
    if (!force && key === this.previous) return
    this.previous = key
    this.seq = this.host.nextSeq()
    this.host.changed(this.snapshot, this.seq)
  }
  private fault(): void {
    this.failed = true
    this.invalidate()
    if (this.goal) this.goal = { ...this.goal, status: 'paused', reason: 'storage' }
    this.publish()
    this.host.stop('storage')
  }
  private save(patch: Partial<GoalRecord>): void {
    if (!this.goal || this.failed) return
    const next = { ...this.goal, ...patch, updatedAt: Date.now() }
    // Publish only after the session entry and fsync both succeed.
    try { this.host.storage.append(GOAL_ENTRY, next) }
    catch { this.fault(); return }
    this.goal = next
    this.publish()
  }
  private updateLedger(change: (ledger: GoalLedger) => void, initialize = false): boolean {
    if (!this.goal || this.failed) return false
    try { this.ledger = this.store.update(this.goal.id, change, initialize); this.host.accountingChanged?.(this.goal.id); return true }
    catch { this.fault(); return false }
  }
  private invalidate(): void { this.generation++; this.job?.abort(); this.inputController?.abort(); this.scheduled = false; this.beforeVersions.clear() }
  private inputAcceptedAnywhere(id: string): boolean {
    const owners = new Map<string, string | null>()
    for (const entry of this.host.session.sessionManager.getEntries()) {
      const definition = entry.type === 'custom' && entry.customType === GOAL_ENTRY ? goalFromBranch([entry]) : null
      const owner = definition?.id ?? (entry.parentId ? owners.get(entry.parentId) ?? null : null)
      owners.set(entry.id, owner)
      if (owner === id && entry.type === 'message' && entry.message.role === 'user') return true
    }
    return false
  }
  restore(reason: 'interrupted' | 'rewound'): void {
    this.invalidate()
    this.initialInput = null
    this.pendingInput = null
    this.countInitial = false
    this.resumeAfterCheckout = false
    this.proofState = null
    this.proofEpoch++
    // Finish billing the outgoing goal before selecting another branch's fact.
    this.bill()
    if (this.ledger?.run) this.updateLedger(l => { l.run = null })
    const branch = this.host.session.sessionManager.getBranch()
    this.goal = goalFromBranch(branch)
    this.ledger = null
    this.failed = false
    if (this.goal) {
      try {
        this.ledger = this.store.read(this.goal.id, true)
        this.accounting.recover(this.billingOwner()!)
        this.ledger = this.store.read(this.goal.id, true)
      }
      catch { this.fault(); return }
      // Reconcile a persisted run after a hard crash. A claim is never replayed.
      this.bill()
      if (this.ledger.run) this.updateLedger(l => { l.run = null })
      const first = branch.findIndex(e => e.type === 'custom' && e.customType === GOAL_ENTRY && (e.data as { id?: string } | undefined)?.id === this.goal!.id)
      if (!['completed', 'cancelled'].includes(this.goal.status) && first >= 0 &&
        !branch.slice(first + 1).some(e => e.type === 'message' && e.message.role === 'user')) {
        // No input was accepted. Explicit Resume must establish a normal
        // first-user checkpoint, rather than run writes without one.
        this.initialInput = {}
        this.countInitial = true
        if (this.goal.inputReceipt) {
          // Selected-branch Rewind cannot erase the global fact that the old
          // input was accepted, including a crash/failure before its tombstone.
          const accepted = this.inputAcceptedAnywhere(this.goal.id)
          if (accepted) try { this.inputs.consume(this.goal.id, 'accepted') } catch { /* accepted input remains forbidden even if the tombstone cannot be written */ }
          const pending = this.inputs.inspect(this.goal.id)
          if (this.inputs.acceptedWithoutAttachments(this.goal.id, this.host.cwd) || accepted && pending.cwd === this.host.cwd && !pending.files.length && !pending.imageCount) {
            // An explicit Resume can establish a fresh checkpoint command on
            // this checkout. Never replay the consumed original user payload.
            this.resumeAfterCheckout = true
            this.initialInput = { fileBlocks: '' }
          } else this.pendingInput = { ...pending, available: !accepted && pending.available }
        }
      } else if (this.goal.inputReceipt) {
        // A durable user entry wins over a crash before the receipt tombstone.
        try { this.inputs.consume(this.goal.id, 'accepted') } catch { /* committed context needs no pending input */ }
      }
      // Restoring must preserve the reviewed SDK leaf and Rewind's journal
      // endpoints. Recovery grants no execution; explicit Resume persists the
      // next transition. Reopening this active branch will pause it again.
      if (goalLive(this.goal) || reason === 'rewound' && this.goal.status === 'completed') this.goal = { ...this.goal, status: 'paused', reason, evidence: null }
      if (this.ledger.independent?.unresolved.length && !['completed', 'cancelled'].includes(this.goal.status)) this.goal = { ...this.goal, status: 'paused', reason: 'accounting' }
    }
    this.evaluate = false
    this.publish(true)
    void this.inspect()
  }
  create(objective: string, acceptance: string, limits: GoalLimits, input: GoalInput = {}): Promise<boolean> {
    this.invalidate()
    const id = randomUUID()
    const controller = this.inputController = new AbortController(), generation = this.generation
    const promise = this.inputPromise = (async () => {
      let retained = false
      try {
        const prepared = await this.inputs.capture(id, this.host.cwd, input, controller.signal)
        if (controller.signal.aborted || generation !== this.generation || this.disposed) return false
        this.proofState = null
        this.proofEpoch++
        retained = true
        this.goal = { version: 2, id, objective, acceptance, criteriaRevision: 1,
          criteria: [{ id: randomUUID(), text: acceptance, revision: 1, proof: null }], limits: structuredClone(limits),
          status: 'active', reason: null, evidence: null, createdAt: Date.now(), updatedAt: Date.now(), inputReceipt: true }
        this.failed = false
        this.initialInput = prepared
        this.pendingInput = this.inputs.inspect(id)
        this.countInitial = false
        this.resumeAfterCheckout = false
        if (!this.updateLedger(() => {}, true)) return false
        this.save({})
        return this.live
      } catch (error) {
        if (controller.signal.aborted || generation !== this.generation) return false
        throw error
      } finally {
        if (!retained) await this.inputs.discard(id).catch(() => {})
        if (this.inputController === controller) this.inputController = null
        this.inputPromise = null
        this.flush()
      }
    })()
    return promise
  }
  limits(limits: GoalLimits): void { this.save({ limits: structuredClone(limits) }) }
  criteria(input: GoalCriterionInput[], objective = this.goal?.objective): void {
    if (!this.goal) return
    this.invalidate()
    const changedObjective = objective !== this.goal.objective
    const criteria = input.map(item => {
      const old = this.goal!.criteria.find(c => c.id === item.id)
      return old && old.text === item.text.trim() && !changedObjective ? old : { id: old?.id ?? randomUUID(), text: item.text.trim(), revision: (old?.revision ?? 0) + 1, proof: null }
    })
    this.save({ objective, criteria, acceptance: criteria.map(c => c.text).join('\n'), criteriaRevision: this.goal.criteriaRevision + 1,
      status: 'paused', reason: 'criteria', evidence: null })
  }
  /** Refresh only observations; inspecting/reopening cannot authorize execution. */
  async inspect(): Promise<GoalSnapshotDTO | null> {
    const goal = this.goal, generation = this.generation, epoch = ++this.proofEpoch
    if (!goal) return null
    try {
      const state = await collectGoalEvidence(this.host.session.sessionManager.getBranch(), this.host.cwd, goal)
      if (generation !== this.generation || epoch !== this.proofEpoch || goal.id !== this.goal?.id || goal.criteriaRevision !== this.goal.criteriaRevision) return this.snapshot
      this.proofState = state
      const view = goalEvidenceView(state, this.goal)
      if (this.goal.status === 'completed' && (view.blocked || view.criteria.some(c => c.state !== 'verified'))) {
        // Preserve exact checkout/recovery endpoints; no private entry on read.
        this.goal = { ...this.goal, status: 'paused', reason: 'evidence', evidence: null }
      }
      this.publish()
    } catch {
      if (generation === this.generation && epoch === this.proofEpoch) {
        this.proofState = null
        if (this.goal?.status === 'completed') this.goal = { ...this.goal, status: 'paused', reason: 'evidence', evidence: null }
        this.publish()
      }
    }
    return this.snapshot
  }
  reviewContext() {
    const goal = this.snapshot
    if (!goal || !goalLive(goal)) return null
    const context = { id: goal.id, criteriaRevision: goal.criteriaRevision, objective: goal.objective, evidenceBlocked: goal.evidenceBlocked,
      criteria: goal.criteria.map(c => ({ id: c.id, revision: c.revision, text: c.text, state: c.state,
        ...(c.proof ? { summary: c.proof.summary, evidenceIds: c.proof.sources.map(s => s.id) } : {}) })) }
    return { ...context, key: createHash('sha256').update(JSON.stringify({ context, revision: this.proofState?.evidence.revision,
      results: this.proofState?.evidence.items.map(i => [i.id, i.status]) })).digest('hex') }
  }
  reviewKey(): string | null { return this.reviewContext()?.key ?? null }
  async workflowEvidence() {
    if (!this.live) return undefined
    await this.inspect()
    const state = this.proofState
    if (!state) return undefined
    const items = new Map([...(state.evidence.references ?? []), ...state.evidence.items].map(item => {
      const stamp = state.stamps.get(item.id)
      return [item.id, { ...item, current: !!stamp && currentGoalSource(state, { id: item.id, stampId: stamp.stampId, hash: stamp.hash }, false) }] as const
    }))
    return { ...state.evidence, items: [...items.values()] }
  }
  async receipt(input: GoalUpdateInput, signal?: AbortSignal): Promise<GoalReceipt> {
    const goal = this.goal, generation = this.generation
    if (!goal || !this.live || goal.id !== input.goalId || goal.criteriaRevision !== input.criteriaRevision) throw new Error('Goal or acceptance criteria changed. Read get_goal again.')
    const state = await collectGoalEvidence(this.host.session.sessionManager.getBranch(), this.host.cwd, goal, input.claims?.flatMap(c => c.evidenceIds))
    if (signal?.aborted || generation !== this.generation || !this.live || goal.criteriaRevision !== this.goal?.criteriaRevision) throw new Error('Goal verification cancelled')
    const claims = (input.claims ?? []).map(claim => {
      const criterion = goal.criteria.find(c => c.id === claim.criterionId)
      if (!criterion || !claim.evidence.trim() || claim.evidence.length > 1000 || !claim.evidenceIds.length || claim.evidenceIds.length > 8 || new Set(claim.evidenceIds).size !== claim.evidenceIds.length) throw new Error('Invalid criterion proof')
      const sources = claim.evidenceIds.map(id => {
        const stamp = state.stamps.get(id)
        const ref = { id, stampId: stamp?.stampId ?? '', hash: stamp?.hash ?? '' }
        if (!currentGoalSource(state, ref)) throw new Error(`Evidence ${id} is missing, failed, pending or stale. Obtain a fresh committed result.`)
        return ref
      })
      return { criterionId: criterion.id, revision: criterion.revision, summary: jevExcerpt(claim.evidence.trim(), 1000), sources }
    })
    if (new Set(claims.map(c => c.criterionId)).size !== claims.length) throw new Error('Duplicate criterion proof')
    const view = goalEvidenceView(state, goal)
    if (input.status === 'complete' && (view.blocked || view.criteria.some(c => !claims.some(claim => claim.criterionId === c.id) && c.state !== 'verified'))) throw new Error('Every criterion needs current committed evidence and all checks must succeed.')
    this.proofState = state
    this.publish()
    return { kind: 'pith-goal-result-v2', goalId: goal.id, criteriaRevision: goal.criteriaRevision, status: input.status, evidence: jevExcerpt(input.evidence.trim(), 8000), claims }
  }
  quota(): GoalReason | null {
    if (!this.goal || !this.ledger) return null
    if (!this.syncAccounting()) return 'storage'
    if (this.ledger.independent?.unresolved.length) return 'accounting'
    if (this.goal.limits.tokenBudget !== null && this.ledger.tokens >= this.goal.limits.tokenBudget) return 'tokens'
    if (this.ledger.autoRuns >= this.goal.limits.maxAutoRuns) return 'runs'
    return null
  }
  syncAccounting(): boolean {
    if (!this.goal || !this.ledger || this.failed) return false
    try {
      this.ledger = this.store.read(this.goal.id, true)
      if (this.ledger.independent?.unresolved.length && this.live) {
        this.invalidate()
        this.goal = { ...this.goal, status: 'paused', reason: 'accounting' }
        this.host.stop('accounting')
      }
      this.publish(); return true
    }
    catch { this.fault(); return false }
  }
  checkpointAccounting(): void {
    if (!this.goal || this.failed) return
    try { this.host.storage.sync(); this.bill() } catch { this.fault() }
  }
  /** An independently owned run retains this attribution through Stop/Rewind. */
  billingOwner(ownedOnly = false): GoalBillingOwner | null {
    if (!this.goal || !this.ledger || this.failed || ownedOnly && !this.ledger.run) return null
    return { goalId: this.goal.id, ownerSessionId: this.store.owner(this.goal.id), parentSessionId: this.host.session.sessionId,
      parentRunId: this.ledger.run?.id ?? 'recovery', tokenBudget: this.goal.limits.tokenBudget }
  }
  resume(): void {
    if (!this.goal || this.failed || this.quota()) return
    if (this.pendingInput && !this.pendingInput.available) return
    this.invalidate()
    if (this.initialInput !== null) this.countInitial = true
    this.manualWakes = false
    this.evaluate = false
    this.updateLedger(l => { l.noProgress = 0; l.fingerprint = null })
    this.save({ status: 'active', reason: null, evidence: null })
    this.start()
  }
  pause(reason: GoalReason, persist = true): void {
    this.manualWakes = false
    this.invalidate()
    if (goalLive(this.goal) || reason === 'rewound' && this.goal?.status === 'completed') {
      if (persist) this.save({ status: 'paused', reason })
      else { this.goal = { ...this.goal!, status: 'paused', reason }; this.publish() }
    }
  }
  cancel(): void {
    this.invalidate()
    this.initialInput = null
    this.pendingInput = null
    if (!this.goal) return
    if (this.goal.inputReceipt) try { this.inputs.consume(this.goal.id, 'superseded') } catch { /* cancellation never replays input */ }
    if (!this.failed) { this.save({ status: 'cancelled', reason: 'user' }); return }
    // Cancellation can still be persisted when only the independent ledger
    // is corrupt. Preserve that ledger; a new goal needs a new explicit ID.
    const next: GoalRecord = { ...this.goal, status: 'cancelled', reason: 'user', updatedAt: Date.now() }
    try { this.host.storage.append(GOAL_ENTRY, next); this.goal = next; this.publish() }
    catch { this.fault() }
  }
  /** Ending a completed mode retains its outcome, proofs and spent allowance. */
  dismiss(): void {
    if (!this.goal || !['completed', 'cancelled'].includes(this.goal.status)) return
    const next: GoalRecord = { ...this.goal, dismissed: true, updatedAt: Date.now() }
    try { this.host.storage.append(GOAL_ENTRY, next); this.goal = next; this.publish() }
    catch { this.fault() }
  }
  /** A new user turn supersedes a preparing wake without resuming paused state. */
  userPrompt(): void {
    this.invalidate(); this.evaluate = false; this.manualWakes = true
    if (this.goal?.status === 'verifying') this.save({ status: 'active', reason: null, evidence: null })
  }
  private bill(): void {
    if (!this.goal || !this.ledger || this.failed || !this.syncAccounting() || !this.ledger.run) return
    const before = new Set(this.ledger.run.before)
    const billed = new Set(this.ledger.billed)
    const entries = this.host.session.sessionManager.getEntries().filter(e => !before.has(e.id) && !billed.has(e.id))
    const charges = entries.map(e => ({ id: e.id, tokens: statsFromEntries([e]).tokens.total })).filter(e => e.tokens > 0)
    if (!charges.length) return
    if (!charges.every(e => Number.isSafeInteger(e.tokens))) { this.fault(); return }
    this.updateLedger(l => {
      const seen = new Set(l.billed)
      for (const charge of charges) if (!seen.has(charge.id)) { l.tokens += charge.tokens; l.billed.push(charge.id) }
    })
    this.publish()
  }
  /** Called after the SDK's awaited persistence subscriber, never its early public event. */
  async committed(event: AgentSessionEvent): Promise<void> {
    if (event.type !== 'message_end') return
    if (this.ledger?.run) {
      try { this.host.storage.sync() } catch { this.fault(); return }
    }
    this.bill()
    const message = event.message
    if (message.role === 'user') {
      const pending = this.pendingInput !== null
      this.initialInput = null
      this.pendingInput = null
      if (pending && this.goal?.inputReceipt) try { this.host.storage.sync(); this.inputs.consume(this.goal.id, 'accepted') } catch { this.fault(); return }
    }
    // Verification cannot certify mutations/failures or late outcomes that
    // arrived after its receipt. Let the model review the new evidence first.
    if (this.goal?.status === 'verifying' && (
      message.role === 'toolResult' && message.toolName !== GOAL_UPDATE &&
        (message.isError || !['read', 'grep', 'find', 'ls', GOAL_GET, 'todo_write'].includes(message.toolName)) ||
      message.role === 'custom' && [BASH_COMPLETION_TYPE, SUBAGENT_COMPLETION_TYPE, ASK_USER_ANSWER_TYPE].includes(message.customType))) {
      this.save({ status: 'active', reason: null, evidence: null })
    }
    if (!this.goal) return
    const branch = this.host.session.sessionManager.getBranch()
    const source = branch.findLast(e => e.type === 'message' ? e.message === message : e.type === 'custom_message' && message.role === 'custom' &&
      e.customType === message.customType && JSON.stringify(e.content) === JSON.stringify(message.content))
    if (message.role === 'toolResult' && message.toolName === GOAL_UPDATE && !message.isError && this.live && source) {
      const receipt = parseGoalReceipt(message.details)
      const next = receipt && applyGoalReceipt(this.goal, receipt, source.id, message.timestamp)
      if (next) this.save(next)
    } else if (source && this.live && (message.role === 'toolResult' || message.role === 'custom')) {
      const generation = this.generation, goalId = this.goal.id
      const state = await collectGoalEvidence(branch, this.host.cwd, this.goal)
      if (generation !== this.generation || !this.live || this.goal?.id !== goalId) return
      const items = makeGoalStamps(state, source.id)
      if (message.role === 'custom' && message.customType === BASH_COMPLETION_TYPE) {
        const taskId = (message.details as { taskId?: string; bashTask?: { id?: string } } | undefined)?.bashTask?.id ??
          (message.details as { taskId?: string } | undefined)?.taskId
        const origin = taskId && branch.findLast(e => e.type === 'message' && e.message.role === 'toolResult' &&
          (e.message.details as { bashTask?: { id?: string } } | undefined)?.bashTask?.id === taskId)
        const original = origin ? state.stamps.get(origin.id) : undefined
        // Delivery may happen long after the command ran. Bind its result to
        // the original observed version, never silently to newer source files.
        for (const item of items) if (!original || original.unstable || original.generation !== item.generation ||
          Object.entries(original.versions).some(([path, version]) => item.versions[path] !== version)) item.unstable = true
      }
      const before = message.role === 'toolResult' ? this.beforeVersions.get(message.toolCallId) : undefined
      if (message.role === 'toolResult') this.beforeVersions.delete(message.toolCallId)
      for (const item of items) {
        const observed = state.evidence.items.find(e => e.id === item.id)
        // Reads/checks must observe a stable version across execution and commit.
        // Write/edit results deliberately change their file and bind afterward.
        if (observed?.kind !== 'change' && before && Object.entries(before).some(([path, version]) =>
          (item.scope === 'workspace' || observed?.path === path) && item.versions[path] !== version)) item.unstable = true
      }
      if (items.length) {
        try { this.host.storage.append(GOAL_EVIDENCE, { version: 1, goalId, items }) }
        catch { this.fault(); return }
      }
    }
    if (message.role !== 'assistant') await this.inspect()
  }
  observe(event: AgentSessionEvent | { type: 'pi_error' }): void {
    if (this.disposed) return
    if (event.type === 'agent_start' && this.live && !this.ledger?.run) {
      this.updateLedger(l => { l.run = { id: randomUUID(), state: 'started', before: this.host.session.sessionManager.getEntries().map(e => e.id) } })
    }
    if (event.type !== 'agent_settled' && event.type !== 'pi_error') return
    this.bill()
    if (this.ledger?.run) this.updateLedger(l => { l.run = null })
    if (event.type === 'pi_error') this.pause('error')
    const last = this.host.session.sessionManager.getBranch().findLast(e => e.type === 'message' && e.message.role === 'assistant')
    if (last?.type === 'message' && last.message.role === 'assistant' && ['error', 'aborted', 'length'].includes(last.message.stopReason)) this.pause('error')
    this.evaluate = true
    this.flush()
  }
  flush(): void {
    this.publish()
    if (!this.live || this.disposed || this.job || this.scheduled) return
    this.scheduled = true
    const generation = this.generation
    queueMicrotask(() => {
      this.scheduled = false
      if (generation === this.generation) this.start()
    })
  }
  private content(initial: boolean): string {
    const g = this.goal!
    return initial && !this.resumeAfterCheckout ? g.objective :
      `Continue the current goal from the committed results; preserve completed work and use the existing Todo list. Read get_goal for criterion IDs, current revisions and committed evidence IDs. Goal and acceptance criteria (quoted JSON): ${JSON.stringify({ id: g.id, objective: g.objective, criteriaRevision: g.criteriaRevision, criteria: g.criteria.map(c => ({ id: c.id, revision: c.revision, text: c.text })) })}. Verify remaining criteria. Use update_goal with evidence IDs, never prose alone; report a concrete external blocker if necessary. Respect user instructions and permissions.`
  }
  private start(): void {
    const initial = this.initialInput !== null
    if (!this.live || this.disposed || this.job || !this.host.available() || this.host.pending()) return
    const review = this.host.review()
    if (review === 'paused') { this.pause('review'); return }
    const quota = this.quota()
    // Final validation spends no new dispatch. Exhausted allowance may still
    // settle a fully proven candidate, but cannot admit another model request.
    if (quota && this.goal?.status !== 'verifying') { this.pause(quota); return }
    let release: () => void
    try { release = this.host.reserve() } catch { return }
    const controller = this.job = new AbortController()
    let input = this.initialInput ?? undefined
    const counted = !initial || this.countInitial
    const generation = this.generation
    const accepted = () => generation === this.generation && !controller.signal.aborted && this.live && !this.disposed && this.host.available() && !this.host.pending()
    this.jobPromise = (async () => {
      try {
        if (initial && this.goal?.inputReceipt && !this.resumeAfterCheckout) {
          try { input = await this.inputs.load(this.goal.id, this.host.cwd, controller.signal) }
          catch { if (!controller.signal.aborted) { this.pendingInput = { ...this.inputs.inspect(this.goal.id), available: false }; this.pause('input') }; return }
        }
        await this.inspect()
        if (!accepted()) return
        if (this.goal?.status === 'verifying') {
          const snapshot = this.snapshot!
          if (!snapshot.evidenceBlocked && snapshot.criteria.every(c => c.state === 'verified')) {
            if (!this.host.unfinishedTodos() && this.host.review() === 'ready') { this.save({ status: 'completed', reason: null }); return }
          } else this.save({ status: 'active', reason: null, evidence: null })
        }
        const quota = this.quota()
        if (quota) { this.pause(quota); return }
        if (!initial && this.evaluate) {
          const evidence = await collectJevEvidence(this.host.session.sessionManager.getBranch(), this.host.cwd)
          if (!accepted()) return
          const fingerprint = createHash('sha256').update(JSON.stringify({ versions: evidence.versions,
            items: evidence.items.filter(e => ![GOAL_GET, GOAL_UPDATE, 'todo_write'].includes(e.tool)).map(e => [e.key, e.status, e.exitCode, e.excerpt, e.currentSource]).sort() })).digest('hex')
          if (!this.updateLedger(l => { l.noProgress = l.fingerprint === fingerprint ? l.noProgress + 1 : 0; l.fingerprint = fingerprint })) return
          this.evaluate = false
          if (this.ledger!.noProgress >= 2) { this.pause('no_progress'); return }
        }
        if (!accepted()) return
        const dispatchId = randomUUID()
        let denied: GoalReason | null = null
        // The durable claim is charged once, before dispatch; crash recovery never replays it.
        if (!this.updateLedger(l => {
          // Forks can race for the final slot. Test and charge under the pool's lock.
          if (l.tokens >= (this.goal!.limits.tokenBudget ?? Infinity)) { denied = 'tokens'; return }
          if (l.autoRuns >= this.goal!.limits.maxAutoRuns) { denied = 'runs'; return }
          if (counted) l.autoRuns++
          l.run = { id: dispatchId, state: 'claimed', before: this.host.session.sessionManager.getEntries().map(e => e.id) }
        })) return
        if (denied) { this.pause(denied); return }
        this.publish()
        await this.host.run(this.content(initial), initial, dispatchId, controller.signal, accepted, input)
      } catch {
        if (!controller.signal.aborted) this.pause('error')
      } finally {
        this.bill()
        if (this.ledger?.run && this.host.session.isIdle) this.updateLedger(l => { l.run = null })
        if (this.job === controller) this.job = null
        this.jobPromise = null
        release()
        this.flush()
      }
    })()
  }
  started(dispatchId: string): void {
    if (this.ledger?.run?.id === dispatchId) {
      this.initialInput = null
      this.pendingInput = null
      this.updateLedger(l => { if (l.run?.id === dispatchId) l.run.state = 'started' })
    }
  }
  /** Bound every primary model request, including SDK/Jev continuations within a run. */
  installStreamGuard(): void {
    const agent = this.host.session.agent
    const previousBefore = agent.beforeToolCall
    const before: typeof previousBefore = async (context, signal) => {
      const prior = await previousBefore?.(context, signal)
      if (prior?.block || !this.live || [GOAL_GET, GOAL_UPDATE, 'todo_write'].includes(context.toolCall.name)) return prior
      const generation = this.generation
      const args = context.args as { path?: unknown }
      const paths = [...Object.keys(this.proofState?.evidence.versions ?? {}), ...(typeof args?.path === 'string' ? [args.path] : [])]
      const versions = await readGoalVersions(paths, this.host.cwd)
      if (signal?.aborted || generation !== this.generation || !this.live) return { block: true, terminate: true, reason: 'Goal execution cancelled.' }
      if (this.beforeVersions.size >= 256) this.beforeVersions.clear()
      this.beforeVersions.set(context.toolCall.id, versions)
      return prior
    }
    agent.beforeToolCall = before
    this.disposeProofGuard = () => { if (agent.beforeToolCall === before) agent.beforeToolCall = previousBefore }
    const previous = agent.streamFunction
    const stream: typeof previous = async (model, context, options) => {
      this.bill()
      const owned = this.live || !this.manualWakes || (!this.failed && !!this.ledger?.run)
      const cancelled = !!options?.signal?.aborted
      if (cancelled || owned && (this.failed || this.ledger?.independent?.unresolved.length || this.ledger?.run && this.goal?.limits.tokenBudget !== null && this.ledger.tokens >= (this.goal?.limits.tokenBudget ?? Infinity))) {
        if (!cancelled && !this.failed) this.pause(this.ledger?.independent?.unresolved.length ? 'accounting' : 'tokens')
        const message = { role: 'assistant' as const, content: [], api: model.api, provider: model.provider, model: model.id,
          stopReason: 'aborted' as const, errorMessage: cancelled ? 'GOAL_CANCELLED' : 'GOAL_TOKEN_BUDGET', timestamp: Date.now(),
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }
        return { async *[Symbol.asyncIterator]() { yield { type: 'error' as const, reason: 'aborted' as const, error: message } }, result: async () => message } as unknown as Awaited<ReturnType<typeof stream>>
      }
      return previous(model, context, options)
    }
    agent.streamFunction = stream
    this.disposeStream = () => { if (agent.streamFunction === stream) agent.streamFunction = previous }
  }
  dispose(): void {
    this.pause('interrupted')
    this.initialInput = null
    this.disposed = true
    this.disposeStream?.()
    this.disposeProofGuard?.()
    // The manager still observes committed abort results before removing subscribers.
  }
}
