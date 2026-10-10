import type { TableSheet } from '../../../shared/table'
import type { FileBrowserRequest, FileDirectoryDTO, FileDocumentDTO, FileGitDiffDTO } from '../../../shared/types'
import { fileDirname } from '@/lib/file-navigation'
import type { BinaryPreviewQuery, BinaryPreviewValue, PreviewResult } from '../../../shared/file-preview'

const DIRECTORY_TTL = 10_000
const DIRECTORY_LIMIT = 160
const DIRECTORY_BYTES = 4 * 1024 * 1024
const DOCUMENT_LIMIT = 16
const DOCUMENT_BYTES = 8 * 1024 * 1024
const DIFF_LIMIT = 16
const DIFF_BYTES = 8 * 1024 * 1024
const TABLE_LIMIT = 8
const TABLE_BYTES = 16 * 1024 * 1024
const BINARY_BYTES = 16 * 1024 * 1024

function binaryBytes(value: BinaryPreviewValue): number {
  if (value.type === 'archive-entry') return 256 + (value.text?.length ?? 0) * 2 + (value.image?.data.byteLength ?? 0)
  if (value.type === 'archive-index') return value.entries.reduce((bytes, entry) => bytes + entry.name.length * 2 + 128, 256)
  if (value.type === 'data-index') return value.tables.reduce((bytes, table) => bytes + table.name.length * 2 + table.columns.reduce((count, column) => count + (column.name.length + column.type.length) * 2 + 64, 128), 256)
  return value.rows.reduce((bytes, row) => bytes + row.reduce((count, cell) => count + cell.length * 2 + 16, 32), 256)
}

/** Everything the grid needs to repaint, including where a delimited file's
 * next slice continues from — a revisited tab resumes instead of re-reading. */
export interface TableSnapshot {
  rows: string[][]
  rowNumbers: number[] | null
  columns: number
  sheets: TableSheet[]
  sheet: string | null
  totalRows: number | null
  truncated: boolean
  eof: boolean
  /** Byte offset of the next delimited slice. */
  offset: number
  delimiter: string
  size: number
}

/** Table keys are `cwd\0path\0generation`; the path is what closing drops. */
function tableKeyPath(key: string): string {
  return key.slice(key.indexOf('\0') + 1, key.lastIndexOf('\0'))
}

function tableBytes(value: TableSnapshot): number {
  let bytes = 256 + value.rows.length * 32
  for (const row of value.rows) for (const cell of row) bytes += cell.length * 2
  return bytes
}

/** Small, workspace-owned caches outlive pane mounts. Disk reads still validate
 * documents on every visit; directory snapshots have a short freshness window.
 * In-flight requests are shared, including React StrictMode's mount replay. */
export class FileBrowserCache {
  private directories = new Map<string, { value: FileDirectoryDTO; time: number; bytes: number }>()
  private documents = new Map<string, FileDocumentDTO>()
  private diffs = new Map<string, FileGitDiffDTO>()
  private tables = new Map<string, { value: TableSnapshot; bytes: number }>()
  private directoryRequests = new Map<string, Promise<FileDirectoryDTO>>()
  private documentRequests = new Map<string, Promise<FileDocumentDTO>>()
  private diffRequests = new Map<string, Promise<FileGitDiffDTO>>()
  private directoryBytes = 0
  private documentBytes = 0
  private diffBytes = 0
  private tableBytes = 0
  private binaries = new Map<string, { path: string; value: BinaryPreviewValue; bytes: number }>()
  private binaryRequests = new Map<string, { path: string; id: string; users: number; promise: Promise<PreviewResult> }>()
  private binaryBytes = 0
  private readers = 0
  private waiting: Array<() => void> = []

  private async readDirectoryPage(request: FileBrowserRequest, offset?: number) {
    // A deep path can be read in parallel without launching an unbounded burst.
    if (this.readers >= 6) await new Promise<void>(resolve => this.waiting.push(resolve))
    else this.readers++
    try { return await window.pi.listFileDirectory(request, offset) }
    finally { const next = this.waiting.shift(); if (next) next(); else this.readers-- }
  }

  directory(path: string) { return this.directories.get(path)?.value }
  directorySnapshot(root: string) {
    return new Map([...this.directories].filter(([path]) => path === root || path.startsWith(root.replace(/\/$/, '') + '/')).map(([path, entry]) => [path, entry.value]))
  }
  directoryFresh(path: string) {
    const entry = this.directories.get(path)
    return !!entry && Date.now() - entry.time < DIRECTORY_TTL
  }
  invalidateTree(root: string) {
    for (const [path, entry] of this.directories) if (path === root || path.startsWith(root.replace(/\/$/, '') + '/')) entry.time = 0
    // A refresh may race an earlier disk snapshot. Its replacement must own
    // the cache; late responses can only satisfy their already-obsolete caller.
    for (const path of this.directoryRequests.keys()) if (path === root || path.startsWith(root.replace(/\/$/, '') + '/')) this.directoryRequests.delete(path)
    for (const key of this.documentRequests.keys()) {
      const path = key.split('\0')[1]
      if (path === root || path.startsWith(root.replace(/\/$/, '') + '/')) this.documentRequests.delete(key)
    }
    for (const key of this.diffRequests.keys()) {
      const path = key.split('\0')[1]
      if (path === root || path.startsWith(root.replace(/\/$/, '') + '/')) this.diffRequests.delete(key)
    }
  }
  async readDirectory(request: FileBrowserRequest, append = false, displayed?: FileDirectoryDTO): Promise<FileDirectoryDTO> {
    const previous = this.directories.get(request.path)
    const base = displayed ?? previous?.value
    const pending = this.directoryRequests.get(request.path)
    if (pending) return pending
    if (append && !base) return this.readDirectory(request)
    if (append && base?.nextOffset === undefined) return base!
    if (!append && this.directoryFresh(request.path)) {
      if (previous) { this.directories.delete(request.path); this.directories.set(request.path, previous) }
      return previous!.value
    }
    const promise = this.readDirectoryPage(request, append ? base?.nextOffset : undefined)
      .catch((): FileDirectoryDTO => ({ path: request.path, entries: append ? [] : base?.entries ?? [], error: 'unreadable' }))
      .then(value => {
        if (this.directoryRequests.get(request.path) !== promise) return value
        if (append) value = { ...value, entries: [...(base?.entries ?? []), ...value.entries] }
        const bytes = value.entries.reduce((size, entry) => size + (entry.name.length + entry.path.length) * 2 + 64, 128)
        this.directoryBytes -= this.directories.get(request.path)?.bytes ?? 0
        this.directories.delete(request.path)
        this.directories.set(request.path, { value, time: Date.now(), bytes })
        this.directoryBytes += bytes
        while (this.directories.size > DIRECTORY_LIMIT || this.directoryBytes > DIRECTORY_BYTES) {
          const oldest = this.directories.entries().next().value!
          this.directoryBytes -= oldest[1].bytes
          this.directories.delete(oldest[0])
        }
        return value
      }).finally(() => { if (this.directoryRequests.get(request.path) === promise) this.directoryRequests.delete(request.path) })
    this.directoryRequests.set(request.path, promise)
    return promise
  }

  /** Known ancestors need no parent-listing round trip before they can load. */
  async prepareTree(root: string, selected: string | null, expanded: string[]) {
    const paths = new Set([root])
    if (selected?.startsWith(root.replace(/\/$/, '') + '/')) {
      for (let path = fileDirname(selected); path !== root; path = fileDirname(path)) {
        paths.add(path)
        if (path === '/' || fileDirname(path) === path) break
      }
    }
    // Previously expanded siblings are restored in the same commit, so they
    // cannot arrive later and push the selected row offscreen after its reveal.
    const open = new Set([...expanded, ...paths])
    for (const path of expanded) {
      if (path !== root && !path.startsWith(root.replace(/\/$/, '') + '/')) continue
      let parent = path
      while (parent !== root && open.has(parent)) parent = fileDirname(parent)
      if (parent === root) paths.add(path)
    }
    const values = await Promise.all([...paths].map(async path => {
      let value = await this.readDirectory({ cwd: root, path })
      const child = selected?.startsWith(path.replace(/\/$/, '') + '/') ? selected.slice(path.replace(/\/$/, '').length + 1).split('/')[0] : null
      while (child && !value.error && value.nextOffset !== undefined && !value.entries.some(entry => entry.name === child)) value = await this.readDirectory({ cwd: root, path }, true, value)
      return [path, value] as const
    }))
    return new Map(values)
  }

  private documentKey(request: FileBrowserRequest) { return `${request.cwd}\0${request.path}${request.encoding && request.encoding !== 'auto' ? '\0' + request.encoding : ''}` }
  document(request: FileBrowserRequest) { return this.documents.get(this.documentKey(request)) }
  readDocument(request: FileBrowserRequest) {
    const key = this.documentKey(request)
    const pending = this.documentRequests.get(key)
    if (pending) return pending
    const promise = window.pi.readFileDocument({ cwd: request.cwd, path: request.path, ...(request.encoding ? { encoding: request.encoding } : {}) })
      .catch((): FileDocumentDTO => ({ path: request.path, relativePath: request.path, gitRoot: null, size: 0, truncated: false, error: 'unreadable' }))
      .then(value => {
        if (this.documentRequests.get(key) !== promise) return value
        const previous = this.documents.get(key)
        // Preserve both the visible body and tokenization on unchanged reads.
        if (previous && previous.text === value.text && previous.encoding === value.encoding && previous.gitRoot === value.gitRoot && previous.relativePath === value.relativePath && previous.error === value.error && previous.size === value.size && previous.truncated === value.truncated) {
          this.documents.delete(key); this.documents.set(key, previous)
          return previous
        }
        this.documentBytes -= (previous?.text?.length ?? 0) * 2
        this.documents.delete(key)
        this.documents.set(key, value)
        this.documentBytes += (value.text?.length ?? 0) * 2
        while (this.documents.size > DOCUMENT_LIMIT || this.documentBytes > DOCUMENT_BYTES) {
          const oldest = this.documents.entries().next().value!
          this.documentBytes -= (oldest[1].text?.length ?? 0) * 2
          this.documents.delete(oldest[0])
        }
        return value
      }).finally(() => { if (this.documentRequests.get(key) === promise) this.documentRequests.delete(key) })
    this.documentRequests.set(key, promise)
    return promise
  }
  private diffKey(request: FileBrowserRequest) { return `${request.cwd}\0${request.path}` }
  gitDiff(request: FileBrowserRequest) { return this.diffs.get(this.diffKey(request)) }
  /** Keep the last diff visible while validating HEAD and working-tree changes.
   * Only the current request may publish; close/refresh/clear revoke old reads. */
  readGitDiff(request: FileBrowserRequest) {
    const key = this.diffKey(request)
    const pending = this.diffRequests.get(key)
    if (pending) return pending
    const promise = window.pi.readFileGitDiff({ cwd: request.cwd, path: request.path })
      .catch((): FileGitDiffDTO => ({ gitRoot: null, patch: '', binary: false, error: 'git' }))
      .then(value => {
        if (this.diffRequests.get(key) !== promise) return value
        const previous = this.diffs.get(key)
        if (previous && previous.patch === value.patch && previous.gitRoot === value.gitRoot && previous.binary === value.binary && previous.error === value.error) {
          this.diffs.delete(key); this.diffs.set(key, previous)
          return previous
        }
        this.diffBytes -= (previous?.patch.length ?? 0) * 2
        this.diffs.delete(key); this.diffs.set(key, value)
        this.diffBytes += value.patch.length * 2
        while (this.diffs.size > DIFF_LIMIT || this.diffBytes > DIFF_BYTES) {
          const oldest = this.diffs.entries().next().value!
          this.diffBytes -= oldest[1].patch.length * 2
          this.diffs.delete(oldest[0])
        }
        return value
      }).finally(() => { if (this.diffRequests.get(key) === promise) this.diffRequests.delete(key) })
    this.diffRequests.set(key, promise)
    return promise
  }
  closeDocument(path: string) {
    for (const key of this.documentRequests.keys()) if (key.split('\0')[1] === path) this.documentRequests.delete(key)
    for (const [key, value] of this.documents) if (value.path === path) {
      this.documentBytes -= (value.text?.length ?? 0) * 2
      this.documents.delete(key)
    }
    for (const key of this.diffRequests.keys()) if (key.split('\0')[1] === path) this.diffRequests.delete(key)
    for (const [key, value] of this.diffs) if (key.split('\0')[1] === path) {
      this.diffBytes -= value.patch.length * 2
      this.diffs.delete(key)
    }
    this.dropTableFile(path)
    for (const [key, entry] of this.binaries) if (entry.path === path) { this.binaryBytes -= entry.bytes; this.binaries.delete(key) }
    for (const [key, entry] of this.binaryRequests) if (entry.path === path) { this.binaryRequests.delete(key); window.pi.cancelBinaryPreview(entry.id) }
  }
  clear() {
    for (const entry of this.binaryRequests.values()) window.pi.cancelBinaryPreview(entry.id)
    this.binaries.clear(); this.binaryRequests.clear(); this.binaryBytes = 0
    this.directories.clear(); this.documents.clear(); this.diffs.clear(); this.tables.clear(); this.directoryRequests.clear(); this.documentRequests.clear(); this.diffRequests.clear(); this.directoryBytes = 0; this.documentBytes = 0; this.diffBytes = 0; this.tableBytes = 0
  }

  binary(key: string) {
    const entry = this.binaries.get(key)
    if (!entry) return undefined
    this.binaries.delete(key); this.binaries.set(key, entry)
    return entry.value
  }
  readBinary(key: string, request: FileBrowserRequest, query: BinaryPreviewQuery) {
    let entry = this.binaryRequests.get(key)
    if (!entry) {
      const id = crypto.randomUUID()
      const promise = window.pi.binaryPreview({ cwd: request.cwd, path: request.path, id, query }).catch((): PreviewResult => ({ error: 'unreadable' })).then(result => {
        if (this.binaryRequests.get(key)?.id !== id || !result.value) return result
        const previous = this.binaries.get(key)
        this.binaryBytes -= previous?.bytes ?? 0
        const bytes = binaryBytes(result.value)
        this.binaries.delete(key); this.binaries.set(key, { path: request.path, value: result.value, bytes }); this.binaryBytes += bytes
        while (this.binaries.size > 16 || this.binaryBytes > BINARY_BYTES) {
          const oldest = this.binaries.entries().next().value!
          this.binaryBytes -= oldest[1].bytes; this.binaries.delete(oldest[0])
        }
        return result
      }).finally(() => { if (this.binaryRequests.get(key)?.id === id) this.binaryRequests.delete(key) })
      entry = { path: request.path, id, users: 0, promise }; this.binaryRequests.set(key, entry)
    }
    entry.users++
    let released = false
    const tracked = entry
    return { promise: tracked.promise, cancel: () => {
      if (released) return
      released = true; tracked.users--
      if (tracked.users === 0 && this.binaryRequests.get(key) === tracked) { this.binaryRequests.delete(key); window.pi.cancelBinaryPreview(tracked.id) }
    } }
  }

  /** Read moves an entry to the front, so an active tab is evicted last. */
  table(key: string) {
    const entry = this.tables.get(key)
    if (!entry) return undefined
    this.tables.delete(key)
    this.tables.set(key, entry)
    return entry.value
  }
  setTable(key: string, value: TableSnapshot) {
    this.dropTable(key)
    const bytes = tableBytes(value)
    this.tables.set(key, { value, bytes })
    this.tableBytes += bytes
    while (this.tables.size > TABLE_LIMIT || this.tableBytes > TABLE_BYTES) {
      const oldest = this.tables.entries().next().value
      if (!oldest) break
      this.dropTable(oldest[0])
    }
  }
  /** Drops every cached generation of one path (a closed tab, a rewrite). */
  dropTableFile(path: string) {
    for (const key of [...this.tables.keys()]) if (tableKeyPath(key) === path) this.dropTable(key)
  }
  private dropTable(key: string) {
    const entry = this.tables.get(key)
    if (!entry) return
    this.tableBytes -= entry.bytes
    this.tables.delete(key)
  }
}
