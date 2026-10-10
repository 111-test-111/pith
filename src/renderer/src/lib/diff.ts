import type { FileDiffLine } from '@/components/agents/file-diff'

/** Shared gutter metric for full diffs and page-scrolled row windows. */
export function diffGutterColumns(lines: FileDiffLine[]): number {
  return lines.reduce((digits, line) => Math.max(digits, String(line.oldLine ?? 0).length, String(line.newLine ?? 0).length), 2)
}

/**
 * Parse a unified diff (as produced by pi's edit/write tools:
 * `--- a/file\n+++ b/file\n@@ -l,c +l,c @@ ...`) into FileDiff rows.
 */
export function parseUnifiedDiff(diff: string): FileDiffLine[] {
  const lines: FileDiffLine[] = []
  let oldLine = 0
  let newLine = 0
  let counter = 0
  const hasHunks = diff.includes('@@')
  let inHunk = !hasHunks

  for (const raw of diff.split('\n')) {
    if (raw.startsWith('@@')) {
      inHunk = true
      const match = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw)
      if (match) {
        oldLine = Number(match[1])
        newLine = Number(match[2])
      }
      continue
    }
    if (!inHunk || raw === '' || (!hasHunks && (raw.startsWith('--- ') || raw.startsWith('+++ ')))) continue
    if (raw.startsWith('\\')) continue // "\ No newline at end of file"

    if (raw.startsWith('+')) {
      lines.push({
        id: `d${counter++}`,
        type: 'added',
        newLine: newLine++,
        content: raw.slice(1)
      })
    } else if (raw.startsWith('-')) {
      lines.push({
        id: `d${counter++}`,
        type: 'removed',
        oldLine: oldLine++,
        content: raw.slice(1)
      })
    } else {
      lines.push({
        id: `d${counter++}`,
        type: 'context',
        oldLine: oldLine++,
        newLine: newLine++,
        content: raw.slice(1)
      })
    }
  }
  return lines
}

/**
 * Reconstructs the unified patch for a `write` call.
 *
 * pi's `write` tool reports no `details` at all — no patch and no counts — so
 * the app derives them from the one thing the call does carry: the full
 * `content` it wrote. `write` is documented as "new files or complete
 * rewrites", and the result holds no before-image, so the content reads as a
 * single all-insertion hunk (`--- /dev/null`). That is exactly right for a
 * created file and the honest answer for a rewrite: the diff shows what the
 * file now contains. Empty content has no hunk to show, so it returns null and
 * the call falls back to its plain disclosure.
 */
export function synthesizeWritePatch(path: string, content: string): string | null {
  if (!content) return null
  // A trailing newline terminates the last line rather than starting an empty
  // one, so drop it before splitting ("a\nb\n" is two lines, not three).
  const body = content.endsWith('\n') ? content.slice(0, -1) : content
  const lines = body.split('\n')
  const header = [`--- /dev/null`, `+++ b/${path}`, `@@ -0,0 +1,${lines.length} @@`]
  return [...header, ...lines.map((line) => `+${line}`)].join('\n')
}

export function diffStats(lines: FileDiffLine[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const line of lines) {
    if (line.type === 'added') added++
    else if (line.type === 'removed') removed++
  }
  return { added, removed }
}

/**
 * Cheap +/- counts straight from the raw diff, for collapsed headers where
 * turning the whole diff into line rows is deferred until the user opens it.
 * Mirrors parseUnifiedDiff's rules (headers and "\ No newline" are ignored).
 */
export function countDiffChanges(diff: string): { added: number; removed: number } {
  let added = 0
  let removed = 0
  const hasHunks = diff.includes('@@')
  let inHunk = !hasHunks
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('@@')) { inHunk = true; continue }
    if (!inHunk || (!hasHunks && (raw.startsWith('--- ') || raw.startsWith('+++ ')))) continue
    if (raw.startsWith('+')) added++
    else if (raw.startsWith('-')) removed++
  }
  return { added, removed }
}
