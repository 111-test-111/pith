/**
 * OpenRouter's native image generation protocol, registered as a first-class Pi
 * image API.
 *
 * Pi ships exactly one image API, `openrouter-images`, which drives
 * chat/completions and therefore cannot reach models OpenRouter serves only on
 * `POST /api/v1/images` — the `openai/gpt-image-*` family among them. This
 * module adds that endpoint as `openrouter-native-images` and publishes the
 * mirrored catalog under its own provider, so `models.generateImages()` (and
 * with it codemode and the `image` tool) can reach every OpenRouter image model
 * through the protocol that supports the full parameter set.
 *
 * Everything here is transport. The tool owns file naming, protocol choice and
 * the user-facing result shape.
 *
 * Wire types are taken from `ModelRuntime`'s own signatures, so the app never
 * imports pi-ai directly: it is a nested dependency of the SDK, not one of ours
 * (see the same rule in `side-chat.ts`).
 */
import { createHash } from 'node:crypto'
import type { ModelRuntime } from '@earendil-works/pi-coding-agent'

type RegisterProviderConfig = Parameters<ModelRuntime['registerProvider']>[1]
type ImagesImplementation = NonNullable<NonNullable<RegisterProviderConfig['images']>[string]>
type ImagesGenerate = ImagesImplementation['generateImages']
type ImagesModel = Parameters<ImagesGenerate>[0]
type ImagesContext = Parameters<ImagesGenerate>[1]
type ImagesOptions = NonNullable<Parameters<ImagesGenerate>[2]>
type AssistantImages = Awaited<ReturnType<ImagesGenerate>>
export type ProviderImageModel = Extract<NonNullable<RegisterProviderConfig['models']>[number], { type: 'image' }>
/** A model `ModelRuntime.generateImages` accepts. */
export type ImageRequestModel = ImagesModel
/** One block of an image request: the prompt text or a reference image. */
export type ImageRequestContent = ImagesContext['input'][number]
/** A resolved image result — Pi never rejects this call, it reports `stopReason`. */
export type ImageGenerationResult = AssistantImages

/** Pi image API implemented here. */
export const OPENROUTER_NATIVE_IMAGE_API = 'openrouter-native-images'
/** Provider id the native catalog is published under. */
export const OPENROUTER_NATIVE_PROVIDER_ID = 'openrouter-native'
/** Provider id whose credential this protocol borrows. */
export const OPENROUTER_SOURCE_PROVIDER_ID = 'openrouter'
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'

/**
 * Optional request fields travel from the tool to this protocol through Pi's
 * `ImagesOptions.metadata` channel, which exists for provider fields the shared
 * contract does not model. Anything under this key is OpenRouter-specific.
 */
export const IMAGE_PARAMS_METADATA_KEY = 'openrouterImage'

export interface ImageProviderRouting {
  /** Let OpenRouter fall back to another provider when the primary fails. */
  allowFallbacks?: boolean
  /** Only route to providers that support every requested parameter. */
  requireParameters?: boolean
  dataCollection?: 'deny' | 'allow'
  /** Pin one provider by slug, or allow-list / deny-list several. */
  only?: string[]
  order?: string[]
  ignore?: string[]
}

/** OpenRouter `/api/v1/images` request fields beyond model and prompt. */
export interface ImageRequestParams {
  /** Upper bound on images to return (1-10). */
  n?: number
  /** Resolution tier: `512`, `1K`, `2K`, `4K`. */
  resolution?: string
  aspectRatio?: string
  /** Explicit pixels, for example `1024x1024`. Wins over the tier. */
  size?: string
  quality?: string
  outputFormat?: string
  background?: string
  /** 0-100, JPEG/WebP only. */
  outputCompression?: number
  seed?: number
  routing?: ImageProviderRouting
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/** Read the OpenRouter field bag a caller attached to an images request. */
export function readImageParams(options: ImagesOptions | undefined): ImageRequestParams {
  const metadata = asRecord(options?.metadata)
  return (asRecord(metadata?.[IMAGE_PARAMS_METADATA_KEY]) ?? {}) as ImageRequestParams
}

function buildBody(model: ImagesModel, context: ImagesContext, params: ImageRequestParams) {
  const prompt = context.input
    .filter(block => block.type === 'text')
    .map(block => (block.type === 'text' ? block.text : ''))
    .join('\n')
    .trim()
  const references = context.input.filter(block => block.type === 'image')
  const body: Record<string, unknown> = { model: model.id, prompt }
  if (params.n !== undefined && params.n > 1) body.n = params.n
  if (params.resolution) body.resolution = params.resolution
  if (params.aspectRatio) body.aspect_ratio = params.aspectRatio
  if (params.size) body.size = params.size
  if (params.quality) body.quality = params.quality
  if (params.outputFormat) body.output_format = params.outputFormat
  if (params.background) body.background = params.background
  if (params.outputCompression !== undefined) body.output_compression = params.outputCompression
  if (params.seed !== undefined) body.seed = params.seed
  if (references.length > 0) {
    body.input_references = references.map(reference => ({
      type: 'image_url',
      image_url: { url: reference.type === 'image' ? `data:${reference.mimeType};base64,${reference.data}` : '' }
    }))
  }
  const provider = imageRouting(params.routing)
  if (provider) body.provider = provider
  return body
}

/** Shared by native and chat: routing restrictions are never silently dropped. */
export function imageRouting(routing: ImageProviderRouting | undefined): Record<string, unknown> | undefined {
  if (!routing) return undefined
  const provider: Record<string, unknown> = {}
  if (routing.allowFallbacks !== undefined) provider.allow_fallbacks = routing.allowFallbacks
  if (routing.requireParameters !== undefined) provider.require_parameters = routing.requireParameters
  if (routing.dataCollection) provider.data_collection = routing.dataCollection
  if (routing.only?.length) provider.only = routing.only
  if (routing.order?.length) provider.order = routing.order
  if (routing.ignore?.length) provider.ignore = routing.ignore
  return Object.keys(provider).length ? provider : undefined
}

/** OpenRouter reports actual billed USD, including per-image pricing. */
export function imageUsage(raw: unknown): AssistantImages['usage'] {
  const usage = asRecord(raw)
  if (!usage) return undefined
  const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
  const prompt = count(usage.prompt_tokens)
  const cacheRead = Math.min(prompt, count(asRecord(usage.prompt_tokens_details)?.cached_tokens))
  const output = count(usage.completion_tokens)
  const cost = typeof usage.cost === 'number' && Number.isFinite(usage.cost) && usage.cost >= 0 ? usage.cost : 0
  return { input: prompt - cacheRead, output, cacheRead, cacheWrite: 0,
    totalTokens: count(usage.total_tokens) || prompt + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost } }
}

export const IMAGE_REQUEST_TIMEOUT_MS = 180_000
/** Bound the response before JSON/base64 decoding, on both protocols. */
const MAX_RESPONSE_BYTES = 128 * 1024 * 1024
async function readResponse(response: Response): Promise<string> {
  if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel()
    throw new Error('Image response exceeds the 128 MiB limit.')
  }
  const reader = response.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_RESPONSE_BYTES) throw new Error('Image response exceeds the 128 MiB limit.')
      chunks.push(value)
    }
    return Buffer.concat(chunks).toString('utf8')
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}

/** The SDK chat adapter estimates token prices; capture OpenRouter's actual
 * usage before returning the unchanged bounded response body to that adapter. */
export function imageResponseFetch(onUsage: (usage: AssistantImages['usage']) => void): typeof fetch {
  return async (input, init) => {
    const response = await fetch(input, init)
    const body = await readResponse(response)
    try { onUsage(imageUsage(asRecord(JSON.parse(body))?.usage)) } catch { /* SDK reports malformed JSON. */ }
    const headers = new Headers(response.headers)
    headers.delete('content-encoding'); headers.delete('content-length')
    return new Response(body || null, { status: response.status, statusText: response.statusText, headers })
  }
}

function failure(model: ImagesModel, errorMessage: string): AssistantImages {
  return {
    api: model.api, provider: model.provider, model: model.id,
    output: [], stopReason: 'error', errorMessage, timestamp: Date.now()
  }
}

/** One error line: OpenRouter's message, plus its routing funnel when present. */
function describeFailure(status: number, payload: unknown): string {
  const error = asRecord(asRecord(payload)?.error)
  const message = typeof error?.message === 'string' ? error.message : JSON.stringify(payload ?? {}).slice(0, 300)
  const funnel = error?.metadata === undefined ? '' : ` ${JSON.stringify(error.metadata).slice(0, 300)}`
  return `${status}: ${message}${funnel}`
}

/**
 * The `/api/v1/images` implementation.
 *
 * `resolveApiKey` is consulted up front and again after a 401, because a
 * registration-time key goes stale when the user signs in again: Pi hands back
 * the key that was captured when the provider was registered.
 */
export function createNativeImagesApi(resolveApiKey: () => Promise<string | undefined>): ImagesImplementation {
  return {
    async generateImages(model, context, options) {
      const timeoutMs = options?.timeoutMs ?? IMAGE_REQUEST_TIMEOUT_MS
      const deadline = new AbortController()
      const timer = timeoutMs > 0 ? setTimeout(() => deadline.abort(), timeoutMs) : undefined
      timer?.unref()
      const signal = options?.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal
      let usage: AssistantImages['usage']
      try {
        signal.throwIfAborted()
        // A registration snapshot must never keep a revoked credential alive.
        let key = await resolveApiKey()
        signal.throwIfAborted()
        if (!key) return failure(model, 'No OpenRouter credential is configured.')
        const initial = buildBody(model, context, readImageParams(options))
        const body = await options?.onPayload?.(initial, model) ?? initial
        const url = `${(model.baseUrl || OPENROUTER_BASE_URL).replace(/\/$/, '')}/images`
        const send = async (apiKey: string) => {
          signal.throwIfAborted()
          const headers = new Headers({ 'Content-Type': 'application/json' })
          for (const [name, value] of Object.entries({ ...model.headers, ...options?.headers })) {
            if (value === null) headers.delete(name)
            else if (value !== undefined) headers.set(name, value)
          }
          headers.set('Authorization', `Bearer ${apiKey}`)
          const response = await (options?.fetch ?? fetch)(url, {
            method: 'POST', headers, body: JSON.stringify(body), signal
          })
          await options?.onResponse?.({ status: response.status, headers: Object.fromEntries(response.headers) }, model)
          const text = await readResponse(response)
          let payload: unknown
          try { payload = JSON.parse(text) } catch { payload = { error: { message: text.slice(0, 300) || 'Empty response' } } }
          usage = imageUsage(asRecord(payload)?.usage)
          return { status: response.status, payload }
        }
        let result = await send(key)
        if (result.status === 401) {
          const fresh = await resolveApiKey()
          if (fresh && fresh !== key) { key = fresh; result = await send(key) }
        }
        signal.throwIfAborted()
        if (result.status !== 200) return { ...failure(model, describeFailure(result.status, result.payload)), ...(usage ? { usage } : {}) }
        const data = asRecord(result.payload)?.data
        if (!Array.isArray(data) || !data.length || data.length > 10) throw new Error('OpenRouter returned an invalid image count.')
        const output: AssistantImages['output'] = []
        for (const entry of data) {
          const record = asRecord(entry)
          if (typeof record?.b64_json !== 'string' || !record.b64_json) throw new Error('OpenRouter returned an empty image.')
          output.push({ type: 'image', data: record.b64_json,
            mimeType: typeof record.media_type === 'string' ? record.media_type
              : readImageParams(options).outputFormat === 'svg' ? 'image/svg+xml' : 'image/png' })
          if (typeof record.revised_prompt === 'string' && record.revised_prompt) {
            output.push({ type: 'text', text: record.revised_prompt.slice(0, 32000) })
          }
        }
        return { api: model.api, provider: model.provider, model: model.id, output,
          ...(usage ? { usage } : {}), stopReason: 'stop', timestamp: Date.now() }
      } catch (error) {
        const message = options?.signal?.aborted ? 'aborted' : deadline.signal.aborted
          ? `Image generation timed out after ${timeoutMs} ms.` : error instanceof Error ? error.message : String(error)
        return { ...failure(model, message), ...(usage ? { usage } : {}),
          ...(options?.signal?.aborted ? { stopReason: 'aborted' as const } : {}) }
      } finally { if (timer) clearTimeout(timer) }
    }
  }
}

function resolveKey(runtime: ModelRuntime) {
  return async () => (await runtime.getAuth(OPENROUTER_SOURCE_PROVIDER_ID))?.auth?.apiKey
}

/** Catalog signature already published per runtime, so repeated calls are cheap. */
const published = new WeakMap<ModelRuntime, string>()

/**
 * Publish the OpenRouter image catalog under {@link OPENROUTER_NATIVE_PROVIDER_ID}.
 *
 * Idempotent and best-effort: it never throws, never blocks a session from
 * starting, and republishes only when the discovered catalog changed or the
 * provider is missing (for example after the credential was added).
 */
export async function ensureOpenRouterNativeImages(runtime: ModelRuntime): Promise<void> {
  try {
    const apiKey = (await runtime.getAuth(OPENROUTER_SOURCE_PROVIDER_ID))?.auth?.apiKey
    if (!apiKey) {
      if (published.has(runtime)) runtime.unregisterProvider(OPENROUTER_NATIVE_PROVIDER_ID)
      published.delete(runtime)
      return
    }
    const catalog = await runtime.getAvailableOfType('image', OPENROUTER_SOURCE_PROVIDER_ID)
    const models: ProviderImageModel[] = catalog.map(model => ({
      type: 'image',
      id: model.id,
      name: model.name || model.id,
      api: OPENROUTER_NATIVE_IMAGE_API,
      input: model.input,
      inputLimits: model.inputLimits,
      output: model.output.length > 0 ? model.output : ['image'],
      cost: model.cost
    }))
    if (models.length === 0) return
    const signature = createHash('sha256').update(apiKey).update(JSON.stringify(models)).digest('hex')
    if (published.get(runtime) === signature && runtime.getRegisteredProviderConfig(OPENROUTER_NATIVE_PROVIDER_ID)) return
    runtime.registerProvider(OPENROUTER_NATIVE_PROVIDER_ID, {
      name: 'OpenRouter (native images)',
      baseUrl: OPENROUTER_BASE_URL,
      apiKey,
      headers: { 'HTTP-Referer': 'https://github.com/111-test-111/pith', 'X-Title': 'Pith' },
      images: { [OPENROUTER_NATIVE_IMAGE_API]: createNativeImagesApi(resolveKey(runtime)) },
      models
    })
    published.set(runtime, signature)
  } catch {
    // A missing or unreadable catalog must not break session startup; the tool
    // reports the protocol mismatch when it is actually asked to paint.
  }
}

/** The native-protocol model for an OpenRouter model id, when published. */
export function nativeModelFor(runtime: ModelRuntime, modelId: string): ImagesModel | undefined {
  return runtime.getModelOfType('image', OPENROUTER_NATIVE_PROVIDER_ID, modelId)
}

/**
 * A model that only serves the other protocol rejects this one with a
 * complaint about the endpoint. That is the single failure the tool retries
 * against the other protocol rather than reporting to the user.
 */
export function isProtocolMismatch(message: string): boolean {
  return /chat\/completions endpoint|images endpoint|does not support image generation|not a valid model ID/i.test(message)
}
