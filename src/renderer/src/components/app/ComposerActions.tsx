import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { ChevronRight, Loader2, Plus, Skills } from '@/lib/icons'
import { Button } from '@/components/motion/button'
import { MorphPopover, MorphPopoverContent, MorphPopoverTrigger } from '@/components/motion/popover-morph'
import type { PromptAction } from '@/components/agents/prompt-input'
import { useOverlayMotion } from '@/lib/overlay-motion'
import { PresenceGate } from '@/lib/presence-gate'
import { cn } from '@/lib/utils'
import { useI18n } from '@/i18n'
import type { SkillInfoDTO } from '../../../../shared/types'
import { FadeScroll } from './FadeScroll'

interface ComposerActionsProps {
  actions: PromptAction[]
  onAction: (action: string) => void
  onSkillSelect: (name: string) => void
  sessionPath: string | null
  initializing: boolean
  disabled: boolean
}

type SkillMenu = { status: 'loading' | 'ready' | 'error'; skills: SkillInfoDTO[] }
const ROW = 'h-auto w-full justify-start gap-2.5 rounded-control px-2.5 py-2 text-left text-sm'

function navigateMenu(event: KeyboardEvent<HTMLDivElement>) {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'))
  if (!items.length) return
  event.preventDefault()
  event.stopPropagation()
  const current = items.indexOf(document.activeElement as HTMLButtonElement)
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
    : current < 0 ? 0 : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
  items[next].focus({ preventScroll: true })
  items[next].scrollIntoView({ block: 'nearest' })
}

/** Both levels share one popover so submenu clicks remain inside its owner. */
export function ComposerActions({ actions, onAction, onSkillSelect, sessionPath, initializing, disabled }: ComposerActionsProps) {
  const { t } = useI18n()
  const skillsId = useId()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const skillTriggerRef = useRef<HTMLButtonElement>(null)
  const skillsRef = useRef<HTMLDivElement>(null)
  const [open, setInternalOpen] = useState(false)
  const [skillsOpen, setSkillsOpen] = useState(false)
  const [skillMenu, setSkillMenu] = useState<SkillMenu>({ status: 'loading', skills: [] })
  const [placement, setPlacement] = useState<{ side: 'left' | 'right'; top: number }>({ side: 'right', top: 0 })
  const overlay = useOverlayMotion(placement.side)

  const setOpen = useCallback((next: boolean) => {
    if (!next) {
      if (menuRef.current?.contains(document.activeElement)) triggerRef.current?.focus({ preventScroll: true })
      setSkillsOpen(false)
    }
    setInternalOpen(next)
  }, [])

  useEffect(() => { setOpen(false) }, [sessionPath, disabled, setOpen])

  useEffect(() => {
    if (!open) return
    const frame = requestAnimationFrame(() => {
      if (skillTriggerRef.current?.getAttribute('aria-expanded') !== 'true') {
        menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true })
      }
    })
    return () => cancelAnimationFrame(frame)
  }, [open])

  useEffect(() => {
    if (!skillsOpen) return
    let cancelled = false
    setSkillMenu({ status: 'loading', skills: [] })
    // Read the active session's live loader on each opening, including skills
    // excluded from automatic model invocation. Discard a superseded response.
    void window.pi.toolsCatalog().then(catalog => {
      if (!cancelled) setSkillMenu({ status: 'ready', skills: [...catalog.skills].sort((a, b) => a.name.localeCompare(b.name)) })
    }).catch(() => {
      if (!cancelled) setSkillMenu({ status: 'error', skills: [] })
    })
    return () => { cancelled = true }
  }, [skillsOpen, sessionPath])

  useEffect(() => {
    if (!skillsOpen) return
    const panel = skillsRef.current
    const first = panel?.querySelector<HTMLButtonElement>('button')
    ;(first ?? panel)?.focus({ preventScroll: true })
  }, [skillsOpen, skillMenu.status])

  useLayoutEffect(() => {
    if (!skillsOpen) return
    const menu = menuRef.current, row = skillTriggerRef.current, panel = skillsRef.current
    if (!menu || !row || !panel) return
    const update = () => {
      const rect = menu.getBoundingClientRect()
      const rightRoom = window.innerWidth - rect.right - 16
      const leftRoom = rect.left - 16
      const side = rightRoom < panel.offsetWidth && leftRoom > rightRoom ? 'left' : 'right'
      const top = Math.max(8, Math.min(rect.top + row.offsetTop, window.innerHeight - panel.offsetHeight - 8)) - rect.top
      setPlacement(previous => previous.side === side && previous.top === top ? previous : { side, top })
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(menu); observer.observe(panel)
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [skillsOpen])

  const closeSkills = () => {
    skillTriggerRef.current?.focus({ preventScroll: true })
    setSkillsOpen(false)
  }

  return (
    <MorphPopover open={open} onOpenChange={setOpen}>
      <MorphPopoverTrigger>
        <Button ref={triggerRef} type="button" variant="ghost" size="icon" disabled={disabled}
          data-composer-actions-trigger="" aria-label={t('composer.addToPrompt')} className="size-8">
          <motion.span aria-hidden="true" animate={{ rotate: open ? 45 : 0 }} transition={overlay.transition}>
            <Plus className="size-4" />
          </motion.span>
        </Button>
      </MorphPopoverTrigger>
      <MorphPopoverContent side="top" align="start" sideOffset={8} radius="var(--app-radius-card)" className="w-56 overflow-visible">
        <div ref={menuRef} data-composer-actions-menu="" className="relative p-1.5">
          <div onKeyDown={event => {
            if (event.key === 'Escape') {
              event.preventDefault(); event.stopPropagation(); setOpen(false)
            } else if (event.key === 'Tab') setOpen(false)
            else navigateMenu(event)
          }}>
            {actions.map(action => (
              <Button key={action.value} type="button" variant="ghost" size="sm" disabled={action.disabled}
                data-composer-action={action.value} className={ROW}
                onClick={() => { setOpen(false); onAction(action.value) }}>
                {action.icon ? <span aria-hidden="true" className="grid size-5 shrink-0 place-items-center text-muted-foreground [&_svg]:size-4">{action.icon}</span> : null}
                <span className="min-w-0 flex-1 text-foreground">{action.label}</span>
              </Button>
            ))}
            <Button ref={skillTriggerRef} type="button" variant="ghost" size="sm" className={ROW}
              disabled={initializing || !sessionPath} data-composer-action="add-skill"
              aria-haspopup="menu" aria-expanded={skillsOpen} aria-controls={skillsOpen ? skillsId : undefined}
              onKeyDown={event => {
                if (event.key === 'ArrowRight') { event.preventDefault(); setSkillsOpen(true) }
              }}
              onClick={() => skillsOpen ? closeSkills() : setSkillsOpen(true)}>
              <span aria-hidden="true" className="grid size-5 shrink-0 place-items-center text-muted-foreground [&_svg]:size-4"><Skills /></span>
              <span className="min-w-0 flex-1">{t('composer.addSkill')}</span>
              <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
            </Button>
          </div>
          <AnimatePresence>
            {skillsOpen ? <PresenceGate>
              {({ gate }) => <motion.div ref={skillsRef} id={skillsId} role="menu" tabIndex={-1}
                aria-label={t('composer.addSkill')} data-composer-skills-menu="" {...overlay} {...gate}
                style={{ ...overlay.style, ...gate.style, top: placement.top }}
                className={cn('absolute w-64 max-w-[calc(100vw-1rem)] rounded-card border border-border bg-background shadow-overlay outline-none',
                  placement.side === 'left' ? 'right-full mr-2' : 'left-full ml-2')}
                onKeyDown={event => {
                  if (event.key === 'Escape' || event.key === 'ArrowLeft') {
                    event.preventDefault(); event.stopPropagation(); closeSkills()
                  } else if (event.key === 'Tab') { event.stopPropagation(); setOpen(false) }
                  else navigateMenu(event)
                }}>
                <FadeScroll className="max-h-[min(20rem,calc(100dvh-1rem))] overscroll-contain p-1.5">
                  {skillMenu.status === 'loading' ? <p role="status" className="flex items-center gap-2 px-2.5 py-2 text-xs text-muted-foreground">
                    <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />{t('settings.skillsLoading')}
                  </p> : skillMenu.status === 'error' ? <p role="alert" className="px-2.5 py-2 text-xs text-muted-foreground">{t('settings.skillsLoadFailed')}</p>
                    : skillMenu.skills.length === 0 ? <p className="px-2.5 py-2 text-xs text-muted-foreground">{t('settings.skillsEmpty')}</p>
                      : skillMenu.skills.map(skill => <Button key={skill.filePath} type="button" variant="ghost" size="sm" role="menuitem"
                        data-skill-name={skill.name} title={skill.description} className={ROW}
                        onClick={() => { setOpen(false); onSkillSelect(skill.name) }}>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate">{skill.name}</span>
                          {skill.description ? <span className="block truncate text-xs font-normal text-muted-foreground">{skill.description}</span> : null}
                        </span>
                      </Button>)}
                </FadeScroll>
              </motion.div>}
            </PresenceGate> : null}
          </AnimatePresence>
        </div>
      </MorphPopoverContent>
    </MorphPopover>
  )
}
