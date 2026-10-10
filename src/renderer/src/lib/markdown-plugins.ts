import remarkCjkFriendly from 'remark-cjk-friendly/parseOnly'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import { remarkTexMath } from './remark-tex-math'
import { remarkMathNodes } from './remark-math-nodes'
import { remarkSafeBreaks } from './remark-safe-breaks'
import { remarkSafeInlineHtml } from './remark-safe-inline-html'
import { remarkAlerts } from './remark-alerts'
import { remarkSoftBreaks } from './remark-soft-breaks'
import type { Link, Parent, PhrasingContent, Text } from 'mdast'
import type { PluggableList } from 'unified'

/**
 * Remark plugins shared by every ReactMarkdown instance: GFM (tables, task
 * lists, strikethrough, literal autolinks), math, plus two fixes for CJK prose —
 *
 * 1. `remark-cjk-friendly` (parse side only) applies the alternative emphasis
 *    spec allowing emphasis after a CJK label and full-width colon. Plain CommonMark refuses it: the
 *    closing `**` is preceded by punctuation and followed by a non-space, so
 *    it is not "right-flanking" and stays literal.
 * 2. `remarkCjkAutolinkTrim` cuts GFM's literal autolinks at CJK punctuation,
 *    see below.
 */
export const REMARK_PLUGINS: PluggableList = [
  remarkGfm, remarkCjkFriendly, remarkCjkAutolinkTrim, remarkSafeBreaks,
  remarkSafeInlineHtml, remarkAlerts,
  [remarkMath, { singleDollarTextMath: false }], remarkTexMath, remarkMathNodes
]

export const FILE_REMARK_PLUGINS: PluggableList = [...REMARK_PLUGINS, remarkSoftBreaks]

/**
 * GFM's literal autolink syntax (`https://…`, `www.…`) ends the link at ASCII
 * whitespace or `<` only, and its "trailing punctuation" trim set is ASCII
 * too. In CJK prose a bare URL glued to full-width punctuation —
 * a URL inside full-width parentheses followed by CJK punctuation/prose — therefore swallows everything
 * up to the next space into the link, because neither `）` nor `，` terminates
 * it. Cut the link at the first CJK/typographic punctuation character, then
 * re-run GFM's own ASCII trail trim on the prefix so `https://x/a(b)。` keeps
 * its balance-matched paren.
 *
 * The cut set is deliberately punctuation-only, not CJK letters: a URL whose
 * path legitimately holds CJK (a CJK wiki path) and is followed by a space must
 * stay intact.
 */
const CJK_GLUE =
  /[\u2013\u2014\u2018-\u201F\u2026\u3000-\u303F\uFF01-\uFF0F\uFF1A-\uFF20\uFF3B-\uFF40\uFF5B-\uFF65]/

/** GFM's trailing-punctuation set (see `splitUrl` in mdast-util-gfm-autolink-literal). */
const ASCII_TRAIL = /[!"&'),.:;<>?\]}]+$/

/** Split a URL into its body and the ASCII punctuation trail that follows it,
 * keeping closing parens that balance an opening paren inside the body. */
function splitTrail(url: string): [string, string] {
  const match = ASCII_TRAIL.exec(url)
  if (!match) return [url, '']
  let body = url.slice(0, match.index)
  let trail = match[0]
  let closing = trail.indexOf(')')
  const opening = count(body, '(')
  let closings = count(body, ')')
  while (closing !== -1 && opening > closings) {
    body += trail.slice(0, closing + 1)
    trail = trail.slice(closing + 1)
    closing = trail.indexOf(')')
    closings += 1
  }
  return [body, trail]
}

function count(value: string, character: string): number {
  let total = 0
  for (const char of value) if (char === character) total += 1
  return total
}

/**
 * True for a GFM literal autolink: its node span is exactly its single text
 * child's span. An explicit `[text](url)` always starts one character (the
 * `[`) before its child, so hand-written links are never re-scoped.
 */
function isLiteralAutolink(node: Link, child: PhrasingContent | undefined): child is Text {
  const start = node.position?.start.offset
  const end = node.position?.end.offset
  return (
    !!child &&
    child.type === 'text' &&
    node.children.length === 1 &&
    start !== undefined &&
    end !== undefined &&
    child.position?.start.offset === start &&
    child.position?.end.offset === end
  )
}

function trimLiteralAutolink(parent: Parent, index: number): void {
  const link = parent.children[index]
  if (link.type !== 'link') return
  const child = link.children[0]
  if (!isLiteralAutolink(link, child)) return
  const value = child.value
  const cut = value.search(CJK_GLUE)
  if (cut <= 0) return
  const [body, trail] = splitTrail(value.slice(0, cut))
  if (!body) return
  child.value = body
  if (link.url.endsWith(value)) link.url = link.url.slice(0, -value.length) + body
  parent.children.splice(index + 1, 0, { type: 'text', value: trail + value.slice(cut) })
}

function walk(parent: Parent): void {
  for (let index = 0; index < parent.children.length; index += 1) {
    const node = parent.children[index]
    if (node.type === 'link') {
      trimLiteralAutolink(parent, index)
      index += 1
      continue
    }
    if ('children' in node && Array.isArray(node.children)) walk(node as Parent)
  }
}

function remarkCjkAutolinkTrim() {
  return (tree: Parent): void => walk(tree)
}
