import { useEffect, useMemo, useRef, useState } from 'react'
import { Brain, ChevronLeft, ChevronRight, Loader2 } from 'lucide-react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger
} from '@/components/motion/select'
import { useI18n } from '@/i18n'
import type { MessageKey } from '@/i18n/locales/en'
import { ProviderIcon } from './ProviderIcon'
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
 * Two-stage composer picker: the model list first, then — for a reasoning
 * model — the thinking levels that model actually supports, with a back row to
 * return to the list. The trigger carries both ("Model · High").
 *
 * The level list is the session's SDK-authoritative `availableThinkingLevels`,
 * so it only exists for the active model: after picking a model the panel waits
 * one IPC round trip for the snapshot, instead of guessing from a hardcoded
 * list or re-deriving `thinkingLevelMap`.
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
  /** Model key whose thinking levels the panel is currently showing. */
  const [levelsFor, setLevelsFor] = useState<string | null>(null)
  /** Set right before a model row is picked: the vendored Select closes on
   * every item click, but the model step has to keep the panel open. */
  const keepOpenRef = useRef(false)

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
  // Levels belong to the active model; while the model switch is in flight the
  // list would still describe the previous one.
  const levelsReady = levelsFor !== null && levelsFor === value

  // A reasoning model whose level map leaves nothing but "off" has no second
  // step — close instead of showing a one-item list.
  useEffect(() => {
    if (levelsFor && levelsReady && availableThinkingLevels.length <= 1) {
      setLevelsFor(null)
      setOpen(false)
    }
  }, [levelsFor, levelsReady, availableThinkingLevels.length])

  const levelSuffix = current?.reasoning ? ` · ${levelLabel(t, thinkingLevel)}` : ''

  const handleValueChange = (next: string) => {
    if (levelsFor) {
      onThinkingLevelChange(next as ThinkingLevel)
      setLevelsFor(null)
      return
    }
    const model = models.find((m) => modelKey(m) === next)
    if (!model) return
    // Non-reasoning models have exactly one level ("off"); nothing to choose.
    if (!model.reasoning) {
      void Promise.resolve(onChange(model))
      return
    }
    keepOpenRef.current = true
    setLevelsFor(modelKey(model))
    void Promise.resolve(onChange(model)).catch(() => {
      setLevelsFor(null)
      setOpen(false)
    })
  }

  return (
    <Select
      open={open}
      onOpenChange={(next) => {
        if (!next && keepOpenRef.current) {
          keepOpenRef.current = false
          return
        }
        setOpen(next)
        if (!next) setLevelsFor(null)
      }}
      value={levelsFor ? thinkingLevel : (value ?? undefined)}
      onValueChange={handleValueChange}
      disabled={disabled}
      className="w-auto"
    >
      <SelectTrigger
        aria-label={t('model.choose')}
        className="h-8 w-auto gap-1.5 rounded-full border-0 bg-transparent px-2.5 text-xs hover:bg-muted"
      >
        <span className="flex min-w-0 items-center gap-1.5 whitespace-nowrap">
          {current ? (
            <ProviderIcon providerId={current.providerId} name={current.providerName} size={14} />
          ) : null}
          <span className="max-w-44 truncate">
            {current ? `${current.name}${levelSuffix}` : t('model.choose')}
          </span>
        </span>
      </SelectTrigger>

      <SelectContent className="left-0 right-auto w-80">
        <div className="max-h-80 overflow-y-auto">
          {levelsFor ? (
            <>
              <div className="flex items-center gap-1 px-1.5 pb-0.5 pt-1">
                <button
                  type="button"
                  aria-label={t('model.backToModels')}
                  title={t('model.backToModels')}
                  onClick={() => setLevelsFor(null)}
                  className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <ChevronLeft className="size-3.5" />
                </button>
                <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-foreground">
                  {current?.name ?? levelsFor}
                </span>
                {/* Keep the section label on one line: a long model name
                    truncates instead of wrapping it. */}
                <span className="ml-auto flex shrink-0 items-center gap-1 whitespace-nowrap pr-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  <Brain aria-hidden="true" className="size-3 shrink-0" />
                  {t('model.thinkingTitle')}
                </span>
              </div>
              {levelsReady ? (
                availableThinkingLevels.map((level) => (
                  <SelectItem key={level} value={level} className="py-1.5">
                    <span className="flex min-w-0 flex-1 items-center gap-2">
                      <span className="truncate text-sm text-foreground">{levelLabel(t, level)}</span>
                    </span>
                  </SelectItem>
                ))
              ) : (
                <p className="flex items-center gap-2 px-3 py-3 text-xs text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" />
                  {t('model.thinkingLoading')}
                </p>
              )}
            </>
          ) : (
            <>
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
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-sm text-foreground">{model.name}</span>
                        <span className="truncate text-[11px] text-muted-foreground">
                          {model.reasoning ? t('model.reasoning') : t('model.standard')}
                          {model.contextWindow
                            ? ` · ${t('model.contextK', { k: Math.round(model.contextWindow / 1000) })}`
                            : ''}
                        </span>
                      </span>
                      {/* A reasoning model has a second step; hint it. */}
                      {model.reasoning ? (
                        <ChevronRight aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
                      ) : null}
                    </SelectItem>
                  ))}
                </div>
              ))}
              {grouped.length === 0 ? (
                <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                  {t('model.noProviders')}
                </p>
              ) : null}
            </>
          )}
        </div>
      </SelectContent>
    </Select>
  )
}
