// App-owned artwork for meanings the Remix pack does not draw. Every other
// square-style glyph stays a real Remix Line export; this file exists only for
// the gaps, and its drawings keep the family's filled-outline contract: one
// 24-grid, `fill: currentColor`, no stroke.
import type { SVGProps } from 'react'

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
