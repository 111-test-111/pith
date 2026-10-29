import type { ReadRangeDTO, ToolSearchRootDTO } from '../../../shared/types'
import type { FileSearchOptions } from './file-search'
import { basename } from './format'
import { isAbsolutePath, isHomePath, normalizeSlashes, resolveFromCwd } from './tool-path'

export interface GrepOutputLine {
  path: string
  line: number
  text: string
  match: boolean
}
export interface GrepOutputFile {
  kind: 'file'
  format: 'sdk' | 'fff'
  path: string
  annotation?: string
  rows: GrepOutputLine[]
}
export type GrepOutputBlock = GrepOutputFile | { kind: 'text'; text: string }

function groupedGrepLine(raw: string) {
  const record = /^[ \t]+(\d+)([:\-]) (.*)$/.exec(raw)
  const line = record ? Number(record[1]) : 0
  return record && Number.isSafeInteger(line) && line > 0
    ? { line, text: record[3], match: record[2] === ':' }
    : undefined
}

/** Both SDK path:line: records and pi-fff file headers + indented rows.
 * A grouped header needs a following numbered row; standalone diagnostics
 * remain text. Git/frecency annotations are metadata, never part of a path. */
export function parseGrepOutput(text: string): GrepOutputBlock[] {
  const blocks: GrepOutputBlock[] = []
  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index]
    const record = /^(.+?)([:\-])(\d+)\2 (.*)$/.exec(raw)
    const line = record ? Number(record[3]) : 0
    if (record && Number.isSafeInteger(line) && line > 0) {
      const row: GrepOutputLine = { path: record[1], line, text: record[4], match: record[2] === ':' }
      const previous = blocks.at(-1)
      if (previous?.kind === 'file' && previous.format === 'sdk' && previous.path === row.path) previous.rows.push(row)
      else blocks.push({ kind: 'file', format: 'sdk', path: row.path, rows: [row] })
    } else if (raw.trim() && groupedGrepLine(lines[index + 1] ?? '')) {
      const header = /^(.*?) {2}(\[(?:[^\]\r\n]+ in git|(?:VERY )?often touched file)\])$/.exec(raw)
      const path = header ? header[1] : raw
      const rows: GrepOutputLine[] = []
      let row
      while ((row = groupedGrepLine(lines[index + 1] ?? ''))) {
        rows.push({ path, ...row })
        index++
      }
      blocks.push({ kind: 'file', format: 'fff', path, annotation: header?.[2], rows })
    } else {
      const previous = blocks.at(-1)
      if (previous?.kind === 'text') previous.text += '\n' + raw
      else blocks.push({ kind: 'text', text: raw })
    }
  }
  return blocks
}

export function grepSearchOptions(args: Record<string, unknown>, grouped: boolean): FileSearchOptions {
  if (!grouped) return { regex: args.literal !== true, matchCase: args.ignoreCase !== true, wholeWord: false }
  // pi-fff auto-detects valid regex syntax and otherwise uses a literal. Its
  // caseSensitive option disables smart-case; lowercase patterns ignore case.
  const pattern = typeof args.pattern === 'string' ? args.pattern : ''
  let regex = /[.*+?^${}()|[\]\\]/.test(pattern)
  if (regex) {
    try { new RegExp(pattern) } catch { regex = false }
  }
  return { regex, matchCase: args.caseSensitive === true || /\p{Lu}/u.test(pattern), wholeWord: false }
}

/** Page source rows rather than raw headings/separators. Diagnostics remain
 * visible and a file header always arrives with its first visible source row. */
export function grepOutputWindow(text: string, lineLimit: number) {
  const capped = toolOutputWindow(text, Infinity)
  let remaining = lineLimit, hiddenLines = 0
  const blocks = parseGrepOutput(capped.text).flatMap<GrepOutputBlock>(block => {
    if (block.kind === 'text') return block.text.trim() ? [block] : []
    const count = Math.min(remaining, block.rows.length)
    remaining -= count
    hiddenLines += block.rows.length - count
    return count ? [{ ...block, rows: block.rows.slice(0, count) }] : []
  })
  return { blocks, hiddenLines, hardLimited: capped.hardLimited }
}

export function searchRoot(details: unknown): ToolSearchRootDTO | undefined {
  const root = (details as { piAppSearchRoot?: ToolSearchRootDTO } | undefined)?.piAppSearchRoot
  return root && typeof root.path === 'string' && root.path && (root.kind === 'file' || root.kind === 'directory') ? root : undefined
}

export function searchResultPath(path: string, args: Record<string, unknown>, cwd?: string | null, root?: ToolSearchRootDTO, grep = false): string | undefined {
  if (root?.kind === 'file') return root.path
  const requested = typeof args.path === 'string' && args.path ? normalizeSlashes(args.path).replace(/^@/, '') : '.'
  // Old results lack the root stamp. A basename equal to the requested root
  // could name either a file or a directory: keep it readable without a
  // speculative link. All other SDK relative paths have an unambiguous base.
  if (!root && grep && path === basename(requested.replace(/\/+$/, ''))) return undefined
  return resolveFromCwd(path, root?.path ?? resolveFromCwd(requested, cwd))
}

export function grepResultPath(file: GrepOutputFile, args: Record<string, unknown>, cwd?: string | null, root?: ToolSearchRootDTO): string | undefined {
  if (file.format === 'sdk') return searchResultPath(file.path, args, cwd, root, true)
  // pi-fff reports workspace-relative paths even when path is a directory,
  // filename or glob constraint. Its out-of-workspace auxiliary index can
  // reuse a broader root that is absent from the result: don't guess that base.
  if (isAbsolutePath(normalizeSlashes(file.path)) || isHomePath(file.path)) return resolveFromCwd(file.path, cwd)
  if (!cwd) return undefined
  const base = resolveFromCwd('.', cwd)
  const requested = typeof args.path === 'string' ? args.path.trim() : '.'
  const constraint = resolveFromCwd(requested || '.', cwd)
  if (isHomePath(constraint) || (constraint !== base && !constraint.startsWith(base.endsWith('/') ? base : `${base}/`))) return undefined
  return resolveFromCwd(file.path, cwd)
}

export function parseFileList(text: string): { paths: string[]; note: string } {
  const separator = text.indexOf('\n\n')
  return {
    paths: (separator < 0 ? text : text.slice(0, separator)).split('\n').filter(Boolean),
    note: separator < 0 ? '' : text.slice(separator + 2)
  }
}

/** A stamped read range describes content lines, excluding the SDK's notices. */
export function splitReadOutput(text: string, range?: ReadRangeDTO): { code: string; note: string } {
  if (!range || !Number.isSafeInteger(range.offset) || !Number.isSafeInteger(range.endLine) || range.offset < 1 || range.endLine < range.offset) return { code: text, note: '' }
  const lines = text.split('\n')
  const count = range.endLine - range.offset + 1
  return { code: lines.slice(0, count).join('\n'), note: lines.slice(count).join('\n').replace(/^\n+/, '') }
}

/** Bound mounted text and tokens. Whole-line paging exposes the complete SDK
 * output on demand; a hard cap also protects against arbitrary overrides. */
export function toolOutputWindow(text: string, lineLimit: number) {
  const hardLimited = text.length > 64_000
  const boundary = text.lastIndexOf('\n', 64_000)
  const capped = hardLimited ? text.slice(0, boundary < 0 ? 64_000 : boundary) : text
  const lines = capped.split('\n')
  return { text: lines.slice(0, lineLimit).join('\n'), hiddenLines: Math.max(0, lines.length - lineLimit), hardLimited }
}
