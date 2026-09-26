import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion, useReducedMotion } from 'motion/react'
import { Check } from '@/lib/icons'
import { useI18n } from '@/i18n'
import type { MessageKey } from '@/i18n/locales/en'
import { EASE_OUT } from '@/lib/ease'
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
  thinkingLevel: ThinkingLevel | null
  /** Levels the ACTIVE model supports (SDK getAvailableThinkingLevels). */
  availableThinkingLevels: readonly ThinkingLevel[]
  onChange: (model: ModelDTO) => void | Promise<void>
  onThinkingLevelChange: (level: ThinkingLevel) => void
  /** Scheduled tasks can leave either override unset. Composer omits these. */
  onInheritModel?: () => void
  onInheritThinking?: () => void
  inheritLabel?: string
  /** Trigger type scale. The composer keeps its 12px control type; the
   * scheduled-task form passes the form's own scale (14px). */
  textClassName?: string
  /** Portalled placement keeps this exact picker usable inside a modal scrollport. */
  portal?: boolean
  /** Separate simultaneous picker instances keep distinct ARIA panel targets. */
  panelId?: string
  disabled?: boolean
}

const modelKey = (model: { providerId: string; id: string }) => `${model.providerId}/${model.id}`

const ROW = 'flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm outline-none transition-colors disabled:pointer-events-none disabled:opacity-50'

/**
 * One trigger, two cascaded panels: the first lists the models, and picking a
 * reasoning model pops the thinking-level list out BESIDE it, so both choices
 * live in a single surface. The level panel hangs off the model panel with a
 * tight 4px gap — close enough to read as one menu. Layout-anchored like the
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
  thinkingLevel,
  availableThinkingLevels,
  onChange,
  onThinkingLevelChange,
  onInheritModel,
  onInheritThinking,
  inheritLabel,
  textClassName = 'text-xs',
  portal = false,
  panelId,
  disabled
}: ModelPickerProps) {
  const { t } = useI18n()
  const reduce = useReducedMotion() ?? false
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const submenuRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
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
  const showLevel = Boolean((current?.reasoning || (onInheritModel && value === null)) && availableThinkingLevels.length > 1)
  const showSubmenu = submenu !== null && submenu.key === value && !switching && showLevel
  const submenuSide = submenuPosition.side

  // The panel animates its BORDER-box height (the inner list scrolls), so the
  // measurement adds the panel's own borders — same accounting as the vendored
  // SelectContent. The trigger usually sits near the window bottom, where the
  // panel flips upward; the height decides while opening.
  const measurePanel = () => {
    const node = listRef.current
    if (!node) return 0
    const panel = node.parentElement
    const styles = panel ? getComputedStyle(panel) : null
    const border = styles
      ? parseFloat(styles.borderTopWidth) + parseFloat(styles.borderBottomWidth)
      : 0
    return node.offsetHeight + (Number.isFinite(border) ? border : 0)
  }

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
  }, [open])

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
    const list = listRef.current
    list?.addEventListener('scroll', measure)
    window.addEventListener('resize', measure)
    return () => {
      observer.disconnect()
      list?.removeEventListener('scroll', measure)
      window.removeEventListener('resize', measure)
    }
  }, [submenu, switching, value, showLevel, placement])

  const pickModel = (model: ModelDTO, row: HTMLButtonElement) => {
    const key = modelKey(model)
    const hasLevels = model.reasoning && (key !== value || availableThinkingLevels.length > 1)
    if (key !== value) {
      setPendingModel(key)
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
    onThinkingLevelChange(level)
    setSubmenu(null)
    setOpen(false)
  }

  const pickInherited = (row: HTMLButtonElement) => {
    onInheritModel?.()
    if (availableThinkingLevels.length > 1) setSubmenu({ key: null, row })
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
        initial={false}
        animate={{
          opacity: open ? 1 : 0,
          y: open ? 0 : placement === 'top' ? 5 : -5,
          scale: open ? 1 : 0.98
        }}
        transition={reduce ? { duration: 0.12 } : { duration: open ? 0.18 : 0.12, ease: EASE_OUT }}
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
            <button
              type="button"
              role="option"
              aria-selected={value === null}
              onClick={(event) => pickInherited(event.currentTarget)}
              className={cn(ROW, value === null ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted')}
            >
              <span>{inheritLabel ?? t('model.choose')}</span>
              {value === null ? <Check className="h-3.5 w-3.5 shrink-0" /> : null}
            </button>
          ) : null}
          {grouped.map((group, index) => (
            <div key={group.providerId}>
              {index > 0 ? <div aria-hidden className="mx-1 my-1 h-px bg-border" /> : null}
              <div className="flex items-center gap-1.5 px-2.5 pb-0.5 pt-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                <ProviderIcon providerId={group.providerId} name={group.providerName} size={12} />
                <span className="truncate">{group.providerName}</span>
                <span className="ml-auto font-normal normal-case">{group.models.length}</span>
              </div>
              {group.models.map((model) => {
                const key = modelKey(model)
                const selected = key === value
                return (
                  <button
                    key={key}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    data-model-option={key}
                    onClick={(event) => pickModel(model, event.currentTarget)}
                    className={cn(
                      ROW,
                      selected
                        ? 'bg-muted text-foreground'
                        : 'text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:bg-muted'
                    )}
                  >
                    {/* Name/meta column, with the inputs it accepts stated
                        in the meta line. */}
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-sm text-foreground">{model.name}</span>
                      <span className="flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground">
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
                  </button>
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

        {showSubmenu ? (
          <motion.div
            key={submenu?.key}
            ref={submenuRef}
            role="menu"
            aria-label={t('model.thinkingTitle')}
            data-thinking-panel=""
            initial={reduce ? { opacity: 0 } : { opacity: 0, x: submenuSide === 'right' ? -5 : 5, scale: 0.98 }}
            animate={reduce ? { opacity: 1 } : { opacity: 1, x: 0, scale: 1 }}
            transition={reduce ? { duration: 0.12 } : { duration: 0.18, ease: EASE_OUT }}
            style={{ top: submenuPosition.top, transformOrigin: submenuSide === 'right' ? 'center left' : 'center right' }}
            className={cn(
              'absolute z-10 w-44 rounded-xl border border-border bg-background p-1 shadow-overlay',
              submenuSide === 'right' ? 'left-full ml-1' : 'right-full mr-1'
            )}
          >
            <div className="px-2.5 pb-0.5 pt-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              {t('model.thinkingTitle')}
            </div>
            {onInheritThinking ? (
              <button
                type="button"
                role="menuitem"
                aria-checked={thinkingLevel === null}
                onClick={() => { onInheritThinking(); setSubmenu(null); setOpen(false) }}
                className={cn(ROW, thinkingLevel === null ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted')}
              >
                <span>{inheritLabel ?? t('model.choose')}</span>
                {thinkingLevel === null ? <Check className="h-3.5 w-3.5 shrink-0" /> : null}
              </button>
            ) : null}
            {availableThinkingLevels.map((level) => (
              <button
                key={level}
                type="button"
                role="menuitem"
                aria-checked={level === thinkingLevel}
                data-thinking-option={level}
                disabled={switching}
                onClick={() => pickLevel(level)}
                className={cn(
                  ROW,
                  level === thinkingLevel
                    ? 'bg-muted text-foreground'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:bg-muted'
                )}
              >
                <span className="truncate text-sm text-foreground">{levelLabel(t, level)}</span>
                {level === thinkingLevel ? <Check className="h-3.5 w-3.5 shrink-0" /> : null}
              </button>
            ))}
          </motion.div>
        ) : null}
      </motion.div>
  )

  return (
    <div ref={rootRef} className="relative w-auto">
      <button
        type="button"
        ref={triggerRef}
        disabled={disabled}
        aria-label={t('model.choose')}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => {
          if (open) setSubmenu(null)
          setOpen(!open)
        }}
        className={cn("relative z-10 flex h-8 w-auto items-center justify-between gap-2 rounded-control border-0 bg-transparent px-2.5 outline-none transition-colors hover:bg-muted focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50", textClassName)}
      >
        <span className="flex min-w-0 items-center gap-1.5 whitespace-nowrap">
          {current ? (
            <ProviderIcon providerId={current.providerId} name={current.providerName} size={14} />
          ) : null}
          <span className="max-w-36 truncate">
            {current ? current.name : inheritLabel ?? t('model.choose')}
          </span>
          {showLevel ? (
            <span className="flex min-w-0 items-center gap-1 text-muted-foreground">
              <span aria-hidden="true">·</span>
              <span className="max-w-16 truncate">{thinkingLevel === null ? inheritLabel ?? t('model.choose') : levelLabel(t, thinkingLevel)}</span>
            </span>
          ) : null}
        </span>
      </button>

      {portal ? (open ? createPortal(panel, document.body) : null) : panel}
    </div>
  )
}
