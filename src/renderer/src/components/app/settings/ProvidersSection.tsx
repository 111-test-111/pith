import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { ArrowRight, CheckCircle2, KeyRound, Loader2, RefreshCw, Search } from '@/lib/icons'
import { Button } from '@/components/motion/button'
import { Input } from '@/components/motion/input'
import { Tooltip } from '@/components/motion/tooltip'
import { EASE_OUT } from '@/lib/ease'
import { useI18n } from '@/i18n'
import type { DefaultModelDTO, ModelDTO, ProviderDTO } from '../../../../../shared/types'
import { ProviderIcon } from '../ProviderIcon'
import { ModelPicker } from '../ModelPicker'
import { useModelsConfig } from './providers/use-models-config'
import { ProviderDetail } from './providers/ProviderDetail'
import { AddProviderMenu } from './providers/AddProviderMenu'
import { CustomProviderView } from './providers/CustomProviderView'
import { ProviderCard, ProviderNotice, ProviderPanel, PROVIDER_INPUT_CLASS_NAMES } from './providers/ProviderUi'

const DEFAULT_MODEL_SLOTS = [
  { id: 'main', label: 'settings.mainDefaultModel', reserved: false },
  { id: 'vision', label: 'settings.visionDefaultModel', reserved: true },
  { id: 'advisor', label: 'settings.advisorDefaultModel', reserved: true }
] as const

/** Connection overview → provider editor / custom connection creation. */
export function ProvidersSection() {
  const { t } = useI18n()
  const [providers, setProviders] = useState<ProviderDTO[]>([])
  const [models, setModels] = useState<ModelDTO[]>([])
  const [defaultModel, setDefaultModel] = useState<DefaultModelDTO | null>(null)
  const [loading, setLoading] = useState(true)
  const [readError, setReadError] = useState<string | null>(null)
  const [selection, setSelection] = useState<string | null>(null)
  const [addingCustom, setAddingCustom] = useState(false)
  const [query, setQuery] = useState('')
  const cfg = useModelsConfig()
  const reduce = useReducedMotion()
  const sectionRef = useRef<HTMLDivElement>(null)
  const refreshEpoch = useRef(0)

  useLayoutEffect(() => {
    sectionRef.current?.closest('[data-settings-scrollport]')?.scrollTo({ top: 0 })
  }, [selection, addingCustom])

  const refresh = useCallback(async () => {
    const epoch = ++refreshEpoch.current
    setLoading(true)
    try {
      const [providerRows, modelRows, defaults] = await Promise.allSettled([
        window.pi.providers(), window.pi.models(), window.pi.defaultModel()
      ])
      if (epoch !== refreshEpoch.current) return
      if (providerRows.status === 'fulfilled') setProviders(providerRows.value)
      if (modelRows.status === 'fulfilled') setModels(modelRows.value)
      if (defaults.status === 'fulfilled') setDefaultModel(defaults.value)
      const failure = [providerRows, modelRows, defaults].find(result => result.status === 'rejected')
      setReadError(failure?.status === 'rejected'
        ? failure.reason instanceof Error ? failure.reason.message : String(failure.reason) : null)
    } catch (error) {
      if (epoch === refreshEpoch.current) setReadError(error instanceof Error ? error.message : String(error))
    } finally {
      if (epoch === refreshEpoch.current) setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => { if (cfg.savedAt > 0) void refresh() }, [cfg.savedAt, refresh])

  const applyDefaultModel = async (model: ModelDTO) => {
    try {
      await window.pi.setDefaultModel(model.providerId, model.id)
      setDefaultModel({ providerId: model.providerId, modelId: model.id })
    } catch (error) {
      setReadError(error instanceof Error ? error.message : String(error))
    }
  }

  const sorted = useMemo(() => [...providers].sort(
    (a, b) => Number(b.authenticated) - Number(a.authenticated) || a.name.localeCompare(b.name)
  ), [providers])
  const configured = sorted.filter(p => p.authenticated || p.custom)
  const unconfigured = sorted.filter(p => !p.authenticated && !p.custom)
  const keyword = query.trim().toLocaleLowerCase()
  const shown = configured.filter(p => !keyword || (p.name + ' ' + p.id).toLocaleLowerCase().includes(keyword))

  const defaultValue = defaultModel ? defaultModel.providerId + '/' + defaultModel.modelId : null
  const selected = selection ? providers.find(p => p.id === selection) : null
  const goBack = () => { setSelection(null); setAddingCustom(false); void refresh() }

  return (
    <div ref={sectionRef} data-provider-settings className="space-y-5 text-xs">
      {(cfg.saveError && !addingCustom) || cfg.loadError || readError ? (
        <ProviderNotice tone="error">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>{t(cfg.loadError || readError ? 'settings.providerLoadFailed' : 'settings.saveFailed')}: {cfg.saveError || cfg.loadError || readError}</span>
            <Button variant="ghost" size="sm" onClick={() => {
              if (cfg.loadError) void cfg.reload()
              if (cfg.saveError) void cfg.flush()
              if (readError) void refresh()
            }}>{t('settings.providerRetry')}</Button>
          </div>
        </ProviderNotice>
      ) : null}

      <AnimatePresence initial={false} mode="wait">
        <motion.div
          key={selected ? 'detail-' + selected.id : addingCustom ? 'create' : 'overview'}
          initial={{ opacity: 0, x: reduce ? 0 : 10 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: reduce ? 0 : -10 }}
          transition={reduce ? { duration: 0 } : { duration: 0.16, ease: EASE_OUT }}
        >
          {selected ? (
            <ProviderDetail
              provider={selected} config={cfg.config} mutate={cfg.mutate} flush={cfg.flush}
              savedAt={cfg.savedAt} saving={cfg.saving} onBack={goBack} onRefresh={refresh}
            />
          ) : addingCustom ? (
            <CustomProviderView
              config={cfg.config} mutate={cfg.mutate} flush={cfg.flush}
              saveError={cfg.saveError}
              providerIds={providers.map(p => p.id)}
              onBack={goBack}
              onCreated={async id => { await refresh(); setAddingCustom(false); setSelection(id) }}
            />
          ) : (
            <div className="space-y-7">
              <header className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0">
                  <h2 className="text-base font-semibold text-foreground">{t('settings.providers')}</h2>
                  <p className="mt-1.5 text-xs leading-ui text-muted-foreground">{t('settings.providersDesc')}</p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Tooltip content={t('settings.refreshProviders')}>
                    <Button variant="ghost" size="icon" disabled={loading} aria-label={t('settings.refreshProviders')} onClick={() => void refresh()}>
                      {loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
                    </Button>
                  </Tooltip>
                  <AddProviderMenu providers={unconfigured} onSelect={setSelection} onCustom={() => setAddingCustom(true)} />
                </div>
              </header>

              <ProviderPanel title={t('settings.providerConnections')} description={t('settings.providerConnectionsHint')}>
                {configured.length > 0 ? (
                  <Input value={query} onChange={setQuery} leftIcon={<Search />}
                    classNames={PROVIDER_INPUT_CLASS_NAMES}
                    placeholder={t('settings.searchProviders')} aria-label={t('settings.searchProviders')} />
                ) : null}
                <ProviderCard>
                  <div className="divide-y divide-border/60 p-1">
                    {shown.map(provider => (
                      <Button
                        key={provider.id}
                        data-provider-connection={provider.id}
                        variant="ghost"
                        className="h-auto w-full min-w-0 justify-start gap-3 px-3 py-2.5 text-left text-xs"
                        aria-label={t('settings.viewProvider', { name: provider.name })}
                        onClick={() => setSelection(provider.id)}
                      >
                        <ProviderIcon providerId={provider.id} name={provider.name} size={18} />
                        <span className="min-w-0 flex-1 truncate text-xs text-foreground">{provider.name}</span>
                        {provider.custom && !provider.builtin ? (
                          <span className="shrink-0 rounded-capsule bg-muted px-1.5 py-0.5 text-micro text-muted-foreground">{t('settings.providerCustomBadge')}</span>
                        ) : null}
                        <span className="shrink-0 text-xs font-normal tabular-nums text-muted-foreground">{t('settings.providerModelCount', { count: provider.modelCount })}</span>
                        <span className={'flex shrink-0 items-center gap-1.5 text-xs font-normal ' + (provider.authenticated ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground')}>
                          {provider.authenticated ? <CheckCircle2 className="size-3.5" /> : <KeyRound className="size-3.5" />}
                          {t(provider.authenticated ? 'auth.connected' : 'settings.providerNeedsSetup')}
                        </span>
                        <ArrowRight className="size-4 shrink-0 text-muted-foreground" />
                      </Button>
                    ))}
                    {loading && configured.length === 0 ? (
                      <div className="flex items-center justify-center gap-2 py-12 text-xs text-muted-foreground">
                        <Loader2 className="size-4 animate-spin" />{t('settings.loadingModels')}
                      </div>
                    ) : shown.length === 0 ? (
                      <div className="px-5 py-10 text-center">
                        <KeyRound className="mx-auto mb-3 size-6 text-muted-foreground" />
                        <p className="text-xs text-foreground">{t(configured.length === 0 ? 'settings.noProviders' : 'settings.addProviderEmpty')}</p>
                        {configured.length === 0 ? <p className="mt-1.5 text-caption text-muted-foreground">{t('settings.providerEmptyHint')}</p> : null}
                      </div>
                    ) : null}
                  </div>
                </ProviderCard>
              </ProviderPanel>

              <ProviderPanel title={t('settings.defaultModel')} description={t('settings.defaultModelsHint')}>
                <ProviderCard className="divide-y divide-border/60">
                  {DEFAULT_MODEL_SLOTS.map(slot => (
                    <div key={slot.id} data-default-model-slot={slot.id} className="flex items-center gap-4 px-4 py-3">
                      <p className="min-w-0 flex-1 text-xs font-medium text-foreground">{t(slot.label)}</p>
                      <ModelPicker
                        models={slot.reserved ? [] : models}
                        value={slot.reserved ? null : defaultValue}
                        onChange={applyDefaultModel}
                        ariaLabel={t(slot.label)}
                        inheritLabel={t(slot.reserved ? 'settings.defaultModelReserved' : 'settings.defaultModelAuto')}
                        unknownModelLabel={defaultValue ?? undefined}
                        panelId={'default-model-picker-' + slot.id}
                        textClassName="text-xs"
                        optionTextClassName="text-xs"
                        className="w-56 max-w-[55%] shrink-0"
                        triggerClassName="h-10 w-full justify-start border border-border/70 bg-background"
                        disabled={slot.reserved}
                        portal
                      />
                    </div>
                  ))}
                </ProviderCard>
              </ProviderPanel>
            </div>
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  )
}
