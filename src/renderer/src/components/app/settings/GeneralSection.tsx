import { useEffect, useState } from 'react'
import { Button } from '@/components/motion/button'
import { RadioGroup, RadioGroupItem } from '@/components/motion/radio'
import { useI18n } from '@/i18n'
import { useStreamingBehavior, type StreamingBehavior } from '@/lib/streaming-behavior'
import { SettingsGroup, SettingsRow } from './SettingsRow'

/** Storage & install facts. Future startup/behavior prefs go here. */
export function GeneralSection() {
  const { t } = useI18n()
  const [version, setVersion] = useState<string | null>(null)
  // Same module store the Composer reads — a change here applies immediately.
  const [behavior, setBehavior] = useStreamingBehavior()

  useEffect(() => {
    void window.pi
      .appInfo()
      .then((info) => setVersion(info.version))
      .catch(() => {})
  }, [])

  return (
    <div className="space-y-6">
      <SettingsGroup title={t('settings.behaviorGroup')}>
        <SettingsRow label={t('settings.behavior')} description={t('settings.behaviorDesc')}>
          <RadioGroup
            orientation="horizontal"
            value={behavior}
            onValueChange={(next) => setBehavior(next as StreamingBehavior)}
            className="gap-4"
          >
            <RadioGroupItem value="steer" label={t('settings.behaviorSteer')} />
            <RadioGroupItem value="followUp" label={t('settings.behaviorFollowUp')} />
          </RadioGroup>
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title={t('settings.storage')}>
        <SettingsRow label={t('settings.credentials')} description={t('settings.credentialsDesc')} />
        <SettingsRow label={t('settings.sessions')} description={t('settings.sessionsDesc')} />
      </SettingsGroup>

      <SettingsGroup title={t('settings.about')}>
        <SettingsRow
          label={t('app.name')}
          description={t('settings.appDescription')}
        >
          <span className="text-xs text-muted-foreground">
            {version ? t('settings.version', { version }) : t('settings.versionUnknown')}
          </span>
          <Button
            variant="ghost"
            size="sm"
            aria-label={t('settings.openProjectPage')}
            title={t('settings.openProjectPage')}
            onClick={() => void window.pi.openExternal('https://github.com/earendil-works/pi-coding-agent')}
          >
            {t('settings.openProjectPage')}
          </Button>
        </SettingsRow>
      </SettingsGroup>
    </div>
  )
}
