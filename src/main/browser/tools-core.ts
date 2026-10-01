/** Pure browser-tool helpers: snapshot windows, refs, diagnostics and diffs.
 * Page-authored content stays inside the untrusted boundary. App observations
 * stay outside it. Tool context is English, independent of the UI locale. */
export const BROWSER_TOOL_NAMES = [
  'browser_navigate',
  'browser_pages',
  'browser_focus',
  'browser_snapshot',
  'browser_click',
  'browser_type',
  'browser_press_key',
  'browser_scroll',
  'browser_wait_for',
  'browser_screenshot',
  'browser_close',
  'browser_hover',
  'browser_select',
  'browser_upload',
] as const

// AI refs are eN in the main frame and f<frameSeq>eN in child frames.
const REF_RE = /\[ref=((?:f\d+)?e\d+)\]/g

export function parseSnapshotRefs(snapshot: string): Set<string> {
  const refs = new Set<string>()
  for (const match of snapshot.matchAll(REF_RE)) refs.add(match[1])
  return refs
}

export function isAiRef(value: unknown): value is string {
  return typeof value === 'string' && /^(?:f\d+)?e\d+$/.test(value)
}

export const SNAPSHOT_DEFAULT_MAX_CHARS = 20_000

export const SNAPSHOT_MAX_CHARS_LIMIT = 200_000

export function clampSnapshotMaxChars(maxChars?: number): number {
  if (maxChars === undefined || !Number.isFinite(maxChars)) return SNAPSHOT_DEFAULT_MAX_CHARS
  return Math.min(Math.max(0, Math.floor(maxChars)), SNAPSHOT_MAX_CHARS_LIMIT)
}

export interface IngestedSnapshot {

  visible: string

  truncated: boolean
  totalChars: number
  cap: number

  offset: number
}

export function normalizeSnapshotOffset(offset?: number): number {
  if (offset === undefined || !Number.isFinite(offset)) return 0
  return Math.max(0, Math.floor(offset))
}

/** One source for delivered text and diff baselines. Pagination changes only the
 * text window; refs outside it remain callable. Scrolling does not change document order. */
export function ingestSnapshot(text: string, maxChars?: number, offset?: number): IngestedSnapshot {
  const cap = clampSnapshotMaxChars(maxChars)
  const requested = Math.min(normalizeSnapshotOffset(offset), text.length)
  const start = snapToLineStart(text, requested, cap)
  const visible = text.slice(start, start + cap)
  return {
    visible,
    truncated: start + visible.length < text.length,
    totalChars: text.length,
    cap,
    offset: start,
  }
}

/** Align to a line boundary only when the resulting window still advances. */
function snapToLineStart(text: string, requested: number, cap: number): number {
  if (requested <= 0) return 0
  const nl = text.lastIndexOf('\n', requested - 1)
  if (nl < 0) return requested
  const lineStart = nl + 1
  return lineStart < requested && lineStart + cap > requested ? lineStart : requested
}

/** Include offset, selector and maxChars so reading never requires guessed CSS. */
export function snapshotTruncationNote(s: IngestedSnapshot): string {
  const next = s.offset + s.visible.length
  const more = next < s.totalChars
    ? ` Call browser_snapshot again with offset=${next} to read on from there.`
    : ''
  return `[Snapshot truncated: ${s.totalChars} characters total, showing characters ${s.offset}-${next}.${more} selector can narrow it to a subtree instead, and maxChars (the page-action tools accept it too) raises the limit for a single call.]`
}

export function snapshotBeyondCapNote(s: IngestedSnapshot): string {
  const next = s.offset + s.visible.length
  return `[Note: this page is ${s.totalChars} characters and only characters ${s.offset}-${next} are compared above. A change past that point would not appear here — re-read with offset=${next} or a larger maxChars to inspect the rest.]`
}

export function snapshotOffsetPastEndNote(offset: number, totalChars: number): string {
  return `[offset=${offset} is past the end of this ${totalChars}-character snapshot, so nothing is shown. Re-read with offset=0, or with a smaller offset.]`
}

/** No sampled mutation is not proof that focus, styles or canvas content stayed unchanged. */
export function noDomChangeNote(): string {
  return '[Nothing observable changed: no DOM mutation was observed while settling, and the accessibility snapshot you just received is identical to the previous one. A purely visual change (a CSS hover/active style, a canvas or video redraw) can still have happened — take a screenshot before concluding.]'
}

// Real keystroke replay must fit the action budget; locator.fill is unavailable on guests.
export const TYPE_TEXT_MAX_CHARS = 8_000

export function typeTextTooLongText(length: number): string {
  return `textTooLong: text is ${length} characters, over the ${TYPE_TEXT_MAX_CHARS}-character limit for keystroke replay (every character becomes a real key event and an action has an 8s budget, so a longer value would die as a timeout instead of arriving). Send a shorter value, or set the long content by another route.`
}

export const UPLOAD_MAX_FILES = 20

export interface UploadPathProblem {
  path: string
  reason: string
}

export function uploadPathsErrorText(problems: UploadPathProblem[]): string {
  const lines = problems.map((problem) => `- ${problem.path}: ${problem.reason}`).join('\n')
  return `error: cannot upload these local paths:\n${lines}`
}

export function uploadTooManyText(count: number): string {
  return `error: ${count} files given, over the ${UPLOAD_MAX_FILES}-file limit of one upload call. Split it into several browser_upload calls (the file input usually keeps what it already has).`
}

export function uploadNote(files: string[]): string {
  const names = files.map(uploadFileName)
  return `[Attached ${names.length} file${names.length === 1 ? '' : 's'}: ${names.join(', ')}.]`
}

function uploadFileName(file: string): string {
  const parts = file.split(/[\\/]+/).filter(Boolean)
  return parts[parts.length - 1] ?? file
}

export function capSnapshotText(text: string, maxChars?: number): string {
  return ingestSnapshot(text, maxChars).visible
}

export interface EmptySnapshotDiagnostics {
  readyState: string
  childElements: number
  textChars: number
}

export function emptySnapshotNote(diag: EmptySnapshotDiagnostics): string {
  return `[The accessibility tree is empty. Measured: readyState=${diag.readyState || 'unknown'}, <body> child elements=${diag.childElements}, visible text length=${diag.textChars}. An empty tree can mean the document genuinely has no accessible content, or that a script that builds the page did not finish or failed — see any page problems reported below, and consider browser_screenshot.]`
}

export interface PageIssueLike {
  kind: 'error' | 'console'
  text: string
}

/** Error text comes from the page and must stay inside its own untrusted boundary. */
export function pageIssuesNote(issues: PageIssueLike[], shown = 3): string {
  const list = issues.slice(0, shown)
  const lines = list.map((issue) => `- ${issue.kind === 'error' ? 'uncaught error' : 'console.error'}: ${issue.text}`)
  const more = issues.length - list.length
  if (more > 0) lines.push(`- (and ${more} more, not shown)`)
  return `[The page reported ${issues.length} problem(s) since the last snapshot (page-authored text, untrusted):\n${wrapUntrustedContent(lines.join('\n'))}]`
}

export interface ScrollPosition {
  x: number
  y: number
  viewportWidth: number
  viewportHeight: number
  scrollWidth: number
  scrollHeight: number
}

/** Document-order accessibility snapshots cannot show viewport movement. */
export function scrollPositionNote(p: ScrollPosition): string {
  const maxY = Math.max(0, p.scrollHeight - p.viewportHeight)
  const maxX = Math.max(0, p.scrollWidth - p.viewportWidth)
  const below = Math.max(0, maxY - p.y)
  return `[Scroll position: y=${p.y}/${maxY} (viewport ${p.viewportHeight}px; ${below}px further down), x=${p.x}/${maxX}. Document ${p.scrollWidth}×${p.scrollHeight} CSS px.]`
}

/** Report only the fixed-vocabulary tag name, never page-authored labels. */
export function focusChangedNote(tag: string): string {
  return `[Focus moved to <${tag}>.]`
}

export const UNTRUSTED_CONTENT_BEGIN = '<<<untrusted-web-content>>>'
export const UNTRUSTED_CONTENT_END = '<<<end-untrusted-web-content>>>'

export function wrapUntrustedContent(text: string): string {
  return `${UNTRUSTED_CONTENT_BEGIN}\n${text}\n${UNTRUSTED_CONTENT_END}`
}

/** Bound the LCS matrix; oversized input falls back to the new snapshot. */
export function diffSnapshotLines(oldText: string, newText: string): string {
  const oldLines = oldText.split('\n')
  const newLines = newText.split('\n')
  if (oldLines.length * newLines.length > 4_000_000) return newText
  const n = oldLines.length
  const m = newLines.length
  const width = m + 1
  const dp = new Uint32Array((n + 1) * width)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * width + j] = oldLines[i] === newLines[j]
        ? dp[(i + 1) * width + j + 1] + 1
        : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1])
    }
  }
  const ops: Array<{ type: 'same' | 'del' | 'add'; line: string }> = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) { ops.push({ type: 'same', line: oldLines[i] }); i++; j++ }
    else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) { ops.push({ type: 'del', line: oldLines[i] }); i++ }
    else { ops.push({ type: 'add', line: newLines[j] }); j++ }
  }
  while (i < n) ops.push({ type: 'del', line: oldLines[i++] })
  while (j < m) ops.push({ type: 'add', line: newLines[j++] })
  const out: string[] = []
  let unchanged = 0
  const flushUnchanged = () => {
    if (unchanged > 0) out.push(`  … ${unchanged} unchanged line(s) …`)
    unchanged = 0
  }
  for (const op of ops) {
    if (op.type === 'same') { unchanged++; continue }
    flushUnchanged()
    out.push(`${op.type === 'del' ? '-' : '+'} ${op.line}`)
  }
  flushUnchanged()
  if (out.every((line) => line.startsWith('  …'))) return '(no snapshot change)'
  return out.join('\n')
}
