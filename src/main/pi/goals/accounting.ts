import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { SessionManager, type SessionEntry } from '@earendil-works/pi-coding-agent'
import { validGoalBillingOwner, type GoalBillingOwner } from '../../../shared/goal'
import { GoalStorage, type GoalLedger } from './storage'
import { SUBAGENT_RUN_TYPE } from '../subagents/protocol'

type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number }
interface Source {
  version: 1; id: string; owner: GoalBillingOwner; kind: 'subagent' | 'jev'
  sessionId: string; runId: string; sessionPath?: string; before?: string[]; callId?: string; subagentRunId?: string
}
interface Charge {
  version: 1; id: string; sourceId: string; kind: Source['kind']; sessionId: string; runId: string
  entryId: string; usage: Usage; providerRequestId?: string; subagentRunId?: string
}
interface ResponseReceipt { version: 1; sourceId: string; requestId: string; sequence: number; before: string[]; usage?: Usage }
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const total = (usage: Usage) => usage.input + usage.output + usage.cacheRead + usage.cacheWrite
const token = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
export function goalUsage(value: unknown): Usage | null {
  if (!value || typeof value !== 'object') return null
  const u = value as Usage
  if (![u.input, u.output, u.cacheRead ?? 0, u.cacheWrite ?? 0].every(token)) return null
  const usage = { input: u.input, output: u.output, cacheRead: u.cacheRead ?? 0, cacheWrite: u.cacheWrite ?? 0 }
  return token(total(usage)) ? usage : null
}
export class GoalAccountingError extends Error {
  constructor(readonly code: 'quota' | 'unavailable') { super(`goal-accounting-${code}`) }
}
function atomic(path: string, value: unknown): void {
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 })
    const fd = openSync(temporary, 'r+'); try { fsyncSync(fd) } finally { closeSync(fd) }
    renameSync(temporary, path)
    const directory = openSync(dirname(path), 'r'); try { fsyncSync(directory) } finally { closeSync(directory) }
  } finally { try { unlinkSync(temporary) } catch { /* renamed or never created */ } }
}
function json<T>(path: string): T { return JSON.parse(readFileSync(path, 'utf8')) as T }
const independent = (ledger: GoalLedger) => ledger.independent ??= { sources: [], billed: [], unresolved: [], subagentTokens: 0, jevTokens: 0 }

/** Main-owned provenance and receipts survive branch changes, child deletion,
 * and crashes between a durable response and applying it to the shared pool. */
export class GoalAccounting {
  private live = new Set<string>()
  constructor(private userData: string, private changed: (owner: GoalBillingOwner) => void = () => {}) {}
  private pool(owner: GoalBillingOwner): GoalStorage { return new GoalStorage(this.userData, owner.ownerSessionId) }
  private directory(owner: GoalBillingOwner): string { return join(this.userData, 'goals', 'charges', hash(`${owner.ownerSessionId}\0${owner.goalId}`)) }
  private sourcePath(source: Source): string { return join(this.directory(source.owner), `${source.id}.source.json`) }
  private prepare(owner: GoalBillingOwner): void {
    const directory = this.directory(owner)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    for (const path of [directory, dirname(directory), dirname(dirname(directory)), this.userData]) {
      const fd = openSync(path, 'r'); try { fsyncSync(fd) } finally { closeSync(fd) }
    }
  }
  private register(source: Source): void {
    this.prepare(source.owner)
    if (existsSync(this.sourcePath(source))) {
      if (JSON.stringify(json<Source>(this.sourcePath(source))) !== JSON.stringify(source)) throw new GoalAccountingError('unavailable')
    } else atomic(this.sourcePath(source), source)
    this.pool(source.owner).update(source.owner.goalId, l => {
      const ids = independent(l).sources
      if (!ids.includes(source.id)) ids.push(source.id)
    })
    this.live.add(source.id)
  }
  check(owner: GoalBillingOwner, budget = owner.tokenBudget): void {
    if (!validGoalBillingOwner(owner)) throw new GoalAccountingError('unavailable')
    const ledger = this.pool(owner).read(owner.goalId, true)
    if (ledger.independent?.unresolved.length) throw new GoalAccountingError('unavailable')
    if (budget !== null && ledger.tokens >= budget) throw new GoalAccountingError('quota')
  }
  private apply(owner: GoalBillingOwner, charge: Charge): void {
    if (this.pool(owner).read(owner.goalId, true).independent?.billed.includes(charge.id)) return
    this.pool(owner).update(owner.goalId, ledger => {
      const data = independent(ledger)
      if (data.billed.includes(charge.id)) return
      const tokens = total(charge.usage)
      if (!token(ledger.tokens + tokens)) throw new GoalAccountingError('unavailable')
      ledger.tokens += tokens
      data[charge.kind === 'subagent' ? 'subagentTokens' : 'jevTokens'] += tokens
      data.billed.push(charge.id)
    })
    this.changed(owner)
  }
  private charge(source: Source, entryId: string, usage: Usage, providerRequestId?: string): void {
    if (!goalUsage(usage)) throw new GoalAccountingError('unavailable')
    const id = hash(`${source.id}\0${entryId}`), path = join(this.directory(source.owner), `${id}.charge.json`)
    const charge: Charge = { version: 1, id, sourceId: source.id, kind: source.kind, sessionId: source.sessionId, runId: source.runId, entryId, usage,
      ...(providerRequestId && providerRequestId.length <= 256 ? { providerRequestId } : {}), ...(source.subagentRunId ? { subagentRunId: source.subagentRunId } : {}) }
    if (existsSync(path)) {
      const saved = json<Charge>(path)
      if (JSON.stringify(saved) !== JSON.stringify(charge)) throw new GoalAccountingError('unavailable')
    } else atomic(path, charge)
    this.apply(source.owner, charge)
  }
  private unresolved(source: Source, pending: boolean): void {
    const current = this.pool(source.owner).read(source.owner.goalId, true).independent?.unresolved.includes(source.id) ?? false
    if (current === pending) return
    this.pool(source.owner).update(source.owner.goalId, ledger => {
      const data = independent(ledger)
      if (pending && !data.unresolved.includes(source.id)) data.unresolved.push(source.id)
      else if (!pending) data.unresolved = data.unresolved.filter(id => id !== source.id)
    })
    this.changed(source.owner)
  }
  private close(source: Source): void {
    atomic(join(this.directory(source.owner), `${source.id}.closed.json`), { version: 1, id: source.id })
    this.live.delete(source.id)
  }
  jev(owner: GoalBillingOwner, sessionId: string, requestId: string, callId?: string, subagentRunId?: string) {
    this.check(owner)
    const source: Source = { version: 1, id: hash(`jev\0${sessionId}\0${requestId}`), kind: 'jev', owner, sessionId, runId: requestId,
      ...(callId ? { callId } : {}), ...(subagentRunId ? { subagentRunId } : {}) }
    this.register(source)
    let finished = false
    return {
      record: (usage: Usage, providerRequestId?: string) => {
        this.charge(source, requestId, usage, providerRequestId)
        this.unresolved(source, false)
        finished = true
        this.close(source)
      },
      uncertain: () => { if (!finished) { this.live.delete(source.id); this.unresolved(source, true) } }
    }
  }
  child(owner: GoalBillingOwner, manager: SessionManager, runId: string) {
    this.check(owner)
    const source: Source = { version: 1, id: hash(`child\0${manager.getSessionId()}\0${runId}`), kind: 'subagent', owner,
      sessionId: manager.getSessionId(), sessionPath: manager.getSessionFile()!, runId, before: manager.getEntries().map(e => e.id) }
    this.register(source)
    let requestSequence = 0
    let closed = false
    const flush = () => {
      try {
        const fd = openSync(source.sessionPath!, 'r+'); try { fsyncSync(fd) } finally { closeSync(fd) }
        this.billChild(source, manager.getEntries())
        if (this.pool(owner).read(owner.goalId, true).independent?.unresolved.includes(source.id)) this.recoverChildRequests(source, manager.getEntries())
      } catch (error) { this.unresolved(source, true); throw error }
    }
    return { owner, runId, flush, check: (budget?: number | null) => { flush(); this.check(owner, budget === undefined ? owner.tokenBudget : budget) },
      beforeRequest: () => {
        const requestId = randomUUID()
        const receipt: ResponseReceipt = { version: 1, sourceId: source.id, requestId, sequence: ++requestSequence, before: manager.getEntries().map(e => e.id) }
        const id = hash(`${source.id}\0${requestId}`), path = join(this.directory(owner), `${id}.request.json`)
        atomic(path, receipt)
        this.pool(owner).update(owner.goalId, ledger => { (independent(ledger).requests ??= []).push(id) })
        return { finish: (usage: unknown) => {
          const actual = goalUsage(usage)
          atomic(path, { ...receipt, ...(actual ? { usage: actual } : {}) })
          if (actual) this.charge(source, `request:${requestId}`, actual)
          else this.unresolved(source, true)
        } }
      },
      close: () => {
        if (closed) return
        try {
          flush()
          if (this.recoverChildRequests(source, manager.getEntries())) { this.close(source); closed = true }
        } finally { this.live.delete(source.id) }
      },
      abandon: () => { if (!closed) { this.live.delete(source.id); this.unresolved(source, true) } }
    }
  }
  private childEntries(source: Source, entries: readonly SessionEntry[]): SessionEntry[] {
    const before = new Set(source.before)
    const result: SessionEntry[] = []
    let owned = false
    for (const entry of entries) {
      if (before.has(entry.id)) continue
      if (entry.type === 'custom' && entry.customType === SUBAGENT_RUN_TYPE) {
        if ((entry.data as { runId?: string }).runId !== source.runId) break
        owned = true
      }
      if (owned) result.push(entry)
    }
    return result
  }
  private billChild(source: Source, entries: readonly SessionEntry[]): void {
    const requests = this.childRequests(source), owned = this.childEntries(source, entries)
    const requestByEntry = new Map<string, ResponseReceipt>()
    requests.forEach((request, index) => this.requestEntries(requests, index, owned).forEach(entry => requestByEntry.set(entry.id, request)))
    const billed = new Set(this.pool(source.owner).read(source.owner.goalId, true).independent?.billed)
    for (const entry of owned) {
      const request = requestByEntry.get(entry.id)
      const entryId = request ? `request:${request.requestId}` : entry.id
      if (billed.has(hash(`${source.id}\0${entryId}`))) continue
      const usage = entry.type === 'message' && 'usage' in entry.message ? entry.message.usage : 'usage' in entry ? entry.usage : undefined
      if (!usage) continue
      const actual = goalUsage(usage)
      if (!actual) throw new GoalAccountingError('unavailable')
      if (total(actual)) this.charge(source, entryId, actual)
    }
  }
  private childRequests(source: Source): ResponseReceipt[] {
    const requests = readdirSync(this.directory(source.owner)).filter(name => name.endsWith('.request.json')).flatMap(name => {
      const request = json<ResponseReceipt>(join(this.directory(source.owner), name))
      if (request.sourceId !== source.id) return []
      if (request.version !== 1 || !Array.isArray(request.before) || !request.before.every(id => typeof id === 'string') ||
        typeof request.requestId !== 'string' || !request.requestId || name !== `${hash(`${source.id}\0${request.requestId}`)}.request.json` ||
        !token(request.sequence) || !request.sequence || request.usage !== undefined && !goalUsage(request.usage)) throw new GoalAccountingError('unavailable')
      return [request]
    }).sort((a, b) => a.sequence - b.sequence)
    if (requests.some((request, index) => request.sequence !== index + 1)) throw new GoalAccountingError('unavailable')
    return requests
  }
  private requestEntries(requests: ResponseReceipt[], index: number, owned: readonly SessionEntry[]): SessionEntry[] {
    const before = new Set(requests[index].before), next = requests[index + 1], nextBefore = next && new Set(next.before)
    // Tool/summary/standalone usage belongs to its own SDK entry. It cannot
    // prove that a lost primary response was accounted for.
    return owned.filter(e => !before.has(e.id) && (!nextBefore || nextBefore.has(e.id)) && e.type === 'message' && e.message.role === 'assistant')
  }
  private recoverChildRequests(source: Source, entries: readonly SessionEntry[]): boolean {
    const owned = this.childEntries(source, entries)
    let unknown = false
    const requests = this.childRequests(source)
    for (const [index, request] of requests.entries()) {
      const responses = this.requestEntries(requests, index, owned)
      if (responses.length > 1) { unknown = true; continue }
      const response = responses[0]?.type === 'message' && responses[0].message.role === 'assistant' ? responses[0].message : null
      const persisted = response && goalUsage(response.usage)
      if (request.usage) {
        this.charge(source, `request:${request.requestId}`, request.usage)
        if (persisted && total(persisted) && JSON.stringify(persisted) !== JSON.stringify(request.usage)) unknown = true
      } else if (persisted && (total(persisted) || response && !['aborted', 'error'].includes(response.stopReason))) {
        this.charge(source, `request:${request.requestId}`, persisted)
      } else unknown = true
    }
    this.unresolved(source, unknown)
    return !unknown
  }
  /** No execution or branch append: recover private receipts and read-only SDK files. */
  recover(owner: GoalBillingOwner): void {
    const pool = this.pool(owner), ledger = pool.read(owner.goalId, true), directory = this.directory(owner)
    if (!existsSync(directory)) {
      if (ledger.independent?.sources.length) throw new GoalAccountingError('unavailable')
      return
    }
    const sources = new Map<string, Source>()
    for (const name of readdirSync(directory).filter(name => name.endsWith('.source.json'))) {
      const source = json<Source>(join(directory, name))
      if (source.version !== 1 || !/^[a-f0-9]{64}$/.test(source.id) || name !== `${source.id}.source.json` || !validGoalBillingOwner(source.owner) ||
        source.owner.goalId !== owner.goalId || source.owner.ownerSessionId !== owner.ownerSessionId || !['subagent', 'jev'].includes(source.kind) ||
        source.subagentRunId !== undefined && (typeof source.subagentRunId !== 'string' || !source.subagentRunId || source.subagentRunId.length > 160) ||
        typeof source.sessionId !== 'string' || !source.sessionId || source.sessionId.length > 160 || typeof source.runId !== 'string' || !source.runId || source.runId.length > 160 ||
        source.id !== hash(`${source.kind === 'subagent' ? 'child' : 'jev'}\0${source.sessionId}\0${source.runId}`) ||
        source.kind === 'subagent' && (!source.sessionPath || !isAbsolute(source.sessionPath) || !Array.isArray(source.before) || !source.before.every(id => typeof id === 'string'))) throw new GoalAccountingError('unavailable')
      sources.set(source.id, source)
    }
    if (ledger.independent?.sources.some(id => !sources.has(id))) throw new GoalAccountingError('unavailable')
    if ([...sources.keys()].some(id => !ledger.independent?.sources.includes(id))) {
      pool.update(owner.goalId, next => { const ids = independent(next).sources; for (const id of sources.keys()) if (!ids.includes(id)) ids.push(id) })
    }
    if (ledger.independent?.billed.some(id => !existsSync(join(directory, `${id}.charge.json`))) ||
      ledger.independent?.requests?.some(id => !existsSync(join(directory, `${id}.request.json`)))) throw new GoalAccountingError('unavailable')
    const reported = new Set<string>()
    const totals = { subagent: 0, jev: 0 }
    for (const name of readdirSync(directory).filter(name => name.endsWith('.charge.json'))) {
      const charge = json<Charge>(join(directory, name)), source = sources.get(charge.sourceId)
      if (!source || charge.version !== 1 || charge.id !== hash(`${source.id}\0${charge.entryId}`) || name !== `${charge.id}.charge.json` ||
        charge.kind !== source.kind || charge.sessionId !== source.sessionId || charge.runId !== source.runId || charge.subagentRunId !== source.subagentRunId || !goalUsage(charge.usage)) throw new GoalAccountingError('unavailable')
      this.apply(owner, charge)
      totals[charge.kind] += total(charge.usage)
      reported.add(source.id)
    }
    const applied = pool.read(owner.goalId, true).independent
    if (applied && (applied.subagentTokens !== totals.subagent || applied.jevTokens !== totals.jev)) throw new GoalAccountingError('unavailable')
    for (const source of sources.values()) {
      if (source.kind === 'jev') { this.unresolved(source, !reported.has(source.id) && !this.live.has(source.id)); continue }
      if (this.live.has(source.id)) continue
      this.childRequests(source)
      const closedPath = join(directory, `${source.id}.closed.json`)
      if (existsSync(closedPath)) {
        const closed = json<{ version: number; id: string }>(closedPath)
        if (closed.version !== 1 || closed.id !== source.id) throw new GoalAccountingError('unavailable')
        continue
      }
      try {
        if (!existsSync(source.sessionPath!)) throw new GoalAccountingError('unavailable')
        const manager = SessionManager.open(source.sessionPath!)
        if (manager.getSessionId() !== source.sessionId) throw new GoalAccountingError('unavailable')
        this.billChild(source, manager.getEntries())
        if (this.recoverChildRequests(source, manager.getEntries())) this.close(source)
      } catch { this.unresolved(source, true) }
    }
  }
}
