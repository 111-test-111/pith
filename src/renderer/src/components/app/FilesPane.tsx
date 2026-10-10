import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react'
import type { DebugBreakpointDTO } from '../../../../shared/types'
import { AgentCode } from '@/components/agents/agent-code'
import { Button } from '@/components/motion/button'
import { Tabs, TabsList, TabsTrigger } from '@/components/motion/tabs'
import { Tooltip } from '@/components/motion/tooltip'
import { Check, Copy, Download, ExternalLink, FileText, FolderOpen, FolderTree, Globe, LoaderCircle, RefreshCw, Search, WrapText, type IconComponent } from '@/lib/icons'
import { basename, formatBytes } from '@/lib/format'
import { fileDirname, FileBaseDirectory, FileNavigationProvider } from '@/lib/file-navigation'
import { cn } from '@/lib/utils'
import { useI18n } from '@/i18n'
import { type FileBrowserStore, type FileTab, type FileView } from '@/state/file-browser-store'
import type { PiShellState, PiStore } from '@/state/pi-store'
import type { DebugStore } from '@/state/debug-store'
import type { FileDocumentDTO, FileGitDiffDTO } from '../../../../shared/types'
import { hasPreviewView, isInlineOnly, isMediaKind, previewKindOf, readsAsText, subtitleFormatOf, textReadLimit, type PreviewKind } from '../../../../shared/preview'
import { FileDiffPreview } from './FileDiffPreview'
import { FileFont } from './FileFont'
import { FileHtml } from './FileHtml'
import { FileMarkdown } from './FileMarkdown'
import { requestBrowserOpenLink } from '@/lib/browser/open-link'
import { FileNotebook } from './FileNotebook'
import { FileJson } from './FileJson'
import { FileStructured } from './FileStructured'
import { FileArchive } from './FileArchive'
import { FileData } from './FileData'
import { structuredFormatOf } from '../../../../shared/file-preview'
import { FileSubtitle } from './FileSubtitle'
import { useToast } from './ToastProvider'
import { FileMedia } from './FileMedia'
import { FilePdf } from './FilePdf'
import { FileTable } from './FileTable'
import { FileTree } from './FileTree'
import { FileSource } from './FileSource'
import { LabelTooltip } from './LabelTooltip'
import { ReviewDiffBody } from './ReviewDiff'
import { MiddleEllipsis } from './MiddleEllipsis'
import { PanelResizeHandle } from './PanelResizeHandle'
import { FileFindBar } from './FileFindBar'
import { useFileSearch } from '@/lib/hooks/use-file-search'
import type { FileSearchOptions, FileSearchResult } from '@/lib/file-search'
import { useDebugTargets } from '@/lib/hooks/use-debug-targets'
import { useWheelScroll } from '@/lib/hooks/use-wheel-scroll'

function ToolButton({ label, icon: Icon, onClick, active, disabled }: { label: string; icon: IconComponent; onClick: () => void; active?: boolean; disabled?: boolean }) {
  return <Tooltip content={label}><Button variant="ghost" size="icon" className={cn('size-7 shrink-0', active && 'bg-muted text-primary')} aria-label={label} aria-pressed={active} disabled={disabled} onClick={onClick}><Icon aria-hidden className="size-3.5" /></Button></Tooltip>
}

function Notice({ children, loading = false }: { children: ReactNode; loading?: boolean }) {
  return <div role="status" className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-5 text-center text-xs leading-ui text-muted-foreground">
    {loading ? <LoaderCircle aria-hidden className="size-5 motion-safe:animate-spin" /> : <FileText aria-hidden className="size-5 text-muted-foreground/60" />}{children}
  </div>
}

function FileContent({ tab, kind, document, store, search, refresh, wrap, debugBreakpoints, onToggleBreakpoint }: { tab: FileTab; kind: PreviewKind; document: FileDocumentDTO; store: FileBrowserStore; search?: { result: FileSearchResult; current: number }; refresh: number; wrap: boolean; debugBreakpoints?: DebugBreakpointDTO[]; onToggleBreakpoint?: (line: number) => void }) {
  const { t } = useI18n()
  const scroll = useRef<HTMLDivElement>(null)
  const [diff, setDiff] = useState<FileGitDiffDTO | null>(() => store.cache.gitDiff(tab) ?? null)
  const [diffRoot, setDiffRoot] = useState<HTMLDivElement | null>(null)
  // Child layout effects run before this scrollport's ref attaches. Publishing
  // the root remeasures virtual rows before paint, after restoring its scroll.
  const attachDiffRoot = useCallback((root: HTMLDivElement | null) => { scroll.current = root; setDiffRoot(root) }, [])
  const view = tab.view === 'diff' && !document.gitRoot ? 'source' : tab.view
  const hasDiffBody = !!diff?.patch && !diff.error && !diff.binary
  useEffect(() => {
    if (view !== 'diff') return
    let cancelled = false
    // Revalidate in the background without replacing a warm diff with a loader.
    // The store cache also supplies the first frame after a rail/pane remount.
    void store.cache.readGitDiff(tab).then(value => { if (!cancelled) setDiff(value) })
    return () => { cancelled = true }
  }, [tab.path, tab.cwd, tab.visit, view, refresh, document.gitRoot, store])
  useLayoutEffect(() => {
    if (!scroll.current) return
    const saved = store.getScroll(tab.path, view)
    scroll.current.scrollTop = saved?.top ?? 0
    scroll.current.scrollLeft = saved?.left ?? 0
  }, [tab.path, view, store, hasDiffBody])
  const onScroll = () => { if (scroll.current) store.saveScroll(tab.path, view, scroll.current.scrollTop, scroll.current.scrollLeft) }
  if (view === 'diff') {
    if (!diff) return <Notice loading>{t('files.loading')}</Notice>
    if (diff.error) return <Notice>{t(`files.error.${diff.error}`)}</Notice>
    if (diff.binary) return <Notice>{t('files.error.binary')}</Notice>
    if (!diff.patch) return <Notice>{t('files.noChanges')}</Notice>
    return <div ref={attachDiffRoot} data-file-diff onScroll={onScroll} className="min-h-0 flex-1 overflow-auto">
      {diff.patch.includes('@@') ? <ReviewDiffBody patch={diff.patch} displayPath={tab.path} scrollRootRef={scroll} layoutKey={diffRoot} /> : <AgentCode code={diff.patch} language="diff" className="p-3" />}
    </div>
  }
  if (document.error) return <Notice>{t(`files.error.${document.error}`)}</Notice>
  if (document.text === '') return <Notice>{t('files.emptyFile')}</Notice>
  if (view === 'preview') {
    // Each previewable family owns its body; only Markdown renders in the
    // document's own scroll container (see shared/preview.ts).
    if (kind === 'diff') return <FileDiffPreview text={document.text ?? ''} displayPath={tab.path} />
    if (kind === 'notebook') return <FileNotebook text={document.text ?? ''} truncated={document.truncated} tab={tab} store={store} />
    if (kind === 'json') return <FileJson text={document.text ?? ''} truncated={document.truncated} />
    if (kind === 'structured') return <FileStructured text={document.text ?? ''} format={structuredFormatOf(tab.path)!} truncated={document.truncated} />
    if (kind === 'subtitle') return <FileSubtitle text={document.text ?? ''} format={subtitleFormatOf(tab.path) ?? 'srt'} />
    return <div ref={scroll} data-file-markdown onScroll={onScroll} className="min-h-0 flex-1 overflow-auto p-5">
      <FileNavigationProvider cwd={tab.cwd} openFile={target => store.open(tab.cwd, target)}>
        <div className="pane-readable"><FileBaseDirectory.Provider value={fileDirname(tab.path)}><FileMarkdown text={document.text ?? ''} /></FileBaseDirectory.Provider></div>
      </FileNavigationProvider>
    </div>
  }
  return <FileSource key={tab.path} text={document.text ?? ''} tab={tab} store={store} search={search} wrap={wrap} debugBreakpoints={debugBreakpoints} onToggleBreakpoint={onToggleBreakpoint} />
}

/** Breakpoint data and the toggle action for the gutter, while a debug
 * session is live; undefined for both means a read-only gutter. */
function useDebugGutter(debug: DebugStore, shell: PiShellState, file: string | undefined): {
  debugBreakpoints?: DebugBreakpointDTO[]
  onToggleBreakpoint?: (line: number) => void
} {
  const { session: selected, revision } = useDebugTargets(debug, shell)
  const sessionPath = selected?.sessionPath
  const debugId = selected?.id
  const live = selected?.kind !== 'core' && (selected?.status === 'running' || selected?.status === 'stopped')
  useEffect(() => {
    if (sessionPath && live && debugId) void debug.refreshBreakpoints(sessionPath, debugId)
  }, [sessionPath, live, debugId, debug, revision])
  if (!sessionPath || !live || !file || !debugId) return {}
  return {
    debugBreakpoints: debug.breakpointsFor(debugId, file),
    onToggleBreakpoint: (line) => {
      void window.pi.debugAction({ sessionPath, debugId, action: 'breakpoint-toggle', file, line })
        .then(() => debug.refreshBreakpoints(sessionPath, debugId))
        .catch(() => {})
    }
  }
}

export function FilesPane({ files, store, filePath, debug }: { files: FileBrowserStore; store: PiStore; filePath: string | null; debug: DebugStore }) {
  const shell = useSyncExternalStore(store.subscribe, store.getShell)
  const gutter = useDebugGutter(debug, shell, filePath ?? undefined)
  return <FilePreviewPane files={files} filePath={filePath} cwd={shell.cwd ?? ''} projectless={shell.projectless} streaming={shell.isStreaming} {...gutter} />
}

/** The same read-only engines and controls can live beside the Library list
 * without mounting the conversation or acquiring its debug/session state. */
export function FilePreviewPane({ files, filePath, cwd: fallbackCwd = '', projectless = false, streaming = false, displayName, toolbarActions, saveCopyAction, debugBreakpoints, onToggleBreakpoint }: {
  files: FileBrowserStore
  filePath: string | null
  cwd?: string
  projectless?: boolean
  streaming?: boolean
  displayName?: string
  toolbarActions?: ReactNode
  saveCopyAction?: { label: string; onClick: () => void }
  debugBreakpoints?: DebugBreakpointDTO[]
  onToggleBreakpoint?: (line: number) => void
}) {
  const { t } = useI18n()
  const state = useSyncExternalStore(files.subscribe, files.getSnapshot)
  const currentTab = state.tabs.find(item => item.path === filePath)
  const lastTab = useRef<FileTab | undefined>(currentTab)
  if (currentTab) lastTab.current = currentTab
  // Closing removes store metadata before the rail's exit animation finishes.
  // Keep its last file frame until unmount, instead of mounting a fresh chooser
  // (and new tree animations) inside an already-exiting presence boundary.
  const tab = currentTab ?? (lastTab.current?.path === filePath ? lastTab.current : undefined)
  const treeOpen = tab?.treeOpen ?? state.treeOpen
  const cwd = tab?.cwd ?? fallbackCwd
  const root = tab && tab.path !== cwd && !tab.path.startsWith(cwd.replace(/\/$/, '') + '/') ? fileDirname(tab.path) : cwd
  // One routing table decides what this path is, and therefore which reader and
  // which body own it (see shared/preview.ts). The old per-family predicates —
  // mediaKindOf / isPdfPath / tableFormatOf / isUnsupportedMedia — are composed
  // inside it, so a new previewable type is one branch there and nothing here.
  const kind: PreviewKind = tab ? previewKindOf(displayName ?? tab.path) : 'text'
  const mediaKind = isMediaKind(kind) ? kind : null
  const table = kind === 'table' ? 'delimited' as const : kind === 'spreadsheet' ? 'xlsx' as const : null
  const spreadsheet = kind === 'spreadsheet'
  // A medium, a PDF, a spreadsheet and a font take the pane whole: no
  // source/preview/diff tabs, and never a document read (a 2 GiB video would
  // come back as its first 512 KiB of "binary").
  const inlineOnly = !!tab && isInlineOnly(kind)
  const [document, setDocument] = useState<{ key: string; value: FileDocumentDTO } | null>(() => {
    const value = tab ? files.cache.document(tab) : undefined
    return value && tab ? { key: `${tab.cwd}\0${tab.path}\0${tab.encoding ?? 'auto'}`, value } : null
  })
  const [refresh, setRefresh] = useState(0)
  const [find, setFind] = useState(false)
  const [query, setQuery] = useState('')
  const [matchIndex, setMatchIndex] = useState(0)
  const [findOptions, setFindOptions] = useState<FileSearchOptions>({ matchCase: false, wholeWord: false, regex: false })
  const [copied, setCopied] = useState(false)
  const toast = useToast()
  // One action error at a time: retrying replaces the previous failure instead
  // of stacking stale ones, which is what the inline notice used to do by
  // clearing on every new attempt.
  const actionError = useRef<string | null>(null)
  const clearActionError = () => {
    if (actionError.current) {
      toast.dismiss(actionError.current)
      actionError.current = null
    }
  }
  const reportActionError = () => {
    clearActionError()
    actionError.current = toast.error({ title: t('files.actionError') })
  }
  const findRef = useRef<HTMLInputElement>(null)
  const findButton = useRef<HTMLDivElement>(null)
  const body = useRef<HTMLDivElement>(null), tree = useRef<HTMLDivElement>(null)
  useWheelScroll(body, tab?.path)
  const treeDrag = useRef({ start: 0, width: 0, maximum: 480 })
  const startTreeResize = () => {
    const width = tree.current?.getBoundingClientRect().width ?? 0
    treeDrag.current = { start: width, width, maximum: Math.max(96, Math.min(480, (body.current?.clientWidth ?? 0) - 140)) }
  }
  const resizeTree = (delta: number) => {
    const width = Math.max(96, Math.min(treeDrag.current.maximum, treeDrag.current.start + delta))
    treeDrag.current.width = width
    // Write only to the tree column: no inherited style invalidation across
    // preview DOM, React render, transition, unmount or IO during pointer moves.
    tree.current?.style.setProperty('--file-tree-width', `${width}px`)
  }
  const endTreeResize = () => files.setTreeWidth(treeDrag.current.width)
  const refreshFiles = () => { files.cache.invalidateTree(root); setRefresh(value => value + 1) }
  useEffect(() => {
    const focus = () => { files.cache.invalidateTree(root); setRefresh(value => value + 1) }
    window.addEventListener('focus', focus)
    return () => window.removeEventListener('focus', focus)
  }, [files, root])
  const wasStreaming = useRef(streaming)
  useEffect(() => {
    if (wasStreaming.current && !streaming) { files.cache.invalidateTree(root); setRefresh(value => value + 1) }
    wasStreaming.current = streaming
  }, [streaming, files, root])
  useEffect(() => {
    setMatchIndex(0)
    // Only a text-family path is read; the main process enforces the same rule.
    if (!tab || !readsAsText(kind)) { setDocument(null); return }
    let cancelled = false
    const key = `${tab.cwd}\0${tab.path}\0${tab.encoding ?? 'auto'}`
    void files.cache.readDocument(tab).then(value => { if (!cancelled) setDocument({ key, value }) })
    return () => { cancelled = true }
  }, [tab?.path, tab?.cwd, tab?.visit, tab?.encoding, refresh, files])
  useEffect(() => { if (!copied) return; const timer = setTimeout(() => setCopied(false), 1600); return () => clearTimeout(timer) }, [copied])
  useEffect(() => { setQuery(''); setFind(false); setCopied(false) }, [tab?.path])
  const ready = document?.key === `${tab?.cwd}\0${tab?.path}\0${tab?.encoding ?? 'auto'}` ? document.value : tab ? files.cache.document(tab) ?? null : null
  const { result: searchResult, searching } = useFileSearch(ready?.text ?? '', query, findOptions, find)
  const matches = searchResult.matches
  const selectedMatch = matches.length ? matchIndex % matches.length : 0
  const moveMatch = (direction: number) => { if (matches.length) setMatchIndex((selectedMatch + direction + matches.length) % matches.length) }
  const showFind = () => {
    if (!tab) return
    files.setView(tab.path, 'source')
    const selection = window.getSelection()
    const selectedText = selection?.toString()
    if (selectedText && selectedText.length <= 500 && !selectedText.includes('\n') && selection?.anchorNode?.parentElement?.closest('[data-file-source]')) { setQuery(selectedText); setMatchIndex(0) }
    setFind(true)
    requestAnimationFrame(() => { findRef.current?.focus({ preventScroll: true }); findRef.current?.select() })
  }
  const closeFind = () => { setFind(false); setQuery(''); findButton.current?.querySelector('button')?.focus({ preventScroll: true }) }
  const copy = async () => {
    clearActionError()
    try { await navigator.clipboard.writeText(ready?.text ?? ''); setCopied(true) } catch { reportActionError() }
  }
  // openPath resolves with the OS error message ('' on success); the other two
  // report only whether the action failed, never prose from the main process.
  const openDefault = async () => {
    if (!tab) return
    clearActionError()
    try { if (await window.pi.openPath(tab.path)) reportActionError() } catch { reportActionError() }
  }
  const openInBrowser = async () => {
    if (!tab) return
    clearActionError()
    try {
      const preview = await window.pi.htmlPreview({ cwd: tab.cwd, path: tab.path })
      if (preview.url) requestBrowserOpenLink(preview.url)
      else reportActionError()
    } catch { reportActionError() }
  }
  const showInFolder = () => { if (tab) void window.pi.showInFolder(tab.path) }
  const saveCopy = async () => {
    if (!tab) return
    clearActionError()
    try {
      const { status } = await window.pi.saveFileCopy(tab.path)
      // A cancelled dialog is a normal outcome, not a failure to report.
      if (status === 'error') reportActionError()
      else if (status === 'ok') toast.success({ title: t('files.savedCopy', { name: basename(tab.path) }) })
    } catch { reportActionError() }
  }
  const view = spreadsheet ? 'preview' : tab?.view === 'diff' && !ready?.gitRoot ? 'source' : tab?.view ?? 'source'
  // The relative path normally comes from the document; a media tab has none.
  const base = cwd.replace(/\/$/, '')
  const shownPath = ready?.relativePath ?? (tab ? (tab.path === base ? basename(tab.path) : tab.path.startsWith(base + '/') ? tab.path.slice(base.length + 1) : tab.path) : '')
  const pathParts = shownPath.replaceAll('\\', '/').split('/').filter(Boolean)
  return <div data-files-pane className="flex h-full min-w-0 flex-col bg-background" onKeyDown={event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f' && tab) { event.preventDefault(); event.stopPropagation(); showFind() }
    if (event.key === 'Escape' && find) { event.preventDefault(); event.stopPropagation(); closeFind() }
  }}>
    <div data-file-toolbar className="flex h-11 shrink-0 items-center gap-1 border-b border-border/40 px-2">
      <ToolButton label={t(treeOpen ? 'files.hideTree' : 'files.showTree')} icon={FolderTree} active={treeOpen} onClick={() => files.toggleTree(tab?.path)} />
      <LabelTooltip content={tab?.path ?? (projectless ? t('files.workspace') : root)} wrap wrapperClassName="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1 overflow-hidden whitespace-nowrap px-1 text-xs" data-file-breadcrumb>
          {tab ? displayName ? <MiddleEllipsis name={displayName} className="font-medium" /> : <><span className="min-w-0 truncate text-muted-foreground">{pathParts.slice(0, -1).join(' / ')}</span>{pathParts.length > 1 ? <span className="text-muted-foreground/40">/</span> : null}<MiddleEllipsis name={basename(tab.path)} className="shrink-[0.3] font-medium" /></> : <span className="truncate text-muted-foreground">{projectless ? t('files.workspace') : basename(root)}</span>}
        </div>
      </LabelTooltip>
      <ToolButton label={t('files.refresh')} icon={RefreshCw} onClick={refreshFiles} />
      {tab ? <>
        {kind === 'html' ? <ToolButton label={t('files.html.openBrowser')} icon={Globe} onClick={() => void openInBrowser()} /> : null}
        <ToolButton label={t('files.openDefault')} icon={ExternalLink} onClick={() => void openDefault()} />
        <ToolButton label={t('files.showInFolder')} icon={FolderOpen} onClick={showInFolder} />
        <ToolButton label={saveCopyAction?.label ?? t('files.saveAs')} icon={Download} onClick={saveCopyAction?.onClick ?? (() => void saveCopy())} />
      </> : null}
      {toolbarActions}
    </div>
    <div ref={body} className="flex min-h-0 flex-1">
      {treeOpen && root ? <><div ref={tree} className="flex min-w-0 shrink-0 flex-col border-r border-border/30" style={{ '--file-tree-width': state.treeWidth === undefined ? 'min(36%, 208px)' : `${state.treeWidth}px`, width: 'clamp(96px, var(--file-tree-width), max(96px, min(480px, calc(100% - 140px))))' } as CSSProperties} data-file-tree-column>
        <FileTree root={root} projectless={projectless && root === fallbackCwd} expanded={state.expanded} selected={tab?.path ?? null} store={files} refresh={refresh} />
      </div><PanelResizeHandle grow="right" label={t('files.resizeTree')} className="-mx-[3px] block focus-visible:bg-primary/20" value={state.treeWidth} onStep={delta => { startTreeResize(); resizeTree(delta); endTreeResize() }} onResizeStart={startTreeResize} onResize={resizeTree} onResizeEnd={endTreeResize} onActiveChange={active => tree.current?.style.setProperty('border-right-color', active ? 'var(--color-primary)' : '')} /></> : null}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-file-preview>
        {tab ? <>
          {inlineOnly || spreadsheet ? null : <div data-file-view-tabs className="flex min-h-10 shrink-0 flex-wrap items-center gap-1 border-b border-border/40 px-2 py-1">
            <Tabs value={view} variant="underline" onValueChange={value => { files.setView(tab.path, value as FileView); setFind(false); setQuery('') }} className="min-w-0">
              <TabsList className="h-7 gap-1 border-b-0 p-0">
                <TabsTrigger value="source" className="min-h-0 px-2 py-1 text-caption">{t('files.source')}</TabsTrigger>
                {hasPreviewView(kind) ? <TabsTrigger value="preview" className="min-h-0 px-2 py-1 text-caption">{t('files.preview')}</TabsTrigger> : null}
                {ready?.gitRoot ? <TabsTrigger value="diff" className="min-h-0 px-2 py-1 text-caption">{t('files.diff')}</TabsTrigger> : null}
              </TabsList>
            </Tabs>
            <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-0.5">
              <div ref={findButton}><ToolButton label={t('files.find')} icon={Search} active={find} disabled={!ready?.text} onClick={showFind} /></div>
              <ToolButton label={t('files.wrap')} icon={WrapText} active={state.wrapLines} disabled={view !== 'source'} onClick={() => files.setWrapLines(!state.wrapLines)} />
              <ToolButton label={t(copied ? 'files.copied' : 'files.copy')} icon={copied ? Check : Copy} disabled={ready?.text === undefined} onClick={() => void copy()} />
            </div>
          </div>}
          {!inlineOnly && !spreadsheet && find ? <FileFindBar inputRef={findRef} query={query} options={findOptions} result={searchResult} current={selectedMatch} searching={searching} onQuery={value => { setQuery(value); setMatchIndex(0) }} onOptions={value => { setFindOptions(value); setMatchIndex(0) }} onMove={moveMatch} onClose={closeFind} /> : null}
          {kind === 'archive' ? <FileArchive key={tab.path} tab={tab} store={files} generation={refresh} /> : kind === 'data' ? <FileData key={tab.path} tab={tab} store={files} generation={refresh} /> : mediaKind ? <FileMedia tab={tab} kind={mediaKind} refresh={refresh} /> : kind === 'pdf' ? <FilePdf key={tab.path} tab={tab} onOpenFile={target => files.open(tab.cwd, { path: target })} /> : kind === 'font' ? <FileFont key={`${tab.path}:${refresh}`} tab={tab} /> : kind === 'unplayable' ? <Notice>{t('files.media.unsupported')}</Notice> : kind === 'html' && view === 'preview' ? <FileHtml key={tab.path} tab={tab} refresh={refresh} onFind={showFind} /> : table && view === 'preview' ? <FileTable key={tab.path} tab={tab} format={table} store={files} generation={refresh} /> : ready ? <FileContent key={tab.path} tab={tab} kind={kind} document={ready} store={files} search={find ? { result: searchResult, current: selectedMatch } : undefined} refresh={refresh} wrap={state.wrapLines} debugBreakpoints={debugBreakpoints} onToggleBreakpoint={onToggleBreakpoint} /> : <Notice loading>{t('files.loading')}</Notice>}
          {/* A table's preview is not the truncated source text, so the source
              notice belongs to the source view only. */}
          {ready?.truncated && !((table || kind === 'html') && view === 'preview') ? <p role="status" className="shrink-0 border-t border-border/40 px-3 py-2 text-xs text-muted-foreground">{t('files.truncated', { size: formatBytes(textReadLimit(kind)) })}</p> : null}
          {view === 'diff' && ready?.gitRoot ? <p className="shrink-0 border-t border-border/40 px-3 py-1.5 text-micro text-muted-foreground">{t('files.diffBase')}</p> : null}
        </> : <Notice>{t('files.chooseFile')}</Notice>}
      </div>
    </div>
  </div>
}
