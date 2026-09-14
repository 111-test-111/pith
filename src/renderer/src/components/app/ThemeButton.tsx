import { Monitor, Moon, Sun } from '@/lib/icons'
import { useTheme } from 'next-themes'
import { ActionSwapIcon } from '@/components/motion/action-swap'
import { Button } from '@/components/motion/button'
import { useThemeReveal } from '@/components/motion/theme-toggle'
import { useI18n } from '@/i18n'

const CYCLE = ['light', 'dark', 'system'] as const
type ThemeMode = (typeof CYCLE)[number]

const MODE_KEY: Record<ThemeMode, 'settings.light' | 'settings.dark' | 'settings.system'> = {
  light: 'settings.light',
  dark: 'settings.dark',
  system: 'settings.system'
}

/** Header theme button, styled to match the sibling settings button. Cycles
 * light → dark → system (same modes as Settings → Appearance) with the beUI
 * view-transition reveal; the icon mirrors the active mode. */
export function ThemeButton() {
  const { t } = useI18n()
  const { theme, setTheme } = useTheme()
  const reveal = useThemeReveal({ start: 'top-right' })

  // Before next-themes resolves the stored value, mirror the provider default.
  const mode: ThemeMode = theme === 'light' || theme === 'dark' ? theme : 'system'
  const next = CYCLE[(CYCLE.indexOf(mode) + 1) % CYCLE.length]
  const label = t('workspace.themeLabel', { mode: t(MODE_KEY[mode]) })

  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={label}
      onClick={() => reveal(() => setTheme(next))}
    >
      <ActionSwapIcon value={mode} animation="blur" className="size-4">
        {mode === 'light' ? (
          <Sun className="size-4" />
        ) : mode === 'dark' ? (
          <Moon className="size-4" />
        ) : (
          <Monitor className="size-4" />
        )}
      </ActionSwapIcon>
    </Button>
  )
}
