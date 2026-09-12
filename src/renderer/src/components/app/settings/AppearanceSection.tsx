import { useEffect, useState } from 'react'
import { useTheme } from 'next-themes'
import { RadioGroup, RadioGroupItem } from '@/components/motion/radio'
import { Input } from '@/components/motion/input'
import { Tooltip } from '@/components/motion/tooltip'
import { cn } from '@/lib/utils'
import { useFontSettings, type UIFont } from '@/lib/fonts'
import { useI18n, LOCALE_NAMES, type Locale } from '@/i18n'
import { SettingsGroup, SettingsRow } from './SettingsRow'

/** Swatch colors: the light-mode `--primary` of each preset, lifted a touch so
 * the dot reads as a paint chip rather than a filled button. Keep the chroma in
 * step with `styles.css` — the swatches are the presets' visual identity. */
export const ACCENTS = [
  { id: 'indigo', color: 'oklch(0.59 0.18 275)' },
  { id: 'blue', color: 'oklch(0.59 0.16 255)' },
  { id: 'violet', color: 'oklch(0.59 0.2 300)' },
  { id: 'emerald', color: 'oklch(0.59 0.12 163)' },
  { id: 'amber', color: 'oklch(0.67 0.13 68)' },
  { id: 'rose', color: 'oklch(0.61 0.165 15)' },
  { id: 'cyan', color: 'oklch(0.61 0.105 215)' }
] as const

/** Free-text monospace family; empty leaves the app on the platform default.
 * The field previews the typed family while its placeholder stays interface
 * text (it is a normal UI string, not a font sample). */
function MonoFontPicker({
  label,
  description,
  placeholder,
  value,
  onChange
}: {
  label: string
  description: string
  placeholder: string
  value: string
  onChange: (family: string) => void
}) {
  return (
    <SettingsRow label={label} description={description}>
      <Input
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        aria-label={label}
        spellCheck={false}
        autoComplete="off"
        classNames={{
          root: 'w-56',
          field: 'h-8',
          input: 'font-mono text-xs placeholder:font-sans'
        }}
      />
    </SettingsRow>
  )
}

/** Language / theme mode / accent / fonts — everything that changes how the app looks. */
export function AppearanceSection({
  accent,
  onAccentChange
}: {
  accent: string
  onAccentChange: (accent: string) => void
}) {
  const { t, locale, setLocale } = useI18n()
  const { theme, setTheme } = useTheme()
  const [fonts, setFonts] = useFontSettings()
  const [mounted, setMounted] = useState(false)

  // next-themes resolves the stored theme after mount; render the neutral
  // value first to avoid a flash of the wrong selection.
  useEffect(() => setMounted(true), [])

  return (
    <div className="space-y-6">
      <SettingsGroup title={t('settings.language')} description={t('settings.languageDesc')}>
        <div className="px-4 py-3.5">
          <RadioGroup
            orientation="horizontal"
            value={locale}
            onValueChange={(next) => setLocale(next as Locale)}
            className="gap-6"
          >
            {(Object.keys(LOCALE_NAMES) as Locale[]).map((id) => (
              <RadioGroupItem key={id} value={id} label={LOCALE_NAMES[id]} />
            ))}
          </RadioGroup>
        </div>
      </SettingsGroup>

      <SettingsGroup title={t('settings.theme')}>
        <div className="px-4 py-3.5">
          <RadioGroup
            orientation="horizontal"
            value={mounted ? (theme ?? 'system') : 'system'}
            onValueChange={setTheme}
            className="gap-6"
          >
            <RadioGroupItem value="light" label={t('settings.light')} />
            <RadioGroupItem value="dark" label={t('settings.dark')} />
            <RadioGroupItem value="system" label={t('settings.system')} />
          </RadioGroup>
        </div>
      </SettingsGroup>

      <SettingsGroup title={t('settings.fonts')} description={t('settings.fontsDesc')}>
        <SettingsRow label={t('settings.uiFont')} description={t('settings.uiFontDesc')}>
          <RadioGroup
            orientation="horizontal"
            value={fonts.ui}
            onValueChange={(next) => setFonts({ ui: next as UIFont })}
            className="gap-6"
          >
            <RadioGroupItem value="sans" label={t('settings.fontSans')} />
            <RadioGroupItem value="serif" label={t('settings.fontSerif')} />
          </RadioGroup>
        </SettingsRow>
        <MonoFontPicker
          label={t('settings.monoFont')}
          description={t('settings.monoFontDesc')}
          placeholder={t('settings.fontDefault')}
          value={fonts.mono}
          onChange={(mono) => setFonts({ mono })}
        />
      </SettingsGroup>

      <SettingsGroup title={t('settings.accent')} description={t('settings.accentDesc')}>
        <div className="px-4 py-3.5">
          <div className="flex flex-wrap gap-2.5">
            {ACCENTS.map((preset) => (
              <Tooltip key={preset.id} content={t('settings.accentAria', { id: preset.id })}>
                <button
                  type="button"
                  aria-label={t('settings.accentAria', { id: preset.id })}
                  aria-pressed={accent === preset.id}
                  onClick={() => onAccentChange(preset.id)}
                  className={cn(
                    'grid size-8 place-items-center rounded-full transition-transform hover:scale-110',
                    accent === preset.id && 'ring-2 ring-foreground/60 ring-offset-2 ring-offset-background'
                  )}
                  style={{ background: preset.color }}
                >
                  {accent === preset.id ? <span className="size-2 rounded-full bg-white/90" /> : null}
                </button>
              </Tooltip>
            ))}
          </div>
        </div>
      </SettingsGroup>
    </div>
  )
}
