import { MAX_CELL_CHARS, MAX_COLUMNS, RANGE_BYTES, XLSX_MAX_TEXT_BYTES, type TableSheet, type TableSheetRows } from '../../../shared/table'

/**
 * A minimal, read-only OOXML spreadsheet reader: ZIP central directory, deflate
 * through `DecompressionStream`, and an incremental scanner over
 * `xl/worksheets/sheetN.xml`.
 *
 * It exists instead of a spreadsheet library because the preview needs almost
 * nothing a library provides: no styles, no formulas, no writing. What it does
 * need is bounded memory — the sheet is inflated straight from the file's byte
 * ranges and parsing stops at the row cap, so a 200 MB workbook costs the rows
 * on screen, not the workbook.
 */

/** Everything the reader needs from the host: byte ranges of one file. */
export interface ByteSource {
  size: number
  read(begin: number, end: number): Promise<Uint8Array>
  cancelled(): boolean
}

/** Thrown when the host cancelled the job; never a user-visible failure. */
export class TableCancelled extends Error {
  constructor() {
    super('cancelled')
    this.name = 'TableCancelled'
  }
}

export function isTableCancelled(error: unknown): boolean {
  return error instanceof TableCancelled || (error as Error | null)?.name === 'TableCancelled'
}

interface ZipEntry {
  name: string
  method: number
  compressedSize: number
  size: number
  offset: number
}

const EOCD = 0x06054b50
const EOCD64 = 0x06064b50
const LOCATOR64 = 0x07064b50
const CENTRAL = 0x02014b50
const LOCAL = 0x04034b50
/** The end-of-central-directory record can sit behind a 64 KiB comment. */
const TAIL_BYTES = 70_000
const MAX_DIRECTORY_BYTES = 16 * 1024 * 1024
const MAX_STYLES_BYTES = 8 * 1024 * 1024
/** Shared strings are capped so one enormous workbook cannot pin the worker. */
const MAX_SHARED_CHARS = 32 * 1024 * 1024
const MAX_SHARED_ENTRIES = 400_000

function check(source: ByteSource) {
  if (source.cancelled()) throw new TableCancelled()
}

async function readAll(source: ByteSource, begin: number, end: number): Promise<Uint8Array> {
  const length = end - begin
  const buffer = new Uint8Array(length)
  let at = 0
  while (at < length) {
    check(source)
    const next = Math.min(length, at + RANGE_BYTES)
    buffer.set(await source.read(begin + at, begin + next), at)
    at = next
  }
  return buffer
}

/** Entry names of the archive, from its central directory (which is what a
 * streamed ZIP lacks — the reason this reads ranges instead of a whole file). */
async function openZip(source: ByteSource): Promise<Map<string, ZipEntry>> {
  const tailStart = Math.max(0, source.size - TAIL_BYTES)
  const tail = await source.read(tailStart, source.size)
  const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength)
  let eocd = -1
  for (let index = tail.byteLength - 22; index >= 0; index--) {
    if (view.getUint32(index, true) === EOCD) { eocd = index; break }
  }
  if (eocd < 0) throw new Error('Not a ZIP archive')
  let entries = view.getUint16(eocd + 10, true)
  let directorySize = view.getUint32(eocd + 12, true)
  let directoryOffset = view.getUint32(eocd + 16, true)
  // ZIP64: any 32-bit field saturated means the real values live in the ZIP64
  // record, which its locator points at just before the classic EOCD.
  if (entries === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    if (eocd >= 20 && view.getUint32(eocd - 20, true) === LOCATOR64) {
      const zip64 = Number(view.getBigUint64(eocd - 20 + 8, true))
      const header = await source.read(zip64, zip64 + 56)
      const headerView = new DataView(header.buffer, header.byteOffset, header.byteLength)
      if (headerView.getUint32(0, true) !== EOCD64) throw new Error('Broken ZIP64 directory')
      entries = Number(headerView.getBigUint64(32, true))
      directorySize = Number(headerView.getBigUint64(40, true))
      directoryOffset = Number(headerView.getBigUint64(48, true))
    }
  }
  if (directorySize <= 0 || directorySize > MAX_DIRECTORY_BYTES) throw new Error('Unsupported ZIP directory')
  const directory = await readAll(source, directoryOffset, directoryOffset + directorySize)
  const central = new DataView(directory.buffer, directory.byteOffset, directory.byteLength)
  const archive = new Map<string, ZipEntry>()
  let at = 0
  for (let index = 0; index < entries && at + 46 <= directory.byteLength; index++) {
    if (central.getUint32(at, true) !== CENTRAL) break
    const method = central.getUint16(at + 10, true)
    let compressedSize = central.getUint32(at + 20, true)
    let size = central.getUint32(at + 24, true)
    const nameLength = central.getUint16(at + 28, true)
    const extraLength = central.getUint16(at + 30, true)
    const commentLength = central.getUint16(at + 32, true)
    let offset = central.getUint32(at + 42, true)
    const name = new TextDecoder().decode(directory.subarray(at + 46, at + 46 + nameLength))
    if (size === 0xffffffff || compressedSize === 0xffffffff || offset === 0xffffffff) {
      const extraEnd = at + 46 + nameLength + extraLength
      let extra = at + 46 + nameLength
      while (extra + 4 <= extraEnd) {
        const id = central.getUint16(extra, true)
        const length = central.getUint16(extra + 2, true)
        if (id === 0x0001) {
          let cursor = extra + 4
          if (size === 0xffffffff) { size = Number(central.getBigUint64(cursor, true)); cursor += 8 }
          if (compressedSize === 0xffffffff) { compressedSize = Number(central.getBigUint64(cursor, true)); cursor += 8 }
          if (offset === 0xffffffff) offset = Number(central.getBigUint64(cursor, true))
          break
        }
        extra += 4 + length
      }
    }
    archive.set(name, { name, method, compressedSize, size, offset })
    at += 46 + nameLength + extraLength + commentLength
  }
  return archive
}

/** Inflated chunks of one entry, pulled from the file only as they are needed:
 * closing the generator releases the reader, so an early stop really stops. */
async function* streamEntry(source: ByteSource, entry: ZipEntry): AsyncGenerator<Uint8Array> {
  const header = await source.read(entry.offset, entry.offset + 30)
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength)
  if (view.getUint32(0, true) !== LOCAL) throw new Error('Broken ZIP entry')
  let position = entry.offset + 30 + view.getUint16(26, true) + view.getUint16(28, true)
  const end = position + entry.compressedSize
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (position >= end) { controller.close(); return }
        if (source.cancelled()) { controller.error(new TableCancelled()); return }
        const next = Math.min(end, position + RANGE_BYTES)
        const chunk = await source.read(position, next)
        position = next
        controller.enqueue(chunk)
      } catch (error) {
        controller.error(error)
      }
    }
  })
  // The DOM lib types a DecompressionStream's writable side as `BufferSource`,
  // which TS will not widen from our `Uint8Array` stream; the runtime contract
  // is exactly this.
  const decoded = entry.method === 8
    ? stream.pipeThrough(new DecompressionStream('deflate-raw') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>)
    : stream
  const reader = decoded.getReader()
  try {
    while (true) {
      check(source)
      const { done, value } = await reader.read()
      if (done) break
      if (value) yield value
    }
  } finally {
    // Releasing the reader is what stops further range pulls.
    void reader.cancel().catch(() => {})
  }
}

async function readTextEntry(source: ByteSource, archive: Map<string, ZipEntry>, name: string, maxChars = XLSX_MAX_TEXT_BYTES): Promise<string | null> {
  const entry = archive.get(name)
  if (!entry) return null
  const decoder = new TextDecoder()
  let text = ''
  for await (const chunk of streamEntry(source, entry)) {
    text += decoder.decode(chunk, { stream: true })
    if (text.length >= maxChars) break
  }
  return text + decoder.decode()
}

/** The tag whose name really ends there (`<row>`/`<row ` — never `<rows>`). */
function findTag(xml: string, name: string, from: number): number {
  let index = xml.indexOf(`<${name}`, from)
  while (index >= 0) {
    const next = xml[index + name.length + 1]
    if (next === undefined || next === ' ' || next === '>' || next === '/' || next === '\t' || next === '\r' || next === '\n') return index
    index = xml.indexOf(`<${name}`, index + 1)
  }
  return -1
}

function decodeXml(text: string): string {
  if (!text.includes('&')) return text
  return text.replace(/&(?:#x([0-9a-fA-F]+)|#(\d+)|(amp|lt|gt|quot|apos));/g, (match, hex, decimal, named) => {
    if (hex) return String.fromCodePoint(Number.parseInt(hex, 16))
    if (decimal) return String.fromCodePoint(Number(decimal))
    if (named === 'amp') return '&'
    if (named === 'lt') return '<'
    if (named === 'gt') return '>'
    if (named === 'quot') return '"'
    return "'"
  })
}

function limit(text: string): string {
  return text.length > MAX_CELL_CHARS ? text.slice(0, MAX_CELL_CHARS) : text
}

function columnIndex(letters: string): number {
  let value = 0
  for (let index = 0; index < letters.length; index++) value = value * 26 + (letters.charCodeAt(index) - 64)
  return value - 1
}

/** Text of the first `<name>…</name>` in an element body (`''` when empty). */
function tagText(xml: string, name: string): string | null {
  const start = findTag(xml, name, 0)
  if (start < 0) return null
  const tagEnd = xml.indexOf('>', start)
  if (tagEnd < 0) return null
  if (xml[tagEnd - 1] === '/') return ''
  const end = xml.indexOf(`</${name}>`, tagEnd)
  if (end < 0) return null
  return xml.slice(tagEnd + 1, end)
}

/** All `<t>` runs of an inline string (rich text is several of them). */
function inlineText(xml: string): string {
  let text = ''
  let at = 0
  while (true) {
    const start = findTag(xml, 't', at)
    if (start < 0) break
    const tagEnd = xml.indexOf('>', start)
    if (tagEnd < 0) break
    if (xml[tagEnd - 1] === '/') { at = tagEnd + 1; continue }
    const end = xml.indexOf('</t>', tagEnd)
    if (end < 0) break
    text += decodeXml(xml.slice(tagEnd + 1, end))
    at = end + 4
  }
  return text
}

/** Built-in number formats that mean "date or time". Custom formats are read
 * from `styles.xml`; this table only covers ids Excel reserves. */
const BUILTIN_DATES: Record<number, string> = {
  14: 'yyyy-mm-dd', 15: 'd-mmm-yy', 16: 'd-mmm', 17: 'mmm-yy',
  18: 'h:mm AM/PM', 19: 'h:mm:ss AM/PM', 20: 'h:mm', 21: 'h:mm:ss', 22: 'yyyy-mm-dd h:mm',
  45: 'mm:ss', 46: '[h]:mm:ss', 47: 'mmss.0'
}

function isDateTimeFormat(id: number): boolean {
  return (id >= 14 && id <= 22) || (id >= 27 && id <= 36) || (id >= 45 && id <= 47) || (id >= 50 && id <= 58)
}

function formatSerial(serial: number, code: string, date1904: boolean): string {
  if (!Number.isFinite(serial)) return String(serial)
  // Excel's 1900 calendar contains a 29 February that never existed; serials
  // below 60 are shifted by one day, and the 1904 system is 1462 days apart.
  const shifted = date1904 ? serial + 1462 : serial < 60 ? serial + 1 : serial
  const date = new Date(Math.round((shifted - 25569) * 86_400_000))
  if (Number.isNaN(date.getTime())) return String(serial)
  const pad = (value: number) => String(value).padStart(2, '0')
  const seconds = /s/i.test(code)
  const time = `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}${seconds ? `:${pad(date.getUTCSeconds())}` : ''}`
  const day = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
  const wantsTime = /[hs]/i.test(code)
  const wantsDate = /[ymd]/i.test(code)
  if (wantsTime && wantsDate) return `${day} ${time}`
  return wantsTime ? time : day
}

/** One `<row>` body into cells. The cell's own `r` reference decides its
 * column, so a sparse sheet keeps its real shape. */
function parseCells(xml: string, shared: string[], dateFormats: (string | null)[], date1904: boolean): string[] {
  const cells: string[] = []
  let column = 0
  let at = 0
  while (true) {
    const start = findTag(xml, 'c', at)
    if (start < 0) break
    const tagEnd = xml.indexOf('>', start)
    if (tagEnd < 0) break
    const tag = xml.slice(start, tagEnd)
    const reference = /\br="([A-Z]+)\d+"/.exec(tag)?.[1]
    const type = /\bt="([^"]+)"/.exec(tag)?.[1]
    const style = Number(/\bs="(\d+)"/.exec(tag)?.[1] ?? 0)
    if (reference) column = columnIndex(reference)
    let inner = ''
    if (xml[tagEnd - 1] === '/') at = tagEnd + 1
    else {
      const end = xml.indexOf('</c>', tagEnd)
      if (end < 0) break
      inner = xml.slice(tagEnd + 1, end)
      at = end + 4
    }
    if (column < MAX_COLUMNS) {
      while (cells.length < column) cells.push('')
      cells[column] = cellValue(inner, type, style, shared, dateFormats, date1904)
    }
    column++
  }
  return cells
}

function cellValue(inner: string, type: string | undefined, style: number, shared: string[], dateFormats: (string | null)[], date1904: boolean): string {
  if (type === 'inlineStr') return limit(inlineText(inner))
  const raw = tagText(inner, 'v')
  if (raw === null) return ''
  if (type === 's') return limit(shared[Number(raw)] ?? '')
  if (type === 'b') return raw === '1' ? 'TRUE' : 'FALSE'
  if (type === 'str' || type === 'e') return limit(decodeXml(raw))
  // A date is a number whose style says so — there is no date type in the file.
  const code = dateFormats[style]
  if (code) return formatSerial(Number(raw), code, date1904)
  return limit(raw)
}

function parseDateFormats(xml: string): (string | null)[] {
  const custom = new Map<number, string>()
  for (const match of xml.matchAll(/<numFmt\b[^>]*\bnumFmtId="(\d+)"[^>]*\bformatCode="([^"]*)"/g)) custom.set(Number(match[1]), decodeXml(match[2]))
  const start = xml.indexOf('<cellXfs')
  if (start < 0) return []
  const end = xml.indexOf('</cellXfs>', start)
  const body = xml.slice(start, end < 0 ? undefined : end)
  const formats: (string | null)[] = []
  for (const match of body.matchAll(/<xf\b[^>]*>/g)) {
    const id = Number(/\bnumFmtId="(\d+)"/.exec(match[0])?.[1] ?? 0)
    if (isDateTimeFormat(id)) { formats.push(BUILTIN_DATES[id] ?? 'yyyy-mm-dd'); continue }
    const code = custom.get(id)
    if (!code) { formats.push(null); continue }
    // Literals and [$…]/[Red] sections never carry date letters.
    const cleaned = code.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '').replace(/\\./g, '').toLowerCase()
    formats.push(/[ymdhs]/.test(cleaned) ? cleaned : null)
  }
  return formats
}

function parseSheets(xml: string, rels: string | null): TableSheet[] {
  const targets = new Map<string, string>()
  if (rels) {
    for (const match of rels.matchAll(/<Relationship\b[^>]*>/g)) {
      const id = /\bId="([^"]*)"/.exec(match[0])?.[1]
      const target = /\bTarget="([^"]*)"/.exec(match[0])?.[1]
      if (id && target) targets.set(id, target)
    }
  }
  const sheets: TableSheet[] = []
  for (const match of xml.matchAll(/<sheet\b[^>]*>/g)) {
    const name = decodeXml(/\bname="([^"]*)"/.exec(match[0])?.[1] ?? '')
    const target = targets.get(/\br:id="([^"]*)"/.exec(match[0])?.[1] ?? '')
    let path = (target ?? `worksheets/sheet${sheets.length + 1}.xml`).replace(/^\/+/, '')
    if (!path.startsWith('xl/')) path = `xl/${path}`
    sheets.push({ name: name || `Sheet${sheets.length + 1}`, path })
  }
  return sheets
}

/** A workbook opened over a byte source: its sheet list, then one sheet at a
 * time. Shared strings and styles are read once and kept for later sheets.
 *
 * Nothing here holds the byte source: ranges are answered per job, so a cached
 * workbook outlives the job that read it and is safe to reuse for the next one. */
export class Workbook {
  private shared: string[] | null = null
  private formats: (string | null)[] | null = null

  private constructor(
    private readonly archive: Map<string, ZipEntry>,
    readonly sheets: TableSheet[],
    private readonly date1904: boolean
  ) {}

  static async open(source: ByteSource): Promise<Workbook> {
    const archive = await openZip(source)
    const xml = await readTextEntry(source, archive, 'xl/workbook.xml', MAX_STYLES_BYTES)
    if (xml === null) throw new Error('Not a workbook')
    const rels = await readTextEntry(source, archive, 'xl/_rels/workbook.xml.rels', MAX_STYLES_BYTES)
    const sheets = parseSheets(xml, rels)
    if (!sheets.length) throw new Error('No worksheets')
    return new Workbook(archive, sheets, /<workbookPr[^>]*\bdate1904="(?:1|true)"/.test(xml))
  }

  /** Streamed, because a workbook's shared-string table is often its largest
   * part: only the entries actually reached are kept. */
  private async readSharedStrings(source: ByteSource): Promise<string[]> {
    const entry = this.archive.get('xl/sharedStrings.xml')
    const strings: string[] = []
    if (!entry) return strings
    const decoder = new TextDecoder()
    let buffer = ''
    let at = 0
    let chars = 0
    for await (const chunk of streamEntry(source, entry)) {
      buffer += decoder.decode(chunk, { stream: true })
      while (true) {
        const start = findTag(buffer, 'si', at)
        if (start < 0) { at = buffer.length; break }
        const tagEnd = buffer.indexOf('>', start)
        if (tagEnd < 0) { at = start; break }
        if (buffer[tagEnd - 1] === '/') { strings.push(''); at = tagEnd + 1; continue }
        const end = buffer.indexOf('</si>', tagEnd)
        if (end < 0) { at = start; break }
        const text = inlineText(buffer.slice(tagEnd + 1, end))
        chars += text.length
        strings.push(limit(text))
        at = end + 5
      }
      if (at > 512 * 1024) { buffer = buffer.slice(at); at = 0 }
      if (chars >= MAX_SHARED_CHARS || strings.length >= MAX_SHARED_ENTRIES) break
    }
    return strings
  }

  private async readFormats(source: ByteSource): Promise<(string | null)[]> {
    const xml = await readTextEntry(source, this.archive, 'xl/styles.xml', MAX_STYLES_BYTES)
    return xml ? parseDateFormats(xml) : []
  }

  /** Rows of one worksheet, in order, with the sheet's own row numbers. The
   * source belongs to the caller's job: its cancellation stops this read. */
  async readSheet(source: ByteSource, path: string, maxRows: number): Promise<TableSheetRows> {
    const entry = this.archive.get(path)
    if (!entry) throw new Error('Missing worksheet')
    if (!this.shared) this.shared = await this.readSharedStrings(source)
    if (!this.formats) this.formats = await this.readFormats(source)
    const shared = this.shared
    const formats = this.formats
    const decoder = new TextDecoder()
    const rows: string[][] = []
    const rowNumbers: number[] = []
    let columns = 0
    let totalRows: number | null = null
    let truncated = false
    let nextRow = 1
    let buffer = ''
    let at = 0
    const emit = (number: number, cells: string[]) => {
      if (rows.length >= maxRows) { truncated = true; return false }
      if (cells.length > columns) columns = Math.min(MAX_COLUMNS, cells.length)
      rows.push(cells)
      rowNumbers.push(number)
      nextRow = number + 1
      return true
    }
    for await (const chunk of streamEntry(source, entry)) {
      buffer += decoder.decode(chunk, { stream: true })
      if (totalRows === null) {
        const ref = /<dimension\b[^>]*\bref="[A-Z]*(\d+):[A-Z]*(\d+)"/.exec(buffer)
        if (ref) totalRows = Number(ref[2])
      }
      while (true) {
        const start = findTag(buffer, 'row', at)
        if (start < 0) {
          // Nothing before the last '<' can start a row tag, so the buffer can
          // be trimmed even when this chunk carried a great deal of cell XML.
          at = Math.max(at, buffer.lastIndexOf('<'))
          break
        }
        const tagEnd = buffer.indexOf('>', start)
        if (tagEnd < 0) { at = start; break }
        const number = Number(/\br="(\d+)"/.exec(buffer.slice(start, tagEnd))?.[1] ?? '') || nextRow
        if (buffer[tagEnd - 1] === '/') {
          if (!emit(number, [])) { at = buffer.length; break }
          at = tagEnd + 1
          continue
        }
        const end = buffer.indexOf('</row>', tagEnd)
        if (end < 0) { at = start; break }
        if (!emit(number, parseCells(buffer.slice(tagEnd + 1, end), shared, formats, this.date1904))) { at = buffer.length; break }
        at = end + 6
      }
      if (truncated) break
      if (at > 512 * 1024) { buffer = buffer.slice(at); at = 0 }
    }
    return { rows, rowNumbers, columns, totalRows, truncated }
  }
}
