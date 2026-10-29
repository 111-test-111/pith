import { useSyncExternalStore } from 'react'
import { DEFAULT_CODE_THEMES, normalizeCodeThemes, type CodeThemes } from './code-themes'

/** Renderer appearance preference, shared with code surfaces and auxiliary windows. */
export const CODE_THEME_STORAGE_KEY = 'pi-app:code-themes'
let current: CodeThemes = { ...DEFAULT_CODE_THEMES }
let initialized = false
let watchingStorage = false
const listeners = new Set<() => void>()

function read(): CodeThemes {
  try { return normalizeCodeThemes(JSON.parse(window.localStorage.getItem(CODE_THEME_STORAGE_KEY) ?? '{}')) }
  catch { return { ...DEFAULT_CODE_THEMES } }
}

export function getCodeThemes(): CodeThemes {
  if (!initialized) { current = read(); initialized = true }
  return current
}

function publish(next: CodeThemes): void {
  const previous = getCodeThemes()
  if (next.light === previous.light && next.dark === previous.dark) return
  current = next
  for (const listener of listeners) listener()
}

export function setCodeThemes(patch: Partial<CodeThemes>): void {
  const next = normalizeCodeThemes(patch, getCodeThemes())
  try { window.localStorage.setItem(CODE_THEME_STORAGE_KEY, JSON.stringify(next)) }
  catch { /* keep the live preference when storage is unavailable */ }
  publish(next)
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  if (!watchingStorage) {
    watchingStorage = true
    window.addEventListener('storage', event => {
      if (event.storageArea === window.localStorage && (event.key === CODE_THEME_STORAGE_KEY || event.key === null)) publish(read())
    })
  }
  return () => { listeners.delete(listener) }
}

export function useCodeThemes(): [CodeThemes, typeof setCodeThemes] {
  return [useSyncExternalStore(subscribe, getCodeThemes), setCodeThemes]
}
