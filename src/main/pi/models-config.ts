import { ModelRuntime, getAgentDir } from '@earendil-works/pi-coding-agent'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type {
  CatalogPresetDTO,
  CatalogRecommendationDTO,
  CustomModelDTO,
  CustomProviderDTO,
  DiscoveredModelDTO,
  ModelCostDTO,
  ModelConfigSourceDTO,
  ModelsConfigDTO,
  ProviderModelDTO,
  TestModelResultDTO
} from '../../shared/types'

/**
 * Viewer/editor backend for ~/.pi/agent/models.json — the file the Pi SDK
 * composes custom providers, extra model carriers and per-model overrides
 * from. The SDK only READS this file; edits are written here directly and the
 * shared ModelRuntime is `refresh()`ed by the caller afterwards.
 *
 * Sanitization mirrors the SDK's applyModelsJson validity rules so a bad
 * entry can never poison provider composition for the whole runtime.
 */

const MODEL_COST_KEYS = ['input', 'output', 'cacheRead', 'cacheWrite'] as const

/** Wire APIs whose models-list endpoint we know how to build and parse. */
const MODEL_DISCOVERY_APIS = new Set([
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
  'google-generative-ai',
  'mistral-conversations'
])

export function supportsModelDiscovery(api: string | undefined): boolean {
  return Boolean(api && MODEL_DISCOVERY_APIS.has(api))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function modelsConfigPath(): string {
  return join(getAgentDir(), 'models.json')
}

export function readModelsConfig(): ModelsConfigDTO {
  const path = modelsConfigPath()
  if (!existsSync(path)) return { providers: {} }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (!isRecord(parsed) || !isRecord(parsed.providers)) return { providers: {} }
    return parsed as unknown as ModelsConfigDTO
  } catch {
    return { providers: {} }
  }
}

/** Complete partial cost groups with zero; drop a group only when empty. */
function normalizeModelCost(value: unknown): ModelCostDTO | undefined {
  if (!isRecord(value)) return undefined
  const provided = MODEL_COST_KEYS.filter((key) => value[key] !== undefined)
  if (provided.length === 0) return undefined
  if (provided.some((key) => typeof value[key] !== 'number' || !Number.isFinite(value[key]))) {
    return undefined
  }
  return {
    input: Number(value.input) || 0,
    output: Number(value.output) || 0,
    cacheRead: Number(value.cacheRead) || 0,
    cacheWrite: Number(value.cacheWrite) || 0
  }
}

function hasMeaningfulProviderFields(provider: Record<string, unknown>): boolean {
  // Mirrors the SDK's applyModelsJson validity check: an entry with none of
  // these fields makes provider composition throw and poisons the whole
  // runtime, so drop it instead of persisting it.
  if (Array.isArray(provider.models) && provider.models.length > 0) return true
  if (typeof provider.baseUrl === 'string' && provider.baseUrl.trim()) return true
  if (provider.headers !== undefined || provider.compat !== undefined) return true
  if (isRecord(provider.modelOverrides) && Object.keys(provider.modelOverrides).length > 0) return true
  return Boolean(provider.apiKey) || Boolean(provider.oauth) || provider.authHeader !== undefined
}

function sanitizeModelsConfig(config: ModelsConfigDTO): ModelsConfigDTO {
  const providers = Object.fromEntries(
    Object.entries(config.providers ?? {})
      .map(([providerId, provider]): [string, CustomProviderDTO] => {
        if (!isRecord(provider)) return [providerId, provider as CustomProviderDTO]
        const models = Array.isArray(provider.models)
          ? provider.models.filter(
              (model) => isRecord(model) && typeof model.id === 'string' && model.id.trim().length > 0
            )
          : provider.models
        const next = { ...provider, models }
        for (const model of next.models ?? []) {
          if (!isRecord(model) || !('cost' in model)) continue
          const cost = normalizeModelCost(model.cost)
          if (cost) (model as Record<string, unknown>).cost = cost
          else delete (model as Record<string, unknown>).cost
        }
        return [providerId, next]
      })
      .filter(([, provider]) => !isRecord(provider) || hasMeaningfulProviderFields(provider))
  )
  return { providers }
}

function writePrivateFileAtomicSync(path: string, data: string): void {
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const temp = join(dir, `.${basename(path)}.${process.pid}.${Date.now()}.tmp`)
  writeFileSync(temp, data, { mode: 0o600 })
  renameSync(temp, path)
}

/** Sanitize, persist and return the config as written. */
export function writeModelsConfig(config: ModelsConfigDTO): ModelsConfigDTO {
  const normalized = sanitizeModelsConfig(config)
  writePrivateFileAtomicSync(modelsConfigPath(), JSON.stringify(normalized, null, 2))
  return normalized
}

// ---- builtin provenance ----------------------------------------------------

/**
 * Registry-only runtime (no models.json, no remote catalog) — the intrinsic
 * provider/model set, cached for the process lifetime.
 */
const registryRuntime = (() => {
  let cached: Promise<ModelRuntime> | null = null
  return () => {
    cached ??= ModelRuntime.create({ modelsPath: null })
    return cached
  }
})()

/**
 * Intrinsic (non-models.json) model ids of a provider: static registry plus
 * the remote catalog cache in `<agentDir>/models-store.json` (read
 * defensively). Needed to tell a custom carrier from a duplicate of a builtin
 * definition — the composed list alone cannot distinguish them.
 */
export async function builtinModelIdsForProvider(providerId: string): Promise<Set<string>> {
  const ids = new Set<string>()
  const registry = await registryRuntime()
  for (const model of registry.getModels(providerId)) ids.add(model.id)
  try {
    const storePath = join(getAgentDir(), 'models-store.json')
    if (existsSync(storePath)) {
      const parsed = JSON.parse(readFileSync(storePath, 'utf8')) as Record<
        string,
        { models?: { id?: unknown }[] } | undefined
      >
      const entry = parsed[providerId]
      if (entry && Array.isArray(entry.models)) {
        for (const model of entry.models) {
          if (isRecord(model) && typeof model.id === 'string' && model.id) ids.add(model.id)
        }
      }
    }
  } catch {
    // Unreadable cache: the static registry above is enough.
  }
  return ids
}

/** Ids of the providers that ship with the SDK (before any models.json). */
export async function builtinProviderIds(): Promise<Set<string>> {
  const registry = await registryRuntime()
  return new Set(registry.getProviders().map((provider) => provider.id))
}

/**
 * Intrinsic base URL per built-in provider id (before any models.json
 * override) — the value the provider detail form shows as "the default".
 * Providers that carry it per model or derive it from auth are absent.
 */
export async function builtinProviderBaseUrls(): Promise<Map<string, string>> {
  const registry = await registryRuntime()
  const urls = new Map<string, string>()
  for (const provider of registry.getProviders()) {
    if (provider.baseUrl) urls.set(provider.id, provider.baseUrl)
  }
  return urls
}

// ---- provider inventory ----------------------------------------------------

const modelNameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/**
 * `provider/modelId` keys the user hid in Settings → Providers. Hiding is an
 * app-level visibility flag stored as `modelOverrides.<id>.hidden: true` in
 * models.json: the SDK's schema tolerates the extra key and its override
 * application ignores it, so a hidden model still composes and stays usable —
 * every app-side model selector simply drops it. The provider inventory keeps
 * listing hidden models so they can be unhidden.
 */
export function hiddenModelKeys(config: ModelsConfigDTO): Set<string> {
  const hidden = new Set<string>()
  for (const [providerId, provider] of Object.entries(config.providers ?? {})) {
    if (!isRecord(provider)) continue
    for (const [modelId, override] of Object.entries(provider.modelOverrides ?? {})) {
      if (isRecord(override) && override.hidden === true) hidden.add(`${providerId}/${modelId}`)
    }
  }
  return hidden
}

/**
 * Composed per-model view of one provider, merged the way the runtime
 * composes it (registry + models.json carriers + modelOverrides), with the
 * provenance the editor needs to label rows honestly. Providers that do not
 * compose (brand-new or invalid) yield an empty list — the caller falls back
 * to the raw models.json entries.
 */
export async function providerInventory(runtime: ModelRuntime, providerId: string): Promise<ProviderModelDTO[]> {
  if (!runtime.getProvider(providerId)) return []
  const entry = readModelsConfig().providers[providerId]
  const carrierIds = new Set(
    (entry?.models ?? [])
      .map((model) => (isRecord(model) && typeof model.id === 'string' ? model.id.trim() : ''))
      .filter(Boolean)
  )
  const overrideEntries = Object.entries(entry?.modelOverrides ?? {})
  // A hide-only override is a visibility choice, not a parameter edit — it
  // earns neither the "edited" badge nor the reset button.
  const overrideIds = new Set(
    overrideEntries
      .filter(([, override]) => isRecord(override) && Object.keys(override).some((key) => key !== 'hidden'))
      .map(([id]) => id)
  )
  const hiddenIds = new Set(
    overrideEntries
      .filter(([, override]) => isRecord(override) && override.hidden === true)
      .map(([id]) => id)
  )
  const builtinIds = await builtinModelIdsForProvider(providerId)
  const available = new Set(
    runtime
      .getAvailableSnapshot()
      .map((model) => `${(model as any).provider}/${model.id}`)
  )

  const models = runtime.getModels(providerId).map((model) => {
    const anyModel = model as any
    const cost = anyModel.cost
    return {
      id: model.id,
      name: anyModel.name ?? model.id,
      contextWindow: anyModel.contextWindow ?? 0,
      maxTokens: anyModel.maxTokens ?? 0,
      reasoning: Boolean(anyModel.reasoning),
      input: (anyModel.input ?? ['text']) as string[],
      ...(cost
        ? {
            cost: {
              input: cost.input ?? 0,
              output: cost.output ?? 0,
              cacheRead: cost.cacheRead ?? 0,
              cacheWrite: cost.cacheWrite ?? 0
            } satisfies ModelCostDTO
          }
        : {}),
      available: available.has(`${anyModel.provider}/${model.id}`),
      source: carrierIds.has(model.id) ? (builtinIds.has(model.id) ? ('both' as const) : ('custom' as const)) : ('builtin' as const),
      hasOverride: overrideIds.has(model.id),
      hidden: hiddenIds.has(model.id)
    } satisfies ProviderModelDTO
  })

  models.sort(
    (a, b) => modelNameCollator.compare(a.name || a.id, b.name || b.id) || modelNameCollator.compare(a.id, b.id)
  )
  return models
}

// ---- model discovery (/models endpoints) -----------------------------------

function cleanString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function modelFromValue(value: unknown): DiscoveredModelDTO | null {
  if (typeof value === 'string') {
    const id = value.trim()
    return id ? { id } : null
  }
  if (!isRecord(value)) return null
  const rawId = cleanString(value.id) ?? cleanString(value.model) ?? cleanString(value.name)
  if (!rawId) return null
  const id = rawId.startsWith('models/') ? rawId.slice('models/'.length) : rawId
  if (!id) return null
  const name =
    cleanString(value.display_name) ?? cleanString(value.displayName) ?? cleanString(value.name)
  return name && name !== id ? { id, name } : { id }
}

function listFromResponse(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (!isRecord(value)) return []
  for (const key of ['data', 'models', 'results', 'items']) {
    const candidate = value[key]
    if (Array.isArray(candidate)) return candidate
    if (isRecord(candidate)) return Object.values(candidate)
  }
  return []
}

export function parseDiscoveredModels(value: unknown): DiscoveredModelDTO[] {
  const seen = new Set<string>()
  const models: DiscoveredModelDTO[] = []
  for (const item of listFromResponse(value)) {
    const model = modelFromValue(item)
    if (!model || seen.has(model.id)) continue
    seen.add(model.id)
    models.push(model)
  }
  return models.sort((a, b) =>
    (a.name ?? a.id).localeCompare(b.name ?? b.id, undefined, { numeric: true, sensitivity: 'base' })
  )
}

export function buildModelsListUrl(baseUrl: string, api: string): URL {
  const url = new URL(baseUrl.trim())
  const trimmedPath = url.pathname.replace(/\/+$/, '')
  if (!/\/models$/i.test(trimmedPath)) {
    let path = trimmedPath
    if (
      (api === 'anthropic-messages' || api === 'mistral-conversations') &&
      !/\/v\d+(?:beta)?$/i.test(path)
    ) {
      path += '/v1'
    }
    if (api === 'google-generative-ai' && !/\/v\d+(?:beta)?$/i.test(path)) path += '/v1beta'
    url.pathname = `${path}/models`.replace(/\/+/g, '/')
  }
  if (api === 'anthropic-messages' && !url.searchParams.has('limit')) {
    url.searchParams.set('limit', '1000')
  }
  if (api === 'google-generative-ai' && !url.searchParams.has('pageSize')) {
    url.searchParams.set('pageSize', '1000')
  }
  return url
}

/** Keep upstream text errors useful without rendering HTML challenge pages. */
function formatUpstreamError(responseText: string, status: number, contentType: string | null): string {
  const trimmed = responseText.trim()
  const looksLikeHtml =
    contentType?.toLowerCase().includes('html') ||
    /^\s*(?:<!doctype\s+html|<!--|<html|<head|<body|<\?xml)\b/i.test(trimmed)
  if (looksLikeHtml) return `Upstream returned HTTP ${status} with an HTML page instead of JSON`
  return trimmed.slice(0, 500) || `Upstream returned HTTP ${status}`
}

/** Drop null/non-string header values the SDK may carry. */
function stringHeaders(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {}
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  )
}

/**
 * Resolve the auth a discovery request should carry: compose the provider in
 * an isolated runtime (a one-model temp models.json) and ask it — this picks
 * up the static models.json key, the stored auth.json credential and env
 * fallbacks exactly like a real request would.
 */
async function resolveDiscoveryAuth(
  providerId: string,
  entry: CustomProviderDTO
): Promise<{ apiKey?: string; headers: Record<string, string> }> {
  let tempDir: string | undefined
  try {
    tempDir = mkdtempSync(join(tmpdir(), 'pi-app-model-discovery-'))
    const modelsPath = join(tempDir, 'models.json')
    const probeId = '__pi_app_model_discovery__'
    writeFileSync(
      modelsPath,
      JSON.stringify({ providers: { [providerId]: { ...entry, models: [{ id: probeId }] } } }),
      'utf8'
    )
    const runtime = await ModelRuntime.create({ modelsPath })
    const error = runtime.getError()
    if (error) throw new Error(error)
    const model = runtime.getModel(providerId, probeId)
    if (!model) throw new Error(`Unable to load provider "${providerId}"`)
    const resolved = await runtime.getAuth(model)
    if (resolved) {
      return { apiKey: resolved.auth.apiKey, headers: stringHeaders(resolved.auth.headers) }
    }
    return { headers: stringHeaders(runtime.getCompatibilityRequestConfig(model).headers) }
  } finally {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true })
  }
}

/**
 * Fetch the provider's models-list endpoint (OpenAI-compatible, Anthropic,
 * Google) and return the ids it advertises. `runtime` is the shared runtime,
 * used only to fall back to the composed provider's baseUrl/api when the
 * models.json entry carries none.
 */
export async function discoverModels(
  providerId: string,
  runtime: ModelRuntime
): Promise<DiscoveredModelDTO[]> {
  const entry = readModelsConfig().providers[providerId] ?? {}
  let baseUrl = typeof entry.baseUrl === 'string' ? entry.baseUrl.trim() : ''
  let api = typeof entry.api === 'string' ? entry.api : undefined
  if (!baseUrl) {
    const composed = runtime.getProvider(providerId)?.getModels()[0] as any
    baseUrl = composed?.baseUrl ?? ''
    api = api ?? composed?.api
  }
  if (!baseUrl) throw new Error('This provider has no base URL to fetch models from')
  const effectiveApi = api || 'openai-completions'
  if (!supportsModelDiscovery(effectiveApi)) {
    throw new Error(`Model discovery is not supported for API "${effectiveApi}"`)
  }

  const auth = await resolveDiscoveryAuth(providerId, entry)
  const headers: Record<string, string> = { Accept: 'application/json', ...auth.headers }
  if (auth.apiKey) {
    if (effectiveApi === 'anthropic-messages') {
      headers['x-api-key'] = auth.apiKey
      headers['anthropic-version'] ??= '2023-06-01'
    } else if (effectiveApi === 'google-generative-ai') {
      headers['x-goog-api-key'] = auth.apiKey
    } else {
      headers.Authorization ??= `Bearer ${auth.apiKey}`
    }
  }
  if (isRecord(entry.headers)) {
    for (const [key, value] of Object.entries(entry.headers)) {
      if (typeof value === 'string') headers[key] = value
    }
  }

  const endpoint = buildModelsListUrl(baseUrl, effectiveApi)
  const response = await fetch(endpoint, { headers, cache: 'no-store', signal: AbortSignal.timeout(20_000) })
  const text = await response.text()
  if (!response.ok) throw new Error(formatUpstreamError(text, response.status, response.headers.get('content-type')))
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(formatUpstreamError(text, response.status, response.headers.get('content-type')))
  }
  const models = parseDiscoveredModels(parsed)
  if (!models.length) throw new Error('The provider returned an empty model list')
  return models
}

// ---- connection test -------------------------------------------------------

const TEST_TIMEOUT_MS = 20_000

/**
 * Send one tiny completion through the (possibly unsaved) model definition to
 * verify provider, model id, auth and quotas in a single round trip. The
 * definition is composed in an isolated temp models.json so the test never
 * depends on what is currently saved; stored auth.json credentials still
 * resolve because only the models path is redirected.
 */
export async function testModel(providerId: string, model: CustomModelDTO): Promise<TestModelResultDTO> {
  const entry = readModelsConfig().providers[providerId] ?? {}
  const modelId = model.id.trim()
  if (!modelId) return { ok: false, error: 'Model ID is required' }

  let tempDir: string | undefined
  try {
    tempDir = mkdtempSync(join(tmpdir(), 'pi-app-model-test-'))
    const modelsPath = join(tempDir, 'models.json')
    writeFileSync(
      modelsPath,
      JSON.stringify({
        providers: { [providerId]: { ...entry, models: [{ ...model, id: modelId }] } }
      }),
      'utf8'
    )

    const runtime = await ModelRuntime.create({ modelsPath })
    const error = runtime.getError()
    if (error) return { ok: false, error }
    const composed = runtime.getModel(providerId, modelId)
    if (!composed) return { ok: false, error: `Model not found: ${providerId}/${modelId}` }
    const resolved = await runtime.getAuth(composed)
    if (!resolved?.auth.apiKey) {
      return { ok: false, error: `No API key found for "${providerId}"` }
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS)
    let status: number | undefined
    const startedAt = Date.now()
    try {
      const message = await runtime.completeSimple(
        composed,
        {
          messages: [{ role: 'user', content: 'Reply with OK only.', timestamp: Date.now() }]
        },
        {
          apiKey: resolved.auth.apiKey,
          headers: resolved.auth.headers,
          maxTokens: 16,
          timeoutMs: TEST_TIMEOUT_MS,
          maxRetries: 0,
          cacheRetention: 'none',
          signal: controller.signal,
          onResponse: (response: { status: number }) => {
            status = response.status
          }
        }
      )
      const latencyMs = Date.now() - startedAt
      if (message.stopReason === 'error' || message.stopReason === 'aborted') {
        return {
          ok: false,
          error:
            (message as any).errorMessage ??
            (controller.signal.aborted ? 'Test timed out' : 'Model returned an error'),
          latencyMs,
          status
        }
      }
      const responseText = (message.content as any[])
        .filter((block) => block?.type === 'text')
        .map((block) => block.text)
        .join('')
      return { ok: true, latencyMs, status, responseText: responseText.slice(0, 300) }
    } finally {
      clearTimeout(timeout)
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true })
  }
}

// ---- models.dev catalog fill -------------------------------------------------

interface CatalogEntry {
  providerId: string
  providerName: string
  providerBaseUrl?: string
  id: string
  name: string
  reasoning?: boolean
  input?: string[]
  contextWindow?: number
  maxTokens?: number
  cost: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
}

const MODELS_DEV_URL = 'https://models.dev/api.json'
const CATALOG_TTL_MS = 60 * 60 * 1000
const CATALOG_FETCH_TIMEOUT_MS = 15_000
const CONSENSUS_MIN_SHARE = 0.6
const CONSENSUS_MIN_SUPPORT = 5
const KNOWN_PROVIDER_HOSTS: Record<string, readonly string[]> = {
  anthropic: ['api.anthropic.com'],
  google: ['generativelanguage.googleapis.com'],
  openai: ['api.openai.com'],
  openrouter: ['openrouter.ai']
}
const SUPPORTED_INPUT_MODALITIES = new Set(['text', 'image'])

const catalogCache: { entries: CatalogEntry[]; expiresAt: number; inFlight?: Promise<CatalogEntry[]> } = {
  entries: [],
  expiresAt: 0
}

function optionalNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function optionalPositiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

function readCatalogCost(value: unknown): CatalogEntry['cost'] {
  if (!isRecord(value)) return {}
  return {
    input: optionalNonNegativeNumber(value.input),
    output: optionalNonNegativeNumber(value.output),
    cacheRead: optionalNonNegativeNumber(value.cache_read),
    cacheWrite: optionalNonNegativeNumber(value.cache_write)
  }
}

function readCatalogInput(value: unknown): string[] | undefined {
  if (!isRecord(value) || !Array.isArray(value.input)) return undefined
  const input = Array.from(
    new Set(
      value.input
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => entry.trim().toLocaleLowerCase())
        .filter((entry) => SUPPORTED_INPUT_MODALITIES.has(entry))
    )
  )
  return input.length ? input : undefined
}

function flattenModelsDevCatalog(value: unknown): CatalogEntry[] {
  if (!isRecord(value)) return []
  const entries: CatalogEntry[] = []
  for (const [providerId, rawProvider] of Object.entries(value)) {
    if (!isRecord(rawProvider) || !isRecord(rawProvider.models)) continue
    const providerName = cleanString(rawProvider.name) ?? providerId
    const providerBaseUrl = cleanString(rawProvider.api)
    for (const [fallbackId, rawModel] of Object.entries(rawProvider.models)) {
      if (!isRecord(rawModel)) continue
      const id = cleanString(rawModel.id) ?? fallbackId
      if (!id) continue
      const entry: CatalogEntry = {
        providerId,
        providerName,
        id,
        name: cleanString(rawModel.name) ?? id,
        cost: readCatalogCost(rawModel.cost)
      }
      if (providerBaseUrl) entry.providerBaseUrl = providerBaseUrl
      if (typeof rawModel.reasoning === 'boolean') entry.reasoning = rawModel.reasoning
      const input = readCatalogInput(rawModel.modalities)
      if (input) entry.input = input
      if (isRecord(rawModel.limit)) {
        const contextWindow = optionalPositiveNumber(rawModel.limit.context)
        const maxTokens = optionalPositiveNumber(rawModel.limit.output)
        if (contextWindow !== undefined) entry.contextWindow = contextWindow
        if (maxTokens !== undefined) entry.maxTokens = maxTokens
      }
      entries.push(entry)
    }
  }
  return entries
}

async function loadCatalog(): Promise<CatalogEntry[]> {
  if (catalogCache.entries.length > 0 && catalogCache.expiresAt > Date.now()) return catalogCache.entries
  if (!catalogCache.inFlight) {
    catalogCache.inFlight = (async () => {
      const response = await fetch(MODELS_DEV_URL, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(CATALOG_FETCH_TIMEOUT_MS)
      })
      if (!response.ok) throw new Error(`models.dev returned HTTP ${response.status}`)
      const entries = flattenModelsDevCatalog(await response.json())
      if (entries.length === 0) throw new Error('models.dev returned an empty catalog')
      catalogCache.entries = entries
      catalogCache.expiresAt = Date.now() + CATALOG_TTL_MS
      return entries
    })().finally(() => {
      catalogCache.inFlight = undefined
    })
  }
  try {
    return await catalogCache.inFlight
  } catch (error) {
    if (catalogCache.entries.length > 0) return catalogCache.entries
    throw error
  }
}

function normalizeProvider(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/[^a-z0-9]/g, '')
}

function normalizeModelId(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/^models\//, '')
}

function hostnameOf(value: string | undefined): string | undefined {
  if (!value) return undefined
  try {
    return new URL(value).hostname.toLocaleLowerCase().replace(/\.$/, '')
  } catch {
    return undefined
  }
}

function providerMatches(entry: CatalogEntry, providerHint: string): boolean {
  const normalized = normalizeProvider(providerHint)
  if (!normalized) return false
  return normalizeProvider(entry.providerId) === normalized || normalizeProvider(entry.providerName) === normalized
}

function baseUrlMatches(entry: CatalogEntry, baseUrl: string): boolean {
  const actualHost = hostnameOf(baseUrl)
  if (!actualHost) return false
  const knownHosts = KNOWN_PROVIDER_HOSTS[normalizeProvider(entry.providerId)] ?? []
  const providerHost = hostnameOf(entry.providerBaseUrl)
  const hostMatches = (actual: string, expected: string) => actual === expected || actual.endsWith(`.${expected}`)
  return [...knownHosts, ...(providerHost ? [providerHost] : [])].some((candidate) => hostMatches(actualHost, candidate))
}

function exactModelMatches(entry: CatalogEntry, query: string): boolean {
  const normalizedQuery = normalizeModelId(query)
  if (!normalizedQuery) return false
  const normalizedId = normalizeModelId(entry.id)
  const normalizedFullId = `${entry.providerId.toLocaleLowerCase()}/${normalizedId}`
  return normalizedId === normalizedQuery || normalizedFullId === normalizedQuery
}

function hasValidPrice(entry: CatalogEntry): entry is CatalogEntry & { cost: { input: number; output: number } } {
  return entry.cost.input !== undefined && entry.cost.output !== undefined
}

function modeValue<T>(values: readonly T[], total: number, keyFor: (value: T) => string): T | undefined {
  if (values.length === 0 || total <= 0) return undefined
  const groups = new Map<string, { value: T; count: number }>()
  for (const value of values) {
    const key = keyFor(value)
    const current = groups.get(key)
    if (current) current.count += 1
    else groups.set(key, { value, count: 1 })
  }
  const ranked = [...groups.values()].sort((a, b) => b.count - a.count)
  const winner = ranked[0]
  if (!winner || winner.count / total < CONSENSUS_MIN_SHARE) return undefined
  if (ranked[1]?.count === winner.count) return undefined
  return winner.value
}

function modeNumber(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined
  const groups = new Map<number, number>()
  for (const value of values) groups.set(value, (groups.get(value) ?? 0) + 1)
  const ranked = [...groups.entries()].sort((a, b) => b[1] - a[1])
  if (!ranked[0] || ranked[1]?.[1] === ranked[0][1]) return undefined
  return ranked[0][0]
}

/**
 * Recommend a parameter preset for a model id from the models.dev catalog:
 * metadata from the provider-matched entry (else base-URL match, else
 * consensus across every provider carrying that exact id), prices only when
 * they come from a trusted match or a clear cross-provider consensus.
 */
export async function recommendCatalogPreset(
  modelId: string,
  providerHint: string,
  baseUrl = ''
): Promise<CatalogRecommendationDTO> {
  const entries = await loadCatalog()
  const exactEntries = entries.filter((entry) => exactModelMatches(entry, modelId))
  if (exactEntries.length === 0) {
    return {
      exactMatches: 0,
      metadataMethod: 'none',
      preset: {},
      price: { status: 'unreliable', reason: 'no-exact-match', support: 0, total: 0 }
    }
  }

  const providerEntries = exactEntries.filter((entry) => providerMatches(entry, providerHint))
  const baseUrlEntries = exactEntries.filter((entry) => baseUrlMatches(entry, baseUrl))
  const metadataEntry = providerEntries[0] ?? baseUrlEntries[0]
  const metadataMethod: CatalogRecommendationDTO['metadataMethod'] = providerEntries.length
    ? 'provider'
    : baseUrlEntries.length
      ? 'base-url'
      : 'consensus'
  const preset: CatalogPresetDTO = metadataEntry
    ? {
        name: metadataEntry.name,
        reasoning: metadataEntry.reasoning,
        input: metadataEntry.input,
        contextWindow: metadataEntry.contextWindow,
        maxTokens: metadataEntry.maxTokens
      }
    : {
        name: modeValue(exactEntries.map((e) => e.name), exactEntries.length, (v) => v.toLocaleLowerCase()),
        reasoning: modeValue(
          exactEntries.flatMap((e) => (e.reasoning === undefined ? [] : [e.reasoning])),
          exactEntries.length,
          String
        ),
        input: modeValue(
          exactEntries.flatMap((e) => (e.input ? [e.input] : [])),
          exactEntries.length,
          (v) => [...v].sort().join(',')
        ),
        contextWindow: modeValue(
          exactEntries.flatMap((e) => (e.contextWindow === undefined ? [] : [e.contextWindow])),
          exactEntries.length,
          String
        ),
        maxTokens: modeValue(
          exactEntries.flatMap((e) => (e.maxTokens === undefined ? [] : [e.maxTokens])),
          exactEntries.length,
          String
        )
      }

  const providerPrice = providerEntries.find(hasValidPrice)
  const baseUrlPrice = baseUrlEntries.find(hasValidPrice)
  let price: CatalogRecommendationDTO['price']
  if (providerPrice && hasValidPrice(providerPrice)) {
    price = {
      status: 'reliable',
      method: 'provider',
      cost: {
        input: providerPrice.cost.input,
        output: providerPrice.cost.output,
        cacheRead: providerPrice.cost.cacheRead ?? 0,
        cacheWrite: providerPrice.cost.cacheWrite ?? 0
      },
      providerName: providerPrice.providerName,
      support: 1,
      total: 1
    }
  } else if (baseUrlPrice && hasValidPrice(baseUrlPrice)) {
    price = {
      status: 'reliable',
      method: 'base-url',
      cost: {
        input: baseUrlPrice.cost.input,
        output: baseUrlPrice.cost.output,
        cacheRead: baseUrlPrice.cost.cacheRead ?? 0,
        cacheWrite: baseUrlPrice.cost.cacheWrite ?? 0
      },
      providerName: baseUrlPrice.providerName,
      support: 1,
      total: 1
    }
  } else {
    const priced = exactEntries.filter(hasValidPrice)
    if (priced.length === 0) {
      price = { status: 'unreliable', reason: 'no-valid-price', support: 0, total: 0 }
    } else if (priced.length === 1) {
      price = { status: 'unreliable', reason: 'insufficient-support', support: 1, total: 1 }
    } else {
      const groups = new Map<string, typeof priced>()
      for (const entry of priced) {
        const key = JSON.stringify([entry.cost.input, entry.cost.output])
        const group = groups.get(key)
        if (group) group.push(entry)
        else groups.set(key, [entry])
      }
      const ranked = [...groups.values()].sort((a, b) => b.length - a.length)
      const winner = ranked[0]
      if (!winner) {
        price = { status: 'unreliable', reason: 'no-valid-price', support: 0, total: priced.length }
      } else {
        const hasConsensus = winner.length / priced.length >= CONSENSUS_MIN_SHARE || winner.length >= CONSENSUS_MIN_SUPPORT
        if (ranked[1]?.length === winner.length || !hasConsensus) {
          price = { status: 'unreliable', reason: 'conflict', support: winner.length, total: priced.length }
        } else {
          price = {
            status: 'reliable',
            method: 'consensus',
            cost: {
              input: winner[0].cost.input,
              output: winner[0].cost.output,
              cacheRead: modeNumber(winner.map((e) => e.cost.cacheRead ?? 0)) ?? 0,
              cacheWrite: modeNumber(winner.map((e) => e.cost.cacheWrite ?? 0)) ?? 0
            },
            support: winner.length,
            total: priced.length
          }
        }
      }
    }
  }

  if (price.status === 'reliable') preset.cost = price.cost
  return {
    exactMatches: exactEntries.length,
    metadataMethod,
    matchedProviderName: metadataEntry?.providerName,
    preset,
    price
  }
}

// ---- model config copy sources ----------------------------------------------

const sourceNameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/**
 * Composed models of the CONFIGURED providers — the source picker for the
 * model editor's "copy from model". A provider counts as configured when it
 * is actually usable here: a resolved credential (auth.json / env /
 * models.json key), or a custom models.json provider. Registry providers the
 * user never authenticated are deliberately absent — this is for copying real
 * model configs, not browsing every possible id.
 */
export async function configuredModels(runtime: ModelRuntime): Promise<ModelConfigSourceDTO[]> {
  const config = readModelsConfig()
  // Hidden models stay usable but never appear in a picker — including this
  // copy-source one.
  const hidden = hiddenModelKeys(config)
  const configuredIds = new Set<string>()
  const authProviderIds = new Set<string>()
  for (const provider of runtime.getProviders()) {
    const auth = provider.auth as any
    if (auth?.apiKey?.login || auth?.oauth) authProviderIds.add(provider.id)
    if (runtime.getProviderAuthStatus(provider.id)?.configured) configuredIds.add(provider.id)
  }
  for (const [providerId, entry] of Object.entries(config.providers)) {
    // An augmentation entry of a registry provider (models/overrides only, no
    // credential of its own) rides along only when that provider has auth.
    if (authProviderIds.has(providerId) && !entry?.apiKey && !entry?.oauth) continue
    configuredIds.add(providerId)
  }

  const providerNames = new Map(runtime.getProviders().map((p) => [p.id, p.name ?? p.id]))
  const models: ModelConfigSourceDTO[] = runtime
    .getModels()
    .filter(
      (model) =>
        configuredIds.has((model as any).provider) &&
        !hidden.has(`${(model as any).provider}/${model.id}`)
    )
    .map((model) => {
      const anyModel = model as any
      return {
        providerId: anyModel.provider,
        providerName: providerNames.get(anyModel.provider) ?? anyModel.provider,
        id: model.id,
        name: anyModel.name ?? model.id,
        reasoning: Boolean(anyModel.reasoning),
        contextWindow: anyModel.contextWindow ?? 0,
        maxTokens: anyModel.maxTokens ?? 0,
        ...(Array.isArray(anyModel.input) && anyModel.input.length ? { input: [...anyModel.input] } : {}),
        ...(anyModel.cost
          ? {
              cost: {
                input: anyModel.cost.input ?? 0,
                output: anyModel.cost.output ?? 0,
                cacheRead: anyModel.cost.cacheRead ?? 0,
                cacheWrite: anyModel.cost.cacheWrite ?? 0
              } satisfies ModelCostDTO
            }
          : {}),
        ...(anyModel.thinkingLevelMap ? { thinkingLevelMap: { ...anyModel.thinkingLevelMap } } : {}),
        ...(anyModel.compat ? { compat: { ...anyModel.compat } } : {})
      } satisfies ModelConfigSourceDTO
    })

  models.sort(
    (a, b) =>
      sourceNameCollator.compare(a.providerName, b.providerName) ||
      sourceNameCollator.compare(a.name || a.id, b.name || b.id) ||
      sourceNameCollator.compare(a.id, b.id)
  )
  return models
}
