import { createInterface } from 'node:readline'
import { createReadStream } from 'node:fs'
import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getAgentDir } from '@earendil-works/pi-coding-agent'
import type { SessionManager } from '@earendil-works/pi-coding-agent'

/**
 * Session sidebar listing index.
 *
 * The sidebar needs a row for EVERY session file in the store — the SDK's
 * `SessionManager.listAll()` re-reads and JSON-parses every byte of every file
 * (and joins every message's text into `allMessagesText`, which nothing here
 * consumes) on EVERY call, and `PiManager.listSessions` is called at boot and
 * again on every turn boundary (`agent_start`/`agent_end`/user `message_end`).
 * With a store of a few hundred files that is hundreds of MiB of parsing per
 * refresh on the Electron main thread — the sidebar lagged far behind the
 * transcript at every launch and re-settled repeatedly during runs.
 *
 * This module keeps the same rows keyed by file path and re-reads a file only
 * when its (mtime, size) changed, or when it is new. The row derivation
 * mirrors the SDK's `buildSessionInfo` exactly (see RowBuilder), so membership
 * and labels stay byte-compatible with the previous SDK-driven list. Two
 * app-side derivations are folded into the same single pass instead of the
 * extra per-file head/tail reads the old path performed:
 * - `subagentChild`: the persisted `pith_subagent_run` marker (the same test
 *   `isSubagentSessionFile` makes on a bounded head — the marker is always
 *   written before the child's first prompt).
 * - `branchHasMessages`: the newest-message-vs-rewind-selection decision of
 *   `selectedBranchHasMessages` (session-branch.ts), answered exactly by
 *   tracking the LAST relevant entry during the forward pass.
 *
 * Rows survive restarts through a small JSON cache in userData, so a launch
 * serves the sidebar after one stat pass and re-parses only the files that
 * changed since the app last ran.
 */

/** Mirrors the SDK `SessionInfo` fields the sidebar actually reads. */
export interface SessionRow {
  path: string
  id: string | undefined
  cwd: string
  name: string | undefined
  parentSessionPath: unknown
  /** Epoch ms from the header; file mtime only backs malformed/missing time. */
  created: number
  /** Epoch ms — last message activity, else header time, else file mtime. */
  modified: number
  /** Counts every `message` entry in the file, all branches included. */
  messageCount: number
  /** First user message text; the SDK's `"(no messages)"` sentinel when none. */
  firstMessage: string
  subagentChild: boolean
  /** Persisted `pith_scheduled_task` marker: the file belongs to a scheduled
   * run and is reachable only from the scheduled tasks view. */
  scheduledTask: boolean
  branchHasMessages: boolean
}

interface FileStamp {
  mtimeMs: number
  size: number
}

interface CachedRow extends SessionRow {
  stamp: FileStamp
}

/** The SDK's own fallback string for sessions with no qualifying first user message. */
const NO_MESSAGES = '(no messages)'

/** Same shape check as the SDK's isMessageWithContent — throws on a missing message, like the SDK's call sites do. */
function isMessageWithContent(message: unknown): message is { role: string; content?: unknown; timestamp?: unknown } {
  return typeof (message as { role?: unknown }).role === 'string' && 'content' in (message as object)
}

/** Mirrors the SDK's extractTextContent (throws on null content, which excludes the file there too). */
function extractTextContent(message: { content?: unknown }): string {
  const content = message.content
  if (typeof content === 'string') return content
  return (content as { type?: string; text?: string }[])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join(' ')
}

/**
 * Accumulates one file's row across its entries, in order. Both the disk
 * reader (raw JSONL lines) and the live-session derivation (parsed entries)
 * feed the same builder, so the two paths cannot drift.
 */
class RowBuilder {
  private header: { id: string | undefined; cwd: unknown; parentSession: unknown; timestamp: unknown } | null = null
  private invalid = false
  /** True once the file is known to be unlistable (no session header first). */
  get excluded(): boolean {
    return this.invalid
  }
  private name: string | undefined
  private messageCount = 0
  private lastActivity: number | undefined
  private firstUserText = ''
  private subagentStart = false
  private scheduledStart = false
  private branchDecision: boolean | undefined

  /** One parsed entry; malformed lines are skipped before reaching here. */
  entry(raw: unknown): void {
    const entry = raw as {
      type?: unknown
      name?: unknown
      customType?: unknown
      data?: { empty?: unknown; target?: unknown } | null
      message?: unknown
      timestamp?: unknown
    }
    if (this.header === null) {
      // The first parsed entry must be the session header (SDK: return null).
      if (entry?.type !== 'session') {
        this.invalid = true
        return
      }
      this.header = {
        id: (entry as { id?: unknown }).id as string | undefined,
        cwd: (entry as { cwd?: unknown }).cwd,
        parentSession: (entry as { parentSession?: unknown }).parentSession,
        timestamp: (entry as { timestamp?: unknown }).timestamp
      }
      return
    }
    if (entry?.type === 'session_info') {
      // Latest wins, explicit clears included (SDK: name?.trim() || undefined).
      this.name = ((entry as { name?: string }).name?.trim() || undefined) as string | undefined
      return
    }
    if (entry?.type === 'custom' && entry.customType === 'pith_subagent_run') this.subagentStart = true
    if (entry?.type === 'custom' && entry.customType === 'pith_scheduled_task') this.scheduledStart = true
    if (entry?.type === 'message') {
      this.messageCount++
      // selectedBranchHasMessages: any message entry decides the branch.
      this.branchDecision = true
      const message = entry.message as { role?: unknown; timestamp?: unknown } | undefined
      if (!isMessageWithContent(message)) return
      const role = message.role
      if (role !== 'user' && role !== 'assistant') return
      const messageTimestamp = message.timestamp
      const activity =
        typeof messageTimestamp === 'number'
          ? messageTimestamp
          : new Date((entry.timestamp ?? Number.NaN) as string | number).getTime()
      if (!Number.isNaN(activity)) this.lastActivity = Math.max(this.lastActivity ?? 0, activity)
      const textContent = extractTextContent(message as { content?: unknown })
      if (!textContent) return
      if (!this.firstUserText && role === 'user') this.firstUserText = textContent.slice(0, 200)
      return
    }
    // The rewind selection decides only while no later message exists; the
    // forward pass keeps the LAST decision, which is the first one scanning
    // backward from the file's end (decisionOf in session-branch.ts).
    if (entry?.type === 'custom' && entry.customType === 'pith_rewind_selection') {
      const data = entry.data
      if (data?.empty === true) this.branchDecision = false
      else this.branchDecision = !(data?.empty === undefined && data?.target === null)
    }
  }

  /** Finish; `mtimeMs` backs `modified` when the file holds no timestamps. */
  finish(path: string, mtimeMs: number): SessionRow | null {
    const header = this.header
    if (this.invalid || !header) return null
    const headerTime = typeof header.timestamp === 'string' ? new Date(header.timestamp).getTime() : Number.NaN
    const modified =
      this.lastActivity !== undefined && this.lastActivity > 0
        ? this.lastActivity
        : !Number.isNaN(headerTime)
          ? headerTime
          : mtimeMs
    return {
      path,
      id: header.id,
      cwd: typeof header.cwd === 'string' ? header.cwd : '',
      name: this.name,
      parentSessionPath: header.parentSession,
      created: Number.isFinite(headerTime) ? headerTime : mtimeMs,
      modified,
      messageCount: this.messageCount,
      firstMessage: this.firstUserText || NO_MESSAGES,
      subagentChild: this.subagentStart,
      scheduledTask: this.scheduledStart,
      // "The whole file holds no message entry and no selection: nothing to show."
      branchHasMessages: this.branchDecision ?? false
    }
  }
}

/**
 * Derive a row from a LIVE session's already-parsed entries. Open sessions
 * (the active chat plus background runs) are the hottest files in the store —
 * they change on every turn — so their rows come from memory instead of a
 * full disk re-parse. `getEntries()` starts with the session header, exactly
 * like the file, and the SDK's entry migrations never touch the fields read
 * here (they adjust ids, versions and the hookMessage role only).
 */
export function rowFromSessionManager(manager: SessionManager): SessionRow | null {
  const path = manager.getSessionFile()
  if (!path) return null
  const builder = new RowBuilder()
  // getEntries() excludes the session header — feed it separately so the
  // builder sees the same entry sequence the file holds.
  const header = manager.getHeader()
  if (header) builder.entry(header)
  for (const entry of manager.getEntries() as unknown[]) builder.entry(entry)
  // Live entries are the freshest truth; mtime only seeds the fallback.
  return builder.finish(path, Date.now())
}

/**
 * Read one session file in a single forward pass, mirroring the SDK's
 * `buildSessionInfo` (including its per-file catch → the file is excluded,
 * never fatal for the listing). Returns null for files without a session
 * header.
 */
export async function readSessionRow(path: string, stamp: FileStamp): Promise<SessionRow | null> {
  try {
    const builder = new RowBuilder()
    const lines = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity })
    for await (const line of lines) {
      const text = line.trim()
      if (!text) continue
      let entry: unknown
      try {
        entry = JSON.parse(text)
      } catch {
        continue
      }
      builder.entry(entry)
      if (builder.excluded) return null
    }
    return builder.finish(path, stamp.mtimeMs)
  } catch {
    return null
  }
}

const CACHE_VERSION = 2
/** Session-file reads run concurrently, bounded like the SDK's own list scan. */
const MAX_CONCURRENT_READS = 10

export class SessionListIndex {
  private rows = new Map<string, CachedRow>()
  private readonly loaded: Promise<void>
  private lastPersisted = ''

  constructor(private readonly cacheFile?: string) {
    this.loaded = this.load()
  }

  private async load(): Promise<void> {
    if (!this.cacheFile) return
    try {
      const parsed = JSON.parse(await readFile(this.cacheFile, 'utf8')) as {
        version?: number
        rows?: CachedRow[]
      }
      if (parsed.version !== CACHE_VERSION || !Array.isArray(parsed.rows)) return
      for (const row of parsed.rows) {
        if (typeof row?.path === 'string' && row.stamp && typeof row.stamp.mtimeMs === 'number') {
          this.rows.set(row.path, row)
        }
      }
      this.lastPersisted = JSON.stringify(parsed)
    } catch {
      // Missing/corrupt cache: the first refresh re-reads everything once.
    }
  }

  list(): SessionRow[] {
    return [...this.rows.values()]
  }

  /**
   * Bring the index up to date: stat every session file, keep rows whose
   * (mtime, size) is unchanged, drop deleted files, re-read the rest, and
   * always re-derive live sessions from memory (their leaf pointer can move
   * without a file write, and they are the files that change per turn).
   */
  async refresh(liveDerive?: (path: string) => SessionRow | undefined): Promise<void> {
    await this.loaded
    const root = join(getAgentDir(), 'sessions')
    const present = new Map<string, FileStamp>()
    try {
      const rootEntries = await readdir(root, { withFileTypes: true })
      const dirs = rootEntries
        .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
        .map((entry) => join(root, entry.name))
      for (const dir of dirs) {
        let names: string[]
        try {
          names = await readdir(dir)
        } catch {
          continue
        }
        for (const name of names) {
          if (!name.endsWith('.jsonl')) continue
          const path = join(dir, name)
          try {
            const stats = await stat(path)
            present.set(path, { mtimeMs: stats.mtimeMs, size: stats.size })
          } catch {
            /* vanished between readdir and stat: not present */
          }
        }
      }
    } catch {
      // Sessions root missing/unreadable: nothing to list.
    }
    for (const path of this.rows.keys()) {
      if (!present.has(path)) this.rows.delete(path)
    }
    const stale: Array<{ path: string; stamp: FileStamp }> = []
    for (const [path, stamp] of present) {
      const cached = this.rows.get(path)
      if (!cached || cached.stamp.mtimeMs !== stamp.mtimeMs || cached.stamp.size !== stamp.size) {
        stale.push({ path, stamp })
      }
    }
    const stalePaths = new Set(stale.map((item) => item.path))
    let index = 0
    const worker = async (): Promise<void> => {
      while (index < stale.length) {
        const { path, stamp } = stale[index++]
        const live = liveDerive?.(path)
        const row = live ?? (await readSessionRow(path, stamp))
        if (row) this.rows.set(path, { ...row, stamp })
        else this.rows.delete(path)
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(MAX_CONCURRENT_READS, stale.length) }, () => worker())
    )
    // Live sessions that were NOT stale still get refreshed from memory: an
    // open session's state can move (leaf navigation) without a disk write.
    for (const [path, stamp] of present) {
      if (stalePaths.has(path)) continue
      const live = liveDerive?.(path)
      if (live) this.rows.set(path, { ...live, stamp })
    }
    void this.persist()
  }

  /** Best-effort persistence so the next launch paints from stat checks. */
  private async persist(): Promise<void> {
    if (!this.cacheFile) return
    try {
      const payload = JSON.stringify({
        version: CACHE_VERSION,
        rows: [...this.rows.values()].map((row) => ({ ...row, stamp: { mtimeMs: row.stamp.mtimeMs, size: row.stamp.size } }))
      })
      if (payload === this.lastPersisted) return
      this.lastPersisted = payload
      await writeFile(this.cacheFile, payload, 'utf8')
    } catch {
      // Cache write failures are non-fatal; the next refresh re-derives.
    }
  }
}
