/**
 * The keyboard dispatcher: ONE window capture/bubble pair owns every app
 * shortcut. Components register handlers per command id (last registration
 * wins, so an unmounting session cannot leave a stale callback), and the
 * dispatcher decides from the DOM whether a keystroke may fire:
 *
 * - Overlay layers (dialogs, menus, listboxes, full-page surfaces marked
 *   `data-shortcut-layer`) block every command — except the ones a layer
 *   explicitly re-admits through `data-shortcut-passthrough` (the palette's
 *   own ⌘K toggles it closed while the rest of the app stays fenced off).
 * - The terminal (xterm) consumes keydown before it bubbles, so a capture
 *   listener intercepts ONLY the explicit open-terminal command there; all
 *   shell input continues untouched.
 * - Escape-stops-the-run never fires from a text field other than the main
 *   composer (`data-main-composer`), where pi parity expects it.
 * - A webview guest emits no DOM keydown at all: main matches the same
 *   binding identities and relays them (see `dispatchGuestIdentity`).
 */
import {
  SHORTCUTS,
  bindingFromEvent,
  bindingIdentity,
  type ShortcutId
} from './keyboard-shortcuts'
import { getShortcutSnapshot } from './shortcut-store'

export type ShortcutHandler = () => void | boolean
export type ShortcutHandlers = Partial<Record<ShortcutId, ShortcutHandler>>
const handlers = new Map<ShortcutId, ShortcutHandler[]>()

/** Registrations are leases: the returned disposer removes exactly these. */
export function registerShortcutHandlers(next: ShortcutHandlers): () => void {
  for (const [id, handler] of Object.entries(next) as [ShortcutId, ShortcutHandler][]) {
    handlers.set(id, [...(handlers.get(id) ?? []), handler])
  }
  return () => {
    for (const [id, handler] of Object.entries(next) as [ShortcutId, ShortcutHandler][]) {
      const remaining = (handlers.get(id) ?? []).filter((item) => item !== handler)
      if (remaining.length) handlers.set(id, remaining)
      else handlers.delete(id)
    }
  }
}

const LAYERS =
  '[role="dialog"], [aria-modal="true"], [role="menu"], [role="listbox"], [data-shortcut-layer]'

function visible(element: Element): boolean {
  return (
    element.getClientRects().length > 0 &&
    !element.closest('[hidden], [inert], [aria-hidden="true"]') &&
    getComputedStyle(element).visibility !== 'hidden' &&
    getComputedStyle(element).opacity !== '0' &&
    getComputedStyle(element).pointerEvents !== 'none'
  )
}

function visibleLayers(doc: Document): Element[] {
  return [...doc.querySelectorAll(LAYERS)].filter(visible)
}

/** A command survives open layers only when EVERY visible layer re-admits it. */
function admittedThroughLayers(doc: Document, id: ShortcutId): boolean {
  return visibleLayers(doc).every((layer) =>
    (layer.getAttribute('data-shortcut-passthrough') ?? '').split(/\s+/).includes(id)
  )
}

function runHandler(id: ShortcutId, repeat: boolean): 'consumed' | 'ignored' {
  const handler = handlers.get(id)?.at(-1)
  if (!handler) return 'ignored'
  // A held key repeats: swallow the repeats so the action fires exactly once
  // per physical press (a toggling panel must not strobe).
  if (repeat) return 'consumed'
  if (handler() === false) return 'ignored'
  return 'consumed'
}

/** Resolve a platform identity to the command it is bound to right now. */
function commandForIdentity(identity: string, mac: boolean, disabled: Record<string, unknown>) {
  const command = SHORTCUTS.find(({ id }) =>
    getShortcutSnapshot().bindings[id].some((binding) => bindingIdentity(binding, mac) === identity)
  )
  if (!command || disabled[command.id]) return null
  return command
}

/**
 * Entry point for main's guest relay: a webview with focus emits no DOM
 * keydown, so main matches the pressed combo against the identities the
 * renderer pushed (`pushGuestRelayBindings`) and relays the identity here.
 * The same layer/disabled rules apply as for a real keydown.
 */
export function dispatchGuestIdentity(identity: string, repeat = false): void {
  const { mac, disabled } = getShortcutSnapshot()
  const command = commandForIdentity(identity, mac, disabled)
  if (!command || !admittedThroughLayers(document, command.id)) return
  runHandler(command.id, repeat)
}

/**
 * The identities main should intercept inside a focused webview: every
 * enabled binding that carries a modifier. Bare keys (Escape-stop) are never
 * relayed — a page's own Escape belongs to the page.
 */
export function guestRelayIdentities(): string[] {
  const { bindings, disabled, mac } = getShortcutSnapshot()
  const identities = new Set<string>()
  for (const { id } of SHORTCUTS) {
    if (disabled[id]) continue
    for (const binding of bindings[id]) {
      const identity = bindingIdentity(binding, mac)
      if (/^(Control|Alt|Shift|Meta)\+/.test(identity)) identities.add(identity)
    }
  }
  return [...identities]
}

/** Snapshot blocking layers in capture phase, before an Escape closes/unmounts them. */
export function installShortcutDispatcher(doc: Document): () => void {
  const blocked = new WeakSet<Event>()
  const capture = (event: KeyboardEvent) => {
    const target = event.target instanceof Element ? event.target : null
    if (
      event.isComposing ||
      event.keyCode === 229 ||
      target?.closest('[data-shortcut-recording], [data-shortcuts="off"]')
    ) {
      blocked.add(event)
      return
    }
    const layers = visibleLayers(doc)
    if (layers.length > 0) {
      // Passthrough is decided per command at dispatch time; mark only the
      // events whose resolved command no visible layer re-admits.
      const { bindings, mac, disabled } = getShortcutSnapshot()
      const pressed = bindingFromEvent(event, mac)
      if (!pressed) {
        blocked.add(event)
        return
      }
      const identity = bindingIdentity(pressed, mac)
      const command = SHORTCUTS.find(
        ({ id }) =>
          bindings[id].some((binding) => bindingIdentity(binding, mac) === identity) &&
          !disabled[id]
      )
      if (!command || !layers.every((layer) =>
        (layer.getAttribute('data-shortcut-passthrough') ?? '').split(/\s+/).includes(command.id)
      )) {
        blocked.add(event)
        return
      }
    }
    // xterm consumes keydown before it bubbles. Intercept only the explicit
    // open-terminal command; all shell input continues untouched.
    if (target?.closest('.xterm')) dispatch(event, true)
  }
  const dispatch = (event: KeyboardEvent, terminalCapture = false) => {
    if (blocked.has(event) || event.defaultPrevented) return
    const { bindings, mac, disabled } = getShortcutSnapshot()
    const pressed = bindingFromEvent(event, mac)
    if (!pressed) return
    const identity = bindingIdentity(pressed, mac)
    const command = SHORTCUTS.find(({ id }) =>
      bindings[id].some((binding) => bindingIdentity(binding, mac) === identity)
    )
    if (!command || disabled[command.id]) return
    const target = event.target instanceof Element ? event.target : null
    // The terminal owns its input. Only explicit focus navigation may leave it.
    if (target?.closest('.xterm') && command.id !== 'openTerminal') return
    // Esc in other editors/fields belongs to that control, never the running agent.
    if (
      command.id === 'stopAgent' &&
      target?.closest('input, textarea, [contenteditable="true"]') &&
      !target.closest('[data-main-composer]')
    ) {
      return
    }
    if (runHandler(command.id, event.repeat) === 'ignored') return
    event.preventDefault()
    if (terminalCapture) event.stopImmediatePropagation()
  }
  doc.defaultView?.addEventListener('keydown', capture, true)
  doc.defaultView?.addEventListener('keydown', dispatch)
  return () => {
    doc.defaultView?.removeEventListener('keydown', capture, true)
    doc.defaultView?.removeEventListener('keydown', dispatch)
  }
}
