import { parseImageToolResult, type ImageToolResult } from './image'
import type { PresentResult } from './present'

/** These SDK custom entries never become model messages. */
export const IMAGE_GENERATION_ENTRY = 'pith_image_generation_v1'
export const IMAGE_REPLAY_ENTRY = 'pith_image_replay_v1'
export const IMAGE_PRESENTATION_ENTRY = 'pith_image_presentation_v1'

export interface ImageGenerationRecord {
  version: 1
  id: string
  arguments: Record<string, unknown>
  result: ImageToolResult
  /** Private byte identity and verified renames; never tool arguments. */
  fileHashes?: Record<string, string>
  aliases?: Record<string, string>
}

export interface ImagePresentationRecord { version: 1; entryId: string; result: PresentResult }

/** Display metadata only. Replay arguments stay in main-owned custom entries. */
export interface PresentedImageGeneration {
  id: string
  result: ImageToolResult
  aspectRatio?: string
}

export interface ImageReplayRecord {
  version: 1
  id: string
  generationId: string
  sourcePath: string
  status: 'queued' | 'generating' | 'complete' | 'error'
  startedAt: number
  endedAt?: number
  result?: ImageToolResult
  fileHashes?: Record<string, string>
  error?: string
  /** The displayed attempt before retry, or null for the original image. */
  restoreId?: string | null
  /** Explicit cancellation restores the image visible before this attempt. */
  cancelled?: boolean
  interrupted?: boolean
  /** Display-only receipt retained for cancellation, never a failed preview. */
  previousResult?: ImageToolResult
}

export interface ImageReplayRequest { sessionPath: string; generationId: string; path: string; restoreId?: string | null }
/** All selected-branch attempts in creation order, one current state per id. */
export interface ImageReplaySnapshot { sessionPath: string; revision: number; items: ImageReplayRecord[] }

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256
const path = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\0') && /^(?:\/|[a-z]:[\\/]|\\\\)/i.test(value)
function hashes(value: unknown, result: ImageToolResult): Record<string, string> | undefined | null {
  if (value === undefined) return undefined
  if (!record(value) || Object.keys(value).length > 10 || Object.entries(value).some(([key, hash]) =>
    !result.files.some(file => file.path === key) || typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash))) return null
  return value as Record<string, string>
}

export function parsePresentedImageGeneration(value: unknown): PresentedImageGeneration | null {
  if (!record(value) || !id(value.id)) return null
  const result = parseImageToolResult(value.result)
  if (!result || !result.files.length) return null
  const aspectRatio = value.aspectRatio
  if (aspectRatio !== undefined && (typeof aspectRatio !== 'string' || !/^\d+:\d+$/.test(aspectRatio))) return null
  return { id: value.id, result, ...(aspectRatio ? { aspectRatio: aspectRatio as string } : {}) }
}

export function parseImageGenerationRecord(value: unknown): ImageGenerationRecord | null {
  if (!record(value) || value.version !== 1 || !id(value.id) || !record(value.arguments)) return null
  const result = parseImageToolResult(value.result)
  if (!result || !result.files.length) return null
  const fileHashes = hashes(value.fileHashes, result)
  if (fileHashes === null || value.aliases !== undefined && (!record(value.aliases) || Object.keys(value.aliases).length > 128 ||
    Object.entries(value.aliases).some(([alias, source]) => !path(alias) || typeof source !== 'string' || !result.files.some(file => file.path === source)))) return null
  try { if (JSON.stringify(value.arguments).length > 128_000) return null } catch { return null }
  return { version: 1, id: value.id, arguments: value.arguments, result,
    ...(fileHashes ? { fileHashes } : {}), ...(value.aliases ? { aliases: value.aliases as Record<string, string> } : {}) }
}

export function parseImageReplayRecord(value: unknown): ImageReplayRecord | null {
  if (!record(value) || value.version !== 1 || !id(value.id) || !id(value.generationId) ||
    typeof value.sourcePath !== 'string' || value.sourcePath.length > 4096 || value.sourcePath.includes('\0') ||
    !/^(?:\/|[a-z]:[\\/]|\\\\)/i.test(value.sourcePath) ||
    !['queued', 'generating', 'complete', 'error'].includes(value.status as string) ||
    typeof value.startedAt !== 'number' || !Number.isSafeInteger(value.startedAt) || value.startedAt < 0 ||
    (value.endedAt !== undefined && (typeof value.endedAt !== 'number' || !Number.isSafeInteger(value.endedAt) || value.endedAt < value.startedAt)) ||
    (value.cancelled !== undefined && typeof value.cancelled !== 'boolean') ||
    (value.restoreId !== undefined && value.restoreId !== null && !id(value.restoreId)) ||
    (value.error !== undefined && (typeof value.error !== 'string' || value.error.length > 8000))) return null
  const result = value.result === undefined ? undefined : parseImageToolResult(value.result)
  if (result === null || value.status === 'complete' && !result?.files.length) return null
  const fileHashes = result ? hashes(value.fileHashes, result) : undefined
  if (fileHashes === null || !result && value.fileHashes !== undefined) return null
  return { version: 1, id: value.id, generationId: value.generationId, sourcePath: value.sourcePath,
    status: value.status as ImageReplayRecord['status'], startedAt: value.startedAt,
    ...(value.endedAt === undefined ? {} : { endedAt: value.endedAt as number }),
    ...(result ? { result } : {}), ...(value.error ? { error: value.error as string } : {}),
    ...(fileHashes ? { fileHashes } : {}),
    ...(value.restoreId === undefined ? {} : { restoreId: value.restoreId as string | null }),
    ...(value.cancelled === true ? { cancelled: true } : {}),
    ...(value.interrupted === true ? { interrupted: true } : {}) }
}
