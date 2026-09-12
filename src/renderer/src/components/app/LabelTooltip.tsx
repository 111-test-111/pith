import { Tooltip, type TooltipProps } from '@/components/motion/tooltip'
import { cn } from '@/lib/utils'

/**
 * beUI `Tooltip` for a label the app derives from data — a path, a cwd, a
 * prompt, a queued message — rather than a fixed interface string.
 *
 * - An absent label leaves the markup exactly as it was instead of opening an
 *   empty bubble: a terminal tab has no cwd until its PTY reports one.
 * - `wrap` relaxes the vendored bubble's `whitespace-nowrap`, which would
 *   render a path or a prompt as one very wide line.
 */
export function LabelTooltip({
  content,
  children,
  wrap = false,
  className,
  ...rest
}: TooltipProps & { wrap?: boolean }) {
  if (content === null || content === undefined || content === '') return children
  return (
    <Tooltip
      content={content}
      className={cn(wrap && 'max-w-80 text-left break-words whitespace-normal', className)}
      {...rest}
    >
      {children}
    </Tooltip>
  )
}
