import { useEffect, useState } from 'react'
import { BASH_DEFAULT_MAX_WAIT_MS, BASH_MIN_WAIT_MS, BASH_MAX_WAIT_MS, DEFAULT_SANDBOX_MODE, type SandboxMode, type SandboxStatusDTO, type StartupSessionMode } from '../../../../../shared/types'
import { Button } from '@/components/motion/button'
import { Input } from '@/components/motion/input'
import { Switch } from '@/components/motion/switch'
import { RadioGroup, RadioGroupItem } from '@/components/motion/radio'
import { useI18n } from '@/i18n'
import { useShowReasoning } from '@/lib/show-reasoning'
import { useSpinnerVerbs } from '@/lib/spinner-verbs'
import { useToolGrouping } from '@/lib/tool-grouping'
import { useStreamingBehavior, type StreamingBehavior } from '@/lib/streaming-behavior'
import { SettingsGroup, SettingsRow } from './SettingsRow'

/** Mirrors the main-process guard for `subagents:setMaxConcurrent`. */
const SUBAGENT_MIN_CONCURRENT = 1
const SUBAGENT_MAX_CONCURRENT = 16

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
  // Subagent delegation; read from appInfo, applied through the setter IPC.
  const [subagentsEnabled, setSubagentsEnabled] = useState(true)
  const [savingSubagents, setSavingSubagents] = useState(false)
  /** Per-parent concurrent delegation limit; 1–16 mirrors the main-process guard. */
  const [subagentConcurrent, setSubagentConcurrent] = useState(4)
  // Free text only while the field is being edited; `null` shows the saved
  // number, so a failed save or a blur always lands on a real value.
  const [concurrentDraft, setConcurrentDraft] = useState<string | null>(null)
  const [savingConcurrent, setSavingConcurrent] = useState(false)
  const [concurrentError, setConcurrentError] = useState(false)
  const saveConcurrent = (value: number) => {
    setSubagentConcurrent(value)
    setSavingConcurrent(true)
    setConcurrentError(false)
    void window.pi
      .setSubagentMaxConcurrent(value)
      .then(setSubagentConcurrent, () => setConcurrentError(true))
      .finally(() => setSavingConcurrent(false))
  }
  // Leaving the field clamps whatever was typed into 1–16 and saves only a real
  // change, so keystrokes never race the setter.
  const commitConcurrent = () => {
    const parsed = Number.parseInt(concurrentDraft ?? '', 10)
    const next = Number.isFinite(parsed)
      ? Math.min(SUBAGENT_MAX_CONCURRENT, Math.max(SUBAGENT_MIN_CONCURRENT, parsed))
      : subagentConcurrent
    setConcurrentDraft(null)
    if (next !== subagentConcurrent) saveConcurrent(next)
  }
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
      .then((info) => { setVersion(info.version); setCheckpoints(info.checkpointsEnabled); setStartup(info.startup); setSubagentsEnabled(info.subagentsEnabled !== false); setSubagentConcurrent(info.subagentMaxConcurrent ?? 4); setWaitSeconds(formatSeconds(info.bashMaxWaitMs)); setSavedWait(info.bashMaxWaitMs); setSandboxMode(info.sandboxMode); setSandbox(info.sandbox) })
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
          label={t('subagent.settingsTitle')}
          description={t('subagent.settingsDesc')}
        >
          <Switch
            checked={subagentsEnabled}
            disabled={savingSubagents}
            onCheckedChange={(value) => {
              setSavingSubagents(true)
              void window.pi
                .setSubagentsEnabled(value)
                .then(setSubagentsEnabled, () => {})
                .finally(() => setSavingSubagents(false))
            }}
            ariaLabel={t('subagent.settingsTitle')}
          />
        </SettingsRow>
        <SettingsRow
          label={t('subagent.concurrency')}
          description={t('subagent.concurrencyDesc')}
        >
          <Input
            value={concurrentDraft ?? String(subagentConcurrent)}
            onChange={(value) => setConcurrentDraft(value.replace(/\D/g, '').slice(0, 2))}
            onBlur={commitConcurrent}
            onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }}
            inputMode="numeric"
            disabled={!subagentsEnabled || savingSubagents || savingConcurrent}
            aria-label={t('subagent.concurrency')}
            className="w-16"
            classNames={{ field: 'h-8', input: 'px-2 text-center text-sm' }}
          />
        </SettingsRow>
        {concurrentError ? <p role="alert" className="px-4 text-xs text-destructive">{t('subagent.concurrencyFailed')}</p> : null}
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
        <div className={sandbox?.support === 'dependencies-missing' ? 'px-4 pb-1 text-xs text-destructive' : 'px-4 pb-1 text-xs text-muted-foreground'} role="status">
          {sandbox ? t(`sandbox.status.${sandbox.support}`, { backend: sandbox.backend ?? '' }) : null}
        </div>
        {sandboxError ? <p className="px-4 text-xs text-destructive" role="alert">{t('sandbox.saveFailed')}</p> : null}
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
