import { forwardRef, type ReactNode } from 'react'
import { motion, type SVGMotionProps } from 'motion/react'
import {
  Cancel01Icon,
  CheckIcon,
  CheckmarkCircle02Icon,
  LoaderCircleIcon,
  MinusSignIcon
} from '@hugeicons/core-free-icons'
import { useIconPack } from './icon-pack'
import type { IconPack } from './ui-style'

// The animated marks are STROKE geometry: the call sites draw them in with a
// `pathLength` transition, so they have to be outlines rather than filled
// artwork. Carbon's square-style glyphs are fill artwork on a 32 grid, so the
// square column keeps the app-drawn stroke marks this branch already shipped;
// the squircle column draws HugeIcons' stroke-rounded line art. Both keep
// beUI's stroke drawing and presence transitions, and keep the tag per node:
// the completion mark is a ring plus a check, so rendering everything as
// `<path>` would drop it.
type Node = { tag: 'path'; d: string } | { tag: 'circle'; cx: number; cy: number; r: number }

/** One HugeIcons glyph: an SVG tag and its attributes, in document order. */
type HugeGlyph = ReadonlyArray<readonly [string, Record<string, string | number>]>

/** Reduce a HugeIcons glyph to the two node shapes these marks draw. */
function hugeNodes(glyph: HugeGlyph): Node[] {
  return glyph.map(([tag, attrs]): Node => {
    if (tag === 'path') return { tag: 'path', d: String(attrs.d) }
    if (tag === 'circle') {
      return { tag: 'circle', cx: Number(attrs.cx), cy: Number(attrs.cy), r: Number(attrs.r) }
    }
    throw new Error(`animated-icons: unsupported HugeIcons tag ${tag}`)
  })
}

const artwork = {
  carbon: {
    check: [{ tag: 'path', d: 'M20 6 9 17l-5-5' }],
    minus: [{ tag: 'path', d: 'M5 12h14' }],
    cancel: [
      { tag: 'path', d: 'M18 6 6 18' },
      { tag: 'path', d: 'm6 6 12 12' }
    ],
    complete: [
      { tag: 'circle', cx: 12, cy: 12, r: 10 },
      { tag: 'path', d: 'm16 9-5.5 5.5L8 12' }
    ],
    spinner: [{ tag: 'path', d: 'M21 12a9 9 0 1 1-6.219-8.56' }]
  },
  hugeicons: {
    check: hugeNodes(CheckIcon),
    minus: hugeNodes(MinusSignIcon),
    cancel: hugeNodes(Cancel01Icon),
    complete: hugeNodes(CheckmarkCircle02Icon),
    spinner: hugeNodes(LoaderCircleIcon)
  }
} satisfies Record<IconPack, Record<string, Node[]>>

const MOTION_TAGS = {
  path: motion.path,
  circle: motion.circle
} as const

type Artwork = keyof (typeof artwork)['carbon']
type DrawProps = Pick<SVGMotionProps<SVGPathElement>, 'initial' | 'animate' | 'transition'>

export function IconPaths({ icon, ...props }: { icon: Artwork } & SVGMotionProps<SVGPathElement>) {
  const pack = useIconPack()
  return artwork[pack][icon].map((node, index) => {
    const Tag = MOTION_TAGS[node.tag]
    return <Tag {...node} {...props} key={index} />
  })
}

export const AnimatedIcon = forwardRef<SVGSVGElement, Omit<SVGMotionProps<SVGSVGElement>, 'children'> & {
  icon: Artwork
  draw?: DrawProps
  children?: ReactNode
}>(({ icon, draw, children, ...props }, ref) => (
  <motion.svg
    ref={ref}
    xmlns="http://www.w3.org/2000/svg"
    width={24}
    height={24}
    viewBox="0 0 24 24"
    fill="none"
    aria-hidden="true"
    focusable="false"
    data-app-icon={icon}
    {...props}
  >
    {/* Lucide's own default weight, so a drawn mark matches an imported glyph. */}
    <IconPaths icon={icon} {...draw} strokeWidth={props.strokeWidth ?? 2} />
    {children}
  </motion.svg>
))
AnimatedIcon.displayName = 'AnimatedIcon'
