/** Jupyter protects display math before parsing Markdown, so a quote's math
 * body often omits `>` on continuation lines. CommonMark only permits that
 * omission in paragraphs, not fenced math: the first `=` then becomes a
 * setext heading and the orphaned closing `$$` consumes subsequent prose.
 *
 * Make just those complete, paragraph-bounded formula blocks explicit quotes.
 * No placeholders, second Markdown parse or DOM pass; ordinary Markdown takes
 * the fast path. This changes rendering input only, never the stored source. */
export function normalizeQuotedMath(source: string): string {
  if (!/^ {0,3}>.*(?:\${2,}|\\\[)[\t ]*\r?$/m.test(source)) return source
  const lines = source.split('\n')
  let codeFence: string | null = null
  let codeSpan = 0
  let mathFence: string | null = null
  let changed = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const content = line.replace(/^ {0,3}(?:>[\t ]?)*(?:(?:[-+*]|\d+[.)])[\t ]+)?/, '')
    if (codeFence) {
      if (new RegExp(`^${codeFence[0]}{${codeFence.length},}\\s*$`).test(content)) codeFence = null
      continue
    }
    if (mathFence) {
      if (closes(content, mathFence)) mathFence = null
      continue
    }
    const openingCode = !codeSpan && /^(`{3,}|~{3,})/.exec(content)
    if (openingCode) { codeFence = openingCode[1]; continue }
    if (!codeSpan) {
      const quote = /^((?: {0,3}>[\t ]?)+)[\t ]*(\${2,}|\\\[)[\t ]*\r?$/.exec(line)
      if (quote) {
        const prefix = quote[1]
        const depth = prefix.split('>').length - 1
        const marker = quote[2]
        let size = 0
        let end = i + 1
        // Jupyter likewise stops at paragraph boundaries. This also prevents
        // an unclosed quote formula from claiming a later, unrelated formula.
        for (; end < lines.length; end++) {
          const body = stripQuote(lines[end], depth)
          size += body.length + 1
          if (!body.trim() || size > 16_384) break
          if (closes(body, marker)) {
            for (let j = i + 1; j <= end; j++) {
              if (!lines[j].startsWith(prefix)) {
                lines[j] = prefix + stripQuote(lines[j], depth)
                changed = true
              }
            }
            i = end
            break
          }
        }
        continue
      }
      const openingMath = /^(\${2,}|\\\[)[\t ]*\r?$/.exec(content)
      if (openingMath) { mathFence = openingMath[1]; continue }
    }
    // Respect multiline inline code as well as fenced/indented code. A run
    // only closes a code span of the same length; escaped backticks outside
    // a span remain ordinary text.
    if (/^(?: {4}|\t)/.test(line)) continue
    for (const run of line.matchAll(/`+/g)) {
      if (codeSpan) { if (run[0].length === codeSpan) codeSpan = 0 }
      else {
        let slashes = 0
        for (let p = run.index - 1; p >= 0 && line[p] === '\\'; p--) slashes++
        if (slashes % 2 === 0) codeSpan = run[0].length
      }
    }
  }
  return changed ? lines.join('\n') : source
}

function stripQuote(line: string, depth: number): string {
  for (let n = 0; n < depth; n++) {
    const marker = /^ {0,3}>[\t ]?/.exec(line)
    if (!marker) break
    line = line.slice(marker[0].length)
  }
  return line
}

function closes(line: string, marker: string): boolean {
  return marker === '\\[' ? line.trim() === '\\]' :
    new RegExp(`^[\\t ]*\\${marker[0]}{${marker.length},}[\\t ]*\\r?$`).test(line)
}
