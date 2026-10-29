import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  Download,
  Eye,
  EyeOff,
  PlugZap,
  Pencil,
  Search,
  Globe,
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
import { RadioGroup, RadioGroupItem } from '@/components/motion/radio'
import { Checkbox } from '@/components/motion/checkbox'
import { Tabs, TabsList, TabsTrigger } from '@/components/motion/tabs'
import { Tooltip } from '@/components/motion/tooltip'
import { useI18n } from '@/i18n'
import type {
  AuthNotifyDTO,
  AuthPromptDTO,
  CustomModelDTO,
  CustomProviderDTO,
  ModelsConfigDTO,
  ProviderDTO,
  ProviderModelDTO,
  TestModelResultDTO
} from '../../../../../../shared/types'
import { ProviderIcon } from '../../ProviderIcon'
import { AuthBridgeContent } from '../../AuthBridge'
import { claimInlineAuth, releaseInlineAuth } from '@/lib/inline-auth'
import { FadeScroll } from '../../FadeScroll'
import { ModelInputBadges } from '../../ModelInputBadges'
import {
  ProviderCard, ProviderDialog, ProviderNotice, ProviderPanel,
  PROVIDER_CHOICE_TEXT, PROVIDER_FIELD_HEADING, PROVIDER_INPUT_CLASS_NAMES
} from './ProviderUi'
import { SettingsRow } from '../SettingsRow'
import type { ModelsConfigMutate } from './use-models-config'
import { ModelEditorDialog, type EditingTarget } from './ModelEditorDialog'
import { DiscoverDialog } from './DiscoverDialog'
import { API_OPTIONS } from './api-options'

interface ProviderDetailProps {
  provider: ProviderDTO
  config: ModelsConfigDTO | null
  mutate: ModelsConfigMutate
  flush: () => Promise<boolean>
  savedAt: number
  saving: boolean
  onBack: () => void
  /** Refresh provider rows (auth state, custom flags) after edits. */
  onRefresh: () => Promise<void>
}

interface ModelRow {
  id: string
  name: string
  contextWindow: number
  reasoning: boolean
  input: string[]
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
 * One provider's settings page: sign-in state (builtin providers), editable
 * models.json fields for every provider, plus the composed model inventory —
 * registry definitions, models.json carriers and overrides, merged the way
 * the runtime composes them.
 */
export function ProviderDetail({
  provider,
  config,
  mutate,
  flush,
  savedAt,
  saving,
  onBack,
  onRefresh
}: ProviderDetailProps) {
  const { t } = useI18n()
  const entry = config?.providers[provider.id]
  const configLoaded = config !== null
  const hasKey = provider.authTypes.includes('api_key')
  const hasOauth = provider.authTypes.includes('oauth') && provider.canLogin
  // Credentials share one card. Preserve an existing stray key on an OAuth
  // provider so the user can still edit or remove it.
  const showApiKey = hasKey || !provider.builtin || entry?.apiKey !== undefined
  // The wire API the provider actually uses comes from the registry (the first
  // composed model's `api`); API_OPTIONS only curates generic choices. Show the
  // effective value and keep it selectable even when it is not one of them.
  const effectiveApi = entry?.api ?? provider.api ?? API_OPTIONS[0]
  const apiOptions: string[] = [...API_OPTIONS]
  if (!apiOptions.includes(effectiveApi)) apiOptions.unshift(effectiveApi)

  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('all')
  const [inventoryError, setInventoryError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const cancelDeleteRef = useRef<HTMLButtonElement>(null)
  const [inventory, setInventory] = useState<ProviderModelDTO[] | null>(null)
  const inventoryEpoch = useRef(0)
  const [editing, setEditing] = useState<EditingTarget | null>(null)
  const [discoverOpen, setDiscoverOpen] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [busyAuth, setBusyAuth] = useState(false)
  const [showKey, setShowKey] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<TestModelResultDTO | null>(null)
  // Access pane: an explicit choice sticks; otherwise the mode follows where
  // the credential already lives (key entry → key, oauth sign-in → oauth).
  const [chosenMode, setChosenMode] = useState<'key' | 'oauth' | null>(null)
  const authMode: 'key' | 'oauth' =
    chosenMode ??
    (entry?.apiKey ? 'key' : provider.authenticated && hasOauth ? 'oauth' : hasKey ? 'key' : 'oauth')
  const [flowActive, setFlowActive] = useState(false)
  const [flowPrompt, setFlowPrompt] = useState<AuthPromptDTO | null>(null)
  const [flowNotify, setFlowNotify] = useState<AuthNotifyDTO[]>([])
  const flowActiveRef = useRef(false)
  flowActiveRef.current = flowActive

  const loadInventory = useCallback(async () => {
    const epoch = ++inventoryEpoch.current
    try {
      const models = await window.pi.providerModels(provider.id)
      if (epoch !== inventoryEpoch.current) return
      setInventory(models)
      setInventoryError(null)
    } catch (error) {
      if (epoch !== inventoryEpoch.current) return
      setInventoryError(error instanceof Error ? error.message : String(error))
      setInventory(current => current ?? [])
    }
  }, [provider.id])

  useEffect(() => {
    setInventory(null)
    void loadInventory()
    return () => { inventoryEpoch.current++ }
  }, [loadInventory])

  // Composition changed under us (a save just landed) — refetch the rows.
  useEffect(() => {
    if (savedAt > 0) void loadInventory()
  }, [savedAt, loadInventory])

  // While this page drives the OAuth flow, its prompts and progress events
  // arrive here instead of the global overlay.
  useEffect(() => {
    if (!flowActive) return
    const offPrompt = window.pi.onAuthPrompt((next) => {
      if (next.providerId === provider.id) setFlowPrompt(next)
    })
    const offDismiss = window.pi.onAuthDismiss(({ requestId, providerId: dismissed }) => {
      setFlowPrompt((current) =>
        current && (current.requestId === requestId || dismissed === provider.id) ? null : current
      )
      if (dismissed === provider.id) setFlowNotify([])
    })
    const offNotify = window.pi.onAuthNotify((next) => {
      if (next.providerId !== provider.id) return
      setFlowNotify((current) => [...current.slice(-8), next])
    })
    return () => {
      offPrompt()
      offDismiss()
      offNotify()
    }
  }, [flowActive, provider.id])

  // Leaving the page mid-flow drops the interaction: release the overlay
  // claim and stop the login so no prompt pops out globally afterwards.
  useEffect(() => {
    return () => {
      if (!flowActiveRef.current) return
      releaseInlineAuth(provider.id)
      void window.pi.cancelLogin(provider.id).catch(() => {})
    }
  }, [provider.id])

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
        reasoning: model.reasoning,
        input: model.input,
        source: model.source,
        hasOverride: model.hasOverride,
        available: model.available,
        // Visibility belongs to the local draft. Waiting for the saved SDK
        // inventory delays badges; an older inventory can also undo a click.
        hidden: configLoaded ? entry?.modelOverrides?.[model.id]?.hidden === true : model.hidden,
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
        reasoning: model?.reasoning === true,
        input: model?.input ?? [],
        source: 'draft' as const,
        hasOverride: false,
        available: false,
        hidden: false,
        carrierIndex: index,
        base: null
      }))
    return [...composed, ...drafts]
  }, [inventory, entry, configLoaded])

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
  const setModelsHidden = (modelIds: string[], hidden: boolean) => {
    mutate(
      (draft) => {
        const current = draft.providers[provider.id] ?? {}
        const overrides = { ...(current.modelOverrides ?? {}) }
        for (const modelId of modelIds) {
          const existing = { ...(overrides[modelId] ?? {}) }
          if (hidden) existing.hidden = true
          else delete existing.hidden
          if (Object.keys(existing).length > 0) overrides[modelId] = existing
          else delete overrides[modelId]
        }
        return {
          ...draft,
          providers: { ...draft.providers, [provider.id]: { ...current, modelOverrides: overrides } }
        }
      },
      true
    )
  }

  const deleteProvider = async () => {
    if (deleting) return
    setDeleting(true)
    setActionError(null)
    try {
      mutate((draft) => {
        const providers = { ...draft.providers }
        delete providers[provider.id]
        return { ...draft, providers }
      })
      if (!await flush()) { setActionError(t('settings.providerSaveBeforeContinue')); return }
      if (provider.authenticated) await window.pi.logout(provider.id)
      setConfirmDelete(false)
      onBack()
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    } finally {
      setDeleting(false)
    }
  }

  // Starts the SDK OAuth flow and renders its interaction (method choice,
  // auth link, device code, manual code) inline below; the inline-auth claim
  // keeps the global overlay out of the way for the same events.
  const startOauth = async () => {
    if (flowActive) return
    setActionError(null)
    setFlowPrompt(null)
    setFlowNotify([])
    setFlowActive(true)
    claimInlineAuth(provider.id)
    try {
      await window.pi.login(provider.id, 'oauth')
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    } finally {
      releaseInlineAuth(provider.id)
      setFlowActive(false)
      setFlowPrompt(null)
      setFlowNotify([])
      await onRefresh()
    }
  }

  const logout = async () => {
    setBusyAuth(true)
    setActionError(null)
    try {
      await window.pi.logout(provider.id)
      await onRefresh()
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusyAuth(false)
    }
  }

  // The connectivity test pings the provider through its first visible
  // composed model: carriers keep their full definition, registry models
  // compose from the id. It resolves an API key, so it is only offered where
  // key auth exists (builtin api_key providers and custom providers).
  const testTarget = useMemo<CustomModelDTO | null>(() => {
    const candidates = rows.filter((row) => row.source !== 'draft' && !row.hidden)
    const row = candidates.find((candidate) => candidate.available) ?? candidates[0]
    if (!row) return null
    if (row.carrierIndex != null) {
      const carrier = entry?.models?.[row.carrierIndex]
      if (carrier) return { ...carrier }
    }
    return { id: row.id, name: row.name }
  }, [rows, entry])
  const canTest = testTarget !== null && (hasKey || !provider.builtin)

  const runTest = async () => {
    const model = testTarget
    if (!model || testing) return
    setTesting(true)
    setTestResult(null)
    try {
      // Test what is on disk: land pending edits first so a freshly typed key
      // is the credential under test.
      if (!await flush()) { setActionError(t('settings.providerSaveBeforeContinue')); return }
      setTestResult(await window.pi.testModel(provider.id, model))
    } catch (error) {
      setTestResult({ ok: false, error: error instanceof Error ? error.message : String(error) })
    } finally {
      setTesting(false)
    }
  }

  const modelCount = entry?.models?.length ?? 0
  const visibleModelIds = rows.filter(row => row.source !== 'draft' && !row.hidden).map(row => row.id)
  const hiddenModelIds = rows.filter(row => row.source !== 'draft' && row.hidden).map(row => row.id)
  const keyword = query.trim().toLocaleLowerCase()
  const matched = rows.filter(row =>
    (!keyword || (row.name + ' ' + row.id).toLocaleLowerCase().includes(keyword)) &&
    (filter === 'all' || (filter === 'enabled' ? !row.hidden : row.hidden))
  )
  const shown = [...matched].sort((a, b) => Number(a.hidden) - Number(b.hidden)).slice(0, 300)
  const editRow = (row: ModelRow) => {
    if (row.carrierIndex !== null) setEditing({ kind: 'carrier', index: row.carrierIndex })
    else if (row.base) setEditing({ kind: 'override', row: row.base })
  }

  return (
    <div data-provider-detail={provider.id} className="space-y-7">
      <header className="flex items-start gap-3">
        <Button variant="ghost" size="icon" aria-label={t('settings.backToList')} onClick={onBack}>
          <ArrowLeft className="size-4" />
        </Button>
        <span className="grid size-10 shrink-0 place-items-center rounded-item bg-muted/60">
          <ProviderIcon providerId={provider.id} name={provider.name} size={28} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-base font-semibold text-foreground">{provider.name}</h2>
          <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-muted-foreground">
            <span className="font-mono">{provider.id}</span>
            <span role="status" className={saving ? 'text-primary' : ''}>
              {saving ? t('settings.providerSaving') : t('settings.providerAutoSave')}
            </span>
          </p>
        </div>
      </header>

      {actionError && !confirmDelete ? <ProviderNotice tone="error">{actionError}</ProviderNotice> : null}

      <ProviderPanel title={t('settings.providerBasicInfo')} description={t('settings.providerBasicInfoHint')}>
        <ProviderCard className="p-5">
          {config ? (
            <div data-form-items className="grid gap-5 md:grid-cols-2">
              <Input
                label={t('settings.displayName')} value={entry?.name ? String(entry.name) : ''}
                onChange={value => setEntryField(value.trim() ? { name: value } : { name: undefined })}
                placeholder={provider.builtin ? provider.name : provider.id}
                classNames={PROVIDER_INPUT_CLASS_NAMES}
              />
              <div>
                <p className={PROVIDER_FIELD_HEADING}>{t('settings.api')}</p>
                <Select value={effectiveApi} onValueChange={api => setEntryField({ api })}>
                  <SelectTrigger className="w-full text-xs" aria-label={t('settings.api')}>
                    <span className="truncate font-mono text-xs">{effectiveApi}</span>
                  </SelectTrigger>
                  <SelectContent className="left-0 right-auto w-full min-w-64">
                    {apiOptions.map(option => <SelectItem key={option} value={option} className="text-xs"><span className="font-mono text-xs">{option}</span></SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <Input
                label={t('settings.baseUrl')} value={entry?.baseUrl ? String(entry.baseUrl) : provider.baseUrl ?? ''}
                onChange={value => {
                  const trimmed = value.trim()
                  setEntryField(trimmed && trimmed !== provider.baseUrl ? { baseUrl: value } : { baseUrl: undefined })
                }}
                placeholder={provider.baseUrl ?? t('settings.providerBaseUrlPlaceholder')}
                classNames={{ ...PROVIDER_INPUT_CLASS_NAMES, root: 'md:col-span-2', input: 'font-mono' }}
              />
            </div>
          ) : <p className="text-xs text-muted-foreground">{t('settings.loadingModels')}</p>}
        </ProviderCard>
      </ProviderPanel>

      {showApiKey || hasOauth ? (
        <ProviderPanel
          title={t('settings.providerCredentials')}
          description={provider.authenticated ? t('auth.connected') + (provider.authSource ? ' · ' + provider.authSource : '') : t('settings.providerCredentialsHint')}
          actions={canTest && (!hasOauth || authMode === 'key') ? (
            <Button variant="outline" size="sm" disabled={testing || !config} onClick={() => void runTest()}>
              {testing ? <Loader2 className="size-3.5 animate-spin" /> : <PlugZap className="size-3.5" />}
              {t(testing ? 'settings.testing' : 'settings.testConnection')}
            </Button>
          ) : null}
        >
          <ProviderCard className="space-y-5 p-5">
            {hasKey && hasOauth ? (
              <div role="group" aria-label={t('settings.signInMethod')}>
                <p className={PROVIDER_FIELD_HEADING}>{t('settings.signInMethod')}</p>
                <RadioGroup value={authMode} onValueChange={mode => setChosenMode(mode as 'key' | 'oauth')} orientation="horizontal" className="gap-x-5">
                  <RadioGroupItem value="key" label={t('settings.apiKey')} disabled={flowActive} className={PROVIDER_CHOICE_TEXT} />
                  <RadioGroupItem value="oauth" label={t('settings.oauth')} disabled={flowActive} className={PROVIDER_CHOICE_TEXT} />
                </RadioGroup>
              </div>
            ) : null}
            {showApiKey && (!hasOauth || authMode === 'key' || !hasKey) ? (
              <div>
                <Input
                  label={t('settings.apiKeyOptional')}
                  value={entry?.apiKey ? String(entry.apiKey) : ''}
                  onChange={value => setEntryField(value.trim() ? { apiKey: value } : { apiKey: undefined })}
                  type={showKey ? 'text' : 'password'} placeholder={t('settings.providerKeyPlaceholder')} autoComplete="off"
                  disabled={!config}
                  classNames={PROVIDER_INPUT_CLASS_NAMES}
                  rightIcon={
                    <Button variant="ghost" size="icon" aria-label={t(showKey ? 'settings.hideKey' : 'settings.showKey')} onClick={() => setShowKey(value => !value)}>
                      {showKey ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                    </Button>
                  }
                />
                <p className="mt-1.5 text-caption text-muted-foreground">{t('settings.providerKeyHint')}</p>
              </div>
            ) : null}
            {authMode === 'oauth' && hasOauth ? (
              <div>
                {flowActive ? (
                  <AuthBridgeContent prompt={flowPrompt} notify={flowNotify}
                    textClassName="text-xs"
                    onReply={(requestId, value) => { setFlowPrompt(null); void window.pi.replyAuth(requestId, value) }}
                    onCancel={() => void window.pi.cancelLogin(provider.id)}
                  />
                ) : (
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <p className="min-w-0 text-xs text-muted-foreground">{t(provider.authenticated ? 'settings.providerOAuthConnected' : 'settings.oauthSignInDesc')}</p>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <Button variant="outline" size="sm" disabled={busyAuth} onClick={() => void startOauth()}>
                        <Globe className="size-3.5" />
                        {t(provider.authenticated ? 'settings.relogin' : provider.id === 'openai' ? 'settings.signInWithChatGPT' : 'settings.oauthSignIn')}
                      </Button>
                      {provider.authenticated ? (
                        <Button variant="destructive" size="sm" disabled={busyAuth} onClick={() => void logout()}>
                          {busyAuth ? <Loader2 className="size-3.5 animate-spin" /> : <LogOut className="size-3.5" />}
                          {t('settings.signOutAction')}
                        </Button>
                      ) : null}
                    </div>
                  </div>
                )}
              </div>
            ) : null}
            {testResult ? (
              <ProviderNotice tone={testResult.ok ? 'success' : 'error'}>
                {testResult.ok ? t('settings.testOk', { ms: testResult.latencyMs ?? 0 }) : testResult.error ?? t('settings.testFailed')}
              </ProviderNotice>
            ) : null}
          </ProviderCard>
        </ProviderPanel>
      ) : null}

      <ProviderPanel
        title={t('settings.providerModels')}
        description={t('settings.providerInventorySummary', { enabled: visibleModelIds.length, total: rows.length })}
        actions={<>
          {provider.discoverable ? (
            <Button variant="outline" size="sm" disabled={!config} onClick={() => setDiscoverOpen(true)}>
              <Download className="size-3.5" />{t('settings.fetchModels')}
            </Button>
          ) : null}
          <Button variant="primary" size="sm" disabled={!config} onClick={() => setEditing({ kind: 'new' })}>
            <Plus className="size-3.5" />{t('settings.addModel')}
          </Button>
        </>}
      >
        <ProviderCard>
          <div className="space-y-3 border-b border-border/60 p-4">
            <Input value={query} onChange={setQuery} leftIcon={<Search />}
              classNames={PROVIDER_INPUT_CLASS_NAMES}
              placeholder={t('settings.searchProviderModels')} aria-label={t('settings.searchProviderModels')} />
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Tabs value={filter} onValueChange={setFilter} variant="segment">
                <TabsList>
                  <TabsTrigger value="all" className="gap-1.5 px-2.5 py-1.5 text-xs">{t('settings.providerAllModels')}<span className="tabular-nums">{rows.length}</span></TabsTrigger>
                  <TabsTrigger value="enabled" className="gap-1.5 px-2.5 py-1.5 text-xs">{t('settings.providerEnabledModels')}<span className="tabular-nums">{visibleModelIds.length}</span></TabsTrigger>
                  <TabsTrigger value="disabled" className="gap-1.5 px-2.5 py-1.5 text-xs">{t('settings.providerDisabledModels')}<span className="tabular-nums">{hiddenModelIds.length}</span></TabsTrigger>
                </TabsList>
              </Tabs>
              <div className="flex items-center gap-1">
                <Button variant="ghost" size="sm" disabled={!config || inventory === null || hiddenModelIds.length === 0} onClick={() => setModelsHidden(hiddenModelIds, false)}>
                  {t('settings.unhideAllModels')}
                </Button>
                <Button variant="ghost" size="sm" disabled={!config || inventory === null || visibleModelIds.length === 0} onClick={() => setModelsHidden(visibleModelIds, true)}>
                  {t('settings.hideAllModels')}
                </Button>
              </div>
            </div>
          </div>
          {inventoryError ? (
            <div className="p-4"><ProviderNotice tone="error"><div className="flex items-center justify-between gap-2"><span>{inventoryError}</span><Button variant="ghost" size="sm" onClick={() => void loadInventory()}>{t('settings.providerRetry')}</Button></div></ProviderNotice></div>
          ) : null}
          <FadeScroll className="max-h-[26rem] px-4 py-1">
            <div className="divide-y divide-border/60">
              {inventory === null ? (
                <div className="flex items-center justify-center gap-2 py-10 text-xs text-muted-foreground"><Loader2 className="size-4 animate-spin" />{t('settings.loadingModels')}</div>
              ) : shown.length === 0 ? (
                <p className="px-4 py-10 text-center text-xs text-muted-foreground">{t(rows.length === 0 ? 'settings.noModels' : 'settings.providerNoModelMatches')}</p>
              ) : shown.map(row => (
                <div data-provider-model={row.id} key={row.id || 'draft-' + row.carrierIndex} className="flex min-w-0 items-center gap-3 px-1 py-1.5">
                  {row.source !== 'draft' ? (
                    <Tooltip content={t(row.hidden ? 'settings.unhideModel' : 'settings.hideModel')}>
                      <Checkbox mark="square" checked={!row.hidden} disabled={!config} className="shrink-0"
                        aria-label={t(row.hidden ? 'settings.unhideModel' : 'settings.hideModel')}
                        onCheckedChange={enabled => setModelsHidden([row.id], !enabled)} />
                    </Tooltip>
                  ) : null}
                  <Button variant="ghost" className="h-8 min-w-0 flex-1 justify-start gap-2 px-2 text-left text-xs"
                    aria-label={t('settings.editModelNamed', { name: row.name || row.id || t('settings.modelDraft') })}
                    onClick={() => editRow(row)}>
                    <span className="flex min-w-0 flex-1 items-center gap-2 whitespace-nowrap">
                      <span className={'min-w-0 max-w-64 truncate text-xs ' + (row.hidden ? 'text-muted-foreground' : 'text-foreground')}>{row.name || row.id || t('settings.modelDraft')}</span>
                      {row.name && row.id && row.name !== row.id ? <span className="min-w-0 max-w-36 truncate font-mono text-caption font-normal text-muted-foreground">{row.id}</span> : null}
                      {row.source === 'draft' ? <span className="shrink-0 rounded-capsule bg-amber-500/10 px-1.5 py-0.5 text-micro text-amber-600 dark:text-amber-400">{t('settings.modelDraft')}</span> : null}
                      {row.source === 'custom' || row.source === 'both' ? <span className="shrink-0 rounded-capsule bg-muted px-1.5 py-0.5 text-micro text-muted-foreground">{t('settings.modelCustom')}</span> : null}
                      {row.hasOverride ? <span className="shrink-0 rounded-capsule bg-primary/10 px-1.5 py-0.5 text-micro text-primary">{t('settings.modelEdited')}</span> : null}
                      {row.hidden ? <span className="shrink-0 rounded-capsule bg-muted px-1.5 py-0.5 text-micro text-muted-foreground">{t('settings.modelHidden')}</span> : null}
                      <span className="ml-auto flex shrink-0 items-center gap-2 text-caption font-normal text-muted-foreground">
                        {row.contextWindow ? <span>{t('model.contextK', { k: Math.round(row.contextWindow / 1000) })}</span> : null}
                        {row.reasoning ? <span>{t('settings.reasoning')}</span> : null}
                        <ModelInputBadges input={row.input} />
                      </span>
                    </span>
                    <Pencil className="size-3.5 shrink-0 text-muted-foreground" />
                  </Button>
                  {row.hasOverride || row.carrierIndex !== null ? <div className="flex shrink-0 items-center gap-0.5">
                    {row.hasOverride ? (
                      <Tooltip content={t('settings.resetOverride')}>
                        <Button variant="ghost" size="icon" aria-label={t('settings.resetOverride')} onClick={() => clearOverride(row.id)}><RotateCcw className="size-3.5" /></Button>
                      </Tooltip>
                    ) : null}
                    {row.carrierIndex !== null ? (
                      <Tooltip content={t('settings.deleteModel')}>
                        <Button variant="destructive" size="icon" aria-label={t('settings.deleteModel')} onClick={() => removeCarrier(row.carrierIndex!)}><Trash2 className="size-3.5" /></Button>
                      </Tooltip>
                    ) : null}
                  </div> : null}
                </div>
              ))}
            </div>
          </FadeScroll>
          {matched.length > shown.length ? <p className="border-t border-border/60 px-4 py-2 text-caption text-muted-foreground">{t('settings.discoverCapped', { shown: shown.length, total: matched.length })}</p> : null}
        </ProviderCard>
        <p className="text-caption leading-ui text-muted-foreground">{t('settings.providerModelsHint')}</p>
      </ProviderPanel>

      {config ? (
        <ProviderCard>
          <SettingsRow label={t('settings.deleteProvider')} description={t('settings.providerRemoveHint')}>
            <Button variant="destructive" size="sm" onClick={() => { setActionError(null); setConfirmDelete(true) }}>
              <Trash2 className="size-3.5" />{t('common.delete')}
            </Button>
          </SettingsRow>
        </ProviderCard>
      ) : null}

      <ModelEditorDialog target={editing} providerId={provider.id} entry={entry} mutate={mutate} flush={flush} onClose={() => setEditing(null)} />
      <DiscoverDialog open={discoverOpen} providerId={provider.id} providerName={provider.name} entry={entry} flush={flush} mutate={mutate} onClose={() => setDiscoverOpen(false)} />
      <ProviderDialog open={confirmDelete} onClose={() => setConfirmDelete(false)}
        busy={deleting}
        title={t('settings.confirmDeleteProviderTitle')} initialFocusRef={cancelDeleteRef} className="max-w-md"
        footer={<div className="flex justify-end gap-2">
          <Button ref={cancelDeleteRef} variant="ghost" size="sm" disabled={deleting} onClick={() => setConfirmDelete(false)}>{t('common.cancel')}</Button>
          <Button variant="destructive" size="sm" disabled={deleting} onClick={() => void deleteProvider()}>
            {deleting ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}{t('common.delete')}
          </Button>
        </div>}
      >
        <p className="text-xs leading-ui text-muted-foreground">
          {t(provider.authenticated ? 'settings.confirmDeleteProviderAuthMessage' : 'settings.confirmDeleteProviderMessage', { name: provider.name, count: modelCount, modelsWord: t(modelCount === 1 ? 'settings.modelOne' : 'settings.modelMany') })}
        </p>
        {actionError ? <div className="mt-3"><ProviderNotice tone="error">{actionError}</ProviderNotice></div> : null}
      </ProviderDialog>
    </div>
  )
}
