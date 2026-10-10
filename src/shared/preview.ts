/**
 * The single routing table for the file pane: what a path *is*, and therefore
 * which reader and which view own it.
 *
 * Every "how is this file previewed" decision goes through `previewKindOf`.
 * The families themselves stay with the code that has to honour them —
 * `media.ts` owns the MIME types the `pith-media` scheme serves, `table.ts` the
 * byte caps and formats, `pdf.ts` the exclusive-end range contract — and this
 * module only composes them into one answer, so adding a previewable type is
 * one branch here instead of five call sites that can drift apart.
 *
 * Two consequences are load-bearing:
 *
 *  - `readsAsText` is the *only* gate on `files:document`. A medium, a PDF, a
 *    spreadsheet or a font read as a 512 KiB text document would come back as
 *    "binary" (or, worse, as the first 512 KiB of a 2 GiB video), so the main
 *    process asks this table rather than trusting the renderer to have skipped
 *    the read.
 *  - `PreviewKind` includes the media kinds, so a caller that needs the media
 *    element's own kind narrows with `isMediaKind` instead of re-deriving it.
 */

import { fileExtension } from './extension'
import { isUnsupportedMedia, mediaKindOf, type MediaKind } from './media'
import { isPdfPath } from './pdf'
import { tableFormatOf } from './table'
import { archiveFormatOf, dataFormatOf, structuredFormatOf } from './file-preview'

export type PreviewKind =
  | MediaKind
  | 'text'
  | 'markdown'
  | 'html'
  | 'table'
  | 'spreadsheet'
  | 'pdf'
  /** A recognized medium this engine cannot decode (HEIC, AVI, …). */
  | 'unplayable'
  | 'diff'
  | 'notebook'
  | 'json'
  | 'subtitle'
  | 'font'
  | 'archive'
  | 'data'
  | 'structured'

const MARKDOWN = new Set(['.md', '.markdown', '.mdown', '.mkd', '.mdx'])
const HTML = new Set(['.html', '.htm'])
const DIFF = new Set(['.diff', '.patch'])
const NOTEBOOK = new Set(['.ipynb'])
/** Strict JSON keeps its existing tree; other grammars own a parse worker. */
const JSON_DOCUMENT = new Set(['.json'])
export type SubtitleFormat = 'srt' | 'vtt' | 'lrc'
const SUBTITLE: Readonly<Record<string, SubtitleFormat>> = { '.srt': 'srt', '.vtt': 'vtt', '.lrc': 'lrc' }

export function subtitleFormatOf(path: string): SubtitleFormat | null {
  return SUBTITLE[fileExtension(path)] ?? null
}
const FONT = new Set(['.ttf', '.otf', '.woff', '.woff2'])

const MEDIA_KIND_SET: ReadonlySet<PreviewKind> = new Set<PreviewKind>(['image', 'video', 'audio'])
/** Kinds whose bytes are decoded as text by `files:document`. */
const TEXT_KINDS: ReadonlySet<PreviewKind> = new Set<PreviewKind>(['text', 'markdown', 'html', 'table', 'diff', 'notebook', 'json', 'subtitle', 'structured'])
/** Kinds that own a rendered preview tab beside the source tab. */
const PREVIEW_KINDS: ReadonlySet<PreviewKind> = new Set<PreviewKind>(['markdown', 'html', 'table', 'diff', 'notebook', 'json', 'subtitle', 'structured'])
/** Kinds that take the whole pane: no view tabs, and never a document read. */
const INLINE_KINDS: ReadonlySet<PreviewKind> = new Set<PreviewKind>(['image', 'video', 'audio', 'pdf', 'unplayable', 'spreadsheet', 'font', 'archive', 'data'])

/** Bytes of a text document the preview reads. */
export const TEXT_READ_BYTES = 512 * 1024
/**
 * A structured JSON document is one object: a notebook carries its outputs
 * inline — a plotted chart is a base64 PNG in the same JSON — and a `.json`
 * file's tree preview parses the file whole. The ordinary text cap cuts
 * either mid-token and `JSON.parse` cannot read any of it. Still bounded:
 * it is one document, read whole so the parse can see it.
 */
export const JSON_READ_BYTES = 4 * 1024 * 1024

/**
 * What this path is. An unrecognized extension is `text`: the text reader is
 * the fallback, and it is the thing that reports "binary" when the bytes turn
 * out not to be text at all.
 */
export function previewKindOf(path: string): PreviewKind {
  const media = mediaKindOf(path)
  if (media) return media
  const table = tableFormatOf(path)
  if (table) return table === 'xlsx' ? 'spreadsheet' : 'table'
  if (isPdfPath(path)) return 'pdf'
  if (archiveFormatOf(path)) return 'archive'
  if (dataFormatOf(path)) return 'data'
  if (structuredFormatOf(path)) return 'structured'
  const ext = fileExtension(path)
  if (FONT.has(ext)) return 'font'
  if (MARKDOWN.has(ext)) return 'markdown'
  if (HTML.has(ext)) return 'html'
  if (DIFF.has(ext)) return 'diff'
  if (NOTEBOOK.has(ext)) return 'notebook'
  if (JSON_DOCUMENT.has(ext)) return 'json'
  if (subtitleFormatOf(path)) return 'subtitle'
  if (isUnsupportedMedia(path)) return 'unplayable'
  return 'text'
}

/** Narrows a `PreviewKind` that IS a media element kind (`image`/`video`/`audio`). */
export function isMediaKind(kind: PreviewKind): kind is MediaKind {
  return MEDIA_KIND_SET.has(kind)
}

/** Whether `files:document` may read this path: everything else would come back
 * as the first 512 KiB of a binary, or of a 2 GiB video. */
export function readsAsText(kind: PreviewKind): boolean {
  return TEXT_KINDS.has(kind)
}

/** Whether the preview offers a rendered view beside the source. */
export function hasPreviewView(kind: PreviewKind): boolean {
  return PREVIEW_KINDS.has(kind)
}

/** Whether the kind takes the pane on its own — no source/preview/diff tabs. */
export function isInlineOnly(kind: PreviewKind): boolean {
  return INLINE_KINDS.has(kind)
}

/** The text cap for the kind: a JSON document has to fit `JSON.parse`. */
export function textReadLimit(kind: PreviewKind): number {
  return kind === 'notebook' || kind === 'json' || kind === 'structured' ? JSON_READ_BYTES : TEXT_READ_BYTES
}

/** What a freshly opened tab shows first: a rendered view where there is one
 * (a patch is worth reading as a diff, not as raw hunks), source otherwise. */
export function opensOnPreview(path: string): boolean {
  return hasPreviewView(previewKindOf(path))
}

/**
 * Whether the app's own pane should show this path — used when a PDF link or a
 * conversation link points somewhere. Everything except a medium this engine
 * cannot decode is previewable here, text included: the pane renders a plain
 * source file perfectly well, and only an unplayable medium has nothing to show
 * and is better handed to the system.
 */
export function opensInFilePane(path: string): boolean {
  return previewKindOf(path) !== 'unplayable'
}
