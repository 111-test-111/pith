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
import { Check, CircleCheck, LoaderCircle, Minus, X } from './icons'
import { useUiStyle } from './ui-style'

// Stroke Rounded can draw its centerlines in; Remix Line's filled outlines reveal
// as a whole. Both branches preserve the pack's actual geometry and weight.
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

const SQUARE_GLYPHS = {
  check: Check,
  minus: Minus,
  cancel: X,
  complete: CircleCheck,
  spinner: LoaderCircle
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
}>(({ icon, draw, children, ...props }, ref) => {
  const [style] = useUiStyle()
  const square = style === 'square'
  const Glyph = SQUARE_GLYPHS[icon]
  const reveal = (value: DrawProps['initial'] | DrawProps['animate']) =>
    value && typeof value === 'object' && 'pathLength' in value
      ? { opacity: value.pathLength }
      : undefined
  // Keep the motion SVG mounted during style switches, including an exit.
  // The nested native SVG fits the common 24-unit animation canvas without
  // rewriting paths; inline sizing prevents ancestor SVG utilities resizing it.
  return (
    <motion.svg
      ref={ref}
      xmlns="http://www.w3.org/2000/svg"
      width={UI_ICON_SIZE.normal}
      height={UI_ICON_SIZE.normal}
      viewBox="0 0 24 24"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      data-app-icon={icon}
      data-icon-family={square ? 'remix' : 'hugeicons'}
      {...props}
      fill={square ? 'currentColor' : props.fill ?? 'none'}
      stroke={square ? 'none' : props.stroke ?? 'currentColor'}
      strokeWidth={square ? undefined : props.strokeWidth ?? UI_ICON_STROKE}
    >
      {square ? (
        <motion.g initial={reveal(draw?.initial)} animate={reveal(draw?.animate)} transition={draw?.transition}>
          <Glyph size={24} style={{ width: '100%', height: '100%' }} data-app-icon={undefined} data-icon-family={undefined} />
        </motion.g>
      ) : (
        <IconPaths icon={icon} {...draw} strokeWidth={props.strokeWidth ?? UI_ICON_STROKE} />
      )}
      {children}
    </motion.svg>
  )
})
AnimatedIcon.displayName = 'AnimatedIcon'
