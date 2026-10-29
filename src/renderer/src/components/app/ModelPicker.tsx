import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'motion/react'
import { Check } from '@/lib/icons'
import { Button } from '@/components/motion/button'
import { useI18n } from '@/i18n'
import type { MessageKey } from '@/i18n/locales/en'
import { useOverlayMotion } from '@/lib/overlay-motion'
import { PresenceGate } from '@/lib/presence-gate'
import { cn } from '@/lib/utils'
import { ProviderIcon } from './ProviderIcon'
import { ModelInputBadges } from './ModelInputBadges'
import type { ModelDTO, ThinkingLevel } from '../../../../shared/types'

type Translate = ReturnType<typeof useI18n>['t']

/** i18n keys for the SDK's thinking-level ids. */
const THINKING_KEYS: Record<ThinkingLevel, MessageKey> = {
  off: 'thinking.off',
  minimal: 'thinking.minimal',
  low: 'thinking.low',
  medium: 'thinking.medium',
  high: 'thinking.high',
  xhigh: 'thinking.xhigh',
  max: 'thinking.max'
}

function levelLabel(t: Translate, level: ThinkingLevel): string {
  return t(THINKING_KEYS[level])
}

interface ModelPickerProps {
  models: readonly ModelDTO[]
  /** `providerId/modelId` of the active model, or null before a session. */
  value: string | null
  thinkingLevel?: ThinkingLevel | null
  /** Levels the ACTIVE model supports (SDK getAvailableThinkingLevels). */
  availableThinkingLevels?: readonly ThinkingLevel[]
  onChange: (model: ModelDTO) => void | Promise<void>
  /** Omit for preferences that select only a model, without a thinking submenu. */
  onThinkingLevelChange?: (level: ThinkingLevel) => void
  /** Scheduled tasks can leave either override unset. Composer omits these. */
  onInheritModel?: () => void
  onInheritThinking?: () => void
  inheritLabel?: string
  /** Forms may inherit a model while leaving thinking independently unset. */
  inheritThinkingLabel?: string
  /** Keep a saved model visible when it is absent from the current catalog. */
  unknownModelLabel?: string
  /** Trigger type scale. The composer keeps its 12px control type; the
   * scheduled-task form passes the form's own scale (14px). */
  textClassName?: string
  /** Menu options can follow a settings surface's compact control scale. */
  optionTextClassName?: string
  /** Portalled placement keeps this exact picker usable inside a modal scrollport. */
  portal?: boolean
  /** Separate simultaneous picker instances keep distinct ARIA panel targets. */
  panelId?: string
  ariaLabel?: string
  className?: string
  triggerClassName?: string
  disabled?: boolean
}

const modelKey = (model: { providerId: string; id: string }) => `${model.providerId}/${model.id}`

const NO_THINKING_LEVELS: readonly ThinkingLevel[] = []
const ROW = 'flex h-auto w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm font-normal outline-none transition-colors disabled:pointer-events-none disabled:opacity-50'

/**
 * One trigger, two cascaded panels: the first lists the models, and picking a
 * reasoning model pops the thinking-level list out BESIDE it, so both choices
 * live in a single surface. The level panel hangs off the model panel with a
 * tight 4px gap — close enough to read as one menu. It is anchored to one row,
 * so scrolling the model list dismisses it rather than sliding it along. Layout-anchored like the
 * sandbox picker beside it (`absolute` against the trigger's own box, no
 * portal): the composer moves in ways no window resize or scroll reports
 * (see `check-composer-pickers.mjs`'s panel drag), and a portalled panel
 * would drift away from its trigger.
 *
 * Picking a model applies it immediately (same as the old two-picker flow)
 * and opens the level panel with the session's SDK-authoritative
 * `availableThinkingLevels`; those describe the PREVIOUS model until the
 * switch's snapshot lands, so the level panel mounts only once the target's
 * levels arrive. A model without
 * reasoning (or with nothing but "off") just applies and closes. The level
 * panel opens to the right of the model panel, flipping left at the viewport
 * edge, and is vertically centered on the clicked row (clamped to the viewport).
 */
export function ModelPicker({
  models,
  value,
  thinkingLevel = null,
  availableThinkingLevels = NO_THINKING_LEVELS,
  onChange,
  onThinkingLevelChange,
  onInheritModel,
  onInheritThinking,
  inheritLabel,
  inheritThinkingLabel,
  unknownModelLabel,
  textClassName = 'text-xs',
  optionTextClassName = 'text-sm',
  portal = false,
  panelId,
  ariaLabel,
  className,
  triggerClassName,
  disabled
}: ModelPickerProps) {
  const { t } = useI18n()
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const submenuRef = useRef<HTMLDivElement>(null)
  const [open, setInternalOpen] = useState(false)
  const setOpen = useCallback((next: boolean) => {
    if (!next && panelRef.current?.contains(document.activeElement)) {
      triggerRef.current?.focus({ preventScroll: true })
    }
    setInternalOpen(next)
  }, [])
  const [placement, setPlacement] = useState<'top' | 'bottom'>('bottom')
  const [panelHeight, setPanelHeight] = useState(0)
  /** Keep the row itself: it may scroll while the model snapshot is in flight. */
  const [submenu, setSubmenu] = useState<{ key: string | null; row: HTMLButtonElement } | null>(null)
  const [submenuPosition, setSubmenuPosition] = useState<{ top: number; side: 'left' | 'right' }>({ top: 0, side: 'right' })
  /**
   * Model key whose snapshot is in flight. Cleared in a render-phase adjust
   * the moment `value` becomes that key (the snapshot landed); the ref-free
   * state keeps the level rows' disabled state honest in that exact render.
   */
  const [pendingModel, setPendingModel] = useState<string | null>(null)
  const [floatingPosition, setFloatingPosition] = useState({ left: 0, top: 0 })
  if (pendingModel !== null && pendingModel === value) setPendingModel(null)

  const grouped = useMemo(() => {
    const byProvider = new Map<string, { providerName: string; models: ModelDTO[] }>()
    for (const model of models) {
      if (!model.available) continue
      const entry = byProvider.get(model.providerId) ?? {
        providerName: model.providerName || model.providerId,
        models: []
      }
      entry.models.push(model)
      byProvider.set(model.providerId, entry)
    }
    return [...byProvider.entries()]
      .map(([providerId, entry]) => ({
        providerId,
        providerName: entry.providerName,
        models: entry.models.sort((a, b) => a.name.localeCompare(b.name))
      }))
      .sort((a, b) => a.providerName.localeCompare(b.providerName))
  }, [models])

  const current = useMemo(
    () => models.find((m) => modelKey(m) === value) ?? null,
    [models, value]
  )

  const switching = pendingModel !== null
  const showLevel = Boolean(onThinkingLevelChange && (current?.reasoning || (onInheritModel && value === null)) && availableThinkingLevels.length > 1)
  const showSubmenu = open && submenu !== null && submenu.key === value && !switching && showLevel
  const submenuSide = submenuPosition.side
  const overlay = useOverlayMotion(placement)
  const submenuOverlay = useOverlayMotion(submenuSide)

  // Measure the full resting surface, including padding and borders. Scaling
  // never changes offsetHeight, so placement stays steady during the entrance.
  const measurePanel = () => panelRef.current?.offsetHeight ?? 0

  useLayoutEffect(() => {
    if (!open) return
    const measure = () => setPanelHeight(measurePanel())
    measure()
    const observer = new ResizeObserver(measure)
    if (listRef.current) observer.observe(listRef.current)
    return () => observer.disconnect()
  }, [open])

  useLayoutEffect(() => {
    if (!open) return
    const trigger = triggerRef.current
    if (!trigger) return
    const rect = trigger.getBoundingClientRect()
    const below = window.innerHeight - rect.bottom
    const above = rect.top
    setPlacement(below < panelHeight + 16 && above > below ? 'top' : 'bottom')
  }, [open, panelHeight])

  useLayoutEffect(() => {
    if (!open || !portal) return
    const update = () => {
      const rect = triggerRef.current?.getBoundingClientRect()
      if (!rect) return
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - 328))
      const top = placement === 'top' ? rect.top - panelHeight - 8 : rect.bottom + 8
      setFloatingPosition((previous) => previous.left === left && previous.top === top ? previous : { left, top })
    }
    update()
    window.addEventListener('scroll', update, true)
    window.addEventListener('resize', update)
    return () => {
      window.removeEventListener('scroll', update, true)
      window.removeEventListener('resize', update)
    }
  }, [open, portal, placement, panelHeight])

  // Outside pointer / Escape close the whole cascade.
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setOpen(false)
      setSubmenu(null)
    }
    const onPointer = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node) && !panelRef.current?.contains(event.target as Node)) {
        setOpen(false)
        setSubmenu(null)
      }
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('pointerdown', onPointer)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('pointerdown', onPointer)
    }
  }, [open, setOpen])

  // Measure the final level list before its first paint. Center on the actual
  // visible row, allowing the submenu to extend above/below the model panel;
  // only the viewport can displace it. Both panels stay layout-anchored.
  useLayoutEffect(() => {
    if (!submenu || switching || submenu.key !== value) return
    if (!showLevel) {
      setSubmenu(null)
      setOpen(false)
      return
    }
    const panel = panelRef.current
    const sub = submenuRef.current
    if (!panel || !sub) return
    const measure = () => {
      const panelBox = panel.getBoundingClientRect()
      const rowBox = submenu.row.getBoundingClientRect()
      // Undo the model panel's entrance scale before writing layout pixels.
      const scale = panelBox.height / panel.offsetHeight || 1
      const center = (rowBox.top + rowBox.height / 2 - panelBox.top) / scale - panel.clientTop
      const minTop = (8 - panelBox.top) / scale - panel.clientTop
      const maxTop = (window.innerHeight - 8 - panelBox.top) / scale - panel.clientTop - sub.offsetHeight
      const top = Math.max(minTop, Math.min(center - sub.offsetHeight / 2, maxTop))
      const side = panelBox.right + (sub.offsetWidth + 4) * scale <= window.innerWidth ? 'right' : 'left'
      setSubmenuPosition((previous) => previous.top === top && previous.side === side ? previous : { top, side })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(panel)
    observer.observe(sub)
    window.addEventListener('resize', measure)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [submenu, switching, value, showLevel, placement])

  // Scrolling the model list moves every row under the level panel's anchor.
  // The cascade closes instead of drifting along: the panel is positioned
  // against one row, and a scrolled list no longer says which one. The offset
  // is compared rather than trusting the event itself, so a scroll event the
  // list already had queued when the panel opened cannot dismiss it.
  useEffect(() => {
    if (!submenu) return
    const list = listRef.current
    if (!list) return
    const openedAt = list.scrollTop
    const onScroll = () => {
      if (list.scrollTop !== openedAt) setSubmenu(null)
    }
    list.addEventListener('scroll', onScroll)
    return () => list.removeEventListener('scroll', onScroll)
  }, [submenu])

  const pickModel = (model: ModelDTO, row: HTMLButtonElement) => {
    const key = modelKey(model)
    const hasLevels = Boolean(onThinkingLevelChange && model.reasoning && (key !== value || availableThinkingLevels.length > 1))
    if (key !== value) {
      if (onThinkingLevelChange) setPendingModel(key)
      void Promise.resolve(onChange(model)).catch(() => setPendingModel(null))
    }
    if (!hasLevels) {
      setSubmenu(null)
      setOpen(false)
      return
    }
    setSubmenu({ key, row })
  }

  const pickLevel = (level: ThinkingLevel) => {
    onThinkingLevelChange?.(level)
    setSubmenu(null)
    setOpen(false)
  }

  const pickInherited = (row: HTMLButtonElement) => {
    onInheritModel?.()
    if (onThinkingLevelChange && availableThinkingLevels.length > 1) setSubmenu({ key: null, row })
    else { setSubmenu(null); setOpen(false) }
  }

  const listId = panelId ?? 'model-picker-panel'

  const panel = (
      <motion.div
        ref={panelRef}
        id={listId}
        role="listbox"
        aria-label={t('model.listAria')}
        aria-hidden={!open}
        inert={!open}
        {...overlay}
        animate={open ? 'open' : 'closed'}
        style={{
          pointerEvents: open ? 'auto' : 'none',
          transformOrigin: placement === 'top' ? 'bottom left' : 'top left',
          ...(portal ? floatingPosition : {}),
          visibility: portal && panelHeight === 0 ? 'hidden' : undefined
        }}
        className={cn(
          portal ? 'fixed z-[110] w-80' : 'absolute left-0 z-20 w-80',
          'rounded-xl border border-border bg-background p-1 shadow-overlay',
          !portal && (placement === 'top' ? 'bottom-full mb-2' : 'top-full mt-2')
        )}
      >
        <div ref={listRef} className="max-h-80 overflow-y-auto">
          {onInheritModel ? (
            <Button variant="ghost"
              type="button"
              role="option"
              aria-selected={value === null}
              onClick={(event) => pickInherited(event.currentTarget)}
              className={cn(ROW, optionTextClassName, value === null ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted')}
            >
              <span>{inheritLabel ?? t('model.choose')}</span>
              {value === null ? <Check className="h-3.5 w-3.5 shrink-0" /> : null}
            </Button>
          ) : null}
          {grouped.map((group, index) => (
            <div key={group.providerId}>
              {index > 0 ? <div aria-hidden className="mx-1 my-1 h-px bg-border" /> : null}
              <div className="flex items-center gap-1.5 px-2.5 pb-0.5 pt-1.5 text-micro font-medium uppercase tracking-wide text-muted-foreground">
                <ProviderIcon providerId={group.providerId} name={group.providerName} size={12} />
                <span className="truncate">{group.providerName}</span>
                <span className="ml-auto font-normal normal-case">{group.models.length}</span>
              </div>
              {group.models.map((model) => {
                const key = modelKey(model)
                const selected = key === value
                return (
                  <Button variant="ghost"
                    key={key}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    data-model-option={key}
                    onClick={(event) => pickModel(model, event.currentTarget)}
                    className={cn(
                      ROW,
                      optionTextClassName,
                      selected
                        ? 'bg-muted text-foreground'
                        : 'text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:bg-muted'
                    )}
                  >
                    {/* Name/meta column, with the inputs it accepts stated
                        in the meta line. */}
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className={cn('truncate text-foreground', optionTextClassName)}>{model.name}</span>
                      <span className="flex min-w-0 items-center gap-1 text-caption text-muted-foreground">
                        <span className="truncate">
                          {model.reasoning ? t('model.reasoning') : t('model.standard')}
                          {model.contextWindow
                            ? ` · ${t('model.contextK', { k: Math.round(model.contextWindow / 1000) })}`
                            : ''}
                        </span>
                        <ModelInputBadges input={model.input} />
                      </span>
                    </span>
                    {selected ? <Check className="h-3.5 w-3.5 shrink-0" /> : null}
                  </Button>
                )
              })}
            </div>
          ))}
          {grouped.length === 0 ? (
            <p className="px-3 py-6 text-center text-xs text-muted-foreground">
              {t('model.noProviders')}
            </p>
          ) : null}
        </div>

        <AnimatePresence>
          {showSubmenu ? (
            <PresenceGate key={submenu?.key ?? '__inherit__'}>
              {({ gate }) => (
                <motion.div
                  ref={submenuRef}
                  role="menu"
                  aria-label={t('model.thinkingTitle')}
                  data-thinking-panel=""
                  {...submenuOverlay}
                  {...gate}
                  style={{ ...gate.style, top: submenuPosition.top, transformOrigin: submenuSide === 'right' ? 'center left' : 'center right' }}
                  className={cn(
                    'absolute z-10 w-44 rounded-xl border border-border bg-background p-1 shadow-overlay',
                    submenuSide === 'right' ? 'left-full ml-1' : 'right-full mr-1'
                  )}
                >
                  <div className="px-2.5 pb-0.5 pt-1.5 text-micro font-medium uppercase tracking-wide text-muted-foreground">
                    {t('model.thinkingTitle')}
                  </div>
                  {onInheritThinking ? (
                    <Button variant="ghost"
                      type="button"
                      role="menuitem"
                      aria-checked={thinkingLevel === null}
                      onClick={() => { onInheritThinking(); setSubmenu(null); setOpen(false) }}
                      className={cn(ROW, optionTextClassName, thinkingLevel === null ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted')}
                    >
                      <span>{inheritThinkingLabel ?? inheritLabel ?? t('model.choose')}</span>
                      {thinkingLevel === null ? <Check className="h-3.5 w-3.5 shrink-0" /> : null}
                    </Button>
                  ) : null}
                  {availableThinkingLevels.map((level) => (
                    <Button variant="ghost"
                      key={level}
                      type="button"
                      role="menuitem"
                      aria-checked={level === thinkingLevel}
                      data-thinking-option={level}
                      disabled={switching}
                      onClick={() => pickLevel(level)}
                      className={cn(
                        ROW,
                        optionTextClassName,
                        level === thinkingLevel
                          ? 'bg-muted text-foreground'
                          : 'text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:bg-muted'
                      )}
                    >
                      <span className={cn('truncate text-foreground', optionTextClassName)}>{levelLabel(t, level)}</span>
                      {level === thinkingLevel ? <Check className="h-3.5 w-3.5 shrink-0" /> : null}
                    </Button>
                  ))}
                </motion.div>
              )}
            </PresenceGate>
          ) : null}
        </AnimatePresence>
      </motion.div>
  )

  return (
    <div ref={rootRef} className={cn('relative w-auto', className)}>
      <Button variant="ghost"
        type="button"
        ref={triggerRef}
        disabled={disabled}
        aria-label={ariaLabel ?? t('model.choose')}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => {
          if (open) setSubmenu(null)
          setOpen(!open)
        }}
        className={cn("relative z-10 flex h-8 w-auto items-center justify-between gap-2 rounded-control border-0 bg-transparent px-2.5 font-normal text-foreground outline-none transition-colors hover:bg-muted focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50", textClassName, triggerClassName)}
      >
        <span className="flex min-w-0 items-center gap-1.5 whitespace-nowrap">
          {current ? (
            <ProviderIcon providerId={current.providerId} name={current.providerName} size={14} />
          ) : null}
          <span className="max-w-36 truncate">
            {current ? current.name : (value ? unknownModelLabel : undefined) ?? inheritLabel ?? t('model.choose')}
          </span>
          {showLevel ? (
            <span className="flex min-w-0 items-center gap-1 text-muted-foreground">
              <span aria-hidden="true">·</span>
              <span className="max-w-16 truncate">{thinkingLevel === null ? inheritThinkingLabel ?? inheritLabel ?? t('model.choose') : levelLabel(t, thinkingLevel)}</span>
            </span>
          ) : null}
        </span>
      </Button>

      {portal ? createPortal(panel, document.body) : panel}
    </div>
  )
}
