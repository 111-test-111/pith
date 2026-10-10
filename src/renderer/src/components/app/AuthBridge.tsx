import { useEffect, useState } from 'react'
import { ExternalLink, Loader2 } from '@/lib/icons'
import { Button } from '@/components/motion/button'
import { Input } from '@/components/motion/input'
import type { AuthNotifyDTO, AuthPromptDTO } from '../../../../shared/types'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'

interface AuthBridgeProps {
  prompt: AuthPromptDTO | null
  notify: AuthNotifyDTO[]
  onReply: (requestId: string, value: string | null) => void
  /** Drop an in-flight login (its dialog has no prompt to cancel through). */
  onCancel: (providerId: string) => void
}

/**
 * The login interaction itself — method choices, auth links, device codes,
 * manual code input — without any overlay chrome. AuthBridge renders it in
 * the global overlay; the provider detail page renders it inline when it
 * drives an OAuth flow from its own pane.
 */
export function AuthBridgeContent({
  prompt, notify, onReply, onCancel, textClassName = 'text-sm'
}: AuthBridgeProps & { textClassName?: string }) {
  const { t } = useI18n()
  const [value, setValue] = useState('')

  useEffect(() => {
    setValue('')
  }, [prompt?.requestId])

  const reversed = [...notify].reverse()
  const deviceCode = reversed.find((n) => n.kind === 'device_code')
  const latestUrl = reversed.find((n) => n.kind === 'auth_url' && n.url)
  const progress = reversed.find((n) => n.kind === 'progress' && n.message)

  const providerId = prompt?.providerId ?? deviceCode?.providerId ?? latestUrl?.providerId ?? ''
  const masked = prompt?.kind === 'secret' || prompt?.kind === 'manual_code'
  // A device-code flow carries the page the code must be entered on; without
  // this the user sees the code but nowhere to use it.
  const verificationUrl = deviceCode?.verificationUri ?? latestUrl?.url ?? undefined
  const instructions = latestUrl?.instructions ?? reversed.find((n) => n.instructions)?.instructions

  return (
    <>
      <p className={cn('flex items-center gap-2 font-medium text-foreground', textClassName)}>
        {!prompt ? <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" /> : null}
        {prompt ? prompt.message : t('auth.waiting')}
      </p>

      {verificationUrl ? (
        <Button
          variant="outline"
          size="sm"
          className="mt-3 w-full"
          onClick={() => void window.pi.openExternal(verificationUrl)}
        >
          <ExternalLink className="size-3.5" />
          {deviceCode ? t('auth.openVerificationPage') : t('auth.openAuthPage')}
        </Button>
      ) : null}

      {instructions ? (
        <p className="mt-2 text-xs leading-ui text-muted-foreground">{instructions}</p>
      ) : null}

      {deviceCode ? (
        <div className="mt-3 rounded-xl bg-muted px-3 py-2.5 text-center">
          <p className="text-caption uppercase tracking-wide text-muted-foreground">{t('auth.deviceCode')}</p>
          <p className="font-mono text-base font-semibold text-foreground">{deviceCode.userCode}</p>
          {deviceCode.verificationUri ? (
            <p className="mt-0.5 truncate font-mono text-caption text-muted-foreground">
              {deviceCode.verificationUri}
            </p>
          ) : null}
        </div>
      ) : null}

      {!prompt && progress?.message ? (
        <p className="mt-2 text-xs leading-ui text-muted-foreground">{progress.message}</p>
      ) : null}

      {prompt?.options?.length ? (
        <div className="mt-3 space-y-1.5">
          {prompt.options.map((option, index) => (
            <Button
              key={option.id}
              type="button"
              variant="ghost"
              onClick={() => onReply(prompt.requestId, option.id)}
              className={cn('h-auto w-full flex-col items-stretch justify-start gap-0 rounded-control px-3 py-2 text-left text-foreground', textClassName)}
            >
              <span className="flex items-center gap-2">
                <span className="grid size-5 shrink-0 place-items-center rounded-capsule bg-muted text-micro text-muted-foreground">
                  {index + 1}
                </span>
                {option.label}
              </span>
              {option.description ? (
                <span className="mt-0.5 block pl-7 text-xs text-muted-foreground">{option.description}</span>
              ) : null}
            </Button>
          ))}
        </div>
      ) : prompt ? (
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
      ) : (
        // No prompt to cancel through — the device-code/URL step polls until
        // the user finishes in the browser, so offer an explicit way out.
        <div className="mt-4 flex justify-end">
          <Button type="button" variant="ghost" size="sm" onClick={() => onCancel(providerId)}>
            {t('common.cancel')}
          </Button>
        </div>
      )}
    </>
  )
}

/**
 * Renders login prompts raised by the Pi SDK (API keys, OAuth codes) and the
 * provider's progress notifications (auth URLs, device codes). Device-code
 * flows raise no prompt at all, so the notification alone must be enough to
 * open the dialog — otherwise the user sees a spinner and nothing else.
 */
export function AuthBridge(props: AuthBridgeProps) {
  const { prompt, notify } = props
  const reversed = [...notify].reverse()
  const deviceCode = reversed.find((n) => n.kind === 'device_code')
  const latestUrl = reversed.find((n) => n.kind === 'auth_url' && n.url)

  if (!prompt && !deviceCode && !latestUrl) return null

  return (
    <div className="fixed inset-0 z-[90] grid place-items-center bg-background/60 p-6 [backdrop-filter:blur(8px)]">
      <div className="w-full max-w-sm rounded-window border border-border bg-card p-5 shadow-overlay">
        <AuthBridgeContent {...props} />
      </div>
    </div>
  )
}

export function InlineLoader() {
  return <Loader2 className="size-4 animate-spin text-muted-foreground" />
}
