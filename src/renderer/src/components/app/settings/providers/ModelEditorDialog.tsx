import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, CheckCircle2, Copy, ExternalLink, Loader2, PlugZap, Sparkles } from '@/lib/icons'
import { MorphingModal } from '@/components/motion/morphing-modal'
import { Button } from '@/components/motion/button'
import { Input } from '@/components/motion/input'
import { Checkbox } from '@/components/motion/checkbox'
import { useI18n } from '@/i18n'
import type {
  CatalogRecommendationDTO,
  CustomModelDTO,
  CustomProviderDTO,
  ModelConfigSourceDTO,
  ModelCostDTO,
  ModelOverrideDTO,
  ProviderModelDTO,
  TestModelResultDTO
} from '../../../../../../shared/types'
import type { ModelsConfigMutate } from './use-models-config'
import { FORM_FIELD_HEADING, FORM_INPUT_LABEL, FORM_PANEL_TITLE } from '@/lib/form-standard'
import { applyCatalogFill, applyConfigCopy, type CopyExtras, type FormSnapshot } from './model-editor-form'
import { CopyConfigDialog } from './CopyConfigDialog'

export type EditingTarget =
  | { kind: 'new' }
  | { kind: 'carrier'; index: number }
  | { kind: 'override'; row: ProviderModelDTO }

interface ModelEditorDialogProps {
  target: EditingTarget | null
  providerId: string
  /** Current models.json entry for the provider (undefined when none). */
  entry: CustomProviderDTO | undefined
  mutate: ModelsConfigMutate
  flush: () => Promise<void>
  onClose: () => void
}

const COST_FIELDS = [
  { key: 'input', labelKey: 'settings.costInput' },
  { key: 'output', labelKey: 'settings.costOutput' },
  { key: 'cacheRead', labelKey: 'settings.costCacheRead' },
  { key: 'cacheWrite', labelKey: 'settings.costCacheWrite' }
] as const

type CostKey = (typeof COST_FIELDS)[number]['key']
type CostForm = Record<CostKey, string>

/** Positive integer or undefined (blank); NaN flags an invalid entry. */
function parsePositiveInt(value: string): number {
  const trimmed = value.trim()
  if (!trimmed) return 0
  const parsed = Number(trimmed)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : NaN
}

function parseCost(form: CostForm): { cost?: ModelCostDTO; partial: boolean; invalid: boolean } {
  const values = COST_FIELDS.map(({ key }) => form[key].trim())
  const filled = values.filter((v) => v !== '')
  if (filled.length === 0) return { partial: false, invalid: false }
  if (filled.length < values.length) return { partial: true, invalid: false }
  const numbers = values.map((v) => Number(v))
  if (numbers.some((n) => !Number.isFinite(n) || n < 0)) return { partial: false, invalid: true }
  return {
    cost: {
      input: numbers[0],
      output: numbers[1],
      cacheRead: numbers[2],
      cacheWrite: numbers[3]
    },
    partial: false,
    invalid: false
  }
}

/**
 * Editor for one model of a provider, in the two shapes models.json offers:
 * a `models[]` carrier (a full definition — custom models) or a
 * `modelOverrides` patch over a registry definition. Override fields left
 * blank (or equal to the composed base) collapse back to "inherit", so an
 * untouched edit never persists.
 */
export function ModelEditorDialog({
  target,
  providerId,
  entry,
  mutate,
  flush,
  onClose
}: ModelEditorDialogProps) {
  const { t } = useI18n()
  // Seed from a ref so a config refresh (e.g. a debounce response landing)
  // never re-seeds the form out from under the user's keystrokes.
  const entryRef = useRef(entry)
  entryRef.current = entry

  const [modelId, setModelId] = useState('')
  const [name, setName] = useState('')
  const [reasoning, setReasoning] = useState(false)
  const [image, setImage] = useState(false)
  const [contextWindow, setContextWindow] = useState('')
  const [maxTokens, setMaxTokens] = useState('')
  const [cost, setCost] = useState<CostForm>({ input: '', output: '', cacheRead: '', cacheWrite: '' })
  const [formError, setFormError] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<TestModelResultDTO | null>(null)
  const [catalogLoading, setCatalogLoading] = useState(false)
  const [copyOpen, setCopyOpen] = useState(false)
  /** Shared status row for catalog fill / config copy; last action wins. */
  const [fillStatus, setFillStatus] = useState<{ text: string; error?: boolean; undo: FormSnapshot | null } | null>(null)
  /** thinkingLevelMap/compat a copy applied — merged into the saved entry. */
  const extrasRef = useRef<CopyExtras>(null)

  const base = target?.kind === 'override' ? target.row : null
  const existing = useMemo<CustomModelDTO | null>(() => {
    if (!target || target.kind !== 'carrier') return null
    return entry?.models?.[target.index] ?? null
  }, [target, entry])
  const existingRef = useRef(existing)
  existingRef.current = existing

  useEffect(() => {
    if (!target) return
    setFormError(null)
    setTestResult(null)
    setFillStatus(null)
    setCopyOpen(false)
    extrasRef.current = null
    const currentEntry = entryRef.current
    if (target.kind === 'override') {
      const row = target.row
      const patch = currentEntry?.modelOverrides?.[row.id]
      setModelId(row.id)
      setName(patch?.name !== undefined ? String(patch.name) : '')
      setReasoning(patch?.reasoning !== undefined ? Boolean(patch.reasoning) : row.reasoning)
      setImage((patch?.input ?? row.input).includes('image'))
      setContextWindow(patch?.contextWindow !== undefined ? String(patch.contextWindow) : '')
      setMaxTokens(patch?.maxTokens !== undefined ? String(patch.maxTokens) : '')
      setCost({
        input: patch?.cost ? String(patch.cost.input) : '',
        output: patch?.cost ? String(patch.cost.output) : '',
        cacheRead: patch?.cost ? String(patch.cost.cacheRead) : '',
        cacheWrite: patch?.cost ? String(patch.cost.cacheWrite) : ''
      })
      return
    }
    const model = target.kind === 'carrier' ? existingRef.current : null
    setModelId(model?.id ?? '')
    setName(model?.name !== undefined ? String(model.name) : '')
    setReasoning(Boolean(model?.reasoning))
    setImage(Boolean(model?.input?.includes('image')))
    setContextWindow(model?.contextWindow !== undefined ? String(model.contextWindow) : '')
    setMaxTokens(model?.maxTokens !== undefined ? String(model.maxTokens) : '')
    setCost({
      input: model?.cost ? String(model.cost.input) : '',
      output: model?.cost ? String(model.cost.output) : '',
      cacheRead: model?.cost ? String(model.cost.cacheRead) : '',
      cacheWrite: model?.cost ? String(model.cost.cacheWrite) : ''
    })
  }, [target])

  if (!target) return null

  const costParsed = parseCost(cost)
  const idTrimmed = modelId.trim()

  const formSnapshot = (): FormSnapshot => ({
    modelId,
    name,
    reasoning,
    image,
    contextWindow,
    maxTokens,
    cost: { ...cost },
    extras: extrasRef.current
  })

  const restoreSnapshot = (snapshot: FormSnapshot) => {
    setModelId(snapshot.modelId)
    setName(snapshot.name)
    setReasoning(snapshot.reasoning)
    setImage(snapshot.image)
    setContextWindow(snapshot.contextWindow)
    setMaxTokens(snapshot.maxTokens)
    setCost({ ...snapshot.cost })
    extrasRef.current = snapshot.extras
  }

  /** Merge copy-managed extras (thinkingLevelMap/compat) into an entry. A key
   * present with undefined means the source lacked it — clear the target's. */
  const withExtras = <T extends Record<string, unknown>>(entry: T): T => {
    const extras = extrasRef.current
    if (!extras) return entry
    const next = { ...entry }
    for (const key of ['thinkingLevelMap', 'compat'] as const) {
      if (!(key in extras)) continue
      const value = extras[key]
      if (value === undefined) delete next[key]
      else (next as Record<string, unknown>)[key] = value
    }
    return next
  }

  const catalogSummary = (appliedCount: number, recommendation: CatalogRecommendationDTO): string => {
    const applied =
      appliedCount > 0 ? t('settings.catalogFilled', { count: appliedCount }) : t('settings.catalogNoEmptyFields')
    const { price } = recommendation
    if (price.status === 'unreliable') {
      const note =
        price.reason === 'no-exact-match'
          ? t('settings.catalogNoExactMatch')
          : t('settings.catalogPriceUnreliable')
      return `${applied} · ${note}`
    }
    const provider = price.providerName ?? recommendation.matchedProviderName ?? providerId
    const note =
      price.method === 'provider'
        ? t('settings.catalogPriceProvider', { provider })
        : price.method === 'base-url'
          ? t('settings.catalogPriceBaseUrl', { provider })
          : t('settings.catalogPriceConsensus', { support: price.support, total: price.total })
    return `${applied} · ${note}`
  }

  const handleCatalogFill = async () => {
    if (!idTrimmed || catalogLoading) return
    setCatalogLoading(true)
    setFillStatus(null)
    try {
      const snapshot = formSnapshot()
      const recommendation = await window.pi.catalogPreset(providerId, idTrimmed)
      const { next, appliedCount } = applyCatalogFill(snapshot, recommendation.preset)
      if (appliedCount > 0) {
        restoreSnapshot(next)
        setFillStatus({ text: catalogSummary(appliedCount, recommendation), undo: snapshot })
      } else {
        setFillStatus({ text: catalogSummary(appliedCount, recommendation), undo: null })
      }
    } catch (error) {
      setFillStatus({ text: error instanceof Error ? error.message : String(error), error: true, undo: null })
    } finally {
      setCatalogLoading(false)
    }
  }

  const handleCopyPick = (source: ModelConfigSourceDTO) => {
    setCopyOpen(false)
    const snapshot = formSnapshot()
    const { next, appliedCount } = applyConfigCopy(snapshot, source)
    if (appliedCount === 0) {
      setFillStatus({ text: t('settings.copyNothing'), undo: null })
      return
    }
    restoreSnapshot(next)
    setFillStatus({ text: t('settings.copyApplied', { model: source.name || source.id, count: appliedCount }), undo: snapshot })
  }

  const undoFill = () => {
    if (!fillStatus?.undo) return
    restoreSnapshot(fillStatus.undo)
    setFillStatus(null)
  }

  /** The carrier draft the form currently represents (never commits). */
  const buildCarrierDraft = (): CustomModelDTO => {
    const draft: CustomModelDTO = { ...(existing ?? {}), id: idTrimmed }
    const nameValue = name.trim()
    if (nameValue) draft.name = nameValue
    else delete draft.name
    if (reasoning) draft.reasoning = true
    else delete draft.reasoning
    if (image) draft.input = ['text', 'image']
    else delete draft.input
    const context = parsePositiveInt(contextWindow)
    if (context > 0) draft.contextWindow = context
    else delete draft.contextWindow
    const max = parsePositiveInt(maxTokens)
    if (max > 0) draft.maxTokens = max
    else delete draft.maxTokens
    if (costParsed.cost) draft.cost = costParsed.cost
    else delete draft.cost
    return withExtras(draft)
  }

  /** Override patch with inherit-collapse: a value equal to the composed
   * base stays undefined so untouched fields never persist. */
  const buildOverride = (): ModelOverrideDTO => {
    const patch: ModelOverrideDTO = {}
    // Hiding is a visibility flag the form never edits; carry it across a
    // save so editing a hidden model's parameters never unhides it.
    if (target.kind === 'override' && entryRef.current?.modelOverrides?.[target.row.id]?.hidden === true) {
      patch.hidden = true
    }
    const nameValue = name.trim()
    if (nameValue && nameValue !== base?.name) patch.name = nameValue
    if (base && reasoning !== base.reasoning) patch.reasoning = reasoning
    if (base && image !== base.input.includes('image')) {
      patch.input = image ? ['text', 'image'] : ['text']
    }
    if (base) {
      const context = parsePositiveInt(contextWindow)
      if (context > 0 && context !== base.contextWindow) patch.contextWindow = context
      const max = parsePositiveInt(maxTokens)
      if (max > 0 && max !== base.maxTokens) patch.maxTokens = max
      if (costParsed.cost && base.cost) {
        const same =
          base.cost.input === costParsed.cost.input &&
          base.cost.output === costParsed.cost.output &&
          base.cost.cacheRead === costParsed.cost.cacheRead &&
          base.cost.cacheWrite === costParsed.cost.cacheWrite
        if (!same) patch.cost = costParsed.cost
      } else if (costParsed.cost) {
        patch.cost = costParsed.cost
      }
    }
    return withExtras(patch)
  }

  const validate = (): string | null => {
    if (target.kind !== 'override' && !idTrimmed) return t('settings.modelIdRequired')
    if (costParsed.partial) return t('settings.costAllOrNothing')
    if (costParsed.invalid) return t('settings.costInvalid')
    for (const [label, value] of [
      [t('settings.contextWindow'), contextWindow],
      [t('settings.maxTokens'), maxTokens]
    ] as const) {
      if (value.trim() && Number.isNaN(parsePositiveInt(value))) {
        return t('settings.numberInvalid', { field: label })
      }
    }
    return null
  }

  const save = () => {
    const error = validate()
    if (error) {
      setFormError(error)
      return
    }
    if (target.kind === 'override') {
      const patch = buildOverride()
      const rowId = target.row.id
      mutate(
        (draft) => {
          const provider = draft.providers[providerId] ?? {}
          const overrides = { ...(provider.modelOverrides ?? {}) }
          if (Object.keys(patch).length > 0) overrides[rowId] = patch
          else delete overrides[rowId]
          return {
            ...draft,
            providers: {
              ...draft.providers,
              [providerId]: { ...provider, modelOverrides: overrides }
            }
          }
        },
        true
      )
      onClose()
      return
    }
    const model = buildCarrierDraft()
    const previousId = existing?.id?.trim()
    mutate(
      (draft) => {
        const provider = draft.providers[providerId] ?? {}
        const models = [...(provider.models ?? [])]
        if (target.kind === 'carrier') models[target.index] = model
        else models.push(model)
        const overrides = { ...(provider.modelOverrides ?? {}) }
        // A renamed carrier takes its override along.
        if (previousId && previousId !== model.id && overrides[previousId] !== undefined) {
          overrides[model.id] = overrides[previousId]
          delete overrides[previousId]
        }
        return {
          ...draft,
          providers: {
            ...draft.providers,
            [providerId]: { ...provider, models, modelOverrides: overrides }
          }
        }
      },
      true
    )
    onClose()
  }

  const removeCarrier = () => {
    if (target.kind !== 'carrier') return
    const removedId = existing?.id?.trim()
    const index = target.index
    mutate(
      (draft) => {
        const provider = draft.providers[providerId] ?? {}
        const models = [...(provider.models ?? [])]
        models.splice(index, 1)
        const overrides = { ...(provider.modelOverrides ?? {}) }
        if (removedId) delete overrides[removedId]
        return {
          ...draft,
          providers: {
            ...draft.providers,
            [providerId]: { ...provider, models, modelOverrides: overrides }
          }
        }
      },
      true
    )
    onClose()
  }

  const resetOverride = () => {
    if (target.kind !== 'override') return
    const rowId = target.row.id
    mutate(
      (draft) => {
        const provider = draft.providers[providerId] ?? {}
        const overrides = { ...(provider.modelOverrides ?? {}) }
        // Reset restores parameters; the visibility choice survives it.
        const keepHidden = overrides[rowId]?.hidden === true
        delete overrides[rowId]
        if (keepHidden) overrides[rowId] = { hidden: true }
        return {
          ...draft,
          providers: {
            ...draft.providers,
            [providerId]: { ...provider, modelOverrides: overrides }
          }
        }
      },
      true
    )
    onClose()
  }

  const runTest = async () => {
    const error = validate()
    if (error) {
      setFormError(error)
      return
    }
    setTesting(true)
    setTestResult(null)
    try {
      await flush()
      const model: CustomModelDTO =
        target.kind === 'override'
          ? { ...buildOverride(), id: target.row.id, name: name.trim() || target.row.name }
          : buildCarrierDraft()
      setTestResult(await window.pi.testModel(providerId, model))
    } catch (err) {
      setTestResult({ ok: false, error: err instanceof Error ? err.message : String(err) })
    } finally {
      setTesting(false)
    }
  }

  const placeholder = (value: number, fallback: string) =>
    value > 0 ? String(value) : fallback

  return (
    <MorphingModal viewId={target ? 'model-editor' : null} onClose={onClose} placement="center" className="w-[min(44rem,calc(100vw-3rem))] max-w-none">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className={FORM_PANEL_TITLE}>
            {target.kind === 'new' ? t('settings.addModel') : t('settings.editModel')}
          </h2>
          <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
            {providerId}/{idTrimmed || '…'}
          </p>
        </div>
        {target.kind === 'override' ? (
          <span className="shrink-0 rounded-control bg-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            {t('settings.overrideBadge')}
          </span>
        ) : null}
      </div>

      {/* p-1 keeps the inputs' focus rings from being clipped by the scroll box. */}
      <div data-form-items className="mt-4 grid max-h-[min(40rem,calc(100vh-3rem))] gap-5 overflow-y-auto p-1 md:grid-cols-2">
        {target.kind === 'override' ? (
          <div className="rounded-xl bg-muted/60 px-3 py-2">
            <p className="font-mono text-sm text-foreground">{target.row.id}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{t('settings.overrideHint')}</p>
          </div>
        ) : (
          <Input
            label={t('settings.modelId')}
            value={modelId}
            onChange={(v) => {
              setModelId(v)
              setFormError(null)
            }}
            placeholder="qwen3-32b"
            classNames={{ ...FORM_INPUT_LABEL, input: 'font-mono text-sm' }}
            autoFocus={target.kind === 'new'}
          />
        )}

        <Input
          label={t('settings.modelName')}
          value={name}
          onChange={setName}
          placeholder={target.kind === 'override' ? (base?.name ?? '') : t('settings.modelNamePlaceholder')}
          classNames={FORM_INPUT_LABEL}
        />

        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            className="px-2"
            disabled={!idTrimmed || catalogLoading}
            onClick={() => void handleCatalogFill()}
          >
            {catalogLoading ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Sparkles className="size-3.5" />
            )}
            {catalogLoading ? t('settings.catalogFilling') : t('settings.fillFromCatalog')}
          </Button>
          <Button variant="ghost" size="sm" className="px-2" onClick={() => setCopyOpen(true)}>
            <Copy className="size-3.5" />
            {t('settings.copyFromModel')}
          </Button>
          <button
            type="button"
            className="ml-auto inline-flex items-center gap-1 rounded-control px-1 text-[11px] text-muted-foreground/70 transition-colors hover:bg-muted hover:text-muted-foreground"
            onClick={() => void window.pi.openExternal('https://models.dev')}
          >
            {t('settings.catalogSource')}
            <ExternalLink className="size-3" />
          </button>
        </div>

        {fillStatus ? (
          <div
            aria-live="polite"
            className={`flex min-h-5 items-center justify-between gap-2 text-xs ${
              fillStatus.error ? 'text-destructive' : 'text-muted-foreground'
            }`}
          >
            <span className="min-w-0 truncate">{fillStatus.text}</span>
            {fillStatus.undo ? (
              <button
                type="button"
                className="shrink-0 rounded-control px-1 text-primary transition-colors hover:bg-primary/10"
                onClick={undoFill}
              >
                {t('settings.undo')}
              </button>
            ) : null}
          </div>
        ) : null}

        <div className="flex flex-wrap gap-x-6 gap-y-2">
          <Checkbox mark="square" checked={reasoning} onCheckedChange={setReasoning} label={t('settings.reasoning')} />
          <Checkbox mark="square" checked={image} onCheckedChange={setImage} label={t('settings.imageInput')} />
        </div>

        <div className="grid grid-cols-2 gap-5 md:col-span-2">
          <Input
            label={t('settings.contextWindow')}
            value={contextWindow}
            onChange={(v) => {
              setContextWindow(v)
              setFormError(null)
            }}
            inputMode="numeric"
            placeholder={target.kind === 'override' ? placeholder(base?.contextWindow ?? 0, '—') : '131072'}
            classNames={FORM_INPUT_LABEL}
          />
          <Input
            label={t('settings.maxTokens')}
            value={maxTokens}
            onChange={(v) => {
              setMaxTokens(v)
              setFormError(null)
            }}
            inputMode="numeric"
            placeholder={target.kind === 'override' ? placeholder(base?.maxTokens ?? 0, '—') : '16384'}
            classNames={FORM_INPUT_LABEL}
          />
        </div>

        <div className="md:col-span-2">
          <p className={FORM_FIELD_HEADING}>{t('settings.pricing')}</p>
          <div className="grid grid-cols-2 gap-5">
            {COST_FIELDS.map(({ key, labelKey }) => (
              <Input
                key={key}
                label={t(labelKey)}
                value={cost[key]}
                onChange={(v) => {
                  setCost((prev) => ({ ...prev, [key]: v }))
                  setFormError(null)
                }}
                inputMode="decimal"
                placeholder={
                  target.kind === 'override' && base?.cost ? String(base.cost[key]) : '0'
                }
                classNames={FORM_INPUT_LABEL}
              />
            ))}
          </div>
        </div>
      </div>

      {formError ? (
        <p className="mt-3 flex items-center gap-1.5 text-xs text-destructive">
          <AlertCircle className="size-3.5 shrink-0" />
          {formError}
        </p>
      ) : null}

      {testResult ? (
        <div
          className={`mt-3 flex items-start gap-1.5 rounded-xl px-3 py-2 text-xs ${
            testResult.ok
              ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
              : 'bg-destructive/10 text-destructive'
          }`}
        >
          {testResult.ok ? (
            <CheckCircle2 className="mt-0.5 size-3.5 shrink-0" />
          ) : (
            <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
          )}
          <span className="min-w-0 break-words">
            {testResult.ok
              ? `${t('settings.testOk', { ms: testResult.latencyMs ?? 0, status: testResult.status ?? 200 })}${
                  testResult.responseText ? ` · ${testResult.responseText.slice(0, 60)}` : ''
                }`
              : (testResult.error ?? t('settings.testFailed'))}
          </span>
        </div>
      ) : null}

      <div className="mt-5 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          {target.kind === 'carrier' && existing ? (
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive hover:bg-destructive/10"
              onClick={removeCarrier}
            >
              {t('settings.deleteModel')}
            </Button>
          ) : null}
          {target.kind === 'override' ? (
            <Button variant="ghost" size="sm" onClick={resetOverride}>
              {t('settings.resetOverride')}
            </Button>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" disabled={testing} onClick={() => void runTest()}>
            {testing ? <Loader2 className="size-3.5 animate-spin" /> : <PlugZap className="size-3.5" />}
            {testing ? t('settings.testing') : t('settings.test')}
          </Button>
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" size="sm" onClick={save}>
            {t('settings.saveModel')}
          </Button>
        </div>
      </div>
      <CopyConfigDialog
        open={copyOpen}
        providerId={providerId}
        excludeModelId={target.kind === 'override' ? target.row.id : idTrimmed || undefined}
        onPick={handleCopyPick}
        onClose={() => setCopyOpen(false)}
      />
    </MorphingModal>
  )
}
