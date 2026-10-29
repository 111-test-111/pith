/**
 * Shared contract for the app's `image` tool.
 *
 * The tool paints through OpenRouter. Two protocols exist there and both are
 * supported:
 *
 * - `native` — `POST /api/v1/images`, the documented image endpoint. Accepts
 *   the full parameter set (resolution, aspect ratio, quality, output format,
 *   background, multiple images, reference images). Registered as the
 *   `openrouter-native-images` Pi image API.
 * - `chat` — Pi's own `openrouter-images` API, which drives models that emit
 *   images as chat/completions content (`openai/gpt-5-image`,
 *   `google/gemini-3-pro-image`). Models that only serve `/api/v1/images`
 *   (`openai/gpt-image-*`) reject this protocol with a 404, and models that
 *   only serve chat reject the native one.
 *
 * `protocol: "auto"` resolves the pair by trying native first and remembering
 * the answer per model, so the mismatch costs at most one failed request.
 */
export const IMAGE_TOOL_NAME = 'image'
export const IMAGE_TOOL_KIND = 'pi-app-image'

export type ImageToolAction = 'generate' | 'edit'
export type ImageToolProtocol = 'auto' | 'native' | 'chat'
export type ResolvedImageProtocol = Exclude<ImageToolProtocol, 'auto'>

/** OpenRouter's resolution tiers, plus the legacy `512` shorthand. */
export const IMAGE_RESOLUTIONS = ['512', '768', '1K', '1.5K', '2K', '4K'] as const
export const IMAGE_ASPECT_RATIOS = [
  'auto', '1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '4:5', '5:4',
  '1:2', '2:1', '21:9', '9:21', '1:4', '4:1', '1:8', '8:1'
] as const
export const IMAGE_QUALITIES = ['auto', 'low', 'medium', 'high'] as const
export const IMAGE_OUTPUT_FORMATS = ['png', 'jpeg', 'webp', 'svg'] as const
export const IMAGE_BACKGROUNDS = ['auto', 'transparent', 'opaque'] as const
export const IMAGE_DATA_COLLECTIONS = ['deny', 'allow'] as const
/** OpenRouter caps a single request at 10 images. */
export const IMAGE_MAX_COUNT = 10

export interface GeneratedImageFile {
  /** Absolute path of the written file. */
  path: string
  mimeType: string
  size: number
  /** Pixel dimensions when the payload could be read; absent for SVG. */
  width?: number
  height?: number
}

export interface ImageToolUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  /** USD as reported by OpenRouter for this call, when it reported one. */
  costUsd: number
}

export interface ImageToolResult {
  kind: typeof IMAGE_TOOL_KIND
  action: ImageToolAction
  /** OpenRouter model slug, for example `openai/gpt-image-2.5-flare`. */
  model: string
  protocol: ResolvedImageProtocol
  prompt: string
  files: GeneratedImageFile[]
  /** Provider-rewritten prompt, when the upstream returns one. */
  revisedPrompt?: string
  /** Text the model returned alongside the images. */
  text?: string
  usage?: ImageToolUsage
  /** Explicitly unsupported controls on the selected protocol. */
  ignoredParameters?: string[]
  /** The returned encoding required changing an explicit filename. */
  renamed?: boolean
  /** Failure after a request. files contains only successfully committed writes,
   * including partial success; never planned destinations. */
  error?: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

const isOptionalCount = (value: unknown): boolean => value === undefined || isCount(value)

/** Absolute POSIX, drive-letter or UNC path — a result may only describe a
 * file the app itself could have written. */
const isAbsolutePath = (value: string): boolean =>
  /^(?:\/|[a-z]:[\\/]|\\\\[^\s\\]+\\[^\s\\]+)/i.test(value)

const MIME_BY_FORMAT: Record<string, string> = {
  png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp', svg: 'image/svg+xml'
}

/** Media type of a written file, or the PNG default when the provider was silent. */
export function imageMimeType(format: string | undefined, reported: string | undefined): string {
  if (reported && /^image\/[a-z0-9.+-]+$/i.test(reported)) return reported.toLowerCase()
  return (format && MIME_BY_FORMAT[format]) || 'image/png'
}

/** Extension for a media type, preferring the provider's format when known. */
export function imageExtension(mimeType: string, format?: string): string {
  if (format === 'jpeg') return 'jpg'
  if (format && MIME_BY_FORMAT[format]) return format
  const subtype = mimeType.replace(/^image\//i, '').toLowerCase()
  return subtype === 'jpeg' ? 'jpg' : subtype === 'svg+xml' ? 'svg' : subtype || 'png'
}

/**
 * Historical and IPC results are re-validated before a consumer may act on
 * them. Anything that is not an app-stamped, well-formed result is rejected
 * wholesale rather than partially trusted.
 */
export function parseImageToolResult(value: unknown): ImageToolResult | null {
  if (!isRecord(value) || value.kind !== IMAGE_TOOL_KIND) return null
  const { action, model, protocol, prompt, files, revisedPrompt, text, usage, error, ignoredParameters, renamed } = value
  if (action !== 'generate' && action !== 'edit') return null
  if (protocol !== 'native' && protocol !== 'chat') return null
  if (typeof model !== 'string' || !model || model.length > 256) return null
  if (typeof prompt !== 'string' || prompt.length > 32000) return null
  if (error !== undefined && (typeof error !== 'string' || !error || error.length > 8000)) return null
  if (!Array.isArray(files) || (!files.length && !error) || files.length > IMAGE_MAX_COUNT) return null
  if (ignoredParameters !== undefined && (!Array.isArray(ignoredParameters) || ignoredParameters.length > 16 ||
    ignoredParameters.some(key => typeof key !== 'string' || !/^[a-z_]{1,40}$/.test(key)))) return null
  const parsed: GeneratedImageFile[] = []
  for (const file of files) {
    if (!isRecord(file)) return null
    const { path, mimeType, size, width, height } = file
    if (typeof path !== 'string' || !path || path.length > 4096 || path.includes('\0') || !isAbsolutePath(path)) return null
    if (typeof mimeType !== 'string' || !/^image\/[a-z0-9.+-]+$/i.test(mimeType)) return null
    if (!isCount(size)) return null
    if (!isOptionalCount(width) || !isOptionalCount(height)) return null
    parsed.push({
      path, mimeType, size,
      ...(width === undefined ? {} : { width: width as number }),
      ...(height === undefined ? {} : { height: height as number })
    })
  }
  let parsedUsage: ImageToolUsage | undefined
  if (usage !== undefined) {
    if (!isRecord(usage)) return null
    const { inputTokens, outputTokens, totalTokens, costUsd } = usage
    if (!isCount(inputTokens) || !isCount(outputTokens) || !isCount(totalTokens)) return null
    if (typeof costUsd !== 'number' || !Number.isFinite(costUsd) || costUsd < 0) return null
    parsedUsage = { inputTokens, outputTokens, totalTokens, costUsd }
  }
  return {
    kind: IMAGE_TOOL_KIND, action, model, protocol, prompt, files: parsed,
    ...(error ? { error: error as string } : {}),
    ...(ignoredParameters ? { ignoredParameters: ignoredParameters as string[] } : {}),
    ...(renamed === true ? { renamed: true } : {}),
    ...(typeof revisedPrompt === 'string' && revisedPrompt ? { revisedPrompt: revisedPrompt.slice(0, 32000) } : {}),
    ...(typeof text === 'string' && text ? { text: text.slice(0, 32000) } : {}),
    ...(parsedUsage ? { usage: parsedUsage } : {})
  }
}
