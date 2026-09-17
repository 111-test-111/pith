import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import type { JSX } from 'react'
import { Globe, History, MoreVertical, Printer, Search, Trash2, type IconComponent } from '@/lib/icons'
import { Button } from '@/components/motion/button'
import { MorphPopover, MorphPopoverContent } from '@/components/motion/popover-morph'
import { Tooltip } from '@/components/motion/tooltip'
import { useI18n } from '@/i18n'
import {
  clearBrowserHistory,
  getBrowserHistory,
  subscribeBrowserHistory,
  type BrowserHistoryEntry
} from '@/lib/browser/session'
import { cn } from '@/lib/utils'

/** Second-click deadline of the two-step 清空历史 confirm. */
const CLEAR_CONFIRM_MS = 5_000

/** Menu entry shape — Ruling C: entries are data, so Task 14's 设备模拟 /
 *  清除数据 additions are new array items, not new markup. */
interface BrowserMenuEntry {
  id: string
  icon: IconComponent
  label: string
  onSelect: () => void
}

/**
 * The selected page's ⋮ overflow menu (Task 13, Ruling C menu shell): the
 * toolbar's last control opens one beUI `MorphPopover` anchored to it. The
 * entries are a simple growable array and the 历史 entry swaps the SAME
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
  onNavigate
}: {
  onFind: () => void
  onPrint: () => void
  /** The toolbar's whitelist-gated navigation; returns the normalized url or
   *  null when the parse/whitelist/guest rejected it. */
  onNavigate: (raw: string) => string | null
}): JSX.Element {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [view, setView] = useState<'menu' | 'history'>('menu')
  const [triggerEl, setTriggerEl] = useState<HTMLButtonElement | null>(null)
  const triggerId = useId()

  /** Opening always lands on the menu view; closing keeps the current view so
   *  the exit animation fades out what the user was actually looking at. */
  const handleOpenChange = useCallback((next: boolean) => {
    if (next) setView('menu')
    setOpen(next)
  }, [])

  /** Close from a menu/history ACTION: the clicked row lives in the portaled
   *  content and is about to unmount, so hand focus back to the ⋮ first. */
  const closeOverlay = useCallback(() => {
    triggerEl?.focus({ preventScroll: true })
    setOpen(false)
  }, [triggerEl])

  // The vendored MorphPopover closes on Escape, but its window handler neither
  // preventDefaults nor stops propagation — the pane's window-level Esc
  // handling (Esc-to-stop) would act on the same keystroke. A capture-phase
  // listener wins both: it fences the event (like the find bar does) and
  // performs the close itself.
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing) return
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [open])

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
    // Task 14 appends 设备模拟 / 清除数据 entries here.
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
        className={cn('p-1', view === 'history' ? 'w-72' : 'w-56')}
      >
        {view === 'history' ? (
          <BrowserHistoryPanel onNavigate={onNavigate} onClose={closeOverlay} />
        ) : (
          <div data-browser-menu>
            {menuEntries.map((entry) => {
              const Icon = entry.icon
              return (
                <Button
                  key={entry.id}
                  variant="ghost"
                  size="sm"
                  className="h-9 w-full justify-start gap-2.5 px-2.5 font-normal"
                  onClick={entry.onSelect}
                >
                  <Icon aria-hidden="true" className="size-4 shrink-0" />
                  {entry.label}
                </Button>
              )
            })}
          </div>
        )}
      </MorphPopoverContent>
    </MorphPopover>
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
 * The 历史 view of the overflow panel: the shared browser history store
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
              <span className="block truncate text-xs leading-4 text-foreground">
                {entry.title || entry.url}
              </span>
              <span className="block truncate text-[11px] leading-4 text-muted-foreground">
                {entry.url}
              </span>
            </span>
            <span className="shrink-0 text-[10px] leading-4 tabular-nums text-muted-foreground/80">
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
