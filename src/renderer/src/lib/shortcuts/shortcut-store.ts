/**
 * Shortcut bindings snapshot: defaults overlaid with the user's overrides and
 * disabled flags, persisted to localStorage as one versioned document. The
 * dispatcher reads the same snapshot synchronously (no React in the key
 * path); components subscribe through `useShortcutBindings`.
 */
import {
  SHORTCUT_STORAGE_KEY,
  parseDisabledShortcuts,
  parseShortcutOverrides,
  resolveShortcutBindings,
  type DisabledShortcuts,
  type ShortcutBindings,
  type ShortcutOverrides
} from './keyboard-shortcuts'

export interface ShortcutSnapshot {
  mac: boolean
  overrides: ShortcutOverrides
  disabled: DisabledShortcuts
  bindings: ShortcutBindings
  storageError: boolean
}

const listeners = new Set<() => void>()
let snapshot: ShortcutSnapshot | null = null

export function getShortcutSnapshot(): ShortcutSnapshot {
  if (snapshot) return snapshot
  const mac = /Mac|iPhone|iPad|iPod/.test(window.navigator.platform)
  let overrides: ShortcutOverrides = {}
  let disabled: DisabledShortcuts = {}
  let storageError = false
  try {
    const raw = window.localStorage.getItem(SHORTCUT_STORAGE_KEY)
    overrides = parseShortcutOverrides(raw, mac)
    disabled = parseDisabledShortcuts(raw)
  } catch {
    storageError = true
  }
  snapshot = { mac, overrides, disabled, bindings: resolveShortcutBindings(overrides, mac), storageError }
  return snapshot
}

function onStorage(event: StorageEvent) {
  if (event.key !== null && event.key !== SHORTCUT_STORAGE_KEY) return
  snapshot = null
  listeners.forEach((listener) => listener())
}

export function subscribeShortcuts(listener: () => void): () => void {
  if (listeners.size === 0) window.addEventListener('storage', onStorage)
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) window.removeEventListener('storage', onStorage)
  }
}

function persist(next: { overrides: ShortcutOverrides; disabled: DisabledShortcuts }) {
  const { mac } = getShortcutSnapshot()
  // Round-trip through the parsers so a corrupt edit can never wedge the
  // dispatcher: what lands in storage is exactly what will be read back.
  const serialized = JSON.stringify({ version: 1, overrides: next.overrides, disabled: next.disabled })
  const clean = parseShortcutOverrides(serialized, mac)
  const cleanDisabled = parseDisabledShortcuts(serialized)
  let storageError = false
  try {
    window.localStorage.setItem(
      SHORTCUT_STORAGE_KEY,
      JSON.stringify({ version: 1, overrides: clean, disabled: cleanDisabled })
    )
  } catch {
    storageError = true
  }
  snapshot = { mac, overrides: clean, disabled: cleanDisabled, bindings: resolveShortcutBindings(clean, mac), storageError }
  listeners.forEach((listener) => listener())
}

export function saveShortcutOverrides(overrides: ShortcutOverrides) {
  persist({ overrides, disabled: getShortcutSnapshot().disabled })
}

export function saveShortcutDisabled(disabled: DisabledShortcuts) {
  persist({ overrides: getShortcutSnapshot().overrides, disabled })
}
