import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import { Button } from '@/components/motion/button'
import { Input } from '@/components/motion/input'
import { Tooltip } from '@/components/motion/tooltip'
import { ChevronLeft, ChevronRight, FileText, LoaderCircle, Maximize2, Minimize2, ZoomIn, ZoomOut, type IconComponent } from '@/lib/icons'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import { opensInFilePane } from '../../../../shared/preview'
import type { FileTab } from '@/state/file-browser-store'
import type { PdfStatDTO } from '../../../../shared/types'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import type { PDFViewer as PdfViewer } from 'pdfjs-dist/web/pdf_viewer.mjs'

/**
 * PDF preview. pdf.js does the work — parsing in its own worker, laying pages
 * out, building the text layer — and it is loaded lazily, so a session that
 * never opens a PDF never pays for it. The bytes come from the main process one
 * range at a time (`files:pdfRange`); see `shared/pdf.ts` for the exclusive-end
 * contract those ranges have to honour.
 *
 * Everything the user sees around the pages (prev/next, zoom, fit) is a beUI
 * control on theme tokens; page and scale are read-only labels. pdf.js only
 * owns the page containers.
 */

/** pdf.js' own chunk size, and the first read we hand it eagerly. */
const CHUNK_BYTES = 65536
const ZOOM_MIN = 0.25
const ZOOM_MAX = 8
const ZOOM_STEP = 1.25

type PdfStatus = 'loading' | 'password' | 'ready' | 'error'

interface PdfRuntime {
  viewer: PdfViewer
  doc: PDFDocumentProxy
}

function ToolButton({ label, icon: Icon, onClick, disabled }: { label: string; icon: IconComponent; onClick: () => void; disabled?: boolean }) {
  return <Tooltip content={label}><Button variant="ghost" size="icon" className="size-7 shrink-0" aria-label={label} disabled={disabled} onClick={onClick}><Icon aria-hidden className="size-3.5" /></Button></Tooltip>
}

function PdfNotice({ children, loading = false }: { children: ReactNode; loading?: boolean }) {
  return <div role="status" className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background/90 p-6 text-center text-xs leading-ui text-muted-foreground">
    {loading ? <LoaderCircle aria-hidden className="size-5 motion-safe:animate-spin" /> : <FileText aria-hidden className="size-5 text-muted-foreground/60" />}{children}
  </div>
}

export function FilePdf({ tab, onOpenFile }: { tab: FileTab; /** Opens a linked workspace file in the app instead of leaving it. */ onOpenFile?: (path: string) => void }) {
  const { t } = useI18n()
  const scrollerRef = useRef<HTMLDivElement>(null)
  const viewerRef = useRef<HTMLDivElement>(null)
  const runtimeRef = useRef<PdfRuntime | null>(null)
  const passwordRef = useRef<((password: string) => void) | null>(null)
  const [status, setStatus] = useState<PdfStatus>('loading')
  const [pages, setPages] = useState(0)
  const [page, setPage] = useState(1)
  const [scale, setScale] = useState(1)
  const [password, setPassword] = useState('')
  const [wrongPassword, setWrongPassword] = useState(false)
  /** Why the viewer gave up; surfaced on the root for diagnostics. */
  const [failure, setFailure] = useState('')
  const [fileError, setFileError] = useState<PdfStatDTO['error']>()

  useEffect(() => {
    const scroller = scrollerRef.current
    const viewerEl = viewerRef.current
    if (!scroller || !viewerEl) return
    let disposed = false
    let teardown: (() => void) | null = null
    const request = { cwd: tab.cwd, path: tab.path }
    setStatus('loading')
    setFailure('')
    setFileError(undefined)
    setPassword('')
    setWrongPassword(false)
    setPages(0)
    setPage(1)
    setScale(1)

    void (async () => {
      try {
        // `build/pdf.mjs` publishes the API on `globalThis.pdfjsLib` and
        // `web/pdf_viewer.mjs` destructures that global at module scope, so the
        // two have to load in order — importing them concurrently is a race.
        const pdfjs = await import('pdfjs-dist')
        ;(globalThis as { pdfjsLib?: unknown }).pdfjsLib ??= pdfjs
        // The stylesheet rides along in the same lazy chunk as the viewer.
        const [viewerModule, worker] = await Promise.all([
          import('pdfjs-dist/web/pdf_viewer.mjs'),
          import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
          import('./pdf-viewer.css')
        ])
        if (disposed) return
        pdfjs.GlobalWorkerOptions.workerSrc = worker.default

        const stat = await window.pi.pdfStat(request)
        if (disposed) return
        if (stat.error || !stat.size) {
          setFileError(stat.error)
          setFailure(stat.error ?? 'empty')
          setStatus('error')
          return
        }
        const initial = new Uint8Array(await window.pi.pdfRange(request, 0, Math.min(CHUNK_BYTES, stat.size)))
        if (disposed) return

        // pdf.js asks for byte ranges; its own reader sends `bytes=begin-(end-1)`,
        // so the end is EXCLUSIVE and the worker checks every answer against its
        // chunk grid. Hand back exactly [begin, end) or the whole load breaks.
        class RangeTransport extends pdfjs.PDFDataRangeTransport {
          constructor() { super(stat.size, initial, false) }
          requestDataRange(begin: number, end: number) {
            window.pi.pdfRange(request, begin, end)
              .then(data => this.onDataRange(begin, new Uint8Array(data)))
              // The type declares `abort()`, but the runtime forwards the reason
              // so a failed read surfaces as a load error instead of a stall.
              .catch(error => (this.abort as (reason?: unknown) => void)(error))
          }
        }
        // `disableAutoFetch` keeps pdf.js from pulling the rest of the document in
        // the background: a preview reads the pages that are actually shown, so
        // opening a 500 MB scan does not read 500 MB.
        const loadingTask = pdfjs.getDocument({ range: new RangeTransport(), rangeChunkSize: CHUNK_BYTES, disableAutoFetch: true })
        loadingTask.onPassword = (updatePassword: (password: string) => void, reason: number) => {
          if (disposed) return
          passwordRef.current = updatePassword
          setWrongPassword(reason === pdfjs.PasswordResponses.INCORRECT_PASSWORD)
          setStatus('password')
        }
        const doc = await loadingTask.promise
        if (disposed) { void loadingTask.destroy(); return }

        const eventBus = new viewerModule.EventBus()
        const linkService = new viewerModule.PDFLinkService({ eventBus })
        // A link to the outside world must leave the app: the window-open handler
        // routes it to the system browser instead of replacing our UI.
        linkService.externalLinkTarget = viewerModule.LinkTarget.BLANK
        const viewer = new viewerModule.PDFViewer({
          container: scroller,
          viewer: viewerEl,
          eventBus,
          linkService,
          // Links and annotation appearance render; form fields stay read-only.
          annotationMode: pdfjs.AnnotationMode.ENABLE,
          textLayerMode: 1
        })
        // An in-document link (a table of contents entry, a cross-reference) only
        // navigates once the link service holds both the viewer and the document.
        linkService.setViewer(viewer)
        teardown = () => {
          // `setDocument(null)` is the documented teardown; the type only admits a
          // document.
          try { viewer.setDocument(null as unknown as PDFDocumentProxy) } catch { /* already gone */ }
          try { viewer.cleanup() } catch { /* already gone */ }
        }
        // The scale can only be applied once the viewer has built its first page:
        // setting it right after setDocument is silently dropped, which leaves
        // every page at zero height and nothing ever renders.
        eventBus.on('pagesinit', () => { viewer.currentScaleValue = 'page-width' })
        eventBus.on('pagechanging', (event: { pageNumber: number }) => setPage(event.pageNumber))
        eventBus.on('scalechanging', (event: { scale: number }) => setScale(event.scale))
        viewer.setDocument(doc)
        linkService.setDocument(doc, null)
        runtimeRef.current = { viewer, doc }
        setPages(doc.numPages)
        setStatus('ready')
      } catch (error) {
        if (!disposed) { setFailure(String(error)); setStatus('error') }
      }
    })()

    return () => {
      disposed = true
      passwordRef.current = null
      const runtime = runtimeRef.current
      runtimeRef.current = null
      teardown?.()
      if (runtime) void runtime.doc.destroy().catch(() => { /* already destroyed */ })
    }
  }, [tab.cwd, tab.path])

  const zoom = useCallback((factor: number) => {
    const viewer = runtimeRef.current?.viewer
    if (!viewer) return
    viewer.currentScale = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, viewer.currentScale * factor))
  }, [])

  const fit = useCallback((value: 'page-width' | 'page-fit') => {
    const viewer = runtimeRef.current?.viewer
    if (viewer) viewer.currentScaleValue = value
  }, [])

  const turn = useCallback((delta: number) => {
    const viewer = runtimeRef.current?.viewer
    if (!viewer) return
    viewer.currentPageNumber = Math.min(Math.max(1, viewer.currentPageNumber + delta), viewer.pagesCount)
  }, [])

  const goTo = useCallback((target: number) => {
    const viewer = runtimeRef.current?.viewer
    if (!viewer || !Number.isFinite(target)) return
    viewer.currentPageNumber = Math.min(Math.max(Math.round(target), 1), viewer.pagesCount)
  }, [])

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const modifier = event.metaKey || event.ctrlKey
    if (modifier && (event.key === '=' || event.key === '+')) { event.preventDefault(); zoom(ZOOM_STEP); return }
    if (modifier && event.key === '-') { event.preventDefault(); zoom(1 / ZOOM_STEP); return }
    if (modifier && event.key === '0') { event.preventDefault(); fit('page-width'); return }
    if (modifier) return
    if (event.key === 'Home') { event.preventDefault(); goTo(1); return }
    if (event.key === 'End') { event.preventDefault(); goTo(pages); return }
  }

  /**
   * pdf.js renders link annotations as real anchors, and a click on one used to
   * navigate the whole window — a linked PDF replaced the app until a restart.
   * Every link is handled here instead: a file the app can preview opens in its
   * own pane, anything else goes to the system browser. Nothing navigates.
   */
  const onLinkClick = (event: MouseEvent<HTMLDivElement>) => {
    const anchor = (event.target as HTMLElement | null)?.closest('a')
    const href = anchor?.getAttribute('href')
    // An in-document destination stays with pdf.js: it scrolls the viewer there.
    if (!href || href.startsWith('#')) return
    event.preventDefault()
    const base = `file://${tab.path.startsWith('/') ? '' : '/'}${tab.path.replaceAll('\\', '/')}`
    let target: URL
    try { target = new URL(href, base) } catch { void window.pi.openExternal(href); return }
    if (target.protocol !== 'file:') { void window.pi.openExternal(href); return }
    // `file:///C:/…` carries a leading slash a Windows path cannot use.
    const path = decodeURIComponent(target.pathname).replace(/^\/([a-zA-Z]:\/)/, '$1')
    if (onOpenFile && opensInFilePane(path)) onOpenFile(path)
    else void window.pi.openPath(path)
  }

  const submitPassword = (event: { preventDefault: () => void }) => {    event.preventDefault()
    if (!password) return
    const update = passwordRef.current
    passwordRef.current = null
    setStatus('loading')
    update?.(password)
  }

  return <div data-file-pdf data-pdf-error={failure || undefined} className="flex min-h-0 flex-1 flex-col">
    <div data-file-pdf-toolbar className="flex min-h-10 shrink-0 flex-wrap items-center gap-1 border-b border-border/40 px-2 py-1">
      <div className="flex items-center gap-0.5">
        <ToolButton label={t('files.pdf.previousPage')} icon={ChevronLeft} disabled={status !== 'ready' || page <= 1} onClick={() => turn(-1)} />
        <span aria-label={t('files.pdf.page')} className="select-none px-0.5 text-caption leading-ui-loose tabular-nums"><span data-pdf-page>{page}</span><span className="text-muted-foreground"> / {pages || '—'}</span></span>
        <ToolButton label={t('files.pdf.nextPage')} icon={ChevronRight} disabled={status !== 'ready' || (pages > 0 && page >= pages)} onClick={() => turn(1)} />
      </div>
      <div className="ml-auto flex items-center gap-0.5">
        <ToolButton label={t('imagePreview.zoomOut')} icon={ZoomOut} disabled={status !== 'ready' || scale <= ZOOM_MIN + 0.001} onClick={() => zoom(1 / ZOOM_STEP)} />
        <span data-pdf-scale className="select-none px-0.5 text-caption leading-ui-loose tabular-nums">{Math.round(scale * 100)}%</span>
        <ToolButton label={t('imagePreview.zoomIn')} icon={ZoomIn} disabled={status !== 'ready' || scale >= ZOOM_MAX - 0.001} onClick={() => zoom(ZOOM_STEP)} />
        <span aria-hidden className="mx-1 h-5 w-px shrink-0 bg-border" />
        <ToolButton label={t('files.pdf.fitWidth')} icon={Maximize2} disabled={status !== 'ready'} onClick={() => fit('page-width')} />
        <ToolButton label={t('files.pdf.fitPage')} icon={Minimize2} disabled={status !== 'ready'} onClick={() => fit('page-fit')} />
      </div>
    </div>
    <div className="relative min-h-0 flex-1 bg-muted/30">
      {/* pdf.js owns this scroller: its container must be absolutely positioned
          and the page host must carry the `pdfViewer` class. */}
      <div ref={scrollerRef} data-pdf-scroller tabIndex={0} aria-label={t('files.pdf.viewerAria')} onKeyDown={onKeyDown} onClickCapture={onLinkClick} className={cn('absolute inset-0 overflow-auto outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset')}>
        <div ref={viewerRef} className="pdfViewer" />
      </div>
      {status === 'loading' ? <PdfNotice loading>{t('files.loading')}</PdfNotice> : null}
      {status === 'error' ? <PdfNotice>{t(fileError === 'missing' ? 'files.error.missing' : fileError === 'unreadable' ? 'files.error.unreadable' : 'files.pdf.failed')}</PdfNotice> : null}
      {status === 'password' ? <div className="absolute inset-0 flex items-center justify-center bg-background/90 p-6">
        <form onSubmit={submitPassword} className="flex w-full max-w-xs flex-col gap-3 rounded-card border border-border bg-background p-4 shadow-overlay">
          <p className="text-xs leading-ui text-muted-foreground">{t('files.pdf.passwordPrompt')}</p>
          <Input type="password" value={password} onChange={setPassword} aria-label={t('files.pdf.password')} autoComplete="off" error={wrongPassword}  />
          <Button size="sm" type="submit" disabled={!password}>{t('files.pdf.passwordSubmit')}</Button>
        </form>
      </div> : null}
    </div>
  </div>
}
