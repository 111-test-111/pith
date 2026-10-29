import { MotionGlobalConfig } from 'motion/react'
import { useSyncExternalStore } from 'react'

/**
 * reduced motion — Settings → Appearance, persisted as `pi-app:reduce-motion`
 * (default off, so the app behaves exactly as it did before).
 *
 * One switch makes every interface animation land instantly. That takes two
 * independent layers, because the app animates in two independent ways:
 *
 * - `MotionGlobalConfig.skipAnimations` is motion's own global kill switch. It
 *   is read when each animation is CREATED (see `motion-dom`'s `motion-value`),
 *   so flipping the preference applies immediately to everything already on
 *   screen — no remount, no `key`. `<MotionConfig skipAnimations>` cannot do
 *   that: its value is copied into each `VisualElement` at construction, so it
 *   would only reach components mounted afterwards.
 * - `html[data-reduce-motion='true']` (see `styles.css`) takes the CSS side:
 *   hover transitions and the few CSS keyframes the app still carries
 *   (`beui-text-shimmer`, the theme View Transition).
 *
 * Two deliberate boundaries:
 *
 * - A running-state indicator is the ONE exception — `animate-spin` (every busy
 *   glyph in the app and in vendored beUI), `animate-pulse` (the dither's
 *   particles, see `components/motion/loader.tsx`) and `beui-text-shimmer` (the
 *   waiting row's sentence) stay animated, and
 *   `components/app/RunningLoader.tsx` keeps the vendored motion `Loader`'s
 *   rotation moving through the same utility. "Still running" has to be visible.
 * - This is NOT a `matchMedia` shim for `prefers-reduced-motion`. The OS
 *   preference is a separate signal with consumers that must keep following it:
 *   beUI's own `useReducedMotion()` branches (which drop a spinner's rotation
 *   rather than freeze it) and Tailwind's `motion-safe:` variants. This
 *   preference is the app's own, stronger switch, and it composes with them.
 */

const STORAGE_KEY = 'pi-app:reduce-motion'
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
 * Push the preference to both layers. Must run outside React's render phase:
 * `main.tsx` calls it once before the first render (so the first paint is
 * already animation-free) and `setReduceMotion` calls it on every flip.
 */
export function applyReduceMotion(enabled: boolean): void {
  document.documentElement.dataset.reduceMotion = enabled ? 'true' : 'false'
  MotionGlobalConfig.skipAnimations = enabled
}

/** Boot hook: read the stored preference and apply it before the first render. */
export function initReduceMotion(): void {
  applyReduceMotion(get())
}

export function setReduceMotion(next: boolean): void {
  if (get() === next) return
  current = next
  try {
    window.localStorage.setItem(STORAGE_KEY, next ? 'on' : 'off')
  } catch {
    /* persistence is best-effort; the in-memory value still applies */
  }
  applyReduceMotion(next)
  for (const listener of listeners) listener()
}

/** The app's motion preference. Read-only here — Settings owns the writer. */
export function useReduceMotion(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    get
  )
}

let systemMotionQuery: MediaQueryList | undefined

function getSystemMotionQuery(): MediaQueryList {
  return systemMotionQuery ??= window.matchMedia('(prefers-reduced-motion: reduce)')
}

function subscribeSystemMotion(listener: () => void): () => void {
  const query = getSystemMotionQuery()
  query.addEventListener('change', listener)
  return () => query.removeEventListener('change', listener)
}

/** Live native OS signal. Motion's useReducedMotion captures only mount state. */
export function useSystemReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeSystemMotion,
    () => getSystemMotionQuery().matches,
    () => false
  )
}

/**
 * Tailwind class that keeps a rotation-based running indicator moving while the
 * switch is on — Tailwind's own keyframes, so the app keeps owning none of its
 * own. The dither grids need nothing from here: their particles move
 * themselves (`components/motion/loader.tsx`).
 */
export function useRunningMotionClass(): string {
  return useReduceMotion() ? 'animate-spin' : ''
}
