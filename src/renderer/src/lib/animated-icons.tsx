import { forwardRef, type ReactNode } from 'react'
import { motion, type SVGMotionProps } from 'motion/react'

// Lucide geometry, read out of the pack's own rendered components. Keep beUI's
// stroke drawing and presence transitions while sourcing the geometry here, and
// keep the tag per node: the completion mark is a circle plus a path, so
// rendering everything as `<path>` would drop it.
type Node = { tag: 'path'; d: string } | { tag: 'circle'; cx: number; cy: number; r: number }

const artwork = {
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
} satisfies Record<string, Node[]>

const MOTION_TAGS = {
  path: motion.path,
  circle: motion.circle
} as const

type Artwork = keyof typeof artwork
type DrawProps = Pick<SVGMotionProps<SVGPathElement>, 'initial' | 'animate' | 'transition'>

export function IconPaths({ icon, ...props }: { icon: Artwork } & SVGMotionProps<SVGPathElement>) {
  return artwork[icon].map((node, index) => {
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
