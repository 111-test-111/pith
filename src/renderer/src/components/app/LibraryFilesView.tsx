import { useEffect, useId, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react'
import { Button } from '@/components/motion/button'
import { InfiniteMasonry, type InfiniteMasonryProps } from '@/components/motion/infinite-masonry'
import { MorphPopover, MorphPopoverContent } from '@/components/motion/popover-morph'
import { Tooltip } from '@/components/motion/tooltip'
import { Download, ExternalLink, Globe, Info, MessageSquare, RefreshCw, Trash2, X, type IconComponent } from '@/lib/icons'
import { useI18n } from '@/i18n'
import { basename, formatBytes } from '@/lib/format'
import { fileDirname } from '@/lib/file-navigation'
import { defaultViewFor, FileBrowserStore } from '@/state/file-browser-store'
import { previewKindOf } from '../../../../shared/preview'
import type { LibraryItem, LibrarySource } from '../../../../shared/library'
import { FileTypeIcon } from './FileTypeIcon'
import { FilePreviewPane } from './FilesPane'
import { MiddleEllipsis } from './MiddleEllipsis'
import { PanelResizeHandle } from './PanelResizeHandle'
import { useToast } from './ToastProvider'

type Paging = Pick<InfiniteMasonryProps<LibraryItem>, 'onLoadMore' | 'hasMore' | 'loading' | 'error' | 'onRetry' | 'emptyState'>
const ROW_HEIGHT = 92

function FileAction({ label, icon: Icon, onClick, disabled }: { label: string; icon: IconComponent; onClick: () => void; disabled?: boolean }) {
  return <Tooltip content={label}><Button variant="ghost" size="icon" className="size-7 shrink-0" aria-label={label} disabled={disabled} onClick={onClick}><Icon aria-hidden className="size-3.5" /></Button></Tooltip>
}

const previewName = (item: LibraryItem): string => item.kind === 'web' ? item.name + '.json' : item.name

/** Files and Web share a virtualized, three-line list and full file preview. */
export function LibraryFilesView({ kind, items, active, confirmationOpen, sourceLabel, renderInfo, onSave, onSession, onDelete, ...paging }: Paging & {
  kind: 'file' | 'web'
  items: LibraryItem[]
  active: boolean
  confirmationOpen: boolean
  sourceLabel: (source: LibrarySource) => string
  renderInfo: (item: LibraryItem, close: () => void) => ReactNode
  onSave: (item: LibraryItem) => void
  onSession: (item: LibraryItem) => void
  onDelete: (item: LibraryItem) => void
}) {
  const { t, locale } = useI18n(), toast = useToast()
  const web = kind === 'web'
  const [files] = useState(() => { const store = new FileBrowserStore(); store.setWrapLines(true); return store })
  const state = useSyncExternalStore(files.subscribe, files.getSnapshot)
  const [selection, setSelection] = useState<LibraryItem | null>(null)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [opening, setOpening] = useState(false)
  const [infoOpen, setInfoOpen] = useState(false)
  const [infoAnchor, setInfoAnchor] = useState<HTMLButtonElement | null>(null)
  const infoId = useId(), info = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(360)
  const list = useRef<HTMLDivElement>(null), split = useRef<HTMLDivElement>(null)
  const origin = useRef<HTMLButtonElement | null>(null), request = useRef(0)
  const drag = useRef({ width: 360, maximum: 720, next: 360 })
  useEffect(() => () => { request.current++; files.clear() }, [files])
  useEffect(() => { if (!active) setInfoOpen(false) }, [active])
  useEffect(() => {
    if (!active || !infoOpen || confirmationOpen) return
    const frame = requestAnimationFrame(() => info.current?.focus({ preventScroll: true }))
    return () => cancelAnimationFrame(frame)
  }, [active, infoOpen])
  const closeInfo = () => { setInfoOpen(false); infoAnchor?.focus({ preventScroll: true }) }
  const close = () => {
    request.current++; setInfoOpen(false); setSelection(null); setSelectedPath(null); setOpening(false); files.clear()
    if (origin.current?.isConnected) origin.current.focus({ preventScroll: true })
  }
  const select = async (item: LibraryItem, anchor?: HTMLButtonElement) => {
    const generation = ++request.current
    if (anchor) origin.current = anchor
    setInfoOpen(false); setSelection(item); setSelectedPath(null)
    if (item.storage !== 'saved') { files.clear(); setOpening(false); return }
    setOpening(true)
    const result = await window.pi.libraryFile(item.id).catch(() => null)
    if (generation !== request.current) return
    setOpening(false)
    if (!result?.ok) { files.clear(); toast.error({ title: t('library.actionError') }); return }
    const previous = files.getSnapshot().tabs.find(tab => tab.path === result.value)
    files.open(fileDirname(result.value), { path: result.value })
    if (!previous) {
      files.toggleTree(result.value)
      // Retain the requested source-first Markdown behavior; the full preview
      // tab remains available, and subsequent visits retain its chosen view.
      files.setView(result.value, previewKindOf(previewName(item)) === 'markdown' ? 'source' : defaultViewFor(previewName(item)))
    }
    if (previewKindOf(previewName(item)) === 'text') files.setView(result.value, 'source')
    setSelectedPath(result.value)
  }
  useEffect(() => {
    if (!selection) return
    const updated = items.find(item => item.id === selection.id)
    // Archive migration/refresh can replace the physical copy while Library
    // stays mounted behind Settings. Rebind the reader to the new snapshot.
    if (updated && updated !== selection) void select(updated)
    else if (!paging.loading && !items.length) close()
  }, [items, selection, paging.loading])
  const startResize = () => {
    const current = list.current?.getBoundingClientRect().width ?? width
    drag.current = { width: current, maximum: Math.max(224, (split.current?.clientWidth ?? 0) - 358), next: current }
  }
  const resize = (delta: number) => {
    drag.current.next = Math.round(Math.max(224, Math.min(drag.current.maximum, drag.current.width + delta)))
    list.current?.style.setProperty('--library-list-width', drag.current.next + 'px')
  }
  const endResize = () => setWidth(drag.current.next)
  const saved = selection?.storage === 'saved' && !!selection.archivedPath
  const infoLabel = selection ? t(web ? 'library.webInfo' : 'library.fileInfo', { name: selection.name }) : ''
  const renderActions = (includeSave = false) => selection ? <>
    {web ? <FileAction label={t('library.openWebsite')} icon={ExternalLink} disabled={!selection.url}
      onClick={() => void window.pi.openExternal(selection.url!).catch(() => toast.error({ title: t('library.actionError') }))} /> : null}
    <Tooltip content={infoLabel}>
      <Button ref={setInfoAnchor} id={infoId + '-trigger'} variant="ghost" size="icon" className={'size-7 shrink-0' + (infoOpen ? ' bg-muted text-primary' : '')}
        data-library-info-trigger aria-label={infoLabel} aria-haspopup="dialog" aria-expanded={infoOpen} aria-controls={infoOpen ? infoId : undefined}
        onClick={() => setInfoOpen(value => !value)}><Info aria-hidden className="size-3.5" /></Button>
    </Tooltip>
    {includeSave ? <FileAction label={t('library.saveAs')} icon={Download} disabled={!saved} onClick={() => onSave(selection)} /> : null}
    <FileAction label={t('library.openChat')} icon={MessageSquare} disabled={!selection.sessionPath} onClick={() => { closeInfo(); onSession(selection) }} />
    <FileAction label={t('library.remove')} icon={Trash2} onClick={() => onDelete(selection)} />
    <FileAction label={t(web ? 'library.closeWebPreview' : 'library.closeFilePreview')} icon={X} onClick={close} />
  </> : null
  return <MorphPopover anchor={infoAnchor} contentId={infoId} open={active && infoOpen && !!selection}
    onOpenChange={value => { if (!confirmationOpen) setInfoOpen(value) }} className="flex min-h-0 min-w-0 flex-1">
    <div ref={split} data-library-records-view data-library-files-view={web ? undefined : ''} data-library-web-view={web ? '' : undefined} className="flex min-h-0 min-w-0 flex-1">
    <div ref={list} data-library-record-list data-library-file-list={web ? undefined : ''} data-library-web-list={web ? '' : undefined} className="flex min-h-0 min-w-0 shrink-0 flex-col" style={selection ? { '--library-list-width': width + 'px', width: 'clamp(14rem, var(--library-list-width), calc(100% - 22rem))' } as CSSProperties : { width: '100%' }}>
      <InfiniteMasonry {...paging} items={items} getItemKey={item => item.id}
        renderItem={item => <article data-library-item={item.id} data-library-kind={kind} data-library-record-row data-library-file-row={web ? undefined : ''} data-library-web-row={web ? '' : undefined} data-selected={selection?.id === item.id || undefined} style={{ height: ROW_HEIGHT }}>
          <Button variant="ghost" aria-label={t('library.preview', { name: item.name })} aria-description={t(web ? 'library.webInteraction' : 'library.fileInteraction')} aria-pressed={selection?.id === item.id}
            onClick={event => void select(item, event.currentTarget)}
            className={'h-full w-full justify-start rounded-control border-b border-border/40 px-3 py-3 text-left' + (selection?.id === item.id ? ' bg-primary/5 ring-1 ring-inset ring-primary/60' : '')}>
            <span className="grid min-w-0 flex-1 grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-1">
              {web ? <Globe aria-hidden className="size-4.5 shrink-0 text-muted-foreground" /> : <FileTypeIcon path={item.name} variant="card" className="shrink-0" />}
              <span data-library-file-name={web ? undefined : ''} data-library-web-name={web ? '' : undefined} className="truncate text-sm font-medium leading-ui text-foreground" title={item.name}>{item.name}</span>
              <span className="col-start-2 truncate text-xs leading-ui-tight text-muted-foreground" title={web ? item.url ?? item.query : undefined}>{web ? item.url ?? item.query ?? t('library.projectless') : <>{item.project ? basename(item.project) : t('library.projectless')}{item.sessionTitle ? ' · ' + item.sessionTitle : ''}</>}</span>
              <span className="col-start-2 truncate text-caption leading-ui-tight text-muted-foreground">{sourceLabel(item.source)}{web ? ' · ' + (item.project ? basename(item.project) : t('library.projectless')) : ''} · {formatBytes(item.size)} · {new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(item.timestamp)}{item.storage === 'saved' ? '' : ' · ' + t('library.thumbnailUnavailable')}</span>
            </span>
          </Button>
        </article>}
        maxColumns={1} gap={0} itemSize={() => ROW_HEIGHT} estimateSize={() => ROW_HEIGHT} animateItems={false} renderLoadingItem={null}
        ariaLabel={t(web ? 'library.web' : 'library.files')} loadingLabel={t('library.loading')} errorLabel={t('library.loadError')} retryLabel={t('library.retry')}
        className="min-h-0 flex-1 rounded-none border-0 bg-transparent p-1" />
    </div>
    {selection ? <>
      <PanelResizeHandle grow="right" label={t(web ? 'library.resizeWeb' : 'library.resizeFiles')} className="block -mx-[3px]" value={width} onResizeStart={startResize} onResize={resize} onResizeEnd={endResize}
        onStep={delta => { startResize(); resize(delta); endResize() }} />
      <aside data-library-record-detail data-library-file-detail={web ? undefined : ''} data-library-web-detail={web ? '' : undefined} aria-label={t('library.preview', { name: selection.name })} className="sidebar-pane-container flex min-h-0 min-w-0 flex-1 flex-col border-l border-border/50">
        {opening || !selectedPath ? <div data-file-toolbar className="flex h-11 shrink-0 items-center gap-1 border-b border-border/40 px-2">
          {web ? <Globe aria-hidden className="size-4 shrink-0 text-muted-foreground" /> : <FileTypeIcon path={selection.name} variant="tree" className="shrink-0" />}
          <MiddleEllipsis name={selection.name} className="min-w-0 flex-1 px-1 text-xs font-medium" />
          <FileAction label={t('files.refresh')} icon={RefreshCw} disabled={!saved || opening} onClick={() => void select(selection)} />
          {renderActions(true)}
        </div> : null}
        {opening ? <p role="status" className="p-5 text-xs text-muted-foreground">{t('library.loading')}</p> : selectedPath ? <div className="min-h-0 flex-1">
          <FilePreviewPane files={files} filePath={state.active} displayName={state.active === selectedPath ? previewName(selection) : undefined}
            toolbarActions={renderActions()} saveCopyAction={state.active === selectedPath ? { label: t('library.saveAs'), onClick: () => onSave(selection) } : undefined} />
        </div> : <p role="status" className="p-5 text-xs text-muted-foreground">{t('library.thumbnailUnavailable')}</p>}
      </aside>
    </> : null}
    </div>
    <MorphPopoverContent side="bottom" align="end" inert={confirmationOpen} className="max-h-[calc(100vh-2rem)] w-[min(22rem,calc(100vw-2rem))] overflow-y-auto">
      {selection ? <div ref={info} tabIndex={-1} data-library-info data-library-info-item={selection.id} data-library-file-info={web ? undefined : ''} data-library-web-info={web ? '' : undefined} className="outline-none">{renderInfo(selection, closeInfo)}</div> : null}
    </MorphPopoverContent>
  </MorphPopover>
}
