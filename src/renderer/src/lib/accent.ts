import { useSyncExternalStore } from 'react'

/**
 * Accent color — Settings → Appearance. ONE global preference that retints
 * every `bg-primary`/`text-primary`/`ring` surface by swapping the `--primary`
 * / `--primary-foreground` / `--ring` tokens on <html> (`data-accent`).
 *
 * Two kinds of value share the one `pi-app:accent` slot:
 *
 * - a preset id from ACCENT_PRESETS — styles.css carries a hand-tuned
 *   light/dark token pair per id (`[data-accent='…']` blocks);
 * - CUSTOM_ACCENT ('custom') — the user picked a color through the native
 *   color well. Its hex lives in `pi-app:accent-custom`; applyAccent derives
 *   the four token values (light/dark primary + readable foregrounds) with
 *   the same recipe the presets follow and writes them as inline custom
 *   properties on <html>, which the `[data-accent='custom']` rules in
 *   styles.css map onto the tokens. Chroma is capped a notch below the pure
 *   hue and lightness is pinned into each mode's readable band, so any pick
 *   keeps filled surfaces legible instead of reproducing the raw sRGB value.
 *
 * A renderer preference like ui-style/locale/typefaces: localStorage plus a
 * subscribable store, so choosing it in Settings re-renders the interface
 * with no session involvement and no reload. App applies it in a layout
 * effect so the first paint is already correct.
 */

const ACCENT_KEY = 'pi-app:accent'
const CUSTOM_ACCENT_KEY = 'pi-app:accent-custom'
export const CUSTOM_ACCENT = 'custom'
const DEFAULT_ACCENT = 'indigo'
/** First-run fill for the custom well: the default preset's light primary. */
const DEFAULT_CUSTOM_HEX = '#4e57d1'

/** Swatch colors: the light-mode `--primary` of each preset, lifted a touch so
 * the dot reads as a paint chip rather than a filled button. Keep the chroma in
 * step with `styles.css` — the swatches are the presets' visual identity. The
 * row walks the hue wheel starting from the default. */
export const ACCENT_PRESETS = [
  { id: 'indigo', color: 'oklch(0.59 0.18 275)' },
  { id: 'violet', color: 'oklch(0.59 0.2 300)' },
  { id: 'pink', color: 'oklch(0.62 0.17 345)' },
  { id: 'rose', color: 'oklch(0.61 0.165 15)' },
  { id: 'orange', color: 'oklch(0.64 0.15 50)' },
  { id: 'amber', color: 'oklch(0.67 0.13 68)' },
  { id: 'green', color: 'oklch(0.6 0.12 148)' },
  { id: 'emerald', color: 'oklch(0.59 0.12 163)' },
  { id: 'teal', color: 'oklch(0.6 0.1 190)' },
  { id: 'cyan', color: 'oklch(0.61 0.105 215)' },
  { id: 'sky', color: 'oklch(0.62 0.12 235)' },
  { id: 'blue', color: 'oklch(0.59 0.16 255)' }
] as const

/* ------------------------------------------------------------------------- *
 * Custom color derivation (OKLCH space).
 * ------------------------------------------------------------------------- */

interface Oklch {
  l: number
  c: number
  h: number
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function srgbToLinear(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4)
}

/** `#rrggbb` → OKLCH (Björn Ottosson's OKLab matrices over linear sRGB). */
function hexToOklch(hex: string): Oklch {
  const r = srgbToLinear(parseInt(hex.slice(1, 3), 16) / 255)
  const g = srgbToLinear(parseInt(hex.slice(3, 5), 16) / 255)
  const b = srgbToLinear(parseInt(hex.slice(5, 7), 16) / 255)
  const lRoot = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const mRoot = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const sRoot = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  const a = 1.9779984951 * lRoot - 2.428592205 * mRoot + 0.4505937099 * sRoot
  const b2 = 0.0259040371 * lRoot + 0.7827717662 * mRoot - 0.808675766 * sRoot
  const hue = (Math.atan2(b2, a) * 180) / Math.PI
  return {
    l: 0.2104542553 * lRoot + 0.793617785 * mRoot - 0.0040720468 * sRoot,
    c: Math.hypot(a, b2),
    h: (hue + 360) % 360
  }
}

/** WCAG relative luminance of an OKLCH color, via linear sRGB. */
function oklchLuminance({ l, c, h }: Oklch): number {
  const radians = (h * Math.PI) / 180
  const a = c * Math.cos(radians)
  const b = c * Math.sin(radians)
  const lPrime = l + 0.3963377774 * a + 0.2158037573 * b
  const mPrime = l - 0.1055613458 * a - 0.0638541728 * b
  const sPrime = l - 0.0894841775 * a - 1.291485548 * b
  const lCubic = lPrime ** 3
  const mCubic = mPrime ** 3
  const sCubic = sPrime ** 3
  const r = 4.0767416621 * lCubic - 3.3077115913 * mCubic + 0.2309699292 * sCubic
  const g = -1.2684380046 * lCubic + 2.6097574011 * mCubic - 0.3413193965 * sCubic
  const b2 = -0.0041960863 * lCubic - 0.7034186147 * mCubic + 1.707614701 * sCubic
  return 0.2126 * Math.max(0, r) + 0.7152 * Math.max(0, g) + 0.0722 * Math.max(0, b2)
}

function contrastRatio(a: number, b: number): number {
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

/** White or ink text for a filled primary surface — whichever reads better.
 * The chroma stays a whisper of the accent hue, exactly like the presets'
 * near-white / near-black foregrounds. */
function readableForeground(primary: Oklch, inkLightness: number): Oklch {
  const white: Oklch = { l: 0.985, c: Math.min(primary.c * 0.02, 0.004), h: primary.h }
  const ink: Oklch = { l: inkLightness, c: Math.min(primary.c * 0.15, 0.03), h: primary.h }
  const y = oklchLuminance(primary)
  return contrastRatio(y, 1) >= contrastRatio(y, oklchLuminance(ink)) ? white : ink
}

function toCss({ l, c, h }: Oklch): string {
  return `oklch(${l.toFixed(3)} ${c.toFixed(3)} ${h.toFixed(1)})`
}

export interface DerivedAccent {
  lightPrimary: string
  lightForeground: string
  darkPrimary: string
  darkForeground: string
}

/** The presets' shared recipe applied to an arbitrary `#rrggbb` pick: chroma
 * capped below the loud line, lightness pinned into the band that keeps filled
 * buttons readable against each mode's background, dark mode a fixed step
 * lighter (the presets average ≈ +0.17 L). */
export function deriveCustomAccent(hex: string): DerivedAccent {
  const picked = hexToOklch(hex)
  const chroma = Math.min(picked.c, 0.19)
  const light: Oklch = { l: clamp(picked.l, 0.45, 0.62), c: chroma, h: picked.h }
  const dark: Oklch = {
    l: clamp(light.l + 0.17, 0.66, 0.82),
    c: Math.min(chroma * 0.92, 0.16),
    h: picked.h
  }
  return {
    lightPrimary: toCss(light),
    lightForeground: toCss(readableForeground(light, 0.16)),
    darkPrimary: toCss(dark),
    darkForeground: toCss(readableForeground(dark, 0.145))
  }
}

/* ------------------------------------------------------------------------- *
 * DOM application + persistence.
 * ------------------------------------------------------------------------- */

const CUSTOM_VARS = [
  '--custom-primary',
  '--custom-primary-foreground',
  '--custom-primary-dark',
  '--custom-primary-foreground-dark'
] as const

/** Write the accent onto <html>. Idempotent; safe to call on every change.
 * DOM-only — persistence is the setters' job, mirroring ui-style's split. */
export function applyAccent(accent: string, customHex: string): void {
  const root = document.documentElement
  root.dataset.accent = accent
  if (accent === CUSTOM_ACCENT) {
    const derived = deriveCustomAccent(customHex)
    root.style.setProperty('--custom-primary', derived.lightPrimary)
    root.style.setProperty('--custom-primary-foreground', derived.lightForeground)
    root.style.setProperty('--custom-primary-dark', derived.darkPrimary)
    root.style.setProperty('--custom-primary-foreground-dark', derived.darkForeground)
  } else {
    for (const name of CUSTOM_VARS) root.style.removeProperty(name)
  }
}

function isAccentId(value: string | null): value is string {
  return (
    value != null &&
    (value === CUSTOM_ACCENT || ACCENT_PRESETS.some((preset) => preset.id === value))
  )
}

function isHex(value: string | null): value is string {
  return value != null && /^#[0-9a-fA-F]{6}$/.test(value)
}

let currentAccent: string = DEFAULT_ACCENT
let currentCustom: string = DEFAULT_CUSTOM_HEX
/** Lazily initialized on first read so module import never touches storage. */
let initialized = false

const listeners = new Set<() => void>()

function init(): void {
  if (initialized) return
  initialized = true
  try {
    const storedAccent = window.localStorage.getItem(ACCENT_KEY)
    if (isAccentId(storedAccent)) currentAccent = storedAccent
    const storedCustom = window.localStorage.getItem(CUSTOM_ACCENT_KEY)
    if (isHex(storedCustom)) currentCustom = storedCustom.toLowerCase()
  } catch {
    /* storage can be unavailable; the defaults still apply */
  }
}

function getAccent(): string {
  init()
  return currentAccent
}

function getCustom(): string {
  init()
  return currentCustom
}

function persist(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    /* persistence is best-effort; the in-memory value still applies */
  }
}

function notify(): void {
  for (const listener of listeners) listener()
}

/** Switch the accent: store, persistence, the derived DOM tokens, listeners. */
export function setAccent(next: string): void {
  if (!isAccentId(next) || getAccent() === next) return
  currentAccent = next
  persist(ACCENT_KEY, next)
  applyAccent(currentAccent, getCustom())
  notify()
}

/** Update the custom well's color. Applies to the interface only while the
 * custom accent is the active one; the pick itself is always remembered. */
export function setCustomAccent(next: string): void {
  if (!isHex(next)) return
  const hex = next.toLowerCase()
  if (getCustom() === hex) return
  currentCustom = hex
  persist(CUSTOM_ACCENT_KEY, hex)
  applyAccent(getAccent(), hex)
  notify()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Subscribable accent preference shared by the app shell and Settings. */
export function useAccent(): [string, typeof setAccent] {
  const accent = useSyncExternalStore(subscribe, getAccent)
  return [accent, setAccent]
}

/** Subscribable custom-well color shared by the app shell and Settings. */
export function useCustomAccent(): [string, typeof setCustomAccent] {
  const hex = useSyncExternalStore(subscribe, getCustom)
  return [hex, setCustomAccent]
}
