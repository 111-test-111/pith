import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { ArrowLeft, BookOpen, Download, FileText, Globe, Image as ImageIcon, LoaderCircle, MessageSquare, RefreshCw, Search, Settings2, Trash2, X } from '@/lib/icons'
import { Button } from '@/components/motion/button'
import { Checkbox } from '@/components/motion/checkbox'
import { Input } from '@/components/motion/input'
import { InfiniteMasonry } from '@/components/motion/infinite-masonry'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/motion/select'
import { Tabs, TabsList, TabsTrigger } from '@/components/motion/tabs'
import { Tooltip } from '@/components/motion/tooltip'
import { CenterMorphModal, CenterMorphModalContent } from '@/components/motion/center-morph-modal'
import { MorphPopover, MorphPopoverContent } from '@/components/motion/popover-morph'
import { useI18n } from '@/i18n'
import { useLibraryStatus } from '@/lib/hooks/use-library-status'
import { basename, formatBytes } from '@/lib/format'
import { mediaUrl } from '../../../../shared/media'
import type { LibraryImageLabel, LibraryItem, LibraryKind, LibraryPage as LibraryPageData, LibrarySource, LibraryStorage } from '../../../../shared/library'
import { useImagePreviewCollection, type PreviewImage } from './ImagePreview'
import { FileTypeIcon } from './FileTypeIcon'
import { LibraryFilesView } from './LibraryFilesView'
import { WindowTitlebar } from './WindowTitlebar'
import { useToast } from './ToastProvider'
import type { MessageKey } from '@/i18n/locales/en'

const sourceKeys = {
  attachment: 'library.source.attachment', present: 'library.source.present', 'tool-image': 'library.source.toolImage',
  download: 'library.source.download', search: 'library.source.search', fetch: 'library.source.fetch',
  browser: 'library.source.browser', link: 'library.source.link'
} as const satisfies Record<LibrarySource, MessageKey>
const storageKeys = {
  saved: 'library.storage.saved', metadata: 'library.storage.metadata', limit: 'library.storage.limit',
  missing: 'library.storage.missing', failed: 'library.storage.failed', invalid: 'library.storage.invalid'
} as const satisfies Record<LibraryStorage, MessageKey>
const imageKeys = {
  attachment: 'library.image.attachment', generated: 'library.image.generated', screenshot: 'library.image.screenshot', tool: 'library.image.tool'
} as const satisfies Record<LibraryImageLabel, MessageKey>
function itemName(item: LibraryItem, t: ReturnType<typeof useI18n>['t']): string {
  if (!item.imageLabel || item.originalPath) return item.name
  const name = t(imageKeys[item.imageLabel])
  return item.imageNumber ? t('library.imageNumber', { name, number: item.imageNumber }) : name
}
function previewImages(items: readonly LibraryItem[], t: ReturnType<typeof useI18n>['t']): PreviewImage[] {
  return items.flatMap(item => item.kind === 'image' && item.storage === 'saved' && item.archivedPath
    ? [{ id: item.id, src: mediaUrl(item.archivedPath), label: itemName(item, t), path: item.archivedPath }] : [])
}
function imageFrameHeight(item: LibraryItem, columnWidth: number): number {
  const ratio = item.imageWidth && item.imageHeight ? item.imageHeight / item.imageWidth : 0.75
  return Math.max(1, Math.round(columnWidth * ratio))
}
function imageCardSize(item: LibraryItem, _index: number, columnWidth: number): number {
  return imageFrameHeight(item, columnWidth)
}
const LIBRARY_GALLERY_GAP = 24
const IMAGE_INFO_DELAY = 200
const HIDE_UNAVAILABLE_KEY = 'pi-app:library-hide-unavailable'
interface LibrarySelection { item: LibraryItem; anchor: HTMLButtonElement; keyboard: boolean; scrollTop: number; scrollLeft: number }
interface LibrarySnapshot { scope: string; page: LibraryPageData | null; loading: boolean; error: boolean }
const NO_ITEMS: LibraryItem[] = []
const emptyKeys = {
  image: { title: 'library.empty.imagesTitle', hint: 'library.empty.imagesHint', icon: ImageIcon },
  file: { title: 'library.empty.filesTitle', hint: 'library.empty.filesHint', icon: FileText },
  web: { title: 'library.empty.webTitle', hint: 'library.empty.webHint', icon: Globe }
} as const

function LibraryLoadingState() {
  const { t } = useI18n()
  const [visible, setVisible] = useState(false)
  useEffect(() => { const timer = setTimeout(() => setVisible(true), 150); return () => clearTimeout(timer) }, [])
  return <div data-library-loading role="status" className="flex min-h-0 flex-1 items-center justify-center gap-2 text-xs text-muted-foreground">
    {visible ? <><LoaderCircle aria-hidden className="size-4 motion-safe:animate-spin" /><span>{t('library.loading')}</span></> : null}
  </div>
}

interface LibraryActions {
  onPreview: (item: LibraryItem) => void
  onSave: (item: LibraryItem) => void
  onSession: (item: LibraryItem) => void
  onDelete: (item: LibraryItem) => void
}

function LibraryItemDetails({ item, actions, onClose }: {
  item: LibraryItem
  actions?: LibraryActions
  onClose?: () => void
}) {
  const { t, locale } = useI18n()
  const name = itemName(item, t)
  const saved = item.storage === 'saved' && !!item.archivedPath
  const isImage = item.kind === 'image'
  const caption = item.project ? basename(item.project) : t('library.projectless')
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(item.timestamp)
  const icon = item.kind === 'web' ? <Globe className="size-5" /> : item.kind === 'image' ? <ImageIcon className="size-5" /> : <FileTypeIcon path={item.name} variant="card" />
  return (
      <div className="space-y-2.5 p-3">
        <div className="flex items-start gap-2">
          {item.kind !== 'image' ? <span className="mt-0.5 shrink-0 text-muted-foreground">{icon}</span> : null}
          <h2 className="min-w-0 flex-1 break-words text-sm font-medium leading-ui text-foreground">{name}</h2>
          {onClose ? <Button variant="ghost" size="icon" className="size-6 shrink-0" aria-label={t(isImage ? 'library.closeImageInfo' : item.kind === 'web' ? 'library.closeWebInfo' : 'library.closeFileInfo')} onClick={onClose}><X className="size-4" /></Button> : null}
        </div>
        {item.kind === 'web' && item.url ? <Button variant="ghost" className="h-auto max-w-full justify-start break-all p-0 text-left text-xs" onClick={() => void window.pi.openExternal(item.url!).catch(() => {})}>{item.url}</Button> : null}
        {item.description ? <p className={(isImage ? 'whitespace-pre-wrap break-words' : 'line-clamp-3') + ' text-xs leading-ui text-muted-foreground'}>{item.description}</p> : null}
        {item.query ? <p className="line-clamp-2 text-xs text-muted-foreground">{t('library.searchQuery', { query: item.query })}</p> : null}
        {item.kind === 'web' && item.excerpt ? <p className="line-clamp-5 whitespace-pre-wrap break-words text-xs leading-ui text-muted-foreground">{item.excerpt}</p> : null}
        {item.sessionTitle ? <p className="break-words text-xs leading-ui text-muted-foreground">{item.sessionTitle}</p> : null}
        {isImage && item.imageWidth && item.imageHeight ? <p className="text-xs tabular-nums text-muted-foreground">{t('library.imageDimensions', { width: item.imageWidth, height: item.imageHeight })}</p> : null}
        <p className={(isImage ? 'break-words' : 'truncate') + ' text-caption text-muted-foreground'} title={item.project ?? undefined}>{caption} · {date}</p>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-muted-foreground">
          <span title={item.toolName}>{t(sourceKeys[item.source])}</span>
          <span className={item.storage === 'limit' || item.storage === 'failed' ? 'text-amber-600 dark:text-amber-400' : undefined}>{t(storageKeys[item.storage])}</span>
          {item.size > 0 ? <span>{formatBytes(item.size)}</span> : null}
        </div>
        {actions ? <div className="flex items-center justify-end gap-0.5 border-t border-border/50 pt-1.5">
          <Tooltip content={item.kind === 'web' ? t('library.snapshot') : t('library.preview', { name })}>
            <Button variant="ghost" size="icon" disabled={!saved} aria-label={item.kind === 'web' ? t('library.snapshot') : t('library.preview', { name })} onClick={() => actions.onPreview(item)}><BookOpen className="size-4" /></Button>
          </Tooltip>
          <Tooltip content={t('library.saveAs')}><Button variant="ghost" size="icon" disabled={!saved} aria-label={t('library.saveAs')} onClick={() => actions.onSave(item)}><Download className="size-4" /></Button></Tooltip>
          <Tooltip content={t('library.openChat')}><Button variant="ghost" size="icon" disabled={!item.sessionPath} aria-label={t('library.openChat')} onClick={() => actions.onSession(item)}><MessageSquare className="size-4" /></Button></Tooltip>
          <Tooltip content={t('library.remove')}><Button variant="ghost" size="icon" aria-label={t('library.remove')} onClick={() => actions.onDelete(item)}><Trash2 className="size-4" /></Button></Tooltip>
        </div> : null}
      </div>
  )
}

function LibraryCard({ item, columnWidth, selected, infoOpen, infoId, onInfo, onCancelInfo, ...actions }: LibraryActions & {
  item: LibraryItem
  columnWidth: number
  selected: boolean
  infoOpen: boolean
  infoId: string
  onInfo: (item: LibraryItem, anchor: HTMLButtonElement, keyboard: boolean) => void
  onCancelInfo: () => void
}) {
  const { t } = useI18n()
  const [imageFailed, setImageFailed] = useState(false)
  // Revalidation can restore a copy that failed to load in the cached view.
  useEffect(() => setImageFailed(false), [item])
  const name = itemName(item, t), saved = item.storage === 'saved' && !!item.archivedPath
  return (
    <article data-library-item={item.id} data-library-kind="image" data-selected={selected || undefined} className="rounded-window">
      <Button id={'library-image-' + item.id} variant="ghost" aria-label={t('library.imageInfo', { name })} aria-description={t('library.imageInteraction')}
        aria-haspopup="dialog" aria-expanded={infoOpen} aria-controls={infoOpen ? infoId : undefined}
        onClick={event => { if (event.detail < 2) onInfo(item, event.currentTarget, event.detail === 0); else onCancelInfo() }}
        onMouseDown={event => { if (event.detail > 1) onCancelInfo() }}
        onDoubleClick={() => { onCancelInfo(); if (saved && !imageFailed) actions.onPreview(item) }}
        style={{ height: imageFrameHeight(item, columnWidth) }}
        className={'relative block w-full overflow-hidden rounded-window p-0 hover:bg-transparent' + (selected ? ' ring-1 ring-primary ring-offset-2 ring-offset-background' : '')}>
        {saved && !imageFailed ? <img src={mediaUrl(item.archivedPath!)} alt={item.description || name} loading="eager" decoding="async" width={item.imageWidth} height={item.imageHeight} draggable={false} className="absolute inset-0 h-full w-full rounded-window object-contain" onError={() => setImageFailed(true)} />
          : <span className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-muted/30 text-muted-foreground"><ImageIcon className="size-5" /><span className="text-xs">{t(imageFailed ? 'library.storage.failed' : storageKeys[item.storage])}</span></span>}
      </Button>
    </article>
  )
}

/** A kept-mounted full page: chat drafts, library filters and image previews
 * share the workspace's normal stores and preview provider. */
export function LibraryPage({ open, onBack, onSettings, onOpenSession }: {
  open: boolean
  onBack: () => void
  onSettings: () => void
  onOpenSession: (path: string) => Promise<void>
}) {
  const { t } = useI18n(), toast = useToast()
  const { status, error: statusError } = useLibraryStatus(open)
  const [visited, setVisited] = useState(open)
  const [kind, setKind] = useState<LibraryKind>('image')
  const [project, setProject] = useState('all')
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const [hideUnavailable, setHideUnavailable] = useState(() => { try { return localStorage.getItem(HIDE_UNAVAILABLE_KEY) !== 'false' } catch { return true } })
  const [revision, setRevision] = useState(0)
  // One snapshot per category, each bound to its exact filters. Changing the
  // selected tab never exposes the previous category's rows or count.
  const [pages, setPages] = useState<Partial<Record<LibraryKind, LibrarySnapshot>>>({})
  const pagesRef = useRef(pages)
  const publishPage = useCallback((category: LibraryKind, snapshot: LibrarySnapshot) => {
    const next = { ...pagesRef.current, [category]: snapshot }
    pagesRef.current = next; setPages(next)
  }, [])
  const scope = JSON.stringify([project, query, hideUnavailable])
  const snapshot = pages[kind]?.scope === scope ? pages[kind] : undefined
  const items = snapshot?.page?.items ?? NO_ITEMS, next = snapshot?.page?.next ?? null
  const total = snapshot?.page?.total ?? 0, ready = snapshot?.page != null
  const loading = snapshot?.loading ?? true, error = snapshot?.error ?? false
  const [dirty, setDirty] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<LibraryItem | null>(null)
  const [pendingClear, setPendingClear] = useState<LibraryKind | null>(null)
  const [mutating, setMutating] = useState(false), mutation = useRef(false)
  const [recordsReset, setRecordsReset] = useState(0)
  const [selectedItem, setSelectedItem] = useState<LibrarySelection | null>(null)
  // Keep a closing panel's content/anchor fixed while a new pointer selection
  // waits: the next image's information must not flash during the old exit.
  const [informationItem, setInformationItem] = useState<LibrarySelection | null>(null)
  const [infoOpen, setInfoOpen] = useState(false)
  const infoId = useId(), infoRef = useRef<HTMLDivElement>(null)
  const infoTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cancelInfoDelay = useCallback(() => { if (infoTimer.current !== null) { clearTimeout(infoTimer.current); infoTimer.current = null } }, [])
  const generation = useRef(0), loadingMore = useRef(false)
  const back = useRef<HTMLButtonElement>(null)
  const cancelDelete = useRef<HTMLButtonElement>(null), deleteOrigin = useRef<HTMLElement | null>(null)
  const filterKey = JSON.stringify([kind, scope])
  const projectName = project === 'all' ? t('library.allProjects') : project === 'projectless' ? t('library.projectless') : basename(project.slice(2))
  useEffect(() => { cancelInfoDelay(); setSelectedItem(null); setInformationItem(null); setInfoOpen(false); return cancelInfoDelay }, [open, filterKey, revision, cancelInfoDelay])
  const selectItem = (item: LibraryItem, anchor: HTMLButtonElement, keyboard: boolean) => {
    cancelInfoDelay()
    const nextOpen = selectedItem?.item.id !== item.id || !infoOpen
    const viewport = anchor.closest('section')
    const selection = { item, anchor, keyboard, scrollTop: viewport?.scrollTop ?? 0, scrollLeft: viewport?.scrollLeft ?? 0 }
    setSelectedItem(selection)
    if (item.kind !== 'image' || keyboard) { if (nextOpen) setInformationItem(selection); setInfoOpen(nextOpen); return }
    // Paint selection immediately, but defer information until the native
    // double-click sequence has had time to cancel the single-click action.
    setInfoOpen(false)
    if (nextOpen) infoTimer.current = setTimeout(() => {
      infoTimer.current = null
      if (anchor.isConnected) { setInformationItem(selection); setInfoOpen(true) }
    }, IMAGE_INFO_DELAY)
  }
  const cancelImageInfo = () => { cancelInfoDelay(); setInfoOpen(false) }
  useEffect(() => {
    if (!infoOpen || !selectedItem?.keyboard) return
    const frame = requestAnimationFrame(() => infoRef.current?.focus({ preventScroll: true }))
    return () => cancelAnimationFrame(frame)
  }, [infoOpen, selectedItem])
  useEffect(() => {
    if (!open || !selectedItem || pendingDelete || pendingClear) return
    const close = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing || document.querySelector('[aria-modal="true"]')) return
      event.preventDefault(); event.stopPropagation()
      selectedItem?.anchor.focus({ preventScroll: true })
      cancelInfoDelay()
      setInfoOpen(false); setSelectedItem(null)
    }
    window.addEventListener('keydown', close, true)
    return () => window.removeEventListener('keydown', close, true)
  }, [open, pendingDelete, pendingClear, selectedItem, cancelInfoDelay])
  useEffect(() => { const timer = setTimeout(() => setQuery(search), 200); return () => clearTimeout(timer) }, [search])
  useEffect(() => {
    if (!open) return
    setVisited(true)
    const previous = document.activeElement as HTMLElement | null
    back.current?.focus({ preventScroll: true })
    return () => { if (previous?.isConnected) previous.focus({ preventScroll: true }) }
  }, [open, visited])
  useEffect(() => {
    if (!open) return
    return window.pi.onLibraryChanged(() => setDirty(true))
  }, [open])
  useEffect(() => {
    if (!open) return
    const request = ++generation.current
    const cached = pagesRef.current[kind]
    const pending: LibrarySnapshot = { scope, page: cached?.scope === scope ? cached.page : null, loading: true, error: false }
    publishPage(kind, pending); setDirty(false)
    void window.pi.libraryPage({ kind, ...(project !== 'all' ? { project: project === 'projectless' ? null : project.slice(2) } : {}), query, hideUnavailable })
      .then(result => {
        if (request !== generation.current) return
        publishPage(kind, { ...pending, page: result.ok ? result.value : pending.page, loading: false, error: !result.ok })
      }).catch(() => { if (request === generation.current) publishPage(kind, { ...pending, loading: false, error: true }) })
    return () => { generation.current++; loadingMore.current = false }
  }, [open, kind, scope, revision, publishPage])
  // A first background import can finish after an initially empty page.
  useEffect(() => { if (open && dirty && !items.length && !loading && !error) setRevision(value => value + 1) }, [open, dirty, items.length, loading, error])

  const loadMore = useCallback(async () => {
    const current = pagesRef.current[kind]
    if (!open || current?.scope !== scope || !current.page?.next || loadingMore.current || current.loading) return
    const page = current.page, before = current.page.next
    loadingMore.current = true
    publishPage(kind, { ...current, loading: true })
    const request = generation.current
    try {
      const result = await window.pi.libraryPage({ kind, ...(project !== 'all' ? { project: project === 'projectless' ? null : project.slice(2) } : {}), query, hideUnavailable, before })
      if (request !== generation.current) return
      if (result.ok) {
        const incoming = result.value.items.filter(item => !page.items.some(existing => existing.id === item.id))
        publishPage(kind, { ...current, page: { ...result.value, items: [...page.items, ...incoming] }, loading: false, error: false })
      } else publishPage(kind, { ...current, loading: false, error: true })
    } catch { if (request === generation.current) publishPage(kind, { ...current, loading: false, error: true }) }
    finally { if (request === generation.current) loadingMore.current = false }
  }, [open, kind, scope, publishPage])
  const loadPreviewPage = useCallback(async () => {
    await loadMore()
    const page = pagesRef.current.image
    return previewImages(page?.scope === scope ? page.page?.items ?? NO_ITEMS : NO_ITEMS, t)
  }, [loadMore, scope, t])
  const imagePreview = useImagePreviewCollection(kind === 'image' && open ? previewImages(items, t) : [], {
    scope: filterKey, loadMore: kind === 'image' && open && next ? loadPreviewPage : undefined
  })
  const retry = () => { if (items.length && next) void loadMore(); else setRevision(value => value + 1) }

  const preview = async (item: LibraryItem) => {
    cancelInfoDelay()
    if (item.kind !== 'web') { setInfoOpen(false); selectedItem?.anchor.focus({ preventScroll: true }) }
    const result = await window.pi.libraryFile(item.id).catch(() => null)
    if (!result?.ok) { toast.error({ title: t('library.actionError') }); return }
    imagePreview({ id: item.id, src: mediaUrl(result.value), label: itemName(item, t), path: result.value })
  }
  const save = async (item: LibraryItem) => {
    const name = itemName(item, t)
    const filename = item.kind === 'web' ? name.replace(/[<>:"|?*]/g, '_') + '.json'
      : item.imageLabel && !item.originalPath ? name.replace(/[<>:"/\\|?*]/g, '_') + '-' + item.id.slice(0, 8) + (item.name.match(/\.[a-z0-9]+$/i)?.[0] ?? '.png') : item.name
    const result = await window.pi.librarySaveCopy(item.id, filename).catch(() => null)
    if (!result || result.status === 'error') toast.error({ title: t('library.actionError') })
  }
  const confirmRemoval = async () => {
    if (mutation.current || (!pendingDelete && !pendingClear)) return
    mutation.current = true; setMutating(true)
    try {
      const result = pendingClear ? await window.pi.libraryClear(pendingClear) : await window.pi.libraryDelete(pendingDelete!.id)
      if (!result.ok) { toast.error({ title: t('library.actionError') }); return }
      if (pendingClear || selectedItem?.item.id === pendingDelete?.id) { cancelInfoDelay(); setInfoOpen(false); setSelectedItem(null) }
      if ((pendingClear && pendingClear !== 'image') || (pendingDelete && pendingDelete.kind !== 'image')) setRecordsReset(value => value + 1)
      setRevision(value => value + 1)
      mutation.current = false; closeDelete()
    } catch { toast.error({ title: t('library.actionError') }) }
    finally { mutation.current = false; setMutating(false) }
  }
  const closeDelete = () => {
    if (mutation.current) return
    setPendingDelete(null); setPendingClear(null)
    const origin = deleteOrigin.current
    requestAnimationFrame(() => { if (origin?.isConnected && !origin.matches(':disabled')) origin.focus({ preventScroll: true }); else back.current?.focus({ preventScroll: true }) })
  }
  const clearLabel = t('library.clearTitle', { kind: t(pendingClear === 'image' ? 'library.images' : pendingClear === 'web' ? 'library.web' : 'library.files') })
  const empty = emptyKeys[kind], EmptyIcon = empty.icon
  const emptyState = <div data-library-empty={kind} className="grid h-full min-h-64 place-content-center gap-2 p-6 text-center"><EmptyIcon aria-hidden className="mx-auto size-8 text-muted-foreground" /><p className="text-sm font-medium">{t(empty.title)}</p><p className="max-w-md text-xs leading-ui text-muted-foreground">{t(empty.hint)}</p></div>

  if (!visited && !open) return null
  return (
    <div hidden={!open} style={{ display: open ? undefined : 'none' }} data-library-page data-shortcut-layer={open ? '' : undefined} className="window-page absolute inset-0 z-40 flex flex-col"
      onKeyDown={event => { if (event.key === 'Escape' && !document.querySelector('[role="dialog"]')) { event.stopPropagation(); onBack() } }}
      onPointerDown={event => {
        if (pendingDelete || !(event.target instanceof Element) || event.target.closest('[data-library-kind="image"], [data-library-kind="file"], [data-library-info]')) return
        cancelInfoDelay()
        setSelectedItem(null); setInfoOpen(false)
      }}
      onScrollCapture={event => {
        const viewport = selectedItem?.anchor.closest('section')
        // A click/focus can follow an automatic scroll into view while its
        // scroll event is still queued. Dismiss only for a subsequent movement.
        if (viewport && viewport === event.target && !pendingDelete && !pendingClear &&
          (viewport.scrollTop !== selectedItem!.scrollTop || viewport.scrollLeft !== selectedItem!.scrollLeft)) {
          cancelInfoDelay(); setSelectedItem(null); setInfoOpen(false)
        }
      }}>
      <WindowTitlebar className="gap-1.5 border-b border-border/50">
        <Button ref={back} variant="ghost" size="icon" aria-label={t('library.back')} onClick={onBack}><ArrowLeft className="size-4" /></Button>
        <h1 className="px-1 text-sm font-semibold text-foreground">{t('library.title')}</h1>
        <div className="flex flex-1 justify-end gap-1">
          <Tooltip content={t('library.settings')}><Button variant="ghost" size="icon" aria-label={t('library.settings')} onClick={onSettings}><Settings2 className="size-4" /></Button></Tooltip>
        </div>
      </WindowTitlebar>
      <div className="flex min-h-0 flex-1 flex-col gap-4 p-5">
        <div data-library-filters className="flex min-w-0 items-center gap-3">
          <Tabs value={kind} onValueChange={value => setKind(value as LibraryKind)} variant="underline" className="shrink-0">
            <TabsList className="h-9">
              <TabsTrigger value="image" className="h-9 min-h-0 gap-1.5 whitespace-nowrap leading-ui"><ImageIcon aria-hidden className="size-4 shrink-0" /><span>{t('library.images')}</span></TabsTrigger>
              <TabsTrigger value="file" className="h-9 min-h-0 gap-1.5 whitespace-nowrap leading-ui"><FileText aria-hidden className="size-4 shrink-0" /><span>{t('library.files')}</span></TabsTrigger>
              <TabsTrigger value="web" className="h-9 min-h-0 gap-1.5 whitespace-nowrap leading-ui"><Globe aria-hidden className="size-4 shrink-0" /><span>{t('library.web')}</span></TabsTrigger>
            </TabsList>
          </Tabs>
          <Select value={project} onValueChange={setProject} className="min-w-0 max-w-[45%] shrink">
            <SelectTrigger aria-label={t('library.projectFilter')} className="h-9 w-auto max-w-full text-sm"><span className="min-w-0 truncate whitespace-nowrap">{projectName}</span></SelectTrigger>
            <SelectContent portal portalWidth={320}><SelectItem value="all">{t('library.allProjects')}</SelectItem><SelectItem value="projectless">{t('library.projectless')}</SelectItem>
              {status?.projects.filter(entry => entry.path !== null).map(entry => <SelectItem key={entry.path} value={'p:' + entry.path} className="overflow-hidden whitespace-nowrap">{basename(entry.path!) + ' · ' + entry.count}</SelectItem>)}
            </SelectContent>
          </Select>
          <Input value={search} onChange={setSearch} leftIcon={<Search className="size-4" />} aria-label={t('library.search')} placeholder={t('library.search')} className="min-w-20 flex-1"  />
          <Button variant="ghost" size="sm" className="shrink-0" onClick={() => setRevision(value => value + 1)} disabled={loading}><RefreshCw className="size-4" />{t(dirty ? 'library.updates' : 'library.refresh')}</Button>
          <Button variant="ghost" size="sm" className="shrink-0 text-destructive hover:text-destructive" disabled={mutating || !status?.total}
            aria-label={t('library.clearTitle', { kind: t(kind === 'image' ? 'library.images' : kind === 'file' ? 'library.files' : 'library.web') })}
            onClick={event => { deleteOrigin.current = event.currentTarget; cancelInfoDelay(); setPendingClear(kind) }}><Trash2 className="size-4" />{t('library.clear')}</Button>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-1 text-xs text-muted-foreground" aria-live="polite">
          <span className={ready ? undefined : 'invisible'}>{t('library.count', { count: total })}</span>
          {status ? <span>{t('library.usage', { used: formatBytes(status.usedBytes), max: formatBytes(status.preferences.maxBytes) })}</span> : null}
          {status?.scanning ? <span>{t('library.scanning')}</span> : null}
          {status && !status.preferences.enabled ? <span>{t('library.paused')}</span> : null}
          {!hideUnavailable && status?.unsaved ? <span className="text-amber-600 dark:text-amber-400">{t('library.unsaved', { count: status.unsaved })}</span> : null}
          {statusError || status?.scanErrors ? <span className="text-destructive">{t('library.incomplete')}</span> : null}
          <Checkbox mark="square" label={t('library.hideUnavailable')} aria-label={t('library.hideUnavailable')} checked={hideUnavailable} className="ml-auto shrink-0 whitespace-nowrap [&>span]:text-xs" onCheckedChange={value => {
            setHideUnavailable(value)
            try { localStorage.setItem(HIDE_UNAVAILABLE_KEY, String(value)) } catch { /* View state remains usable without storage. */ }
          }} />
        </div>
        {!ready && !error ? <LibraryLoadingState key={filterKey} /> : kind !== 'image' ? <LibraryFilesView key={[kind, scope, recordsReset].join(':')} kind={kind} items={items} active={open} confirmationOpen={!!pendingDelete || !!pendingClear} sourceLabel={source => t(sourceKeys[source])} onLoadMore={loadMore} hasMore={!!next} loading={loading}
          error={error ? t('library.loadError') : undefined} onRetry={retry} emptyState={emptyState}
          renderInfo={(item, close) => <LibraryItemDetails item={item} onClose={close} />}
          onSave={value => void save(value)} onSession={value => void onOpenSession(value.sessionPath).catch(() => toast.error({ title: t('library.actionError') }))}
          onDelete={value => { deleteOrigin.current = document.activeElement as HTMLElement | null; setPendingDelete(value) }} /> : <MorphPopover anchor={informationItem?.anchor} contentId={infoId} open={open && infoOpen && selectedItem?.item.kind === kind}
          onOpenChange={value => { if (!value && !pendingDelete && !pendingClear) { setSelectedItem(null); setInfoOpen(false) } }} className="flex min-h-0 flex-1 flex-col">
        <InfiniteMasonry key={filterKey} items={items} getItemKey={item => item.id}
          renderItem={(item, _index, columnWidth) => <LibraryCard item={item} columnWidth={columnWidth} selected={selectedItem?.item.id === item.id} infoOpen={infoOpen && selectedItem?.item.id === item.id} infoId={infoId}
            onInfo={selectItem} onCancelInfo={cancelImageInfo}
            onPreview={value => void preview(value)} onSave={value => void save(value)} onSession={value => void onOpenSession(value.sessionPath).catch(() => toast.error({ title: t('library.actionError') }))}
            onDelete={value => { deleteOrigin.current = document.activeElement as HTMLElement | null; setPendingDelete(value) }} />}
          onLoadMore={loadMore} hasMore={!!next} loading={loading} error={error ? t('library.loadError') : undefined}
          onRetry={retry}
          minColumnWidth={240} maxColumns={6} gap={LIBRARY_GALLERY_GAP} animateItems={false} estimateSize={() => 340}
          itemSize={imageCardSize}
          ariaLabel={t('library.title')} loadingLabel={t('library.loading')} errorLabel={t('library.loadError')} retryLabel={t('library.retry')}
          renderLoadingItem={null} emptyState={emptyState}
          className={'min-h-0 flex-1 border-0 bg-transparent p-1' + (kind === 'image' ? ' library-image-gallery' : '')} />
          <MorphPopoverContent side="right" align="center" inert={!!pendingDelete || !!pendingClear} className="max-h-[calc(100vh-2rem)] w-[min(22rem,calc(100vw-2rem))] overflow-y-auto">
            {informationItem ? <div ref={infoRef} tabIndex={-1} data-library-info data-library-info-item={informationItem.item.id} data-library-image-info={informationItem.item.kind === 'image' ? '' : undefined} data-library-file-info={informationItem.item.kind === 'file' ? '' : undefined} className="outline-none">
              <LibraryItemDetails item={informationItem.item} onClose={() => { setInfoOpen(false); informationItem.anchor.focus({ preventScroll: true }) }}
                actions={{ onPreview: value => void preview(value), onSave: value => void save(value),
                  onSession: value => { setInfoOpen(false); informationItem.anchor.focus({ preventScroll: true }); void onOpenSession(value.sessionPath).catch(() => toast.error({ title: t('library.actionError') })) },
                  onDelete: value => { deleteOrigin.current = document.activeElement as HTMLElement | null; setPendingDelete(value) } }} />
            </div> : null}
          </MorphPopoverContent>
        </MorphPopover>}
      </div>
      <CenterMorphModal open={pendingDelete !== null || pendingClear !== null} onOpenChange={value => { if (!value) closeDelete() }}>
        <CenterMorphModalContent ariaLabel={pendingClear ? clearLabel : t('library.remove')} showCloseButton={false} initialFocusRef={cancelDelete} className="max-w-sm p-5">
          <h2 className="text-base font-semibold text-foreground">{pendingClear ? clearLabel : t('library.remove')}</h2>
          <p className="mt-2 text-sm leading-ui text-muted-foreground">{pendingClear ? t('library.clearConfirm', { kind: t(pendingClear === 'image' ? 'library.images' : pendingClear === 'file' ? 'library.files' : 'library.web') }) : t('library.removeConfirm', { name: pendingDelete ? itemName(pendingDelete, t) : '' })}</p>
          <div className="mt-5 flex justify-end gap-2">
            <Button ref={cancelDelete} variant="outline" size="sm" disabled={mutating} onClick={closeDelete}>{t('common.cancel')}</Button>
            <Button variant="destructive" size="sm" disabled={mutating} onClick={() => void confirmRemoval()}>{t(pendingClear ? 'library.clear' : 'library.remove')}</Button>
          </div>
        </CenterMorphModalContent>
      </CenterMorphModal>
    </div>
  )
}
