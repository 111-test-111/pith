import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Button } from '@/components/motion/button'
import { Input } from '@/components/motion/input'
import { Tabs, TabsList, TabsTrigger } from '@/components/motion/tabs'
import { ArrowLeft, Search } from '@/lib/icons'
import { useI18n } from '@/i18n'
import { formatBytes } from '@/lib/format'
import { useBinaryPreview } from '@/lib/hooks/use-binary-preview'
import { archiveTree, type ArchiveTreeNode } from '@/lib/archive-tree'
import { structuredFormatOf, type ArchiveContent, type ArchiveEntry, type ArchiveIndex } from '../../../../shared/file-preview'
import { fileExtension } from '../../../../shared/extension'
import { previewKindOf, readsAsText } from '../../../../shared/preview'
import type { FileBrowserStore, FileTab } from '@/state/file-browser-store'
import { FileTypeIcon } from './FileTypeIcon'
import { FilePreviewNotice } from './FilePreviewNotice'
import { FileJson } from './FileJson'
import { FileStructured } from './FileStructured'
import { FileSource } from './FileSource'
import { PreviewThumb } from './ImagePreview'
import { MiddleEllipsis } from './MiddleEllipsis'
import { FileTreeView, FileTreeFile, FileTreeFolder } from './FileTreeView'

function ArchiveBody({ tab, store, generation, index, entry }: { tab: FileTab; store: FileBrowserStore; generation: number; index: ArchiveIndex; entry: ArchiveEntry }) {
  const { t } = useI18n()
  const content = useBinaryPreview<ArchiveContent>(tab, store, generation, { type: 'archive-entry', revision: index.revision, entry: entry.id, encoding: tab.encoding })
  const [image, setImage] = useState<{ bytes: Uint8Array; url: string } | null>(null)
  const [failed, setFailed] = useState(false)
  const [view, setView] = useState('preview')
  const data = content.value?.image
  useEffect(() => {
    setFailed(false)
    if (!data) { setImage(null); return }
    const url = URL.createObjectURL(new Blob([new Uint8Array(data.data)], { type: data.mimeType }))
    const probe = new Image()
    let cancelled = false
    probe.onload = () => { if (!cancelled) setImage({ bytes: data.data, url }) }
    probe.onerror = () => { if (!cancelled) setFailed(true) }
    probe.src = url
    return () => { cancelled = true; probe.onload = null; probe.onerror = null; probe.src = ''; URL.revokeObjectURL(url) }
  }, [data])
  if (!content.value) return <FilePreviewNotice error={content.error} loading={!content.error} />
  if (content.value.binary && !readsAsText(previewKindOf(entry.name))) return <FilePreviewNotice error="unsupported" />
  if (failed) return <FilePreviewNotice error="invalid" />
  if (data) return image?.bytes === data.data ? <div data-file-archive-image className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-5"><PreviewThumb src={image.url} alt={entry.name} className="rounded-item" imageClassName="max-h-full max-w-full object-contain" /></div> : <FilePreviewNotice loading />
  const text = content.value.text ?? ''
  const format = structuredFormatOf(entry.name)
  const json = fileExtension(entry.name) === '.json'
  return <div data-file-archive-content className="flex min-h-0 flex-1 flex-col">
    <div className="flex min-h-9 shrink-0 flex-wrap items-center justify-between gap-1 border-b border-border/40 px-2 py-1">
      {format || json ? <Tabs value={view} onValueChange={setView} variant="underline"><TabsList className="h-7 gap-1 border-b-0 p-0"><TabsTrigger value="source" className="min-h-0 px-2 py-1 text-caption">{t('files.source')}</TabsTrigger><TabsTrigger value="preview" className="min-h-0 px-2 py-1 text-caption">{t('files.preview')}</TabsTrigger></TabsList></Tabs> : <span className="px-1 text-caption text-muted-foreground">{t('files.source')}</span>}
    </div>
    {content.value.binary ? <FilePreviewNotice error="unsupported" /> : view === 'preview' && format ? <FileStructured text={text} format={format} truncated={content.value.truncated} /> : view === 'preview' && json ? <FileJson text={text} truncated={content.value.truncated} /> : <FileSource text={text} tab={{ ...tab, path: `${tab.path}\0${entry.id}/${entry.name}`, line: undefined }} store={store} wrap />}
    {content.value.truncated ? <p role="status" className="shrink-0 border-t border-border/40 px-3 py-2 text-xs text-muted-foreground">{t('files.archive.contentLimited')}</p> : null}
  </div>
}

function ArchiveTree({ tab, store, index, restoreFocus, onFocusRestored }: { tab: FileTab; store: FileBrowserStore; index: ArchiveIndex; restoreFocus: boolean; onFocusRestored: () => void }) {
  const { t } = useI18n()
  const query = tab.previewState?.archiveQuery ?? ''
  const tree = useMemo(() => archiveTree(index.entries, query), [index.entries, query])
  const expanded = query ? tree.expanded.filter(id => !tab.previewState?.archiveSearchCollapsed?.includes(id)) : tab.previewState?.archiveExpanded ?? []
  const [viewport, setViewport] = useState<HTMLDivElement | null>(null)
  const scrollPath = `${tab.path}\0archive-tree`
  const initialOffset = useRef(store.getScroll(scrollPath, 'preview')?.top ?? 0)
  const virtualize = useMemo(() => ({ scrollElement: viewport, rowHeight: 32, initialOffset: initialOffset.current }), [viewport])
  const saveScroll = () => { if (viewport) store.saveScroll(scrollPath, 'preview', viewport.scrollTop, viewport.scrollLeft) }
  useLayoutEffect(() => {
    const saved = store.getScroll(scrollPath, 'preview')
    if (viewport) { viewport.scrollTop = saved?.top ?? 0; viewport.scrollLeft = saved?.left ?? 0 }
  }, [viewport, store, scrollPath])
  useLayoutEffect(() => {
    if (!viewport || !restoreFocus) return
    // Restore the keyboard anchor independently of selection, once the
    // virtualizer has mounted its rows, without moving the saved scroll.
    const frame = requestAnimationFrame(() => {
      viewport.querySelector<HTMLElement>('[role="treeitem"][tabindex="0"]')?.focus({ preventScroll: true })
      onFocusRestored()
    })
    return () => cancelAnimationFrame(frame)
  }, [viewport, restoreFocus, onFocusRestored])
  const children = useMemo(() => {
    const node = (item: ArchiveTreeNode): ReactNode => item.children ? <FileTreeFolder key={item.key} value={item.key} name={item.name} label={<MiddleEllipsis name={item.name} />}>
      {item.children.map(node)}
    </FileTreeFolder> : <FileTreeFile key={item.key} value={item.key} name={item.name} disabled={!item.entry?.readable}
      icon={<FileTypeIcon path={item.path} className="size-4" />}
      label={<MiddleEllipsis name={item.name} />} />
    return tree.roots.map(node)
  }, [tree])
  return <>
    <div className="shrink-0 px-3 py-2"><Input value={query} onChange={value => {
      store.saveScroll(scrollPath, 'preview', 0, 0)
      if (viewport) viewport.scrollTop = 0
      store.setPreviewState(tab.path, { archiveQuery: value, archiveSearchCollapsed: [], archiveFocused: undefined })
    }} placeholder={t('files.archive.search')} aria-label={t('files.archive.search')} leftIcon={<Search aria-hidden className="size-3.5" />} /></div>
    <div ref={setViewport} data-file-archive-list className="relative min-h-0 min-w-0 flex-1 overflow-auto p-1" style={{ overflowAnchor: 'none' }} onScroll={saveScroll}>
      {tree.roots.length ? <FileTreeView virtualize={virtualize} value={null} defaultValue={tab.previewState?.archiveFocused ?? null} expandedIds={expanded} ariaLabel={t('files.archive.tree')}
        onExpandedChange={next => store.setPreviewState(tab.path, query ? { archiveSearchCollapsed: tree.expanded.filter(id => !next.includes(id)) } : { archiveExpanded: next })}
        onValueChange={id => {
          saveScroll()
          const entry = index.entries.find(entry => entry.id === id)
          store.setPreviewState(tab.path, { archiveFocused: id, ...(entry?.readable && entry.kind === 'file' ? { archiveEntry: { id: entry.id, name: entry.name } } : {}) })
        }}>{children}</FileTreeView> : <p role="status" className="p-5 text-center text-xs text-muted-foreground">{t(query ? 'files.archive.noMatches' : 'files.archive.empty')}</p>}
    </div>
  </>
}

export function FileArchive({ tab, store, generation }: { tab: FileTab; store: FileBrowserStore; generation: number }) {
  const { t } = useI18n()
  const index = useBinaryPreview<ArchiveIndex>(tab, store, generation, { type: 'archive-index' })
  const selected = index.value?.entries.find(entry => entry.id === tab.previewState?.archiveEntry?.id && entry.name === tab.previewState?.archiveEntry?.name)
  const restoreFocus = useRef(false)
  if (!index.value) return <FilePreviewNotice error={index.error} loading={!index.error} />
  return <div data-file-archive={index.value.format} className="flex min-h-0 flex-1 flex-col">
    <div data-file-archive-toolbar className="flex h-9 shrink-0 items-center gap-2 border-b border-border/40 px-2">
      {selected ? <Button variant="ghost" size="icon" className="size-7 shrink-0" aria-label={t('files.archive.back')} onClick={() => { restoreFocus.current = true; store.setPreviewState(tab.path, { archiveEntry: undefined }) }}><ArrowLeft aria-hidden className="size-3.5" /></Button> : null}
      <span data-file-archive-location className="min-w-0 flex-1 truncate text-caption text-muted-foreground">{selected?.name ?? t('files.archive.entries', { count: index.value.entries.length })}</span>
      {selected ? <span className="shrink-0 text-caption tabular-nums text-muted-foreground">{formatBytes(selected.size)}</span> : null}
    </div>
    {index.error ? <p role="status" className="shrink-0 px-3 py-1 text-xs text-destructive">{t(`files.previewError.${index.error}`)}</p> : null}
    {selected ? <ArchiveBody key={selected.id} tab={tab} store={store} generation={generation} index={index.value} entry={selected} /> : <ArchiveTree tab={tab} store={store} index={index.value} restoreFocus={restoreFocus.current} onFocusRestored={() => { restoreFocus.current = false }} />}
    {index.value.truncated ? <p role="status" className="shrink-0 border-t border-border/40 px-3 py-2 text-xs text-muted-foreground">{t('files.archive.limited', { count: index.value.entries.length })}</p> : null}
  </div>
}
