import { useSyncExternalStore } from 'react'

/**
 * compact tool-call display — Settings → Appearance, persisted as
 * `pi-app:compact-tools` (default off, so the transcript keeps the uniform row
 * rhythm it has always had).
 *
 * The switch changes the transcript's shared positive gap from 24px to 4px.
 * Text output keeps 24px on both sides. The turn fold's body and the persistent
 * waiting row also keep 24px above; other groups and bodies use the ordinary gap. See styles.css and transcript-rhythm.ts.
 *
 * A renderer preference like `show-reasoning`: stored in localStorage and read
 * through a subscribable store, so the Settings checkbox follows it at once.
 * The attribute is applied outside React (`main.tsx` applies it before the
 * first render), because no component needs to re-render for the CSS to land.
 */
const STORAGE_KEY = 'pi-app:compact-tools'
const DEFAULT = false

function read(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === 'on'
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

/**
 * Push the preference onto `<html>`. Must run outside React's render phase:
 * `main.tsx` calls it once before the first render and `setCompactTools` calls
 * it on every flip.
 */
export function applyCompactTools(enabled: boolean): void {
  document.documentElement.dataset.compactTools = enabled ? 'true' : 'false'
}

/** Boot hook: read the stored preference and apply it before the first render. */
export function initCompactTools(): void {
  applyCompactTools(get())
}

export function setCompactTools(next: boolean): void {
  if (get() === next) return
  current = next
  try {
    window.localStorage.setItem(STORAGE_KEY, next ? 'on' : 'off')
  } catch {
    /* persistence is best-effort; the in-memory value still applies */
  }
  applyCompactTools(next)
  for (const listener of listeners) listener()
}

/** The transcript-density preference. Read-only here — Settings owns the writer. */
export function useCompactTools(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    get
  )
}
