import { useSyncExternalStore } from 'react'

/**
 * Interface style — Settings → Appearance. ONE global preference that drives
 * two dimensions so they can never disagree: the corner/radius preset
 * (`data-corners`) and the icon pack (`data-icon-pack`).
 *
 * The squircle values are recovered from 397f6ed^ (the parent of the commit
 * that squared the branch); the square style is the default and the two token
 * values that matter read `--app-radius-capsule: 0px`, which is what every
 * capsule-by-design site rendered before the token existed.
 *
 * A renderer preference like accent/locale/typefaces: localStorage plus a
 * subscribable store, so choosing it in Settings re-renders the interface with
 * no session involvement and no reload. No boot hook is needed in main.tsx —
 * the first read resolves the stored value and App applies it in a layout
 * effect so the first paint is already correct.
 */

const STORAGE_KEY = 'pi-app:ui-style'
export const UI_STYLES = ['square', 'squircle'] as const
export type UiStyle = (typeof UI_STYLES)[number]
export type IconPack = 'remix' | 'hugeicons'
const DEFAULT: UiStyle = 'square'

function isStyle(value: string | null): value is UiStyle {
  return value === 'square' || value === 'squircle'
}

/** The icon pack is derived, never stored: one preference, two dimensions. */
export function iconPackOf(style: UiStyle): IconPack {
  return style === 'squircle' ? 'hugeicons' : 'remix'
}

/** Write both derived attributes. Idempotent; safe to call on every change. */
export function applyUiStyle(style: UiStyle): void {
  const root = document.documentElement
  root.dataset.corners = style
  root.dataset.iconPack = iconPackOf(style)
}

function read(): UiStyle {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY)
    return isStyle(stored) ? stored : DEFAULT
  } catch {
    return DEFAULT
  }
}

let current: UiStyle = DEFAULT
/** Lazily initialized on first read so module import never touches storage. */
let initialized = false

const listeners = new Set<() => void>()

function get(): UiStyle {
  if (!initialized) {
    current = read()
    initialized = true
  }
  return current
}

function set(next: UiStyle): void {
  if (get() === next) return
  current = next
  try {
    window.localStorage.setItem(STORAGE_KEY, next)
  } catch {
    /* persistence is best-effort; the in-memory value still applies */
  }
  for (const listener of listeners) listener()
}

/** Subscribable interface-style preference shared by the app shell and Settings. */
export function useUiStyle(): [UiStyle, (next: UiStyle) => void] {
  const style = useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    get
  )
  return [style, set]
}
