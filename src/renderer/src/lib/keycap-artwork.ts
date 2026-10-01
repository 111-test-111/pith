import type { IconSvgElement } from '@hugeicons/react'
import { UI_ICON_STROKE } from './icon-metrics'

/** The mac ⌫ keycap, like ⇧ in ShortcutKeys, is typographic geometry.
 * Hugeicons has no backspace drawing; its Delete icon is a trash can.
 * Keep the keyboard symbol legible without depending on a fallback font. */
export const BACKSPACE_ARTWORK = [
  ['path', {
    d: 'M9 5H20C21.105 5 22 5.895 22 7V17C22 18.105 21.105 19 20 19H9L2 12ZM12 9L18 15M18 9L12 15',
    stroke: 'currentColor',
    strokeWidth: UI_ICON_STROKE,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    key: 'backspace'
  }]
] as const satisfies IconSvgElement
