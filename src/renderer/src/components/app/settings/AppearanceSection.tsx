import { useEffect, useState } from 'react'
import { useTheme } from 'next-themes'
import { RadioGroup, RadioGroupItem } from '@/components/motion/radio'
import { Input } from '@/components/motion/input'
import { Checkbox } from '@/components/motion/checkbox'
import { Tooltip } from '@/components/motion/tooltip'
import { cn } from '@/lib/utils'
import { useFontSettings } from '@/lib/fonts'
import { useSidebarGlass } from '@/lib/sidebar-glass'
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

/** Free-text family field, shared by both typefaces; empty leaves the app on
 * the system default (the sans-serif tail for the interface, the platform mono for
 * code). The field previews the family it edits — `--app-font-ui`/
 * `--app-font-mono` carry the typed name first, so `font-sans`/`font-mono`
 * here renders the typed value as it is typed — while the monospace field
 * pins its placeholder back to interface text (a normal UI string, not a
 * font sample). */
function FontPicker({
  label,
  description,
  placeholder,
  value,
  inputClassName,
  onChange
}: {
  label: string
  description: string
  placeholder: string
  value: string
  inputClassName: string
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
          input: `text-xs ${inputClassName}`
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
  const [sidebarGlass, setSidebarGlass] = useSidebarGlass()
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
        <FontPicker
          label={t('settings.uiFont')}
          description={t('settings.uiFontDesc')}
          placeholder={t('settings.fontDefault')}
          value={fonts.ui}
          inputClassName="font-sans"
          onChange={(ui) => setFonts({ ui })}
        />
        <FontPicker
          label={t('settings.monoFont')}
          description={t('settings.monoFontDesc')}
          placeholder={t('settings.fontDefault')}
          value={fonts.mono}
          inputClassName="font-mono placeholder:font-sans"
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
                    'grid size-8 place-items-center rounded-control transition-transform hover:scale-110',
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

      <SettingsGroup title={t('settings.sidebar')}>
        <SettingsRow
          label={t('settings.sidebarGlass')}
          description={t('settings.sidebarGlassDesc')}
        >
          <Checkbox
            mark="square"
            checked={sidebarGlass}
            onCheckedChange={setSidebarGlass}
            aria-label={t('settings.sidebarGlass')}
          />
        </SettingsRow>
      </SettingsGroup>
    </div>
  )
}
