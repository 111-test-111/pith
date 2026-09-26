import { useEffect, useState } from 'react'
import { Plus } from '@/lib/icons'
import { MorphingModal } from '@/components/motion/morphing-modal'
import { Button } from '@/components/motion/button'
import { Input } from '@/components/motion/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger
} from '@/components/motion/select'
import { useI18n } from '@/i18n'
import type { ModelsConfigDTO } from '../../../../../../shared/types'
import type { ModelsConfigMutate } from './use-models-config'
import { FORM_FIELD_HEADING, FORM_INPUT_LABEL, FORM_PANEL_TITLE } from '@/lib/form-standard'

/** Wire APIs a custom provider entry can speak. */
export const API_OPTIONS = [
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
  'google-generative-ai',
  'mistral-conversations'
] as const

const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9.-]*$/

/**
 * Creates a models.json provider entry. Base URL is required — an entry
 * without baseUrl/models/apiKey is structurally invalid and the SDK drops it
 * during composition, so the form enforces it up front.
 */
export function AddProviderDialog({
  open,
  config,
  mutate,
  onClose,
  onCreated
}: {
  open: boolean
  config: ModelsConfigDTO | null
  mutate: ModelsConfigMutate
  onClose: () => void
  onCreated: (providerId: string) => void
}) {
  const { t } = useI18n()
  const [providerId, setProviderId] = useState('')
  const [api, setApi] = useState<string>('openai-completions')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setProviderId('')
    setApi('openai-completions')
    setBaseUrl('')
    setApiKey('')
    setError(null)
  }, [open])

  if (!open) return null

  const trimmedId = providerId.trim()

  const create = () => {
    if (!PROVIDER_ID_PATTERN.test(trimmedId)) {
      setError(t('settings.providerIdInvalid'))
      return
    }
    if (config && Object.prototype.hasOwnProperty.call(config.providers, trimmedId)) {
      setError(t('settings.providerIdExists'))
      return
    }
    if (!baseUrl.trim()) {
      setError(t('settings.baseUrlRequired'))
      return
    }
    const id = trimmedId
    mutate(
      (draft) => ({
        ...draft,
        providers: {
          ...draft.providers,
          [id]: {
            api,
            baseUrl: baseUrl.trim(),
            ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {})
          }
        }
      }),
      true
    )
    onCreated(id)
    onClose()
  }

  return (
    <MorphingModal viewId={open ? 'add-provider' : null} onClose={onClose} placement="center" className="w-[min(40rem,calc(100vw-3rem))] max-w-none">
      <h2 className={FORM_PANEL_TITLE}>{t('settings.addProviderTitle')}</h2>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">{t('settings.addProviderDesc')}</p>

      <div data-form-items className="mt-4 grid gap-5 md:grid-cols-2">
        <Input
          label={t('settings.providerId')}
          value={providerId}
          onChange={(v) => {
            setProviderId(v)
            setError(null)
          }}
          placeholder="ollama"
          classNames={{ ...FORM_INPUT_LABEL, input: 'font-mono text-sm' }}
          error={error ?? undefined}
          reserveErrorLine
          autoFocus
        />

        <div>
          <label className={`block ${FORM_FIELD_HEADING}`}>
            {t('settings.api')}
          </label>
          <Select value={api} onValueChange={setApi}>
            <SelectTrigger className="w-full" aria-label={t('settings.api')}>
              <span className="font-mono text-sm">{api}</span>
            </SelectTrigger>
            <SelectContent className="left-0 right-auto w-80">
              {API_OPTIONS.map((option) => (
                <SelectItem key={option} value={option} className="py-1.5">
                  <span className="font-mono text-sm">{option}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <Input
          label={t('settings.baseUrl')}
          value={baseUrl}
          onChange={(v) => {
            setBaseUrl(v)
            setError(null)
          }}
          placeholder="http://localhost:11434/v1"
          classNames={{ ...FORM_INPUT_LABEL, input: 'font-mono text-sm' }}
        />

        <Input
          label={t('settings.apiKeyOptional')}
          value={apiKey}
          onChange={setApiKey}
          type="password"
          placeholder="ollama"
          classNames={FORM_INPUT_LABEL}
        />
      </div>

      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onClose}>
          {t('common.cancel')}
        </Button>
        <Button variant="primary" size="sm" onClick={create}>
          <Plus className="size-3.5" />
          {t('settings.addProvider')}
        </Button>
      </div>
    </MorphingModal>
  )
}
