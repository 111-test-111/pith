import { Fragment, useMemo } from 'react'
import {
  shortcutAriaLabel,
  shortcutKeyLabels,
  type ShortcutId
} from '@/lib/shortcuts/keyboard-shortcuts'
import { useShortcutBindings, useShortcutLabel } from '@/lib/shortcuts/use-shortcuts'
import {
  KeyArrowDown,
  KeyArrowLeft,
  KeyArrowRight,
  KeyArrowUp,
  Backspace,
  Command,
  Control,
  Option,
  Shift,
  type IconComponent
} from '@/lib/icons'
import { cn } from '@/lib/utils'
import { UI_ICON_SIZE } from '@/lib/icon-metrics'

/**
 * Modifier and arrow keys render as ICONS, never text: the Unicode glyphs
 * (⌘⇧⌥⌃⌫←→) fall back to whatever symbol font the platform picks, arriving
 * small and low against the app font's letters. Everything else (letters,
 * digits, punctuation, Esc/Enter/Tab…) stays text.
 */
const KEY_ICONS: Record<string, IconComponent> = {
  '⌘': Command,
  '⌥': Option,
  '⌃': Control,
  '⇧': Shift,
  '⌫': Backspace,
  '←': KeyArrowLeft,
  '→': KeyArrowRight,
  '↑': KeyArrowUp,
  '↓': KeyArrowDown
}

/**
 * One cap per key, with plus separators outside the caps. Letters use the
 * interface font. Icon canvases follow that font's cap height: the Lucide
 * drawings have different native extents, so equal SVG boxes would make the
 * arrows smaller than Command and the letters. Preserve the paths and balance
 * their visible ink instead. Reactive bindings go through ShortcutBindingChip.
 */
export function ShortcutKeys({
  binding,
  mac,
  className
}: {
  binding: string
  mac: boolean
  className?: string
}) {
  const keys = useMemo(() => shortcutKeyLabels(binding, mac), [binding, mac])
  return (
    <span
      role="group"
      aria-label={shortcutAriaLabel(binding, mac)}
      className={cn(
        'inline-flex shrink-0 items-center gap-1 whitespace-nowrap font-sans text-keycap font-normal leading-none text-foreground',
        className
      )}
    >
      {keys.map((key, index) => {
        const Icon = KEY_ICONS[key]
        return (
          <Fragment key={index}>
            {index > 0 ? <span aria-hidden="true" className="text-xs text-muted-foreground">+</span> : null}
            <kbd
              aria-hidden="true"
              className={cn(
                'inline-flex h-[max(1.5rem,1.5em)] min-w-[max(1.5rem,1.5em)] shrink-0 items-center justify-center rounded-control border border-border bg-card font-sans font-normal leading-none',
                !Icon && key.length > 1 && 'px-1.5'
              )}
            >
              {Icon ? (
                <Icon
                  size={UI_ICON_SIZE.compact}
                  strokeWidth={2}
                  className={cn('shrink-0', key === '⌃' ? 'size-[1.75cap]' : '←→↑↓'.includes(key) ? 'size-[1.5cap]' : 'size-[1.2cap]')}
                />
              ) : key.length > 1 ? <span className="text-micro">{key}</span> : key}
            </kbd>
          </Fragment>
        )
      })}
    </span>
  )
}

/**
 * The key chip the right-rail picker (and any button hint) shows for a
 * command: follows the user's rebinding live, and hides itself when the
 * command is disabled or unassigned (an empty chip would read as a broken
 * glyph).
 */
export function ShortcutBindingChip({ id, className }: { id: ShortcutId; className?: string }) {
  const { mac, disabled, bindings } = useShortcutBindings()
  const binding = bindings[id][0]
  if (!binding || disabled[id]) return null
  return <ShortcutKeys binding={binding} mac={mac} className={className} />
}

/** Joined glyph text ("⌘K") for tooltips and other plain-string slots. */
export function useShortcutGlyphText(id: ShortcutId): string {
  return useShortcutLabel(id).display
}
