import type {
  CatalogPresetDTO,
  ModelConfigSourceDTO
} from '../../../../../../shared/types'

/**
 * Form-level logic for the model editor's bulk actions: "fill from models.dev"
 * (fills only empty fields) and "copy from model" (mirrors the source's
 * parameter fields). Both operate on the editor's form snapshot so the
 * one-step undo can restore it verbatim.
 */

export interface CostForm {
  input: string
  output: string
  cacheRead: string
  cacheWrite: string
}

/** Extra parameter fields a copy manages but the form has no input for. */
export type CopyExtras = { thinkingLevelMap?: unknown; compat?: unknown } | null

export interface FormSnapshot {
  modelId: string
  name: string
  reasoning: boolean
  image: boolean
  contextWindow: string
  maxTokens: string
  cost: CostForm
  extras: CopyExtras
}

const COST_KEYS = ['input', 'output', 'cacheRead', 'cacheWrite'] as const

export function costFormIsEmpty(cost: CostForm): boolean {
  return COST_KEYS.every((key) => cost[key].trim() === '')
}

/** Deep equality over JSON-shaped values (copy comparisons only ever see
 * what models.json can hold). */
export function jsonEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((item, i) => jsonEquals(item, b[i]))
  }
  const ka = Object.keys(a as Record<string, unknown>)
  const kb = Object.keys(b as Record<string, unknown>)
  if (ka.length !== kb.length) return false
  return ka.every((key) => jsonEquals((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]))
}

/**
 * Fill only the form's empty fields from a models.dev preset. Cost is
 * all-or-nothing: the group is filled only when the form is blank and the
 * preset carries a complete one.
 */
export function applyCatalogFill(
  form: FormSnapshot,
  preset: CatalogPresetDTO
): { next: FormSnapshot; appliedCount: number } {
  const next = { ...form, cost: { ...form.cost } }
  let appliedCount = 0
  if (!next.name.trim() && preset.name) {
    next.name = preset.name
    appliedCount += 1
  }
  if (!next.reasoning && preset.reasoning === true) {
    next.reasoning = true
    appliedCount += 1
  }
  if (!next.image && preset.input?.includes('image')) {
    next.image = true
    appliedCount += 1
  }
  if (!next.contextWindow.trim() && preset.contextWindow !== undefined) {
    next.contextWindow = String(preset.contextWindow)
    appliedCount += 1
  }
  if (!next.maxTokens.trim() && preset.maxTokens !== undefined) {
    next.maxTokens = String(preset.maxTokens)
    appliedCount += 1
  }
  if (costFormIsEmpty(next.cost) && preset.cost) {
    for (const key of COST_KEYS) next.cost[key] = String(preset.cost[key])
    appliedCount += 4
  }
  return { next, appliedCount }
}

/**
 * Mirror a source model's parameter fields onto the form. id/name stay the
 * target's own; api/baseUrl/headers are connection concerns and never copy.
 * A field the source lacks clears the form's value; unknown limits (0) copy
 * as "unset" because the editor rejects non-positive numbers. Returns how
 * many fields actually changed (for the status row and a no-op message).
 */
export function applyConfigCopy(
  form: FormSnapshot,
  source: ModelConfigSourceDTO
): { next: FormSnapshot; appliedCount: number } {
  const next: FormSnapshot = {
    ...form,
    cost: { ...form.cost },
    extras: { thinkingLevelMap: source.thinkingLevelMap, compat: source.compat }
  }
  let changed = 0

  if (next.reasoning !== source.reasoning) {
    next.reasoning = source.reasoning
    changed += 1
  }
  const nextImage = Boolean(source.input?.includes('image'))
  if (next.image !== nextImage) {
    next.image = nextImage
    changed += 1
  }
  const nextContext = source.contextWindow > 0 ? String(source.contextWindow) : ''
  if (next.contextWindow !== nextContext) {
    next.contextWindow = nextContext
    changed += 1
  }
  const nextMax = source.maxTokens > 0 ? String(source.maxTokens) : ''
  if (next.maxTokens !== nextMax) {
    next.maxTokens = nextMax
    changed += 1
  }
  const nextCost: CostForm = source.cost
    ? {
        input: String(source.cost.input ?? 0),
        output: String(source.cost.output ?? 0),
        cacheRead: String(source.cost.cacheRead ?? 0),
        cacheWrite: String(source.cost.cacheWrite ?? 0)
      }
    : { input: '', output: '', cacheRead: '', cacheWrite: '' }
  if (!jsonEquals(next.cost, nextCost)) {
    next.cost = nextCost
    changed += 1
  }
  const previousExtras = form.extras ?? {}
  if (!jsonEquals(previousExtras.thinkingLevelMap, source.thinkingLevelMap)) changed += 1
  if (!jsonEquals(previousExtras.compat, source.compat)) changed += 1

  return { next, appliedCount: changed }
}
