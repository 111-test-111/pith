import { useEffect, useState } from 'react'
import { Button } from '@/components/motion/button'
import { Input } from '@/components/motion/input'
import { Checkbox } from '@/components/motion/checkbox'
import { useI18n } from '@/i18n'
import { SettingsGroup, SettingsRow } from './SettingsRow'

/**
 * Prompt settings: the global append system prompt
 * (~/.pi/agent/APPEND_SYSTEM.md) and whether AGENTS.md/CLAUDE.md context files
 * are injected. The main process owns both files/settings and reloads every
 * live session so a change reaches the next turn without a restart.
 * UI is beUI-native: the vendored `Input` (multiline), `Checkbox` and `Button`.
 */
export function PromptSection() {
  const { t } = useI18n()
  const [path, setPath] = useState('')
  const [value, setValue] = useState('')
  const [savedValue, setSavedValue] = useState('')
  const [contextFiles, setContextFiles] = useState(true)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let alive = true
    void Promise.all([window.pi.appendPrompt(), window.pi.appInfo()])
      .then(([prompt, info]) => {
        if (!alive) return
        setPath(prompt.path)
        setValue(prompt.text)
        setSavedValue(prompt.text)
        setContextFiles(info.contextFiles)
      })
      .catch(() => {
        if (alive) setFailed(true)
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [])

  const dirty = value !== savedValue

  const save = async () => {
    setBusy(true)
    setFailed(false)
    try {
      const prompt = await window.pi.setAppendPrompt(value)
      setPath(prompt.path)
      setValue(prompt.text)
      setSavedValue(prompt.text)
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  const toggleContextFiles = async (next: boolean) => {
    setContextFiles(next)
    try {
      setContextFiles(await window.pi.setContextFiles(next))
    } catch {
      setContextFiles(!next)
    }
  }

  return (
    <div className="space-y-7">
      <SettingsGroup title={t('settings.promptContextGroup')}>
        <SettingsRow
          label={t('settings.promptContextLabel')}
          description={t('settings.promptContextDesc')}
        >
          <Checkbox
            mark="square"
            checked={contextFiles}
            onCheckedChange={(next) => void toggleContextFiles(next)}
            disabled={loading}
            aria-label={t('settings.promptContextLabel')}
          />
        </SettingsRow>
      </SettingsGroup>

      <div className="space-y-3">
        {/* No SettingsGroup card here: the editor is the surface, so an extra
            bordered wrapper around it just double-boxes the field. */}
        <div className="px-1">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t('settings.promptGroup')}
          </p>
          {path ? (
            <p className="mt-1 text-xs text-muted-foreground/70">
              {t('settings.promptFile', { path })}
            </p>
          ) : null}
        </div>
        <Input
          multiline
          rows={16}
          value={value}
          onChange={setValue}
          disabled={loading}
          aria-label={t('settings.prompt')}
          placeholder={t('settings.promptPlaceholder')}
        />
        <div className="flex items-center justify-between gap-3 px-1">
          <p className="text-xs text-muted-foreground">
            {failed
              ? t('settings.promptSaveFailed')
              : dirty
                ? t('settings.promptUnsaved')
                : t('settings.promptSaved')}
          </p>
          <div className="flex items-center gap-1.5">
            <Button
              variant="ghost"
              size="sm"
              disabled={!dirty || busy}
              onClick={() => setValue(savedValue)}
            >
              {t('settings.promptReset')}
            </Button>
            <Button size="sm" disabled={!dirty || busy} onClick={() => void save()}>
              {t('settings.promptSave')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
