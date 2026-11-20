import { SIDEBAR_TAB_KINDS, filePathForTab, fileTabId, type SidebarTabId } from '@/lib/sidebar-tabs'
import { FileBrowserStore, type FileBrowserState, type FileTab } from './file-browser-store'
import { GitStore } from './git-store'
import { SideChatStore } from './side-chat-store'
import { TerminalStore } from './terminal-store'
import type { PiShellState } from './pi-store'

const STORAGE_KEY = 'pi-app:workspace-panes:v1'
const SAVED_SESSIONS_LIMIT = 48
const SAVED_TABS_LIMIT = 128
const modes = ['closed', 'docked', 'fullscreen'] as const
type PanelMode = typeof modes[number]

interface PaneLayout {
  mode: PanelMode
  tabs: SidebarTabId[]
  active: SidebarTabId | null
  pickerOpen: boolean
  reviewTurnId: number | null
  reviewWrapLines: boolean
}
type SavedPanes = PaneLayout & { files?: FileBrowserState; gitWrapLines: boolean }
type PaneOwner = Pick<PiShellState, 'sessionId' | 'cwd' | 'subagentParentPath'>
const emptyLayout: SavedPanes = { mode: 'closed', tabs: [], active: null, pickerOpen: false, reviewTurnId: null, reviewWrapLines: true, gitWrapLines: true }

/** A saved session file has its own execution directory. The SDK ID also
 * distinguishes sessions that have not acquired a file yet. */
export function paneSessionKey(shell: Pick<PiShellState, 'sessionPath' | 'sessionId'>): string {
  return shell.sessionPath ?? (shell.sessionId ? `memory:${shell.sessionId}` : '')
}

function absolutePath(value: unknown): value is string {
  return typeof value === 'string' && /^(\/|[a-z]:\/)/i.test(value)
}

function readFiles(files: FileBrowserState | undefined): FileBrowserState | undefined {
  if (!Array.isArray(files?.tabs)) return undefined
  const tabs: FileTab[] = files.tabs.slice(0, SAVED_TABS_LIMIT).flatMap(tab => {
    if (!absolutePath(tab?.path) || !absolutePath(tab.cwd) || !['source', 'preview', 'diff'].includes(tab.view)) return []
    return [{
      path: tab.path, cwd: tab.cwd, view: tab.view, visit: 1, treeOpen: tab.treeOpen === true,
      gitDeletion: tab.gitDeletion === true ? true : undefined,
      line: Number.isSafeInteger(tab.line) && tab.line! > 0 ? tab.line : undefined
    }]
  })
  return {
    tabs, active: tabs.some(tab => tab.path === files.active) ? files.active : null,
    treeOpen: files.treeOpen !== false, wrapLines: files.wrapLines === true, diffWrapLines: files.diffWrapLines !== false,
    treeWidth: Number.isFinite(files.treeWidth) ? files.treeWidth : undefined,
    showGitChanges: files.showGitChanges !== false,
    expanded: Array.isArray(files.expanded) ? files.expanded.slice(0, 512).filter(absolutePath) : []
  }
}

function readLayouts(): Map<string, SavedPanes> {
  const saved = new Map<string, SavedPanes>()
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw || raw.length > 4 * 1024 * 1024) return saved
    const records = JSON.parse(raw) as Array<[string, SavedPanes]>
    if (!Array.isArray(records)) return saved
    for (const record of records.slice(-SAVED_SESSIONS_LIMIT)) {
      if (!Array.isArray(record)) continue
      const [path, value] = record
      if (typeof path !== 'string' || !Array.isArray(value?.tabs) || !modes.includes(value.mode)) continue
      const files = readFiles(value.files)
      const fileIds = new Set(files?.tabs.map(tab => fileTabId(tab.path)))
      const tabs = [...new Set(value.tabs.slice(0, SAVED_TABS_LIMIT).filter(id =>
        typeof id === 'string' && (SIDEBAR_TAB_KINDS.some(kind => kind === id) || fileIds.has(id) ||
          (id.startsWith('agent:') && id.length > 6) || (id.startsWith('scheduled:') && id.length > 10))
      ))]
      saved.set(path, {
        files, tabs, active: value.active && tabs.includes(value.active) ? value.active : tabs[0] ?? null,
        mode: value.mode,
        pickerOpen: value.pickerOpen === true,
        reviewTurnId: Number.isFinite(value.reviewTurnId) ? value.reviewTurnId : null,
        reviewWrapLines: value.reviewWrapLines !== false,
        gitWrapLines: value.gitWrapLines !== false
      })
    }
  } catch { /* Preferences are optional. */ }
  return saved
}

export class WorkspacePaneSession {
  readonly files: FileBrowserStore
  readonly terminals = new TerminalStore()
  readonly git: GitStore
  private layout: PaneLayout
  private listeners = new Set<() => void>()
  private sideChat: SideChatStore | null = null
  reviewCollapsed: Record<string, boolean> = {}

  constructor(readonly key: string, saved: SavedPanes | undefined, private readonly remember: () => void) {
    const { files, gitWrapLines, ...layout } = saved ?? emptyLayout
    this.layout = layout
    this.files = new FileBrowserStore(files)
    this.git = new GitStore(gitWrapLines, remember)
    this.files.subscribe(remember)
    this.files.subscribeOpen(path => {
      const id = fileTabId(path)
      const { tabs } = this.layout
      this.show({
        tabs: tabs.includes(id) ? tabs.filter(tab => tab !== 'files') :
          tabs.includes('files') ? tabs.map(tab => tab === 'files' ? id : tab) : [...tabs, id],
        active: id
      })
    })
  }

  getSnapshot = () => this.layout
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  save(): SavedPanes {
    return {
      ...this.layout,
      tabs: this.layout.tabs.slice(0, SAVED_TABS_LIMIT),
      files: readFiles(this.files.getSnapshot()),
      gitWrapLines: this.git.getState().wrapLines
    }
  }
  private update(patch: Partial<PaneLayout>): void {
    this.layout = { ...this.layout, ...patch }
    this.remember()
    for (const listener of this.listeners) listener()
  }
  private show(patch: Partial<PaneLayout>): void {
    this.update({ mode: this.layout.mode === 'closed' ? 'docked' : this.layout.mode, pickerOpen: false, ...patch })
  }
  setOpen = (value: boolean | ((open: boolean) => boolean)): void => {
    const open = this.layout.mode !== 'closed'
    if ((typeof value === 'function' ? value(open) : value) === open) return
    this.update({ mode: open ? 'closed' : 'docked' })
  }
  toggleFullscreen = (): void => {
    if (this.layout.mode !== 'closed') this.update({ mode: this.layout.mode === 'fullscreen' ? 'docked' : 'fullscreen' })
  }
  togglePicker = (): void => this.update({ pickerOpen: !this.layout.pickerOpen })
  open(id: SidebarTabId, foreground = true): void {
    const { tabs, active } = this.layout
    const next = tabs.includes(id) ? tabs : [...tabs, id]
    if (foreground) this.show({ tabs: next, active: id })
    else if (next !== tabs) this.update({ tabs: next, active: active ?? id })
  }
  select = (id: SidebarTabId): void => {
    if (!this.layout.tabs.includes(id)) return
    const path = filePathForTab(id)
    if (path) this.files.select(path)
    this.update({ active: id, pickerOpen: false })
  }
  review = (id: number | null): void => {
    if (id !== this.layout.reviewTurnId) this.update({ reviewTurnId: id })
  }
  setReviewWrapLines = (wrap: boolean): void => { this.update({ reviewWrapLines: wrap }) }
  setReviewCollapsed = (collapsed: Record<string, boolean>): void => { this.reviewCollapsed = collapsed }
  chat(sessionPath: string | null): SideChatStore {
    return this.sideChat ??= new SideChatStore(sessionPath)
  }
  close(remove: readonly SidebarTabId[]): void {
    const { tabs, active } = this.layout
    const next = tabs.filter(id => !remove.includes(id))
    if (next.length === tabs.length) return
    for (const id of remove) {
      if (id === 'chat') { this.sideChat?.dispose(); this.sideChat = null }
      if (id === 'terminal') this.terminals.dispose(true)
      const path = filePathForTab(id)
      if (path) this.files.close(path)
    }
    const index = active ? tabs.indexOf(active) : -1
    const selected = active && remove.includes(active)
      ? tabs.slice(0, index).reverse().find(id => next.includes(id)) ?? next[0] ?? null
      : active
    if (next.length === 0) this.update({ tabs: next, active: null, mode: 'closed', pickerOpen: false })
    else {
      const path = filePathForTab(selected)
      if (path) this.files.select(path)
      this.update({ tabs: next, active: selected, pickerOpen: false })
    }
  }
  dispose(): void {
    this.sideChat?.dispose()
    this.sideChat = null
    this.terminals.dispose()
    this.git.dispose()
    this.files.clear()
  }
}

export class WorkspacePanes {
  private saved = readLayouts()
  private sessions = new Map<string, WorkspacePaneSession>()
  private owners = new Map<string, PaneOwner>()
  private pending = new Set<string>()
  private timer: ReturnType<typeof setTimeout> | undefined

  forSession(key: string): WorkspacePaneSession {
    let session = this.sessions.get(key)
    if (!session) {
      session = new WorkspacePaneSession(key, this.saved.get(key), () => {
        if (!key || !this.sessions.has(key)) return
        this.pending.add(key)
        this.timer ??= setTimeout(this.flush, 150)
      })
      this.sessions.set(key, session)
    }
    return session
  }
  identify(key: string, owner: PaneOwner): void {
    if (key) this.owners.set(key, owner)
  }
  ownedBy(kind: 'session' | 'folder', id: string): Array<[string, PaneOwner]> {
    return [...this.owners].filter(([key, owner]) => kind === 'folder'
      ? owner.cwd === id
      : key === id || owner.subagentParentPath === id)
  }
  flush = (): void => {
    clearTimeout(this.timer)
    this.timer = undefined
    if (this.pending.size === 0) return
    for (const key of this.pending) {
      const session = this.sessions.get(key)
      this.saved.delete(key)
      if (session) this.saved.set(key, session.save())
    }
    this.pending.clear()
    while (this.saved.size > SAVED_SESSIONS_LIMIT) this.saved.delete(this.saved.keys().next().value!)
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...this.saved])) } catch { /* Optional preference storage. */ }
  }
  forget(key: string): void {
    const scope = this.sessions.get(key)
    this.sessions.delete(key)
    this.owners.delete(key)
    scope?.dispose()
    this.pending.add(key)
    this.flush()
  }
  dispose = (): void => {
    this.flush()
    const sessions = [...this.sessions.values()]
    this.sessions.clear()
    this.owners.clear()
    for (const session of sessions) session.dispose()
  }
}
