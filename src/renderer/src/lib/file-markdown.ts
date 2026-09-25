/** Presentation-only sections for a Markdown file preview. The source view and
 * the bytes passed to the agent remain untouched. */
export type FileMarkdownSection = { kind: 'markdown' | 'tag-block'; text: string }

export interface FileMarkdownParts {
  frontmatter: string | null
  sections: FileMarkdownSection[]
}

const FRONTMATTER = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)^(?:---|\.\.\.)[ \t]*\r?(?:\n|$)/m
const YAML_FIELD = /^[A-Za-z_][\w-]*[ \t]*:/m
const OPEN_TAG = /^[ \t]*<([A-Za-z][\w.:-]*)(?:\s+[^<>]*)?>[ \t]*$/
const CLOSE_TAG = /^[ \t]*<\/([A-Za-z][\w.:-]*)>[ \t]*$/

function fenceMarker(line: string): string | null {
  return /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1] ?? null
}

function closesFence(line: string, marker: string): boolean {
  const trimmed = line.replace(/^ {0,3}/, '')
  const match = /^(`+|~+)[ \t]*$/.exec(trimmed)
  return !!match && match[1][0] === marker[0] && match[1].length >= marker.length
}

/** Find balanced standalone tags in one pass. Unmatched tags remain Markdown;
 * an unmatched earlier opener does not hide a complete later block. */
function tagBlockEnds(lines: string[]): Map<number, number> {
  const ends = new Map<number, number>()
  const stack: { name: string; start: number }[] = []
  let fence: string | null = null
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (fence) {
      if (closesFence(line, fence)) fence = null
      continue
    }
    fence = fenceMarker(line)
    if (fence) continue
    if (stack.length === 0 && /^(?: {4}|\t)/.test(line)) continue
    const closing = CLOSE_TAG.exec(line)
    if (closing) {
      const opened = stack.at(-1)
      if (opened?.name === closing[1]) {
        stack.pop()
        ends.set(opened.start, index)
      } else stack.length = 0
      continue
    }
    const opening = OPEN_TAG.exec(line)
    if (opening) stack.push({ name: opening[1], start: index })
  }
  return ends
}

export function splitFileMarkdown(source: string): FileMarkdownParts {
  let body = source.replace(/^\uFEFF/, '')
  let frontmatter: string | null = null
  const match = FRONTMATTER.exec(body)
  if (match?.index === 0 && YAML_FIELD.test(match[1])) {
    frontmatter = match[1].replace(/\r?\n$/, '')
    body = body.slice(match[0].length)
  }

  const lines = body.split(/\r?\n/)
  const ends = tagBlockEnds(lines)
  const sections: FileMarkdownSection[] = []
  let markdownStart = 0
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    // Four-space indented code is Markdown code, even when it contains tags.
    if (/^(?: {4}|\t)/.test(line)) continue
    const end = ends.get(index)
    if (end === undefined) continue
    const markdown = lines.slice(markdownStart, index).join('\n')
    if (markdown.trim()) sections.push({ kind: 'markdown', text: markdown })
    sections.push({ kind: 'tag-block', text: lines.slice(index, end + 1).join('\n') })
    index = end
    markdownStart = end + 1
  }
  const markdown = lines.slice(markdownStart).join('\n')
  if (markdown.trim()) sections.push({ kind: 'markdown', text: markdown })
  return { frontmatter, sections }
}
