import { useSyncExternalStore } from 'react'

const STORAGE_KEY = 'pi-app:diff-style'
type DiffStyle = 'detailed' | 'simple'
let style: DiffStyle | undefined
let watchingStorage = false
const listeners = new Set<() => void>()

function readStyle(): DiffStyle {
  try { return window.localStorage.getItem(STORAGE_KEY) === 'simple' ? 'simple' : 'detailed' }
  catch { return 'detailed' }
}

function getStyle(): DiffStyle {
  return style ??= readStyle()
}

function publish(next: DiffStyle): void {
  if (next === getStyle()) return
  style = next
  for (const listener of listeners) listener()
}

export function setDiffStyle(value: string): void {
  if (value !== 'detailed' && value !== 'simple') return
  try { window.localStorage.setItem(STORAGE_KEY, value) }
  catch { /* The preference still applies to this window. */ }
  publish(value)
}

function onStorage(event: StorageEvent): void {
  if (event.storageArea === window.localStorage && (event.key === STORAGE_KEY || event.key === null)) publish(readStyle())
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  if (!watchingStorage) {
    watchingStorage = true
    window.addEventListener('storage', onStorage)
  }
  return () => { listeners.delete(listener) }
}

/** A renderer appearance preference, shared by every diff surface. */
export function useDiffStyle(): DiffStyle {
  return useSyncExternalStore(subscribe, getStyle)
}
