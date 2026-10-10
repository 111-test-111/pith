import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, constants } from 'node:fs'
import { chmod, mkdir, open, readdir, readFile, realpath, rename, stat, unlink, writeFile, type FileHandle } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import lockfile from 'proper-lockfile'
import { resizeImage } from '@earendil-works/pi-coding-agent'
import type { LibraryItem, LibraryPage, LibraryPreferences, LibraryQuery, LibrarySession, LibraryStatus, LibraryStorage, LibraryTextPreview } from '../../shared/library'
import { LIBRARY_WEB_SNAPSHOT_SCHEMA, normalizeLibraryPreferences } from '../../shared/library'
import { collectMessage, collectImageReplay, libraryCandidateAllowed, libraryToolImageLabel, type LibraryCandidate } from './extract'
import { IMAGE_REPLAY_ENTRY } from '../../shared/image-replay'
import type { LibraryWorkerOptions } from './protocol'
import { libraryImageDimensions } from './image-dimensions'
import { previewKindOf, readsAsText } from '../../shared/preview'
import { readFileText } from '../file-browser'
import { libraryWebSnapshotBytes } from './web-snapshot'

const VERSION = 1
const COLLECTION_VERSION = '4'
const MAX_LINE_BYTES = 64 * 1024 ** 2
const OBJECT_NAME = /^[a-f0-9]{64}\.[a-z0-9]{1,16}$/
interface ResourceRow { id: string; metadata: string; blob: string | null; storage: LibraryStorage; size: number; hidden: number }
interface ScanRow { stamp: string; identity: string; offset: number; tail: string; session: string; calls: string }
interface SavedCopy { blob?: string; size: number; storage: LibraryStorage; imageWidth?: number; imageHeight?: number }

/** SQLite and every byte-copy run in one worker's serialized queue. The index
 * lives outside the archive, so maxBytes is an exact cap on retained copies. */
export class LibraryStore {
  scanning = false
  scanErrors = 0
  lastScanAt: number | null = null
  private usedBytes = 0
  private owner = ''
  private directory = ''
  private preferences: LibraryPreferences
  private constructor(private db: DatabaseSync, private options: LibraryWorkerOptions, private unlock: () => Promise<void>) {
    this.preferences = options.preferences
  }

  static async open(options: LibraryWorkerOptions): Promise<LibraryStore> {
    await mkdir(dirname(options.databasePath), { recursive: true })
    const unlock = await lockfile.lock(options.databasePath, { realpath: false, stale: 15_000, update: 5_000 })
    let db: DatabaseSync | undefined
    try {
      db = new DatabaseSync(options.databasePath)
      await chmod(options.databasePath, 0o600)
      db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA cache_size=-8000;')
      const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
      if (version !== 0 && version !== VERSION) throw new Error('library-version')
      db.exec('CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);'
        + 'CREATE TABLE IF NOT EXISTS blobs(name TEXT PRIMARY KEY, size INTEGER NOT NULL);'
        + 'CREATE TABLE IF NOT EXISTS resources(id TEXT PRIMARY KEY, kind TEXT NOT NULL, project TEXT, session_path TEXT NOT NULL, timestamp INTEGER NOT NULL, metadata TEXT NOT NULL, search TEXT NOT NULL, blob TEXT, storage TEXT NOT NULL, size INTEGER NOT NULL, hidden INTEGER NOT NULL DEFAULT 0);'
        + 'CREATE INDEX IF NOT EXISTS library_order ON resources(hidden, timestamp DESC, id DESC);'
        + 'CREATE INDEX IF NOT EXISTS library_project ON resources(project, kind, hidden);'
        + 'CREATE TABLE IF NOT EXISTS scans(path TEXT PRIMARY KEY, stamp TEXT NOT NULL, identity TEXT NOT NULL, offset INTEGER NOT NULL, tail TEXT NOT NULL, session TEXT NOT NULL, calls TEXT NOT NULL);'
        + 'PRAGMA user_version=' + VERSION + ';')
      const store = new LibraryStore(db, options, unlock)
      store.owner = store.meta('owner') ?? randomUUID()
      store.setMeta('owner', store.owner)
      // Physical archive location is a crash-recovery pointer, while settings
      // remain the sole preference owner. Main reconciles this after migration.
      const recovered = store.meta('directory')
      const migration = store.meta('migration')
      if (migration && recovered) {
        const journal = JSON.parse(migration) as { previous: string; target: string }
        const disposable = recovered === journal.target ? journal.previous : journal.target
        if (await store.releaseArchiveObjects(disposable)) store.db.prepare("DELETE FROM meta WHERE key='migration'").run()
      }
      if (recovered) {
        // An unplugged archive must not be recreated as an empty directory and
        // mistaken for mass deletion of the user's retained copies.
        const marker = JSON.parse(await readFile(join(recovered, '.pith-library.json'), 'utf8'))
        if (marker.owner !== store.owner) throw new Error('library-directory')
      }
      store.directory = await store.ensureDirectory(recovered ?? options.directory)
      store.preferences = { ...store.preferences, directory: store.directory === await realpath(options.defaultDirectory).catch(() => resolve(options.defaultDirectory)) ? null : store.directory }
      store.setMeta('directory', store.directory)
      store.upgradeCollection()
      store.upgradeWebSnapshots()
      await store.reconcile()
      await store.backfillImageDimensions()
      await store.backfillWebSnapshots()
      return store
    } catch (error) { db?.close(); await unlock(); throw error }
  }

  private meta(key: string): string | null { return (this.db.prepare('SELECT value FROM meta WHERE key=?').get(key) as { value: string } | undefined)?.value ?? null }
  private setMeta(key: string, value: string): void { this.db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').run(key, value) }
  private upgradeCollection(): void {
    if (this.meta('collectionVersion') === COLLECTION_VERSION) return
    // Remove obsolete inferred downloads/reply references and inspection images. Keep
    // deliveries/attachments, their shared objects and deletion tombstones.
    const rows = this.db.prepare("SELECT id,metadata FROM resources WHERE hidden=0 AND kind IN ('file','image')").all() as { id: string; metadata: string }[]
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const row of rows) if (!libraryCandidateAllowed(JSON.parse(row.metadata))) this.db.prepare('DELETE FROM resources WHERE id=?').run(row.id)
      const images = this.db.prepare("SELECT id,metadata FROM resources WHERE hidden=0 AND kind='image' AND json_extract(metadata,'$.originalPath') IS NULL").all() as { id: string; metadata: string }[]
      for (const row of images) {
        const item = JSON.parse(row.metadata) as LibraryItem
        if (item.toolName === 'image' && item.imageLabel === 'tool') {
          item.imageLabel = 'generated'
          item.name = 'generated-' + item.id.slice(0, 12) + extname(item.name)
          this.db.prepare('UPDATE resources SET metadata=? WHERE id=?').run(JSON.stringify(item), item.id)
        }
        if (item.imageLabel || !/\.(?:png|jpg|webp|gif|bin)$/.test(item.name)) continue
        if (item.source !== 'attachment' && item.source !== 'tool-image') continue
        if (item.source === 'attachment' ? !/^image-\d+\./.test(item.name)
          : !item.toolName || !item.name.startsWith(item.toolName + '-') || !/^-\d+\./.test(item.name.slice(item.toolName.length))) continue
        // V1 assigned a synthetic name to every inline image. Update those
        // labels even when the originating session was removed or is paused.
        item.imageLabel = item.source === 'attachment' ? 'attachment' : libraryToolImageLabel(item.toolName ?? '')
        item.name = item.imageLabel + '-' + item.id.slice(0, 12) + extname(item.name)
        this.db.prepare('UPDATE resources SET metadata=? WHERE id=?').run(JSON.stringify(item), item.id)
      }
      this.db.exec('DELETE FROM blobs WHERE NOT EXISTS (SELECT 1 FROM resources WHERE resources.blob=blobs.name AND hidden=0); DELETE FROM scans;')
      this.setMeta('collectionVersion', COLLECTION_VERSION)
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  private objectPath(name: string, directory = this.directory): string {
    if (!OBJECT_NAME.test(name)) throw new Error('library-invalid-object')
    return join(directory, 'objects', name)
  }

  private upgradeWebSnapshots(): void {
    if (this.meta('webSnapshotSchema') === LIBRARY_WEB_SNAPSHOT_SCHEMA) return
    // Rebuild every web record from its collected index fields. There is one
    // JSON format; old plain-text objects are not parsed or served as snapshots.
    // Tombstones and copies shared with other categories remain intact.
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.exec("UPDATE resources SET blob=NULL,storage='metadata',size=0 WHERE kind='web' AND hidden=0;"
        + 'DELETE FROM blobs WHERE NOT EXISTS (SELECT 1 FROM resources WHERE resources.blob=blobs.name AND hidden=0);')
      this.setMeta('webSnapshotSchema', LIBRARY_WEB_SNAPSHOT_SCHEMA)
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  private async saveWebSnapshot(item: LibraryCandidate): Promise<SavedCopy> {
    try { return await this.saveBytes(libraryWebSnapshotBytes(item), '.json', true) }
    catch { return { size: 0, storage: 'failed' } }
  }

  private async backfillWebSnapshots(): Promise<void> {
    const rows = this.db.prepare("SELECT * FROM resources WHERE hidden=0 AND kind='web' AND storage!='saved'").all() as unknown as ResourceRow[]
    for (const row of rows) {
      const saved = await this.saveWebSnapshot(JSON.parse(row.metadata))
      this.db.prepare('UPDATE resources SET blob=?,storage=?,size=? WHERE id=?').run(saved.blob ?? row.blob, saved.storage, saved.size, row.id)
      if (saved.blob && row.blob && saved.blob !== row.blob) await this.releaseUnusedBlob(row.blob)
    }
  }

  private async ensureDirectory(path: string): Promise<string> {
    if (!isAbsolute(path) || path.includes('\0')) throw new Error('library-directory')
    await mkdir(path, { recursive: true, mode: 0o700 })
    const canonical = await realpath(path)
    const marker = join(canonical, '.pith-library.json')
    try {
      const raw = JSON.parse(await readFile(marker, 'utf8'))
      if (raw.kind !== 'pith-library-v1' || raw.owner !== this.owner) throw new Error('library-directory')
    } catch (error: any) {
      if (error.code !== 'ENOENT') throw new Error('library-directory')
      if ((await readdir(canonical)).length) throw new Error('library-directory')
      await writeFile(marker, JSON.stringify({ kind: 'pith-library-v1', owner: this.owner }), { mode: 0o600, flag: 'wx' })
    }
    await mkdir(join(canonical, 'objects'), { recursive: true, mode: 0o700 })
    if (await realpath(join(canonical, 'objects')) !== join(canonical, 'objects')) throw new Error('library-directory')
    return canonical
  }

  private async reconcile(): Promise<void> {
    const rows = this.db.prepare('SELECT name,size FROM blobs').all() as { name: string; size: number }[]
    const known = new Set(rows.map(row => row.name))
    for (const row of rows) {
      const info = await stat(this.objectPath(row.name)).catch(() => null)
      if (!info?.isFile() || info.size !== row.size) {
        this.db.prepare("UPDATE resources SET blob=NULL,storage='missing' WHERE blob=?").run(row.name)
        this.db.prepare('DELETE FROM blobs WHERE name=?').run(row.name)
        known.delete(row.name)
      } else this.usedBytes += row.size
    }
    // Recovery removes only app-owned temporary/unreferenced objects.
    for (const name of await readdir(join(this.directory, 'objects'))) {
      if (/^tmp-[a-f0-9-]+\.part$/.test(name) || (OBJECT_NAME.test(name) && !known.has(name))) await unlink(join(this.directory, 'objects', name)).catch(() => {})
    }
  }

  private async releaseArchiveObjects(path: string): Promise<boolean> {
    try {
      const canonical = await realpath(path)
      const marker = JSON.parse(await readFile(join(canonical, '.pith-library.json'), 'utf8'))
      if (marker.kind !== 'pith-library-v1' || marker.owner !== this.owner) return false
      const objects = join(canonical, 'objects')
      if (await realpath(objects) !== objects) return false
      for (const name of await readdir(objects)) if (OBJECT_NAME.test(name) || /^tmp-[a-f0-9-]+\.part$/.test(name)) await unlink(join(objects, name))
      return true
    } catch { return false }
  }

  private async imageDimensions(name: string): Promise<ReturnType<typeof libraryImageDimensions>> {
    const handle = await open(this.objectPath(name), 'r').catch(() => null)
    if (!handle) return undefined
    try {
      const header = Buffer.allocUnsafe(256 * 1024)
      const { bytesRead } = await handle.read(header, 0, header.length, 0)
      return libraryImageDimensions(header.subarray(0, bytesRead), extname(name))
    } finally { await handle.close() }
  }
  private async backfillImageDimensions(): Promise<void> {
    const rows = this.db.prepare("SELECT * FROM resources WHERE hidden=0 AND kind='image' AND blob IS NOT NULL AND json_extract(metadata,'$.imageWidth') IS NULL").all() as unknown as ResourceRow[]
    const dimensions = new Map<string, Awaited<ReturnType<LibraryStore['imageDimensions']>>>()
    for (const row of rows) {
      if (!dimensions.has(row.blob!)) dimensions.set(row.blob!, await this.imageDimensions(row.blob!))
      const size = dimensions.get(row.blob!)
      if (size) this.db.prepare('UPDATE resources SET metadata=? WHERE id=?').run(JSON.stringify({ ...JSON.parse(row.metadata), ...size }), row.id)
    }
  }

  status(): LibraryStatus {
    const counts = this.db.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN storage NOT IN ('saved','metadata') THEN 1 ELSE 0 END) AS unsaved FROM resources WHERE hidden=0").get() as { total: number; unsaved: number }
    const projects = this.db.prepare('SELECT project AS path,COUNT(*) AS count FROM resources WHERE hidden=0 GROUP BY project ORDER BY project').all() as LibraryStatus['projects']
    return { preferences: this.preferences, directory: this.directory, usedBytes: this.usedBytes,
      total: counts.total, unsaved: counts.unsaved ?? 0, projects,
      scanning: this.scanning, scanErrors: this.scanErrors, lastScanAt: this.lastScanAt }
  }

  page(query: LibraryQuery = {}): LibraryPage {
    if (!query || typeof query !== 'object' || (query.kind !== undefined && !['image','file','web'].includes(query.kind))
      || (query.project !== undefined && query.project !== null && typeof query.project !== 'string')
      || (query.query !== undefined && (typeof query.query !== 'string' || query.query.length > 1000))
      || (query.hideUnavailable !== undefined && typeof query.hideUnavailable !== 'boolean')
      || (query.before && (!Number.isSafeInteger(query.before.timestamp) || !/^[a-f0-9]{64}$/.test(query.before.id)))) throw new Error('library-invalid')
    const where = ['hidden=0'], params: (string | number | null)[] = []
    if (query.kind) { where.push('kind=?'); params.push(query.kind) }
    if (query.project !== undefined) { where.push('project IS ?'); params.push(query.project) }
    if (query.hideUnavailable) where.push("(storage='saved' OR (kind='web' AND json_extract(metadata,'$.url') IS NOT NULL))")
    for (const term of query.query?.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean).slice(0, 12) ?? []) { where.push('instr(search,?)>0'); params.push(term) }
    const total = (this.db.prepare('SELECT COUNT(*) AS n FROM resources WHERE ' + where.join(' AND ')).get(...params) as { n: number }).n
    if (query.before) { where.push('(timestamp<? OR (timestamp=? AND id<?))'); params.push(query.before.timestamp, query.before.timestamp, query.before.id) }
    const limit = Math.max(1, Math.min(80, Number.isSafeInteger(query.limit) ? query.limit! : 60))
    const rows = this.db.prepare('SELECT * FROM resources WHERE ' + where.join(' AND ') + ' ORDER BY timestamp DESC,id DESC LIMIT ?').all(...params, limit + 1) as unknown as ResourceRow[]
    const items = rows.slice(0, limit).map(row => this.item(row))
    const last = items.at(-1)
    return { items, total, next: rows.length > limit && last ? { timestamp: last.timestamp, id: last.id } : null }
  }

  private item(row: ResourceRow): LibraryItem {
    return { ...JSON.parse(row.metadata), storage: row.storage, size: row.size,
      ...(row.blob && row.storage === 'saved' ? { archivedPath: this.objectPath(row.blob) } : {}) }
  }

  async archivedFile(id: string): Promise<string | null> {
    const row = this.db.prepare('SELECT * FROM resources WHERE id=? AND hidden=0').get(id) as unknown as ResourceRow | undefined
    if (!row?.blob || row.storage !== 'saved') return null
    const path = this.objectPath(row.blob), info = await stat(path).catch(() => null)
    return info?.isFile() && info.size === row.size ? path : null
  }

  async previewText(id: string): Promise<LibraryTextPreview | null> {
    const row = this.db.prepare('SELECT * FROM resources WHERE id=? AND hidden=0').get(id) as unknown as ResourceRow | undefined
    if (!row || !readsAsText(previewKindOf(this.item(row).name))) return null
    const path = await this.archivedFile(id)
    if (!path) return null
    const content = await readFileText(path, 16 * 1024)
    return content.text === undefined || content.error ? null : { text: content.text, truncated: content.truncated }
  }

  async collect(candidates: LibraryCandidate[]): Promise<void> {
    if (!this.preferences.enabled) return
    for (const value of candidates.slice(0, 256)) {
      if (!libraryCandidateAllowed(value)) continue
      const old = this.db.prepare('SELECT * FROM resources WHERE id=?').get(value.id) as unknown as ResourceRow | undefined
      if (old?.hidden) continue
      const { data: _data, ...current } = value
      const prior = old ? JSON.parse(old.metadata) as LibraryCandidate : undefined
      // Historical nested calls contain parameters but no returned body. They
      // may enrich names, never erase actual evidence captured live.
      const metadata = { ...prior, ...current,
        timestamp: prior?.timestamp ?? current.timestamp,
        sessionTitle: current.sessionTitle || prior?.sessionTitle || '',
        description: current.description || prior?.description || '',
        ...((current.excerpt || prior?.excerpt) ? { excerpt: current.excerpt || prior?.excerpt } : {}),
        ...((current.query || prior?.query) ? { query: current.query || prior?.query } : {}) }
      const search = [metadata.name, metadata.description, metadata.project, metadata.sessionTitle, metadata.originalPath, metadata.url, metadata.query, metadata.excerpt, metadata.toolName].filter(Boolean).join('\n').toLocaleLowerCase()
      // A historical reference can arrive before its actual nested result.
      // Enrich that JSON once returned text becomes available; subsequent
      // parameter-only replays cannot replace the captured excerpt.
      const enrichWeb = value.kind === 'web' && !prior?.excerpt && !!metadata.excerpt
      if ((old?.storage === 'saved' && !enrichWeb) || (old?.storage === 'metadata' && value.kind !== 'web')) {
        this.db.prepare('UPDATE resources SET metadata=?,search=? WHERE id=?').run(JSON.stringify(metadata), search, value.id)
        continue
      }
      let saved: SavedCopy = { size: 0, storage: 'metadata' }
      try {
        if (value.kind === 'web') saved = await this.saveWebSnapshot(metadata)
        else if (value.data) {
          if (value.data.base64.length > MAX_LINE_BYTES || value.data.base64.length % 4 === 1 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.data.base64)
            || !['image/png','image/jpeg','image/gif','image/webp'].includes(value.data.mimeType)) saved.storage = 'invalid'
          else {
            const bytes = Buffer.from(value.data.base64, 'base64')
            // Validate without replacing the original bytes with the decoder's output.
            const image = await resizeImage(bytes, value.data.mimeType)
            saved = image ? await this.saveBytes(bytes, extname(value.name)) : { size: bytes.length, storage: 'invalid' }
            if (image) { metadata.imageWidth = image.originalWidth; metadata.imageHeight = image.originalHeight }
          }
        } else if (value.originalPath) saved = await this.saveFile(value.originalPath)
      } catch (error: any) { saved = { size: 0, storage: error.code === 'ENOENT' ? 'missing' : 'failed' } }
      if (value.kind === 'image' && saved.imageWidth && saved.imageHeight) { metadata.imageWidth = saved.imageWidth; metadata.imageHeight = saved.imageHeight }
      this.db.prepare('INSERT INTO resources(id,kind,project,session_path,timestamp,metadata,search,blob,storage,size) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET metadata=excluded.metadata,search=excluded.search,blob=excluded.blob,storage=excluded.storage,size=excluded.size')
        .run(value.id, value.kind, value.project, value.sessionPath, value.timestamp, JSON.stringify(metadata), search,
          saved.blob ?? (value.kind === 'web' ? old?.blob : null) ?? null, saved.storage, saved.size)
      if (saved.blob && old?.blob && saved.blob !== old.blob) await this.releaseUnusedBlob(old.blob)
    }
  }

  private suffix(extension: string): string { return /^\.[a-z0-9]{1,16}$/i.test(extension) ? extension.toLowerCase() : '.bin' }
  private imageSuffix(bytes: Buffer, fallback: string): string {
    if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return '.png'
    if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return '.jpg'
    if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))) return '.gif'
    if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return '.webp'
    return this.suffix(fallback)
  }
  private async durableRename(temp: string, path: string): Promise<void> {
    await rename(temp, path)
    const directory = await open(dirname(path), constants.O_RDONLY)
    try { await directory.sync() } catch (error: any) { if (process.platform !== 'win32') throw error }
    finally { await directory.close() }
  }
  private knownBlob(name: string): { size: number } | undefined { return this.db.prepare('SELECT size FROM blobs WHERE name=?').get(name) as { size: number } | undefined }
  private knownContent(hash: string): { name: string; size: number } | undefined {
    return this.db.prepare('SELECT name,size FROM blobs WHERE name>=? AND name<? LIMIT 1').get(hash + '.', hash + '/') as { name: string; size: number } | undefined
  }
  private recordBlob(name: string, size: number): void { this.db.prepare('INSERT INTO blobs VALUES (?,?)').run(name, size); this.usedBytes += size }

  private async saveBytes(bytes: Buffer, extension: string, requireExtension = false): Promise<{ blob?: string; size: number; storage: LibraryStorage }> {
    const hash = createHash('sha256').update(bytes).digest('hex')
    const name = hash + this.imageSuffix(bytes, extension)
    // Web snapshots must route to the JSON reader even if an attachment with
    // identical bytes was previously archived using a different extension.
    const exact = requireExtension ? this.knownBlob(name) : undefined
    const existing = requireExtension ? (exact ? { name, size: exact.size } : undefined) : this.knownContent(hash)
    if (existing) return { blob: existing.name, size: bytes.length, storage: 'saved' }
    if (this.usedBytes + bytes.length > this.preferences.maxBytes) return { size: bytes.length, storage: 'limit' }
    const temp = join(this.directory, 'objects', 'tmp-' + randomUUID() + '.part')
    try {
      const handle = await open(temp, 'wx', 0o600)
      try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
      await this.durableRename(temp, this.objectPath(name))
      this.recordBlob(name, bytes.length)
      return { blob: name, size: bytes.length, storage: 'saved' }
    } finally { await unlink(temp).catch(() => {}) }
  }

  /** A descriptor binds the source. Growth, replacement and in-place mutation
   * fail the snapshot rather than committing partial or mixed bytes. */
  private async saveFile(path: string): Promise<SavedCopy> {
    const source = await open(path, constants.O_RDONLY)
    let temp: string | undefined
    let output: FileHandle | undefined
    try {
      const before = await source.stat()
      if (!before.isFile()) return { size: 0, storage: 'invalid' }
      if (before.size > this.preferences.maxBytes && !this.db.prepare('SELECT 1 FROM blobs WHERE size=? LIMIT 1').get(before.size)) return { size: before.size, storage: 'limit' }
      if (this.usedBytes + before.size <= this.preferences.maxBytes) {
        temp = join(this.directory, 'objects', 'tmp-' + randomUUID() + '.part')
        output = await open(temp, 'wx', 0o600)
      }
      const hash = createHash('sha256')
      let size = 0
      let extension = this.suffix(extname(path))
      let dimensions: ReturnType<typeof libraryImageDimensions>
      const buffer = Buffer.allocUnsafe(256 * 1024)
      while (size < before.size) {
        const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, before.size - size), size)
        if (!bytesRead) throw new Error('library-source-changed')
        const chunk = buffer.subarray(0, bytesRead)
        if (size === 0) { dimensions = libraryImageDimensions(chunk, extension); extension = this.imageSuffix(chunk, extension) }
        hash.update(chunk)
        if (output) await output.writeFile(chunk)
        size += bytesRead
      }
      const after = await source.stat()
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('library-source-changed')
      const digest = hash.digest('hex'), existing = this.knownContent(digest)
      if (existing) return { blob: existing.name, size, storage: 'saved', ...dimensions }
      const name = digest + extension
      if (!output || !temp) return { size, storage: 'limit' }
      await output.sync(); await output.close(); output = undefined
      await this.durableRename(temp, this.objectPath(name)); temp = undefined
      this.recordBlob(name, size)
      return { blob: name, size, storage: 'saved', ...dimensions }
    } finally { await source.close(); await output?.close(); if (temp) await unlink(temp).catch(() => {}) }
  }

  async remove(id: string): Promise<void> {
    if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw new Error('library-invalid')
    const row = this.db.prepare('SELECT blob FROM resources WHERE id=? AND hidden=0').get(id) as { blob: string | null } | undefined
    this.db.prepare('UPDATE resources SET hidden=1,blob=NULL WHERE id=?').run(id)
    if (row?.blob) await this.releaseUnusedBlob(row.blob)
  }

  private async releaseUnusedBlob(name: string): Promise<void> {
    if (this.db.prepare('SELECT 1 FROM resources WHERE blob=? AND hidden=0 LIMIT 1').get(name)) return
    const blob = this.knownBlob(name)
    // Delete the managed copy, never the original path in provenance.
    await unlink(this.objectPath(name)).catch((error: any) => { if (error.code !== 'ENOENT') throw error })
    this.db.prepare('DELETE FROM blobs WHERE name=?').run(name)
    this.usedBytes -= blob?.size ?? 0
  }

  /** Clear one complete category, including records hidden by view filters.
   * Tombstones commit together before releasing unshared managed copies. */
  async clear(kind: LibraryItem['kind']): Promise<number> {
    if (!['image', 'file', 'web'].includes(kind)) throw new Error('library-invalid')
    const count = Number(this.db.prepare('UPDATE resources SET hidden=1,blob=NULL WHERE kind=? AND hidden=0').run(kind).changes)
    const unused = this.db.prepare('SELECT name,size FROM blobs WHERE NOT EXISTS (SELECT 1 FROM resources WHERE resources.blob=blobs.name AND hidden=0)').all() as { name: string; size: number }[]
    for (const blob of unused) {
      await unlink(this.objectPath(blob.name)).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error })
      this.db.prepare('DELETE FROM blobs WHERE name=?').run(blob.name)
      this.usedBytes -= blob.size
    }
    return count
  }

  /** Browser downloads have no SDK message body to replay. Their persisted
   * provenance also permits retrying a failed local copy after raising quota. */
  async retryUnsaved(): Promise<void> {
    const rows = this.db.prepare("SELECT * FROM resources WHERE hidden=0 AND storage IN ('limit','missing','failed')").all() as unknown as ResourceRow[]
    for (const row of rows) {
      const value = JSON.parse(row.metadata) as LibraryCandidate
      if (value.kind === 'web' || value.originalPath) await this.collect([value])
    }
  }

  async configure(preferences: LibraryPreferences, directory: string): Promise<LibraryStatus> {
    const next = normalizeLibraryPreferences(preferences)
    if (resolve(directory) !== this.directory) {
      const target = await this.ensureDirectory(directory)
      if (target !== this.directory) {
        const rows = this.db.prepare('SELECT name,size FROM blobs').all() as { name: string; size: number }[]
        const previous = this.directory
        this.setMeta('migration', JSON.stringify({ previous, target }))
        // All copies are complete and hash-verified before committing the new
        // physical root. A failed migration keeps the old archive usable.
        try { for (const row of rows) {
          const source = this.objectPath(row.name, previous), destination = this.objectPath(row.name, target)
          const input = await open(source, 'r'), temp = join(target, 'objects', 'tmp-' + randomUUID() + '.part')
          const output = await open(temp, 'wx', 0o600)
          try {
            const hash = createHash('sha256'); let size = 0
            for await (const chunk of input.createReadStream({ autoClose: false })) { hash.update(chunk); size += chunk.length; await output.writeFile(chunk) }
            if (size !== row.size || hash.digest('hex') !== row.name.slice(0, 64)) throw new Error('library-source-changed')
            await output.sync(); await output.close(); await this.durableRename(temp, destination)
          } finally { await input.close(); await output.close().catch(() => {}); await unlink(temp).catch(() => {}) }
        } } catch (error) {
          if (await this.releaseArchiveObjects(target)) this.db.prepare("DELETE FROM meta WHERE key='migration'").run()
          throw error
        }
        this.setMeta('directory', target)
        this.directory = target
        if (await this.releaseArchiveObjects(previous)) this.db.prepare("DELETE FROM meta WHERE key='migration'").run()
      }
    }
    this.preferences = { ...next, directory: this.directory === await realpath(this.options.defaultDirectory).catch(() => resolve(this.options.defaultDirectory)) ? null : this.directory }
    return this.status()
  }

  async sessionFiles(): Promise<string[]> {
    const files: string[] = []
    try {
      for (const dir of await readdir(this.options.sessionsDir, { withFileTypes: true })) {
        if (!dir.isDirectory()) continue
        try { for (const file of await readdir(join(this.options.sessionsDir, dir.name))) if (file.endsWith('.jsonl')) files.push(join(this.options.sessionsDir, dir.name, file)) }
        catch { this.scanErrors++ }
      }
    } catch (error: any) { if (error.code !== 'ENOENT') this.scanErrors++ }
    return files.sort()
  }

  private async tail(path: string, offset: number): Promise<string> {
    const handle = await open(path, 'r')
    try {
      const bytes = Buffer.alloc(Math.min(offset, 1024))
      const read = await handle.read(bytes, 0, bytes.length, offset - bytes.length)
      return createHash('sha256').update(bytes.subarray(0, read.bytesRead)).digest('hex')
    } finally { await handle.close() }
  }

  async scanFile(path: string, force = false, yieldCaptures?: () => Promise<void>): Promise<void> {
    if (!this.preferences.enabled) return
    const info = await stat(path)
    if (!info.isFile()) return
    const stamp = [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join(':')
    const previous = this.db.prepare('SELECT * FROM scans WHERE path=?').get(path) as unknown as ScanRow | undefined
    if (!force && previous?.stamp === stamp) return
    const identity = info.dev + ':' + info.ino
    const append = !force && previous && previous.identity === identity && info.size > previous.offset && previous.tail === await this.tail(path, previous.offset)
    let offset = append ? previous.offset : 0
    let session: LibrarySession | null = append ? JSON.parse(previous.session) : null
    const calls = new Map<string, { name: string; args: unknown }>(append ? JSON.parse(previous.calls) : [])
    let messages = 0
    for await (const line of this.lines(path, offset, info.size)) {
      offset = line.end
      if (!line.text) { this.scanErrors++; continue }
      let entry: any
      try { entry = JSON.parse(line.text) } catch { this.scanErrors++; continue }
      if (!session) {
        if (entry?.type !== 'session' || typeof entry.id !== 'string' || typeof entry.cwd !== 'string') { this.scanErrors++; return }
        const projectless = resolve(entry.cwd) === resolve(this.options.defaultWorkspace)
        session = { id: entry.id, path, cwd: projectless ? null : entry.cwd, workspace: entry.cwd, title: '' }
        continue
      }
      if (entry?.type === 'session_info' && typeof entry.name === 'string') {
        session.title = entry.name.trim().slice(0, 200)
        this.db.prepare("UPDATE resources SET metadata=json_set(metadata,'$.sessionTitle',?),search=search||? WHERE session_path=?").run(session.title, '\n' + session.title.toLocaleLowerCase(), path)
      }
      if (entry?.type === 'custom' && entry.customType === IMAGE_REPLAY_ENTRY && typeof entry.id === 'string') {
        await this.collect(collectImageReplay(session, entry.id, entry.data))
      }
      if (entry?.type !== 'message' || typeof entry.id !== 'string' || !entry.message) continue
      if (!session.title && entry.message.role === 'user') {
        const content = entry.message.content
        session.title = (typeof content === 'string' ? content : Array.isArray(content) ? content.filter(v => v?.type === 'text').map(v => v.text).join(' ') : '').split('<file path=')[0].trim().slice(0, 200)
      }
      await this.collect(collectMessage(session, entry.id, entry.message, calls))
      if (++messages % 16 === 0) await yieldCaptures?.()
    }
    if (!session) return
    // Only network/present parameters are required across an append boundary.
    // Bound persisted call metadata independently of huge tool arguments.
    const retained = [...calls].slice(-4096).map(([id, call]) => [id, { name: call.name, args: JSON.stringify(call.args ?? {}).length <= 32_768 ? call.args : {} }])
    const bounded: typeof retained = []; let bytes = 0
    for (const call of retained.reverse()) { bytes += JSON.stringify(call).length; if (bytes <= 1024 ** 2) bounded.push(call) }
    this.db.prepare('INSERT OR REPLACE INTO scans VALUES (?,?,?,?,?,?,?)').run(path, stamp, identity, offset, await this.tail(path, offset), JSON.stringify(session), JSON.stringify(bounded.reverse()))
  }

  private async *lines(path: string, start: number, end: number): AsyncGenerator<{ text: string | null; end: number }> {
    if (end <= start) return
    const stream = createReadStream(path, { start, end: end - 1, highWaterMark: 256 * 1024 })
    let parts: Buffer[] = [], length = 0, discarded = false, position = start
    for await (const chunk of stream) {
      const buffer = chunk as Buffer
      let from = 0
      for (let index = 0; index < buffer.length; index++) if (buffer[index] === 10) {
        const part = buffer.subarray(from, index)
        length += part.length
        if (!discarded && length <= MAX_LINE_BYTES) parts.push(part)
        else discarded = true
        position += length + 1
        yield { text: discarded ? null : Buffer.concat(parts, length).toString('utf8'), end: position }
        parts = []; length = 0; discarded = false; from = index + 1
      }
      if (from < buffer.length) {
        const part = buffer.subarray(from); length += part.length
        if (!discarded && length <= MAX_LINE_BYTES) parts.push(part)
        else { discarded = true; parts = [] }
      }
    }
    // SDK JSONL ends in a newline; leave an in-flight tail for the next scan.
  }

  async close(): Promise<void> { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); this.db.close(); await this.unlock() }
}
