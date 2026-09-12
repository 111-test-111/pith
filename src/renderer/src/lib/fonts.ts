import { useSyncExternalStore } from 'react'

/**
 * Typeface preference for the whole app.
 *
 * The interface is either the system sans-serif or a serif stack (`ui`), and
 * code uses a monospace family the user types in (`mono`) — left empty it is
 * the platform default. Both are applied as CSS variables that `styles.css`
 * maps onto Tailwind's `font-sans`/`font-mono` tokens, so every consumer —
 * vendored beUI components included — follows along without per-element
 * changes. A renderer preference like locale/accent: stored in localStorage
 * and applied before first paint.
 */
export type UIFont = 'sans' | 'serif'

export interface FontSettings {
  /** Interface text: system sans-serif, or a serif stack. */
  ui: UIFont
  /** Monospace family (or full family list) for code; empty = system default. */
  mono: string
}

const UI_STACKS: Record<UIFont, string> = {
  sans: "ui-sans-serif, system-ui, -apple-system, 'SF Pro Text', 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
  // Georgia/Times cover Latin, the CJK faces cover Chinese — fallback is
  // per-glyph, so a mixed-script UI renders serif in both.
  serif:
    "ui-serif, Georgia, Cambria, 'Songti SC', 'Noto Serif CJK SC', 'SimSun', 'Times New Roman', Times, serif"
}

const MONO_STACK =
  "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace"
const DEFAULT_SETTINGS: FontSettings = { ui: 'sans', mono: '' }

const STORAGE_KEY = 'pi-app:fonts'

/** A family name can hold anything the user types; drop the characters that
 * would break out of the single CSS declaration the value is written into
 * (`setProperty` would otherwise reject the whole value). */
function sanitizeMono(value: string): string {
  return value.replace(/[;{}\n\r\\]/g, ' ').trim()
}

/** The CSS stack the monospace setting resolves to. The typed family comes
 * first, then the platform mono faces, and — because most monospace faces only
 * carry Latin — the interface stack last: glyphs the code font lacks (CJK in a
 * comment, say) fall back to the interface face, so they follow the
 * sans/serif choice instead of whatever the browser would pick on its own. */
function resolveMonoFont(family: string, ui: UIFont): string {
  const custom = sanitizeMono(family)
  const mono = custom ? `${custom}, ${MONO_STACK}` : MONO_STACK
  return `${mono}, ${UI_STACKS[ui]}`
}

function read(): FontSettings {
  try {
    const raw = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}')
    return {
      ui: raw?.ui === 'serif' ? 'serif' : 'sans',
      mono: typeof raw?.mono === 'string' ? raw.mono : ''
    }
  } catch {
    return DEFAULT_SETTINGS
  }
}

function apply(settings: FontSettings): void {
  const root = document.documentElement
  root.style.setProperty('--app-font-ui', UI_STACKS[settings.ui])
  root.style.setProperty('--app-font-mono', resolveMonoFont(settings.mono, settings.ui))
}

let current: FontSettings = DEFAULT_SETTINGS
/** Lazily initialized on first read so module import never touches storage. */
let initialized = false

const listeners = new Set<() => void>()

function get(): FontSettings {
  if (!initialized) {
    current = read()
    initialized = true
  }
  return current
}

function set(patch: Partial<FontSettings>): void {
  current = { ...get(), ...patch }
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(current))
  } catch {
    /* persistence is best-effort; the in-memory value still applies */
  }
  apply(current)
  for (const listener of listeners) listener()
}

/** Applies the stored typefaces. Called from `main.tsx` before the first paint
 * so the app never flashes the fallback font. */
export function initFonts(): void {
  apply(get())
}

/** Subscribable typeface preference shared by the Settings section and boot. */
export function useFontSettings(): [FontSettings, (patch: Partial<FontSettings>) => void] {
  const settings = useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    get
  )
  return [settings, (patch) => set(patch)]
}
