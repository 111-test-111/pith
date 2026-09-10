import { useEffect, useState } from 'react'
import { useTheme } from 'next-themes'
import { RadioGroup, RadioGroupItem } from '@/components/motion/radio'
import { cn } from '@/lib/utils'
import { useI18n, LOCALE_NAMES, type Locale } from '@/i18n'
import { SettingsGroup, SettingsRow } from './SettingsRow'

export const ACCENTS = [
  { id: 'indigo', color: 'oklch(0.58 0.2 275)' },
  { id: 'blue', color: 'oklch(0.58 0.18 255)' },
  { id: 'violet', color: 'oklch(0.58 0.23 300)' },
  { id: 'emerald', color: 'oklch(0.58 0.13 163)' },
  { id: 'amber', color: 'oklch(0.66 0.14 68)' },
  { id: 'rose', color: 'oklch(0.6 0.19 15)' },
  { id: 'cyan', color: 'oklch(0.6 0.12 215)' }
] as const

/** Language / theme mode / accent — everything that changes how the app looks. */
export function AppearanceSection({
  accent,
  onAccentChange
}: {
  accent: string
  onAccentChange: (accent: string) => void
}) {
  const { t, locale, setLocale } = useI18n()
  const { theme, setTheme } = useTheme()
  const [mounted, setMounted] = useState(false)

  // next-themes resolves the stored theme after mount; render the neutral
  // value first to avoid a flash of the wrong selection.
  useEffect(() => setMounted(true), [])

  return (
    <div className="space-y-5">
      <SettingsGroup title={t('settings.language')} description={t('settings.languageDesc')}>
        <div className="px-3 py-2.5">
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
        <div className="px-3 py-2.5">
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

      <SettingsGroup title={t('settings.accent')} description={t('settings.accentDesc')}>
        <div className="px-3 py-2.5">
          <div className="flex flex-wrap gap-2.5">
            {ACCENTS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                aria-label={t('settings.accentAria', { id: preset.id })}
                aria-pressed={accent === preset.id}
                title={preset.id}
                onClick={() => onAccentChange(preset.id)}
                className={cn(
                  'grid size-8 place-items-center rounded-full transition-transform hover:scale-110',
                  accent === preset.id && 'ring-2 ring-foreground/60 ring-offset-2 ring-offset-background'
                )}
                style={{ background: preset.color }}
              >
                {accent === preset.id ? <span className="size-2 rounded-full bg-white/90" /> : null}
              </button>
            ))}
          </div>
        </div>
      </SettingsGroup>
    </div>
  )
}
