import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ArrowLeft,
  ChevronRight,
  Download,
  Eye,
  EyeOff,
  Globe,
  KeyRound,
  Loader2,
  LogOut,
  Plus,
  RotateCcw,
  Trash2
} from '@/lib/icons'
import { Button } from '@/components/motion/button'
import { Input } from '@/components/motion/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger
} from '@/components/motion/select'
import { Tooltip } from '@/components/motion/tooltip'
import { useI18n } from '@/i18n'
import type {
  CustomProviderDTO,
  ModelsConfigDTO,
  ProviderDTO,
  ProviderModelDTO
} from '../../../../../../shared/types'
import { ProviderIcon } from '../../ProviderIcon'
import { ProviderStatus } from '../../AuthBridge'
import { ConfirmDialog } from '../../ConfirmDialog'
import { SettingsGroup, SettingsRow } from '../SettingsRow'
import type { ModelsConfigMutate } from './use-models-config'
import { ModelEditorDialog, type EditingTarget } from './ModelEditorDialog'
import { DiscoverDialog } from './DiscoverDialog'
import { API_OPTIONS } from './AddProviderDialog'

interface ProviderDetailProps {
  provider: ProviderDTO
  config: ModelsConfigDTO | null
  mutate: ModelsConfigMutate
  flush: () => Promise<void>
  savedAt: number
  onBack: () => void
  /** Refresh provider rows (auth state, custom flags) after edits. */
  onRefresh: () => Promise<void>
}

interface ModelRow {
  id: string
  name: string
  contextWindow: number
  source: 'builtin' | 'custom' | 'both' | 'draft'
  hasOverride: boolean
  available: boolean
  /** App-level visibility flag (models.json modelOverrides.<id>.hidden). */
  hidden: boolean
  /** Index into entry.models when the row maps to a carrier. */
  carrierIndex: number | null
  /** Composed base when the row is editable as an override. */
  base: ProviderModelDTO | null
}

/**
 * One provider's settings page: sign-in state (builtin providers) or the
 * models.json fields (custom providers), plus the composed model inventory —
 * registry definitions, models.json carriers and overrides, merged the way
 * the runtime composes them.
 */
export function ProviderDetail({
  provider,
  config,
  mutate,
  flush,
  savedAt,
  onBack,
  onRefresh
}: ProviderDetailProps) {
  const { t } = useI18n()
  const entry = config?.providers[provider.id]
  const isCustom = !provider.builtin || entry !== undefined
  // OAuth-only providers (e.g. openai-codex) have no API-key auth to offer, so
  // the field would only invite a key that fabricates an auth method the
  // endpoint cannot use. Keep it for providers that do accept keys, for
  // models.json-only entries (where it is the credential), and for entries that
  // already carry one so it stays editable/removable.
  const showApiKey =
    !provider.builtin || provider.authTypes.includes('api_key') || entry?.apiKey !== undefined
  // The wire API the provider actually uses comes from the registry (the first
  // composed model's `api`); API_OPTIONS only curates generic choices. Show the
  // effective value and keep it selectable even when it is not one of them.
  const effectiveApi = entry?.api ?? provider.api ?? API_OPTIONS[0]
  const apiOptions: string[] = [...API_OPTIONS]
  if (!apiOptions.includes(effectiveApi)) apiOptions.unshift(effectiveApi)

  const [inventory, setInventory] = useState<ProviderModelDTO[] | null>(null)
  const [editing, setEditing] = useState<EditingTarget | null>(null)
  const [discoverOpen, setDiscoverOpen] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [busyAuth, setBusyAuth] = useState(false)
  const [showKey, setShowKey] = useState(false)

  const loadInventory = useCallback(async () => {
    try {
      setInventory(await window.pi.providerModels(provider.id))
    } catch {
      setInventory([])
    }
  }, [provider.id])

  useEffect(() => {
    setInventory(null)
    void loadInventory()
  }, [loadInventory])

  // Composition changed under us (a save just landed) — refetch the rows.
  useEffect(() => {
    if (savedAt > 0) void loadInventory()
  }, [savedAt, loadInventory])

  const rows = useMemo<ModelRow[]>(() => {
    const composed: ModelRow[] = (inventory ?? []).map((model) => {
      const carrierIndex = (entry?.models ?? []).findIndex(
        (candidate) => typeof candidate?.id === 'string' && candidate.id.trim() === model.id
      )
      const editableAsCarrier = model.source !== 'builtin' && carrierIndex >= 0
      return {
        id: model.id,
        name: model.name,
        contextWindow: model.contextWindow,
        source: model.source,
        hasOverride: model.hasOverride,
        available: model.available,
        hidden: model.hidden,
        carrierIndex: editableAsCarrier ? carrierIndex : null,
        base: editableAsCarrier ? null : model
      }
    })
    const composedIds = new Set(composed.map((row) => row.id))
    // Carriers the runtime did not compose: blank-id drafts and entries of a
    // provider that is not valid enough to register yet.
    const drafts: ModelRow[] = (entry?.models ?? [])
      .map((model, index) => ({ model, index }))
      .filter(({ model }) => {
        const id = typeof model?.id === 'string' ? model.id.trim() : ''
        return !id || !composedIds.has(id)
      })
      .map(({ model, index }) => ({
        id: typeof model?.id === 'string' ? model.id : '',
        name: typeof model?.name === 'string' ? model.name : '',
        contextWindow: typeof model?.contextWindow === 'number' ? model.contextWindow : 0,
        source: 'draft' as const,
        hasOverride: false,
        available: false,
        hidden: false,
        carrierIndex: index,
        base: null
      }))
    return [...composed, ...drafts]
  }, [inventory, entry])

  const setEntryField = (patch: Partial<CustomProviderDTO>) => {
    mutate((draft) => {
      const current = draft.providers[provider.id] ?? {}
      const next = { ...current, ...patch }
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined || value === '') delete (next as any)[key]
      }
      return { ...draft, providers: { ...draft.providers, [provider.id]: next } }
    })
  }

  const removeCarrier = (index: number) => {
    const removedId = entry?.models?.[index]?.id?.trim()
    mutate(
      (draft) => {
        const current = draft.providers[provider.id] ?? {}
        const models = [...(current.models ?? [])]
        models.splice(index, 1)
        const overrides = { ...(current.modelOverrides ?? {}) }
        if (removedId) delete overrides[removedId]
        return {
          ...draft,
          providers: { ...draft.providers, [provider.id]: { ...current, models, modelOverrides: overrides } }
        }
      },
      true
    )
  }

  const clearOverride = (modelId: string) => {
    mutate(
      (draft) => {
        const current = draft.providers[provider.id] ?? {}
        const overrides = { ...(current.modelOverrides ?? {}) }
        // Reset restores parameters; the visibility choice survives it.
        const keepHidden = overrides[modelId]?.hidden === true
        delete overrides[modelId]
        if (keepHidden) overrides[modelId] = { hidden: true }
        return {
          ...draft,
          providers: { ...draft.providers, [provider.id]: { ...current, modelOverrides: overrides } }
        }
      },
      true
    )
  }

  /**
   * Hiding is a visibility flag, not a parameter edit: it lives in
   * `modelOverrides` beside any parameter patch and never touches it.
   * Unhiding a model with no other override keys drops the emptied entry.
   */
  const setModelHidden = (modelId: string, hidden: boolean) => {
    mutate(
      (draft) => {
        const current = draft.providers[provider.id] ?? {}
        const overrides = { ...(current.modelOverrides ?? {}) }
        const existing = { ...(overrides[modelId] ?? {}) }
        if (hidden) existing.hidden = true
        else delete existing.hidden
        if (Object.keys(existing).length > 0) overrides[modelId] = existing
        else delete overrides[modelId]
        return {
          ...draft,
          providers: { ...draft.providers, [provider.id]: { ...current, modelOverrides: overrides } }
        }
      },
      true
    )
  }

  const deleteProvider = () => {
    mutate(
      (draft) => {
        const providers = { ...draft.providers }
        delete providers[provider.id]
        return { ...draft, providers }
      },
      true
    )
    setConfirmDelete(false)
    onBack()
  }

  const login = async (kind: 'api_key' | 'oauth') => {
    setBusyAuth(true)
    try {
      await window.pi.login(provider.id, kind)
      await onRefresh()
    } catch (error) {
      console.error('login failed', error)
    } finally {
      setBusyAuth(false)
    }
  }

  const logout = async () => {
    setBusyAuth(true)
    try {
      await window.pi.logout(provider.id)
      await onRefresh()
    } catch (error) {
      console.error('logout failed', error)
    } finally {
      setBusyAuth(false)
    }
  }

  const modelCount = entry?.models?.length ?? 0

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon" aria-label={t('settings.backToList')} onClick={onBack}>
          <ArrowLeft className="size-4" />
        </Button>
        <ProviderIcon providerId={provider.id} name={provider.name} size={28} />
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-foreground">{provider.name}</p>
          <p className="truncate font-mono text-[11px] text-muted-foreground">{provider.id}</p>
        </div>
        <div className="ml-auto flex items-center gap-2 text-xs">
          <ProviderStatus authenticated={provider.authenticated} />
          {provider.authSource ? (
            <span className="hidden truncate text-muted-foreground/70 sm:inline">{provider.authSource}</span>
          ) : null}
        </div>
      </div>

      {provider.builtin ? (
        <SettingsGroup title={t('settings.access')}>
          <SettingsRow
            label={t('settings.signIn')}
            description={t('settings.credentialsDesc')}
          >
            {provider.authTypes.includes('api_key') && provider.canLogin ? (
              <Button variant="outline" size="sm" disabled={busyAuth} onClick={() => void login('api_key')}>
                <KeyRound className="size-3.5" />
                {t('settings.apiKey')}
              </Button>
            ) : null}
            {provider.authTypes.includes('oauth') && provider.canLogin ? (
              <Button variant="outline" size="sm" disabled={busyAuth} onClick={() => void login('oauth')}>
                <Globe className="size-3.5" />
                {t(provider.id === 'openai' ? 'settings.signInWithChatGPT' : 'settings.oauth')}
              </Button>
            ) : null}
            {provider.authenticated ? (
              <Button variant="ghost" size="icon" aria-label={t('settings.signOut', { name: provider.name })} disabled={busyAuth} onClick={() => void logout()}>
                {busyAuth ? <Loader2 className="size-3.5 animate-spin" /> : <LogOut className="size-3.5" />}
              </Button>
            ) : null}
          </SettingsRow>
        </SettingsGroup>
      ) : null}

      {isCustom ? (
        <SettingsGroup title={t('settings.customProvider')} description={t('settings.modelsFileNote')}>
          <div className="space-y-3 px-4 py-4">
            <Input
              label={t('settings.displayName')}
              value={entry?.name ? String(entry.name) : ''}
              onChange={(v) => setEntryField(v.trim() ? { name: v } : { name: undefined })}
              placeholder={provider.builtin ? provider.name : provider.id}
            />
            <div>
              <label className="mb-1.5 block px-1 text-sm font-medium text-foreground">{t('settings.api')}</label>
              <Select
                value={effectiveApi}
                onValueChange={(api) => setEntryField({ api })}
              >
                <SelectTrigger className="w-full" aria-label={t('settings.api')}>
                  <span className="font-mono text-sm">{effectiveApi}</span>
                </SelectTrigger>
                <SelectContent className="left-0 right-auto w-80">
                  {apiOptions.map((option) => (
                    <SelectItem key={option} value={option} className="py-1.5">
                      <span className="font-mono text-sm">{option}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Input
              label={t('settings.baseUrl')}
              value={entry?.baseUrl ? String(entry.baseUrl) : (provider.baseUrl ?? '')}
              onChange={(v) => {
                const trimmed = v.trim()
                // The provider's own default is "inherit": only a real
                // deviation needs a models.json entry.
                setEntryField(
                  trimmed && trimmed !== provider.baseUrl ? { baseUrl: v } : { baseUrl: undefined }
                )
              }}
              placeholder="http://localhost:11434/v1"
              classNames={{ input: 'font-mono text-sm' }}
            />
            {showApiKey ? (
              <Input
                label={t('settings.apiKeyOptional')}
                value={entry?.apiKey ? String(entry.apiKey) : ''}
                onChange={(v) => setEntryField(v.trim() ? { apiKey: v } : { apiKey: undefined })}
                type={showKey ? 'text' : 'password'}
                placeholder="sk-…"
                rightIcon={
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={showKey ? t('settings.hideKey') : t('settings.showKey')}
                    onClick={() => setShowKey((prev) => !prev)}
                  >
                    {showKey ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                  </Button>
                }
              />
            ) : null}
          </div>
          <SettingsRow
            label={t('settings.deleteProvider')}
            description={t('settings.deleteProviderDesc', {
              count: modelCount,
              modelsWord: modelCount === 1 ? t('settings.modelOne') : t('settings.modelMany')
            })}
          >
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive hover:bg-destructive/10"
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2 className="size-3.5" />
              {t('common.delete')}
            </Button>
          </SettingsRow>
        </SettingsGroup>
      ) : null}

      <section>
        <div className="flex items-center justify-between gap-2 px-1 pb-2">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t('settings.providerModels')}
          </p>
          <div className="flex items-center gap-1.5">
            {provider.discoverable ? (
              <Button variant="outline" size="sm" onClick={() => setDiscoverOpen(true)}>
                <Download className="size-3.5" />
                {t('settings.fetchModels')}
              </Button>
            ) : null}
            <Button variant="outline" size="sm" onClick={() => setEditing({ kind: 'new' })}>
              <Plus className="size-3.5" />
              {t('settings.addModel')}
            </Button>
          </div>
        </div>

        <div className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border/70 bg-card">
          {inventory === null ? (
            <div className="flex items-center justify-center gap-2 py-8 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              {t('settings.loadingModels')}
            </div>
          ) : rows.length === 0 ? (
            <p className="py-8 text-center text-xs text-muted-foreground">{t('settings.noModels')}</p>
          ) : (
            rows.map((row, index) => (
              <div
                key={`${row.source}-${row.carrierIndex ?? 'x'}-${row.id || 'draft'}-${index}`}
                className="group flex cursor-pointer items-center justify-between gap-3 px-3 py-2.5 transition-colors hover:bg-muted/50"
                role="button"
                tabIndex={0}
                onClick={() => {
                  if (row.carrierIndex !== null) setEditing({ kind: 'carrier', index: row.carrierIndex })
                  else if (row.base) setEditing({ kind: 'override', row: row.base })
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    if (row.carrierIndex !== null) setEditing({ kind: 'carrier', index: row.carrierIndex })
                    else if (row.base) setEditing({ kind: 'override', row: row.base })
                  }
                }}
              >
                <div className="flex min-w-0 items-center gap-2.5">
                  <Tooltip
                    content={row.available ? t('settings.modelAvailable') : t('settings.modelUnavailable')}
                    wrapperClassName="shrink-0"
                  >
                    <span
                      className={`size-1.5 shrink-0 rounded-full ${
                        row.available ? 'bg-emerald-500' : 'bg-muted-foreground/40'
                      }`}
                    />
                  </Tooltip>
                  <div className="min-w-0">
                    <p
                      className={`flex items-center gap-1.5 truncate text-sm font-medium ${
                        row.hidden ? 'text-muted-foreground' : 'text-foreground'
                      }`}
                    >
                      <span className="truncate">{row.name || row.id || t('settings.modelDraft')}</span>
                      {row.source === 'draft' ? (
                        <span className="shrink-0 rounded-control bg-amber-500/15 px-1.5 py-px text-[10px] font-medium text-amber-600 dark:text-amber-400">
                          {t('settings.modelDraft')}
                        </span>
                      ) : null}
                      {row.source === 'custom' || row.source === 'both' ? (
                        <span className="shrink-0 rounded-control bg-muted px-1.5 py-px text-[10px] font-medium text-muted-foreground">
                          {t('settings.modelCustom')}
                        </span>
                      ) : null}
                      {row.hasOverride ? (
                        <span className="shrink-0 rounded-control bg-primary/10 px-1.5 py-px text-[10px] font-medium text-primary">
                          {t('settings.modelEdited')}
                        </span>
                      ) : null}
                      {row.hidden ? (
                        <span className="shrink-0 rounded-control bg-muted px-1.5 py-px text-[10px] font-medium text-muted-foreground">
                          {t('settings.modelHidden')}
                        </span>
                      ) : null}
                    </p>
                    <p className="truncate font-mono text-[11px] text-muted-foreground">
                      {row.id || '—'}
                      {row.contextWindow
                        ? ` · ${t('model.contextK', { k: Math.round(row.contextWindow / 1000) })}`
                        : ''}
                    </p>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-0.5">
                  {row.hasOverride ? (
                    <Tooltip content={t('settings.resetOverride')}>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={t('settings.resetOverride')}
                        onClick={(event) => {
                          event.stopPropagation()
                          clearOverride(row.id)
                        }}
                      >
                        <RotateCcw className="size-3.5" />
                      </Button>
                    </Tooltip>
                  ) : null}
                  {row.source !== 'draft' ? (
                    <Tooltip content={row.hidden ? t('settings.unhideModel') : t('settings.hideModel')}>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={row.hidden ? t('settings.unhideModel') : t('settings.hideModel')}
                        onClick={(event) => {
                          event.stopPropagation()
                          setModelHidden(row.id, !row.hidden)
                        }}
                      >
                        {row.hidden ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                      </Button>
                    </Tooltip>
                  ) : null}
                  {row.carrierIndex !== null ? (
                    <Tooltip content={t('settings.deleteModel')}>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={t('settings.deleteModel')}
                        onClick={(event) => {
                          event.stopPropagation()
                          removeCarrier(row.carrierIndex!)
                        }}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </Tooltip>
                  ) : null}
                  <ChevronRight className="size-4 text-muted-foreground/60" />
                </div>
              </div>
            ))
          )}
        </div>
        <p className="px-1 pt-2 text-xs text-muted-foreground/70">
          {t('settings.providerModelsHint')}
        </p>
      </section>

      <ModelEditorDialog
        target={editing}
        providerId={provider.id}
        entry={entry}
        mutate={mutate}
        flush={flush}
        onClose={() => setEditing(null)}
      />

      <DiscoverDialog
        open={discoverOpen}
        providerId={provider.id}
        providerName={provider.name}
        entry={entry}
        flush={flush}
        mutate={mutate}
        onClose={() => setDiscoverOpen(false)}
      />

      <ConfirmDialog
        open={confirmDelete}
        title={t('settings.confirmDeleteProviderTitle')}
        message={t('settings.confirmDeleteProviderMessage', {
          name: provider.name,
          count: modelCount,
          modelsWord: modelCount === 1 ? t('settings.modelOne') : t('settings.modelMany')
        })}
        onConfirm={deleteProvider}
        onClose={() => setConfirmDelete(false)}
      />
    </div>
  )
}
