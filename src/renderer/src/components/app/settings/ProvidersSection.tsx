import { useCallback, useEffect, useState } from 'react'
import { Globe, KeyRound, Loader2, LogOut, RefreshCw } from 'lucide-react'
import { Button } from '@/components/motion/button'
import type { ProviderDTO } from '../../../../../shared/types'
import { ProviderStatus } from '../AuthBridge'
import { ProviderIcon } from '../ProviderIcon'
import { useI18n } from '@/i18n'

/** Provider auth (login/logout). Future default-model prefs go here. */
export function ProvidersSection() {
  const { t } = useI18n()
  const [providers, setProviders] = useState<ProviderDTO[]>([])
  const [loading, setLoading] = useState(false)
  const [busyProvider, setBusyProvider] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      setProviders(await window.pi.providers())
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
    } finally {
      setBusyProvider(null)
    }
  }

  // Configured providers float to the top; the rest stay alphabetical.
  const sorted = [...providers].sort(
    (a, b) => Number(b.authenticated) - Number(a.authenticated) || a.name.localeCompare(b.name)
  )

  return (
    <div className="space-y-3">
      {/* The page shell renders the section title/description; this toolbar
          carries the section's only action. */}
      <div className="flex justify-end">
        <Button
          variant="ghost"
          size="icon"
          aria-label={t('settings.refreshProviders')}
          onClick={() => void refresh()}
        >
          {loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
        </Button>
      </div>

      <div className="space-y-1.5">
        {sorted.map((provider) => (
          <div
            key={provider.id}
            className="flex items-center justify-between gap-3 rounded-xl border border-border/70 px-3 py-2.5"
          >
            <div className="flex min-w-0 items-center gap-2.5">
              <ProviderIcon providerId={provider.id} name={provider.name} size={20} />
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-foreground">{provider.name}</p>
              <div className="mt-0.5 flex items-center gap-2 text-xs">
                <ProviderStatus authenticated={provider.authenticated} />
                  {provider.authSource ? (
                    <span className="truncate text-muted-foreground/70">{provider.authSource}</span>
                  ) : null}
                </div>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              {provider.authTypes.includes('api_key') && provider.canLogin ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busyProvider !== null}
                  onClick={() => void login(provider, 'api_key')}
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
                  onClick={() => void login(provider, 'oauth')}
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
                  onClick={() => void logout(provider)}
                >
                  {busyProvider === `${provider.id}:logout` ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <LogOut className="size-3.5" />
                  )}
                </Button>
              ) : null}
            </div>
          </div>
        ))}
        {!loading && providers.length === 0 ? (
          <p className="py-8 text-center text-xs text-muted-foreground">{t('settings.noProviders')}</p>
        ) : null}
      </div>
    </div>
  )
}
