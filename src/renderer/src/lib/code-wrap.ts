export interface WrappedCode {
  prefix: Uint32Array
  boundaries: number[]
  rows: number
}

/** Segment code in monospace columns, preserving tabs and UTF-16 boundaries. */
function segmentLine(line: string, columns: number, tabSize: number, out: number[]) {
  let column = 0, start = 0, index = 0
  while (index < line.length) {
    const codePoint = line.codePointAt(index)!
    let advance = codePoint === 9 ? tabSize - column % tabSize : codePoint > 127 ? 2 : 1
    if (column > 0 && column + advance > columns) {
      out.push(start, index)
      start = index
      column = 0
      if (codePoint === 9) advance = tabSize
    }
    column += advance
    index += codePoint >= 0x10000 ? 2 : 1
  }
  out.push(start, index)
}

export function wrapCodeLines(lines: readonly string[], columns: number, tabSize = 8): WrappedCode {
  const prefix = new Uint32Array(lines.length + 1)
  const boundaries: number[] = []
  for (let index = 0; index < lines.length; index++) {
    segmentLine(lines[index], columns, tabSize, boundaries)
    prefix[index + 1] = boundaries.length / 2
  }
  return { prefix, boundaries, rows: boundaries.length / 2 }
}

/** Largest logical line index whose first display row is at or above `row`. */
export function lineAtRow(prefix: Uint32Array, row: number) {
  let low = 0, high = prefix.length - 2
  while (low < high) {
    const mid = (low + high + 1) >>> 1
    if (prefix[mid] <= row) low = mid
    else high = mid - 1
  }
  return low
}

/** Find the display row that contains a UTF-16 offset on a logical line. */
export function displayRow(wrapped: WrappedCode | null, line: number, offset = 0) {
  if (!wrapped) return line
  let low = wrapped.prefix[line], high = wrapped.prefix[line + 1] - 1
  while (low < high) {
    const mid = (low + high + 1) >>> 1
    if (wrapped.boundaries[mid * 2] <= offset) low = mid
    else high = mid - 1
  }
  return low
}
