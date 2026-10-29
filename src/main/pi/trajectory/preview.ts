import type { TrajectoryDocumentKind, TrajectoryKind } from '../../../shared/trajectory'
import { TRAJECTORY_PREVIEW_SIZE } from '../../../shared/trajectory'

/** Read only selected Merkle children and scalar prefixes, never decode a
 * complete request, tool result, image or message to populate a list row. */
export interface PreviewReader {
  field(id: string, key: string): string | undefined
  entries(id: string, limit: number): Array<[string, string]>
  text(id: string): string
}

const SECRET = /^(api[_-]?key|authorization|access[_-]?token|refresh[_-]?token|password|secret|data|image|signature|thinkingSignature)$/i
const compact = (text: string) => text.replace(/[\s\u200b-\u200d\ufeff]+/g, ' ').trim().slice(0, TRAJECTORY_PREVIEW_SIZE).replace(/[\ud800-\udbff]$/, '')

/** A scalar can be megabytes long. SQLite returns only its encoded prefix;
 * repair an incomplete JSON escape at the cut, then decode that small prefix. */
export function scalarPreview(prefix: string): string {
  if (!prefix.startsWith('"')) {
    try { const value: unknown = JSON.parse(prefix); return typeof value === 'number' || typeof value === 'boolean' ? String(value) : '' } catch { return '' }
  }
  try { return JSON.parse(prefix) as string } catch { /* truncated string */ }
  for (let cut = 0; cut <= 6; cut++) {
    try { return JSON.parse(prefix.slice(0, prefix.length - cut) + '"') as string } catch { /* trailing escape */ }
  }
  return ''
}

export function trajectoryPreview(kind: TrajectoryKind, roots: Partial<Record<TrajectoryDocumentKind, string>>, read: PreviewReader): string {
  const field = (id: string | undefined, key: string) => id ? read.field(id, key) : undefined
  const text = (id: string | undefined) => id ? compact(read.text(id)) : ''
  const value = (id: string | undefined, key: string) => text(field(id, key))
  const join = (parts: string[]) => compact(parts.filter(Boolean).join(' · '))
  const args = (id: string | undefined): string => {
    if (!id) return ''
    // Put the invocation's intent first, even when an extension's schema lists
    // bookkeeping or a large file body before command/path/query.
    for (const key of ['command', 'path', 'filePath', 'file', 'url', 'query', 'pattern', 'description', 'prompt', 'code']) {
      const primary = value(id, key)
      if (primary) return join([primary, ...['offset', 'limit', 'startLine', 'endLine'].map(key => {
        const child = field(id, key)
        const number = child ? read.text(child) : ''
        return number ? `${key}: ${number}` : ''
      })])
    }
    const request = field(id, 'request')
    if (request) {
      const action = value(request, 'action')
      const detail = args(request)
      if (action || detail) return join([action, detail])
    }
    return join(read.entries(id, 4).filter(([key]) => !SECRET.test(key)).map(([key, child]) => {
      const scalar = text(child)
      return scalar ? `${key}: ${scalar}` : ''
    }))
  }
  const message = (id: string | undefined): string => {
    if (!id) return ''
    const content = field(id, 'content')
    const direct = text(content) || value(id, 'text') || value(id, 'errorMessage') || value(id, 'summary') || value(field(id, 'compaction'), 'summary')
    if (direct) return direct
    if (!content) return ''
    const blocks = read.entries(content, 12).map(([, block]) => block)
    const output = join(blocks.filter(block => value(block, 'type') === 'text').map(block => value(block, 'text')))
    if (output) return output
    return join(blocks.filter(block => value(block, 'type') === 'thinking').map(block => value(block, 'thinking')))
  }
  if (kind === 'run') return ''
  if (kind === 'tool') return args(roots.context) || message(roots.output) || message(roots.event)
  if (kind === 'user') return message(roots.context) || message(roots.event)
  return message(roots.output) || message(roots.event) || value(roots.event, 'error') || value(roots.output, 'finalError')
}
