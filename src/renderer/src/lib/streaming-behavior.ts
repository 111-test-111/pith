import { useSyncExternalStore } from 'react'

/**
 * What Enter does while the agent is already running: "steer" interrupts
 * before the next model call, "followUp" waits for the run to finish. A
 * renderer preference (like locale/theme) — the composer submits the inverse
 * behavior on Cmd/Ctrl+Enter, and Settings → General flips the default.
 */
export type StreamingBehavior = 'steer' | 'followUp'

const STORAGE_KEY = 'pi-app:streaming-behavior'
const DEFAULT: StreamingBehavior = 'steer'

function read(): StreamingBehavior {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === 'followUp' ? 'followUp' : 'steer'
  } catch {
    return DEFAULT
  }
}

let current: StreamingBehavior = DEFAULT
/** Lazily initialized on first read so module import never touches storage. */
let initialized = false

const listeners = new Set<() => void>()

function get(): StreamingBehavior {
  if (!initialized) {
    current = read()
    initialized = true
  }
  return current
}

function set(next: StreamingBehavior): void {
  if (get() === next) return
  current = next
  try {
    window.localStorage.setItem(STORAGE_KEY, next)
  } catch {
    /* persistence is best-effort; the in-memory value still applies */
  }
  for (const listener of listeners) listener()
}

/** The behavior opposite to `behavior` — what Cmd/Ctrl+Enter submits. */
export function otherBehavior(behavior: StreamingBehavior): StreamingBehavior {
  return behavior === 'steer' ? 'followUp' : 'steer'
}

/** Subscribable preference shared by the Composer and the Settings section. */
export function useStreamingBehavior(): [StreamingBehavior, (next: StreamingBehavior) => void] {
  const behavior = useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    get
  )
  return [behavior, set]
}
