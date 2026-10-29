import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/motion/button'
import { Input } from '@/components/motion/input'
import { useI18n } from '@/i18n'
import type { MessageKey } from '@/i18n/locales/en'
import { DEFAULT_FONT_SIZES, FONT_SIZE_LIMITS, useFontSizes, type FontSizeSettings } from '@/lib/typography'
import { SettingsRow } from './SettingsRow'

const fields: { key: keyof FontSizeSettings; label: MessageKey; description: MessageKey }[] = [
  { key: 'ui', label: 'settings.uiFontSize', description: 'settings.uiFontSizeDesc' },
  { key: 'content', label: 'settings.contentFontSize', description: 'settings.contentFontSizeDesc' },
  { key: 'code', label: 'settings.codeFontSize', description: 'settings.codeFontSizeDesc' }
]

function FontSizeField({ kind, value, label, description, onCommit }: {
  kind: keyof FontSizeSettings; value: number; label: string; description: string; onCommit: (value: number) => void
}) {
  const { t } = useI18n()
  const [draft, setDraft] = useState(String(value))
  const cancelBlur = useRef(false)
  const { min, max } = FONT_SIZE_LIMITS[kind]
  useEffect(() => setDraft(String(value)), [value])
  const commit = (raw: string) => {
    const parsed = raw.trim() === '' ? Number.NaN : Number(raw)
    const next = Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.round(parsed))) : value
    setDraft(String(next))
    if (next !== value) onCommit(next)
  }
  return <SettingsRow label={label} description={`${description} ${t('settings.fontSizeRange', { min, max })}`}>
    <Input value={draft} onChange={raw => setDraft(raw.replace(/[^0-9]/g, '').slice(0, 2))}
      aria-label={label} data-font-size-field={kind} inputMode="numeric" pattern="[0-9]*" maxLength={2}
      onBlur={event => { if (cancelBlur.current) cancelBlur.current = false; else commit(event.currentTarget.value) }}
      onKeyDown={event => {
        if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur() }
        if (event.key === 'Escape') {
          event.preventDefault(); event.stopPropagation(); cancelBlur.current = true
          setDraft(String(value)); event.currentTarget.blur()
        }
      }}
      classNames={{ root: 'w-16', input: 'tabular-nums' }} />
    <span className="text-xs text-muted-foreground">{t('settings.fontSizeUnit')}</span>
  </SettingsRow>
}

/** The base-size rows of the Appearance → Fonts group. Kept as its own
 *  component (no card of its own — the fonts group supplies that) because
 *  check-font-sizes mounts these fields standalone. */
export function FontSizesGroup() {
  const { t } = useI18n()
  const [sizes, setSizes] = useFontSizes()
  const defaults = fields.every(field => sizes[field.key] === DEFAULT_FONT_SIZES[field.key])
  return <>
    {fields.map(field => <FontSizeField key={field.key} kind={field.key} value={sizes[field.key]}
      label={t(field.label)} description={t(field.description)} onCommit={value => setSizes({ [field.key]: value })} />)}
    <div className="flex justify-end px-3 py-2">
      <Button variant="ghost" size="sm" data-font-size-reset disabled={defaults} onClick={() => setSizes(DEFAULT_FONT_SIZES)}>
        {t('settings.fontSizesReset')}
      </Button>
    </div>
  </>
}
