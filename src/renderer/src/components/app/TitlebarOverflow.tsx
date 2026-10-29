import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { Button } from '@/components/motion/button'
import { Tooltip } from '@/components/motion/tooltip'
import { ChevronLeft } from '@/lib/icons'
import { EASE_OUT } from '@/lib/ease'
import { useDismiss } from '@/lib/hooks/use-dismiss'
import { cn } from '@/lib/utils'
import { useI18n } from '@/i18n'

export interface TitlebarAction {
  /** Stable id; also the `data-titlebar-action` marker a check targets. */
  id: string
  /** Already-localized text, used as both the tooltip and the accessible name. */
  label: string
  icon: ReactNode
  onSelect: () => void
  disabled?: boolean
  pressed?: boolean
}

/**
 * The title row's pocket for actions added after its original toolbar.
 *
 * The row itself keeps the controls a user reaches for without looking: every
 * later action goes in here instead, behind one chevron that leads the row's
 * right-hand action group. It rests collapsed, and clicking unfolds the pocket
 * LEFTWARD — the chevron holds its position, and the buttons that follow it in
 * the row never move — so a growing command set can never crowd the row or
 * shift the controls beside it.
 *
 * Collapsed, the pocket is unmounted: its buttons must not be tabbable at zero
 * width, and an invisible control that still takes focus is worse than a slower
 * reveal. Escape and an outside press close it; Escape synthesizes the close
 * before anything else on the page can read it (the composer's Esc-to-stop
 * checks `defaultPrevented`), because a surface the user is looking at owns the
 * key over a run that keeps going.
 */
export function TitlebarOverflow({ actions, className }: {
  actions: readonly TitlebarAction[]
  className?: string
}) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const reduce = useReducedMotion()
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const close = useCallback(() => setOpen(false), [])
  // Escape is handled here rather than by `useDismiss` so closing can hand
  // focus back to the chevron; the outside press still comes from the shared hook.
  useDismiss(open, close, root, { escape: false })
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented) return
      event.preventDefault()
      trigger.current?.focus()
      close()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [open, close])
  if (!actions.length) return null
  return (
    <div
      ref={root}
      data-titlebar-overflow={open ? 'open' : 'closed'}
      className={cn('flex items-center', className)}
    >
      <AnimatePresence initial={false}>
        {open ? (
          <motion.div
            key="pocket"
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: 'auto', opacity: 1 }}
            exit={{ width: 0, opacity: 0 }}
            transition={reduce ? { duration: 0 } : { duration: 0.22, ease: EASE_OUT }}
            // The pocket clips what it reveals; its content is `w-max`, so the
            // buttons slide out from behind the chevron instead of being
            // squeezed by the shrinking box.
            className="flex items-center overflow-hidden"
          >
            <div className="flex w-max items-center gap-1 pr-1">
              {actions.map((action) => (
                <Tooltip key={action.id} content={action.label}>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8"
                    data-titlebar-action={action.id}
                    aria-label={action.label}
                    aria-pressed={action.pressed}
                    disabled={action.disabled}
                    onClick={() => {
                      close()
                      action.onSelect()
                    }}
                  >
                    {action.icon}
                  </Button>
                </Tooltip>
              ))}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
      <Tooltip content={t(open ? 'titlebar.fewerActions' : 'titlebar.moreActions')}>
        <Button
          ref={trigger}
          variant="ghost"
          size="icon"
          className="size-8"
          aria-label={t(open ? 'titlebar.fewerActions' : 'titlebar.moreActions')}
          aria-expanded={open}
          data-titlebar-more
          onClick={() => setOpen((value) => !value)}
        >
          <ChevronLeft
            aria-hidden="true"
            className={cn('size-4', !reduce && 'transition-transform duration-200 ease-out', open && 'rotate-180')}
          />
        </Button>
      </Tooltip>
    </div>
  )
}
