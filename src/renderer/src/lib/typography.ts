import { useSyncExternalStore } from 'react'

/** Renderer appearance preferences, like fonts and accent. Geometry keeps its
 * 16px rem: these bases change text and its line boxes, never window zoom. */
export interface FontSizeSettings {
  ui: number
  content: number
  code: number
}

export const DEFAULT_FONT_SIZES: Readonly<FontSizeSettings> = { ui: 14, content: 14, code: 12 }
export const FONT_SIZE_LIMITS = {
  ui: { min: 12, max: 20 },
  content: { min: 12, max: 24 },
  code: { min: 10, max: 24 }
} as const
export const FONT_SIZE_STORAGE_KEY = 'pi-app:font-sizes'

const keys = ['ui', 'content', 'code'] as const

export function normalizeFontSizes(raw: unknown, fallback: Readonly<FontSizeSettings> = DEFAULT_FONT_SIZES): FontSizeSettings {
  const input = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const next = { ...fallback }
  for (const key of keys) {
    const value = input[key]
    const { min, max } = FONT_SIZE_LIMITS[key]
    if (typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max) next[key] = value
  }
  return next
}

export function codeLineHeight(size: number): number { return Math.round(size * 20 / 12) }
export function contentLineHeight(size: number): number { return Math.round(size * 24 / 14) }
export function compactContentSize(size: number): number { return Math.max(10, Math.round(size * 12 / 14)) }
export function terminalFontSize(size: number): number { return size + 2 }

function read(): FontSizeSettings {
  try { return normalizeFontSizes(JSON.parse(window.localStorage.getItem(FONT_SIZE_STORAGE_KEY) ?? '{}')) }
  catch { return { ...DEFAULT_FONT_SIZES } }
}

function apply(sizes: FontSizeSettings): void {
  const root = document.documentElement
  const scaleUI = (base: number) => Math.max(10, Math.round(base * sizes.ui / 14))
  for (const [role, base] of Object.entries({ micro: 10, caption: 11, keycap: 14, xs: 12, sm: 14, base: 16, lg: 18, xl: 20, '2xl': 24 })) {
    root.style.setProperty(`--app-text-ui-${role}`, `${scaleUI(base)}px`)
  }
  const properties = {
    '--app-text-content': sizes.content,
    '--app-text-content-small': compactContentSize(sizes.content),
    '--app-text-content-heading': Math.round(sizes.content * 16 / 14),
    '--app-text-code': sizes.code,
    '--app-text-terminal': terminalFontSize(sizes.code),
    '--app-line-ui': Math.round(sizes.ui * 20 / 14),
    '--app-line-content': contentLineHeight(sizes.content),
    '--app-line-content-tight': Math.round(sizes.content * 20 / 14),
    '--app-line-code': codeLineHeight(sizes.code)
  }
  for (const [name, value] of Object.entries(properties)) root.style.setProperty(name, `${value}px`)
}

let current: FontSizeSettings = { ...DEFAULT_FONT_SIZES }
let initialized = false
let watchingStorage = false
const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) }

export function getFontSizes(): FontSizeSettings {
  if (!initialized) { current = read(); initialized = true }
  return current
}

function publish(next: FontSizeSettings): void {
  const previous = getFontSizes()
  if (keys.every(key => next[key] === previous[key])) return
  current = next
  apply(current)
  for (const listener of listeners) listener()
}

export function setFontSizes(patch: Partial<FontSizeSettings>): void {
  const next = normalizeFontSizes(patch, getFontSizes())
  try { window.localStorage.setItem(FONT_SIZE_STORAGE_KEY, JSON.stringify(next)) }
  catch { /* keep the live preference when storage is unavailable */ }
  publish(next)
}

/** Boot and auxiliary windows apply the stored scale before their first paint. */
export function initFontSizes(): void {
  apply(getFontSizes())
  if (watchingStorage) return
  watchingStorage = true
  window.addEventListener('storage', event => {
    if (event.storageArea === window.localStorage && (event.key === FONT_SIZE_STORAGE_KEY || event.key === null)) publish(read())
  })
}

export function useFontSizes(): [FontSizeSettings, typeof setFontSizes] {
  return [useSyncExternalStore(subscribe, getFontSizes), setFontSizes]
}

const getCodeSize = () => getFontSizes().code
const getContentSize = () => getFontSizes().content
export function useCodeFontSize(): number { return useSyncExternalStore(subscribe, getCodeSize) }
export function useContentFontSize(): number { return useSyncExternalStore(subscribe, getContentSize) }
