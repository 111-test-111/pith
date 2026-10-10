import type { AgentSession, SessionManager } from '@earendil-works/pi-coding-agent'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { MAX_IMAGE_BYTES } from './image-limits'
import { IMAGE_TOOL_NAME, parseImageToolResult } from '../../shared/image'
import { parsePresentResult } from '../../shared/present'
import {
  IMAGE_GENERATION_ENTRY, IMAGE_REPLAY_ENTRY, IMAGE_PRESENTATION_ENTRY, parseImageGenerationRecord, parseImageReplayRecord,
  type ImageGenerationRecord, type ImageReplayRecord, type ImagePresentationRecord, type PresentedImageGeneration
} from '../../shared/image-replay'

/** Preserve presentation receipts on disk while removing app-only metadata
 * from every provider request copy, including SDK summarization requests. */
export function installImageReplayContextGuard(session: AgentSession): () => void {
  const previous = session.agent.streamFunction
  const overlay: typeof previous = (model, context, options) => {
    let changed = false
    const messages = context.messages.map(message => {
      if (message.role !== 'toolResult' || message.toolName !== 'present') return message
      const details = message.details
      if (!details || typeof details !== 'object' || Array.isArray(details) ||
        !('kind' in details) || details.kind !== 'pith-present-v1' ||
        !('files' in details) || !Array.isArray(details.files)) return message
      let changedFiles = false
      const files = details.files.map(file => {
        if (!file || typeof file !== 'object' || Array.isArray(file) || !('generation' in file)) return file
        const { generation: _generation, ...publicFile } = file
        changedFiles = true
        return publicFile
      })
      if (!changedFiles) return message
      changed = true
      return { ...message, details: { ...details, files } }
    })
    return previous(model, changed ? { ...context, messages } : context, options)
  }
  session.agent.streamFunction = overlay
  return () => { if (session.agent.streamFunction === overlay) session.agent.streamFunction = previous }
}

/** Freeze replay parameters outside model history when an image is delivered.
 * getBranch includes compacted ancestry and excludes abandoned branches. */
export async function capturePresentedImage(manager: SessionManager, path: string, size: number): Promise<PresentedImageGeneration | undefined> {
  const branch = manager.getBranch()
  const generations = new Map<string, ImageGenerationRecord>()
  const previews = new Map<string, Array<{ data: string; mimeType: string }>>()
  const calls = new Map<string, Record<string, unknown>>()
  for (const entry of branch) {
    if (entry.type === 'custom' && entry.customType === IMAGE_GENERATION_ENTRY) {
      const saved = parseImageGenerationRecord(entry.data)
      if (saved) generations.set(saved.id, saved)
    }
    if (entry.type === 'custom' && entry.customType === IMAGE_REPLAY_ENTRY) {
      const replay = parseImageReplayRecord(entry.data)
      const source = replay && generations.get(replay.generationId)
      if (source && replay?.endedAt && replay.result?.files.length) {
        generations.set(replay.id, { version: 1, id: replay.id, arguments: { ...source.arguments, n: 1 }, result: replay.result,
          ...(replay.fileHashes ? { fileHashes: replay.fileHashes } : {}) })
      }
    }
    if (entry.type !== 'message') continue
    if (entry.message.role === 'assistant') for (const block of entry.message.content) {
      if (block.type === 'toolCall' && block.name === IMAGE_TOOL_NAME) calls.set(block.id, block.arguments)
    }
    if (entry.message.role !== 'toolResult' || entry.message.toolName !== IMAGE_TOOL_NAME) continue
    const args = calls.get(entry.message.toolCallId)
    const result = parseImageToolResult(entry.message.details)
    if (args && result?.files.length) {
      const saved = generations.get(entry.message.toolCallId)
      generations.set(entry.message.toolCallId, { ...saved, version: 1, id: entry.message.toolCallId, arguments: structuredClone(args), result })
      previews.set(entry.message.toolCallId, entry.message.content.filter(block => block.type === 'image'))
    }
  }
  const candidates = [...generations.values()].reverse().flatMap(generation => generation.result.files
    .map((file, index) => ({ generation, file, index })).filter(candidate => candidate.file.size === size))
  if (!candidates.length || size > MAX_IMAGE_BYTES) return undefined
  const hash = await fileHash(path, size)
  if (!hash) return undefined
  for (const candidate of candidates.sort((a, b) => Number(b.file.path === path || b.generation.aliases?.[path] === b.file.path) - Number(a.file.path === path || a.generation.aliases?.[path] === a.file.path))) {
    const { generation, file, index } = candidate
    const direct = file.path === path || generation.aliases?.[path] === file.path
    let expected = generation.fileHashes?.[file.path]
    // Old raster receipts retained exact bytes. Do not use size or a visual
    // similarity as proof, and never confuse a rendered SVG preview with SVG.
    const images = previews.get(generation.id)
    const preview = images?.length === generation.result.files.length ? images[index] : undefined
    if (!expected && preview?.mimeType === file.mimeType && preview.data.length <= Math.ceil(MAX_IMAGE_BYTES / 3) * 4) {
      const bytes = Buffer.from(preview.data, 'base64')
      if (bytes.length === size) expected = createHash('sha256').update(bytes).digest('hex')
    }
    if (expected ? expected !== hash : !direct) continue
    // A regular source/reference with identical bytes remains ordinary while
    // the generated destination still exists. A rename must retire that path.
    if (!direct && !await missingFile(file.path)) continue
    const aliases = { ...generation.aliases, ...(!direct ? { [path]: file.path } : {}) }
    if (Object.keys(aliases).length > 128) continue
    const saved = { ...generation, ...(expected ? { fileHashes: { ...generation.fileHashes, [file.path]: expected } } : {}),
      ...(Object.keys(aliases).length ? { aliases } : {}) }
    const previous = branch.filter(entry => entry.type === 'custom' && entry.customType === IMAGE_GENERATION_ENTRY)
      .map(entry => parseImageGenerationRecord((entry as { data: unknown }).data)).findLast(record => record?.id === saved.id)
    if (JSON.stringify(previous) !== JSON.stringify(saved)) manager.appendCustomEntry(IMAGE_GENERATION_ENTRY, saved)
    const ratio = saved.arguments.aspect_ratio
    return { id: saved.id, result: { ...saved.result, files: saved.result.files.map(source => source.path === file.path ? { ...source, path } : source) },
      ...(typeof ratio === 'string' && /^\d+:\d+$/.test(ratio) ? { aspectRatio: ratio } : {}) }
  }
  return undefined
}

async function missingFile(path: string): Promise<boolean> {
  try { await lstat(path); return false } catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' }
}

async function fileHash(path: string, size: number): Promise<string | undefined> {
  let handle
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const before = await handle.stat()
    if (!before.isFile() || before.size !== size || size > MAX_IMAGE_BYTES) return undefined
    const hash = createHash('sha256'), buffer = Buffer.alloc(64 * 1024)
    let total = 0
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
      if (!bytesRead) break
      total += bytesRead
      if (total > size) return undefined
      hash.update(buffer.subarray(0, bytesRead))
    }
    const after = await handle.stat()
    return total === size && before.size === after.size && before.mtimeMs === after.mtimeMs ? hash.digest('hex') : undefined
  } catch { return undefined } finally { await handle?.close().catch(() => {}) }
}

/** Historical display repair uses private entries, never rewrites messages. */
export async function hydrateImagePresentations(manager: SessionManager): Promise<void> {
  const repaired = imagePresentationDetails(manager)
  const calls = new Set<string>()
  for (const entry of manager.getBranch()) {
    if (entry.type !== 'message') continue
    const message = entry.message
    if (message.role === 'assistant') for (const block of message.content) if (block.type === 'toolCall' && block.name === 'present') calls.add(block.id)
    if (message.role !== 'toolResult' || message.toolName !== 'present' || message.isError || !calls.has(message.toolCallId)) continue
    const result = repaired.get(entry.id) ?? parsePresentResult(message.details)
    if (!result) continue
    let changed = false
    const files = []
    for (const file of result.files) {
      const generation = file.generation ?? await capturePresentedImage(manager, file.path, file.size)
      changed ||= !!generation && !file.generation
      files.push({ ...file, ...(generation ? { generation } : {}) })
    }
    if (changed) manager.appendCustomEntry(IMAGE_PRESENTATION_ENTRY, { version: 1, entryId: entry.id, result: { kind: result.kind, files } })
  }
}

function parseImagePresentationRecord(value: unknown): ImagePresentationRecord | null {
  if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1 ||
    !('entryId' in value) || typeof value.entryId !== 'string' || !value.entryId || value.entryId.length > 256 || !('result' in value)) return null
  const result = parsePresentResult(value.result)
  return result ? { version: 1, entryId: value.entryId, result } : null
}

export function imagePresentationDetails(manager: SessionManager): Map<string, NonNullable<ReturnType<typeof parsePresentResult>>> {
  const branch = manager.getBranch(), result = new Map<string, NonNullable<ReturnType<typeof parsePresentResult>>>()
  const originals = new Map<string, NonNullable<ReturnType<typeof parsePresentResult>>>()
  const calls = new Set<string>()
  for (const entry of branch) {
    if (entry.type !== 'message') continue
    const message = entry.message
    if (message.role === 'assistant') for (const block of message.content) if (block.type === 'toolCall' && block.name === 'present') calls.add(block.id)
    if (message.role !== 'toolResult' || message.toolName !== 'present' || message.isError || !calls.has(message.toolCallId)) continue
    const receipt = parsePresentResult(message.details)
    if (receipt) originals.set(entry.id, receipt)
  }
  for (const entry of branch) {
    if (entry.type !== 'custom' || entry.customType !== IMAGE_PRESENTATION_ENTRY) continue
    const saved = parseImagePresentationRecord(entry.data)
    if (!saved) continue
    const receipt = originals.get(saved.entryId)
    if (receipt && receipt.files.length === saved.result.files.length && receipt.files.every((file, index) => file.path === saved.result.files[index].path && file.size === saved.result.files[index].size)) result.set(saved.entryId, saved.result)
  }
  return result
}

/** A private snapshot alone cannot authorize a paid retry: this exact file
 * must also have a successful presentation on the current selected branch. */
export function presentedGeneration(manager: SessionManager, generationId: string, path: string): ImageGenerationRecord | undefined {
  let generation: ImageGenerationRecord | undefined
  let presented = false
  const calls = new Set<string>()
  const repaired = imagePresentationDetails(manager)
  for (const entry of manager.getBranch()) {
    if (entry.type === 'custom' && entry.customType === IMAGE_GENERATION_ENTRY) {
      const value = parseImageGenerationRecord(entry.data)
      if (value?.id === generationId && value.result.files.some(file => file.path === path || value.aliases?.[path] === file.path)) generation = value
    }
    if (entry.type !== 'message') continue
    const message = entry.message
    if (message.role === 'assistant') for (const block of message.content) {
      if (block.type === 'toolCall' && block.name === 'present') calls.add(block.id)
    }
    if (message.role === 'toolResult' && message.toolName === 'present' && !message.isError && calls.has(message.toolCallId)) {
      presented ||= (repaired.get(entry.id) ?? parsePresentResult(message.details))?.files.some(file => file.path === path && file.generation?.id === generationId) ?? false
    }
  }
  return presented ? generation : undefined
}

export function imageReplayRecords(manager: SessionManager, activeId?: string): ImageReplayRecord[] {
  // Updates replace one attempt's status, never a different paid attempt.
  const attempts = new Map<string, ImageReplayRecord>()
  for (const entry of manager.getBranch()) {
    if (entry.type !== 'custom' || entry.customType !== IMAGE_REPLAY_ENTRY) continue
    const value = parseImageReplayRecord(entry.data)
    if (!value) continue
    attempts.set(JSON.stringify([value.generationId, value.sourcePath, value.id]), value)
  }
  const displayed = new Map<string, ImageReplayRecord>()
  const previousBySource = new Map<string, ImageReplayRecord>()
  for (const value of attempts.values()) {
    const source = JSON.stringify([value.generationId, value.sourcePath])
    const key = JSON.stringify([value.generationId, value.sourcePath, value.id])
    const previous = value.restoreId === null ? undefined : value.restoreId === undefined ? previousBySource.get(source)
      : displayed.get(JSON.stringify([value.generationId, value.sourcePath, value.restoreId]))
    const previousResult = previous?.status === 'complete' && previous.result?.files.length ? previous.result : previous?.previousResult
    const display = { ...value, ...(!value.result?.files.length && previousResult ? { previousResult } : {}) }
    const settled: ImageReplayRecord = value.id !== activeId && (value.status === 'queued' || value.status === 'generating')
      ? { ...display, status: 'error', interrupted: true } : display
    displayed.set(key, settled)
    previousBySource.set(source, settled)
  }
  return [...displayed.values()]
}
