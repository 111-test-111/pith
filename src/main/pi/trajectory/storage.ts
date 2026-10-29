import { createHash } from 'node:crypto'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { chmod, mkdir, open, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { trajectoryLines } from './jsonl'
import type { TrajectoryDetail, TrajectoryNode, TrajectoryNodePage, TrajectoryNodeRequest, TrajectoryPage, TrajectoryQuery, TrajectoryRecord, TrajectoryDocumentKind } from '../../../shared/trajectory'
import { TRAJECTORY_CHILDREN_SIZE, TRAJECTORY_PAGE_SIZE, TRAJECTORY_TEXT_SIZE, TRAJECTORY_PREVIEW_SIZE } from '../../../shared/trajectory'
import type { TraceAccess, TraceWrite } from './protocol'
import type { ContextRequestDTO } from '../../../shared/types'
import { scalarPreview, trajectoryPreview } from './preview'

type RecordRow = { seq: number; data: string; roots: string }
const PREVIEW_VERSION = 2
type RecordMetadata = Omit<TrajectoryRecord, 'seq'> & { previewVersion?: number }

/** One worker owns SQLite and all hashing/serialization. A Merkle tree shares
 * unchanged prompts, tools, messages and images across requests; no full
 * request snapshots or decoded body caches live in the main/renderer process. */
export class TrajectoryStorage {
  private statements = new Map<string, StatementSync>()
  constructor(private db: DatabaseSync) {}
  private prepare(sql: string): StatementSync {
    const cached = this.statements.get(sql)
    if (cached) return cached
    const statement = this.db.prepare(sql)
    if (this.statements.size >= 48) this.statements.delete(this.statements.keys().next().value!)
    this.statements.set(sql, statement)
    return statement
  }

  static async open(path: string): Promise<TrajectoryStorage> {
    if (path !== ':memory:') await mkdir(dirname(path), { recursive: true })
    const db = new DatabaseSync(path)
    if (path !== ':memory:') await chmod(path, 0o600)
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA cache_size=-4096; PRAGMA mmap_size=0; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS nodes (id TEXT PRIMARY KEY, kind TEXT NOT NULL, count INTEGER NOT NULL,
        bytes INTEGER NOT NULL, preview TEXT NOT NULL, body TEXT NOT NULL, length INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS records (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
        session_id TEXT NOT NULL, anchor TEXT NOT NULL, entry_id TEXT, kind TEXT NOT NULL, status TEXT NOT NULL,
        name TEXT NOT NULL, started_at INTEGER NOT NULL, data TEXT NOT NULL, roots TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(path TEXT PRIMARY KEY,session_id TEXT NOT NULL,parent_path TEXT,leaf TEXT,size INTEGER,mtime REAL);
      CREATE TABLE IF NOT EXISTS entries(path TEXT NOT NULL,id TEXT NOT NULL,parent_id TEXT,PRIMARY KEY(path,id));
      CREATE INDEX IF NOT EXISTS trace_time ON records(started_at,seq);
      CREATE INDEX IF NOT EXISTS trace_anchor ON records(anchor,seq);
      CREATE INDEX IF NOT EXISTS trace_entry ON records(entry_id);
      CREATE INDEX IF NOT EXISTS trace_tool_call ON records(session_id,json_extract(data,'$.toolCallId')) WHERE kind='tool';
      CREATE INDEX IF NOT EXISTS trace_session ON records(session_id,status);`)
    // A previous process cannot still own an in-flight request.
    db.exec(`UPDATE records SET status='interrupted', data=json_set(data,'$.status','interrupted') WHERE status='running'`)
    return new TrajectoryStorage(db)
  }

  private node(value: unknown, depth = 0, ancestors = new Set<object>()): string {
    if (depth > 96) throw new Error('trajectory-depth-limit')
    let kind: TrajectoryNode['kind'] = 'value'
    let body: string
    let count = 0
    let preview = ''
    let bytes = 0
    if (value !== null && typeof value === 'object') {
      if (ancestors.has(value)) throw new Error('trajectory-cyclic-value')
      ancestors.add(value)
      kind = Array.isArray(value) ? 'array' : 'object'
      const pairs: Array<[string, string]> = []
      const entries = Array.isArray(value) ? value.map((v, i) => [String(i), v] as const) : Object.entries(value)
      for (const [key, child] of entries) {
        if (child === undefined && kind === 'object') continue
        const id = this.node(/^(api[_-]?key|authorization|access[_-]?token|refresh[_-]?token)$/i.test(key) ? '[redacted]' : child ?? null, depth + 1, ancestors)
        pairs.push([key, id])
        const size = this.prepare('SELECT bytes FROM nodes WHERE id=?').get(id) as { bytes: number }
        bytes += size.bytes
      }
      ancestors.delete(value)
      count = pairs.length
      bytes += 2 + Math.max(0, count - 1)
      if (kind === 'object') bytes += pairs.reduce((sum, [key]) => sum + Buffer.byteLength(JSON.stringify(key)) + 1, 0)
      body = JSON.stringify(pairs)
      preview = kind === 'array' ? `[${count}]` : `{${count}}`
    } else {
      body = JSON.stringify(value ?? null) ?? 'null'
      preview = body.length > 120 ? `${body.slice(0, 120)}…` : body
      bytes = Buffer.byteLength(body)
    }
    const id = createHash('sha256').update(kind).update(body).digest('hex')
    this.prepare('INSERT OR IGNORE INTO nodes VALUES(?,?,?,?,?,?,length(?))').run(id, kind, count, bytes, preview, body, body)
    return id
  }

  write(value: TraceWrite): void {
    const metadata = { ...value.record, name: value.record.name.slice(0, 500),
      ...(value.record.provider ? { provider: value.record.provider.slice(0, 200) } : {}),
      ...(value.record.model ? { model: value.record.model.slice(0, 500) } : {}) }
    this.db.exec('BEGIN')
    try {
      const previous = this.prepare('SELECT roots FROM records WHERE id=?').get(value.record.id) as { roots: string } | undefined
      const roots = previous ? JSON.parse(previous.roots) as Record<string, string> : {}
      for (const [key, document] of Object.entries(value.documents ?? {})) roots[key] = this.node(document)
      Object.assign(metadata, this.excerpt(metadata, roots))
      this.prepare(`INSERT INTO records(id,session_id,anchor,entry_id,kind,status,name,started_at,data,roots) VALUES(?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET anchor=excluded.anchor,entry_id=COALESCE(excluded.entry_id,records.entry_id),
          status=excluded.status,name=excluded.name,data=excluded.data,roots=excluded.roots`).run(
        value.record.id, value.sessionId, value.anchor, value.entryId ?? null, value.record.kind, value.record.status,
        value.record.name.slice(0, 500), value.record.startedAt, JSON.stringify(metadata), JSON.stringify(roots))
      if (value.entryId && value.record.captured) this.prepare("DELETE FROM records WHERE session_id=? AND entry_id=? AND id LIKE 'entry:%'").run(value.sessionId, value.entryId)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  private preview(kind: TrajectoryRecord['kind'], roots: Record<string, string>): string {
    let budget = 96
    const fields = new Map<string, string | undefined>(), texts = new Map<string, string>()
    return trajectoryPreview(kind, roots, {
      field: (id, key) => {
        const cacheKey = `${id}:${key}`
        if (fields.has(cacheKey)) return fields.get(cacheKey)
        if (--budget < 0) return undefined
        const row = this.prepare("SELECT json_extract(e.value,'$[1]') id FROM nodes,json_each(nodes.body) e WHERE nodes.id=? AND nodes.kind='object' AND json_extract(e.value,'$[0]')=? LIMIT 1").get(id, key) as { id: string } | undefined
        fields.set(cacheKey, row?.id)
        return row?.id
      },
      entries: (id, limit) => {
        if (--budget < 0) return []
        return (this.prepare("SELECT json_extract(e.value,'$[0]') key,json_extract(e.value,'$[1]') id FROM nodes,json_each(nodes.body) e WHERE nodes.id=? AND nodes.kind!='value' LIMIT ?").all(id, limit) as Array<{ key: string; id: string }>).map(row => [row.key, row.id])
      },
      text: id => {
        if (texts.has(id)) return texts.get(id)!
        if (--budget < 0) return ''
        const row = this.prepare("SELECT substr(body,1,?) prefix FROM nodes WHERE id=? AND kind='value'").get(TRAJECTORY_PREVIEW_SIZE * 6 + 8, id) as { prefix: string } | undefined
        const text = row ? scalarPreview(row.prefix) : ''
        texts.set(id, text)
        return text
      }
    })
  }

  private excerpt(record: RecordMetadata, roots: Record<string, string>): Partial<RecordMetadata> {
    const toolCalls: NonNullable<TrajectoryRecord['toolCalls']> = []
    if (record.kind === 'request' || record.kind === 'assistant') {
      // Inspect every output block's identity, never its arguments or text.
      // Scalar prefixes keep malformed/oversized extension data out of IPC.
      for (const root of [roots.output, roots.event].filter(Boolean)) {
        const rows = this.prepare(`SELECT substr(identifier.body,1,4096) id,substr(name.body,1,3080) name
          FROM nodes root,json_each(root.body) contentField,nodes content,json_each(content.body) item,
            nodes block,json_each(block.body) typeField,nodes tag,
            json_each(block.body) idField,nodes identifier,json_each(block.body) nameField,nodes name
          WHERE root.id=? AND root.kind='object' AND json_extract(contentField.value,'$[0]')='content'
            AND content.id=json_extract(contentField.value,'$[1]') AND content.kind='array'
            AND block.id=json_extract(item.value,'$[1]') AND block.kind='object'
            AND json_extract(typeField.value,'$[0]')='type' AND tag.id=json_extract(typeField.value,'$[1]') AND tag.body='"toolCall"'
            AND json_extract(idField.value,'$[0]')='id' AND identifier.id=json_extract(idField.value,'$[1]')
            AND json_extract(nameField.value,'$[0]')='name' AND name.id=json_extract(nameField.value,'$[1]')
          ORDER BY CAST(item.key AS INTEGER)`).all(root) as Array<{ id: string; name: string }>
        for (const row of rows) {
          try {
            const id: unknown = JSON.parse(row.id)
            if (typeof id === 'string' && id) toolCalls.push({ id, name: scalarPreview(row.name).slice(0, 500) })
          } catch { /* incomplete or oversized call identity */ }
        }
        if (toolCalls.length) break
      }
    }
    let toolCallId = record.toolCallId
    if (record.kind === 'tool' && !toolCallId) {
      for (const root of [roots.output, roots.event].filter(Boolean)) {
        const row = this.prepare(`SELECT substr(value.body,1,4096) body FROM nodes root,json_each(root.body) field,nodes value
          WHERE root.id=? AND root.kind='object' AND json_extract(field.value,'$[0]')='toolCallId'
            AND value.id=json_extract(field.value,'$[1]') AND value.kind='value' LIMIT 1`).get(root) as { body: string } | undefined
        try { const id: unknown = row && JSON.parse(row.body); if (typeof id === 'string' && id) { toolCallId = id; break } } catch { /* incomplete identity */ }
      }
    }
    return { previewVersion: PREVIEW_VERSION, preview: toolCalls.length ? '' : this.preview(record.kind, roots),
      ...(record.kind === 'request' || record.kind === 'assistant' ? { toolCalls } : {}), ...(toolCallId ? { toolCallId } : {}) }
  }

  private withPreview(row: RecordRow): TrajectoryRecord {
    const metadata = JSON.parse(row.data) as RecordMetadata
    // Existing databases need no eager body scan or schema migration. Backfill
    // only a requested page, then reuse its bounded metadata on later visits.
    if (metadata.preview === undefined || metadata.previewVersion !== PREVIEW_VERSION) {
      Object.assign(metadata, this.excerpt(metadata, JSON.parse(row.roots)))
      this.prepare('UPDATE records SET data=? WHERE id=?').run(JSON.stringify(metadata), metadata.id)
    }
    const { previewVersion: _version, contextStats: _context, ...record } = metadata
    return { ...record, seq: row.seq }
  }

  /** Incremental JSONL indexing happens in the worker. Only parent links and
   * file offsets are retained in SQLite; no complete branch/log enters IPC. */
  async history(access: TraceAccess, yieldWrites: () => Promise<void> = async () => {}): Promise<void> {
    if (access.sessionPath.startsWith('memory:')) return
    let info
    try { info = await stat(access.sessionPath) } catch { return }
    const previous = this.prepare('SELECT size,mtime,session_id FROM sessions WHERE path=?').get(access.sessionPath) as { size: number; mtime: number; session_id: string } | undefined
    if (previous) access.sessionId = previous.session_id
    if (previous?.size === info.size && previous.mtime === info.mtimeMs) return
    const append = previous && previous.size < info.size
    if (!append) this.prepare('DELETE FROM entries WHERE path=?').run(access.sessionPath)
    let offset = append ? previous.size : 0
    const lines = trajectoryLines(access.sessionPath, offset, info.size)
    this.db.exec('BEGIN')
    try {
      let batch = 0
      for await (const item of lines) {
        offset = item.offset
        const entry = item.entry
        if (!entry) continue
        if (entry.type === 'session') {
          this.prepare('INSERT OR REPLACE INTO sessions VALUES(?,?,?,?,?,?)').run(access.sessionPath, entry.id, entry.parentSession ?? null, null, 0, 0)
          access.sessionId = entry.id
          continue
        }
        if (typeof entry.id !== 'string') continue
        this.prepare('INSERT OR REPLACE INTO entries VALUES(?,?,?)').run(access.sessionPath, entry.id, entry.parentId ?? null)
        this.prepare('UPDATE sessions SET leaf=? WHERE path=?').run(entry.id, access.sessionPath)
        if (entry.trajectoryOmitted) entry.message = { role: 'custom', customType: entry.type, content: [], details: { omitted: true }, timestamp: Date.parse(entry.timestamp) }
        if (entry.type === 'custom_message' && !entry.trajectoryOmitted) entry.message = { role: 'custom', customType: entry.customType, content: entry.content, details: entry.details, display: entry.display, timestamp: Date.parse(entry.timestamp) }
        if ((entry.type === 'message' || entry.type === 'custom_message' || entry.trajectoryOmitted) && entry.message && ['user', 'assistant', 'toolResult', 'custom'].includes(entry.message.role)
          && !this.prepare(`SELECT 1 FROM records WHERE entry_id=? AND session_id IN (WITH RECURSIVE owners(path,session_id,parent_path) AS (
            SELECT path,session_id,parent_path FROM sessions WHERE path=? UNION SELECT s.path,s.session_id,s.parent_path FROM sessions s JOIN owners o ON s.path=o.parent_path
          ) SELECT session_id FROM owners UNION SELECT ?) LIMIT 1`).get(entry.id, access.sessionPath, access.sessionId)) {
          const m = entry.message
          // write() owns a transaction, so import inside this batch directly.
          const record: RecordMetadata = { id: `entry:${access.sessionId}:${entry.id}`, kind: m.role === 'toolResult' ? 'tool' : m.role === 'custom' ? 'notification' : m.role,
            name: m.toolName ?? m.customType ?? m.role, startedAt: m.timestamp ?? Date.parse(entry.timestamp),
            status: entry.trajectoryOmitted ? 'unavailable' : m.stopReason === 'aborted' ? 'cancelled' : m.isError || m.stopReason === 'error' ? 'failed' : 'completed', captured: false, ...(entry.trajectoryOmitted ? { captureError: true } : {}),
            ...(m.provider ? { provider: m.provider, model: m.model } : {}),
            ...(m.usage ? { usage: { input: m.usage.input ?? 0, output: m.usage.output ?? 0,
              cacheRead: m.usage.cacheRead ?? 0, cacheWrite: m.usage.cacheWrite ?? 0, cost: m.usage.cost?.total ?? 0 } } : {}) }
          const documentRoots = { event: this.node(m) }
          const roots = JSON.stringify(documentRoots)
          const metadata = { ...record, ...this.excerpt(record, documentRoots) }
          this.prepare('INSERT OR IGNORE INTO records(id,session_id,anchor,entry_id,kind,status,name,started_at,data,roots) VALUES(?,?,?,?,?,?,?,?,?,?)')
            .run(record.id, access.sessionId, entry.id, entry.id, record.kind, record.status, record.name, record.startedAt, JSON.stringify(metadata), roots)
        }
        if (++batch % 16 === 0) {
          this.db.exec('COMMIT')
          await new Promise<void>(resolve => setImmediate(resolve))
          await yieldWrites()
          this.db.exec('BEGIN')
        }
      }
      this.prepare('UPDATE sessions SET size=?,mtime=? WHERE path=?').run(Math.min(offset, info.size), info.mtimeMs, access.sessionPath)
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
    finally { await lines.return(undefined) }
  }

  private where(access: TraceAccess): { sql: string; args: (string | null)[] } {
    // Full selected branch, including compacted ancestors. A fork's copied
    // message IDs can refer back to captures from its parent session.
    return { sql: `session_id IN (WITH RECURSIVE owners(path,session_id,parent_path) AS (
        SELECT path,session_id,parent_path FROM sessions WHERE path=? UNION
        SELECT s.path,s.session_id,s.parent_path FROM sessions s JOIN owners o ON s.path=o.parent_path
      ) SELECT session_id FROM owners UNION SELECT ?) AND (anchor IN (
        WITH RECURSIVE branch(id,parent_id) AS (SELECT id,parent_id FROM entries WHERE path=? AND id=coalesce(?,(SELECT leaf FROM sessions WHERE path=?))
          UNION SELECT e.id,e.parent_id FROM entries e JOIN branch b ON e.id=b.parent_id AND e.path=?) SELECT id FROM branch
      ) OR anchor=? OR anchor=?)`,
      args: [access.sessionPath, access.sessionId, access.sessionPath, access.leafId === undefined ? null : access.leafId ?? '', access.sessionPath, access.sessionPath, access.leafId ?? '', `session:${access.sessionId}`] }
  }

  page(access: TraceAccess, query: TrajectoryQuery): TrajectoryPage {
    const where = this.where(access)
    const predicates = [where.sql]
    const args: (string | number | null)[] = [...where.args]
    if (query.kind && !query.toolCall) {
      if (query.kind === 'request') predicates.push("kind IN ('request','assistant')")
      else { predicates.push('kind=?'); args.push(query.kind) }
    }
    if (query.status && !query.toolCall) { predicates.push('status=?'); args.push(query.status) }
    if (query.query && !query.toolCall) { predicates.push("instr(lower(name || ' ' || coalesce(json_extract(data,'$.provider'),'') || ' ' || coalesce(json_extract(data,'$.model'),'')),lower(?))>0"); args.push(query.query.slice(0, 200)) }
    const base = predicates.join(' AND ')
    const total = (this.prepare(`SELECT count(*) n FROM records WHERE ${base}`).get(...args) as { n: number }).n
    const pageArgs = [...args]
    let rows: RecordRow[]
    let targetId: string | undefined
    if (query.toolCall) {
      const target = this.toolTarget(access, query.toolCall)
      targetId = (JSON.parse(target.data) as TrajectoryRecord).id
      const following = (limit: number) => this.prepare(`SELECT seq,data,roots FROM records WHERE ${base}
        AND (started_at,seq)>=((SELECT started_at FROM records WHERE seq=?),?) ORDER BY started_at,seq LIMIT ?`)
        .all(...args, target.seq, target.seq, limit) as RecordRow[]
      let after = following(TRAJECTORY_PAGE_SIZE / 2)
      const before = this.prepare(`SELECT seq,data,roots FROM records WHERE ${base}
        AND (started_at,seq)<((SELECT started_at FROM records WHERE seq=?),?) ORDER BY started_at DESC,seq DESC LIMIT ?`)
        .all(...args, target.seq, target.seq, TRAJECTORY_PAGE_SIZE - after.length) as RecordRow[]
      if (before.length + after.length < TRAJECTORY_PAGE_SIZE) after = following(TRAJECTORY_PAGE_SIZE - before.length)
      rows = [...before.reverse(), ...after]
    } else {
      if (query.before !== undefined) { predicates.push('(started_at,seq)<((SELECT started_at FROM records WHERE seq=?),?)'); pageArgs.push(query.before, query.before) }
      if (query.after !== undefined) { predicates.push('(started_at,seq)>((SELECT started_at FROM records WHERE seq=?),?)'); pageArgs.push(query.after, query.after) }
      const ascending = query.after !== undefined
      rows = this.prepare(`SELECT seq,data,roots FROM records WHERE ${predicates.join(' AND ')} ORDER BY started_at ${ascending ? 'ASC' : 'DESC'},seq ${ascending ? 'ASC' : 'DESC'} LIMIT ${TRAJECTORY_PAGE_SIZE}`).all(...pageArgs) as RecordRow[]
      if (!ascending) rows.reverse()
    }
    const items = rows.map(row => this.withPreview(row))
    const first = items[0]?.seq, last = items.at(-1)?.seq
    const older = first !== undefined && this.prepare(`SELECT 1 FROM records WHERE ${base} AND (started_at,seq)<((SELECT started_at FROM records WHERE seq=?),?) LIMIT 1`).get(...args, first, first) ? first : null
    const newer = last !== undefined && this.prepare(`SELECT 1 FROM records WHERE ${base} AND (started_at,seq)>((SELECT started_at FROM records WHERE seq=?),?) LIMIT 1`).get(...args, last, last) ? last : null
    return { items, total, older, newer, ...(targetId ? { targetId } : {}) }
  }

  /** Uses the same verified ancestry as trace reads. Older logs cannot invent
   * a request capture from their saved message bodies. Only metadata is read. */
  context(access: TraceAccess): ContextRequestDTO | null {
    const where = this.where(access)
    const row = this.prepare(`SELECT json_extract(data,'$.contextStats') stats FROM records
      WHERE kind='request' AND json_extract(data,'$.captured')=1
        AND json_type(data,'$.contextStats')='object' AND ${where.sql}
      ORDER BY started_at DESC,seq DESC LIMIT 1`).get(...where.args) as { stats: string } | undefined
    return row ? JSON.parse(row.stats) as ContextRequestDTO : null
  }

  private toolTarget(access: TraceAccess, call: NonNullable<TrajectoryQuery['toolCall']>): RecordRow {
    if (typeof call.recordId !== 'string' || call.recordId.length > 200 || typeof call.callId !== 'string' || call.callId.length > 4096) throw new Error('trajectory-record-unavailable')
    const source = this.withPreview(this.record(access, call.recordId))
    if (!source.toolCalls?.some(item => item.id === call.callId)) throw new Error('trajectory-record-unavailable')
    const where = this.where(access)
    // Captures bind to the originating request; historical SDK messages bind
    // through their exact call ID. Same-named tools never influence the link.
    const historyOrigin = `entry_id IN (
      WITH RECURSIVE calls(id) AS (
        SELECT id FROM entries WHERE path=? AND parent_id=(SELECT entry_id FROM records WHERE id=?)
        UNION SELECT e.id FROM entries e JOIN calls c ON e.parent_id=c.id WHERE e.path=? AND NOT EXISTS (
          SELECT 1 FROM records r WHERE r.entry_id=c.id AND r.kind IN ('user','request','assistant'))
      ) SELECT id FROM calls)`
    const origin = source.captured ? `(json_extract(data,'$.parentId')=? OR (json_extract(data,'$.parentId') IS NULL AND ${historyOrigin}))` : historyOrigin
    const scope = `kind='tool' AND ${where.sql} AND ${origin}`
    const args = [...where.args, ...(source.captured ? [source.id] : []), access.sessionPath, source.id, access.sessionPath]
    let target = this.prepare(`SELECT seq,data,roots FROM records WHERE ${scope} AND json_extract(data,'$.toolCallId')=?
      ORDER BY started_at,seq LIMIT 1`).get(...args, call.callId) as RecordRow | undefined
    if (!target) {
      // Compatibility with captures written before call identities became
      // summary metadata. Read only tool-result identity scalars in SQLite.
      target = this.prepare(`SELECT seq,data,roots FROM records WHERE ${scope} AND EXISTS (
        SELECT 1 FROM json_each(records.roots) document,nodes root,json_each(root.body) field,nodes value
        WHERE document.key IN ('output','event') AND root.id=document.value AND root.kind='object'
          AND json_extract(field.value,'$[0]')='toolCallId' AND value.id=json_extract(field.value,'$[1]')
          AND value.kind='value' AND value.body=?) ORDER BY started_at,seq LIMIT 1`).get(...args, JSON.stringify(call.callId)) as RecordRow | undefined
    }
    if (!target) throw new Error('trajectory-record-unavailable')
    return target
  }

  private record(access: TraceAccess, id: string): RecordRow {
    const where = this.where(access)
    const row = this.prepare(`SELECT seq,data,roots FROM records WHERE id=? AND ${where.sql}`).get(id, ...where.args) as RecordRow | undefined
    if (!row) throw new Error('trajectory-record-unavailable')
    return row
  }

  private summary(id: string): TrajectoryNode {
    const row = this.prepare('SELECT id,kind,count,bytes,preview FROM nodes WHERE id=?').get(id) as unknown as TrajectoryNode | undefined
    if (!row) throw new Error('trajectory-node-unavailable')
    return row
  }

  detail(access: TraceAccess, id: string): TrajectoryDetail {
    const row = this.record(access, id)
    const roots = JSON.parse(row.roots) as Record<TrajectoryDocumentKind, string>
    return { record: this.withPreview(row), documents: Object.entries(roots).map(([kind, id]) => ({ kind: kind as TrajectoryDocumentKind, node: this.summary(id) })) }
  }

  readNode(access: TraceAccess, request: TrajectoryNodeRequest): TrajectoryNodePage {
    const roots = JSON.parse(this.record(access, request.recordId).roots) as Record<string, string>
    const trail = request.trail
    if (!Array.isArray(trail) || !trail.length || trail.length > 96 || !Object.values(roots).includes(trail[0])) throw new Error('trajectory-node-unavailable')
    for (let i = 1; i < trail.length; i++) {
      if (!this.prepare("SELECT 1 FROM nodes,json_each(nodes.body) e WHERE nodes.id=? AND nodes.kind!='value' AND json_extract(e.value,'$[1]')=? LIMIT 1").get(trail[i - 1], trail[i])) throw new Error('trajectory-node-unavailable')
    }
    const id = trail.at(-1)!, node = this.summary(id)
    const offset = Number.isSafeInteger(request.offset) && request.offset! >= 0 ? request.offset! : 0
    if (node.kind === 'value') {
      const row = this.prepare('SELECT substr(body,?,?) text,length FROM nodes WHERE id=?').get(offset + 1, TRAJECTORY_TEXT_SIZE, id) as { text: string; length: number }
      const next = offset + Array.from(row.text).length
      return { node, children: [], text: row.text, nextOffset: next < row.length ? next : null }
    }
    const rows = this.prepare(`SELECT substr(json_extract(e.value,'$[0]'),1,256) || CASE WHEN length(json_extract(e.value,'$[0]'))>256 THEN '…' ELSE '' END key,n.id,n.kind,n.count,n.bytes,n.preview
      FROM nodes parent,json_each(parent.body) e JOIN nodes n ON n.id=json_extract(e.value,'$[1]')
      WHERE parent.id=? LIMIT ${TRAJECTORY_CHILDREN_SIZE} OFFSET ?`).all(id, offset) as unknown as Array<TrajectoryNode & { key: string }>
    return { node, text: null, children: rows.map(({ key, ...node }) => ({ key, node })), nextOffset: offset + rows.length < node.count ? offset + rows.length : null }
  }

  /** Export traverses disk nodes directly. It never reconstructs a large
   * request in memory or sends its body across IPC. */
  async export(access: TraceAccess, id: string, path: string, yieldWrites: () => Promise<void> = async () => {}): Promise<void> {
    const row = this.record(access, id)
    const file = await open(path, 'w', 0o600)
    const write = async (text: string) => { await file.writeFile(text) }
    const visit = async (id: string): Promise<void> => {
      const meta = this.summary(id)
      if (meta.kind === 'value') {
        for (let offset = 0;; offset += TRAJECTORY_TEXT_SIZE) {
          const part = this.prepare('SELECT substr(body,?,?) text FROM nodes WHERE id=?').get(offset + 1, TRAJECTORY_TEXT_SIZE, id) as { text: string }
          if (!part.text) break
          await write(part.text)
          await yieldWrites()
        }
      } else {
        await write(meta.kind === 'array' ? '[' : '{')
        let first = true
        for (let offset = 0; offset < meta.count; offset += TRAJECTORY_CHILDREN_SIZE) {
          const pairs = this.prepare('SELECT e.value pair FROM nodes,json_each(nodes.body) e WHERE nodes.id=? LIMIT ? OFFSET ?').all(id, TRAJECTORY_CHILDREN_SIZE, offset)
          for (const pair of pairs) {
            const [key, child] = JSON.parse(pair.pair as string) as [string, string]
            if (!first) await write(',')
            first = false
            if (meta.kind === 'object') await write(`${JSON.stringify(key)}:`)
            await visit(child)
          }
          await yieldWrites()
        }
        await write(meta.kind === 'array' ? ']' : '}')
      }
    }
    try {
      await write(`{"record":${row.data},"documents":{`)
      let first = true
      for (const [key, root] of Object.entries(JSON.parse(row.roots) as Record<string, string>)) {
        if (!first) await write(',')
        first = false
        await write(`${JSON.stringify(key)}:`)
        await visit(root)
      }
      await write('}}\n')
      await file.sync()
    } finally { await file.close() }
  }

  settle(sessionId: string): void {
    this.prepare("UPDATE records SET status='interrupted',data=json_set(data,'$.status','interrupted') WHERE session_id=? AND status='running'").run(sessionId)
  }
  close(): void { this.db.close() }
}
