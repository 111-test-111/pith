import { useMemo, type ReactElement } from 'react'
import {
  shortcutAriaLabel,
  shortcutKeyLabels,
  type ShortcutId
} from '@/lib/shortcuts/keyboard-shortcuts'
import { useShortcutBindings, useShortcutLabel } from '@/lib/shortcuts/use-shortcuts'
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Backspace,
  Command,
  Control,
  Option,
  type IconComponent
} from '@/lib/icons'
import { cn } from '@/lib/utils'

/**
 * The mac ⇧ (U+21E7) as drawn artwork: Lucide draws ⌘ and ⌥ (`Command`,
 * `Option`) and this adapter maps ⌃ to its `ChevronUp` caret, but the pack ships
 * no shift drawing, and the text character's baseline varies by fallback font —
 * exactly the off-centre look this component exists to kill. Stroked at the
 * family's own default weight (2px in the 24 box), so it sits evenly next to
 * them.
 */
function ShiftGlyph({ size = 14 }: { size?: string | number }): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 4 L18.5 11 H15 V20 H9 V11 H5.5 Z" />
    </svg>
  )
}

/**
 * Modifier and arrow keys render as ICONS, never text: the Unicode glyphs
 * (⌘⇧⌥⌃⌫←→) fall back to whatever symbol font the platform picks, arriving
 * small and low against the app font's letters. Everything else (letters,
 * digits, punctuation, Esc/Enter/Tab…) stays text.
 */
const KEY_ICONS: Record<string, IconComponent | ((props: { size?: string | number }) => ReactElement)> = {
  '⌘': Command,
  '⌥': Option,
  '⌃': Control,
  '⇧': ShiftGlyph,
  '⌫': Backspace,
  '←': ArrowLeft,
  '→': ArrowRight,
  '↑': ArrowUp,
  '↓': ArrowDown
}

/**
 * One binding rendered as key caps (⌘ K). Each cap is its own chip — a light
 * field with a hairline edge, content flex-centred on a 24px box. Pure
 * presentation: pass the raw binding string and the platform; reactive
 * per-command labels go through `ShortcutBindingChip`.
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
      aria-label={shortcutAriaLabel(binding, mac)}
      className={cn('inline-flex items-center gap-[3px] whitespace-nowrap', className)}
    >
      {keys.map((key, index) => {
        const Icon = KEY_ICONS[key]
        return (
          // Every cap is the same 24×24 square: content (icon or glyph)
          // centred, padding-free, so an icon cap never out-widens a letter
          // cap. Long word labels (Enter/Space…) shrink to fit.
          <kbd
            key={index}
            aria-hidden="true"
            className={cn(
              'inline-flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border/50 bg-muted/70 font-medium leading-none text-muted-foreground',
              key.length > 3 ? 'text-[10px]' : 'text-[13px]'
            )}
          >
            {Icon ? <Icon size={14} /> : key}
          </kbd>
        )
      })}
    </span>
  )
}

/**
 * The key caps the right-rail picker (and any button hint) shows for a
 * command: follows the user's rebinding live, and hides itself when the
 * command is disabled or unassigned (an empty cap would read as a broken
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
