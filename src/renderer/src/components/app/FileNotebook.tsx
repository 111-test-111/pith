import { useMemo } from 'react'
import { AgentCode } from '@/components/agents/agent-code'
import { fileDirname, FileBaseDirectory, FileNavigationProvider } from '@/lib/file-navigation'
import { codeLanguage } from '@/lib/file-language'
import { Markdown } from '@/lib/markdown'
import { useI18n } from '@/i18n'
import type { FileBrowserStore, FileTab } from '@/state/file-browser-store'
import { ImagePreviewGroup, PreviewThumb } from './ImagePreview'

/**
 * Preview for a Jupyter notebook (`.ipynb`): the cells it is made of, rendered
 * with the app's own Markdown and code components — so a notebook reads like
 * the transcript does, and nothing new has to be highlighted or themed.
 *
 * The document is the notebook's JSON. `files:document` reads it whole (the
 * notebook's own cap in `shared/preview.ts`) because the outputs are inline —
 * a plotted chart is a base64 PNG in the same object — and a truncated file
 * cannot be parsed at all. The parse and the cell walk are bounded, so what the
 * pane holds is proportional to the cells on screen, not to the file.
 */

/** Cells rendered. Beyond this the notebook is a document to open elsewhere. */
const MAX_CELLS = 300
/** Characters one text output keeps. */
const MAX_OUTPUT_CHARS = 20_000
/** Base64 characters one inline image may carry (~4 MB of bytes). */
const MAX_IMAGE_CHARS = 4 * 1024 * 1024
/** Code longer than this is not worth highlighting as a preview. */
const MAX_HIGHLIGHT_CHARS = 20_000

interface NotebookOutput {
  output_type?: string
  name?: string
  text?: string | string[]
  data?: Record<string, unknown>
  ename?: string
  evalue?: string
  traceback?: string[]
}

interface NotebookCell {
  cell_type?: string
  source?: string | string[]
  execution_count?: number | null
  outputs?: NotebookOutput[]
}

interface Notebook {
  cells: NotebookCell[]
  language: string
}

export function parseNotebook(text: string): Notebook | null {
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { return null }
  if (!parsed || typeof parsed !== 'object') return null
  const cells = (parsed as { cells?: unknown }).cells
  if (!Array.isArray(cells)) return null
  const metadata = (parsed as { metadata?: { kernelspec?: { language?: unknown }, language_info?: { name?: unknown } } }).metadata
  const language = metadata?.kernelspec?.language ?? metadata?.language_info?.name
  return { cells: cells.slice(0, MAX_CELLS) as NotebookCell[], language: typeof language === 'string' ? language : 'python' }
}

/** `source` is a list of lines in the format, a single string in files that
 * were written by hand. */
function join(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value.join('')
  return typeof value === 'string' ? value : ''
}

function bound(value: string): string {
  return value.length > MAX_OUTPUT_CHARS ? `${value.slice(0, MAX_OUTPUT_CHARS)}\n…` : value
}

/** An inline image output as a `data:` URL — the base64 is already in the JSON,
 * so no blob has to be created or revoked. */
function inlineImage(mime: string, value: unknown): string | null {
  const data = Array.isArray(value) ? value.join('') : value
  if (typeof data !== 'string' || !data || data.length > MAX_IMAGE_CHARS) return null
  return `data:${mime};base64,${data}`
}

function OutputView({ output }: { output: NotebookOutput }) {
  // A stream is stdout/stderr text, and an error is its traceback: both are
  // plain text, and only the error is worth colouring.
  if (output.output_type === 'stream' || output.output_type === 'error') {
    const text = output.output_type === 'error'
      ? (output.traceback?.length ? output.traceback.join('\n') : `${output.ename ?? ''}: ${output.evalue ?? ''}`)
      : join(output.text)
    if (!text) return null
    return <pre data-notebook-output={output.output_type} className={output.output_type === 'error'
      ? 'm-0 overflow-x-auto whitespace-pre-wrap break-words rounded-detail border border-destructive/30 bg-destructive/5 px-3 py-2 font-mono text-code text-destructive'
      : 'm-0 overflow-x-auto whitespace-pre-wrap break-words rounded-detail bg-muted/40 px-3 py-2 font-mono text-code text-muted-foreground'}>{bound(text)}</pre>
  }
  const data = output.data ?? {}
  const images = Object.entries(data)
    .filter(([mime]) => mime.startsWith('image/'))
    .map(([mime, value]) => inlineImage(mime, value))
    .filter((src): src is string => src !== null)
  const text = join(data['text/plain'] as string | string[] | undefined)
  if (!images.length && !text) return null
  return <>
    {/* The outputs column is a stretch flex, which would pull the thumbnail
        button to full width and paint its hover veil over empty space — pin
        it to its own width so the lift covers only the picture. */}
    {images.map((src, index) => <PreviewThumb key={index} src={src} alt="" className="self-start rounded-detail" imageClassName="max-h-80 max-w-full object-contain" />)}
    {text ? <pre data-notebook-output="text" className="m-0 overflow-x-auto whitespace-pre-wrap break-words rounded-detail bg-muted/40 px-3 py-2 font-mono text-code text-muted-foreground">{bound(text)}</pre> : null}
  </>
}

function CellView({ cell, language, index, tab, store }: { cell: NotebookCell; language: string; index: number; tab: FileTab; store: FileBrowserStore }) {
  const source = join(cell.source)
  if (cell.cell_type === 'markdown') return <div data-notebook-cell={index} data-notebook-markdown className="px-1">
    <FileNavigationProvider cwd={tab.cwd} openFile={target => store.open(tab.cwd, target)}>
      <FileBaseDirectory.Provider value={fileDirname(tab.path)}><Markdown>{source}</Markdown></FileBaseDirectory.Provider>
    </FileNavigationProvider>
  </div>
  return <div data-notebook-cell={index} className="flex flex-col gap-2">
    <div className="flex items-center gap-2 text-micro text-muted-foreground/70">
      <span aria-hidden className="select-none font-mono tabular-nums">{cell.execution_count == null ? '[ ]' : `[${cell.execution_count}]`}</span>
      <span className="truncate opacity-70">{language}</span>
    </div>
    {source ? <div data-notebook-code className="overflow-x-auto rounded-detail border border-border/60 bg-muted/20"><AgentCode code={source} language={codeLanguage(language)} highlight={source.length <= MAX_HIGHLIGHT_CHARS} className="p-3" /></div> : null}
    {cell.cell_type === 'code' && cell.outputs?.length
      ? <ImagePreviewGroup><div data-notebook-outputs className="flex flex-col gap-2">{cell.outputs.map((output, position) => <OutputView key={position} output={output} />)}</div></ImagePreviewGroup>
      : null}
  </div>
}

export function FileNotebook({ text, truncated, tab, store }: { text: string; truncated: boolean; tab: FileTab; store: FileBrowserStore }) {
  const { t } = useI18n()
  const notebook = useMemo(() => parseNotebook(text), [text])
  // A truncated notebook is a JSON document cut mid-object: `JSON.parse` cannot
  // read it, so the honest answer is "this one is too large to render here"
  // rather than a parse error the user cannot act on.
  if (!notebook) return <div role="status" data-file-notebook-invalid className="flex min-h-0 flex-1 items-center justify-center p-5 text-center text-xs leading-ui text-muted-foreground">{t(truncated ? 'files.notebook.tooLarge' : 'files.notebook.invalid')}</div>
  if (notebook.cells.length === 0) return <div role="status" className="flex min-h-0 flex-1 items-center justify-center p-5 text-center text-xs leading-ui text-muted-foreground">{t('files.notebook.empty')}</div>
  return <div data-file-notebook data-notebook-cells={notebook.cells.length} className="min-h-0 flex-1 overflow-auto">
    <div className="mx-auto flex max-w-4xl flex-col gap-5 px-5 py-5">
      {notebook.cells.map((cell, index) => <CellView key={index} cell={cell} language={notebook.language} index={index} tab={tab} store={store} />)}
    </div>
    {truncated || notebook.cells.length >= MAX_CELLS ? <p role="status" className="px-5 pb-4 text-center text-xs text-muted-foreground">{t('files.notebook.truncated', { count: notebook.cells.length })}</p> : null}
  </div>
}
