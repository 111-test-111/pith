import { useMemo } from 'react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger
} from '@/components/motion/select'
import { useI18n } from '@/i18n'
import { ProviderIcon } from './ProviderIcon'
import type { ModelDTO } from '../../../../shared/types'

interface ModelPickerProps {
  models: ModelDTO[]
  value: string | null
  onChange: (model: ModelDTO) => void
  disabled?: boolean
}

/**
 * Composer model selector: a plain beUI Select button (provider icon + model
 * name on a single line) opening a grouped panel. Unauthenticated providers
 * are omitted (configure them in Settings).
 */
export function ModelPicker({ models, value, onChange, disabled }: ModelPickerProps) {
  const { t } = useI18n()
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
    () => models.find((m) => `${m.providerId}/${m.id}` === value) ?? null,
    [models, value]
  )

  return (
    <Select
      value={value ?? undefined}
      onValueChange={(next) => {
        const [providerId, ...rest] = next.split('/')
        const model = models.find((m) => m.providerId === providerId && m.id === rest.join('/'))
        if (model) onChange(model)
      }}
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
                  key={`${model.providerId}/${model.id}`}
                  value={`${model.providerId}/${model.id}`}
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
  )
}
