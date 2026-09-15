import { useEffect, useState } from 'react'
import { Input } from '@/components/motion/input'
import { BASH_DEFAULT_MAX_WAIT_MS, BASH_MIN_WAIT_MS, BASH_MAX_WAIT_MS, type StartupSessionMode } from '../../../../../shared/types'
import { Button } from '@/components/motion/button'
import { Switch } from '@/components/motion/switch'
import { RadioGroup, RadioGroupItem } from '@/components/motion/radio'
import { useI18n } from '@/i18n'
import { useShowReasoning } from '@/lib/show-reasoning'
import { useSpinnerVerbs } from '@/lib/spinner-verbs'
import { useToolGrouping } from '@/lib/tool-grouping'
import { useStreamingBehavior, type StreamingBehavior } from '@/lib/streaming-behavior'
import { SettingsGroup, SettingsRow } from './SettingsRow'

/** Storage & install facts. Future startup/behavior prefs go here. */
export function GeneralSection() {
  const { t } = useI18n()
  const [waitSeconds, setWaitSeconds] = useState(String(BASH_DEFAULT_MAX_WAIT_MS / 1000))
  const [savedWait, setSavedWait] = useState(BASH_DEFAULT_MAX_WAIT_MS)
  const [savingWait, setSavingWait] = useState(false)
  const [waitError, setWaitError] = useState(false)
  const waitMs = Math.round(Number(waitSeconds) * 1000)
  const validWait = waitSeconds.trim() !== '' && Number.isFinite(waitMs) && waitMs >= BASH_MIN_WAIT_MS && waitMs <= BASH_MAX_WAIT_MS
  const saveWait = async () => {
    if (!validWait) return
    setSavingWait(true)
    try {
      const value = await window.pi.setBashMaxWaitMs(waitMs)
      setSavedWait(value)
      setWaitSeconds(String(value / 1000))
      setWaitError(false)
    } catch { setWaitError(true) }
    finally { setSavingWait(false) }
  }
  const [checkpoints, setCheckpoints] = useState(true)
  const [checkpointError, setCheckpointError] = useState(false)
  const [savingCheckpoints, setSavingCheckpoints] = useState(false)
  /** What the next launch opens (Settings → General → Startup). */
  const [startup, setStartup] = useState<StartupSessionMode>('resume')
  const [savingStartup, setSavingStartup] = useState(false)
  const [startupError, setStartupError] = useState(false)
  const [version, setVersion] = useState<string | null>(null)
  // Same module store the Composer reads — a change here applies immediately.
  const [behavior, setBehavior] = useStreamingBehavior()
  // Display preference of the transcript, shared with the message rows.
  const [showReasoning, setShowReasoning] = useShowReasoning()
  // Folds consecutive same-category tool calls into one group row when on.
  const [toolGrouping, setToolGrouping] = useToolGrouping()
  // Plays a status sentence on the turn-in-progress row instead of a bare spinner.
  const [spinnerVerbs, setSpinnerVerbs] = useSpinnerVerbs()

  useEffect(() => {
    void window.pi
      .appInfo()
      .then((info) => { setVersion(info.version); setCheckpoints(info.checkpointsEnabled); setStartup(info.startup); setWaitSeconds(String(info.bashMaxWaitMs / 1000)); setSavedWait(info.bashMaxWaitMs) })
      .catch(() => {})
  }, [])

  return (
    <div className="space-y-6">
      <SettingsGroup title={t('settings.startupGroup')}>
        <SettingsRow
          label={t('settings.startupSession')}
          description={t('settings.startupSessionDesc')}
        >
          <RadioGroup
            orientation="horizontal"
            value={startup}
            onValueChange={(next) => {
              const mode = next as StartupSessionMode
              setSavingStartup(true)
              setStartupError(false)
              void window.pi
                .setStartup(mode)
                .then(setStartup, () => setStartupError(true))
                .finally(() => setSavingStartup(false))
            }}
            className="gap-4"
          >
            <RadioGroupItem value="resume" disabled={savingStartup} label={t('settings.startupResume')} />
            <RadioGroupItem value="new" disabled={savingStartup} label={t('settings.startupNew')} />
          </RadioGroup>
        </SettingsRow>
        {startupError ? (
          <p role="alert" className="px-4 text-xs text-destructive">
            {t('settings.startupFailed')}
          </p>
        ) : null}
      </SettingsGroup>

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
        <SettingsRow
          label={t('settings.showReasoning')}
          description={t('settings.showReasoningDesc')}
        >
          <Switch
            checked={showReasoning}
            onCheckedChange={setShowReasoning}
            ariaLabel={t('settings.showReasoning')}
          />
        </SettingsRow>
        <SettingsRow
          label={t('settings.toolGrouping')}
          description={t('settings.toolGroupingDesc')}
        >
          <Switch
            checked={toolGrouping}
            onCheckedChange={setToolGrouping}
            ariaLabel={t('settings.toolGrouping')}
          />
        </SettingsRow>
        <SettingsRow
          label={t('settings.spinnerVerbs')}
          description={t('settings.spinnerVerbsDesc')}
        >
          <Switch
            checked={spinnerVerbs}
            onCheckedChange={setSpinnerVerbs}
            ariaLabel={t('settings.spinnerVerbs')}
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title={t('bashTask.settingsGroup')}>
        <SettingsRow label={t('bashTask.maxWait')} description={t('bashTask.maxWaitDesc')}>
          <Input type="number" min={BASH_MIN_WAIT_MS / 1000} max={BASH_MAX_WAIT_MS / 1000} step="0.1"
            value={waitSeconds} onChange={setWaitSeconds} className="w-24" aria-label={t('bashTask.waitSeconds')}
            error={!validWait || waitError} disabled={savingWait} />
          <Button variant="ghost" size="sm" disabled={!validWait || waitMs === savedWait || savingWait} onClick={() => void saveWait()}>{t('bashTask.save')}</Button>
        </SettingsRow>
        {waitError ? <p className="px-4 text-xs text-destructive" role="status">{t('bashTask.saveFailed')}</p> : null}
      </SettingsGroup>

      <SettingsGroup title={t('settings.storage')}>
        <SettingsRow label={t('rewind.setting')} description={t('rewind.settingDescription')}>
          <Switch checked={checkpoints} disabled={savingCheckpoints} ariaLabel={t('rewind.setting')} onCheckedChange={value => {
            setSavingCheckpoints(true); setCheckpointError(false)
            void window.pi.setCheckpointsEnabled(value === true).then(setCheckpoints, () => setCheckpointError(true)).finally(() => setSavingCheckpoints(false))
          }} />
        </SettingsRow>
        {checkpointError ? <p role="alert" className="px-4 text-xs text-destructive">{t('rewind.settingFailed')}</p> : null}
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
            onClick={() => void window.pi.openExternal('https://github.com/earendil-works/pi-coding-agent')}
          >
            {t('settings.openProjectPage')}
          </Button>
        </SettingsRow>
      </SettingsGroup>
    </div>
  )
}
