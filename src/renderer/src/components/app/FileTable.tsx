import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Button } from '@/components/motion/button'
import { Tabs, TabsList, TabsTrigger } from '@/components/motion/tabs'
import { Tooltip } from '@/components/motion/tooltip'
import { FileText, LoaderCircle, ZoomIn, ZoomOut } from '@/lib/icons'
import { useI18n } from '@/i18n'
import { useDiffWindow } from '@/lib/hooks/use-diff-window'
import { useTablePreview, type TablePreview } from '@/lib/hooks/use-table-preview'
import { compactContentSize, useContentFontSize } from '@/lib/typography'
import { BASE_FONT_PX, BASE_ROW_PX, LOOKAHEAD_ROWS, ZOOM_STEPS, type TableFormat } from '../../../../shared/table'
import type { FileBrowserStore, FileTab } from '@/state/file-browser-store'

/**
 * The table preview: a windowed grid over rows the parse worker produced.
 *
 * Everything here is sized in `ch`/`em` and measured from the font, so zoom is
 * a font-size change and column widths never need a DOM measurement or a
 * per-row reflow. Only the visible rows exist as elements, and the sticky
 * header/gutter keep their own opaque background — a translucent overlay would
 * let the scrolled cells show through it.
 */

/** Every box is expressed in `ch` **of the row font** — the number gutter, one
 * side of cell padding and a rounding margin included, so a measured content
 * width can simply be added up. A `ch` follows the element's own font size and
 * weight, so the width-bearing cells must keep identical metrics in the header
 * and in the body: a `font-medium` row made every header column wider than its
 * body column, and the drift grew with each column. Cosmetic weight belongs on
 * the inner text span, never on the cell that carries the width. */
const GUTTER_CH = 5
const CELL_PAD_CH = 1.25
const CELL_SLACK_CH = 0.5
/** Rows (and cells) sampled to size columns: enough to be stable, bounded. */
const SAMPLE_ROWS = 200
const SAMPLE_CELLS = 20_000
const MIN_COLUMN_CH = 3
const MAX_COLUMN_CH = 60
/** Opaque stripe/header colors: a sticky cell must cover what is under it. */
const ROW_STRIPE = 'color-mix(in oklab, var(--color-muted) 45%, var(--color-background))'
const HEADER_FILL = 'color-mix(in oklab, var(--color-muted) 75%, var(--color-background))'

/** Widest cell per column in `ch`, using the same metric as the source pane
 * (tab → next 8-column stop, wide code point → 2ch). The result is the cell's
 * *content* width: `cellBox` adds the paddings, which is why a value that
 * exactly fills the column is not ellipsised any more. */
function columnWidths(rows: string[][], columns: number): number[] {
  const widths = new Array(Math.max(0, columns)).fill(MIN_COLUMN_CH)
  let budget = SAMPLE_CELLS
  for (let index = 0; index < rows.length && index < SAMPLE_ROWS && budget > 0; index++) {
    const row = rows[index]
    for (let column = 0; column < row.length && column < columns; column++) {
      const cell = row[column]
      if (!cell) continue
      let width = 0
      for (const character of cell) {
        const code = character.codePointAt(0)!
        width += code === 9 ? 8 - (width % 8) : code > 127 ? 2 : 1
        if (width > MAX_COLUMN_CH) break
      }
      if (width > widths[column]) widths[column] = width
      if (--budget <= 0) break
    }
  }
  return widths.map(width => Math.min(MAX_COLUMN_CH, Math.max(MIN_COLUMN_CH, width)))
}

/** A cell's border box for a measured content width (border-box, so the width
 * already contains the padding and the hairline border). */
function cellBox(contentCh: number): CSSProperties {
  return { width: `${contentCh + CELL_PAD_CH * 2 + CELL_SLACK_CH}ch`, paddingInline: `${CELL_PAD_CH}ch` }
}

function TableNotice({ children, loading = false }: { children: ReactNode; loading?: boolean }) {
  return <div role="status" className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-5 text-center text-xs leading-ui text-muted-foreground">
    {loading ? <LoaderCircle aria-hidden className="size-5 motion-safe:animate-spin" /> : <FileText aria-hidden className="size-5 text-muted-foreground/60" />}{children}
  </div>
}

export function FileTable({ tab, format, store, generation }: { tab: FileTab; format: TableFormat; store: FileBrowserStore; generation: number }) {
  const preview = useTablePreview(tab, format, generation, store)
  return <FileTableGrid tab={tab} store={store} preview={preview} />
}

export function FileTableGrid({ tab, store, preview }: { tab: FileTab; store: FileBrowserStore; preview: TablePreview }) {
  const { t } = useI18n()
  const { loadMore, selectSheet } = preview
  const [zoom, setZoom] = useState(1)
  const viewport = useRef<HTMLDivElement>(null)
  const fontSize = compactContentSize(useContentFontSize())
  const rowHeight = Math.round(BASE_ROW_PX * fontSize / BASE_FONT_PX * zoom)
  const header = preview.rows[0]
  const bodyCount = Math.max(0, preview.rows.length - 1)
  const ready = preview.status === 'ready'
  const { start, end, onScroll: measure } = useDiffWindow(viewport, bodyCount, ready, 800, rowHeight)
  // Column widths are measured once per file/sheet/column set, never per slice:
  // they must not jump while the file streams in.
  const measured = useRef<{ key: string; widths: number[] }>({ key: '', widths: [] })
  const measureKey = `${tab.path}|${preview.sheet ?? ''}|${preview.columns}|${preview.rows.length > 0 ? 1 : 0}`
  if (measureKey !== measured.current.key) measured.current = { key: measureKey, widths: columnWidths(preview.rows.slice(0, SAMPLE_ROWS), preview.columns) }
  const widths = measured.current.widths

  useLayoutEffect(() => {
    const saved = store.getScroll(tab.path, 'preview')
    if (!viewport.current) return
    viewport.current.scrollTop = saved?.top ?? 0
    viewport.current.scrollLeft = saved?.left ?? 0
  }, [tab.path, store])
  // A different worksheet is a different document: keep its own top-left.
  const firstSheet = useRef(true)
  useLayoutEffect(() => {
    if (firstSheet.current) { firstSheet.current = false; return }
    if (viewport.current) { viewport.current.scrollTop = 0; viewport.current.scrollLeft = 0 }
  }, [preview.sheet])

  useEffect(() => {
    if (!ready || preview.eof || preview.truncated || preview.busy) return
    if (end + LOOKAHEAD_ROWS >= bodyCount) loadMore()
  }, [ready, preview.eof, preview.truncated, preview.busy, end, bodyCount, loadMore])

  const onScroll = () => {
    measure()
    if (viewport.current) store.saveScroll(tab.path, 'preview', viewport.current.scrollTop, viewport.current.scrollLeft)
  }
  const step = (direction: number) => {
    const index = ZOOM_STEPS.findIndex(value => Math.abs(value - zoom) < 0.001)
    const next = Math.min(ZOOM_STEPS.length - 1, Math.max(0, (index < 0 ? ZOOM_STEPS.indexOf(1) : index) + direction))
    setZoom(ZOOM_STEPS[next])
  }
  const rowNumber = (index: number) => preview.rowNumbers?.[index + 1] ?? index + 2

  return <div data-file-table data-file-table-status={preview.status} className="flex min-h-0 flex-1 flex-col">
    {preview.status === 'loading' ? <TableNotice loading>{t('files.loading')}</TableNotice>
      : preview.status === 'error' ? <TableNotice>{t(`files.error.${preview.error ?? 'unreadable'}`)}</TableNotice>
        : preview.rows.length === 0 ? <TableNotice>{t('files.table.empty')}</TableNotice>
          : <>
            {/* Its own row above the grid: loaded shape on the left, zoom on the right. */}
            <div data-file-table-bar className="flex h-9 shrink-0 items-center gap-1 border-b border-border/40 px-2">
              <span data-file-table-count role="status" className="shrink-0 px-0.5 text-caption leading-ui-loose tabular-nums text-muted-foreground">{t('files.table.dimensions', { rows: bodyCount, columns: preview.columns })}</span>
              {preview.error && preview.status === 'ready' ? <span data-file-table-error role="status" className="min-w-0 max-w-56 truncate px-1 text-micro text-destructive">{t(`files.error.${preview.error}`)}</span> : null}
              <div className="ml-auto flex shrink-0 items-center gap-1">
                {preview.busy ? <LoaderCircle aria-hidden className="size-3.5 shrink-0 text-muted-foreground motion-safe:animate-spin" /> : null}
                <div data-file-table-zoom className="flex items-center gap-0.5">
                  <Tooltip content={t('files.table.zoomOut')}><Button variant="ghost" size="icon" className="size-7" aria-label={t('files.table.zoomOut')} disabled={zoom <= ZOOM_STEPS[0]} onClick={() => step(-1)}><ZoomOut aria-hidden className="size-3.5" /></Button></Tooltip>
                  <span data-file-table-scale className="select-none px-0.5 text-caption leading-ui-loose tabular-nums">{Math.round(zoom * 100)}%</span>
                  <Tooltip content={t('files.table.zoomIn')}><Button variant="ghost" size="icon" className="size-7" aria-label={t('files.table.zoomIn')} disabled={zoom >= ZOOM_STEPS[ZOOM_STEPS.length - 1]} onClick={() => step(1)}><ZoomIn aria-hidden className="size-3.5" /></Button></Tooltip>
                </div>
              </div>
            </div>
            <div
              ref={viewport}
              role="group"
              tabIndex={0}
              data-file-table-viewport
              aria-label={t('files.table.viewportAria')}
              onScroll={onScroll}
              className="min-h-0 flex-1 overflow-auto focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset"
              style={{ fontSize: `${fontSize * zoom}px`, overflowAnchor: 'none' }}
            >
              <div className="w-max min-w-full">
                <div data-table-header className="sticky top-0 z-20 flex w-max min-w-full border-b border-border text-muted-foreground" style={{ height: rowHeight, backgroundColor: HEADER_FILL }}>
                  <div aria-hidden className="sticky left-0 z-10 flex shrink-0 items-center justify-end border-r border-border" style={{ width: `${GUTTER_CH}ch`, paddingInline: `${CELL_PAD_CH}ch`, height: rowHeight, backgroundColor: HEADER_FILL }} />
                  {widths.map((width, column) => <div key={column} className="flex shrink-0 items-center overflow-hidden border-r border-border/40" style={cellBox(width)}>
                    <span className="truncate font-medium">{header?.[column] ?? ''}</span>
                  </div>)}
                </div>
                {start > 0 ? <div aria-hidden style={{ height: start * rowHeight }} /> : null}
                {Array.from({ length: Math.max(0, end - start) }, (_, offset) => {
                  const index = start + offset
                  const row = preview.rows[index + 1] ?? []
                  const fill = index % 2 === 1 ? ROW_STRIPE : 'var(--color-background)'
                  return <div key={index} data-table-row={index} className="flex w-max min-w-full" style={{ height: rowHeight, backgroundColor: fill }}>
                    <div aria-hidden className="sticky left-0 z-10 flex shrink-0 items-center justify-end border-r border-border" style={{ width: `${GUTTER_CH}ch`, paddingInline: `${CELL_PAD_CH}ch`, height: rowHeight, backgroundColor: fill }}>
                      <span className="truncate text-[0.85em] tabular-nums text-muted-foreground">{rowNumber(index)}</span>
                    </div>
                    {widths.map((width, column) => <div key={column} className="flex shrink-0 items-center overflow-hidden border-r border-border/20" style={cellBox(width)}>
                      <span className="truncate">{row[column] ?? ''}</span>
                    </div>)}
                  </div>
                })}
                {/* The spacers are what give the scrollbar the whole table's
                    range; without the trailing one the grid can never scroll
                    to rows it has not loaded yet. */}
                {end < bodyCount ? <div aria-hidden style={{ height: (bodyCount - end) * rowHeight }} /> : null}
              </div>
            </div>
            {preview.truncated ? <p role="status" className="shrink-0 border-t border-border/40 px-3 py-2 text-xs text-muted-foreground">{t('files.table.truncated', { rows: bodyCount })}</p> : null}
            {/* Worksheets are filed at the bottom, as tabs, and only when there
                is more than one: a dropdown here floated over the very rows it
                was switching between, and a single sheet needs no chooser. */}
            {preview.sheets.length > 1 ? <div data-file-table-sheets className="flex h-9 shrink-0 items-stretch overflow-x-auto overflow-y-hidden border-t border-border/40 px-2">
              <Tabs value={preview.sheet ?? ''} onValueChange={selectSheet} variant="underline" className="h-full w-max">
                <TabsList className="h-full gap-1 border-b-0 p-0">
                  {preview.sheets.map(sheet => <TabsTrigger
                    key={sheet.path}
                    value={sheet.path}
                    data-table-sheet={sheet.path}
                    className="mb-0 h-full min-h-0 items-center px-2.5 py-0 text-caption"
                    // The underline variant puts its indicator on the trigger's
                    // bottom edge; this strip is the pane's last row, so the
                    // indicator rides the divider above it instead.
                    indicatorClassName="top-0 bottom-auto"
                  >
                    <span className="max-w-40 truncate">{sheet.name}</span>
                  </TabsTrigger>)}
                </TabsList>
              </Tabs>
            </div> : null}
          </>}
  </div>
}
