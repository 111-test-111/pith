import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowRight, Loader2, Search } from '@/lib/icons'
import { Button } from '@/components/motion/button'
import { Input } from '@/components/motion/input'
import { useI18n } from '@/i18n'
import type { ModelConfigSourceDTO } from '../../../../../../shared/types'
import { ProviderIcon } from '../../ProviderIcon'
import { ModelInputBadges } from '../../ModelInputBadges'
import { ProviderDialog, ProviderNotice, PROVIDER_INPUT_CLASS_NAMES } from './ProviderUi'

const SHOWN_LIMIT = 300

/** Search configured models and copy parameters while the parent draft stays mounted. */
export function CopyConfigDialog({
  open, providerId, excludeModelId, onPick, onClose
}: {
  open: boolean
  providerId: string
  excludeModelId?: string
  onPick: (source: ModelConfigSourceDTO) => void
  onClose: () => void
}) {
  const { t } = useI18n()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [models, setModels] = useState<ModelConfigSourceDTO[]>([])
  const [query, setQuery] = useState('')
  const [retry, setRetry] = useState(0)
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    setError(null)
    setModels([])
    setQuery('')
    void window.pi.configuredModels()
      .then(sources => { if (!cancelled) setModels(sources) })
      .catch(err => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [open, retry])

  const matched = useMemo(() => {
    const keyword = query.trim().toLocaleLowerCase()
    return models.filter(model =>
      !(model.providerId === providerId && model.id === excludeModelId) &&
      (!keyword || [model.id, model.name, model.providerName, model.providerId].join(' ').toLocaleLowerCase().includes(keyword))
    ).sort((a, b) => Number(b.providerId === providerId) - Number(a.providerId === providerId) ||
      a.providerName.localeCompare(b.providerName) || (a.name || a.id).localeCompare(b.name || b.id))
  }, [models, query, providerId, excludeModelId])
  const shown = matched.slice(0, SHOWN_LIMIT)

  return (
    <ProviderDialog open={open} onClose={onClose}
      title={t('settings.copyFromModel')} description={t('settings.copyFromModelHint')} initialFocusRef={searchRef}
      toolbar={<Input ref={searchRef} value={query} onChange={setQuery} leftIcon={<Search />}
        classNames={PROVIDER_INPUT_CLASS_NAMES}
        placeholder={t('settings.copySearchPlaceholder', { count: models.length })} aria-label={t('settings.copyFromModel')} />}
      footer={<div className="flex items-center justify-between gap-3">
        <span className="text-xs text-muted-foreground">{t('settings.providerModelCount', { count: matched.length })}</span>
        <Button variant="ghost" size="sm" onClick={onClose}>{t('common.cancel')}</Button>
      </div>}
    >
      {loading ? (
        <div className="flex items-center justify-center gap-2 py-10 text-xs text-muted-foreground"><Loader2 className="size-4 animate-spin" />{t('settings.loadingModels')}</div>
      ) : error ? (
        <div className="mt-3"><ProviderNotice tone="error">
          <div className="flex items-center justify-between gap-2">
            <span>{t('settings.copyLoadFailed')} · {error}</span><Button variant="ghost" size="sm" onClick={() => setRetry(value => value + 1)}>{t('settings.providerRetry')}</Button>
          </div>
        </ProviderNotice></div>
      ) : shown.length === 0 ? (
        <p className="py-10 text-center text-xs text-muted-foreground">{t('settings.copyNoMatches')}</p>
      ) : (
        <div className="space-y-1">
          {shown.map((model, index) => (
            <div key={model.providerId + '/' + model.id}>
              {index === 0 || shown[index - 1].providerId !== model.providerId ? (
                <div className="flex items-center gap-2 px-2 pb-1 pt-3 text-xs font-medium text-muted-foreground">
                  <ProviderIcon providerId={model.providerId} name={model.providerName} size={16} /><span className="truncate">{model.providerName}</span>
                </div>
              ) : null}
              <Button variant="ghost" data-copy-model={model.id}
                className="h-auto w-full min-w-0 justify-between gap-3 px-3 py-2.5 text-left text-xs" onClick={() => onPick(model)}>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs text-foreground">{model.name || model.id}</span>
                  <span className="mt-0.5 block truncate font-mono text-caption font-normal text-muted-foreground">{model.id}</span>
                  <span className="mt-1 flex flex-wrap items-center gap-2 text-caption font-normal text-muted-foreground">
                    {model.contextWindow ? <span>{t('model.contextK', { k: Math.round(model.contextWindow / 1000) })}</span> : null}
                    {model.reasoning ? <span>{t('settings.reasoning')}</span> : null}<ModelInputBadges input={model.input} />
                  </span>
                </span>
                <ArrowRight className="size-3.5 shrink-0 text-muted-foreground" />
              </Button>
            </div>
          ))}
          {matched.length > shown.length ? <p className="px-2 pt-2 text-caption text-muted-foreground">{t('settings.discoverCapped', { shown: shown.length, total: matched.length })}</p> : null}
        </div>
      )}
    </ProviderDialog>
  )
}
