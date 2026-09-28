/** A wheel stream includes macOS trackpad inertia. Decide its intent once;
 * per-event dominant-axis comparisons flip on nearly diagonal swipes. */
export const WHEEL_GESTURE_IDLE = 200
export const WHEEL_NOTCH_PX = 40
export type WheelAxis = 'x' | 'y'
export interface WheelInput {
  deltaX: number
  deltaY: number
  deltaMode: number
  ctrlKey: boolean
  shiftKey: boolean
}

export function wheelPixels(event: WheelInput, viewport: { clientWidth: number; clientHeight: number }, linePixels = 16): WheelInput {
  return { deltaX: event.deltaX * (event.deltaMode === 1 ? linePixels : event.deltaMode === 2 ? viewport.clientWidth : 1),
    deltaY: event.deltaY * (event.deltaMode === 1 ? linePixels : event.deltaMode === 2 ? viewport.clientHeight : 1),
    deltaMode: event.deltaMode, ctrlKey: event.ctrlKey, shiftKey: event.shiftKey }
}

export function createWheelGesture<Mode extends string>(chooseMode: (input: WheelInput, axis: WheelAxis) => Mode) {
  let axis: WheelAxis | null = null
  let mode: Mode
  let last = -Infinity
  let modifier = ''
  return {
    reset() { axis = null; last = -Infinity },
    read(input: WheelInput, now = performance.now()) {
      if (!input.deltaX && !input.deltaY) return null
      const nextModifier = input.ctrlKey ? 'pinch' : input.shiftKey ? 'shift' : ''
      if (axis === null || now - last > WHEEL_GESTURE_IDLE || modifier !== nextModifier) {
        axis = input.ctrlKey ? 'y' : input.shiftKey ? 'x' : Math.abs(input.deltaX) > Math.abs(input.deltaY) ? 'x' : 'y'
        mode = chooseMode(input, axis)
      }
      last = now; modifier = nextModifier
      // Shift maps a conventional vertical mouse wheel to horizontal motion;
      // Chromium may already have mapped it, so use the stronger raw delta.
      const shifted = Math.abs(input.deltaX) > Math.abs(input.deltaY) ? input.deltaX : input.deltaY
      return { axis, mode: mode!, deltaX: axis === 'x' ? input.shiftKey ? shifted : input.deltaX : 0,
        deltaY: axis === 'y' ? input.deltaY : 0 }
    }
  }
}
