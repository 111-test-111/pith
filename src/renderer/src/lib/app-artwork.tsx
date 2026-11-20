// App-owned artwork for meanings the icon packs do not draw. Everywhere else
// the adapter binds a real pack export; this file exists only for the gaps.
// Square-side drawings keep the Remix family's filled-outline contract: one
// 24-grid, `fill: currentColor`, no stroke. Squircle-side stroke drawings use
// the native 24-grid and weight; filled artwork retains its upstream canvas.
import type { ReactElement, SVGProps } from 'react'
import { UI_ICON_STROKE } from './icon-metrics'

/** Mirrors the Remix pack's prop surface without importing the pack here (the
 * icon adapter is the only module allowed to touch `@remixicon/react`). */
type AppArtworkProps = Pick<
  SVGProps<SVGSVGElement>,
  Exclude<keyof SVGProps<SVGSVGElement>, 'color' | 'size' | 'width' | 'height' | 'fill' | 'viewBox'>
> & {
  color?: string
  size?: number | string
  children?: never
}

/** One app-owned drawing, bound through `GLYPHS` like any pack export. */
export type AppArtworkComponent = (props: AppArtworkProps) => ReactElement

/** Subagent: code brackets branching into two independent task nodes. Original
 * app-owned artwork, drawn on the same 24 grid as both interface families. */
const subagentStroke = {
  stroke: 'currentColor',
  strokeWidth: UI_ICON_STROKE,
  strokeLinecap: 'round',
  strokeLinejoin: 'round'
} as const

export const SubagentRoundedArtwork = [
  ['path', {
    d: 'M9 3.5L6 6.5L9 9.5M15 3.5L18 6.5L15 9.5M12 9.5V12.5M5 15.5V12.5H19V15.5',
    ...subagentStroke,
    key: 'code-branch'
  }],
  ['rect', { x: 2, y: 15.5, width: 6, height: 6, rx: 1.5, ...subagentStroke, key: 'child-left' }],
  ['rect', { x: 16, y: 15.5, width: 6, height: 6, rx: 1.5, ...subagentStroke, key: 'child-right' }]
] as const

/** The same code-branch silhouette as filled, 2-unit outlines for square UI. */
export function SubagentSquareArtwork({ size = 24, color, ...props }: AppArtworkProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill={color ?? 'currentColor'}
      {...props}
    >
      <path
        d="M9 2.586L10.414 4L7.914 6.5L10.414 9L9 10.414L5.086 6.5ZM15 2.586L18.914 6.5L15 10.414L13.586 9L16.086 6.5L13.586 4Z"
      />
      <path d="M11 10H13V11.5H20V15H18V13.5H6V15H4V11.5H11Z" />
      <path
        fillRule="evenodd"
        d="M2 15H8V21H2ZM4 17V19H6V17ZM16 15H22V21H16ZM18 17V19H20V17Z"
      />
    </svg>
  )
}

/** Diff: a plus above a minus — the same change mark the squircle style's
 * Hugeicons `DiffIcon` draws, redrawn as filled bars so the square style keeps
 * its filled-outline family. Bars are 2 units thick, matching Remix Line's
 * drawn weight (its inner rules are 2-unit rects). Used by `Diff` and `FileDiff`. */
export function DiffArtwork({ size = 24, color, ...props }: AppArtworkProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill={color ?? 'currentColor'}
      {...props}
    >
      <rect x="11" y="3" width="2" height="14" rx="1" />
      <rect x="5" y="9" width="14" height="2" rx="1" />
      <rect x="5" y="20" width="14" height="2" rx="1" />
    </svg>
  )
}

/** A change comparison: rose for the original, emerald for the revised file. */
function diffLayoutArtwork(sideBySide: boolean, rounded: boolean): AppArtworkComponent {
  return function DiffLayoutArtwork({ size = 24, color, ...props }) {
    const width = sideBySide ? 5.5 : 14
    const height = sideBySide ? 11 : 4.5
    const rx = rounded ? 1.1 : undefined
    return <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width={size} height={size} fill={rounded ? 'none' : color ?? 'currentColor'} {...props}>
      {rounded
        ? <rect x="2.75" y="3.75" width="18.5" height="16.5" rx="3" fill="none" stroke={color ?? 'currentColor'} strokeWidth={UI_ICON_STROKE} />
        : <path fillRule="evenodd" d="M2 3H22V21H2ZM4 5H20V19H4Z" />}
      <rect x="5" y="6.5" width={width} height={height} rx={rx} fill="var(--color-rose-400)" />
      <rect x={sideBySide ? 13.5 : 5} y={sideBySide ? 6.5 : 13} width={width} height={height} rx={rx} fill="var(--color-emerald-400)" />
    </svg>
  }
}

export const DiffStackedSquareArtwork = /* @__PURE__ */ diffLayoutArtwork(false, false)
export const DiffStackedRoundedArtwork = /* @__PURE__ */ diffLayoutArtwork(false, true)
export const DiffSideBySideSquareArtwork = /* @__PURE__ */ diffLayoutArtwork(true, false)
export const DiffSideBySideRoundedArtwork = /* @__PURE__ */ diffLayoutArtwork(true, true)

/** Modified-file mark with the same 18-unit frame and weight as the add box. */
export function SquareDotArtwork({ size = 24, color, ...props }: AppArtworkProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill={color ?? 'currentColor'}
      {...props}
    >
      <path fillRule="evenodd" d="M3 3H21V21H3ZM5 5H19V19H5Z" />
      <circle cx="12" cy="12" r="2" />
    </svg>
  )
}

/** Pin: Phosphor's PushPin, the mark a pinned session, a pinned picture-in-
 * picture window and the always-on-top titlebar control share. Path data is
 * vendored verbatim from `@phosphor-icons/react` 2.1.10 (MIT, see
 * public/licenses/phosphor-icons.txt) on its native 256 grid: filled geometry,
 * no stroke, and no rescaling that would redraw the shipped shape. */
export function PinArtwork({ size = 24, color, ...props }: AppArtworkProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 256 256"
      width={size}
      height={size}
      fill={color ?? 'currentColor'}
      {...props}
    >
      <path d="M216,168h-9.29L185.54,48H192a8,8,0,0,0,0-16H64a8,8,0,0,0,0,16h6.46L49.29,168H40a8,8,0,0,0,0,16h80v56a8,8,0,0,0,16,0V184h80a8,8,0,0,0,0-16ZM86.71,48h82.58l21.17,120H65.54Z" />
    </svg>
  )
}

/** PinOff: Phosphor's PushPinSlash, the same pin with the slash that reads as
 * "not pinned". Vendored from the same release and canvas as `PinArtwork`. */
export function PinOffArtwork({ size = 24, color, ...props }: AppArtworkProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 256 256"
      width={size}
      height={size}
      fill={color ?? 'currentColor'}
      {...props}
    >
      <path d="M83.25,40a8,8,0,0,1,8-8H192a8,8,0,0,1,0,16h-6.46l18.75,106.3a8,8,0,0,1-6.48,9.26,7.52,7.52,0,0,1-1.4.13,8,8,0,0,1-7.87-6.61L169.29,48h-78A8,8,0,0,1,83.25,40ZM213.38,221.92a8,8,0,0,1-11.3-.54L168.1,184H136v56a8,8,0,0,1-16,0V184H40a8,8,0,0,1,0-16h9.29L66.24,72,42.08,45.38A8,8,0,1,1,53.92,34.62l160,176A8,8,0,0,1,213.38,221.92ZM153.55,168,79.84,86.92,65.54,168Z" />
    </svg>
  )
}
