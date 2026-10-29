import { useEffect, useState } from 'react'
import { Button } from '@/components/motion/button'
import { Checkbox } from '@/components/motion/checkbox'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/motion/select'
import { useI18n } from '@/i18n'
import {
  PICTURE_IN_PICTURE_FRAME_RATES,
  PICTURE_IN_PICTURE_POSITIONS,
  PICTURE_IN_PICTURE_SCALES,
  type PictureInPicturePreferencesDTO
} from '../../../../../shared/types'
import { SettingsRow } from './SettingsRow'

type Position = PictureInPicturePreferencesDTO['position']
type Scale = PictureInPicturePreferencesDTO['initialScale']

const positionKeys = {
  last: 'pip.positionLast',
  center: 'pip.positionCenter',
  'top-left': 'pip.positionTopLeft',
  'top-right': 'pip.positionTopRight',
  'bottom-left': 'pip.positionBottomLeft',
  'bottom-right': 'pip.positionBottomRight'
} as const satisfies Record<Position, string>

/** App-owned controls composed from the vendored beUI settings primitives. */
export function PictureInPictureSection() {
  const { t } = useI18n()
  const [preferences, setPreferences] = useState<PictureInPicturePreferencesDTO | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const [retry, setRetry] = useState(0)

  useEffect(() => {
    let alive = true
    setError(false)
    void window.pi.pictureInPicturePreferences()
      .then((value) => { if (alive) setPreferences(value) })
      .catch(() => { if (alive) setError(true) })
    return () => { alive = false }
  }, [retry])

  const save = async (update: Partial<PictureInPicturePreferencesDTO>) => {
    if (!preferences || busy) return
    setBusy(true)
    setError(false)
    try {
      setPreferences(await window.pi.setPictureInPicturePreferences(update))
    } catch { setError(true) }
    finally { setBusy(false) }
  }

  const scaleLabel = (value: Scale) => value === 'last'
    ? t('pip.scaleLast') : t('pip.scalePercent', { value })

  return (
    <div data-pip-settings className="space-y-6">
      {preferences ? (
        <>
          {/* Playback and window behavior are four rows of one feature —
              one card, like the Browser section's. */}
          <div className="divide-y divide-border/60 rounded-xl border border-border/70 bg-card">
            <SettingsRow label={t('pip.settingsFrameRate')} description={t('pip.settingsFrameRateDesc')}>
              <Select
                value={String(preferences.frameRate)}
                disabled={busy}
                onValueChange={(value) => void save({ frameRate: Number(value) as PictureInPicturePreferencesDTO['frameRate'] })}
              >
                <SelectTrigger aria-label={t('pip.settingsFrameRate')} className="h-9 w-52 rounded-control px-3 text-sm">
                  {t('pip.settingsFpsOption', { count: preferences.frameRate })}
                </SelectTrigger>
                <SelectContent className="left-auto right-0 w-52">
                  {PICTURE_IN_PICTURE_FRAME_RATES.map((rate) => (
                    <SelectItem key={rate} value={String(rate)} className="text-sm">
                      {t('pip.settingsFpsOption', { count: rate })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </SettingsRow>
            <SettingsRow label={t('pip.settingsPosition')} description={t('pip.settingsPositionDesc')}>
              <Select
                value={preferences.position}
                disabled={busy}
                onValueChange={(value) => void save({ position: value as Position })}
              >
                <SelectTrigger aria-label={t('pip.settingsPosition')} className="h-9 w-52 rounded-control px-3 text-sm">
                  {t(positionKeys[preferences.position])}
                </SelectTrigger>
                <SelectContent className="left-auto right-0 w-52">
                  {PICTURE_IN_PICTURE_POSITIONS.map((position) => (
                    <SelectItem key={position} value={position} className="text-sm">
                      {t(positionKeys[position])}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </SettingsRow>
            <SettingsRow label={t('pip.settingsInitialScale')} description={t('pip.settingsInitialScaleDesc')}>
              <Select
                value={preferences.initialScale}
                disabled={busy}
                onValueChange={(value) => void save({ initialScale: value as Scale })}
              >
                <SelectTrigger aria-label={t('pip.settingsInitialScale')} className="h-9 w-52 rounded-control px-3 text-sm">
                  {scaleLabel(preferences.initialScale)}
                </SelectTrigger>
                <SelectContent className="left-auto right-0 w-52">
                  {PICTURE_IN_PICTURE_SCALES.map((scale) => (
                    <SelectItem key={scale} value={scale} className="text-sm">
                      {scaleLabel(scale)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </SettingsRow>
            <SettingsRow label={t('pip.settingsStartPinned')} description={t('pip.settingsStartPinnedDesc')}>
              <Checkbox
                mark="square"
                checked={preferences.startPinned}
                disabled={busy}
                aria-label={t('pip.settingsStartPinned')}
                onCheckedChange={(value) => void save({ startPinned: value === true })}
              />
            </SettingsRow>
          </div>
        </>
      ) : (
        <div className="divide-y divide-border/60 rounded-xl border border-border/70 bg-card">
          <div className="px-4 py-3 text-sm text-muted-foreground">{t(error ? 'pip.settingsLoadError' : 'pip.settingsLoading')}</div>
          {error ? (
            <div className="px-4 pb-3">
              <Button size="sm" variant="outline" onClick={() => setRetry((value) => value + 1)}>{t('pip.settingsRetry')}</Button>
            </div>
          ) : null}
        </div>
      )}
      {error && preferences ? <p role="alert" className="px-4 text-xs text-destructive">{t('pip.settingsSaveError')}</p> : null}
    </div>
  )
}
