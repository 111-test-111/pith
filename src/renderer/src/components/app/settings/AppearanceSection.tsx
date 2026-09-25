import { useEffect, useState } from 'react'
import { useTheme } from 'next-themes'
import { RadioGroup, RadioGroupItem } from '@/components/motion/radio'
import { Input } from '@/components/motion/input'
import { Checkbox } from '@/components/motion/checkbox'
import { Tooltip } from '@/components/motion/tooltip'
import { useFontSettings } from '@/lib/fonts'
import { useSidebarGlass } from '@/lib/sidebar-glass'
import { setReduceMotion, useReduceMotion } from '@/lib/reduce-motion'
import { setCompactTools, useCompactTools } from '@/lib/compact-tools'
import { useI18n, LOCALE_NAMES, type Locale } from '@/i18n'
import { ACCENT_PRESETS, CUSTOM_ACCENT, useCustomAccent } from '@/lib/accent'
import type { UiStyle } from '@/lib/ui-style'
import { AccentColorPicker } from './AccentColorPicker'
import { SettingsGroup, SettingsRow } from './SettingsRow'

/** Interface style: the corner/radius preset and the icon pack that matches it.
 * They are one choice on purpose — the two dimensions can never disagree. */
export const UI_STYLE_OPTIONS = [
  { id: 'square', labelKey: 'settings.uiStyleSquare' },
  { id: 'squircle', labelKey: 'settings.uiStyleSquircle' }
] as const

/** Free-text family field, shared by the three typefaces; empty leaves the app
 * on its default (the sans-serif tail for the interface, the platform mono for
 * code, the bundled Latin Modern Math for formulas). The field previews the
 * family it edits — `--app-font-ui`/`--app-font-mono`/`--app-font-math` carry
 * the typed name first, so `font-sans`/`font-mono`/`font-math` here renders
 * the typed value as it is typed — while the monospace and math fields pin
 * their placeholders back to interface text (a normal UI string, not a font
 * sample). */
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
  onAccentChange,
  uiStyle,
  onUiStyleChange
}: {
  accent: string
  onAccentChange: (accent: string) => void
  uiStyle: UiStyle
  onUiStyleChange: (style: UiStyle) => void
}) {
  const { t, locale, setLocale } = useI18n()
  const { theme, setTheme } = useTheme()
  const [fonts, setFonts] = useFontSettings()
  const [customAccent, setCustomAccent] = useCustomAccent()
  const [sidebarGlass, setSidebarGlass] = useSidebarGlass()
  const reduceMotion = useReduceMotion()
  const compactTools = useCompactTools()
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

      <SettingsGroup title={t('settings.uiStyle')} description={t('settings.uiStyleDesc')}>
        <div className="px-4 py-3.5">
          <RadioGroup
            orientation="horizontal"
            value={uiStyle}
            onValueChange={(next) => onUiStyleChange(next as UiStyle)}
            className="gap-6"
          >
            {UI_STYLE_OPTIONS.map((option) => (
              <RadioGroupItem key={option.id} value={option.id} label={t(option.labelKey)} />
            ))}
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
        <FontPicker
          label={t('settings.mathFont')}
          description={t('settings.mathFontDesc')}
          placeholder={t('settings.fontDefault')}
          value={fonts.math}
          inputClassName="font-math placeholder:font-sans"
          onChange={(math) => setFonts({ math })}
        />
      </SettingsGroup>

      <SettingsGroup title={t('settings.accent')} description={t('settings.accentDesc')}>
        <div className="px-4 py-3.5">
          <div className="flex flex-wrap gap-2.5">
            {ACCENT_PRESETS.map((preset) => (
              <Tooltip key={preset.id} content={t('settings.accentAria', { id: preset.id })}>
                {/* Compact color samples sit beside the other controls; the last
                 * well is the custom color, picked through the native color input. */}
                <button
                  type="button"
                  aria-label={t('settings.accentAria', { id: preset.id })}
                  aria-pressed={accent === preset.id}
                  onClick={() => onAccentChange(preset.id)}
                  className="grid size-6 place-items-center rounded-capsule transition-[filter] hover:brightness-110"
                  style={{ background: preset.color }}
                >
                  {accent === preset.id ? <span className="size-2 rounded-full bg-white/90" /> : null}
                </button>
              </Tooltip>
            ))}
            {/* The custom well sits apart from the presets behind a hairline. */}
            <span aria-hidden="true" className="w-px self-stretch bg-border" />
            {/* Picking is a draft until confirmed inside the picker's popover —
             * only then does the accent change. */}
            <AccentColorPicker
              color={customAccent}
              active={accent === CUSTOM_ACCENT}
              onApply={(hex) => {
                setCustomAccent(hex)
                onAccentChange(CUSTOM_ACCENT)
              }}
            />
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

      <SettingsGroup title={t('settings.motion')}>
        <SettingsRow
          label={t('settings.reduceMotion')}
          description={t('settings.reduceMotionDesc')}
        >
          <Checkbox
            mark="square"
            checked={reduceMotion}
            onCheckedChange={setReduceMotion}
            aria-label={t('settings.reduceMotion')}
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title={t('settings.transcript')}>
        <SettingsRow
          label={t('settings.compactTools')}
          description={t('settings.compactToolsDesc')}
        >
          <Checkbox
            mark="square"
            checked={compactTools}
            onCheckedChange={setCompactTools}
            aria-label={t('settings.compactTools')}
          />
        </SettingsRow>
      </SettingsGroup>
    </div>
  )
}
