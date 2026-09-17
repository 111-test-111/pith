import { useSyncExternalStore } from 'react'

/**
 * Translucent (frosted-glass) session sidebar — Settings → Appearance.
 *
 * When on, the sidebar panel's surface goes translucent with a backdrop blur,
 * and a static accent-tinted wash is painted behind it (the `backdrop` slot
 * Workspace passes to `AnimatedSidebar`, styled by the `.sidebar-glass-wash`
 * rule in `styles.css`), so the column reads as glass over a soft glow instead
 * of a flat opaque slab. When off, the panel is the plain opaque
 * `bg-background` column and the wash is not mounted at all.
 *
 * A renderer preference like locale/accent/typefaces: localStorage plus a
 * subscribable store, so flipping it in Settings re-renders the sidebar with
 * no session involvement. Only the workspace sidebar consumes it, and its
 * first render already reads the stored value, so there is no boot hook to
 * call from `main.tsx`. Default: on.
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
