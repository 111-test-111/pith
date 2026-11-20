import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, memo, type ReactNode } from 'react'
import type { GitChange } from '../../../../shared/git'
import { FileTreeView, FileTreeFile, FileTreeFolder } from './FileTreeView'
import { fileTreeGitLabel, indexFileTreeGit } from './FileTreeGit'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/components/motion/context-menu'
import { ChevronDown, LoaderCircle, RefreshCw } from '@/lib/icons'
import { useFilePreviewActive, useFilePreviewPopup } from '@/lib/file-preview-activity'
import { basename } from '@/lib/format'
import { useI18n } from '@/i18n'
import type { FileBrowserStore } from '@/state/file-browser-store'
import { FileTypeIcon } from './FileTypeIcon'
import { MiddleEllipsis } from './MiddleEllipsis'
import { useToast } from './ToastProvider'

const entryNames = new Intl.Collator('en', { numeric: true })

/** IO and pagination stay app-owned; beUI owns the actual tree collection,
 * selection, branch motion, roving focus and Arrow/Home/End/Enter behaviour. */
export const FileTree = memo(function FileTree({ root, projectless, expanded, selected, store, refresh, changes }: {
  root: string; projectless: boolean; expanded: string[]; selected: string | null; store: FileBrowserStore; refresh: number; changes?: readonly GitChange[]
}) {
  const { t } = useI18n()
  const active = useFilePreviewActive()
  const contextMenu = useFilePreviewPopup()
  const ref = useRef<HTMLElement>(null)
  // One menu for the whole tree: the row under the pointer is resolved from the
  // DOM, so the collection stays untouched (and no per-row wrapper is needed).
  const [menuPath, setMenuPath] = useState<string | null>(null)
  const [menuFolder, setMenuFolder] = useState(false)
  const toast = useToast()
  const menuFailed = () => toast.error({ title: t('files.actionError') })
  const openRow = async () => {
    if (!menuPath) return
    try { if (await window.pi.openPath(menuPath)) menuFailed() } catch { menuFailed() }
  }
  const revealRow = () => { if (menuPath) void window.pi.showInFolder(menuPath) }
  const saveRow = async () => {
    if (!menuPath) return
    try {
      const { status } = await window.pi.saveFileCopy(menuPath)
      if (status === 'error') menuFailed()
    } catch { menuFailed() }
  }
  const copyRowPath = async () => {
    if (!menuPath) return
    try { await navigator.clipboard.writeText(menuPath) } catch { menuFailed() }
  }
  const cache = store.cache
  const [snapshot, setSnapshot] = useState(() => ({ root, selected, refresh, prepared: false, values: cache.directorySnapshot(root) }))
  const directories = snapshot.root === root ? snapshot.values : cache.directorySnapshot(root)
  const current = useRef(directories)
  current.current = directories
  const generation = useRef(0)
  const requests = useRef(new Set<string>())
  const preparing = !snapshot.prepared || snapshot.root !== root || snapshot.selected !== selected || snapshot.refresh !== refresh
  const revealPending = useRef(true)
  const load = useCallback(async (path: string, append = false, retry = false) => {
    if (requests.current.has(path)) return
    const request = generation.current
    requests.current.add(path)
    if (retry) cache.invalidateTree(path)
    const value = await cache.readDirectory({ cwd: root, path }, append, current.current.get(path))
    if (generation.current !== request) return
    const next = new Map(current.current)
    next.set(path, value); current.current = next; setSnapshot(previous => ({ ...previous, root, values: next }))
    requests.current.delete(path)
  }, [cache, root])
  useEffect(() => {
    if (!active) return
    const request = ++generation.current
    requests.current.clear()
    // Ancestors and restored siblings load concurrently, then enter the native
    // tree together. Keep the previous collection while a new path is prepared.
    void cache.prepareTree(root, selected, store.getSnapshot().expanded).then(values => {
      if (request !== generation.current) return
      const next = new Map([...cache.directorySnapshot(root), ...values])
      setSnapshot(previous => {
        const unchanged = previous.root === root && previous.values.size === next.size && [...next].every(([path, value]) => previous.values.get(path) === value)
        const values = unchanged ? previous.values : next
        current.current = values
        return { root, selected, refresh, prepared: true, values }
      })
    })
    return () => { generation.current++; requests.current.clear() }
  }, [active, cache, root, selected, refresh, store])
  useEffect(() => {
    if (!active) return
    const before = store.getSnapshot().expanded
    if (!before.includes(root)) store.setExpanded([...before, root])
  }, [active, root, store])
  useEffect(() => {
    if (!active || preparing) return
    const queue = [root]
    for (const path of queue) {
      if (!expanded.includes(path)) continue
      const directory = directories.get(path)
      if (!directory) { void load(path); continue }
      for (const entry of directory.entries) if (entry.directory) queue.push(entry.path)
    }
  }, [active, directories, expanded, load, root, preparing])
  const git = useMemo(() => changes?.length ? indexFileTreeGit(root, changes) : undefined, [root, changes])
  const { children, folderPaths, missingPaths } = useMemo(() => {
    const folderPaths = new Set<string>()
    const missingPaths = new Set<string>()
    const folder = (path: string, name: string, missing = false): ReactNode => {
      folderPaths.add(path)
      if (missing) missingPaths.add(path)
      const value = directories.get(path)
      const disk = value?.entries ?? []
      const removed = git?.missing.get(path)
      const present = removed ? new Set(disk.map(entry => entry.path)) : undefined
      const extra = removed ? [...removed.values()].filter(entry => !present?.has(entry.path)) : []
      const entries = extra.length ? [...disk, ...extra].sort((a, b) => Number(b.directory) - Number(a.directory) || entryNames.compare(a.name, b.name)) : disk
      const decoration = git?.folders.has(path) ? fileTreeGitLabel(name, t) : { label: <MiddleEllipsis name={name} /> }
      return <FileTreeFolder key={path} value={path} name={name} {...decoration}>
        {entries.map(entry => {
          const absent = !!removed?.has(entry.path) && !present?.has(entry.path)
          if (entry.directory) return folder(entry.path, entry.name, absent)
          if (absent) missingPaths.add(entry.path)
          const change = git?.files.get(entry.path)
          const decoration = change ? fileTreeGitLabel(entry.name, t, change) : { label: <MiddleEllipsis name={entry.name} /> }
          return <FileTreeFile key={entry.path} value={entry.path} name={entry.name} {...decoration} icon={<FileTypeIcon path={entry.path} className="size-4" />} />
        })}
        {!missing && !value ? <FileTreeFile value={`loading:${path}`} name={t('files.loading')} disabled icon={<LoaderCircle className="size-3.5 motion-safe:animate-spin" />} /> : null}
        {!missing && value?.error ? <FileTreeFile value={`retry:${path}`} name={t('files.treeError')} icon={<RefreshCw className="size-3.5" />} /> : null}
        {value && !value.error && !entries.length ? <FileTreeFile value={`empty:${path}`} name={t('files.emptyFolder')} disabled icon={<span />} /> : null}
        {value?.nextOffset !== undefined ? <FileTreeFile value={`more:${path}`} name={t('files.loadMore')} icon={<ChevronDown className="size-3.5" />} /> : null}
      </FileTreeFolder>
    }
    const children = folder(root, projectless ? t('files.workspace') : basename(root) || root)
    return { children, folderPaths, missingPaths }
  }, [directories, root, projectless, git, t])
  const menuMissing = menuPath !== null && missingPaths.has(menuPath)
  useLayoutEffect(() => { revealPending.current = true }, [selected, root, refresh])
  useLayoutEffect(() => {
    if (!selected || !revealPending.current || preparing) return
    const element = ref.current
    const row = element?.querySelector<HTMLElement>('[role="treeitem"][aria-selected="true"]')
    if (!element || !row) return
    // No path animation or intermediate paint: place the selected row before
    // this completed collection appears, even when the tree was remounted.
    let top = 0
    for (let node: HTMLElement | null = row; node && node !== element; node = node.offsetParent as HTMLElement | null) top += node.offsetTop
    if (top < element.scrollTop || top + row.offsetHeight > element.scrollTop + element.clientHeight) element.scrollTop = top - (element.clientHeight - row.offsetHeight) / 2
    revealPending.current = false
  }, [directories, preparing, selected, root, refresh])
  return <ContextMenu {...contextMenu}>
    <ContextMenuTrigger>
    <nav ref={ref} aria-label={t('files.tree')} data-file-tree className="relative min-h-0 min-w-0 overflow-auto p-1"
      onContextMenu={(event) => {
        const row = (event.target as HTMLElement).closest<HTMLElement>('[role="treeitem"]')
        const value = row?.getAttribute('data-tree-value') ?? null
        // Loading / retry / empty / load-more rows are affordances, not paths.
        const usable = !!value && !/^(loading|retry|empty|more):/.test(value) && !row?.hasAttribute('aria-disabled')
        setMenuPath(usable ? value : null)
        setMenuFolder(!!row?.hasAttribute('aria-expanded'))
      }}>
    <FileTreeView value={selected} expandedIds={expanded} onExpandedChange={next => store.setExpanded(next)} ariaLabel={t('files.tree')}
      onValueChange={value => {
        if (value.startsWith('retry:')) { void load(value.slice(6), false, true); return }
        if (value.startsWith('more:')) { void load(value.slice(5), true); return }
        if (folderPaths.has(value)) return
        if (missingPaths.has(value)) store.open(root, { path: value }, 'diff', { gitDeletion: true })
        else store.open(root, { path: value })
      }}>
      {children}
    </FileTreeView>
    </nav>
    </ContextMenuTrigger>
    <ContextMenuContent ariaLabel={t('files.treeMenu')}>
      {menuPath && !menuFolder && !menuMissing ? <ContextMenuItem onSelect={() => void openRow()}>{t('files.openDefault')}</ContextMenuItem> : null}
      <ContextMenuItem disabled={!menuPath || menuMissing} onSelect={revealRow}>{t('files.showInFolder')}</ContextMenuItem>
      {menuPath && !menuFolder && !menuMissing ? <ContextMenuItem onSelect={() => void saveRow()}>{t('files.saveAs')}</ContextMenuItem> : null}
      <ContextMenuSeparator />
      <ContextMenuItem disabled={!menuPath} onSelect={() => void copyRowPath()}>{t('files.copyPath')}</ContextMenuItem>
    </ContextMenuContent>
  </ContextMenu>
})
