import { useCallback, useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { AlertCircle, ChevronRight, Globe, KeyRound, Loader2, LogOut, Plus, RefreshCw } from 'lucide-react'
import { Button } from '@/components/motion/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger
} from '@/components/motion/select'
import { EASE_OUT } from '@/lib/ease'
import { useI18n } from '@/i18n'
import type {
  DefaultModelDTO,
  ModelDTO,
  ProviderDTO
} from '../../../../../shared/types'
import { ProviderIcon } from '../ProviderIcon'
import { ProviderStatus } from '../AuthBridge'
import { SettingsGroup, SettingsRow } from './SettingsRow'
import { useModelsConfig } from './providers/use-models-config'
import { ProviderDetail } from './providers/ProviderDetail'
import { AddProviderDialog } from './providers/AddProviderDialog'

/**
 * Providers & models: sign-in state per provider, the default model for new
 * sessions, and full viewing/editing of ~/.pi/agent/models.json (custom
 * providers, extra model carriers, per-model overrides) through the
 * provider detail pages.
 */
export function ProvidersSection() {
  const { t } = useI18n()
  const [providers, setProviders] = useState<ProviderDTO[]>([])
  const [models, setModels] = useState<ModelDTO[]>([])
  const [defaultModel, setDefaultModel] = useState<DefaultModelDTO | null>(null)
  const [loading, setLoading] = useState(false)
  const [busyProvider, setBusyProvider] = useState<string | null>(null)
  const [selection, setSelection] = useState<string | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const cfg = useModelsConfig()
  const reduce = useReducedMotion()

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const [providerRows, modelRows, defaults] = await Promise.all([
        window.pi.providers(),
        window.pi.models().catch(() => [] as ModelDTO[]),
        window.pi.defaultModel().catch(() => null)
      ])
      setProviders(providerRows)
      setModels(modelRows)
      setDefaultModel(defaults)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const login = async (provider: ProviderDTO, kind: 'api_key' | 'oauth') => {
    setBusyProvider(`${provider.id}:${kind}`)
    try {
      await window.pi.login(provider.id, kind)
      await refresh()
    } catch (error) {
      console.error('login failed', error)
    } finally {
      setBusyProvider(null)
    }
  }

  const logout = async (provider: ProviderDTO) => {
    setBusyProvider(`${provider.id}:logout`)
    try {
      await window.pi.logout(provider.id)
      await refresh()
    } catch (error) {
      console.error('logout failed', error)
    } finally {
      setBusyProvider(null)
    }
  }

  const applyDefaultModel = async (value: string) => {
    const [providerId, ...rest] = value.split('/')
    const modelId = rest.join('/')
    if (!providerId || !modelId) return
    setDefaultModel({ providerId, modelId })
    try {
      await window.pi.setDefaultModel(providerId, modelId)
    } catch (error) {
      console.error('failed to set default model', error)
      setDefaultModel(await window.pi.defaultModel().catch(() => null))
    }
  }

  // Configured providers float to the top; the rest stay alphabetical.
  const sorted = useMemo(
    () =>
      [...providers].sort(
        (a, b) => Number(b.authenticated) - Number(a.authenticated) || a.name.localeCompare(b.name)
      ),
    [providers]
  )
  const builtinProviders = sorted.filter((p) => p.builtin)
  const customProviders = sorted.filter((p) => !p.builtin)

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

  const defaultValue = defaultModel ? `${defaultModel.providerId}/${defaultModel.modelId}` : undefined
  const currentDefault = defaultModel
    ? models.find((m) => m.providerId === defaultModel.providerId && m.id === defaultModel.modelId)
    : null

  const selected = selection ? (providers.find((p) => p.id === selection) ?? null) : null

  const renderProviderRow = (provider: ProviderDTO) => (
    <div
      key={provider.id}
      className="group flex cursor-pointer items-center justify-between gap-3 px-4 py-2.5 transition-colors first:rounded-t-xl last:rounded-b-xl hover:bg-muted/50"
      role="button"
      tabIndex={0}
      onClick={() => setSelection(provider.id)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          setSelection(provider.id)
        }
      }}
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <ProviderIcon providerId={provider.id} name={provider.name} size={20} />
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 truncate text-sm font-medium text-foreground">
            <span className="truncate">{provider.name}</span>
            {provider.custom ? (
              <span className="shrink-0 rounded-full bg-muted px-1.5 py-px text-[10px] font-medium text-muted-foreground">
                {t('settings.providerCustomBadge')}
              </span>
            ) : null}
          </p>
          <div className="mt-0.5 flex items-center gap-2 text-xs">
            <ProviderStatus authenticated={provider.authenticated} />
            {provider.authSource ? (
              <span className="truncate text-muted-foreground/70">{provider.authSource}</span>
            ) : null}
          </div>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        {provider.authTypes.includes('api_key') && provider.canLogin ? (
          <Button
            variant="outline"
            size="sm"
            disabled={busyProvider !== null}
            onClick={(event) => {
              event.stopPropagation()
              void login(provider, 'api_key')
            }}
          >
            {busyProvider === `${provider.id}:api_key` ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <KeyRound className="size-3.5" />
            )}
            {t('settings.apiKey')}
          </Button>
        ) : null}
        {provider.authTypes.includes('oauth') && provider.canLogin ? (
          <Button
            variant="outline"
            size="sm"
            disabled={busyProvider !== null}
            onClick={(event) => {
              event.stopPropagation()
              void login(provider, 'oauth')
            }}
          >
            {busyProvider === `${provider.id}:oauth` ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Globe className="size-3.5" />
            )}
            {t('settings.oauth')}
          </Button>
        ) : null}
        {provider.authenticated ? (
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('settings.signOut', { name: provider.name })}
            disabled={busyProvider !== null}
            onClick={(event) => {
              event.stopPropagation()
              void logout(provider)
            }}
          >
            {busyProvider === `${provider.id}:logout` ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <LogOut className="size-3.5" />
            )}
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="icon"
          aria-label={t('settings.viewProvider', { name: provider.name })}
          title={t('settings.viewProvider', { name: provider.name })}
          onClick={(event) => {
            event.stopPropagation()
            setSelection(provider.id)
          }}
        >
          <ChevronRight className="size-4" />
        </Button>
      </div>
    </div>
  )

  return (
    <div className="space-y-6">
      {/* The page shell renders the section title/description; this toolbar
          carries the section's only global action. */}
      <div className="flex items-center justify-between gap-3">
        {cfg.saveError ? (
          <p className="flex min-w-0 items-center gap-1.5 text-xs text-destructive">
            <AlertCircle className="size-3.5 shrink-0" />
            <span className="truncate">{t('settings.saveFailed')}: {cfg.saveError}</span>
          </p>
        ) : (
          <span />
        )}
        <Button
          variant="ghost"
          size="icon"
          aria-label={t('settings.refreshProviders')}
          onClick={() => void refresh()}
        >
          {loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
        </Button>
      </div>

      <AnimatePresence initial={false} mode="wait">
        {selected ? (
          <motion.div
            key={`detail-${selected.id}`}
            initial={{ opacity: 0, x: reduce ? 0 : 16 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: reduce ? 0 : 16 }}
            transition={reduce ? { duration: 0 } : { duration: 0.18, ease: EASE_OUT }}
          >
            <ProviderDetail
              provider={selected}
              config={cfg.config}
              mutate={cfg.mutate}
              flush={cfg.flush}
              savedAt={cfg.savedAt}
              onBack={() => {
                setSelection(null)
                void refresh()
              }}
              onRefresh={refresh}
            />
          </motion.div>
        ) : (
          <motion.div
            key="overview"
            initial={{ opacity: 0, x: reduce ? 0 : -16 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: reduce ? 0 : -16 }}
            transition={reduce ? { duration: 0 } : { duration: 0.18, ease: EASE_OUT }}
            className="space-y-6"
          >
            <SettingsGroup title={t('settings.defaultModel')}>
              <SettingsRow label={t('settings.defaultModel')} description={t('settings.defaultModelDesc')}>
                <Select
                  value={defaultValue}
                  onValueChange={(next) => void applyDefaultModel(next)}
                  className="w-auto"
                >
                  <SelectTrigger aria-label={t('settings.defaultModel')} className="h-8 w-auto max-w-56 rounded-full px-3 text-xs">
                    <span className="truncate">
                      {currentDefault
                        ? `${currentDefault.providerName} / ${currentDefault.name}`
                        : defaultValue ?? t('settings.defaultModelAuto')}
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
                          {t('settings.noAvailableModels')}
                        </p>
                      ) : null}
                    </div>
                  </SelectContent>
                </Select>
              </SettingsRow>
            </SettingsGroup>

            <SettingsGroup title={t('settings.builtinProviders')}>
              {builtinProviders.map(renderProviderRow)}
              {!loading && builtinProviders.length === 0 ? (
                <p className="py-8 text-center text-xs text-muted-foreground">{t('settings.noProviders')}</p>
              ) : null}
            </SettingsGroup>

            <SettingsGroup title={t('settings.customProviders')} description={t('settings.customProvidersDesc')}>
              {customProviders.map(renderProviderRow)}
              <button
                type="button"
                className="flex w-full items-center justify-center gap-1.5 rounded-b-xl px-4 py-2.5 text-sm text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
                onClick={() => setAddOpen(true)}
              >
                <Plus className="size-3.5" />
                {t('settings.addProvider')}
              </button>
            </SettingsGroup>
          </motion.div>
        )}
      </AnimatePresence>

      <AddProviderDialog
        open={addOpen}
        config={cfg.config}
        mutate={cfg.mutate}
        onClose={() => setAddOpen(false)}
        onCreated={(providerId) => {
          void refresh().then(() => setSelection(providerId))
        }}
      />
    </div>
  )
}
