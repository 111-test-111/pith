import { Worker } from 'node:worker_threads'
import { app } from 'electron'
import type { BrowserWindow } from 'electron'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { getAgentDir } from '@earendil-works/pi-coding-agent'
import { loadSettings, saveSettings } from '../settings'
import { libraryDownload } from './extract'
import type { LibraryKind, LibraryPage, LibraryPreferences, LibraryQuery, LibrarySession, LibrarySettingsUpdate, LibraryStatus, LibraryTextPreview } from '../../shared/library'
import { LIBRARY_MIN_MAX_BYTES, LIBRARY_MAX_MAX_BYTES } from '../../shared/library'
import type { LibraryCommand, LibraryWorkerOptions } from './protocol'
import type { captureLibraryHtml } from './html-thumbnail'

let instance: LibraryService | null = null
export const getLibraryService = (): LibraryService | null => instance
export function startLibraryService(emit: (channel: string, payload: unknown) => void, context: (id?: string) => LibrarySession | null): LibraryService {
  instance ??= new LibraryService(emit, context)
  instance.start()
  return instance
}

/** A single archive owner across ordinary, child, scheduled and browser work. */
export class LibraryService {
  private worker: Worker | null = null
  private nextId = 0
  private jobs = new Map<number, { resolve(value: any): void; reject(error: Error): void }>()
  private closing = false
  private notifyTimer: ReturnType<typeof setTimeout> | null = null
  private sessionTimer: ReturnType<typeof setTimeout> | null = null
  private sessions = new Set<string>()
  private nestedCalls = new Map<string, { name: string; args: unknown }>()
  private configuring = false
  private unavailableUntil = 0
  private thumbnailWindows = new Set<BrowserWindow>()
  private thumbnailAbort = new AbortController()
  readonly defaultDirectory = join(app.getPath('userData'), 'library')

  constructor(private emit: (channel: string, payload: unknown) => void, private context: (id?: string) => LibrarySession | null) {}
  start(): void { void this.status().then(status => {
    // Complete a crash-interrupted archive-location settings write.
    const settings = loadSettings()
    if (settings.library.directory !== status.preferences.directory) saveSettings({ ...settings, library: status.preferences })
  }).catch(() => {}) }

  private changed(): void {
    if (this.closing || this.notifyTimer) return
    this.notifyTimer = setTimeout(() => { this.notifyTimer = null; this.emit('library:changed', {}) }, 200)
  }

  private send<T>(command: LibraryCommand): Promise<T> {
    if (this.closing && command.type !== 'close') return Promise.reject(new Error('unavailable'))
    if (Date.now() < this.unavailableUntil) return Promise.reject(new Error('unavailable'))
    if (!this.worker) {
      const settings = loadSettings()
      const options: LibraryWorkerOptions = { databasePath: join(app.getPath('userData'), 'library.sqlite'),
        sessionsDir: join(getAgentDir(), 'sessions'), defaultWorkspace: join(app.getPath('userData'), 'workspace'),
        directory: settings.library.directory ?? this.defaultDirectory, defaultDirectory: this.defaultDirectory, preferences: settings.library }
      const worker = new Worker(new URL('./library-worker.mjs', import.meta.url), { workerData: options })
      this.worker = worker
      worker.on('message', ({ id, result, error, changed }) => {
        if (changed) { this.changed(); return }
        const job = this.jobs.get(id); this.jobs.delete(id)
        if (error) job?.reject(new Error(error))
        else job?.resolve(result)
      })
      const fail = () => {
        if (this.worker !== worker) return
        this.worker = null; this.unavailableUntil = Date.now() + 30_000
        for (const job of this.jobs.values()) job.reject(new Error('unavailable'))
        this.jobs.clear(); this.changed()
      }
      worker.on('error', fail); worker.on('exit', fail)
    }
    const id = ++this.nextId
    return new Promise<T>((resolve, reject) => {
      this.jobs.set(id, { resolve, reject })
      try { this.worker!.postMessage({ id, command }) }
      catch { this.jobs.delete(id); reject(new Error('unavailable')) }
    })
  }

  sessionChanged(path: string): void {
    if (this.closing || !loadSettings().library.enabled) return
    this.sessions.add(path)
    if (this.sessionTimer) return
    this.sessionTimer = setTimeout(() => {
      this.sessionTimer = null
      const paths = [...this.sessions]; this.sessions.clear()
      for (const path of paths) void this.send({ type: 'session', path }).catch(() => {})
    }, 20)
  }
  toolStarted(sessionPath: string, id: string, name: string, args: unknown): void {
    if (this.closing || !loadSettings().library.enabled) return
    // Only nested call parameters need mirroring; images in arguments do not.
    let bounded: unknown = {}
    try { bounded = JSON.stringify(args ?? {}).length <= 32_768 ? args : {} } catch { /* A bad extension argument cannot break agent work. */ }
    this.nestedCalls.set(sessionPath + ':' + id, { name, args: bounded })
    while (this.nestedCalls.size > 4096) this.nestedCalls.delete(this.nestedCalls.keys().next().value!)
  }
  toolEnded(session: LibrarySession, id: string, result: unknown, isError: boolean, nested: boolean): void {
    const key = session.path + ':' + id, call = this.nestedCalls.get(key)
    if (nested) this.nestedCalls.delete(key)
    if (!nested || !call || isError || this.closing || !loadSettings().library.enabled) return
    // The SDK records nested arguments/status but omits nested result bodies.
    // Capture their successful output here, while it still exists.
    void this.send({ type: 'nested', session, callId: id, name: call.name, args: call.args, result }).catch(() => {})
  }
  committed(session: LibrarySession, entryId: string, message: unknown): void {
    if (this.closing || !loadSettings().library.enabled) return
    const value = message as { role?: string; toolCallId?: string }
    const key = session.path + ':' + value.toolCallId, call = value.role === 'toolResult' ? this.nestedCalls.get(key) : undefined
    if (value.role === 'toolResult') this.nestedCalls.delete(key)
    void this.send({ type: 'message', session, entryId, message, call }).catch(() => {})
  }
  downloadSession(owner?: string): LibrarySession {
    return this.context(owner?.startsWith('agent:') ? owner.slice(6) : undefined)
      ?? { id: 'browser', path: '', cwd: null, title: '' }
  }
  download(path: string, url: string, session: LibrarySession): void {
    if (this.closing || !loadSettings().library.enabled) return
    void this.send({ type: 'collect', candidates: libraryDownload(session, path, url, Date.now(), randomUUID()) }).catch(() => {})
  }

  page(query: LibraryQuery): Promise<LibraryPage> { return this.send({ type: 'page', query }) }
  status(): Promise<LibraryStatus> { return this.send({ type: 'status' }) }
  rescan(): Promise<LibraryStatus> { return this.send({ type: 'scan', force: true }) }
  remove(id: string): Promise<void> { return this.send({ type: 'delete', id }) }
  clear(kind: LibraryKind): Promise<number> { return this.send({ type: 'clear', kind }) }
  file(id: string): Promise<string | null> { return this.send({ type: 'file', id }) }
  previewText(id: string): Promise<LibraryTextPreview | null> { return this.send({ type: 'preview-text', id }) }
  async htmlThumbnail(id: string, capture: typeof captureLibraryHtml): Promise<string | null> {
    const path = await this.file(id)
    return path && !this.closing ? capture(path, this.thumbnailWindows, this.thumbnailAbort.signal) : null
  }

  async configure(update: LibrarySettingsUpdate, directory?: string | null): Promise<LibraryStatus> {
    if (this.configuring) throw new Error('unavailable')
    if (!update || typeof update !== 'object' || Object.keys(update).some(key => key !== 'enabled' && key !== 'maxBytes') || (update.enabled !== undefined && typeof update.enabled !== 'boolean')
      || (update.maxBytes !== undefined && (!Number.isSafeInteger(update.maxBytes) || update.maxBytes < LIBRARY_MIN_MAX_BYTES || update.maxBytes > LIBRARY_MAX_MAX_BYTES))) throw new Error('invalid')
    this.configuring = true
    try {
      const current = loadSettings().library
      const preferences: LibraryPreferences = { ...current, ...update, ...(directory !== undefined ? { directory } : {}) }
      const status = await this.send<LibraryStatus>({ type: 'configure', preferences, directory: preferences.directory ?? this.defaultDirectory })
      saveSettings({ ...loadSettings(), library: status.preferences })
      if (status.preferences.enabled) void this.rescan().catch(() => {})
      return status
    } finally { this.configuring = false }
  }

  async dispose(): Promise<void> {
    if (this.closing) return
    this.closing = true
    this.thumbnailAbort.abort()
    for (const win of this.thumbnailWindows) if (!win.isDestroyed()) win.destroy()
    this.thumbnailWindows.clear()
    if (this.notifyTimer) clearTimeout(this.notifyTimer)
    if (this.sessionTimer) clearTimeout(this.sessionTimer)
    this.sessions.clear(); this.nestedCalls.clear()
    const worker = this.worker
    if (!worker) return
    // Quit remains bounded even when an archive disk disappears mid-copy.
    let timer: ReturnType<typeof setTimeout> | undefined
    try { await Promise.race([this.send({ type: 'close' }), new Promise<void>(resolve => { timer = setTimeout(resolve, 1500) })]) }
    catch { /* History replay will recover any unfinished capture. */ }
    finally {
      if (timer) clearTimeout(timer)
      this.worker = null
      for (const job of this.jobs.values()) job.reject(new Error('unavailable'))
      this.jobs.clear(); await worker.terminate()
    }
  }
}
