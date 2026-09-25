import { forwardRef, type ReactNode } from 'react'
import { motion, type SVGMotionProps } from 'motion/react'

// Animated marks use centerline geometry because beUI draws them with a
// pathLength transition. Phosphor's regular icons are fill paths, so each mark
// carries a compact line-art equivalent on the app's 24px animation grid,
// reduced from Phosphor's 256 grid to the centerlines the draw-in needs.
type Node = { tag: 'path'; d: string } | { tag: 'circle'; cx: number; cy: number; r: number }

const artwork = {
  check: [{ tag: 'path', d: 'M3.75 13.5 9 18.75 20.5 7.25' }],
  minus: [{ tag: 'path', d: 'M3.75 12h16.5' }],
  cancel: [
    { tag: 'path', d: 'M5.25 5.25 18.75 18.75' },
    { tag: 'path', d: 'M18.75 5.25 5.25 18.75' }
  ],
  complete: [
    { tag: 'circle', cx: 12, cy: 12, r: 9.75 },
    { tag: 'path', d: 'm7.75 12.5 2.25 2.25 5.25-5.25' }
  ],
  spinner: [{ tag: 'path', d: 'M12 3v3m9 6h-3m-.64 5.36-2.12-2.12M12 21v-3m-5.36-.64 2.12-2.12M3 12h3m.64-5.36 2.12 2.12' }]
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
    stroke="currentColor"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
    data-app-icon={icon}
    {...props}
  >
    <IconPaths icon={icon} {...draw} strokeWidth={props.strokeWidth ?? 2} />
    {children}
  </motion.svg>
))
AnimatedIcon.displayName = 'AnimatedIcon'
