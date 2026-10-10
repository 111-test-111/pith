import { createHash, randomUUID } from 'node:crypto'
import type { AgentSession, AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import type { GoalLimits, GoalRecord, GoalReason, GoalSnapshotDTO } from '../../../shared/goal'
import { statsFromEntries } from '../context-detail'
import { collectJevEvidence } from '../jev/evidence'
import { BASH_COMPLETION_TYPE } from '../task-notifications'
import { SUBAGENT_COMPLETION_TYPE } from '../subagents/protocol'
import { ASK_USER_ANSWER_TYPE } from '../../../shared/ask-user'
import type { PlanStorage } from '../plan-storage'
import { GOAL_ENTRY, GOAL_GET, GOAL_UPDATE, GOAL_RECEIPT, goalFromBranch, goalLive } from './protocol'
import { GoalStorage, type GoalLedger } from './storage'

interface Host {
  session: AgentSession
  storage: PlanStorage
  userData: string
  cwd: string
  nextSeq(): number
  changed(goal: GoalSnapshotDTO | null, seq: number): void
  /** Checked before reservation AND again immediately before dispatch. */
  available(): boolean
  pending(): boolean
  unfinishedTodos(): boolean
  review(): 'ready' | 'waiting' | 'paused'
  reserve(): () => void
  stop(reason: GoalReason): void
  run(content: string, initial: boolean, dispatchId: string, signal: AbortSignal, accepted: () => boolean): Promise<void>
}

/** Session-owned wake owner. Neither model tools nor restored entries can resume it. */
export class GoalRuntime {
  private goal: GoalRecord | null = null
  private ledger: GoalLedger | null = null
  private store: GoalStorage
  private job: AbortController | null = null
  private jobPromise: Promise<void> | null = null
  private manualWakes = false
  private generation = 0
  private disposed = false
  private failed = false
  private evaluate = false
  private scheduled = false
  private previous = ''
  private disposeStream: (() => void) | null = null
  seq = 0
  constructor(private host: Host) {
    this.store = new GoalStorage(host.userData, host.session.sessionId)
    this.restore('interrupted')
  }
  get preparing(): boolean { return !!this.job }
  get continuesAtSettled(): boolean {
    return this.live && !this.quota() && this.host.review() !== 'paused' &&
      (this.goal?.status !== 'verifying' || this.host.pending() || this.host.unfinishedTodos() || this.host.review() !== 'ready')
  }
  get live(): boolean { return !this.failed && goalLive(this.goal) }
  get stopsWakes(): boolean { return !this.manualWakes && !!this.goal && !this.live && this.goal.status !== 'completed' }
  async idle(): Promise<void> { await this.jobPromise }
  get snapshot(): GoalSnapshotDTO | null {
    return this.goal ? { ...structuredClone(this.goal), seq: this.seq, autoRuns: this.ledger?.autoRuns ?? 0,
      tokens: this.ledger?.tokens ?? 0, accountingAvailable: !this.failed && !!this.ledger,
      executing: !this.host.session.isIdle || !!this.job, waiting: this.live && this.host.pending() } : null
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
    try { this.ledger = this.store.update(this.goal.id, change, initialize); return true }
    catch { this.fault(); return false }
  }
  private invalidate(): void { this.generation++; this.job?.abort(); this.scheduled = false }
  restore(reason: 'interrupted' | 'rewound'): void {
    this.invalidate()
    // Finish billing the outgoing goal before selecting another branch's fact.
    this.bill()
    if (this.ledger?.run) this.updateLedger(l => { l.run = null })
    this.goal = goalFromBranch(this.host.session.sessionManager.getBranch())
    this.ledger = null
    this.failed = false
    if (this.goal) {
      try { this.ledger = this.store.read(this.goal.id, true) }
      catch { this.fault(); return }
      // Reconcile a persisted run after a hard crash. A claim is never replayed.
      this.bill()
      if (this.ledger.run) this.updateLedger(l => { l.run = null })
      // Restoring must preserve the reviewed SDK leaf and Rewind's journal
      // endpoints. Recovery grants no execution; explicit Resume persists the
      // next transition. Reopening this active branch will pause it again.
      if (goalLive(this.goal)) this.goal = { ...this.goal, status: 'paused', reason }
    }
    this.evaluate = false
    this.publish(true)
  }
  create(objective: string, acceptance: string, limits: GoalLimits): void {
    this.invalidate()
    const id = randomUUID()
    this.goal = { version: 1, id, objective, acceptance, limits: structuredClone(limits),
      status: 'active', reason: null, evidence: null, createdAt: Date.now(), updatedAt: Date.now() }
    this.failed = false
    if (!this.updateLedger(() => {}, true)) return
    this.save({})
    if (this.live) this.start(true)
  }
  limits(limits: GoalLimits): void { this.save({ limits: structuredClone(limits) }) }
  quota(): GoalReason | null {
    if (!this.goal || !this.ledger) return null
    if (this.goal.limits.tokenBudget !== null && this.ledger.tokens >= this.goal.limits.tokenBudget) return 'tokens'
    if (this.ledger.autoRuns >= this.goal.limits.maxAutoRuns) return 'runs'
    return null
  }
  resume(): void {
    if (!this.goal || this.failed || this.quota()) return
    this.invalidate()
    this.manualWakes = false
    this.evaluate = false
    this.updateLedger(l => { l.noProgress = 0; l.fingerprint = null })
    this.save({ status: 'active', reason: null, evidence: null })
    this.start(false)
  }
  pause(reason: GoalReason, persist = true): void {
    this.manualWakes = false
    this.invalidate()
    if (goalLive(this.goal)) {
      if (persist) this.save({ status: 'paused', reason })
      else { this.goal = { ...this.goal!, status: 'paused', reason }; this.publish() }
    }
  }
  cancel(): void {
    this.invalidate()
    if (!this.goal) return
    if (!this.failed) { this.save({ status: 'cancelled', reason: 'user' }); return }
    // Cancellation can still be persisted when only the independent ledger
    // is corrupt. Preserve that ledger; a new goal needs a new explicit ID.
    const next: GoalRecord = { ...this.goal, status: 'cancelled', reason: 'user', updatedAt: Date.now() }
    try { this.host.storage.append(GOAL_ENTRY, next); this.goal = next; this.publish() }
    catch { this.fault() }
  }
  /** A new user turn supersedes a preparing wake without resuming paused state. */
  userPrompt(): void {
    this.invalidate(); this.evaluate = false; this.manualWakes = true
    if (this.goal?.status === 'verifying') this.save({ status: 'active', reason: null, evidence: null })
  }
  private bill(): void {
    if (!this.goal || !this.ledger?.run || this.failed) return
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
  committed(event: AgentSessionEvent): void {
    if (event.type !== 'message_end') return
    this.bill()
    const message = event.message
    // Verification cannot certify mutations/failures or late outcomes that
    // arrived after its receipt. Let the model review the new evidence first.
    if (this.goal?.status === 'verifying' && (
      message.role === 'toolResult' && message.toolName !== GOAL_UPDATE &&
        (message.isError || !['read', 'grep', 'find', 'ls', GOAL_GET, 'todo_write'].includes(message.toolName)) ||
      message.role === 'custom' && [BASH_COMPLETION_TYPE, SUBAGENT_COMPLETION_TYPE, ASK_USER_ANSWER_TYPE].includes(message.customType))) {
      this.save({ status: 'active', reason: null, evidence: null })
    }
    if (message.role !== 'toolResult' || message.toolName !== GOAL_UPDATE || message.isError || !this.live) return
    const data = message.details as { kind?: string; goalId?: string; status?: string; evidence?: string } | undefined
    if (data?.kind !== GOAL_RECEIPT || data.goalId !== this.goal?.id || !['complete', 'blocked'].includes(data.status ?? '') || typeof data.evidence !== 'string' || !data.evidence.trim()) return
    this.save({ status: data.status === 'complete' ? 'verifying' : 'blocked', reason: null,
      evidence: data.evidence.slice(0, 8000) })
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
      if (generation === this.generation) this.start(false)
    })
  }
  private content(initial: boolean): string {
    const g = this.goal!
    return initial ? `Work on this goal until its acceptance criteria are verified. Use the existing Todo list to track the work.\n\n${g.objective}\n\nAcceptance criteria:\n${g.acceptance}` :
      `Continue the current goal from the committed results; preserve completed work and use the existing Todo list. Goal and acceptance criteria (quoted JSON): ${JSON.stringify({ id: g.id, objective: g.objective, acceptance: g.acceptance })}. Check remaining work and verify it. Request completion through update_goal only with concrete evidence for every criterion; report a concrete external blocker if necessary. Respect user instructions and permissions.`
  }
  private start(initial: boolean): void {
    if (!this.live || this.disposed || this.job || !this.host.available() || this.host.pending()) return
    const review = this.host.review()
    if (review === 'paused') { this.pause('review'); return }
    // Completion requires a committed receipt, no unfinished Todo and a settled review.
    if (this.goal?.status === 'verifying' && !this.host.unfinishedTodos() && review === 'ready') {
      this.save({ status: 'completed', reason: null }); return
    }
    const quota = this.quota()
    if (quota) { this.pause(quota); return }
    let release: () => void
    try { release = this.host.reserve() } catch { return }
    const controller = this.job = new AbortController()
    const generation = this.generation
    const accepted = () => generation === this.generation && !controller.signal.aborted && this.live && !this.disposed && this.host.available() && !this.host.pending()
    this.jobPromise = (async () => {
      try {
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
        // The durable claim is charged once, before dispatch; crash recovery never replays it.
        if (!this.updateLedger(l => {
          if (!initial) l.autoRuns++
          l.run = { id: dispatchId, state: 'claimed', before: this.host.session.sessionManager.getEntries().map(e => e.id) }
        })) return
        this.publish()
        await this.host.run(this.content(initial), initial, dispatchId, controller.signal, accepted)
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
    if (this.ledger?.run?.id === dispatchId) this.updateLedger(l => { if (l.run?.id === dispatchId) l.run.state = 'started' })
  }
  /** Bound every primary model request, including SDK/Jev continuations within a run. */
  installStreamGuard(): void {
    const agent = this.host.session.agent
    const previous = agent.streamFunction
    const stream: typeof previous = async (model, context, options) => {
      this.bill()
      const owned = this.live || !this.manualWakes || (!this.failed && !!this.ledger?.run)
      if (owned && (this.failed || this.ledger?.run && this.goal?.limits.tokenBudget !== null && this.ledger.tokens >= (this.goal?.limits.tokenBudget ?? Infinity))) {
        if (!this.failed) this.pause('tokens')
        const message = { role: 'assistant' as const, content: [], api: model.api, provider: model.provider, model: model.id,
          stopReason: 'aborted' as const, errorMessage: 'GOAL_TOKEN_BUDGET', timestamp: Date.now(),
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
    this.disposed = true
    this.disposeStream?.()
    // The manager still observes committed abort results before removing subscribers.
  }
}
