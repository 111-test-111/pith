import { useSyncExternalStore } from 'react'

/**
 * Translucent (frosted-glass) title row and session sidebar — Settings → Appearance.
 *
 * When on, both regions become real glass: on macOS the window itself is
 * a vibrancy surface (window-chrome.ts) and the page background steps aside,
 * so windows behind the app show through; a theme-gradient wash tints whatever
 * comes through (the `backdrop` slot Workspace passes to `AnimatedSidebar`,
 * styled by the `.window-glass-wash` rule in `styles.css`), and a light
 * translucent veil keeps the list readable. On platforms without a vibrancy
 * surface the same layers sit over the app's own background and read as a
 * soft tinted column. When off, the panel is the plain opaque
 * `bg-background` column and the wash is not mounted at all.
 *
 * A renderer preference like locale/accent/typefaces: localStorage plus a
 * subscribable store, so flipping it in Settings re-renders the sidebar with
 * no session involvement. The workspace sidebar and every WindowTitlebar
 * consume it; their first render reads the stored value, so no boot hook is
 * needed in `main.tsx`. Keep the existing storage key. Default: on.
 */

const STORAGE_KEY = 'pi-app:sidebar-glass'
const DEFAULT = true

function read(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) !== 'off'
  } catch {
    return DEFAULT
  }
}

let current = DEFAULT
/** Lazily initialized on first read so module import never touches storage. */
let initialized = false

const listeners = new Set<() => void>()

function get(): boolean {
  if (!initialized) {
    current = read()
    initialized = true
  }
  return current
}

function set(next: boolean): void {
  if (get() === next) return
  current = next
  try {
    window.localStorage.setItem(STORAGE_KEY, next ? 'on' : 'off')
  } catch {
    /* persistence is best-effort; the in-memory value still applies */
  }
  for (const listener of listeners) listener()
}

/** Subscribable glass preference shared by the workspace sidebar and Settings. */
export function useSidebarGlass(): [boolean, (next: boolean) => void] {
  const enabled = useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    get
  )
  return [enabled, set]
}
