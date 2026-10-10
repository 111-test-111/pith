/** Image previews retain mouse-wheel zoom versus trackpad pan through inertia.
 * Scroll direction itself is never locked. */
export const WHEEL_GESTURE_IDLE = 200
export const WHEEL_NOTCH_PX = 40
export interface WheelInput {
  deltaX: number
  deltaY: number
  deltaMode: number
  ctrlKey: boolean
  shiftKey: boolean
}

export function wheelPixels(event: WheelInput, viewport: { clientWidth: number; clientHeight: number }, linePixels = 16): WheelInput {
  const input = { deltaX: event.deltaX * (event.deltaMode === 1 ? linePixels : event.deltaMode === 2 ? viewport.clientWidth : 1),
    deltaY: event.deltaY * (event.deltaMode === 1 ? linePixels : event.deltaMode === 2 ? viewport.clientHeight : 1),
    deltaMode: event.deltaMode, ctrlKey: event.ctrlKey, shiftKey: event.shiftKey }
  // Shift explicitly maps a vertical mouse wheel to horizontal motion.
  // Chromium may already have mapped it. Pinch keeps its zoom delta intact.
  if (input.shiftKey && !input.ctrlKey) {
    input.deltaX = Math.abs(input.deltaX) > Math.abs(input.deltaY) ? input.deltaX : input.deltaY
    input.deltaY = 0
  }
  return input
}
