import { fileDirname, type FileTarget } from '@/lib/file-navigation'
import { isHomePath, normalizeSlashes } from '@/lib/tool-path'
import { opensOnPreview } from '../../../shared/preview'
import { FileBrowserCache } from './file-browser-cache'
import type { TextEncoding } from '../../../shared/file-preview'

export type FileView = 'source' | 'preview' | 'diff'
export interface FileTab extends FileTarget {
  cwd: string
  view: FileView
  visit: number
  treeOpen: boolean
  encoding?: TextEncoding
  previewState?: {
    dataTable?: string; dataView?: 'rows' | 'schema'
    archiveExpanded?: string[]; archiveQuery?: string; archiveSearchCollapsed?: string[]; archiveFocused?: string
    archiveEntry?: { id: string; name: string }
  }
}
interface FileBrowserState {
  tabs: FileTab[]
  active: string | null
  treeOpen: boolean
  expanded: string[]
  treeWidth?: number
  wrapLines: boolean
}
/** Markdown, tables, patch files, notebooks and subtitles open on their
 * rendered view; everything else on source. The routing table decides, so a new
 * previewable type is one branch in `shared/preview.ts`. */
export const defaultViewFor = (path: string): FileView => opensOnPreview(path) ? 'preview' : 'source'

/** Tree, view and scroll choices survive pane unmounts and rail collapse.
 * The separate bounded cache keeps visits fast without retaining hidden DOM. */
export class FileBrowserStore {
  readonly cache = new FileBrowserCache()
  private state: FileBrowserState = { tabs: [], active: null, treeOpen: true, expanded: [], wrapLines: false }
  private listeners = new Set<() => void>()
  private openListeners = new Set<(path: string) => void>()
  subscribeOpen = (listener: (path: string) => void) => { this.openListeners.add(listener); return () => { this.openListeners.delete(listener) } }
  private openErrorListeners = new Set<() => void>()
  subscribeOpenError = (listener: () => void) => { this.openErrorListeners.add(listener); return () => { this.openErrorListeners.delete(listener) } }
  private navigationVersion = 0
  private scroll = new Map<string, { top: number; left: number }>()
  private positioned = new Map<string, number>()
  getSnapshot = () => this.state
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private set(patch: Partial<FileBrowserState>) {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener()
  }
  open(cwd: string, target: FileTarget) {
    const version = ++this.navigationVersion
    const path = normalizeSlashes(target.path)
    if (isHomePath(path)) {
      // Resolve only at navigation time. Tabs/cache/media URLs always receive
      // absolute paths, while ordinary navigation stays synchronous.
      return window.pi.resolveFilePath({ cwd, path }).then(absolute => {
        if (version === this.navigationVersion) this.openResolved(cwd, { ...target, path: absolute })
      }).catch(() => {
        if (version === this.navigationVersion) for (const listener of this.openErrorListeners) listener()
      })
    }
    this.openResolved(cwd, target)
  }
  private openResolved(cwd: string, target: FileTarget) {
    cwd = cwd.replaceAll('\\', '/')
    const previous = this.state.tabs.find(tab => tab.path === target.path)
    const tab: FileTab = { ...target, cwd: previous?.cwd ?? cwd, view: target.line ? 'source' : previous?.view ?? defaultViewFor(target.path), visit: (previous?.visit ?? 0) + 1, treeOpen: previous?.treeOpen ?? true, encoding: previous?.encoding, previewState: previous?.previewState }
    const expanded = new Set(this.state.expanded)
    let parent = fileDirname(target.path)
    while (true) {
      expanded.add(parent)
      if (parent === cwd || parent === '/' || /^[a-z]:$/i.test(parent)) break
      const next = fileDirname(parent)
      if (next === parent) break
      parent = next
    }
    this.set({ tabs: previous ? this.state.tabs.map(item => item === previous ? tab : item) : [...this.state.tabs, tab], active: tab.path, expanded: [...expanded] })
    for (const listener of this.openListeners) listener(tab.path)
  }
  select(path: string) { this.navigationVersion++; this.set({ active: path }) }
  close(path: string) {
    this.navigationVersion++
    this.cache.closeDocument(path)
    const index = this.state.tabs.findIndex(tab => tab.path === path)
    const tabs = this.state.tabs.filter(tab => tab.path !== path)
    for (const key of this.scroll.keys()) if (key.startsWith(`${path}\0`)) this.scroll.delete(key)
    this.positioned.delete(path)
    for (const key of this.positioned.keys()) if (key.startsWith(path + '\0')) this.positioned.delete(key)
    this.set({ tabs, active: this.state.active === path ? (tabs[index - 1] ?? tabs[index])?.path ?? null : this.state.active })
  }
  clear() { this.navigationVersion++; this.cache.clear(); this.scroll.clear(); this.positioned.clear(); this.set({ tabs: [], active: null, expanded: [] }) }
  takeNavigationLine(tab: FileTab) {
    if (this.positioned.get(tab.path) === tab.visit) return undefined
    this.positioned.set(tab.path, tab.visit)
    return tab.line
  }
  setView(path: string, view: FileView) { this.set({ tabs: this.state.tabs.map(tab => tab.path === path ? { ...tab, view, line: undefined } : tab) }) }
  setPreviewState(path: string, patch: NonNullable<FileTab['previewState']>) { this.set({ tabs: this.state.tabs.map(tab => tab.path === path ? { ...tab, previewState: { ...tab.previewState, ...patch } } : tab) }) }
  toggleTree(path?: string | null) {
    if (path) this.set({ tabs: this.state.tabs.map(tab => tab.path === path ? { ...tab, treeOpen: !tab.treeOpen } : tab) })
    else this.set({ treeOpen: !this.state.treeOpen })
  }
  setExpanded(expanded: string[]) { this.set({ expanded }) }
  setTreeWidth(treeWidth: number) { this.set({ treeWidth }) }
  setWrapLines(wrapLines: boolean) { this.set({ wrapLines }) }
  getScroll(path: string, view: FileView) { return this.scroll.get(`${path}\0${view}`) }
  saveScroll(path: string, view: FileView, top: number, left: number) {
    // Archive sources have a virtual identity owned by their outer file tab.
    if (this.state.tabs.some(tab => tab.path === path || path.startsWith(tab.path + '\0'))) this.scroll.set(`${path}\0${view}`, { top, left })
  }
}
