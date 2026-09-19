import { useMemo, useState } from 'react'
import { Brain } from '@/lib/icons'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/motion/select'
import { useI18n } from '@/i18n'
import type { MessageKey } from '@/i18n/locales/en'
import { ProviderIcon } from './ProviderIcon'
import { ModelInputBadges } from './ModelInputBadges'
import type { ModelDTO, ThinkingLevel } from '../../../../shared/types'

type Translate = ReturnType<typeof useI18n>['t']

/** i18n keys for the SDK's thinking-level ids. */
const THINKING_KEYS: Record<ThinkingLevel, MessageKey> = {
  off: 'thinking.off',
  minimal: 'thinking.minimal',
  low: 'thinking.low',
  medium: 'thinking.medium',
  high: 'thinking.high',
  xhigh: 'thinking.xhigh',
  max: 'thinking.max'
}

function levelLabel(t: Translate, level: ThinkingLevel): string {
  return t(THINKING_KEYS[level])
}

interface ModelPickerProps {
  models: ModelDTO[]
  /** `providerId/modelId` of the active model, or null before a session. */
  value: string | null
  thinkingLevel: ThinkingLevel
  /** Levels the ACTIVE model supports (SDK getAvailableThinkingLevels). */
  availableThinkingLevels: ThinkingLevel[]
  onChange: (model: ModelDTO) => void | Promise<void>
  onThinkingLevelChange: (level: ThinkingLevel) => void
  disabled?: boolean
}

const modelKey = (model: { providerId: string; id: string }) => `${model.providerId}/${model.id}`

/**
 * Two adjacent pickers: one chooses the model, the one beside it chooses the
 * thinking level of THAT model. Both are `Select`s, the same primitive as the
 * sandbox-mode picker beside them and Settings → Providers' default-model row:
 * the panels hang off their triggers in the layout (`absolute left-0
 * top-full`), so they cannot drift away — a portalled panel positioned from
 * coordinates measured on mount could, since the composer moves in ways no
 * window resize or scroll reports (see `SelectContent`). Picking is a choice
 * from a list, so there is no search field: a trigger states its current
 * value, never a query.
 *
 * The level picker exists only for a reasoning model with more than the single
 * "off" level — a non-reasoning model had no level UI before the split either.
 * Its list is the session's SDK-authoritative `availableThinkingLevels`, which
 * arrives one IPC round trip after a model switch; until the snapshot lands
 * the list still describes the PREVIOUS model, so the picker is disabled for
 * that window instead of offering levels the new model does not support.
 */
export function ModelPicker({
  models,
  value,
  thinkingLevel,
  availableThinkingLevels,
  onChange,
  onThinkingLevelChange,
  disabled
}: ModelPickerProps) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [levelOpen, setLevelOpen] = useState(false)
  /**
   * Model key whose snapshot is in flight. Cleared in a render-phase adjust
   * the moment `value` becomes that key (the snapshot landed); the ref-free
   * state keeps the level picker's disabled state honest in that exact render.
   */
  const [pendingModel, setPendingModel] = useState<string | null>(null)
  if (pendingModel !== null && pendingModel === value) setPendingModel(null)

  const grouped = useMemo(() => {
    const byProvider = new Map<string, { providerName: string; models: ModelDTO[] }>()
    for (const model of models) {
      if (!model.available) continue
      const entry = byProvider.get(model.providerId) ?? {
        providerName: model.providerName || model.providerId,
        models: []
      }
      entry.models.push(model)
      byProvider.set(model.providerId, entry)
    }
    return [...byProvider.entries()]
      .map(([providerId, entry]) => ({
        providerId,
        providerName: entry.providerName,
        models: entry.models.sort((a, b) => a.name.localeCompare(b.name))
      }))
      .sort((a, b) => a.providerName.localeCompare(b.providerName))
  }, [models])

  const current = useMemo(
    () => models.find((m) => modelKey(m) === value) ?? null,
    [models, value]
  )

  const handleValueChange = (next: string) => {
    const model = models.find((m) => modelKey(m) === next)
    if (!model) return
    setPendingModel(modelKey(model))
    setLevelOpen(false)
    void Promise.resolve(onChange(model)).catch(() => setPendingModel(null))
  }

  const switching = pendingModel !== null
  const showLevels = Boolean(current?.reasoning && availableThinkingLevels.length > 1)

  return (
    <>
      <Select
        open={open}
        onOpenChange={setOpen}
        value={value ?? undefined}
        onValueChange={handleValueChange}
        disabled={disabled}
        className="w-auto"
      >
        <SelectTrigger
          aria-label={t('model.choose')}
          className="h-8 w-auto min-w-0 gap-1.5 rounded-control border-0 bg-transparent px-2.5 text-xs hover:bg-muted"
        >
          <span className="flex min-w-0 items-center gap-1.5 whitespace-nowrap">
            {current ? (
              <ProviderIcon providerId={current.providerId} name={current.providerName} size={14} />
            ) : null}
            <span className="max-w-44 truncate">
              {current ? current.name : t('model.choose')}
            </span>
          </span>
        </SelectTrigger>

        <SelectContent className="left-0 right-auto w-80">
          <div className="max-h-80 overflow-y-auto">
            {grouped.map((group, index) => (
              <div key={group.providerId}>
                {index > 0 ? <div aria-hidden className="mx-1 my-1 h-px bg-border" /> : null}
                <div className="flex items-center gap-1.5 px-2.5 pb-0.5 pt-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  <ProviderIcon providerId={group.providerId} name={group.providerName} size={12} />
                  <span className="truncate">{group.providerName}</span>
                  <span className="ml-auto font-normal normal-case">{group.models.length}</span>
                </div>
                {group.models.map((model) => (
                  <SelectItem
                    key={modelKey(model)}
                    value={modelKey(model)}
                    className="py-1.5"
                  >
                    {/* Name/meta column, with the inputs it accepts stated
                        in the meta line. */}
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-sm text-foreground">{model.name}</span>
                      <span className="flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground">
                        <span className="truncate">
                          {model.reasoning ? t('model.reasoning') : t('model.standard')}
                          {model.contextWindow
                            ? ` · ${t('model.contextK', { k: Math.round(model.contextWindow / 1000) })}`
                            : ''}
                        </span>
                        <ModelInputBadges input={model.input} />
                      </span>
                    </span>
                  </SelectItem>
                ))}
              </div>
            ))}
            {grouped.length === 0 ? (
              <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                {t('model.noProviders')}
              </p>
            ) : null}
          </div>
        </SelectContent>
      </Select>

      {showLevels ? (
        <Select
          open={levelOpen}
          onOpenChange={setLevelOpen}
          value={thinkingLevel}
          onValueChange={(next) => onThinkingLevelChange(next as ThinkingLevel)}
          disabled={disabled || switching}
          className="w-auto"
        >
          <SelectTrigger
            aria-label={t('model.thinkingTitle')}
            className="h-8 w-auto min-w-0 gap-1.5 rounded-control border-0 bg-transparent px-2.5 text-xs hover:bg-muted"
          >
            <span className="flex min-w-0 items-center gap-1.5 whitespace-nowrap">
              <Brain aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="max-w-24 truncate">{levelLabel(t, thinkingLevel)}</span>
            </span>
          </SelectTrigger>

          <SelectContent className="left-0 right-auto w-44">
            <div className="max-h-80 overflow-y-auto">
              {availableThinkingLevels.map((level) => (
                <SelectItem key={level} value={level} className="py-1.5">
                  <span className="truncate text-sm text-foreground">{levelLabel(t, level)}</span>
                </SelectItem>
              ))}
            </div>
          </SelectContent>
        </Select>
      ) : null}
    </>
  )
}
