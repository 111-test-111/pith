/** Embedded-browser device presets are implemented by sizing the renderer webview element. This preserves the guest-viewport/element-size invariant used by annotations; CDP setDeviceMetricsOverride would break it. Pure data/functions are Node-testable; ported from pi-web without changing keys/dependencies. */

export interface DevicePreset {
  id: string
  name: string
  width: number
  height: number
}

export const DEVICE_PRESETS: readonly DevicePreset[] = [
  { id: 'iphone-se', name: 'iPhone SE', width: 375, height: 667 },
  { id: 'iphone-15-pro', name: 'iPhone 15 Pro', width: 393, height: 852 },
  { id: 'pixel-8', name: 'Pixel 8', width: 412, height: 915 },
  { id: 'galaxy-s23', name: 'Galaxy S23', width: 360, height: 780 },
  { id: 'ipad-air', name: 'iPad Air', width: 820, height: 1180 },
]

/** Custom device ID, selected by dimension edits and listed only while active. */
export const CUSTOM_DEVICE_ID = 'custom'

/** No-emulation ID: fill the host area. The selector disables this row; changing the selected page resets emulation, with no in-panel toggle on this path. */
export const DEVICE_NONE_ID = 'none'

/** Pane device state: preset ID and last committed dimensions. Presets supply their dimensions, custom uses committed values, and none ignores dimensions. */
export interface DeviceEmulationState {
  presetId: string
  width: number
  height: number
}

/** Initial no-emulation state seeds dimensions from the first preset for a later custom edit. */
export const INITIAL_DEVICE_STATE: DeviceEmulationState = {
  presetId: DEVICE_NONE_ID,
  width: DEVICE_PRESETS[0].width,
  height: DEVICE_PRESETS[0].height,
}

/** Effective webview dimensions; null fills the host without emulation. */
export function resolveDeviceSize(state: DeviceEmulationState): { width: number; height: number } | null {
  const preset = findDevicePreset(state.presetId)
  if (preset) return { width: preset.width, height: preset.height }
  if (state.presetId === CUSTOM_DEVICE_ID) return { width: state.width, height: state.height }
  return null
}

/** Dimension input filter: digits only, up to four characters (the 3840 maximum has four). */
export function sanitizeDeviceDigits(raw: string): string {
  return raw.replace(/\D/g, '').slice(0, 4)
}

/** Commit one dimension on blur: empty/invalid drafts retain the value; otherwise round and clamp to 200–3840. Draft edits do not change effective dimensions or truncate an unfinished value. */
export function commitDeviceSize(raw: string, previous: number): number {
  const trimmed = raw.trim()
  if (trimmed === '') return previous
  const parsed = Number(trimmed)
  if (!Number.isFinite(parsed)) return previous
  return clampDeviceSize(parsed)
}

/** Resolve a committed size to an exact matching preset, otherwise custom. */
export function resolveDevicePresetId(width: number, height: number): string {
  const match = DEVICE_PRESETS.find((p) => p.width === width && p.height === height)
  return match ? match.id : CUSTOM_DEVICE_ID
}

export const DEVICE_SIZE_MIN = 200
export const DEVICE_SIZE_MAX = 3840

export function clampDeviceSize(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return DEVICE_SIZE_MIN
  return Math.min(Math.max(Math.round(value), DEVICE_SIZE_MIN), DEVICE_SIZE_MAX)
}

export function findDevicePreset(id: string): DevicePreset | null {
  return DEVICE_PRESETS.find((p) => p.id === id) ?? null
}
