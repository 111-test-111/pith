import { createReadStream, type Dirent } from 'node:fs'
import { chmod, mkdir, readdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { DatabaseSync } from 'node:sqlite'
import type { SessionSearchRequest, SessionSearchResultDTO } from '../../shared/types'
import { highlightSearchText, normalizeSearchText, searchGrams, searchTerms } from './session-search-text'
import { contentPassages, isConversationPassage, messagePassages, passageSnippet, type SearchPassage } from './session-search-passages'

const PAGE_SIZE = 40
const INDEX_VERSION = 4

interface DocumentRow {
  rowid: number
  path: string
  id: string
  cwd: string
  title: string
  modified: string
}

/** Stable malformed data can only be repaired by changing the file. I/O
 * failures stay retryable; they must not be cached as permanent corruption. */
class InvalidSessionFile extends Error {}

/** Scheduled-run sessions surface only in the scheduled tasks view: the index
 * drops them without recording a failure. The marker entry sits before the
 * session's first prompt, so detection aborts the read within a few lines. */
class ScheduledTaskSessionFile extends Error {}

export class SessionSearchIndex {
  private incomplete = 0

  private constructor(private db: DatabaseSync, private sessionsDir: string) {}

  static async open(sessionsDir: string, databasePath: string): Promise<SessionSearchIndex> {
    if (databasePath !== ':memory:') await mkdir(dirname(databasePath), { recursive: true })
    const db = new DatabaseSync(databasePath)
    if (databasePath !== ':memory:') await chmod(databasePath, 0o600)
    db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA cache_size = -16000;')
    const version = db.prepare('PRAGMA user_version').get() as { user_version: number }
    if (version.user_version !== INDEX_VERSION) {
      db.exec('DROP TABLE IF EXISTS grams; DROP TABLE IF EXISTS documents; DROP TABLE IF EXISTS index_failures; DROP TABLE IF EXISTS conversation_grams;')
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        rowid INTEGER PRIMARY KEY, path TEXT UNIQUE NOT NULL, fingerprint TEXT NOT NULL,
        id TEXT NOT NULL, cwd TEXT NOT NULL, title TEXT NOT NULL, title_normalized TEXT NOT NULL,
        modified TEXT NOT NULL, body TEXT NOT NULL, body_normalized TEXT NOT NULL,
        conversation_normalized TEXT NOT NULL, conversation_body TEXT NOT NULL, incomplete INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS index_failures (path TEXT PRIMARY KEY, fingerprint TEXT NOT NULL);
      CREATE VIRTUAL TABLE IF NOT EXISTS grams USING fts5(tokens, content='', detail=none);
      CREATE VIRTUAL TABLE IF NOT EXISTS conversation_grams USING fts5(tokens, content='', detail=none);
      PRAGMA user_version = ${INDEX_VERSION};
    `)
    return new SessionSearchIndex(db, sessionsDir)
  }

  /** A metadata scan per request catches app/CLI appends, same-size rewrites,
   * renamed titles, new folders and deletions. Only changed JSONL is read.
   * Directory failures retain the previous index, but report incompleteness. */
  async sync(): Promise<void> {
    this.incomplete = 0
    const files = new Set<string>()
    const failedDirectories = new Set<string>()
    let directories: Dirent[]
    try {
      directories = await readdir(this.sessionsDir, { withFileTypes: true })
    } catch (error: any) {
      if (error.code !== 'ENOENT') throw error
      directories = []
    }
    await Promise.all(directories.filter((dir) => dir.isDirectory() || dir.isSymbolicLink()).map(async (dir) => {
      const path = join(this.sessionsDir, dir.name)
      try {
        for (const name of await readdir(path)) if (name.endsWith('.jsonl')) files.add(join(path, name))
      } catch {
        failedDirectories.add(path)
        this.incomplete++
      }
    }))
    const existing = new Map((this.db.prepare('SELECT path, fingerprint, incomplete FROM documents').all() as
      { path: string; fingerprint: string; incomplete: number }[]).map((row) => [row.path, row]))
    const failed = new Map((this.db.prepare('SELECT path, fingerprint FROM index_failures').all() as
      { path: string; fingerprint: string }[]).map((row) => [row.path, row.fingerprint]))
    // Small batches bound open files and memory even with thousands of sessions.
    const paths = [...files]
    for (let i = 0; i < paths.length; i += 16) {
      const batch = await Promise.all(paths.slice(i, i + 16).map(async (path) => {
        try { return { path, stats: await stat(path) } } catch { return { path, stats: null } }
      }))
      for (const { path, stats } of batch) {
        if (!stats) { this.remove(path); this.incomplete++; continue }
        const fingerprint = `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`
        const indexed = existing.get(path)
        if (indexed?.fingerprint === fingerprint) { this.incomplete += indexed.incomplete; continue }
        if (failed.get(path) === fingerprint) { this.incomplete++; continue }
        try {
          await this.indexFile(path, fingerprint, stats.mtime.toISOString())
        } catch (error) {
          if (error instanceof ScheduledTaskSessionFile) { this.remove(path); continue }
          // Never present an old match from a file that was replaced/corrupted.
          this.remove(path)
          if (error instanceof InvalidSessionFile) {
            this.db.prepare('INSERT OR REPLACE INTO index_failures(path, fingerprint) VALUES (?, ?)').run(path, fingerprint)
          }
          this.incomplete++
        }
      }
    }
    for (const path of new Set([...existing.keys(), ...failed.keys()])) {
      if (!files.has(path) && !failedDirectories.has(dirname(path))) this.remove(path)
    }
  }

  private async indexFile(path: string, fingerprint: string, fallbackTime: string): Promise<void> {
    const stream = createReadStream(path, { encoding: 'utf8' })
    const lines = createInterface({ input: stream, crlfDelay: Infinity })
    let header: any = null
    let title = ''
    let firstUser = ''
    let count = 0
    let modified = 0
    let incomplete = false
    const passages: SearchPassage[] = []
    try {
      for await (const line of lines) {
        if (!line.trim()) continue
        let entry: any
        try { entry = JSON.parse(line) } catch { incomplete = true; continue }
        if (!entry || typeof entry !== 'object') { incomplete = true; continue }
        if (!header) {
          if (entry.type !== 'session' || typeof entry.id !== 'string' || !entry.id || typeof entry.cwd !== 'string' || !entry.cwd) throw new InvalidSessionFile('Invalid session header')
          header = entry
          continue
        }
        if (entry.type === 'custom' && entry.customType === 'pith_scheduled_task') throw new ScheduledTaskSessionFile()
        if (entry.type === 'session_info') title = typeof entry.name === 'string' ? entry.name.trim() : ''
        if (entry.type === 'message') {
          count++
          const message = entry.message
          if (!firstUser && message?.role === 'user') firstUser = contentPassages(message.content, 'user').filter((p) => p.source === 'user').map((p) => p.text).join(' ').trim()
          const time = typeof message?.timestamp === 'number' ? message.timestamp : Date.parse(entry.timestamp)
          if (Number.isFinite(time)) modified = Math.max(modified, time)
          passages.push(...messagePassages(message))
        } else if (entry.type === 'compaction' || entry.type === 'branch_summary') {
          if (typeof entry.summary === 'string') passages.push({ text: entry.summary, source: 'summary' })
        } else if (entry.type === 'custom_message' && entry.display !== false) {
          passages.push(...messagePassages({ ...entry, role: 'custom' }))
          count++
        }
      }
    } finally {
      lines.close()
      stream.destroy()
    }
    if (!header) throw new InvalidSessionFile('Missing session header')
    if (incomplete) this.incomplete++
    if (!count) { this.remove(path); return }
    title ||= firstUser.slice(0, 80)
    // Keep passage boundaries: a quoted phrase cannot accidentally cross from
    // one message/block to the next. Whitespace within a block is normalized.
    const blocks = passages.map((p) => ({ ...p, text: p.text.replace(/\s+/gu, ' ').trim() })).filter((p) => p.text)
    const body = JSON.stringify(blocks)
    const normalized = blocks.map((p) => normalizeSearchText(p.text)).join('\n')
    const conversation = blocks.filter(isConversationPassage).map((p) => normalizeSearchText(p.text)).join('\n')
    const normalizedTitle = normalizeSearchText(title)
    const tokens = searchGrams(`${normalizedTitle}\n${normalized}`, true).join(' ')
    const conversationTokens = searchGrams(`${normalizedTitle}\n${conversation}`, true).join(' ')
    this.db.exec('BEGIN')
    try {
      this.remove(path)
      const row = this.db.prepare(`INSERT INTO documents
        (path, fingerprint, id, cwd, title, title_normalized, modified, body, body_normalized, conversation_normalized, conversation_body, incomplete)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING rowid`).get(
          path, fingerprint, header.id, header.cwd, title, normalizedTitle,
          modified ? new Date(modified).toISOString() : fallbackTime, body, normalized, conversation, JSON.stringify(blocks.filter(isConversationPassage)), Number(incomplete)
        ) as { rowid: number }
      this.db.prepare('INSERT INTO grams(rowid, tokens) VALUES (?, ?)').run(row.rowid, tokens)
      this.db.prepare('INSERT INTO conversation_grams(rowid, tokens) VALUES (?, ?)').run(row.rowid, conversationTokens)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  private remove(path: string): void {
    this.db.prepare('DELETE FROM index_failures WHERE path = ?').run(path)
    const previous = this.db.prepare('SELECT rowid, title_normalized, body_normalized, conversation_normalized FROM documents WHERE path = ?').get(path) as
      { rowid: number; title_normalized: string; body_normalized: string; conversation_normalized: string } | undefined
    if (!previous) return
    // Contentless FTS needs the original tokens for deletion. Only modified or
    // deleted sessions pay for rebuilding them; queries never do.
    this.db.prepare("INSERT INTO grams(grams, rowid, tokens) VALUES ('delete', ?, ?)").run(
      previous.rowid, searchGrams(`${previous.title_normalized}\n${previous.body_normalized}`, true).join(' '))
    this.db.prepare("INSERT INTO conversation_grams(conversation_grams, rowid, tokens) VALUES ('delete', ?, ?)").run(
      previous.rowid, searchGrams(`${previous.title_normalized}\n${previous.conversation_normalized}`, true).join(' '))
    this.db.prepare('DELETE FROM documents WHERE path = ?').run(path)
  }

  search(request: SessionSearchRequest): SessionSearchResultDTO {
    if (!request || typeof request.query !== 'string' || request.query.length > 512 ||
      (request.sort !== undefined && !['newest', 'oldest'].includes(request.sort)) ||
      (request.includeDetails !== undefined && typeof request.includeDetails !== 'boolean')) {
      throw new Error('Invalid search request')
    }
    // 'oldest' is the exact mirror of the default: folder groups keep their
    // whole-set ordering (never a page-local one) and sessions within a group
    // read the other way round.
    const oldest = request.sort === 'oldest'
    const direction = oldest ? 'ASC' : 'DESC'
    const terms = searchTerms(request.query)
    if (!terms.length) return { hits: [], total: 0, incomplete: this.incomplete }
    const includeDetails = request.includeDetails === true
    const bodyColumn = includeDetails ? 'body_normalized' : 'conversation_normalized'
    const gramQuery = [...new Set(terms.flatMap((term) => searchGrams(term)))].join(' AND ')
    // Separate candidates keep ordinary dialogue searches independent of
    // megabytes of tool output; detail=none does not support column filters.
    const gramTable = includeDetails ? 'grams' : 'conversation_grams'
    const matchCondition = terms.map(() =>
      `(instr(title_normalized, ?) > 0 OR instr(${bodyColumn}, ?) > 0)`).join(' AND ')
    const matchValues = terms.flatMap((term) => [term, term])
    const filter = `rowid IN (SELECT rowid FROM ${gramTable} WHERE ${gramTable} MATCH ?) AND ${matchCondition}`
    const total = (this.db.prepare(`SELECT count(*) AS total FROM documents WHERE ${filter}`).get(
      gramQuery, ...matchValues) as { total: number }).total
    const offset = Number.isSafeInteger(request.offset) ? Math.max(0, request.offset!) : 0
    // Group the complete verified match set BEFORE pagination. A global time
    // sort followed by renderer-only grouping would interleave folders across
    // pages. Folders use their newest (or oldest) matching session; ties use
    // stable paths.
    const rows = this.db.prepare(`SELECT rowid, path, id, cwd, title, modified,
      ${oldest ? 'MIN' : 'MAX'}(modified) OVER (PARTITION BY cwd) AS folderModified
      FROM documents WHERE ${filter}
      ORDER BY folderModified ${direction}, cwd ASC, modified ${direction}, path ASC LIMIT ? OFFSET ?`).all(
        gramQuery, ...matchValues, PAGE_SIZE, offset
      ) as unknown as DocumentRow[]
    return {
      total,
      incomplete: this.incomplete,
      hits: rows.map((row) => {
        const body = (this.db.prepare(`SELECT ${includeDetails ? 'body' : 'conversation_body'} AS body FROM documents WHERE rowid = ?`).get(row.rowid) as { body: string }).body
        const excerpt = body ? passageSnippet(JSON.parse(body) as SearchPassage[], terms, includeDetails) : { snippet: null }
        return {
          path: row.path, id: row.id, cwd: row.cwd, modified: row.modified,
          title: highlightSearchText(row.title, terms),
          ...excerpt
        }
      })
    }
  }

  close(): void { this.db.close() }
}
