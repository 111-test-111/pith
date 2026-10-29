import { createHash } from 'node:crypto'
import { basename, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { mediaKindOf } from '../../shared/media'
import { parsePresentResult } from '../../shared/present'
import { IMAGE_TOOL_NAME, parseImageToolResult } from '../../shared/image'
import { parseImageReplayRecord } from '../../shared/image-replay'
import type { LibraryImageLabel, LibraryItem, LibrarySession, LibrarySource } from '../../shared/library'

export interface LibraryCandidate extends Omit<LibraryItem, 'storage' | 'size' | 'archivedPath'> {
  data?: { base64: string; mimeType: string }
}
type ObjectValue = Record<string, any>
const object = (value: unknown): ObjectValue => value && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : {}
const text = (value: unknown, max = 1000): string => typeof value === 'string' ? value.slice(0, max) : ''

/** Ordinary source inspection is not an attachment or a delivery. */
function inspectionTool(name: string): boolean {
  return /(?:^|[._:/])(?:read|read_file|read_image|view_image|open_file|file_read|image_read)$/.test(name.toLowerCase())
}

export function libraryCandidateAllowed(value: Pick<LibraryItem, 'source' | 'kind' | 'toolName'>): boolean {
  return !(value.kind === 'file' && value.source !== 'attachment' && value.source !== 'present')
    && !(value.kind === 'image' && (value.source === 'link' || value.source === 'download'))
    && !(value.source === 'tool-image' && inspectionTool(value.toolName ?? ''))
}
export function libraryToolImageLabel(toolName: string): LibraryImageLabel {
  return toolName === IMAGE_TOOL_NAME || /(?:image.?gen|generate.?image)/i.test(toolName) ? 'generated'
    : /(?:browser|screenshot)/i.test(toolName) ? 'screenshot' : 'tool'
}

function inlineImage(base: LibraryCandidate, block: ObjectValue, label: LibraryImageLabel, number?: number): LibraryCandidate {
  const mimeType = text(block.mimeType, 100)
  const extension = ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' } as Record<string, string>)[mimeType] ?? 'bin'
  const originalName = text(block.name ?? block.fileName, 300)
  return { ...base, kind: 'image', name: originalName ? basename(originalName) : label + '-' + base.id.slice(0, 12) + '.' + extension,
    ...(!originalName ? { imageLabel: label, ...(number ? { imageNumber: number } : {}) } : {}),
    data: { base64: block.data, mimeType } }
}

export function libraryUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 8192) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    url.username = ''; url.password = ''; url.hash = ''
    return url.href
  } catch { return null }
}

function localPath(value: string, cwd: string | null): string | null {
  if (!value || value.length > 4096 || value.includes('\0')) return null
  try {
    if (value.startsWith('file:')) return fileURLToPath(value)
    if (/^[a-z][a-z\d+.-]*:/i.test(value) && !/^[a-z]:[\\/]/i.test(value)) return null
    return isAbsolute(value) ? resolve(value) : cwd ? resolve(cwd, value) : null
  } catch { return null }
}

function candidate(session: LibrarySession, entryId: string, timestamp: number, source: LibrarySource, key: string): LibraryCandidate {
  return {
    id: createHash('sha256').update(JSON.stringify([session.id, entryId, source, key])).digest('hex'),
    kind: 'file', source, name: '', description: '', timestamp: Number.isFinite(timestamp) ? timestamp : 0,
    project: session.cwd, sessionId: session.id, sessionPath: session.path,
    sessionTitle: session.title.slice(0, 200), entryId
  }
}

function file(session: LibrarySession, entryId: string, timestamp: number, source: LibrarySource, path: string, description = ''): LibraryCandidate | null {
  const absolute = localPath(path, session.workspace ?? session.cwd)
  if (!absolute) return null
  return { ...candidate(session, entryId, timestamp, source, absolute),
    kind: mediaKindOf(absolute) === 'image' ? 'image' : 'file', name: basename(absolute),
    description: description.slice(0, 1000), originalPath: absolute }
}

/** Traverse only bounded result data. Headers, auth and request options are never retained. */
function resultLinks(value: unknown): Map<string, { title: string; excerpt: string }> {
  const links = new Map<string, { title: string; excerpt: string }>()
  const queue = [{ value, depth: 0 }]
  let nodes = 0
  const add = (url: unknown, title = '', excerpt = '') => {
    const normalized = libraryUrl(url)
    if (normalized && links.size < 64) {
      const previous = links.get(normalized)
      links.set(normalized, { title: title.slice(0, 300) || previous?.title || '', excerpt: excerpt.slice(0, 16_384) || previous?.excerpt || '' })
    }
  }
  while (queue.length && nodes++ < 2048) {
    const { value: current, depth } = queue.shift()!
    if (depth > 8) continue
    if (typeof current === 'string') {
      for (const match of current.slice(0, 128_000).matchAll(/https?:\/\/[^\s<>"\]\[)]+/g)) add(match[0].replace(/[.,;:!?]+$/, ''))
    } else if (Array.isArray(current)) {
      queue.push(...current.slice(0, 64).map(value => ({ value, depth: depth + 1 })))
    } else if (current && typeof current === 'object') {
      const record = object(current)
      const url = record.url ?? record.link ?? record.href
      add(url, text(record.title ?? record.name, 300), text(record.snippet ?? record.description ?? record.text ?? record.content, 16_384))
      for (const [key, value] of Object.entries(record).slice(0, 64)) {
        if (!/^(?:headers?|auth|authorization|cookies?|token|apiKey|options|base64)$/i.test(key)) queue.push({ value, depth: depth + 1 })
      }
    }
  }
  return links
}

function contentText(value: unknown): string {
  if (typeof value === 'string') return value.slice(0, 128_000)
  return Array.isArray(value) ? value.filter(block => object(block).type === 'text').slice(0, 32)
    .map(block => text(object(block).text, 128_000)).join('\n').slice(0, 128_000) : ''
}

/** Inputs are actual successful tool results, including nested calls. */
export function collectTool(session: LibrarySession, entryId: string, timestamp: number, toolName: string, args: unknown, resultValue: unknown): LibraryCandidate[] {
  const result = object(resultValue), input = object(args)
  const generated = toolName === IMAGE_TOOL_NAME ? parseImageToolResult(result.details) : null
  if (result.isError === true && !generated?.files.length) return []
  const candidates: LibraryCandidate[] = []
  if (toolName === 'present') {
    for (const value of parsePresentResult(result.details)?.files ?? []) {
      const item = file(session, entryId, timestamp, 'present', value.path, value.description)
      if (item) candidates.push({ ...item, toolName })
    }
  }
  const images = (Array.isArray(result.content) ? result.content.slice(0, 64) : []).map(object)
    .map((block, index) => ({ block, index })).filter(({ block }) => block.type === 'image' && typeof block.data === 'string')
  if (generated) generated.files.forEach((saved, number) => {
    const item = file(session, entryId, timestamp, 'tool-image', saved.path)
    if (item) candidates.push({ ...item, toolName, imageLabel: 'generated',
      // Keep the historic inline-image identity so reindexing neither duplicates
      // saved previews nor resurrects a user's removed item.
      id: candidate(session, entryId, timestamp, 'tool-image', String(images[number]?.index ?? number + 1)).id,
      ...(saved.width ? { imageWidth: saved.width } : {}), ...(saved.height ? { imageHeight: saved.height } : {}) })
  })
  else if (!inspectionTool(toolName)) images.forEach(({ block, index }, number) => {
    const label = libraryToolImageLabel(toolName)
    candidates.push({ ...inlineImage(candidate(session, entryId, timestamp, 'tool-image', String(index)), block, label, images.length > 1 ? number + 1 : undefined), toolName })
  })
  // Only user attachments and validated present/image receipts declare
  // local files. Tool prose and arbitrary result.path fields are not evidence.

  const lower = toolName.toLowerCase()
  const localSearch = /(?:tool_search|search_tools|searchtools|file_search|session_search|ctx_|grep|glob|find_file)/.test(lower)
  const network = !localSearch && /(?:search|fetch|download|browser|web(?:[._:/]|$))/.test(lower)
  if (network) {
    const source: LibrarySource = /search/.test(lower) || input.search_query ? 'search'
      : /fetch/.test(lower) || input.open ? 'fetch' : /download/.test(lower) ? 'download' : 'browser'
    const query = text(input.query ?? input.q ?? (Array.isArray(input.search_query) ? input.search_query.map(v => text(object(v).q)).join(' · ') : ''), 1000)
    const excerpt = contentText(result.content).slice(0, 16_384)
    const links = resultLinks({ content: result.content, details: result.details })
    const inputs = resultLinks({ url: input.url, urls: input.urls, open: input.open, requests: input.requests })
    // Fetch/navigation parameters name the requested site even if the output
    // omits it. Search results name discovered sites, rather than a provider URL.
    for (const [url, metadata] of inputs) if (!links.has(url)) links.set(url, metadata)
    for (const [url, metadata] of links) {
      candidates.push({ ...candidate(session, entryId, timestamp, source, url), kind: 'web',
        name: metadata.title || new URL(url).hostname, description: '', url, toolName,
        ...(query ? { query } : {}), excerpt: metadata.excerpt || excerpt })
    }
    if (!links.size && query) candidates.push({ ...candidate(session, entryId, timestamp, 'search', query),
      kind: 'web', name: query, description: '', toolName, query, excerpt })
  }
  return candidates.slice(0, 128)
}

function markdownLinks(session: LibrarySession, entryId: string, timestamp: number, prose: string): LibraryCandidate[] {
  const items: LibraryCandidate[] = []
  const root = fromMarkdown(prose.slice(0, 512_000))
  const definitions = new Map(root.children.filter(node => node.type === 'definition').map(node => [node.identifier.toLowerCase(), node.url]))
  const queue: any[] = [...root.children]
  let nodes = 0
  while (queue.length && items.length < 64 && nodes++ < 8192) {
    const node = queue.shift()!
    if (node.type === 'code' || node.type === 'inlineCode' || node.type === 'html') continue
    const target = node.type === 'link' || node.type === 'image' ? node.url
      : node.type === 'linkReference' || node.type === 'imageReference' ? definitions.get(node.identifier?.toLowerCase()) : undefined
    if (!target) { if (node.children) queue.push(...node.children); continue }
    const label = text(node.alt ?? node.children?.filter((v: { type: string }) => v.type === 'text').map((v: { value?: string }) => v.value).join(''), 300)
    const url = libraryUrl(target)
    if (url) items.push({ ...candidate(session, entryId, timestamp, 'link', url), kind: 'web', name: label || new URL(url).hostname, url })
  }
  return items
}

/** Both live and history collection share this parser. Calls supply typed
 * parameters, never executable instructions or claims scraped from prose. */
export function collectMessage(session: LibrarySession, entryId: string, messageValue: unknown, calls: Map<string, { name: string; args: unknown }>): LibraryCandidate[] {
  const message = object(messageValue)
  const timestamp = typeof message.timestamp === 'number' ? message.timestamp : 0
  const prose = contentText(message.content)
  if (message.role === 'assistant') {
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (object(block).type === 'toolCall' && typeof block.id === 'string') calls.set(block.id, { name: text(block.name), args: block.arguments })
    }
    while (calls.size > 4096) calls.delete(calls.keys().next().value!)
    return message.stopReason === 'error' || message.stopReason === 'aborted' ? [] : markdownLinks(session, entryId, timestamp, prose)
  }
  if (message.role === 'toolResult') {
    const call = calls.get(message.toolCallId)
    const items = message.toolName === 'present' && call?.name !== 'present' ? []
      : collectTool(session, entryId, timestamp, text(message.toolName), call?.args, message)
    // Historical nested records retain parameters/status, but not results.
    // Successful fetch/navigation URLs can still be indexed without inventing
    // missing search results, images or present declarations.
    for (const nested of Array.isArray(object(message.nestedCalls).calls) ? message.nestedCalls.calls.slice(0, 256) : []) {
      if (object(nested).status !== 'ok') continue
      items.push(...collectTool(session, 'nested:' + text(nested.id), timestamp, text(nested.name), nested.arguments, {}))
    }
    return items
  }
  if (message.role !== 'user') return []
  const items: LibraryCandidate[] = []
  const images = (Array.isArray(message.content) ? message.content.slice(0, 64) : []).map(object)
    .map((block, index) => ({ block, index })).filter(({ block }) => block.type === 'image' && typeof block.data === 'string')
  images.forEach(({ block, index }, number) => {
    items.push(inlineImage(candidate(session, entryId, timestamp, 'attachment', 'image:' + index), block, 'attachment', images.length > 1 ? number + 1 : undefined))
  })
  // Legacy prompts carry attachment paths in the app's <file> blocks.
  for (const match of prose.matchAll(/<file path="([^\n]+?)">([\s\S]*?)<\/file>/g)) {
    if (items.length >= 128) break
    if (match[2].startsWith('(could not be read:')) continue
    const item = file(session, entryId, timestamp, 'attachment', match[1])
    if (item) items.push(item)
  }
  return items
}

/** UI replay receipts are private session entries, not model messages. */
export function collectImageReplay(session: LibrarySession, entryId: string, data: unknown): LibraryCandidate[] {
  const replay = parseImageReplayRecord(data)
  if (!replay?.endedAt || !replay.result) return []
  return collectTool(session, entryId, replay.endedAt, IMAGE_TOOL_NAME, {},
    { details: replay.result, content: [], isError: replay.status === 'error' })
}

export function libraryDownload(session: LibrarySession, path: string, url: string, timestamp: number, key: string): LibraryCandidate[] {
  const normalized = libraryUrl(url)
  return normalized ? [{ ...candidate(session, 'download:' + key, timestamp, 'download', normalized), kind: 'web', name: basename(path), url: normalized }] : []
}
