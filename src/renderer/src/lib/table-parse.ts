import { MAX_CELL_CHARS, MAX_COLUMNS, type TableRows } from '../../../shared/table'

/** A table row with more columns than the preview keeps is cut, not dropped. */
const TRUNCATED = '…'

/**
 * RFC 4180-shaped delimited text into rows. The main process hands over
 * record-aligned slices, so each call is independent: a quoted field never
 * spans two of them, and the header is simply the first row of the first slice.
 *
 * Quotes are only special at the start of a field (`"a"b` stays literal), and
 * CR/LF inside a quoted field is kept — that is the whole reason the slices are
 * aligned to records in the main process.
 */
export function parseDelimitedRows(text: string, delimiter: string): TableRows {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let columns = 0
  let quoted = false
  let index = 0
  const endField = () => {
    if (row.length < MAX_COLUMNS) row.push(field.length > MAX_CELL_CHARS ? field.slice(0, MAX_CELL_CHARS) : field)
    else if (row[MAX_COLUMNS - 1].length < MAX_CELL_CHARS) row[MAX_COLUMNS - 1] += TRUNCATED
    field = ''
  }
  const endRow = () => {
    endField()
    if (row.length > columns) columns = row.length
    rows.push(row)
    row = []
  }
  while (index < text.length) {
    const char = text[index]
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') { field += '"'; index += 2; continue }
        quoted = false
        index++
        continue
      }
      // A quoted line break is content: keep it as one LF so a CRLF record
      // does not carry a raw CR into the cell.
      if (char === '\r') {
        field += '\n'
        index += text[index + 1] === '\n' ? 2 : 1
        continue
      }
      field += char
      index++
      continue
    }
    if (char === '"' && field.length === 0) { quoted = true; index++; continue }
    if (char === delimiter) { endField(); index++; continue }
    // CR of a CRLF pair (and a lone CR) never becomes part of a cell.
    if (char === '\r') { index++; continue }
    if (char === '\n') { endRow(); index++; continue }
    field += char
    index++
  }
  // A file that does not end in a newline still has a last row.
  if (field.length || row.length) endRow()
  return { rows, columns }
}
