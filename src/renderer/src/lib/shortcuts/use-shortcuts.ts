/**
 * React bindings for the shortcut system: one dispatcher install (Workspace),
 * per-component handler leases, and the reactive snapshot for labels/UI.
 */
import { useEffect, useMemo, useSyncExternalStore } from 'react'
import {
  bindingIdentity,
  shortcutAriaLabel,
  shortcutDisplay,
  type ShortcutId
} from './keyboard-shortcuts'
import {
  getShortcutSnapshot,
  subscribeShortcuts,
  type ShortcutSnapshot
} from './shortcut-store'
import {
  installShortcutDispatcher,
  registerShortcutHandlers,
  type ShortcutHandlers
} from './shortcut-dispatcher'

export function useShortcutBindings(): ShortcutSnapshot {
  return useSyncExternalStore(subscribeShortcuts, getShortcutSnapshot)
}

/**
 * Lease handlers for the given commands. The record should be memoized by the
 * caller when it closes over changing state; re-registration is cheap and
 * last-registration-wins, so a stale closure never survives its component.
 */
export function useShortcutHandlers(handlers: ShortcutHandlers): void {
  useEffect(() => registerShortcutHandlers(handlers), [handlers])
}

/** One dispatcher for the whole app; install once near the root. */
export function useShortcutDispatcher(): void {
  useEffect(() => installShortcutDispatcher(document), [])
}

export interface ShortcutLabel {
  /** Joined glyph form for chips ("⌘K", "⌃⇧G"). Empty when unassigned. */
  display: string
  /** Spoken form for aria-labels. */
  aria: string
}

/** The current display labels for one command, following rebinding. */
export function useShortcutLabel(id: ShortcutId): ShortcutLabel {
  const { bindings, mac } = useShortcutBindings()
  return useMemo(() => {
    const binding = bindings[id][0]
    return {
      display: binding ? shortcutDisplay(binding, mac) : '',
      aria: binding ? shortcutAriaLabel(binding, mac) : ''
    }
  }, [bindings, mac, id])
}

/** Non-hook label read (same inputs as the dispatcher's matching). */
export function shortcutLabelFor(
  snapshot: ShortcutSnapshot,
  id: ShortcutId
): ShortcutLabel {
  const binding = snapshot.bindings[id][0]
  return {
    display: binding ? shortcutDisplay(binding, snapshot.mac) : '',
    aria: binding ? shortcutAriaLabel(binding, snapshot.mac) : ''
  }
}

/** Re-export for the guest-relay pusher and settings validation. */
export { bindingIdentity }
export type { ShortcutHandlers } from './shortcut-dispatcher'
