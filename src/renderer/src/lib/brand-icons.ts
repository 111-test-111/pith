import type { IconSvgElement } from '@hugeicons/react'
import { UI_ICON_STROKE } from './icon-metrics'

/** App-owned Agent SVG: a code face with a core above it. Bot and Subagent
 * share this mark; it is branding rather than a second UI icon family.
 * The Pi/Pith brand keeps its existing resources/pith*.svg masters. */
const stroke = {
  stroke: 'currentColor',
  strokeWidth: UI_ICON_STROKE,
  strokeLinecap: 'round',
  strokeLinejoin: 'round'
} as const

export const AGENT_ARTWORK = [
  ['path', { d: 'M8 7H6C4.343 7 3 8.343 3 10V18C3 19.657 4.343 21 6 21H18C19.657 21 21 19.657 21 18V10C21 8.343 19.657 7 18 7H16', ...stroke, key: 'frame' }],
  ['path', { d: 'M12 2.5L14.5 5L12 7.5L9.5 5Z', ...stroke, key: 'core' }],
  ['path', { d: 'M9 11.5L7 13.5L9 15.5M15 11.5L17 13.5L15 15.5M10.5 18H13.5', ...stroke, key: 'face' }]
] as const satisfies IconSvgElement
