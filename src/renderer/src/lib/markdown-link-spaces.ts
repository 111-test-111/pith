/** CommonMark allows no whitespace in an inline link destination unless it is
 * wrapped in `<...>` (or the space is escaped or percent-encoded). A model that
 * links a path containing one — `~/Library/Application Support/rtk/config.toml`
 * is the everyday case on macOS — therefore renders as literal text on every
 * conformant renderer, without a link and without an error.
 *
 * Wrap exactly those destinations, which is what the author meant. This
 * changes rendering input only: the stored message keeps its bytes, and a
 * candidate the scanner cannot read exactly (an escaped space, an embedded
 * `<`, prose that merely looks like Markdown) is left untouched and still
 * renders literally — a verbatim fallback, never a wrong link. */
export function normalizeLinkSpaces(source: string): string {
  if (!OPENER.test(source)) return source
  const lines = source.split('\n')
  const span = { open: 0 }
  let fence: string | null = null
  let changed = false
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const unquoted = line.replace(QUOTE_PREFIX, '')
    if (fence) {
      if (closesFence(unquoted, fence)) fence = null
      continue
    }
    if (!span.open) {
      const opening = FENCE_OPEN.exec(unquoted)
      if (opening) {
        fence = opening[1]
        continue
      }
      if (INDENTED.test(line)) continue
    }
    const masked = codeSpanMask(line, span)
    const rewritten = rewriteLine(line, masked)
    if (rewritten !== line) {
      lines[index] = rewritten
      changed = true
    }
  }
  return changed ? lines.join('\n') : source
}

/** Cheap gate: every rewrite needs a link or image opener. */
const OPENER = /\]\(/

/** A destination worth repairing looks like a path, URL or fragment. Bare prose
 * that merely resembles Markdown (`[x](see above)`) stays literal text instead
 * of turning into a link to a file named after the sentence. */
const TARGET_LIKE = /[/\\.:#]/

/** Backslash escapes CommonMark resolves inside a plain destination. Wrapping
 * the text would make them literal again, so those candidates stay untouched. */
const ESCAPED = /\\[\s!"#$%&'()*+,./:;<=>?@[\\\]^_`{|}~-]/

/** `destination "title"` — the title stays outside the bracket we add. */
const TITLE = /^(.*?)[\t ]+(["'])(.*)\2$/

const LEADING = /^[\t ]*/
const TRAILING = /[\t ]*$/
const QUOTE_PREFIX = /^ {0,3}(?:>[\t ]?)*/
const FENCE_OPEN = /^(`{3,}|~{3,})/
const INDENTED = /^(?: {4}|\t)/

/** CommonMark fence close: same marker character, at least as long as the opener. */
function closesFence(line: string, marker: string): boolean {
  const match = /^(`+|~+)[\t ]*$/.exec(line)
  return !!match && match[1][0] === marker[0] && match[1].length >= marker.length
}

/** Mark every character of `line` that sits inside a code span, carrying the
 * open span length across lines — a transformation inside a code span would
 * change the code the user is reading. */
function codeSpanMask(line: string, state: { open: number }): boolean[] {
  const masked: boolean[] = []
  let open = state.open
  for (let index = 0; index < line.length; ) {
    if (line[index] !== '`') {
      masked[index] = open > 0
      index += 1
      continue
    }
    let length = 0
    while (line[index + length] === '`') length += 1
    let escaped = false
    if (!open) {
      let slashes = 0
      for (let probe = index - 1; probe >= 0 && line[probe] === '\\'; probe -= 1) slashes += 1
      escaped = slashes % 2 === 1
    }
    if (open > 0 && length === open) open = 0
    else if (!open && !escaped) open = length
    for (let offset = 0; offset < length; offset += 1) masked[index + offset] = true
    index += length
  }
  state.open = open
  return masked
}

function rewriteLine(line: string, masked: boolean[]): string {
  let out = ''
  let cursor = 0
  for (let index = 0; index + 1 < line.length; index += 1) {
    if (line[index] !== ']' || line[index + 1] !== '(' || masked[index]) continue
    const link = repairDestination(line, index + 2, masked)
    if (!link) continue
    out += line.slice(cursor, index + 2) + link.text
    cursor = link.end
    index = link.end
  }
  return cursor === 0 ? line : out + line.slice(cursor)
}

/** Read one `(...)` destination and return its rewritten body, or `null` when it
 * parses already or cannot be repaired exactly. `open` indexes the character
 * after `(`; `end` the closing parent. */
function repairDestination(line: string, open: number, masked: boolean[]): { text: string; end: number } | null {
  let depth = 0
  let end = -1
  for (let index = open; index < line.length; index += 1) {
    // A destination that runs into code, HTML or a nested construct is not one
    // this scanner can read; leave the source exactly as written.
    if (masked[index]) return null
    const character = line[index]
    if (character === '\\') {
      index += 1
      continue
    }
    if (character === '(') {
      if (depth === 32) return null
      depth += 1
    } else if (character === ')') {
      if (depth === 0) {
        end = index
        break
      }
      depth -= 1
    }
  }
  if (end === -1) return null
  const inner = line.slice(open, end)
  const leading = LEADING.exec(inner)![0]
  const trailing = TRAILING.exec(inner)![0]
  const body = inner.slice(leading.length, inner.length - trailing.length)
  if (!body) return null
  if (body.startsWith('<')) {
    // Already the bracketed form, which cannot hold a space: only an omitted
    // `>` is left to repair, and the `>` the author wrote is already the opener.
    return body.endsWith('>') || body.includes('>') ? null : { text: `${leading}${body}>${trailing}`, end }
  }
  if (body.includes('<') || body.includes('>') || ESCAPED.test(body)) return null
  const title = TITLE.exec(body)
  const destination = title ? title[1] : body
  // No rewrite is needed when the whitespace already separates a valid
  // destination from its title, and none exists when the destination itself is
  // unbroken.
  if (!destination || !/[\t ]/.test(destination) || !TARGET_LIKE.test(destination)) return null
  const suffix = title ? ` ${title[2]}${title[3]}${title[2]}` : ''
  return { text: `${leading}<${destination}>${suffix}${trailing}`, end }
}
