import { useEffect, useState } from 'react'
import { Globe } from 'lucide-react'
import { Button } from '@/components/motion/button'
import { useI18n } from '@/i18n'
import { SettingsGroup, SettingsRow } from './SettingsRow'

/** Storage & install facts. Future startup/behavior prefs go here. */
export function GeneralSection() {
  const { t } = useI18n()
  const [version, setVersion] = useState<string | null>(null)

  useEffect(() => {
    void window.pi
      .appInfo()
      .then((info) => setVersion(info.version))
      .catch(() => {})
  }, [])

  return (
    <div className="space-y-6">
      <SettingsGroup title={t('settings.storage')}>
        <SettingsRow label={t('settings.credentials')} description={t('settings.credentialsDesc')} />
        <SettingsRow label={t('settings.sessions')} description={t('settings.sessionsDesc')} />
      </SettingsGroup>

      <SettingsGroup title={t('settings.about')}>
        <SettingsRow label="Pi" description={version ? t('settings.version', { version }) : t('settings.versionUnknown')}>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('settings.openProjectPage')}
            title={t('settings.openProjectPage')}
            onClick={() => void window.pi.openExternal('https://github.com/earendil-works/pi-coding-agent')}
          >
            <Globe className="size-4" />
          </Button>
        </SettingsRow>
      </SettingsGroup>
    </div>
  )
}
