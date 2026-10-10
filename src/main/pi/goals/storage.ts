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
/** Independent of conversation branches: rewind never refunds or replays a dispatch. */
export class GoalStorage {
  private root: string
  constructor(userData: string, private sessionId: string) { this.root = join(userData, 'goals') }
  private path(id: string): string { return join(this.root, createHash('sha256').update(`${this.sessionId}\0${id}`).digest('hex') + '.json') }
  read(id: string, required = false): GoalLedger {
    try {
      const data: GoalLedger = JSON.parse(readFileSync(this.path(id), 'utf8'))
      if (data.version !== 1 || data.goalId !== id || !Number.isSafeInteger(data.autoRuns) || data.autoRuns < 0 ||
        !Number.isSafeInteger(data.tokens) || data.tokens < 0 || !Array.isArray(data.billed) || data.billed.some(i => typeof i !== 'string') ||
        !Number.isSafeInteger(data.noProgress) || data.noProgress < 0 || (data.fingerprint !== null && typeof data.fingerprint !== 'string') ||
        (data.run !== null && (!data.run || typeof data.run.id !== 'string' || !Array.isArray(data.run.before) ||
          data.run.before.some(i => typeof i !== 'string') || !['claimed', 'started'].includes(data.run.state)))) throw new Error('goal-ledger-invalid')
      return data
    } catch (error) {
      if (!required && (error as NodeJS.ErrnoException).code === 'ENOENT') return emptyLedger(id)
      throw error
    }
  }
  update(id: string, change: (ledger: GoalLedger) => void, initialize = false): GoalLedger {
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
    const path = this.path(id)
    const release = lockfile.lockSync(path, { realpath: false, retries: 0, stale: 10_000 })
    const temporary = `${path}.${randomUUID()}.tmp`
    try {
      const next = this.read(id, !initialize)
      change(next)
      writeFileSync(temporary, JSON.stringify(next), { mode: 0o600, flag: 'wx' })
      const fd = openSync(temporary, 'r+')
      try { fsyncSync(fd) } finally { closeSync(fd) }
      renameSync(temporary, path)
      const directory = openSync(this.root, 'r')
      try { fsyncSync(directory) } finally { closeSync(directory) }
      return next
    } finally {
      try { unlinkSync(temporary) } catch { /* renamed or not written */ }
      release()
    }
  }
}
