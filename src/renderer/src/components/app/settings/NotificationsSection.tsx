import { useState } from 'react'
import { Button } from '@/components/motion/button'
import { Checkbox } from '@/components/motion/checkbox'
import { useI18n } from '@/i18n'
import {
  previewNotificationSound,
  previewSystemNotification,
  requestSystemNotificationPermission,
  systemNotificationPermission,
  useNotificationSounds,
  useSystemNotifications
} from '@/lib/notification-sounds'
import { SettingsRow } from './SettingsRow'

/** Native alerts and audio cues — every out-of-app attention signal in one page. */
export function NotificationsSection() {
  const { t } = useI18n()
  const [sounds, setSounds] = useNotificationSounds()
  const [systemNotifications, setSystemNotifications] = useSystemNotifications()
  const [systemNotificationBusy, setSystemNotificationBusy] = useState(false)
  const [systemNotificationError, setSystemNotificationError] = useState<'denied' | 'unavailable' | null>(null)

  const systemNotificationCopy = {
    title: t('notification.turnCompleteTitle'),
    body: t('notification.turnCompleteBody')
  }
  const notificationFailure = (): 'denied' | 'unavailable' =>
    systemNotificationPermission() === 'denied' ? 'denied' : 'unavailable'

  const changeSystemNotifications = async (enabled: boolean) => {
    setSystemNotificationError(null)
    if (!enabled) {
      setSystemNotifications({ enabled: false })
      return
    }
    setSystemNotificationBusy(true)
    try {
      const permission = await requestSystemNotificationPermission()
      if (permission === 'granted') setSystemNotifications({ enabled: true })
      else setSystemNotificationError(permission === 'denied' ? 'denied' : 'unavailable')
    } finally {
      setSystemNotificationBusy(false)
    }
  }

  const previewSystemNotifications = async () => {
    setSystemNotificationBusy(true)
    setSystemNotificationError(null)
    try {
      if (!(await previewSystemNotification(systemNotificationCopy))) {
        setSystemNotificationError(notificationFailure())
      }
    } finally {
      setSystemNotificationBusy(false)
    }
  }

  return (
    <div className="space-y-6">
      {/* Every attention signal on one card — the section heading already
          supplies the title, so no inner group repeats it. */}
      <div className="divide-y divide-border/60 rounded-xl border border-border/70 bg-card">
        <SettingsRow
          label={t('settings.systemNotificationsEnabled')}
          description={t('settings.systemNotificationsEnabledDesc')}
        >
          <Button
            variant="ghost"
            size="sm"
            disabled={systemNotificationBusy}
            onClick={() => void previewSystemNotifications()}
          >
            {t('settings.systemNotificationsPreview')}
          </Button>
          <Checkbox
            mark="square"
            disabled={systemNotificationBusy}
            checked={systemNotifications.enabled}
            onCheckedChange={(value) => void changeSystemNotifications(value === true)}
            aria-label={t('settings.systemNotificationsEnabled')}
          />
        </SettingsRow>
        {systemNotificationError ? (
          <p role="status" className="px-4 text-xs text-destructive">
            {t(systemNotificationError === 'denied'
              ? 'settings.systemNotificationsDenied'
              : 'settings.systemNotificationsUnavailable')}
          </p>
        ) : null}
        <SettingsRow label={t('settings.soundsEnabled')} description={t('settings.soundsEnabledDesc')}>
          <Checkbox
            mark="square"
            checked={sounds.enabled}
            onCheckedChange={(value) => setSounds({ enabled: value === true })}
            aria-label={t('settings.soundsEnabled')}
          />
        </SettingsRow>
        {/* Each cue keeps its own switch and can be previewed while disabled. */}
        <SettingsRow label={t('settings.soundTurnComplete')} description={t('settings.soundTurnCompleteDesc')}>
          <Button variant="ghost" size="sm" onClick={() => previewNotificationSound('turnComplete')}>
            {t('settings.soundPreview')}
          </Button>
          <Checkbox
            mark="square"
            disabled={!sounds.enabled}
            checked={sounds.turnComplete}
            onCheckedChange={(value) => setSounds({ turnComplete: value === true })}
            aria-label={t('settings.soundTurnComplete')}
          />
        </SettingsRow>
        <SettingsRow label={t('settings.soundAskUser')} description={t('settings.soundAskUserDesc')}>
          <Button variant="ghost" size="sm" onClick={() => previewNotificationSound('askUser')}>
            {t('settings.soundPreview')}
          </Button>
          <Checkbox
            mark="square"
            disabled={!sounds.enabled}
            checked={sounds.askUser}
            onCheckedChange={(value) => setSounds({ askUser: value === true })}
            aria-label={t('settings.soundAskUser')}
          />
        </SettingsRow>
        <SettingsRow label={t('settings.soundScheduledTask')} description={t('settings.soundScheduledTaskDesc')}>
          <Button variant="ghost" size="sm" onClick={() => previewNotificationSound('scheduledTask')}>
            {t('settings.soundPreview')}
          </Button>
          <Checkbox
            mark="square"
            disabled={!sounds.enabled}
            checked={sounds.scheduledTask}
            onCheckedChange={(value) => setSounds({ scheduledTask: value === true })}
            aria-label={t('settings.soundScheduledTask')}
          />
        </SettingsRow>
      </div>
    </div>
  )
}
