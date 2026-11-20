import type { FileBrowserStore } from './file-browser-store'

const IDLE_MS = 90_000
const INACTIVE_LIMIT = 3

interface RetainedFilePreview {
  id: number
  files: FileBrowserStore
  path: string
  deadline: number | null
}

/** One rail-wide budget across conversations, ordered by last use. */
export class FilePreviewRetention {
  private entries: RetainedFilePreview[] = []
  private currentFiles: FileBrowserStore | undefined
  private owners = new Map<FileBrowserStore, () => void>()
  private listeners = new Set<() => void>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private nextId = 0

  getSnapshot = () => this.entries
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  show(files: FileBrowserStore, path: string | null): void {
    this.setCurrentFiles(files)
    const now = Date.now()
    const available = this.available(now)
    const selected = available.find(entry => entry.files === files && entry.path === path)
    const next = available.filter(entry => entry !== selected).slice(-INACTIVE_LIMIT)
      .map(entry => entry.deadline === null ? { ...entry, deadline: now + IDLE_MS } : entry)
    if (selected) {
      next.push(selected.deadline === null ? selected : { ...selected, deadline: null })
    } else if (path && files.getSnapshot().tabs.some(tab => tab.path === path)) {
      next.push({ id: ++this.nextId, files, path, deadline: null })
    }
    this.publish(next)
  }

  clear = (): void => {
    this.setCurrentFiles(undefined)
    this.publish([])
  }

  private setCurrentFiles(files: FileBrowserStore | undefined): void {
    const previous = this.currentFiles
    this.currentFiles = files
    // The Files chooser can own a cache even before a file has been opened.
    if (previous && previous !== files && !this.owners.has(previous)) previous.cache.clear()
  }

  private available(now: number): RetainedFilePreview[] {
    return this.entries.filter(entry => (entry.deadline === null || entry.deadline > now) &&
      entry.files.getSnapshot().tabs.some(tab => tab.path === entry.path))
  }

  private prune = (): void => { this.publish(this.available(Date.now())) }

  private scheduleExpiry(): void {
    clearTimeout(this.timer)
    const deadline = Math.min(...this.entries.map(entry => entry.deadline ?? Infinity))
    this.timer = Number.isFinite(deadline) ? setTimeout(() => {
      this.timer = undefined
      this.prune()
      if (this.timer === undefined) this.scheduleExpiry()
    }, Math.max(1, deadline - Date.now())) : undefined
  }

  private publish(next: RetainedFilePreview[]): void {
    if (next.length === this.entries.length && next.every((entry, index) => entry === this.entries[index])) return
    for (const entry of this.entries) {
      if (!next.some(candidate => candidate.id === entry.id)) entry.files.cache.closeDocument(entry.path)
    }
    this.entries = next
    const owners = new Set(next.map(entry => entry.files))
    for (const [files, unsubscribe] of this.owners) {
      if (owners.has(files)) continue
      unsubscribe()
      this.owners.delete(files)
      if (files !== this.currentFiles) files.cache.clear()
    }
    for (const files of owners) {
      if (!this.owners.has(files)) this.owners.set(files, files.subscribe(this.prune))
    }
    this.scheduleExpiry()
    for (const listener of this.listeners) listener()
  }
}
