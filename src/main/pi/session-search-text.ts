import type { SearchTextDTO } from '../../shared/types'

/** Literal substring semantics, shared by candidate verification and snippets.
 * NFKC handles full-width input and composed/decomposed Unicode equally. */
export function normalizeSearchText(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim()
}

export function searchTerms(query: string): string[] {
  const normalized = normalizeSearchText(query)
  return [...new Set(Array.from(normalized.matchAll(/"([^"]+)"|"([^"]+)$|([^\s"]+)/gu),
    (match) => (match[1] ?? match[2] ?? match[3]).trim()).filter(Boolean))]
}

/** Unique character/bigram tokens, encoded so FTS query syntax and punctuation
 * have no special meaning. Bigrams index two-character Chinese queries as well
 * as paths/code. Exact substring verification removes scattered-gram matches. */
export function searchGrams(text: string, indexing = false): string[] {
  const tokens = new Set<string>()
  let previous: string | undefined
  for (const char of text) {
    const current = char.codePointAt(0)!.toString(16)
    if (indexing) tokens.add(`u${current}`)
    if (previous !== undefined) tokens.add(`b${previous}x${current}`)
    previous = current
  }
  if (!tokens.size && previous !== undefined) tokens.add(`u${previous}`)
  return [...tokens]
}

const graphemes = new Intl.Segmenter('und', { granularity: 'grapheme' })

/** Map normalized matches back to the original text: lowercase expansions,
 * ligatures, combining marks and emoji must not shift highlight offsets. */
export function highlightSearchText(text: string, terms: string[]): SearchTextDTO {
  let normalized = ''
  const starts: number[] = []
  const ends: number[] = []
  for (const { segment, index } of graphemes.segment(text)) {
    const value = segment.normalize('NFKC').toLowerCase().replace(/\s/gu, ' ')
    for (const char of value) {
      if (char === ' ' && normalized.endsWith(' ')) {
        ends[ends.length - 1] = index + segment.length
        continue
      }
      normalized += char
      for (let i = 0; i < char.length; i++) {
        starts.push(index)
        ends.push(index + segment.length)
      }
    }
  }
  // Lowercasing can depend on neighbouring graphemes (Greek final sigma).
  // The full-string normalization is authoritative; the map retains offsets.
  normalized = text.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ')
  const found: [number, number][] = []
  for (const term of terms) {
    let at = normalized.indexOf(term)
    while (at !== -1) {
      found.push([starts[at], ends[at + term.length - 1]])
      at = normalized.indexOf(term, at + term.length)
    }
  }
  found.sort((a, b) => a[0] - b[0])
  const ranges: [number, number][] = []
  for (const range of found) {
    const tail = ranges.at(-1)
    if (tail && range[0] <= tail[1]) tail[1] = Math.max(tail[1], range[1])
    else ranges.push(range)
  }
  return { text, ranges }
}

/** Only page-sized result sets pay for Unicode offset mapping. First locate a
 * small window cheaply, then map that window exactly (no full-transcript maps). */
export function searchSnippet(body: string, terms: string[]): SearchTextDTO | null {
  for (const passage of body.split('\n')) {
    const normalized = normalizeSearchText(passage)
    const positions = terms.map((term) => normalized.indexOf(term)).filter((at) => at >= 0)
    if (!positions.length) continue
    // Locate by grapheme while retaining just the neighbourhood of the match.
    const first = Math.min(...positions)
    const radius = Math.max(130, ...terms.map((term) => term.length))
    const nearbyStart = Math.max(0, first - 55)
    const nearbyEnd = Math.min(passage.length, first + radius + 1)
    const nearby = highlightSearchText(`${nearbyStart ? '…' : ''}${passage.slice(nearbyStart, nearbyEnd)}${nearbyEnd < passage.length ? '…' : ''}`, terms)
    // ASCII, CJK and most Unicode preserve offsets. Avoid walking megabytes of
    // graphemes to reach a late match in a tool result in the common case.
    if (nearby.ranges.length) return nearby
    let offset = 0
    let start = 0
    let end = passage.length
    let previousSpace = false
    for (const item of graphemes.segment(passage)) {
      const value = item.segment.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ')
      const length = value === ' ' && previousSpace ? 0 : value.length
      if (offset < first - 55) start = item.index + item.segment.length
      offset += length
      previousSpace = value.endsWith(' ')
      if (offset > first + radius) {
        end = item.index + item.segment.length
        break
      }
    }
    const text = `${start ? '…' : ''}${passage.slice(start, end)}${end < passage.length ? '…' : ''}`
    return highlightSearchText(text, terms)
  }
  return null
}
