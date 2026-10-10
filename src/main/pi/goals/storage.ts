import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, openSync, fsyncSync, closeSync, renameSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import lockfile from 'proper-lockfile'

export interface GoalLedger {
  version: 1
  goalId: string
  autoRuns: number
  tokens: number
  billed: string[]
  /** All entry IDs existing before this owned run. Recovery bills newer entries once. */
  run: { id: string; before: string[]; state: 'claimed' | 'started' } | null
  fingerprint: string | null
  noProgress: number
}
export function emptyLedger(goalId: string): GoalLedger {
  return { version: 1, goalId, autoRuns: 0, tokens: 0, billed: [], run: null, fingerprint: null, noProgress: 0 }
}
type Scope = Pick<GoalLedger, 'run' | 'fingerprint' | 'noProgress'>
type StoredLedger = GoalLedger & { scopes?: Record<string, Scope> }
const validRun = (run: GoalLedger['run']) => run === null || !!run && typeof run.id === 'string' && Array.isArray(run.before) &&
  run.before.every(i => typeof i === 'string') && ['claimed', 'started'].includes(run.state)
const validScope = (s: Scope) => !!s && validRun(s.run) && Number.isSafeInteger(s.noProgress) && s.noProgress >= 0 &&
  (s.fingerprint === null || typeof s.fingerprint === 'string')
const key = (sessionId: string, id: string) => createHash('sha256').update(`${sessionId}\0${id}`).digest('hex')
function atomic(path: string, value: unknown, root: string): void {
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' })
    const fd = openSync(temporary, 'r+')
    try { fsyncSync(fd) } finally { closeSync(fd) }
    renameSync(temporary, path)
    const directory = openSync(root, 'r')
    try { fsyncSync(directory) } finally { closeSync(directory) }
  } finally { try { unlinkSync(temporary) } catch { /* renamed or not written */ } }
}
/** Independent of conversation branches: rewind never refunds or replays a dispatch. */
export class GoalStorage {
  private root: string
  constructor(userData: string, private sessionId: string) { this.root = join(userData, 'goals') }
  private path(id: string, sessionId = this.sessionId): string { return join(this.root, key(sessionId, id) + '.json') }
  owner(id: string): string {
    try {
      const alias = JSON.parse(readFileSync(join(this.root, key(this.sessionId, id) + '.fork'), 'utf8'))
      if (alias.version !== 1 || alias.goalId !== id || alias.sessionId !== this.sessionId ||
        typeof alias.ownerSessionId !== 'string' || !alias.ownerSessionId || alias.ownerSessionId.length > 80) throw new Error('goal-fork-accounting-unavailable')
      return alias.ownerSessionId
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return this.sessionId
      throw error
    }
  }
  /** Forks share spending, but never another session's dispatch or progress. */
  linkFork(source: GoalStorage, id: string): void {
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
    let ownerSessionId: string | null = null
    try { ownerSessionId = source.owner(id) } catch { /* inherit unavailable accounting, never a new allowance */ }
    atomic(join(this.root, key(this.sessionId, id) + '.fork'), { version: 1, sessionId: this.sessionId, goalId: id, ownerSessionId }, this.root)
  }
  private readStored(id: string, owner: string, required: boolean): StoredLedger {
    try {
      const data: StoredLedger = JSON.parse(readFileSync(this.path(id, owner), 'utf8'))
      if (data.version !== 1 || data.goalId !== id || !Number.isSafeInteger(data.autoRuns) || data.autoRuns < 0 ||
        !Number.isSafeInteger(data.tokens) || data.tokens < 0 || !Array.isArray(data.billed) || data.billed.some(i => typeof i !== 'string') ||
        !validScope(data) || (data.scopes !== undefined && (!data.scopes || typeof data.scopes !== 'object' || Array.isArray(data.scopes) ||
          Object.entries(data.scopes).some(([sessionId, scope]) => !sessionId || sessionId.length > 80 || !validScope(scope))))) throw new Error('goal-ledger-invalid')
      return data
    } catch (error) {
      if (!required && (error as NodeJS.ErrnoException).code === 'ENOENT') return emptyLedger(id)
      throw error
    }
  }
  read(id: string, required = false): GoalLedger {
    const owner = this.owner(id)
    const data = this.readStored(id, owner, required || owner !== this.sessionId)
    const scope = data.scopes && Object.hasOwn(data.scopes, this.sessionId) ? data.scopes[this.sessionId] :
      owner === this.sessionId ? data : { run: null, fingerprint: null, noProgress: 0 }
    const { scopes: _scopes, ...ledger } = data
    return { ...ledger, run: scope.run, fingerprint: scope.fingerprint, noProgress: scope.noProgress }
  }
  update(id: string, change: (ledger: GoalLedger) => void, initialize = false): GoalLedger {
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
    const owner = this.owner(id)
    const path = this.path(id, owner)
    const release = lockfile.lockSync(path, { realpath: false, retries: 0, stale: 10_000 })
    try {
      const data = this.readStored(id, owner, !initialize || owner !== this.sessionId)
      const next = this.read(id, !initialize)
      change(next)
      const scopes: Record<string, Scope> = Object.assign(Object.create(null), data.scopes,
        { [this.sessionId]: { run: next.run, fingerprint: next.fingerprint, noProgress: next.noProgress } })
      if (!Object.hasOwn(scopes, owner)) scopes[owner] = { run: data.run, fingerprint: data.fingerprint, noProgress: data.noProgress }
      atomic(path, { ...next, scopes, ...scopes[owner] }, this.root)
      return next
    } finally {
      release()
    }
  }
}
