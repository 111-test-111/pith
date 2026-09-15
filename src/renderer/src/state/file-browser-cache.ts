import type { TableSheet } from '../../../shared/table'
import type { FileBrowserRequest, FileDirectoryDTO, FileDocumentDTO } from '../../../shared/types'
import { fileDirname } from '@/lib/file-navigation'

const DIRECTORY_TTL = 10_000
const DIRECTORY_LIMIT = 160
const DIRECTORY_BYTES = 4 * 1024 * 1024
const DOCUMENT_LIMIT = 16
const DOCUMENT_BYTES = 8 * 1024 * 1024
const TABLE_LIMIT = 8
const TABLE_BYTES = 16 * 1024 * 1024

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
  private tables = new Map<string, { value: TableSnapshot; bytes: number }>()
  private directoryRequests = new Map<string, Promise<FileDirectoryDTO>>()
  private documentRequests = new Map<string, Promise<FileDocumentDTO>>()
  private directoryBytes = 0
  private documentBytes = 0
  private tableBytes = 0
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
      const path = key.slice(key.indexOf('\0') + 1)
      if (path === root || path.startsWith(root.replace(/\/$/, '') + '/')) this.documentRequests.delete(key)
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

  private documentKey(request: FileBrowserRequest) { return `${request.cwd}\0${request.path}` }
  document(request: FileBrowserRequest) { return this.documents.get(this.documentKey(request)) }
  readDocument(request: FileBrowserRequest) {
    const key = this.documentKey(request)
    const pending = this.documentRequests.get(key)
    if (pending) return pending
    const promise = window.pi.readFileDocument({ cwd: request.cwd, path: request.path })
      .catch((): FileDocumentDTO => ({ path: request.path, relativePath: request.path, gitRoot: null, size: 0, truncated: false, error: 'unreadable' }))
      .then(value => {
        if (this.documentRequests.get(key) !== promise) return value
        const previous = this.documents.get(key)
        // Preserve both the visible body and tokenization on unchanged reads.
        if (previous && previous.text === value.text && previous.gitRoot === value.gitRoot && previous.relativePath === value.relativePath && previous.error === value.error && previous.size === value.size && previous.truncated === value.truncated) {
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
  closeDocument(path: string) {
    for (const key of this.documentRequests.keys()) if (key.endsWith(`\0${path}`)) this.documentRequests.delete(key)
    for (const [key, value] of this.documents) if (value.path === path) {
      this.documentBytes -= (value.text?.length ?? 0) * 2
      this.documents.delete(key)
    }
    this.dropTableFile(path)
  }
  clear() { this.directories.clear(); this.documents.clear(); this.tables.clear(); this.directoryRequests.clear(); this.documentRequests.clear(); this.directoryBytes = 0; this.documentBytes = 0; this.tableBytes = 0 }

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
