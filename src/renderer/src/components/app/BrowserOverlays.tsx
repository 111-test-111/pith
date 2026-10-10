import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import type { JSX } from 'react'
import { Globe, History, MoreVertical, Printer, Search, Smartphone, Trash2, type IconComponent } from '@/lib/icons'
import { Button } from '@/components/motion/button'
import { Input } from '@/components/motion/input'
import { RunningLoader } from './RunningLoader'
import { MorphPopover, MorphPopoverContent } from '@/components/motion/popover-morph'
import { Tooltip } from '@/components/motion/tooltip'
import { useI18n } from '@/i18n'
import {
  CUSTOM_DEVICE_ID,
  DEVICE_NONE_ID,
  DEVICE_PRESETS,
  INITIAL_DEVICE_STATE,
  commitDeviceSize,
  findDevicePreset,
  resolveDevicePresetId,
  sanitizeDeviceDigits,
  type DeviceEmulationState
} from '@/lib/browser/device'
import {
  clearBrowserHistory,
  getBrowserHistory,
  subscribeBrowserHistory,
  type BrowserHistoryEntry
} from '@/lib/browser/session'
import { cn } from '@/lib/utils'

/** Second-click deadline of the two-step clear-history confirm. */
const CLEAR_CONFIRM_MS = 5_000

/** After a successful clear-data the note lingers 3s, then the panel closes
 *  itself (spec: transient note + auto-close). */
const CLEAR_DONE_CLOSE_MS = 3_000

/** Menu entry shape — Ruling C: entries are data, so Task 14's device emulation /
 *  clear-data additions are new array items, not new markup. The clear-data
 *  entry is the first one that changes costume in place (confirm tint, busy
 *  spinner), so the shape grows the three optional flags it needs. */
interface BrowserMenuEntry {
  id: string
  icon: IconComponent
  label: string
  onSelect: () => void
  /** Destructive tint (the confirm costume of clear-data). */
  destructive?: boolean
  /** Disabled while the clear round trip is in flight. */
  disabled?: boolean
  /** Icon slot renders the beUI spinner instead of the entry glyph. */
  busy?: boolean
}

/**
 * The selected page's ⋮ overflow menu (Task 13, Ruling C menu shell): the
 * toolbar's last control opens one beUI `MorphPopover` anchored to it. The
 * entries are a simple growable array and the history entry swaps the SAME
 * panel's content over to the history list — one portal, one anchor, one
 * dismissal surface, so outside press and Escape close both views through the
 * vendored component's own handlers.
 *
 * `onFind`/`onPrint`/`onNavigate` are the SELECTED page's callbacks — the very
 * function references BrowserPageView binds into `BrowserPageActions` for the
 * pane-level ⌘F/⌘P shortcuts — so a menu entry rides exactly the path the
 * keyboard shortcuts (and the guest relay) use.
 */
export function BrowserOverlays({
  onFind,
  onPrint,
  onNavigate,
  device,
  onDeviceChange
}: {
  onFind: () => void
  onPrint: () => void
  /** The toolbar's whitelist-gated navigation; returns the normalized url or
   *  null when the parse/whitelist/guest rejected it. */
  onNavigate: (raw: string) => string | null
  /** Device-emulation state (T14): owned by the page view (selection-scoped,
   *  not persisted), edited through the device sub-view. */
  device: DeviceEmulationState
  onDeviceChange: (next: DeviceEmulationState) => void
}): JSX.Element {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  // Synchronous mirror of `open`: the clear-data round trip may resolve after
  // the user already dismissed the popover, and its handlers must see CLOSED
  // at that moment — not after the next passive-effect flush. Every open/
  // close path routes through setOpenTracked so the mirror is exact.
  const openRef = useRef(open)
  const setOpenTracked = useCallback((next: boolean) => {
    openRef.current = next
    setOpen(next)
  }, [])
  const [view, setView] = useState<'menu' | 'history' | 'device'>('menu')
  const [triggerEl, setTriggerEl] = useState<HTMLButtonElement | null>(null)
  const triggerId = useId()

  /** Opening always lands on the menu view; closing keeps the current view so
   *  the exit animation fades out what the user was actually looking at. */
  const handleOpenChange = useCallback((next: boolean) => {
    if (next) setView('menu')
    setOpenTracked(next)
  }, [setOpenTracked])

  /** Close from a menu/history ACTION: the clicked row lives in the portaled
   *  content and is about to unmount, so hand focus back to the ⋮ first. */
  const closeOverlay = useCallback(() => {
    triggerEl?.focus({ preventScroll: true })
    setOpenTracked(false)
  }, [setOpenTracked, triggerEl])

  // ---- clear-data (T14): the ⋮ quick path beside Settings' row (T11). Same
  // browserClearData call — only the inline two-step confirm lives here. ----
  const [clearConfirming, setClearConfirming] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [clearDone, setClearDone] = useState(false)
  const [clearFailed, setClearFailed] = useState(false)
  const clearConfirmTimerRef = useRef<number | null>(null)
  const clearDoneTimerRef = useRef<number | null>(null)
  // The done auto-close runs from a timer; it must reach the LATEST
  // closeOverlay (trigger element changes) without re-arming the timer.
  const closeOverlayRef = useRef(closeOverlay)
  useEffect(() => { closeOverlayRef.current = closeOverlay }, [closeOverlay])

  // Reopening the menu always starts fresh: no leftover confirm costume or
  // result note from the previous visit (an in-flight clear keeps showing
  // its busy state — that is honest).
  useEffect(() => {
    if (!open) return
    setClearConfirming(false)
    setClearDone(false)
    setClearFailed(false)
  }, [open])

  // Closing cancels both timers: the 5s confirm revert is moot while closed,
  // and the done auto-close must NOT fire after a manual close (it would
  // yank focus back to the trigger through closeOverlay). A done timer armed
  // AFTER this ran — the round trip resolving post-close — is fenced twice:
  // the .then/.catch handlers in handleClearData skip arming when openRef
  // reads closed, and this effect's cleanup (which runs when the menu
  // reopens) cancels anything that still slipped through in between.
  useEffect(() => {
    if (open) return
    if (clearConfirmTimerRef.current !== null) {
      window.clearTimeout(clearConfirmTimerRef.current)
      clearConfirmTimerRef.current = null
    }
    if (clearDoneTimerRef.current !== null) {
      window.clearTimeout(clearDoneTimerRef.current)
      clearDoneTimerRef.current = null
    }
    setClearConfirming(false)
    return () => {
      if (clearDoneTimerRef.current !== null) {
        window.clearTimeout(clearDoneTimerRef.current)
        clearDoneTimerRef.current = null
      }
    }
  }, [open])

  // Unmount never leaves a trailing timer behind (same rule as the history
  // panel's confirm revert below).
  useEffect(
    () => () => {
      if (clearConfirmTimerRef.current !== null) window.clearTimeout(clearConfirmTimerRef.current)
      if (clearDoneTimerRef.current !== null) window.clearTimeout(clearDoneTimerRef.current)
    },
    []
  )

  const handleClearData = useCallback(() => {
    if (clearing) return
    setClearDone(false)
    setClearFailed(false)
    if (!clearConfirming) {
      // First click: the entry flips to its destructive confirm costume and
      // reverts after 5s (same deadline as the history panel / Settings row).
      setClearConfirming(true)
      if (clearConfirmTimerRef.current !== null) window.clearTimeout(clearConfirmTimerRef.current)
      clearConfirmTimerRef.current = window.setTimeout(() => {
        clearConfirmTimerRef.current = null
        setClearConfirming(false)
      }, CLEAR_CONFIRM_MS)
      return
    }
    if (clearConfirmTimerRef.current !== null) window.clearTimeout(clearConfirmTimerRef.current)
    clearConfirmTimerRef.current = null
    setClearConfirming(false)
    setClearing(true)
    void window.pi
      .browserClearData()
      .then(
        () => {
          // The popover may have closed while the round trip was in flight.
          // The done note would be invisible anyway, but arming the
          // auto-close would yank focus to the ⋮ trigger 3s after the user
          // left — skip both when closed (the catch path is symmetric).
          if (!openRef.current) return
          setClearDone(true)
          if (clearDoneTimerRef.current !== null) window.clearTimeout(clearDoneTimerRef.current)
          clearDoneTimerRef.current = window.setTimeout(() => {
            clearDoneTimerRef.current = null
            // Defense in depth: a close that raced this timer cleared it
            // above, but never close/focus a popover that is no longer open.
            if (!openRef.current) return
            closeOverlayRef.current()
          }, CLEAR_DONE_CLOSE_MS)
        },
        () => {
          if (!openRef.current) return
          setClearFailed(true)
        }
      )
      .finally(() => setClearing(false))
  }, [clearConfirming, clearing])

  // The vendored MorphPopover closes on Escape, but its window handler neither
  // preventDefaults nor stops propagation — the pane's window-level Esc
  // handling (Esc-to-stop) would act on the same keystroke. A capture-phase
  // listener wins both: it fences the event (like the find bar does) and
  // performs the close itself.
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing) return
      // An open modal owns Escape (CenterMorphModal bails on defaultPrevented) —
      // fencing it here would close the popover while the dialog stayed open.
      if (document.querySelector('[aria-modal="true"]')) return
      event.preventDefault()
      event.stopPropagation()
      // Hand focus back to the trigger like closeOverlay does — a bare
      // setOpen strands a keyboard user on <body>.
      triggerEl?.focus({ preventScroll: true })
      setOpenTracked(false)
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [open, setOpenTracked, triggerEl])

  // A pointer press inside a webview guest NEVER reaches the host DOM — the
  // guest is a separate process, so the MorphPopover's document-level
  // outside-press cannot see it (clicking the page left the menu open until
  // the user clicked app chrome). Main's input-event relay forwards the guest
  // mouseDown as a ping; that ping is the popover's "outside press" here.
  // No focus steal: the click keeps the guest focused.
  useEffect(() => {
    return window.pi.onBrowserGuestPointer(() => {
      if (openRef.current) setOpenTracked(false)
    })
  }, [setOpenTracked])

  // Ruling C: the menu is a growable list of entries; find/print close the
  // overlay and act, history swaps this panel's view in place.
  const menuEntries: BrowserMenuEntry[] = [
    {
      id: 'find',
      icon: Search,
      label: t('browser.menuFind'),
      onSelect: () => {
        closeOverlay()
        onFind()
      }
    },
    {
      id: 'print',
      icon: Printer,
      label: t('browser.print'),
      onSelect: () => {
        closeOverlay()
        onPrint()
      }
    },
    // Task 14 appends device emulation / clear-data entries here.
    {
      id: 'device',
      icon: Smartphone,
      label: t('browser.menuDevice'),
      onSelect: () => setView('device')
    },
    {
      id: 'clear-data',
      icon: Trash2,
      label: t(clearConfirming ? 'browser.clearDataConfirm' : 'browser.menuClearData'),
      onSelect: handleClearData,
      destructive: clearConfirming,
      disabled: clearing,
      busy: clearing
    },
    {
      id: 'history',
      icon: History,
      label: t('browser.menuHistory'),
      onSelect: () => setView('history')
    }
  ]

  return (
    <MorphPopover open={open} onOpenChange={handleOpenChange} anchor={triggerEl}>
      <Tooltip content={t('browser.menu')}>
        <Button
          ref={setTriggerEl}
          id={triggerId}
          variant="ghost"
          size="icon"
          className="size-7 shrink-0"
          aria-label={t('browser.menu')}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => handleOpenChange(!open)}
        >
          <MoreVertical aria-hidden="true" className="size-3.5" />
        </Button>
      </Tooltip>
      <MorphPopoverContent
        side="bottom"
        align="end"
        sideOffset={6}
        radius="var(--app-radius-control)"
        className={cn('p-1', view === 'history' ? 'w-72' : view === 'device' ? 'w-64' : 'w-56')}
      >
        {view === 'history' ? (
          <BrowserHistoryPanel onNavigate={onNavigate} onClose={closeOverlay} />
        ) : view === 'device' ? (
          <BrowserDevicePanel device={device} onDeviceChange={onDeviceChange} />
        ) : (
          <div data-browser-menu>
            {menuEntries.map((entry) => {
              const Icon = entry.icon
              return (
                <Button
                  key={entry.id}
                  variant="ghost"
                  size="sm"
                  disabled={entry.disabled}
                  className={cn(
                    'h-9 w-full justify-start gap-2.5 px-2.5 font-normal',
                    entry.destructive &&
                      'text-destructive hover:bg-destructive/10 hover:text-destructive'
                  )}
                  onClick={entry.onSelect}
                >
                  {entry.busy ? (
                    <RunningLoader variant="dither-plus" size={16} label={t('browser.menuClearData')} className="size-4 shrink-0" />
                  ) : (
                    <Icon aria-hidden="true" className="size-4 shrink-0" />
                  )}
                  {entry.label}
                </Button>
              )
            })}
          </div>
        )}
        {/* clear-data's transient result note: inside the popover, below the
            view content, so it survives a view swap while it lingers. */}
        {clearDone || clearFailed ? (
          <p
            role={clearDone ? 'status' : 'alert'}
            data-browser-clear-status={clearDone ? 'done' : 'failed'}
            className={cn(
              'border-t border-border px-2.5 py-2 text-xs',
              clearDone ? 'text-muted-foreground' : 'text-destructive'
            )}
          >
            {t(clearDone ? 'browser.clearDataDone' : 'browser.clearDataFailed')}
          </p>
        ) : null}
      </MorphPopoverContent>
    </MorphPopover>
  )
}

/**
 * The device view of the overflow panel (T14): an in-panel row list — none (a real
 * off switch: clicking it returns the page to full-fill), the five presets
 * (names verbatim) and custom — plus, while a device is active, the width/height
 * number fields. NOT a nested Select dropdown: the vendored Select renders
 * its options inline (no portal), so inside this popover's panel they clip
 * at the panel edge. Editing holds DIGIT-ONLY DRAFTS (never clobbering a
 * partial entry like “393”); leaving a field commits it through
 * `commitDeviceSize` (clamp 200–3840), and the committed pair then resolves
 * back to its preset or falls to custom. The state itself lives in the page
 * view — this panel only edits it, so the pinning survives the popover
 * closing.
 */
function BrowserDevicePanel({
  device,
  onDeviceChange
}: {
  device: DeviceEmulationState
  onDeviceChange: (next: DeviceEmulationState) => void
}): JSX.Element {
  const { t } = useI18n()
  const widthId = useId()
  const heightId = useId()
  // Null = not editing; the field then shows the COMMITTED dimension, so a
  // preset switch flows through even while the panel is closed.
  const [widthDraft, setWidthDraft] = useState<string | null>(null)
  const [heightDraft, setHeightDraft] = useState<string | null>(null)

  const handlePresetChange = useCallback(
    (presetId: string) => {
      // none never routes through here — the row list maps it directly to
      // INITIAL_DEVICE_STATE (a real off switch); this guard stays defensive.
      if (presetId === DEVICE_NONE_ID) return
      setWidthDraft(null)
      setHeightDraft(null)
      const preset = findDevicePreset(presetId)
      if (preset) {
        onDeviceChange({ presetId, width: preset.width, height: preset.height })
      } else {
        // custom keeps the last committed dimensions (seeded from the first
        // preset when the user jumps straight to custom).
        onDeviceChange({ ...device, presetId: CUSTOM_DEVICE_ID })
      }
    },
    [device, onDeviceChange]
  )

  /** Blur commit for one axis: clears the draft, clamps the value and lets
   *  the committed pair pick its preset (diverging values fall to custom). */
  const commitDimension = (axis: 'width' | 'height', raw: string | null) => {
    if (axis === 'width') setWidthDraft(null)
    else setHeightDraft(null)
    if (raw === null) return
    const committed = commitDeviceSize(raw, axis === 'width' ? device.width : device.height)
    const next: DeviceEmulationState =
      axis === 'width' ? { ...device, width: committed } : { ...device, height: committed }
    next.presetId = resolveDevicePresetId(next.width, next.height)
    onDeviceChange(next)
  }

  return (
    <div className="flex flex-col gap-2.5 p-2" data-browser-device>
      {/* In-panel row list, not a nested Select: the vendored dropdown renders
          inline (no portal) and clips at this popover panel's edge. The list
          also gives none a real off switch instead of a disabled row. */}
      <div className="flex flex-col gap-0.5" role="radiogroup" aria-label={t('browser.menuDevice')}>
        {[
          { id: DEVICE_NONE_ID, name: t('browser.deviceNone') },
          ...DEVICE_PRESETS.map((preset) => ({ id: preset.id, name: preset.name })),
          { id: CUSTOM_DEVICE_ID, name: t('browser.deviceCustom') }
        ].map((row) => {
          const selected = device.presetId === row.id
          return (
            <Button
              key={row.id}
              variant="ghost"
              className={cn('h-7 justify-start px-2 text-xs', selected && 'bg-primary/15 text-foreground hover:bg-primary/25')}
              role="radio"
              aria-checked={selected}
              onClick={() => {
                if (row.id === DEVICE_NONE_ID) {
                  onDeviceChange(INITIAL_DEVICE_STATE)
                  return
                }
                handlePresetChange(row.id)
              }}
            >
              {row.name}
            </Button>
          )
        })}
      </div>
      {device.presetId !== DEVICE_NONE_ID ? (
        <div className="flex items-center gap-2" data-browser-device-size>
          <label htmlFor={widthId} className="shrink-0 text-xs text-muted-foreground">
            {t('browser.deviceWidth')}
          </label>
          <Input
            id={widthId}
            value={widthDraft ?? String(device.width)}
            onChange={(value) => setWidthDraft(sanitizeDeviceDigits(value))}
            onBlur={() => commitDimension('width', widthDraft)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur()
            }}
            inputMode="numeric"
            aria-label={t('browser.deviceWidth')}
            className="w-16 shrink-0"
            classNames={{ input: 'text-center' }}
          />
          <label htmlFor={heightId} className="shrink-0 text-xs text-muted-foreground">
            {t('browser.deviceHeight')}
          </label>
          <Input
            id={heightId}
            value={heightDraft ?? String(device.height)}
            onChange={(value) => setHeightDraft(sanitizeDeviceDigits(value))}
            onBlur={() => commitDimension('height', heightDraft)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur()
            }}
            inputMode="numeric"
            aria-label={t('browser.deviceHeight')}
            className="w-16 shrink-0"
            classNames={{ input: 'text-center' }}
          />
        </div>
      ) : null}
    </div>
  )
}

/** One row's favicon chain: recorded favicon → the site's default
 * /favicon.ico → a Globe once an <img> load fails (or nothing parsed). */
function HistoryFavicon({ url, favicon }: { url: string; favicon?: string }): JSX.Element {
  const [broken, setBroken] = useState(false)
  const src = broken ? null : (favicon ?? originFavicon(url))
  if (!src) {
    return <Globe aria-hidden="true" className="size-4 shrink-0 text-muted-foreground/70" />
  }
  return (
    <img
      src={src}
      alt=""
      aria-hidden="true"
      className="size-4 shrink-0 rounded-detail object-contain"
      onError={() => setBroken(true)}
    />
  )
}

const originFavicon = (url: string): string | null => {
  try {
    return `${new URL(url).origin}/favicon.ico`
  } catch {
    return null
  }
}

/** Relative time for a row: Intl.RelativeTimeFormat localises en/zh-CN the
 * same way the app's dictionaries would; past a week it falls back to the
 * locale date. `now` comes from the render pass so one paint agrees. */
function formatRelativeTime(at: number, locale: string, now: number): string {
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  const diff = at - now
  const abs = Math.abs(diff)
  if (abs < 60_000) return rtf.format(Math.round(diff / 1_000), 'second')
  if (abs < 3_600_000) return rtf.format(Math.round(diff / 60_000), 'minute')
  if (abs < 86_400_000) return rtf.format(Math.round(diff / 3_600_000), 'hour')
  if (abs < 7 * 86_400_000) return rtf.format(Math.round(diff / 86_400_000), 'day')
  return new Date(at).toLocaleDateString(locale, { month: 'short', day: 'numeric' })
}

/**
 * The history view of the overflow panel: the shared browser history store
 * (`useSyncExternalStore` over `subscribeBrowserHistory`), one row per entry
 * (favicon chain, truncated title with a url fallback, truncated url,
 * relative time). A row click navigates the CURRENT page through the
 * toolbar's funnel and closes the panel. The visible list caps at exactly six
 * rows — see the max-h derivation on the list container.
 */
function BrowserHistoryPanel({
  onNavigate,
  onClose
}: {
  onNavigate: (raw: string) => string | null
  onClose: () => void
}): JSX.Element {
  const { t, locale } = useI18n()
  const history = useSyncExternalStore(subscribeBrowserHistory, getBrowserHistory)
  const [confirming, setConfirming] = useState(false)
  const confirmTimerRef = useRef<number | null>(null)

  // A closed/aborted confirm never leaves a trailing revert timer behind
  // (the panel unmounts on view swap and on popover close).
  useEffect(
    () => () => {
      if (confirmTimerRef.current !== null) window.clearTimeout(confirmTimerRef.current)
    },
    []
  )

  const handleClear = useCallback(() => {
    if (confirmTimerRef.current !== null) window.clearTimeout(confirmTimerRef.current)
    confirmTimerRef.current = null
    if (!confirming) {
      setConfirming(true)
      confirmTimerRef.current = window.setTimeout(() => {
        confirmTimerRef.current = null
        setConfirming(false)
      }, CLEAR_CONFIRM_MS)
      return
    }
    setConfirming(false)
    clearBrowserHistory()
  }, [confirming])

  const handleOpenEntry = useCallback(
    (entry: BrowserHistoryEntry) => {
      // History rows can only contain urls the whitelist once accepted, but a
      // stale/blocked entry keeps the panel open instead of closing on nothing.
      if (onNavigate(entry.url) !== null) onClose()
    },
    [onClose, onNavigate]
  )

  if (history.length === 0) {
    return (
      <div
        className="flex flex-col items-center gap-1.5 px-4 py-6 text-center"
        data-browser-history-empty
      >
        <History aria-hidden="true" className="size-4 text-muted-foreground/70" />
        <p className="text-xs text-muted-foreground">{t('browser.historyEmpty')}</p>
      </div>
    )
  }

  const now = Date.now()
  return (
    <div data-browser-history>
      {/* 6 whole rows: one row = two 16px text lines + 2×4px py = 40px; the
          list's own p-1 adds 4px top + 4px bottom edge padding →
          max-h = 4 + 6×40 + 4 = 248px. Rows past the cap simply end (pi-web
          parity — content hides, no scrollbar chrome). */}
      <div className="flex max-h-[248px] flex-col overflow-y-auto p-1">
        {history.map((entry, index) => (
          <Button
            key={`${entry.url}@${entry.at}@${index}`}
            variant="ghost"
            size="sm"
            className="h-auto w-full items-center justify-start gap-2 px-2 py-1 text-left font-normal"
            onClick={() => handleOpenEntry(entry)}
          >
            <HistoryFavicon url={entry.url} favicon={entry.favicon} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs leading-ui-tight text-foreground">
                {entry.title || entry.url}
              </span>
              <span className="block truncate text-caption leading-ui-tight text-muted-foreground">
                {entry.url}
              </span>
            </span>
            <span className="shrink-0 text-micro leading-ui-tight tabular-nums text-muted-foreground/80">
              {formatRelativeTime(entry.at, locale, now)}
            </span>
          </Button>
        ))}
      </div>
      <div className="border-t border-border p-1">
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            'h-8 w-full justify-center gap-1.5 font-normal',
            confirming && 'text-destructive hover:bg-destructive/10 hover:text-destructive'
          )}
          onClick={handleClear}
        >
          <Trash2 aria-hidden="true" className="size-3.5 shrink-0" />
          {t(confirming ? 'browser.historyClearConfirm' : 'browser.historyClear')}
        </Button>
      </div>
    </div>
  )
}
