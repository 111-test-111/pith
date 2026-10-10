import { useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, Eye, EyeOff, Loader2 } from '@/lib/icons'
import { Button } from '@/components/motion/button'
import { Input } from '@/components/motion/input'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/motion/select'
import { useI18n } from '@/i18n'
import type { ModelsConfigDTO } from '../../../../../../shared/types'
import type { ModelsConfigMutate } from './use-models-config'
import { API_OPTIONS } from './api-options'
import {
  ProviderCard, ProviderDialog, ProviderNotice, ProviderPanel,
  PROVIDER_FIELD_HEADING, PROVIDER_INPUT_CLASS_NAMES
} from './ProviderUi'

const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9.-]*$/

/** A custom connection is created durably before opening its model inventory. */
export function CustomProviderView({
  config, mutate, flush, providerIds, onBack, onCreated, saveError
}: {
  config: ModelsConfigDTO | null
  mutate: ModelsConfigMutate
  flush: () => Promise<boolean>
  providerIds: string[]
  saveError: string | null
  onBack: () => void
  onCreated: (providerId: string) => void | Promise<void>
}) {
  const { t } = useI18n()
  const [providerId, setProviderId] = useState('')
  const [name, setName] = useState('')
  const [api, setApi] = useState('openai-completions')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const cancelRef = useRef<HTMLButtonElement>(null)
  // An unsuccessful write retains the staged entry so Retry can save that same connection.
  const stagedId = useRef<string | null>(null)

  const requestBack = () => {
    if (providerId || name || baseUrl || apiKey || api !== 'openai-completions') setConfirmDiscard(true)
    else onBack()
  }

  const discard = () => {
    const staged = stagedId.current
    if (staged) mutate(draft => {
      const providers = { ...draft.providers }
      delete providers[staged]
      return { ...draft, providers }
    }, true)
    setConfirmDiscard(false)
    onBack()
  }

  const create = async () => {
    if (creating || !config) return
    const id = providerId.trim()
    if (!PROVIDER_ID_PATTERN.test(id)) { setError(t('settings.providerIdInvalid')); return }
    if (providerIds.includes(id) || (Object.hasOwn(config.providers, id) && stagedId.current !== id)) {
      setError(t('settings.providerIdExists')); return
    }
    if (!baseUrl.trim()) { setError(t('settings.baseUrlRequired')); return }
    setCreating(true)
    setError(null)
    const previous = stagedId.current
    stagedId.current = id
    mutate(draft => {
      const providers = { ...draft.providers }
      if (previous && previous !== id) delete providers[previous]
      providers[id] = {
        api, baseUrl: baseUrl.trim(),
        ...(name.trim() ? { name: name.trim() } : {}),
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {})
      }
      return { ...draft, providers }
    })
    try {
      if (!await flush()) { setError(t('settings.providerSaveBeforeContinue')); return }
      await onCreated(id)
    } finally {
      setCreating(false)
    }
  }

  return (
    <div data-custom-provider className="space-y-7">
      <header className="flex items-start gap-3">
        <Button variant="ghost" size="icon" disabled={creating} aria-label={t('settings.backToList')} onClick={requestBack}>
          <ArrowLeft className="size-4" />
        </Button>
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-foreground">{t('settings.addCustomProviderTitle')}</h2>
          <p className="mt-1.5 text-xs leading-ui text-muted-foreground">{t('settings.addCustomProviderHint')}</p>
        </div>
      </header>
      <form className="space-y-7" onSubmit={event => { event.preventDefault(); void create() }}>
        <ProviderPanel title={t('settings.providerBasicInfo')}>
          <ProviderCard className="p-5">
            <div data-form-items className="grid gap-5 md:grid-cols-2">
              <div><Input label={t('settings.providerId')} value={providerId} onChange={value => { setProviderId(value); setError(null) }}
                placeholder={t('settings.providerIdPlaceholder')} autoFocus disabled={creating}
                classNames={{ ...PROVIDER_INPUT_CLASS_NAMES, input: 'font-mono' }} />
                <p className="mt-1.5 text-caption text-muted-foreground">{t('settings.providerIdHint')}</p>
              </div>
              <Input label={t('settings.displayName')} value={name} onChange={setName}
                placeholder={t('settings.providerNamePlaceholder')} disabled={creating} classNames={PROVIDER_INPUT_CLASS_NAMES} />
              <div>
                <p className={PROVIDER_FIELD_HEADING}>{t('settings.api')}</p>
                <Select value={api} onValueChange={setApi} disabled={creating}>
                  <SelectTrigger className="w-full text-xs" aria-label={t('settings.api')}><span className="truncate font-mono text-xs">{api}</span></SelectTrigger>
                  <SelectContent className="left-0 right-auto w-full min-w-64">
                    {API_OPTIONS.map(option => <SelectItem key={option} value={option} className="text-xs"><span className="font-mono text-xs">{option}</span></SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <Input label={t('settings.baseUrl')} value={baseUrl} onChange={value => { setBaseUrl(value); setError(null) }}
                placeholder={t('settings.providerLocalUrlPlaceholder')} disabled={creating}
                classNames={{ ...PROVIDER_INPUT_CLASS_NAMES, input: 'font-mono' }} />
            </div>
          </ProviderCard>
        </ProviderPanel>
        <ProviderPanel title={t('settings.providerCredentials')} description={t('settings.providerCustomCredentialsHint')}>
          <ProviderCard className="p-5">
            <Input label={t('settings.apiKeyOptional')} value={apiKey} onChange={setApiKey}
              type={showKey ? 'text' : 'password'} autoComplete="off" disabled={creating}
              placeholder={t('settings.providerKeyPlaceholder')} classNames={PROVIDER_INPUT_CLASS_NAMES}
              rightIcon={<Button variant="ghost" size="icon" aria-label={t(showKey ? 'settings.hideKey' : 'settings.showKey')} onClick={() => setShowKey(value => !value)}>
                {showKey ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </Button>}
            />
          </ProviderCard>
        </ProviderPanel>
        {error ? <ProviderNotice tone="error">
          {error}
          {error === t('settings.providerSaveBeforeContinue') && saveError ? <p className="mt-1">{saveError}</p> : null}
        </ProviderNotice> : null}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/60 pt-4">
          <p className="text-caption text-muted-foreground">{t('settings.providerCreateNextHint')}</p>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" disabled={creating} onClick={requestBack}>{t('common.cancel')}</Button>
            <Button type="submit" variant="primary" size="sm" disabled={creating || !config}>
              {creating ? <Loader2 className="size-3.5 animate-spin" /> : null}
              {t('settings.providerCreateAndConfigure')}<ArrowRight className="size-3.5" />
            </Button>
          </div>
        </div>
      </form>
      <ProviderDialog open={confirmDiscard} onClose={() => setConfirmDiscard(false)} title={t('settings.providerDiscardTitle')}
        initialFocusRef={cancelRef} className="max-w-md"
        footer={<div className="flex justify-end gap-2">
          <Button ref={cancelRef} variant="ghost" size="sm" onClick={() => setConfirmDiscard(false)}>{t('settings.providerKeepEditing')}</Button>
          <Button variant="destructive" size="sm" onClick={discard}>{t('settings.providerDiscard')}</Button>
        </div>}
      >
        <p className="text-xs leading-ui text-muted-foreground">{t('settings.providerDiscardHint')}</p>
      </ProviderDialog>
    </div>
  )
}
