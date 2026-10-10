import { bundledThemesInfo } from 'shiki/themes'
import type { BundledTheme } from 'shiki'

export type CodeThemeMode = 'light' | 'dark'
export interface CodeThemes {
  light: BundledTheme
  dark: BundledTheme
}

/** Shiki owns the names and mode metadata; only selected themes load at runtime. */
export const CODE_THEME_OPTIONS = bundledThemesInfo
export const DEFAULT_CODE_THEMES: Readonly<CodeThemes> = {
  light: 'github-light-high-contrast',
  dark: 'github-dark-high-contrast'
}
const modes = new Map(CODE_THEME_OPTIONS.map(theme => [theme.id, theme.type]))

export function normalizeCodeThemes(raw: unknown, fallback: Readonly<CodeThemes> = DEFAULT_CODE_THEMES): CodeThemes {
  const input = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const next = { ...fallback }
  for (const mode of ['light', 'dark'] as const) {
    const value = input[mode]
    if (typeof value === 'string' && modes.get(value as BundledTheme) === mode) next[mode] = value as BundledTheme
  }
  return next
}

/** A cached/in-flight result belongs to its entire theme pair, even in light mode. */
export function codeThemeKey(themes: Readonly<CodeThemes>): string {
  return `${themes.light}\0${themes.dark}`
}

export function codeTokenCacheKey(code: string, language: string, themes: Readonly<CodeThemes>): string {
  return `${codeThemeKey(themes)}\0${language}\0${code}`
}
