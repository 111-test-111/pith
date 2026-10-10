import { useEffect, useRef, useState } from 'react'
import type { JevErrorCode, JevEvaluationDTO, JevPreferences, JevSettingsDTO, JevSettingsUpdate } from '../../../../../shared/types'
import { Button } from '@/components/motion/button'
import { RadioGroup, RadioGroupItem } from '@/components/motion/radio'
import { Checkbox } from '@/components/motion/checkbox'
import { Input } from '@/components/motion/input'
import { MorphingModal } from '@/components/motion/morphing-modal'
import { KeyRound } from '@/lib/icons'
import { useI18n } from '@/i18n'
import { refreshCatalog } from '@/lib/extensions-catalog'
import { SettingsGroup, SettingsRow } from './SettingsRow'

export function JevSection() {
  const { t } = useI18n()
  const [settings, setSettings] = useState<JevSettingsDTO | null>(null)
  const [draft, setDraft] = useState('')
  const [keyOpen, setKeyOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<JevErrorCode | null>(null)
  const [result, setResult] = useState<JevEvaluationDTO | null>(null)
  const mounted = useRef(false)
  const revision = useRef(0)
  const pending = useRef(false)
  const load = async () => {
    const current = ++revision.current
    setError(null)
    try { const value = await window.pi.jevSettings(); if (mounted.current && current === revision.current) setSettings(value) }
    catch { if (mounted.current && current === revision.current) setError('storage') }
  }
  useEffect(() => { mounted.current = true; void load(); return () => { mounted.current = false; revision.current++ } }, [])
  /** Runs one settings action; resolves to the failure code so callers decide
   *  whether to close a surface (the key dialog stays open on failure). */
  const act = async (update?: JevSettingsUpdate): Promise<JevErrorCode | null> => {
    if (pending.current) return 'busy'
    pending.current = true
    revision.current++
    setBusy(true); setError(null); setResult(null)
    let failure: JevErrorCode | null = null
    try {
      if (update) {
        const reply = await window.pi.updateJevSettings(update)
        if (!mounted.current) return failure
        if (!reply.ok) { failure = reply.code; setError(reply.code) }
        else {
          setSettings(reply.data)
          if ('apiKey' in update) setDraft('')
          if (update.preferences) void refreshCatalog()
        }
      } else {
        const reply = await window.pi.testJev()
        if (!mounted.current) return failure
        if (reply.ok) setResult(reply.data)
        else { failure = reply.code; setError(reply.code) }
      }
    } catch { failure = 'network'; if (mounted.current) setError('network') }
    finally { pending.current = false; if (mounted.current) setBusy(false) }
    return failure
  }
  const change = (patch: Partial<JevPreferences>) => {
    if (!settings) return
    const { mode, choice, score, noul } = settings
    void act({ preferences: { mode, choice, score, noul, ...patch } })
  }
  const openKey = () => { setError(null); setDraft(''); setKeyOpen(true) }
  const closeKey = () => { if (busy) return; setKeyOpen(false); setDraft(''); setError(null) }
  const saveKey = async () => { if (!(await act({ apiKey: draft }))) setKeyOpen(false) }
  if (!settings) return <div className="space-y-3 text-sm text-muted-foreground" role="status">
    <p>{error ? t(`jev.error.${error}`) : t('jev.loading')}</p>
    {error && <Button variant="outline" size="sm" onClick={() => void load()}>{t('jev.retry')}</Button>}
  </div>

  return <div className="space-y-6" data-jev-settings>
    <SettingsGroup title={t('jev.mode')} description={t('jev.modeDesc')}>
      <div className="p-4" role="group" aria-label={t('jev.mode')}>
        {/* The three modes read as one choice row, not a stack: side by side
            (wrapping only when the panel is too narrow). Each option stays
            atomic via `whitespace-nowrap`, so a long label moves to the next
            line instead of squeezing its own text into a column. */}
        <RadioGroup value={settings.mode} onValueChange={mode => change({ mode: mode as JevPreferences['mode'] })} orientation="horizontal" className="items-center gap-x-5 gap-y-2">
          {(['off', 'tools', 'workflow'] as const).map(mode => <RadioGroupItem key={mode} value={mode} disabled={busy} label={t(`jev.mode.${mode}`)} className="whitespace-nowrap" />)}
        </RadioGroup>
        <p className="mt-3 text-xs text-muted-foreground">{t(`jev.modeHelp.${settings.mode}`)}</p>
      </div>
    </SettingsGroup>
    <SettingsGroup title={t('jev.capabilities')} description={t('jev.capabilitiesDesc')}>
      {(['choice', 'score', 'noul'] as const).map(key => <SettingsRow key={key} label={t(`jev.${key}`)} description={t(`jev.${key}Desc`)}>
        <Checkbox mark="square" checked={settings[key]} onCheckedChange={checked => change({ [key]: checked })} disabled={busy || settings.mode !== 'tools'} aria-label={t(`jev.${key}`)} />
      </SettingsRow>)}
    </SettingsGroup>
    {/* Credentials stay one status row, like the Providers page: the secret is
        only on screen while it is being typed, so no key field sits in the
        section and nothing has to be re-masked after the fact. */}
    <SettingsGroup title={t('jev.credentials')} description={t('jev.credentialsDesc')}>
      <SettingsRow label={t('jev.keyStatus')} description={t(`jev.key.${settings.keySource}`)}>
        <Button variant="outline" size="sm" disabled={busy} onClick={openKey}>
          <KeyRound className="size-3.5" />
          {settings.keySource === 'saved' ? t('jev.replaceKey') : t('jev.setKey')}
        </Button>
        {settings.keySource === 'saved' && <Button variant="destructive" size="sm" disabled={busy} onClick={() => void act({ apiKey: null })}>{t('jev.removeKey')}</Button>}
      </SettingsRow>
      <SettingsRow label={t('jev.model')} description={t('jev.testDesc')}>
        <Button variant="outline" size="sm" disabled={busy || !['saved', 'environment'].includes(settings.keySource)} onClick={() => void act()}>{busy ? t('jev.working') : t('jev.test')}</Button>
      </SettingsRow>
      {/* Only the pass/fail outcome is surfaced: the answers above are a
          fixture, not a result the reader can act on, and a failure already
          renders as the alert below. */}
      {result && <p className="px-4 py-3 text-sm" role="status" data-jev-result>{t('jev.testSuccess', { model: result.model, ms: result.elapsedMs, input: result.inputTokens, output: result.outputTokens })}</p>}
    </SettingsGroup>
    {/* Only one alert is ever on screen: while the dialog is open its own field
        carries the failure, and it closes only once the write succeeded. */}
    {error && !keyOpen && <p className="text-sm text-destructive" role="alert">{t(`jev.error.${error}`)}</p>}
    <MorphingModal viewId={keyOpen ? 'jev-api-key' : null} onClose={closeKey} placement="center" className="max-w-md">
      <div role="dialog" aria-modal="true" aria-label={t('jev.apiKey')}>
        <h2 className="text-base font-semibold text-foreground">{t('jev.apiKey')}</h2>
        <div className="mt-3">
          <Input
            type="password"
            aria-label={t('jev.apiKey')}
            value={draft}
            onChange={value => { setDraft(value); if (error) setError(null) }}
            placeholder={t('jev.keyPlaceholder')}
            autoComplete="new-password"
            spellCheck={false}
            autoCapitalize="none"
            maxLength={512}
            disabled={busy}
            autoFocus
            error={error ? t(`jev.error.${error}`) : undefined}
            reserveErrorLine
            onKeyDown={event => { if (event.key === 'Enter' && draft.trim() && !busy) void saveKey() }}

          />
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" size="sm" disabled={busy} onClick={closeKey}>{t('common.cancel')}</Button>
          <Button variant="primary" size="sm" disabled={busy || !draft.trim()} onClick={() => void saveKey()}>{busy ? t('jev.working') : t('jev.saveKey')}</Button>
        </div>
      </div>
    </MorphingModal>
  </div>
}
