import { parsePresentedImageGeneration, type PresentedImageGeneration } from './image-replay'

export const PRESENT_TOOL_NAME = 'present'
export interface PresentedFile {
  path: string
  description?: string
  size: number
  /** Stamped from a matching committed image receipt, never supplied by a model. */
  generation?: PresentedImageGeneration
}
export interface PresentResult {
  kind: 'pith-present-v1'
  files: PresentedFile[]
}
/** Only successful, app-stamped results declare deliveries. Stored/IPC data is
 * validated before a file action can consume it. */
export function parsePresentResult(value: unknown): PresentResult | null {
  if (!value || typeof value !== 'object' || !('kind' in value) || value.kind !== 'pith-present-v1'
    || !('files' in value) || !Array.isArray(value.files) || value.files.length > 8) return null
  const files: PresentedFile[] = []
  for (const file of value.files) {
    if (!file || typeof file !== 'object' || typeof file.path !== 'string' || !file.path || file.path.length > 4096
      || !(/^(?:\/|[a-z]:[\\/]|\\\\[^\\]+\\[^\\]+)/i.test(file.path)) || file.path.includes('\0') || !Number.isSafeInteger(file.size) || file.size < 0
      || (file.description !== undefined && (typeof file.description !== 'string' || file.description.length > 1000))) return null
    const generation = file.generation === undefined ? undefined : parsePresentedImageGeneration(file.generation)
    if (generation === null || generation && !generation.result.files.some(image => image.path === file.path && image.size === file.size)) return null
    files.push({ path: file.path, size: file.size, ...(file.description ? { description: file.description } : {}), ...(generation ? { generation } : {}) })
  }
  return files.length ? { kind: 'pith-present-v1', files } : null
}
