/** The two file groups the SDK appends to every summary it generates. */
export interface SummaryFileGroups {
  /** The summary with those sections taken out. */
  body: string
  /** Files the summarized work only read. */
  read: string[]
  /** Files it created, edited or wrote. */
  modified: string[]
}

const TAGS = { 'read-files': 'read', 'modified-files': 'modified' } as const

/**
 * Split the SDK's trailing file sections out of a compaction/branch summary.
 *
 * `formatFileOperations` appends
 *
 * ```
 * <read-files>
 * src/a.ts
 * </read-files>
 *
 * <modified-files>
 * src/b.ts
 * </modified-files>
 * ```
 *
 * — one path per line — to every summary it generates. That is a private
 * convention between the SDK and the model, and markdown has no idea what those
 * tags are: the user got two lumps of raw tag text and a wall of unlinked
 * paths. The summary renders as this `body` plus two real lists instead
 * (`SummaryRow`), and the paths become the app's file links.
 *
 * Fenced code is off limits. A summary can quote a file that contains the very
 * same tags, and rewriting inside a fence would corrupt the quote — so the scan
 * tracks fences and leaves their contents untouched.
 */
export function splitSummaryFiles(text: string): SummaryFileGroups {
  const lines = text.split(/\r?\n/)
  const body: string[] = []
  const read: string[] = []
  const modified: string[] = []
  let fence: string | null = null
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    const opening = /^\s*(`{3,}|~{3,})/.exec(line)
    if (opening) {
      const marker = opening[1][0]
      if (!fence) fence = marker
      else if (fence === marker) fence = null
      body.push(line)
      continue
    }
    if (fence) {
      body.push(line)
      continue
    }
    const section = /^<(read-files|modified-files)>\s*$/.exec(line.trim())
    if (!section) {
      body.push(line)
      continue
    }
    const tag = section[1] as keyof typeof TAGS
    const end = lines.findIndex((candidate, at) => at > index && candidate.trim() === `</${tag}>`)
    // An unterminated block stays as it was written: dropping the text it wraps
    // would lose a file list the model itself is reading.
    if (end === -1) {
      body.push(line)
      continue
    }
    const target = TAGS[tag] === 'read' ? read : modified
    for (const candidate of lines.slice(index + 1, end)) {
      const path = candidate.trim()
      if (path) target.push(path)
    }
    index = end
  }
  // The sections are the last thing in a summary, so removing them leaves the
  // blank lines that separated them behind; more than one blank line means
  // nothing extra to markdown.
  const collapsed = body.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()
  return { body: collapsed, read, modified }
}
