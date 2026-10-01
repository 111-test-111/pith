import { forwardRef, type ReactNode } from 'react'
import { motion, type SVGMotionProps } from 'motion/react'
import {
  Cancel01Icon,
  CheckIcon,
  CheckmarkCircle02Icon,
  LoaderCircleIcon,
  MinusSignIcon
} from '@hugeicons/core-free-icons'
import { UI_ICON_SIZE, UI_ICON_STROKE } from './icon-metrics'

// beUI owns the pathLength animation; the pack owns the SVG geometry. Import
// those same Stroke Rounded drawings instead of copying another family's paths.
const artwork = {
  check: CheckIcon,
  minus: MinusSignIcon,
  cancel: Cancel01Icon,
  complete: CheckmarkCircle02Icon,
  spinner: LoaderCircleIcon
} as const

const MOTION_TAGS = {
  path: motion.path,
  circle: motion.circle
} as const

type Artwork = keyof typeof artwork
type DrawProps = Pick<SVGMotionProps<SVGPathElement>, 'initial' | 'animate' | 'transition'>

export function IconPaths({ icon, ...props }: { icon: Artwork } & SVGMotionProps<SVGPathElement>) {
  return artwork[icon].map(([tag, attributes], index) => {
    const Tag = MOTION_TAGS[tag as keyof typeof MOTION_TAGS]
    return <Tag {...attributes} {...props} key={attributes.key ?? index} />
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
    width={UI_ICON_SIZE.normal}
    height={UI_ICON_SIZE.normal}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={UI_ICON_STROKE}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
    data-app-icon={icon}
    data-icon-family="hugeicons"
    {...props}
  >
    <IconPaths icon={icon} {...draw} strokeWidth={props.strokeWidth ?? UI_ICON_STROKE} />
    {children}
  </motion.svg>
))
AnimatedIcon.displayName = 'AnimatedIcon'
