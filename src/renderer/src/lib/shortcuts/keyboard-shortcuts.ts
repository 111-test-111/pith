/**
 * App-wide keyboard shortcut catalogue and portable key bindings.
 *
 * One registry backs everything: the window dispatcher, the right-rail pane
 * shortcuts, the settings rebinding UI and the main-process guest relay (a
 * webview that holds focus never emits DOM keydowns, so main matches the same
 * identities and relays them). `Mod` = Command on macOS, Control elsewhere.
 *
 * Binding strings are `"Modifier+Modifier+Code"` where Code is the PHYSICAL
 * `KeyboardEvent.code` spelling (KeyK, Digit0, Backquote…), so bindings stay
 * stable across keyboard layouts and Option-generated characters.
 */
export const SHORTCUTS = [
  // chat
  { id: 'newSession', group: 'chat', defaults: ['Mod+KeyN'] },
  { id: 'stopAgent', group: 'chat', defaults: ['Escape'] },
  // navigation
  { id: 'commandPalette', group: 'navigation', defaults: ['Mod+KeyK'] },
  { id: 'sessionSearch', group: 'navigation', defaults: ['Mod+Shift+KeyF'] },
  { id: 'openSettings', group: 'navigation', defaults: ['Mod+Comma'] },
  { id: 'toggleSidebar', group: 'navigation', defaults: ['Mod+KeyB'] },
  { id: 'toggleRail', group: 'navigation', defaults: ['Mod+Alt+KeyB'] },
  // right rail panes (the picker's advertised keys) and tab management
  { id: 'openReview', group: 'panes', defaults: ['Control+Shift+KeyG'] },
  { id: 'openGit', group: 'panes', defaults: ['Mod+Alt+KeyG'] },
  { id: 'openTrajectory', group: 'panes', defaults: ['Control+Shift+KeyT'] },
  { id: 'openContext', group: 'panes', defaults: ['Control+Shift+KeyC'] },
  { id: 'openTerminal', group: 'panes', defaults: ['Control+Backquote'] },
  { id: 'openDebug', group: 'panes', defaults: ['Control+Shift+KeyD'] },
  { id: 'openBrowser', group: 'panes', defaults: ['Mod+KeyT'] },
  { id: 'openFiles', group: 'panes', defaults: ['Mod+KeyP'] },
  { id: 'openSideChat', group: 'panes', defaults: ['Alt+Mod+KeyS'] },
  { id: 'closeRailTab', group: 'panes', defaults: ['Mod+Alt+KeyW'] },
  { id: 'nextRailTab', group: 'panes', defaults: ['Mod+Alt+ArrowRight'] },
  { id: 'prevRailTab', group: 'panes', defaults: ['Mod+Alt+ArrowLeft'] }
] as const

export type ShortcutId = (typeof SHORTCUTS)[number]['id']
export type ShortcutGroup = (typeof SHORTCUTS)[number]['group']
export type ShortcutOverrides = Partial<Record<ShortcutId, string[]>>
export type ShortcutBindings = Record<ShortcutId, readonly string[]>
export type DisabledShortcuts = Partial<Record<ShortcutId, true>>
export const SHORTCUT_STORAGE_KEY = 'pi-app:keyboard-shortcuts'
export const MAX_SHORTCUT_BINDINGS = 1
const MODIFIERS = ['Control', 'Alt', 'Shift', 'Mod']
const CODE =
  /^(Key[A-Z]|Digit[0-9]|F(?:[1-9]|1[0-2])|Arrow(?:Left|Right|Up|Down)|Backquote|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Comma|Period|Slash|Space|Enter|Tab|Backspace|Delete|Escape|Home|End|PageUp|PageDown)$/

export function isShortcutId(id: unknown): id is ShortcutId {
  return SHORTCUTS.some((command) => command.id === id)
}

function parts(binding: string) {
  const tokens = binding.split('+')
  return { modifiers: tokens.slice(0, -1), code: tokens[tokens.length - 1] }
}

export function normalizeBinding(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const { modifiers, code } = parts(value)
  if (
    !CODE.test(code) ||
    modifiers.some((mod) => !MODIFIERS.includes(mod)) ||
    new Set(modifiers).size !== modifiers.length
  ) {
    return null
  }
  return [...MODIFIERS.filter((mod) => modifiers.includes(mod)), code].join('+')
}

/** The platform-resolved identity two bindings compare by (Mod → Meta/Ctrl). */
export function bindingIdentity(binding: string, mac: boolean): string {
  const { modifiers, code } = parts(binding)
  const keys = new Set(
    modifiers.map((mod) => (mod === 'Mod' ? (mac ? 'Meta' : 'Control') : mod))
  )
  return ['Control', 'Alt', 'Shift', 'Meta'].filter((mod) => keys.has(mod)).concat(code).join('+')
}

export type BindingError = 'modifierRequired' | 'reserved' | 'escapeOnlyStop'
export function bindingError(binding: string, id: ShortcutId, mac: boolean): BindingError | null {
  const { modifiers, code } = parts(binding)
  // Escape is the stop key's alone: anywhere else it either fights an
  // overlay's dismiss or strands the running turn with no way to stop it.
  if (code === 'Escape') return binding === 'Escape' && id === 'stopAgent' ? null : 'escapeOnlyStop'
  if (!modifiers.includes('Mod') && !modifiers.includes('Control') && !/^F\d+$/.test(code)) {
    return 'modifierRequired'
  }
  // Enter without Shift is submit in every composer/field of the app.
  if (code === 'Enter' && !modifiers.includes('Shift')) return 'reserved'
  const resolved = bindingIdentity(binding, mac)
  const primary = mac ? 'Meta' : 'Control'
  // OS/native-editing keys that can never become reliable app commands:
  // - ⌘Q is intercepted by main (quit) before the renderer sees a keydown.
  // - ⌘A/C/V/X/Z/Y and their Shift forms are text editing in every field.
  // - Spotlight (⌘Space) is swallowed by macOS before the app.
  // - F12 is the dev-tools convention; Alt+F4 / Ctrl+Alt+Del are Windows OS keys.
  const reserved = [
    ...['KeyA', 'KeyC', 'KeyV', 'KeyX', 'KeyZ', 'KeyY', 'KeyQ', 'Space'].map(
      (key) => `${primary}+${key}`
    ),
    ...['KeyZ', 'KeyV', 'KeyC', 'KeyX'].map((key) => `Shift+${primary}+${key}`),
    'Control+Alt+Delete',
    'Alt+F4',
    'F12'
  ].map((key) => key.split('+').sort().join('+'))
  if (reserved.includes(resolved.split('+').sort().join('+'))) return 'reserved'
  return null
}

export function parseShortcutOverrides(raw: string | null, mac: boolean): ShortcutOverrides {
  try {
    const saved: unknown = JSON.parse(raw ?? 'null')
    if (
      !saved ||
      typeof saved !== 'object' ||
      !('version' in saved) ||
      saved.version !== 1 ||
      !('overrides' in saved)
    ) {
      return {}
    }
    const overrides = saved.overrides
    if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) return {}
    const result: ShortcutOverrides = {}
    for (const { id } of SHORTCUTS) {
      const value = (overrides as Record<string, unknown>)[id]
      if (!Array.isArray(value)) continue
      // Preserve the first binding from older multi-binding configurations.
      const bindings = value.slice(0, MAX_SHORTCUT_BINDINGS).map(normalizeBinding)
      if (bindings.some((binding) => !binding || bindingError(binding, id, mac))) continue
      result[id] = [...new Set(bindings as string[])]
    }
    return result
  } catch {
    return {}
  }
}

/** Disabled flags live beside overrides in the same stored document; true rows only. */
export function parseDisabledShortcuts(raw: string | null): DisabledShortcuts {
  try {
    const saved: unknown = JSON.parse(raw ?? 'null')
    if (
      !saved ||
      typeof saved !== 'object' ||
      !('version' in saved) ||
      saved.version !== 1 ||
      !('disabled' in saved)
    ) {
      return {}
    }
    const disabled = (saved as { disabled?: unknown }).disabled
    if (!disabled || typeof disabled !== 'object' || Array.isArray(disabled)) return {}
    const result: DisabledShortcuts = {}
    for (const { id } of SHORTCUTS) {
      if ((disabled as Record<string, unknown>)[id] === true) result[id] = true
    }
    return result
  } catch {
    return {}
  }
}

export function resolveShortcutBindings(
  overrides: ShortcutOverrides,
  mac: boolean
): ShortcutBindings {
  const result = {} as ShortcutBindings
  const used = new Set<string>()
  // Explicit customizations win over defaults when importing older/corrupt data.
  const ordered = [...SHORTCUTS].sort(
    (a, b) => Number(b.id in overrides) - Number(a.id in overrides)
  )
  for (const { id, defaults } of ordered) {
    result[id] = (overrides[id] ?? defaults).slice(0, MAX_SHORTCUT_BINDINGS).filter((binding) => {
      const identity = bindingIdentity(binding, mac)
      if (used.has(identity)) return false
      used.add(identity)
      return true
    })
  }
  return result
}

export function findShortcutConflict(
  bindings: ShortcutBindings,
  candidate: string,
  id: ShortcutId,
  mac: boolean
): ShortcutId | null {
  const identity = bindingIdentity(candidate, mac)
  return (
    SHORTCUTS.find(
      (command) =>
        command.id !== id &&
        bindings[command.id].some((binding) => bindingIdentity(binding, mac) === identity)
    )?.id ?? null
  )
}

export interface ShortcutKeyEvent {
  key: string
  code: string
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  metaKey: boolean
  isComposing?: boolean
  keyCode?: number
  getModifierState?: (key: string) => boolean
}

export function bindingFromEvent(event: ShortcutKeyEvent, mac: boolean): string | null {
  if (event.isComposing || event.keyCode === 229 || event.getModifierState?.('AltGraph')) return null
  if (!CODE.test(event.code) || (!mac && event.metaKey)) return null
  // Physical codes keep Option-generated characters and shifted punctuation stable.
  return [
    event.ctrlKey && (mac ? 'Control' : 'Mod'),
    event.altKey && 'Alt',
    event.shiftKey && 'Shift',
    mac && event.metaKey && 'Mod',
    event.code
  ]
    .filter(Boolean)
    .join('+')
}

const KEY_LABELS: Record<string, string> = {
  Escape: 'Esc',
  Backquote: '`',
  Minus: '−',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
  Backspace: '⌫',
  Delete: 'Del',
  Space: 'Space',
  Enter: 'Enter',
  PageUp: 'PgUp',
  PageDown: 'PgDn'
}

export function shortcutKeyLabels(binding: string, mac: boolean): string[] {
  const { modifiers, code } = parts(binding)
  const names: Record<string, string> = mac
    ? { Control: '⌃', Alt: '⌥', Shift: '⇧', Mod: '⌘' }
    : { Control: 'Ctrl', Alt: 'Alt', Shift: 'Shift', Mod: 'Ctrl' }
  const order = mac ? MODIFIERS : ['Mod', 'Control', 'Alt', 'Shift']
  return [
    ...new Set(order.filter((mod) => modifiers.includes(mod)).map((mod) => names[mod])),
    KEY_LABELS[code] ?? code.replace(/^(Key|Digit)/, '')
  ]
}

/** Joined display form ("⌘K") for chips and tooltips. */
export function shortcutDisplay(binding: string, mac: boolean): string {
  return shortcutKeyLabels(binding, mac).join('')
}

export function shortcutAriaLabel(binding: string, mac: boolean): string {
  const { modifiers, code } = parts(bindingIdentity(binding, mac))
  return [
    ...modifiers,
    code.startsWith('Key')
      ? code.slice(3)
      : code.startsWith('Digit')
        ? code.slice(5)
        : KEY_LABELS[code] &&
            !['Escape', 'Backspace', 'Delete', 'Space', 'PageUp', 'PageDown'].includes(code) &&
            !code.startsWith('Arrow')
          ? KEY_LABELS[code]
          : code
  ].join('+')
}
