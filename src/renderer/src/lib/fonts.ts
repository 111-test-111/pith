import { useSyncExternalStore } from 'react'

/**
 * Typeface preferences for the whole app: interface, code and math.
 *
 * All three are free text: the user types a family (or a whole family
 * list) and it is written at the head of the stack. Anything the machine has
 * installed applies immediately, and anything it does not simply falls through
 * to the next family — CSS resolves that per glyph, which is what keeps a
 * mixed-script UI whole.
 *
 * Each stack's own tail is its default, so an empty field and an unknown
 * family land in the same place. A value the CSS parser itself rejects drops
 * straight to that tail as well, instead of being written into a declaration
 * that would be invalid at computed-value time (which does not fall back — it
 * discards the whole `font-family`).
 *
 * The text stacks are applied as CSS variables that `styles.css` maps onto
 * Tailwind's `font-sans`/`font-mono` tokens, so every consumer — vendored
 * beUI components included — follows along without per-element changes. The
 * math stack feeds `lib/math.css`, which styles every MathML formula. A
 * renderer preference like locale/accent: stored in localStorage and applied
 * before first paint.
 */
export interface FontSettings {
  /** Interface family (or full family list); empty = the system sans-serif. */
  ui: string
  /** Monospace family (or full family list) for code; empty = system default. */
  mono: string
  /** Math family (or full family list) for formulas; empty = the bundled face. */
  math: string
}

/** The interface tail: the default, and what an unknown or rejected family
 * falls back to. It leads with the platform's own UI face (`ui-sans-serif`/
 * `system-ui`), which already carries the CJK glyphs the named Latin families
 * below it lack — fallback is per-glyph, so a mixed-script UI stays whole. */
const UI_FALLBACK =
  "ui-sans-serif, system-ui, -apple-system, 'SF Pro Text', 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif"

const MONO_STACK =
  "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace"

/** The math tail: the bundled TeX Gyre DejaVu Math face (registered as
 * `Pith Math` in `lib/math.css`), then the platform's generic math face.
 * Unlike the text tails this one must carry an OpenType MATH table — MathML
 * layout reads radical/fence metrics from it — so a plain text family can
 * never be the default here. */
const MATH_STACK = "'Pith Math', math"

const DEFAULT_SETTINGS: FontSettings = { ui: '', mono: '', math: '' }

const STORAGE_KEY = 'pi-app:fonts'

/** A family name can hold anything the user types; drop the characters that
 * would break out of the single CSS declaration the value is written into
 * (`setProperty` accepts an unparseable token stream on a custom property, and
 * the damage only shows up later, at the consumer). Quotes go too when they are
 * unbalanced — same reason, and an unquoted multi-word family is valid CSS. */
function sanitizeFamily(value: string): string {
  let out = value.replace(/[;{}\n\r\\]/g, ' ')
  if ((out.match(/["']/g) ?? []).length % 2 === 1) out = out.replace(/["']/g, ' ')
  return out.replace(/\s+/g, ' ').trim()
}

/** Whether the engine accepts the stack as a `font-family` value. Guarded for
 * the non-DOM contexts the check scripts import this module from. */
function isUsableStack(stack: string): boolean {
  return typeof CSS === 'undefined' || typeof CSS.supports !== 'function'
    ? true
    : CSS.supports('font-family', stack)
}

/** The CSS stack the interface setting resolves to. The typed family comes
 * first, then the sans-serif tail — so an unknown family and an empty field
 * both end up on the tail. */
function resolveUIFont(family: string): string {
  const custom = sanitizeFamily(family)
  if (!custom) return UI_FALLBACK
  const stack = `${custom}, ${UI_FALLBACK}`
  return isUsableStack(stack) ? stack : UI_FALLBACK
}

/** The CSS stack the monospace setting resolves to. The typed family comes
 * first, then the platform mono faces, and — because most monospace faces only
 * carry Latin — the interface stack last: glyphs the code font lacks (CJK in a
 * comment, say) fall back to the interface face, so they follow the interface
 * setting instead of whatever the browser would pick on its own. */
function resolveMonoFont(family: string, ui: string): string {
  const custom = sanitizeFamily(family)
  const stack = custom ? `${custom}, ${MONO_STACK}` : MONO_STACK
  const mono = isUsableStack(stack) ? stack : MONO_STACK
  return `${mono}, ${resolveUIFont(ui)}`
}

/** The CSS stack the math setting resolves to: the typed family first, then
 * the bundled TeX Gyre DejaVu Math face. An empty field, an unknown family and a
 * rejected stack all land on the bundled face, so a misconfigured value can
 * never leave formulas in a font without math metrics. */
function resolveMathFont(family: string): string {
  const custom = sanitizeFamily(family)
  if (!custom) return MATH_STACK
  const stack = `${custom}, ${MATH_STACK}`
  return isUsableStack(stack) ? stack : MATH_STACK
}

function read(): FontSettings {
  try {
    const raw = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}')
    // `sans`/`serif` are the retired radio values: the interface typeface is a
    // free-form family now, and both of them mean the sans-serif tail — exactly
    // what an empty field resolves to, so they reset rather than kept as text.
    const ui = typeof raw?.ui === 'string' && raw.ui !== 'sans' && raw.ui !== 'serif' ? raw.ui : ''
    return {
      ui,
      mono: typeof raw?.mono === 'string' ? raw.mono : '',
      math: typeof raw?.math === 'string' ? raw.math : ''
    }
  } catch {
    return DEFAULT_SETTINGS
  }
}

function apply(settings: FontSettings): void {
  const root = document.documentElement
  root.style.setProperty('--app-font-ui', resolveUIFont(settings.ui))
  root.style.setProperty('--app-font-mono', resolveMonoFont(settings.mono, settings.ui))
  root.style.setProperty('--app-font-math', resolveMathFont(settings.math))
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

/** Applying a stack rewrites root CSS variables, which invalidates style and
 * layout across the whole document — including a live transcript mounted
 * behind the Settings overlay. A typing burst collapses into one trailing
 * application; persistence and subscriber state stay immediate, so the field
 * never lags the keystroke that produced it. */
const APPLY_DEBOUNCE_MS = 200

let applyTimer: ReturnType<typeof setTimeout> | null = null

function set(patch: Partial<FontSettings>): void {
  current = { ...get(), ...patch }
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(current))
  } catch {
    /* persistence is best-effort; the in-memory value still applies */
  }
  if (applyTimer !== null) clearTimeout(applyTimer)
  applyTimer = setTimeout(() => {
    applyTimer = null
    apply(current)
  }, APPLY_DEBOUNCE_MS)
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
