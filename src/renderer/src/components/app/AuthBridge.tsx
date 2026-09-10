import { useEffect, useState } from 'react'
import { CheckCircle2, ExternalLink, Loader2, XCircle } from 'lucide-react'
import { Button } from '@/components/motion/button'
import { Input } from '@/components/motion/input'
import type { AuthNotifyDTO, AuthPromptDTO } from '../../../../shared/types'
import { useI18n } from '@/i18n'

interface AuthBridgeProps {
  prompt: AuthPromptDTO | null
  notify: AuthNotifyDTO[]
  onReply: (requestId: string, value: string | null) => void
}

/**
 * Renders login prompts raised by the Pi SDK (API keys, OAuth codes) and the
 * provider's progress notifications (auth URLs, device codes).
 */
export function AuthBridge({ prompt, notify, onReply }: AuthBridgeProps) {
  const { t } = useI18n()
  const [value, setValue] = useState('')

  useEffect(() => {
    setValue('')
  }, [prompt?.requestId])

  if (!prompt) return null

  const masked = prompt.kind === 'secret' || prompt.kind === 'manual_code'
  const latestUrl = [...notify].reverse().find((n) => n.kind === 'auth_url' && n.url)
  const deviceCode = [...notify].reverse().find((n) => n.kind === 'device_code')

  return (
    <div className="fixed inset-0 z-[90] grid place-items-center bg-background/60 p-6 [backdrop-filter:blur(8px)]">
      <div className="w-full max-w-sm rounded-2xl border border-border bg-card p-5 shadow-2xl">
        <p className="text-sm font-medium text-foreground">{prompt.message}</p>

        {latestUrl?.url ? (
          <Button
            variant="outline"
            size="sm"
            className="mt-3 w-full"
            onClick={() => void window.pi.openExternal(latestUrl.url!)}
          >
            <ExternalLink className="size-3.5" />
            {t('auth.openAuthPage')}
          </Button>
        ) : null}

        {deviceCode ? (
          <div className="mt-3 rounded-xl bg-muted px-3 py-2.5 text-center">
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{t('auth.deviceCode')}</p>
            <p className="font-mono text-base font-semibold text-foreground">{deviceCode.userCode}</p>
          </div>
        ) : null}

        {prompt.options?.length ? (
          <div className="mt-3 space-y-1.5">
            {prompt.options.map((option, index) => (
              <button
                key={option.id}
                type="button"
                onClick={() => onReply(prompt.requestId, option.id)}
                className="w-full rounded-xl border border-border px-3 py-2 text-left text-sm text-foreground transition-colors hover:bg-muted"
              >
                <span className="flex items-center gap-2">
                  <span className="grid size-5 shrink-0 place-items-center rounded-full border border-border text-[10px] text-muted-foreground">
                    {index + 1}
                  </span>
                  {option.label}
                </span>
                {option.description ? (
                  <span className="mt-0.5 block pl-7 text-xs text-muted-foreground">{option.description}</span>
                ) : null}
              </button>
            ))}
          </div>
        ) : (
          <form
            className="mt-3"
            onSubmit={(event) => {
              event.preventDefault()
              if (value.trim()) onReply(prompt.requestId, value.trim())
            }}
          >
            <Input
              type={masked ? 'password' : 'text'}
              value={value}
              onChange={setValue}
              placeholder={prompt.placeholder}
              autoFocus
              aria-label={prompt.message}
            />
            <div className="mt-3 flex justify-end gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={() => onReply(prompt.requestId, null)}>
                {t('common.cancel')}
              </Button>
              <Button type="submit" size="sm" disabled={!value.trim()}>
                {t('common.continue')}
              </Button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}

export function ProviderStatus({ authenticated }: { authenticated: boolean }) {
  const { t } = useI18n()
  return authenticated ? (
    <span className="inline-flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
      <CheckCircle2 className="size-3.5" /> {t('auth.connected')}
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
      <XCircle className="size-3.5" /> {t('auth.notConfigured')}
    </span>
  )
}

export function InlineLoader() {
  return <Loader2 className="size-4 animate-spin text-muted-foreground" />
}
