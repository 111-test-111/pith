import { AgentCode } from '@/components/agents/agent-code'
import { Button } from '@/components/motion/button'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/motion/select'
import { useI18n } from '@/i18n'
import { useCodeThemes } from '@/lib/code-theme-settings'
import { CODE_THEME_OPTIONS, DEFAULT_CODE_THEMES } from '@/lib/code-themes'
import { SettingsGroup, SettingsRow } from './SettingsRow'
import { FadeScroll } from '../FadeScroll'

export function CodeThemesGroup() {
  const { t } = useI18n()
  const [themes, setThemes] = useCodeThemes()
  const isDefault = themes.light === DEFAULT_CODE_THEMES.light && themes.dark === DEFAULT_CODE_THEMES.dark
  const sample = `// ${t('settings.codeThemePreviewComment')}\nconst files = ["app.ts"]\nconst count: number = 42\n\nexport function total() {\n  return files.length + count\n}`

  return (
    <SettingsGroup title={t('settings.codeThemes')} description={t('settings.codeThemesDesc')}>
      {(['light', 'dark'] as const).map(mode => {
        const label = t(mode === 'light' ? 'settings.codeThemeLight' : 'settings.codeThemeDark')
        return (
          <SettingsRow key={mode} label={label} className="flex-wrap">
            <div data-code-theme-mode={mode} className="w-72 max-w-full">
              <Select value={themes[mode]} onValueChange={value => setThemes({ [mode]: value })}>
                <SelectTrigger aria-label={label} className="h-9 rounded-control px-3 text-sm">
                  <span className="min-w-0 truncate">{CODE_THEME_OPTIONS.find(theme => theme.id === themes[mode])?.displayName}</span>
                </SelectTrigger>
                <SelectContent portal portalAlign="end">
                  <FadeScroll className="max-h-64 px-0.5">
                    <ul>
                      {CODE_THEME_OPTIONS.filter(theme => theme.type === mode).map(theme => (
                        <SelectItem key={theme.id} value={theme.id} className="text-sm">
                          {theme.displayName}
                        </SelectItem>
                      ))}
                    </ul>
                  </FadeScroll>
                </SelectContent>
              </Select>
            </div>
          </SettingsRow>
        )
      })}
      <div className="px-4 py-3">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-medium text-foreground">{t('settings.codeThemePreview')}</p>
          <Button variant="ghost" size="sm" disabled={isDefault} onClick={() => setThemes(DEFAULT_CODE_THEMES)} data-code-theme-reset className="h-7 text-xs">
            {t('settings.codeThemeReset')}
          </Button>
        </div>
        <div className="grid grid-cols-2 gap-3">
          {(['light', 'dark'] as const).map(mode => (
            <figure key={mode} data-code-theme-preview={mode} className="min-w-0 rounded-detail border border-border bg-background p-3 text-foreground">
              <figcaption className="mb-2 text-xs font-medium text-muted-foreground">{t(mode === 'light' ? 'settings.light' : 'settings.dark')}</figcaption>
              <AgentCode code={sample} language="typescript" />
            </figure>
          ))}
        </div>
      </div>
    </SettingsGroup>
  )
}
