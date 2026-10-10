import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, memo, type ReactNode } from 'react'
import { FileTreeView, FileTreeFile, FileTreeFolder } from './FileTreeView'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/components/motion/context-menu'
import { ChevronDown, LoaderCircle, RefreshCw } from '@/lib/icons'
import { basename } from '@/lib/format'
import { useI18n } from '@/i18n'
import type { FileBrowserStore } from '@/state/file-browser-store'
import { FileTypeIcon } from './FileTypeIcon'
import { MiddleEllipsis } from './MiddleEllipsis'
import { useToast } from './ToastProvider'

/** IO and pagination stay app-owned; beUI owns the actual tree collection,
 * selection, branch motion, roving focus and Arrow/Home/End/Enter behaviour. */
export const FileTree = memo(function FileTree({ root, projectless, expanded, selected, store, refresh }: {
  root: string; projectless: boolean; expanded: string[]; selected: string | null; store: FileBrowserStore; refresh: number
}) {
  const { t } = useI18n()
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
  }, [cache, root, selected, refresh, store])
  useEffect(() => {
    const before = store.getSnapshot().expanded
    if (!before.includes(root)) store.setExpanded([...before, root])
  }, [root, store])
  useEffect(() => {
    if (preparing) return
    const queue = [root]
    for (const path of queue) {
      if (!expanded.includes(path)) continue
      const directory = directories.get(path)
      if (!directory) { void load(path); continue }
      for (const entry of directory.entries) if (entry.directory) queue.push(entry.path)
    }
  }, [directories, expanded, load, root, preparing])
  const children = useMemo(() => {
    const folder = (path: string, name: string): ReactNode => {
      const value = directories.get(path)
      return <FileTreeFolder key={path} value={path} name={name} label={<MiddleEllipsis name={name} />}>
        {value?.entries.map(entry => entry.directory ? folder(entry.path, entry.name) :
          <FileTreeFile key={entry.path} value={entry.path} name={entry.name} label={<MiddleEllipsis name={entry.name} />} icon={<FileTypeIcon path={entry.path} className="size-4" />} />)}
        {!value ? <FileTreeFile value={`loading:${path}`} name={t('files.loading')} disabled icon={<LoaderCircle className="size-3.5 motion-safe:animate-spin" />} /> : null}
        {value?.error ? <FileTreeFile value={`retry:${path}`} name={t('files.treeError')} icon={<RefreshCw className="size-3.5" />} /> : null}
        {value && !value.error && value.entries.length === 0 ? <FileTreeFile value={`empty:${path}`} name={t('files.emptyFolder')} disabled icon={<span />} /> : null}
        {value?.nextOffset !== undefined ? <FileTreeFile value={`more:${path}`} name={t('files.loadMore')} icon={<ChevronDown className="size-3.5" />} /> : null}
      </FileTreeFolder>
    }
    return folder(root, projectless ? t('files.workspace') : basename(root) || root)
  }, [directories, root, projectless, t])
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
  return <ContextMenu>
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
        if (value === root || [...directories.values()].some(directory => directory.entries.some(entry => entry.path === value && entry.directory))) return
        store.open(root, { path: value })
      }}>
      {children}
    </FileTreeView>
    </nav>
    </ContextMenuTrigger>
    <ContextMenuContent ariaLabel={t('files.treeMenu')}>
      {menuPath && !menuFolder ? <ContextMenuItem onSelect={() => void openRow()}>{t('files.openDefault')}</ContextMenuItem> : null}
      <ContextMenuItem disabled={!menuPath} onSelect={revealRow}>{t('files.showInFolder')}</ContextMenuItem>
      {menuPath && !menuFolder ? <ContextMenuItem onSelect={() => void saveRow()}>{t('files.saveAs')}</ContextMenuItem> : null}
      <ContextMenuSeparator />
      <ContextMenuItem disabled={!menuPath} onSelect={() => void copyRowPath()}>{t('files.copyPath')}</ContextMenuItem>
    </ContextMenuContent>
  </ContextMenu>
})
