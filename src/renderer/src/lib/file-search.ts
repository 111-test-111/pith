export interface FileSearchOptions { matchCase: boolean; wholeWord: boolean; regex: boolean }
export interface FileMatch { start: number; end: number; line: number; column: number }
export interface FileSearchResult { matches: FileMatch[]; limited: boolean; error?: 'invalidRegex' | 'timeout' | 'unavailable' }
export const EMPTY_FILE_SEARCH: FileSearchResult = { matches: [], limited: false }
export const MAX_FILE_MATCHES = 10_000

/** Runs in a disposable worker: even a pathological user regex cannot block
 * typing, pane resizing or navigation. Offsets are UTF-16, like DOM Ranges. */
export function searchFile(text: string, query: string, options: FileSearchOptions): FileSearchResult {
  if (!query) return EMPTY_FILE_SEARCH
  let expression: RegExp
  try { expression = new RegExp(options.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), `gmu${options.matchCase ? '' : 'i'}`) }
  catch { return { ...EMPTY_FILE_SEARCH, error: 'invalidRegex' } }
  const matches: FileMatch[] = []
  const word = /[\p{L}\p{N}\p{M}_]/u
  let line = 1, lineStart = 0, nextLine = text.indexOf('\n')
  let match: RegExpExecArray | null
  while ((match = expression.exec(text))) {
    const start = match.index, end = start + match[0].length
    // Empty matches have no text to highlight; advance by a whole code point.
    if (start === end) { expression.lastIndex += (text.codePointAt(end) ?? 0) > 0xffff ? 2 : 1; continue }
    if (options.wholeWord) {
      const before = Array.from(text.slice(Math.max(0, start - 2), start)).at(-1) ?? ''
      const after = String.fromCodePoint(text.codePointAt(end) ?? 0)
      if (word.test(before) || word.test(after)) continue
    }
    if (matches.length === MAX_FILE_MATCHES) return { matches, limited: true }
    while (nextLine !== -1 && nextLine < start) { line++; lineStart = nextLine + 1; nextLine = text.indexOf('\n', lineStart) }
    matches.push({ start, end, line, column: start - lineStart })
  }
  return { matches, limited: false }
}
