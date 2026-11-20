/** Main-owned image analysis. References never contain image bytes or file paths. */
export const VISION_TOOL_NAME = 'vision_analyze'
export const VISION_ANALYSIS_ENTRY = 'pith_vision_analysis_v1'
export const VISION_TOOL_KIND = 'pith-vision-v1'

export interface VisionModelSelection { providerId: string; modelId: string }
export function normalizeVisionModel(value: unknown): VisionModelSelection | null {
  if (!value || typeof value !== 'object') return null
  const model = value as VisionModelSelection
  return typeof model.providerId === 'string' && !!model.providerId.trim() && model.providerId.length <= 256 &&
    typeof model.modelId === 'string' && !!model.modelId.trim() && model.modelId.length <= 512
    ? { providerId: model.providerId, modelId: model.modelId } : null
}
export function supportsImageInput(model: { input?: readonly string[] } | null | undefined): boolean {
  return model?.input?.includes('image') === true
}

export const VISION_ERROR_CODES = ['not-configured', 'model-missing', 'model-text-only', 'auth', 'images-disabled',
  'invalid-image', 'image-limit', 'unknown-image', 'unavailable', 'timeout', 'cancelled', 'request-failed', 'empty-result'] as const
export type VisionErrorCode = (typeof VISION_ERROR_CODES)[number]
export interface VisionErrorDTO { kind: 'vision'; code: VisionErrorCode; model?: string; detail?: string }
export interface VisionProgressDTO extends VisionModelSelection { id: string; imageCount: number }
export interface VisionStateDTO { revision: number; progress: VisionProgressDTO | null; error?: VisionErrorDTO }
export interface PromptAdmissionDTO { accepted: boolean; visionError?: VisionErrorDTO }
export interface VisionToolDetails {
  kind: typeof VISION_TOOL_KIND
  providerId?: string
  modelId?: string
  imageRefs?: string[]
  error?: VisionErrorDTO
}
export function visionToolError(value: unknown): VisionErrorDTO | null {
  const details = value as VisionToolDetails | null
  const error = details?.kind === VISION_TOOL_KIND ? details.error : null
  return error?.kind === 'vision' && VISION_ERROR_CODES.includes(error.code) ? error : null
}

export interface VisionAnalysisRecord extends VisionModelSelection {
  version: 1
  id: string
  key: string
  mode: 'automatic' | 'tool'
  imageRefs: string[]
  imageHashes: string[]
  prompt: string
  text: string
}
