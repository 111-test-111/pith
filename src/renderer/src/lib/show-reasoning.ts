import { useSyncExternalStore } from 'react'

/**
 * Whether the transcript paints the model's reasoning blocks.
 *
 * Reasoning is the model's scratchpad: some turns read better with it visible,
 * others as answer + tool calls only. A renderer preference like
 * locale/theme/fonts — stored in localStorage and read through a subscribable
 * store, so flipping it in Settings re-renders the transcript immediately (no
 * session reload, no main-process round trip). Default: on.
 *
 * The flag also reaches the tool-run plan: a hidden reasoning block paints no
 * row, and a block that paints nothing must not separate two otherwise adjacent
 * tool runs (`buildToolPlan`), nor be counted by the fold's "show earlier N"
 * step count.
 */
const STORAGE_KEY = 'pi-app:show-reasoning'
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

/** Subscribable reasoning-visibility preference shared by the transcript and
 * the Settings section. */
export function useShowReasoning(): [boolean, (next: boolean) => void] {
  const show = useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    get
  )
  return [show, set]
}
