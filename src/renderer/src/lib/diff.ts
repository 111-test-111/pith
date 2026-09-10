import type { FileDiffLine } from '@/components/agents/file-diff'

/**
 * Parse a unified diff (as produced by pi's edit/write tools:
 * `--- a/file\n+++ b/file\n@@ -l,c +l,c @@ ...`) into FileDiff rows.
 */
export function parseUnifiedDiff(diff: string): FileDiffLine[] {
  const lines: FileDiffLine[] = []
  let oldLine = 0
  let newLine = 0
  let counter = 0

  for (const raw of diff.split('\n')) {
    if (raw.startsWith('@@')) {
      const match = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw)
      if (match) {
        oldLine = Number(match[1])
        newLine = Number(match[2])
      }
      continue
    }
    if (raw.startsWith('---') || raw.startsWith('+++')) continue
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

export function diffStats(lines: FileDiffLine[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const line of lines) {
    if (line.type === 'added') added++
    else if (line.type === 'removed') removed++
  }
  return { added, removed }
}
