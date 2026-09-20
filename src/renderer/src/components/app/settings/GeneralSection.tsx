import { useEffect, useState } from 'react'
import { BASH_DEFAULT_MAX_WAIT_MS, BASH_MIN_WAIT_MS, BASH_MAX_WAIT_MS, DEFAULT_SANDBOX_MODE, type SandboxMode, type SandboxStatusDTO, type StartupSessionMode } from '../../../../../shared/types'
import { ASK_USER_DEFAULT_TIMEOUT_S, ASK_USER_MAX_TIMEOUT_S, ASK_USER_MIN_TIMEOUT_S, clampAskUserTimeoutSeconds } from '../../../../../shared/ask-user'
import { RESPONSE_TIMEOUT_DEFAULT_S, RESPONSE_TIMEOUT_MAX_S, RESPONSE_TIMEOUT_MIN_S, clampResponseTimeoutSeconds } from '../../../../../shared/response-timeout'
import { Button } from '@/components/motion/button'
import { Input } from '@/components/motion/input'
import { Checkbox } from '@/components/motion/checkbox'
import { RadioGroup, RadioGroupItem } from '@/components/motion/radio'
import { useI18n } from '@/i18n'
import { useShowReasoning } from '@/lib/show-reasoning'
import { useSpinnerVerbs } from '@/lib/spinner-verbs'
import { previewNotificationSound, useNotificationSounds } from '@/lib/notification-sounds'
import { useToolGrouping } from '@/lib/tool-grouping'
import { useStreamingBehavior, type StreamingBehavior } from '@/lib/streaming-behavior'
import { SettingsGroup, SettingsRow } from './SettingsRow'

/** One decimal place — the wait threshold's own resolution (step 0.1s). */
const formatSeconds = (ms: number) => (ms / 1000).toFixed(1)

/** A seconds field: digits only, at most one dot, never a second decimal. */
function sanitizeSeconds(raw: string) {
  const cleaned = raw.replace(/[^0-9.]/g, '')
  const [head, ...rest] = cleaned.split('.')
  return rest.length ? `${head}.${rest.join('')}` : head
}

/** Storage & install facts. Future startup/behavior prefs go here. */
export function GeneralSection() {
  const { t } = useI18n()
  const [waitSeconds, setWaitSeconds] = useState(formatSeconds(BASH_DEFAULT_MAX_WAIT_MS))
  const [savedWait, setSavedWait] = useState(BASH_DEFAULT_MAX_WAIT_MS)
  const [savingWait, setSavingWait] = useState(false)
  const [waitError, setWaitError] = useState(false)
  const waitMs = Math.round(Number(waitSeconds) * 1000)
  const validWait = waitSeconds.trim() !== '' && Number.isFinite(waitMs) && waitMs >= BASH_MIN_WAIT_MS && waitMs <= BASH_MAX_WAIT_MS
  // The field is free text while it has focus; leaving it clamps into range, so
  // a typed 999 or an empty box can never reach the setter.
  const clampWaitSeconds = (raw: string) => {
    const trimmed = raw.trim()
    // `Number('')` is 0, which would look like a below-range entry; an empty
    // field means “no answer”, so it goes back to the saved value.
    const parsed = trimmed === '' ? Number.NaN : Number(trimmed)
    if (!Number.isFinite(parsed)) return formatSeconds(savedWait)
    const ms = Math.min(BASH_MAX_WAIT_MS, Math.max(BASH_MIN_WAIT_MS, Math.round(parsed * 1000)))
    return formatSeconds(ms)
  }
  const saveWait = async () => {
    if (!validWait) return
    setSavingWait(true)
    try {
      const value = await window.pi.setBashMaxWaitMs(waitMs)
      setSavedWait(value)
      setWaitSeconds(formatSeconds(value))
      setWaitError(false)
    } catch { setWaitError(true) }
    finally { setSavingWait(false) }
  }
  // ask_user_question auto-settle deadline: whole seconds (the field caps its
  // own digits, the setter enforces the documented range).
  const [askTimeout, setAskTimeout] = useState(String(ASK_USER_DEFAULT_TIMEOUT_S))
  const [savedAskTimeout, setSavedAskTimeout] = useState(ASK_USER_DEFAULT_TIMEOUT_S)
  const [savingAskTimeout, setSavingAskTimeout] = useState(false)
  const [askTimeoutError, setAskTimeoutError] = useState(false)
  const askTimeoutValue = Number(askTimeout)
  const validAskTimeout = askTimeout.trim() !== ''
    && Number.isInteger(askTimeoutValue)
    && askTimeoutValue >= ASK_USER_MIN_TIMEOUT_S
    && askTimeoutValue <= ASK_USER_MAX_TIMEOUT_S
  // Digits only while typing; leaving the field clamps into range, so an empty
  // box or a typed 99999 can never reach the setter.
  const clampAskTimeout = (raw: string) => {
    const parsed = raw.trim() === '' ? Number.NaN : Number(raw)
    return String(clampAskUserTimeoutSeconds(parsed))
  }
  const saveAskTimeout = async () => {
    if (!validAskTimeout) return
    setSavingAskTimeout(true)
    try {
      const value = await window.pi.setAskUserTimeoutSeconds(askTimeoutValue)
      setSavedAskTimeout(value)
      setAskTimeout(String(value))
      setAskTimeoutError(false)
    } catch { setAskTimeoutError(true) }
    finally { setSavingAskTimeout(false) }
  }
  // Provider request timeout: how long a model request may go unanswered
  // before the SDK fails it as a timeout and retries.
  const [responseTimeout, setResponseTimeout] = useState(String(RESPONSE_TIMEOUT_DEFAULT_S))
  const [savedResponseTimeout, setSavedResponseTimeout] = useState(RESPONSE_TIMEOUT_DEFAULT_S)
  const [savingResponseTimeout, setSavingResponseTimeout] = useState(false)
  const [responseTimeoutError, setResponseTimeoutError] = useState(false)
  const responseTimeoutValue = Number(responseTimeout)
  const validResponseTimeout = responseTimeout.trim() !== ''
    && Number.isInteger(responseTimeoutValue)
    && responseTimeoutValue >= RESPONSE_TIMEOUT_MIN_S
    && responseTimeoutValue <= RESPONSE_TIMEOUT_MAX_S
  const clampResponseTimeout = (raw: string) => {
    const parsed = raw.trim() === '' ? Number.NaN : Number(raw)
    return String(clampResponseTimeoutSeconds(parsed))
  }
  const saveResponseTimeout = async () => {
    if (!validResponseTimeout) return
    setSavingResponseTimeout(true)
    try {
      const value = await window.pi.setResponseTimeoutSeconds(responseTimeoutValue)
      setSavedResponseTimeout(value)
      setResponseTimeout(String(value))
      setResponseTimeoutError(false)
    } catch { setResponseTimeoutError(true) }
    finally { setSavingResponseTimeout(false) }
  }
  const [checkpoints, setCheckpoints] = useState(true)
  const [checkpointError, setCheckpointError] = useState(false)
  const [savingCheckpoints, setSavingCheckpoints] = useState(false)
  /** What the next launch opens (Settings → General → Startup). */
  const [startup, setStartup] = useState<StartupSessionMode>('resume')
  const [savingStartup, setSavingStartup] = useState(false)
  const [startupError, setStartupError] = useState(false)
  const [version, setVersion] = useState<string | null>(null)
  // DSH file sandbox: the mode is read from appInfo and applied through the
  // setter; the status below it says what this host can actually enforce.
  const [sandboxMode, setSandboxMode] = useState<SandboxMode>(DEFAULT_SANDBOX_MODE)
  const [sandbox, setSandbox] = useState<SandboxStatusDTO | null>(null)
  const [savingSandbox, setSavingSandbox] = useState(false)
  const [sandboxError, setSandboxError] = useState(false)
  const applySandboxMode = (mode: SandboxMode) => {
    setSavingSandbox(true)
    setSandboxError(false)
    void window.pi
      .setSandboxMode(mode)
      .then(async (saved) => {
        setSandboxMode(saved)
        // The capability readout depends on the mode, so re-read it with it.
        setSandbox((await window.pi.appInfo()).sandbox)
      }, () => setSandboxError(true))
      .finally(() => setSavingSandbox(false))
  }
  // Subagent delegation settings (switch + concurrency) live in the
  // Subagents section, beside the profiles they govern.
  // Same module store the Composer reads — a change here applies immediately.
  const [behavior, setBehavior] = useStreamingBehavior()
  // Display preference of the transcript, shared with the message rows.
  const [showReasoning, setShowReasoning] = useShowReasoning()
  // Folds consecutive same-category tool calls into one group row when on.
  const [toolGrouping, setToolGrouping] = useToolGrouping()
  // Plays a status sentence on the turn-in-progress row instead of a bare spinner.
  const [spinnerVerbs, setSpinnerVerbs] = useSpinnerVerbs()
  // Audio cues for a finished turn and for a question waiting on the user.
  const [sounds, setSounds] = useNotificationSounds()

  useEffect(() => {
    void window.pi
      .appInfo()
      .then((info) => { setVersion(info.version); setCheckpoints(info.checkpointsEnabled); setStartup(info.startup); setWaitSeconds(formatSeconds(info.bashMaxWaitMs)); setSavedWait(info.bashMaxWaitMs); setSandboxMode(info.sandboxMode); setSandbox(info.sandbox); setAskTimeout(String(info.askUserTimeoutSeconds ?? ASK_USER_DEFAULT_TIMEOUT_S)); setSavedAskTimeout(info.askUserTimeoutSeconds ?? ASK_USER_DEFAULT_TIMEOUT_S); setResponseTimeout(String(info.responseTimeoutSeconds ?? RESPONSE_TIMEOUT_DEFAULT_S)); setSavedResponseTimeout(info.responseTimeoutSeconds ?? RESPONSE_TIMEOUT_DEFAULT_S) })
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
          <Checkbox
            mark="square"
            checked={showReasoning}
            onCheckedChange={setShowReasoning}
            aria-label={t('settings.showReasoning')}
          />
        </SettingsRow>
        <SettingsRow
          label={t('settings.toolGrouping')}
          description={t('settings.toolGroupingDesc')}
        >
          <Checkbox
            mark="square"
            checked={toolGrouping}
            onCheckedChange={setToolGrouping}
            aria-label={t('settings.toolGrouping')}
          />
        </SettingsRow>
        <SettingsRow
          label={t('settings.spinnerVerbs')}
          description={t('settings.spinnerVerbsDesc')}
        >
          <Checkbox
            mark="square"
            checked={spinnerVerbs}
            onCheckedChange={setSpinnerVerbs}
            aria-label={t('settings.spinnerVerbs')}
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title={t('settings.soundsGroup')}>
        <SettingsRow label={t('settings.soundsEnabled')} description={t('settings.soundsEnabledDesc')}>
          <Checkbox
            mark="square"
            checked={sounds.enabled}
            onCheckedChange={(value) => setSounds({ enabled: value === true })}
            aria-label={t('settings.soundsEnabled')}
          />
        </SettingsRow>
        {/* The two cues side by side, each with its own switch and a preview
            that plays it even while it is off — the only way to judge a cue
            before turning it on. The switches stay visible (not hidden) when
            the master is off, so the choice is remembered. */}
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
      </SettingsGroup>

      <SettingsGroup title={t('bashTask.settingsGroup')}>
        <SettingsRow label={t('bashTask.maxWait')} description={t('bashTask.maxWaitDesc')}>
          <Input
            value={waitSeconds}
            onChange={(value) => setWaitSeconds(sanitizeSeconds(value))}
            onBlur={() => setWaitSeconds(clampWaitSeconds(waitSeconds))}
            onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }}
            inputMode="decimal"
            disabled={savingWait}
            aria-label={t('bashTask.waitSeconds')}
            className="w-20"
            classNames={{ field: 'h-8', input: 'px-2 text-center text-sm' }}
          />
          <span className="text-xs text-muted-foreground">{t('bashTask.secondsUnit')}</span>
          <Button variant="ghost" size="sm" disabled={!validWait || waitMs === savedWait || savingWait} onClick={() => void saveWait()}>{t('bashTask.save')}</Button>
        </SettingsRow>
        {waitError ? <p className="px-4 text-xs text-destructive" role="status">{t('bashTask.saveFailed')}</p> : null}
      </SettingsGroup>

      <SettingsGroup title={t('askUser.settingsGroup')}>
        <SettingsRow label={t('askUser.timeoutLabel')} description={t('askUser.timeoutDesc')}>
          <Input
            value={askTimeout}
            onChange={(value) => setAskTimeout(value.replace(/[^0-9]/g, '').slice(0, 4))}
            onBlur={() => setAskTimeout(clampAskTimeout(askTimeout))}
            onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }}
            inputMode="numeric"
            disabled={savingAskTimeout}
            aria-label={t('askUser.timeoutSeconds')}
            className="w-20"
            classNames={{ field: 'h-8', input: 'px-2 text-center text-sm' }}
          />
          <span className="text-xs text-muted-foreground">{t('askUser.secondsUnit')}</span>
          <Button variant="ghost" size="sm" disabled={!validAskTimeout || askTimeoutValue === savedAskTimeout || savingAskTimeout} onClick={() => void saveAskTimeout()}>{t('askUser.save')}</Button>
        </SettingsRow>
        {askTimeoutError ? <p className="px-4 text-xs text-destructive" role="status">{t('askUser.saveFailed')}</p> : null}
      </SettingsGroup>

      <SettingsGroup title={t('settings.timeoutGroup')}>
        <SettingsRow
          label={t('settings.responseTimeoutLabel')}
          description={t('settings.responseTimeoutDesc')}
        >
          <Input
            value={responseTimeout}
            onChange={(value) => setResponseTimeout(value.replace(/[^0-9]/g, '').slice(0, 4))}
            onBlur={() => setResponseTimeout(clampResponseTimeout(responseTimeout))}
            onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }}
            inputMode="numeric"
            disabled={savingResponseTimeout}
            aria-label={t('settings.responseTimeoutSeconds')}
            className="w-20"
            classNames={{ field: 'h-8', input: 'px-2 text-center text-sm' }}
          />
          <span className="text-xs text-muted-foreground">{t('settings.timeoutSecondsUnit')}</span>
          <Button variant="ghost" size="sm" disabled={!validResponseTimeout || responseTimeoutValue === savedResponseTimeout || savingResponseTimeout} onClick={() => void saveResponseTimeout()}>{t('settings.timeoutSave')}</Button>
        </SettingsRow>
        {responseTimeoutError ? <p className="px-4 text-xs text-destructive" role="status">{t('settings.timeoutSaveFailed')}</p> : null}
      </SettingsGroup>

      <SettingsGroup title={t('sandbox.group')}>
        <SettingsRow label={t('sandbox.modeLabel')} description={t('sandbox.modeDesc')}>
          <RadioGroup
            orientation="horizontal"
            value={sandboxMode}
            onValueChange={(next) => applySandboxMode(next as SandboxMode)}
            className="gap-4"
          >
            <RadioGroupItem value="read-only" disabled={savingSandbox} label={t('sandbox.readOnly')} />
            <RadioGroupItem value="workspace-write" disabled={savingSandbox} label={t('sandbox.workspaceWrite')} />
            <RadioGroupItem value="danger-full-access" disabled={savingSandbox} label={t('sandbox.fullAccess')} />
          </RadioGroup>
        </SettingsRow>
        {/* A host that runs unconfined needs no status line: the radio group
            above already shows which mode is on. Only an unfreeable or missing
            runner says something the user has to act on. */}
        {sandbox && sandbox.support !== 'host' ? (
          <div data-sandbox-status className={sandbox.support === 'dependencies-missing' ? 'px-4 pb-1 text-xs text-destructive' : 'px-4 pb-1 text-xs text-muted-foreground'} role="status">
            {t(`sandbox.status.${sandbox.support}`, { backend: sandbox.backend ?? '' })}
          </div>
        ) : null}
        {sandboxError ? <p className="px-4 text-xs text-destructive" role="alert">{t('sandbox.saveFailed')}</p> : null}
      </SettingsGroup>

      <SettingsGroup title={t('settings.storage')}>
        <SettingsRow label={t('rewind.setting')} description={t('rewind.settingDescription')}>
          <Checkbox mark="square" checked={checkpoints} disabled={savingCheckpoints} aria-label={t('rewind.setting')} onCheckedChange={value => {
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
