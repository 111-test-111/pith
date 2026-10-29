import { useSyncExternalStore } from 'react'

/**
 * Interface style — Settings → Appearance. ONE global preference that drives
 * the corner/radius preset (`data-corners`) and UI glyphs through icons.tsx.
 * Square uses Remix Line and Bearded file types; squircle uses Hugeicons Stroke
 * Rounded and Pierre file types. Keyboard marks and brands keep their artwork.
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
const DEFAULT: UiStyle = 'square'

function isStyle(value: string | null): value is UiStyle {
  return value === 'square' || value === 'squircle'
}

/** Write the derived corner attribute. Idempotent; safe to call on every change. */
export function applyUiStyle(style: UiStyle): void {
  document.documentElement.dataset.corners = style
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

/**
 * Apply a style: store, persistence, the derived DOM attribute, listeners.
 * Exported as a plain function (not only through the hook) so a consumer that
 * renders the components without mounting `App` — the geometry check fixture,
 * for one — can drive BOTH the store and `<html>` from one call. Writing the
 * DOM here as well keeps the store and the tokens from ever disagreeing.
 */
export function setUiStyle(next: UiStyle): void {
  if (get() === next) return
  current = next
  try {
    window.localStorage.setItem(STORAGE_KEY, next)
  } catch {
    /* persistence is best-effort; the in-memory value still applies */
  }
  applyUiStyle(next)
  for (const listener of listeners) listener()
}

/** Subscribable interface-style preference shared by the app shell and Settings. */
export function useUiStyle(): [UiStyle, typeof setUiStyle] {
  const style = useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    get
  )
  return [style, setUiStyle]
}
