/**
 * The app's `image` tool: generate and edit images through OpenRouter.
 *
 * The tool is deliberately model-first and protocol-aware. Both OpenRouter
 * protocols are reachable — the native `/api/v1/images` endpoint (registered by
 * `image-protocol.ts` as the `openrouter-native-images` Pi image API) and Pi's
 * own chat/completions image API — and `protocol: "auto"` resolves which one a
 * model actually serves, remembering the answer so the mismatch costs at most
 * one failed request.
 *
 * Bytes land on disk. Every target is resolved through the session's file
 * policy first (`writableTarget`) and the target is validated *before* the
 * request is sent, so a denied path never costs an image generation.
 */
import { defineTool, detectSupportedImageMimeTypeFromFile, getAgentDir, type ModelRuntime } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { createHash } from 'node:crypto'
import type { ImageGenerationRecord } from '../../shared/image-replay'
import { mkdir, open, stat, lstat } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve, sep } from 'node:path'
import { writableTarget } from './file-tools'
import { commitImageFile } from './image-files'
import { MAX_IMAGE_BYTES, validateGeneratedImage } from './image-output'
import type { SandboxMode } from '../sandbox/types'
import {
  ensureOpenRouterNativeImages, IMAGE_PARAMS_METADATA_KEY, isProtocolMismatch, nativeModelFor,
  imageRouting, imageResponseFetch, IMAGE_REQUEST_TIMEOUT_MS,
  OPENROUTER_SOURCE_PROVIDER_ID, type ImageGenerationResult, type ImageRequestContent,
  type ImageRequestParams
} from './image-protocol'
import {
  IMAGE_ASPECT_RATIOS, IMAGE_BACKGROUNDS, IMAGE_DATA_COLLECTIONS, IMAGE_MAX_COUNT,
  IMAGE_OUTPUT_FORMATS, IMAGE_QUALITIES, IMAGE_RESOLUTIONS, IMAGE_TOOL_KIND, IMAGE_TOOL_NAME,
  imageExtension, type GeneratedImageFile, type ImageToolAction,
  type ImageToolProtocol, type ImageToolResult, type ResolvedImageProtocol
} from '../../shared/image'

/** Tool-result content block, taken from the SDK so the shape cannot drift. */
type ContentBlock = Parameters<ModelRuntime['generateImages']>[1]['input'][number]

/**
 * Default model. Chosen for availability rather than peak quality: it answered
 * on both protocols and from both a restricted and an unrestricted region in
 * testing, and it is inexpensive. Callers override it with `model`.
 */
const DEFAULT_MODEL = 'black-forest-labs/flux.2-klein-4b'
/** Subdirectory generated images go to when the caller names no path. */
const DEFAULT_DIRECTORY = 'images'
const MAX_INPUT_IMAGES = 8
const MAX_INPUT_IMAGE_BYTES = MAX_IMAGE_BYTES

function stringEnum<T extends readonly string[]>(values: T, description?: string) {
  return Type.Union(values.map((value) => Type.Literal(value)), { description })
}

const parameters = Type.Object({
  action: stringEnum(['generate', 'edit'] as const,
    'generate paints from the prompt alone; edit also takes input_images to modify or use as references.'),
  prompt: Type.String({ minLength: 1, maxLength: 32000, description: 'What to draw, or how to change the input images. Be specific about subject, style, lighting and composition.' }),
  model: Type.Optional(Type.String({ minLength: 1, maxLength: 256, description: `OpenRouter image model slug selected using the openrouter-image skill. Defaults to ${DEFAULT_MODEL}.` })),
  protocol: Type.Optional(stringEnum(['auto', 'native', 'chat'] as const,
    'auto (default) picks the protocol the model serves and remembers it. native is OpenRouter /api/v1/images; chat is chat/completions. Use native for required generation controls; use chat for documented data_collection routing.')),
  input_images: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), {
    minItems: 1, maxItems: MAX_INPUT_IMAGES,
    description: 'Paths of images to edit or use as references. Required for edit. Relative paths use the session working directory.'
  })),
  n: Type.Optional(Type.Integer({ minimum: 1, maximum: IMAGE_MAX_COUNT, description: 'Upper bound on images to return. Providers may return fewer, and single-image models reject more than one.' })),
  resolution: Type.Optional(stringEnum(IMAGE_RESOLUTIONS, 'Model-specific resolution tier; see the skill for support and combinations.')),
  aspect_ratio: Type.Optional(stringEnum(IMAGE_ASPECT_RATIOS, 'Model-specific output ratio; see the skill for support and combinations.')),
  size: Type.Optional(Type.String({ minLength: 2, maxLength: 32, description: 'Model-specific dimensions or tier shorthand; see the skill for values and conflicts.' })),
  quality: Type.Optional(stringEnum(IMAGE_QUALITIES, 'Rendering quality where supported; see the skill.')),
  output_format: Type.Optional(stringEnum(IMAGE_OUTPUT_FORMATS, 'Returned encoding where supported; see the skill.')),
  background: Type.Optional(stringEnum(IMAGE_BACKGROUNDS, 'Background mode where supported; see the skill for alpha requirements.')),
  output_compression: Type.Optional(Type.Integer({ minimum: 0, maximum: 100, description: 'Encoding compression where supported; see the skill for compatible formats.' })),
  seed: Type.Optional(Type.Integer({ minimum: 0, description: 'Seed for reproducible output, where the provider supports one.' })),
  allow_fallbacks: Type.Optional(Type.Boolean({ description: 'Let OpenRouter fall back to another provider when the chosen one fails.' })),
  require_parameters: Type.Optional(Type.Boolean({ description: 'Reject a chat downgrade that cannot apply requested generation controls. Forwarded to OpenRouter; native capability filtering is unverified. See the skill.' })),
  data_collection: Type.Optional(stringEnum(IMAGE_DATA_COLLECTIONS, 'Chat provider data-collection routing. Native image enforcement is unverified; do not rely on this field for a native privacy requirement. See the skill.')),
  only: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 16, description: 'Allow-list of upstream provider slugs.' })),
  order: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 16, description: 'Preferred upstream provider order.' })),
  ignore: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 16, description: 'Deny-list of upstream provider slugs.' })),
  output_path: Type.Optional(Type.String({ minLength: 1, maxLength: 4096, description: `File or directory to write to. Defaults to a short prompt-based name under ${DEFAULT_DIRECTORY}/ in the session working directory. Prefer an explicit, content-related filename.` })),
  overwrite: Type.Optional(Type.Boolean({ description: 'Allow replacing an existing file at an explicit output_path. Defaults to false.' }))
})

export interface ImageToolOptions {
  cwd: string
  runtime: ModelRuntime
  /** Defaults to the global Pi skill; also readable when automatic discovery is disabled. */
  skillPath?: string
  getMode: () => SandboxMode
  /** Live Plan read: writing generated bytes is a file effect, so Plan refuses it. */
  isPlanRestricted?: () => boolean
  canStart: () => boolean
  getTimeoutMs?: () => number
  /** Main-owned UI replay destination; absent from the model tool schema. */
  replayFile?: string
  recordGeneration?: (record: ImageGenerationRecord) => void
}

/**
 * Protocol already proven for a model id. OpenRouter's protocol support is a
 * property of the model, not of this session, so one process-wide map is right;
 * a wrong guess costs one discarded request and then never repeats.
 */
const proven = new Map<string, ResolvedImageProtocol>()

function protocolParams(args: Record<string, unknown>): ImageRequestParams {
  const routing = {
    allowFallbacks: args.allow_fallbacks as boolean | undefined,
    requireParameters: args.require_parameters as boolean | undefined,
    dataCollection: args.data_collection as 'deny' | 'allow' | undefined,
    only: args.only as string[] | undefined,
    order: args.order as string[] | undefined,
    ignore: args.ignore as string[] | undefined
  }
  const hasRouting = Object.values(routing).some((value) => value !== undefined)
  const params: ImageRequestParams = {}
  if (args.n !== undefined) params.n = args.n as number
  if (args.resolution !== undefined) params.resolution = args.resolution as string
  if (args.aspect_ratio !== undefined) params.aspectRatio = args.aspect_ratio as string
  if (args.size !== undefined) params.size = args.size as string
  if (args.quality !== undefined) params.quality = args.quality as string
  if (args.output_format !== undefined) params.outputFormat = args.output_format as string
  if (args.background !== undefined) params.background = args.background as string
  if (args.output_compression !== undefined) params.outputCompression = args.output_compression as number
  if (args.seed !== undefined) params.seed = args.seed as number
  if (hasRouting) params.routing = routing
  return params
}

/** Which parameters the chat/completions protocol cannot express. */
const CHAT_PROTOCOL_UNSUPPORTED = ['n', 'resolution', 'aspect_ratio', 'size', 'quality', 'output_format', 'background', 'output_compression', 'seed']

/** A short fallback; explicit content names remain preferable. */
function imageName(prompt: string): string {
  const words = prompt.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').split('-').slice(0, 5).join('-')
  return Array.from(words).slice(0, 40).join('').replace(/-+$/, '') || 'image'
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/**
 * Replace, or add, the extension so the name describes the bytes on disk.
 *
 * The provider picks the encoding, so a request for a `.png` name can come back
 * as JPEG. Mislabelled bytes are not cosmetic here: the app's file preview
 * chooses a decoder from the extension, so a PNG name over JPEG data fails to
 * open.
 */
function withExtension(path: string, extension: string): string {
  const current = extname(path)
  if (current.slice(1).toLowerCase() === extension) return path
  return `${current ? path.slice(0, -current.length) : path}.${extension}`
}

/**
 * Where the bytes will go, decided before the request is sent.
 *
 * `output_path` may name a file (one image only) or a directory. Everything is
 * funnelled through `writableTarget`, so an illegal target fails here — cheaply
 * — instead of after the generation has been paid for.
 */
async function resolveTargets(
  args: Record<string, unknown>,
  count: number,
  options: ImageToolOptions
): Promise<{ directory: string; base: string; fixed?: string; overwrite: boolean }> {
  const mode = options.getMode()
  if (options.replayFile) {
    const source = writableTarget(options.replayFile, options.cwd, mode)
    const directory = writableTarget(dirname(source), options.cwd, mode)
    await mkdir(directory, { recursive: true })
    return { directory, base: basename(source, extname(source)), overwrite: false }
  }
  const overwrite = args.overwrite === true
  const requested = typeof args.output_path === 'string' ? args.output_path.trim() : ''
  const base = imageName(typeof args.prompt === 'string' ? args.prompt : '')

  if (!requested) {
    const directory = writableTarget(join(options.cwd, DEFAULT_DIRECTORY), options.cwd, mode)
    await mkdir(directory, { recursive: true })
    return { directory, base, overwrite }
  }

  const target = resolve(options.cwd, requested)
  const directoryHint = requested.endsWith('/') || requested.endsWith(sep)
  const info = await stat(target).catch(error => { if (error.code === 'ENOENT') return null; throw error })
  const isDirectory = directoryHint || (info ? info.isDirectory() : !extname(target))
  if (isDirectory) {
    const directory = writableTarget(target, options.cwd, mode)
    await mkdir(directory, { recursive: true })
    return { directory, base, overwrite }
  }
  if (count > 1) {
    throw new Error(`output_path ${requested} names one file, but ${count} images were requested. Pass a directory instead.`)
  }
  const fixed = writableTarget(target, options.cwd, mode)
  // An explicit path is the one case where a name can already be taken, so the
  // overwrite contract is enforced here — before the request is sent, not after
  // the generation has been paid for.
  if (!overwrite && await exists(fixed)) {
    throw new Error(`output_path ${requested} already exists. Pass overwrite: true to replace it, or choose another path.`)
  }
  await mkdir(dirname(fixed), { recursive: true })
  return { directory: dirname(fixed), base, fixed, overwrite }
}

/** Read the edit sources. Reads are unrestricted, exactly like the SDK's own. */
async function readInputImages(paths: readonly string[], cwd: string): Promise<ImageRequestContent[]> {
  const blocks: ImageRequestContent[] = []
  let total = 0
  for (const entry of paths) {
    if (entry.includes('\0')) throw new Error('input_images contains an invalid path')
    const path = resolve(cwd, entry)
    const info = await stat(path).catch(() => null)
    if (!info?.isFile()) throw new Error(`input_images entry is not an existing file: ${entry}`)
    if (info.size > MAX_INPUT_IMAGE_BYTES) {
      throw new Error(`input_images entry is too large (${Math.round(info.size / 1024 / 1024)} MB): ${entry}`)
    }
    const mimeType = await detectSupportedImageMimeTypeFromFile(path)
    if (!mimeType) throw new Error(`input_images entry is not a supported image (png, jpeg, gif or webp): ${entry}`)
    const handle = await open(path, 'r')
    const chunks: Buffer[] = []
    let size = 0
    try {
      // Bound the actual read as well as the earlier stat: an input may grow
      // while the image request is being prepared.
      for await (const chunk of handle.createReadStream()) {
        size += chunk.length
        total += chunk.length
        if (size > MAX_INPUT_IMAGE_BYTES || total > 64 * 1024 * 1024) throw new Error('Input images exceed the size limit.')
        chunks.push(chunk)
      }
    } finally { await handle.close() }
    const bytes = Buffer.concat(chunks)
    const block = { type: 'image' as const, data: bytes.toString('base64'), mimeType }
    await validateGeneratedImage(block)
    blocks.push(block)
  }
  return blocks
}

/** Model ids worth suggesting when the requested one does not resolve. */
async function suggestions(runtime: ModelRuntime, modelId: string): Promise<string[]> {
  const available = await runtime.getAvailableOfType('image').catch(() => [])
  const [head, tail] = modelId.split('/')
  const tokens = [tail ?? head, head].filter((token): token is string => Boolean(token)).map((token) => token.toLowerCase())
  const matching = available.filter(model => tokens.some((token) => model.id.toLowerCase().includes(token)))
  return (matching.length > 0 ? matching : available).slice(0, 12).map(model => model.id)
}

function failureText(result: ImageGenerationResult, modelId: string, protocol: ResolvedImageProtocol): string {
  const detail = result.errorMessage ?? 'no reason reported'
  const aborted = result.stopReason === 'aborted' ? ' (the call was cancelled)' : ''
  return `${modelId} did not produce an image over the ${protocol} protocol${aborted}: ${detail}`
}

export function createImageTool(options: ImageToolOptions) {
  const skillPath = options.skillPath ?? join(getAgentDir(), 'skills', 'openrouter-image', 'SKILL.md')
  return defineTool<typeof parameters, ImageToolResult>({
    name: IMAGE_TOOL_NAME,
    label: 'Generate or edit image',
    promptSnippet: 'Generate or edit images with OpenRouter; read the openrouter-image skill first',
    description: `Before calling this tool, you MUST read and follow the global Pi skill openrouter-image's SKILL.md at ${JSON.stringify(skillPath)} and its relevant model/parameter references; resolve reference paths relative to that skill directory. Reuse them if already loaded in context. Generate or edit an image through OpenRouter and save it to disk. Model choices, compatible parameter values, combinations and editing details live in that skill. Respect a model explicitly selected by the user. Choose a short content-related output filename without timestamps or model names. You MUST use present for every successfully saved image, including partial successes. Results include previews, committed file paths, billing and parameter warnings.`,
    parameters,
    executionMode: 'sequential',
    async execute(_toolCallId, args, signal) {
      if (!options.canStart()) throw new Error('image-admission-closed')
      // Generating bytes is a file effect; under Plan it is refused before any
      // request is sent, matching the app's edit/write behaviour.
      if (options.isPlanRestricted?.()) throw new Error('image-file-effect-refused-in-plan-mode')

      const action = args.action as ImageToolAction
      const prompt = args.prompt.trim()
      const modelId = (args.model ?? DEFAULT_MODEL).trim()
      const requested = (args.protocol ?? 'auto') as ImageToolProtocol
      const inputPaths = args.input_images ?? []
      if (action === 'edit' && inputPaths.length === 0) {
        throw new Error('action "edit" needs at least one input_images entry to modify or reference.')
      }

      if (!prompt || !modelId) throw new Error('prompt and model must not be blank.')
      const assertAdmitted = () => {
        signal?.throwIfAborted()
        if (!options.canStart()) throw new Error('image-admission-closed')
        if (options.isPlanRestricted?.()) throw new Error('image-file-effect-refused-in-plan-mode')
      }
      assertAdmitted()
      await ensureOpenRouterNativeImages(options.runtime)
      assertAdmitted()
      const native = nativeModelFor(options.runtime, modelId)
      const chat = options.runtime.getModelOfType('image', OPENROUTER_SOURCE_PROVIDER_ID, modelId)
      if (!native && !chat) {
        const hints = await suggestions(options.runtime, modelId)
        throw new Error(`No OpenRouter image model named "${modelId}". Available models include: ${hints.join(', ')}`)
      }
      const input: ImageRequestContent[] = [{ type: 'text', text: prompt }, ...await readInputImages(inputPaths, options.cwd)]
      const params = protocolParams(args as Record<string, unknown>)
      const count = params.n ?? 1
      assertAdmitted()
      const plan = await resolveTargets(args as Record<string, unknown>, count, options)
      const preferred = proven.get(modelId) ?? 'native'
      const order: ResolvedImageProtocol[] = requested === 'auto'
        ? [preferred, preferred === 'native' ? 'chat' : 'native'] : [requested]
      const ignored = CHAT_PROTOCOL_UNSUPPORTED.filter(key => args[key as keyof typeof args] !== undefined && !(key === 'n' && count === 1))
      const files: GeneratedImageFile[] = []
      const fileHashes: Record<string, string> = {}
      let remembered = false
      const remember = (result: ImageToolResult) => {
        if (remembered || !files.length) return
        remembered = true
        options.recordGeneration?.({ version: 1, id: _toolCallId, arguments: structuredClone(args), result: structuredClone(result), fileHashes })
      }
      const previews: ContentBlock[] = []
      let used: ResolvedImageProtocol = order[0]
      let renamed = false
      let usage: ImageGenerationResult['usage']
      const addUsage = (next: ImageGenerationResult['usage']) => {
        if (!next) return
        if (!usage) { usage = { ...next, cost: { ...next.cost } }; return }
        for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'] as const) usage[key] += next[key]
        for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'total'] as const) usage.cost[key] += next.cost[key]
      }
      const details = (error?: string, text?: string): ImageToolResult => ({
        kind: IMAGE_TOOL_KIND, action, model: modelId, protocol: used, prompt, files,
        ...(error ? { error } : {}), ...(text ? { text } : {}), ...(renamed ? { renamed: true } : {}),
        ...(used === 'chat' && ignored.length ? { ignoredParameters: ignored } : {}),
        ...(usage ? { usage: { inputTokens: usage.input + usage.cacheRead + usage.cacheWrite,
          outputTokens: usage.output, totalTokens: usage.totalTokens, costUsd: usage.cost.total } } : {})
      })
      const timeoutMs = options.getTimeoutMs?.() ?? IMAGE_REQUEST_TIMEOUT_MS
      const deadline = new AbortController()
      const timer = timeoutMs > 0 ? setTimeout(() => deadline.abort(), timeoutMs) : undefined
      timer?.unref()
      const requestSignal = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal
      try {
        let result: ImageGenerationResult | undefined
        const failures: string[] = []
        for (const protocol of order) {
          assertAdmitted()
          requestSignal.throwIfAborted()
          used = protocol
          const model = protocol === 'native' ? native : chat
          if (!model) { failures.push(`${protocol}: model is not served on this protocol`); continue }
          if (protocol === 'chat' && ignored.length && args.require_parameters === true) {
            throw new Error(`The chat protocol cannot apply required parameters: ${ignored.join(', ')}. Use the native protocol or another model.`)
          }
          let billed: ImageGenerationResult['usage']
          const provider = imageRouting(params.routing)
          const attempt = await options.runtime.generateImages(model, { input }, {
            signal: requestSignal, timeoutMs, maxRetries: 0,
            ...(protocol === 'native' ? { metadata: { [IMAGE_PARAMS_METADATA_KEY]: params } } : {
              fetch: imageResponseFetch(value => { if (value) billed = value }),
              onPayload: payload => ({ ...(payload as Record<string, unknown>), ...(provider ? { provider } : {}) })
            })
          })
          if (billed) attempt.usage = billed
          addUsage(attempt.usage)
          requestSignal.throwIfAborted()
          if (attempt.stopReason === 'stop' && attempt.output.some(block => block.type === 'image')) {
            result = attempt
            if (requested === 'auto') {
              proven.set(modelId, protocol)
              if (proven.size > 256) proven.delete(proven.keys().next().value!)
            }
            break
          }
          failures.push(failureText(attempt, modelId, protocol))
          if (requested !== 'auto' || !isProtocolMismatch(attempt.errorMessage ?? '')) break
        }
        if (!result) throw new Error(`Could not generate with "${modelId}". ${failures.join(' | ')}`)
        if (timer) clearTimeout(timer)
        const images = result.output.filter(block => block.type === 'image')
        if (images.length > count || images.length > IMAGE_MAX_COUNT) throw new Error(`Provider returned ${images.length} images; at most ${count} were requested.`)
        // Validate the entire batch before the first write. A malformed second
        // image must not silently leave a successful first write behind.
        const validated = []
        let bytes = 0
        for (const image of images) {
          assertAdmitted()
          bytes += Math.ceil(image.data.length * 3 / 4)
          if (bytes > 64 * 1024 * 1024) throw new Error('Generated image batch exceeds the 64 MiB limit.')
          validated.push(await validateGeneratedImage(image))
        }
        for (let index = 0; index < validated.length; index++) {
          const image = validated[index]
          const extension = imageExtension(image.mimeType)
          const fixed = plan.fixed ? withExtension(plan.fixed, extension) : undefined
          if (fixed && fixed !== plan.fixed) renamed = true
          let saved: string | undefined
          for (let suffix = 0; suffix < 1000; suffix++) {
            const base = index === 0 ? plan.base : `${plan.base}-${index + 1}`
            const target = fixed ?? join(plan.directory, `${base}${suffix ? `-${suffix + 1}` : ''}.${extension}`)
            try {
              saved = await commitImageFile(target, image.bytes, { ...options,
                overwrite: Boolean(fixed && plan.overwrite), assertAdmitted })
              break
            } catch (error) {
              if (!fixed && (error as NodeJS.ErrnoException).code === 'EEXIST') continue
              throw error
            }
          }
          if (!saved) throw new Error('Cannot find a free image filename.')
          files.push({ path: saved, mimeType: image.mimeType, size: image.bytes.length, width: image.width, height: image.height })
          fileHashes[saved] = createHash('sha256').update(image.bytes).digest('hex')
          previews.push(image.preview)
        }
        const text = result.output.filter(block => block.type === 'text').map(block => block.text).join('\n').trim().slice(0, 32000)
        const summary = [
          `${action === 'edit' ? 'Edited' : 'Generated'} ${files.length} image(s) with ${modelId} over the ${used} protocol.`,
          ...files.map(file => `Saved ${file.path} (${file.mimeType}, ${file.width}x${file.height}, ${file.size} bytes)`),
          ...(usage ? [`Cost: $${usage.cost.total.toFixed(4)}`] : []),
          ...(renamed ? ['The saved extension follows the returned encoding.'] : []),
          ...(used === 'chat' && ignored.length ? [`Not applied on the chat protocol: ${ignored.join(', ')}.`] : []),
          ...(text ? [`Model text: ${text}`] : [])
        ].join('\n')
        const receipt = details(undefined, text)
        remember(receipt)
        return { content: [{ type: 'text', text: summary }, ...previews], details: receipt, ...(usage ? { usage } : {}) }
      } catch (error) {
        const message = (signal?.aborted ? 'Image generation was cancelled.' : deadline.signal.aborted
          ? `Image generation timed out after ${timeoutMs} ms.` : error instanceof Error ? error.message : String(error)).slice(0, 8000)
        // A paid request and already committed files remain evidence even when
        // a later validation/save fails. The SDK persists failed result details.
        const receipt = details(message)
        remember(receipt)
        return { isError: true, content: [{ type: 'text', text: message }, ...previews],
          details: receipt, ...(usage ? { usage } : {}) }
      } finally { if (timer) clearTimeout(timer) }
    }
  })
}
