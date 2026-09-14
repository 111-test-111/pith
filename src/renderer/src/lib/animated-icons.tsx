import { forwardRef, type ReactNode } from 'react'
import { motion, type SVGMotionProps } from 'motion/react'
import {
  Cancel01Icon,
  CheckIcon,
  CheckmarkCircle02Icon,
  LoaderCircleIcon,
  MinusSignIcon
} from '@hugeicons/core-free-icons'

// These Stroke Rounded glyphs contain paths only. Keep beUI's stroke drawing
// and presence transitions while sourcing the actual geometry from Hugeicons.
const artwork = {
  check: CheckIcon,
  minus: MinusSignIcon,
  cancel: Cancel01Icon,
  complete: CheckmarkCircle02Icon,
  spinner: LoaderCircleIcon
}

type Artwork = keyof typeof artwork
type DrawProps = Pick<SVGMotionProps<SVGPathElement>, 'initial' | 'animate' | 'transition'>

export function IconPaths({ icon, ...props }: { icon: Artwork } & SVGMotionProps<SVGPathElement>) {
  return artwork[icon].map(([, { key, ...attributes }]) => (
    <motion.path {...attributes} {...props} key={key} />
  ))
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
    <IconPaths icon={icon} {...draw} strokeWidth={props.strokeWidth ?? 1.5} />
    {children}
  </motion.svg>
))
AnimatedIcon.displayName = 'AnimatedIcon'
