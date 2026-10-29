/**
 * Model-facing wording for a `model:` spec that cannot be resolved. Pure and
 * node-loadable so the exact text is script-checked
 * (`scripts/check-subagents.mjs`).
 *
 * Why it is separated from manager.ts: a WELL-FORMED `provider/modelId` that
 * simply is not configured used to be reported as `Unknown subagent model "…"
 * (expected "provider/modelId")`. The parenthetical was wrong — the spec's
 * syntax was fine — and it sent the model (and its user) chasing the syntax
 * instead of the real cause. The message now names which half is missing,
 * lists what IS available, and always offers the way out.
 */

/** How many provider/model ids an error message lists before truncating. */
const MAX_LISTED = 12

/** `a, b, c, …` — capped so a large provider catalog cannot flood the model's
 * context (and, for the provider case, keep the message scannable). */
function listIds(ids: readonly string[]): string {
  const shown = ids.slice(0, MAX_LISTED)
  return `${shown.join(', ')}${ids.length > shown.length ? ', …' : ''}`
}

export interface ModelSpecLookup {
  /** Configured provider ids. */
  providers: readonly string[]
  /** Model ids of a provider, or `null` when this app has no such provider. */
  modelsOf: (providerId: string) => readonly string[] | null
}

export function subagentModelSpecError(spec: string, lookup: ModelSpecLookup): string {
  const inherit = 'Omit "model" to inherit the parent session\'s model.'
  const trimmed = spec.trim()
  const slash = trimmed.indexOf('/')
  if (slash <= 0 || slash === trimmed.length - 1) {
    return `Invalid subagent model "${spec}": expected "provider/modelId". ${inherit}`
  }
  const providerId = trimmed.slice(0, slash)
  const modelId = trimmed.slice(slash + 1)
  const models = lookup.modelsOf(providerId)
  if (models === null) {
    const known = lookup.providers.length
      ? ` Configured providers: ${listIds(lookup.providers)}.`
      : ' No providers are configured; check Settings → Providers.'
    return `Unknown subagent model provider "${providerId}" (the spec "${spec}" is well-formed, but this app has no provider with that id).${known} ${inherit}`
  }
  const available = models.length ? ` Provider "${providerId}" has: ${listIds(models)}.` : ` Provider "${providerId}" lists no models.`
  return `Provider "${providerId}" has no model "${modelId}".${available} ${inherit}`
}
