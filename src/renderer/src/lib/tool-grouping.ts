import { useSyncExternalStore } from 'react'

/**
 * Whether the transcript folds consecutive same-category tool calls into one
 * collapsed group row (`ToolGroupView`).
 *
 * A renderer preference like `show-reasoning`: stored in localStorage and read
 * through a subscribable store, so flipping it in Settings re-renders the
 * transcript immediately (no session reload, no main-process round trip).
 * Default: on. Off restores the pre-grouping transcript — every tool call is
 * its own row.
 *
 * The flag reaches `buildToolPlan`, which is the single source of truth for the
 * rows a tool block renders: when off it emits one singleton run per call
 * instead of merging adjacent blocks.
 */
const STORAGE_KEY = 'pi-app:tool-grouping'
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

/** Subscribable grouping preference shared by the transcript and Settings. */
export function useToolGrouping(): [boolean, (next: boolean) => void] {
  const enabled = useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    get
  )
  return [enabled, set]
}
