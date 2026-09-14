import { useState, type ReactNode } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import {
  Folder,
  Globe,
  MessageCirclePlus,
  Plus,
  ScanSearch,
  SquareTerminal,
  X,
  type IconComponent
} from '@/lib/icons'
import { Button } from '@/components/motion/button'
import { SharedLayoutBg } from '@/components/motion/shared-layout-bg'
import { Tabs, TabsList, TabsTrigger } from '@/components/motion/tabs'
import { Tooltip } from '@/components/motion/tooltip'
import { DURATION, EASE_OUT, motionTransition } from '@/lib/ease'
import { useI18n } from '@/i18n'
import type { MessageKey } from '@/i18n/locales/en'
import { cn } from '@/lib/utils'
import { SideChatPane } from './SideChatPane'
import { ReviewPane } from './ReviewPane'
import { TerminalPane } from './TerminalPane'
import type { TerminalStore } from '@/state/terminal-store'
import type { SideChatStore } from '@/state/side-chat-store'
import type { PiStore } from '@/state/pi-store'

/** Fallback width before the workspace has applied the user's panel layout. */
export const SIDEBAR_PANEL_WIDTH = 400

/** The panes the right rail can host. */
export type SidebarTabKind = 'review' | 'terminal' | 'browser' | 'files' | 'chat'

interface SidebarTabSpec {
  id: SidebarTabKind
  labelKey: MessageKey
  shortcutKey: MessageKey
  icon: IconComponent
  /** Content of an opened tab — each pane lands here as it is implemented. */
  render: (props: SidebarPaneProps) => ReactNode
}

/**
 * Data a pane may render, handed in by the workspace that owns it. Panes that
 * don't need it ignore the argument (only the side chat does today).
 */
export interface SidebarPaneProps {
  terminals: TerminalStore
  onNewTerminal: () => void
  onTerminalsEmpty: () => void
  /** The workspace store, for panes that read the session's transcript. */
  store: PiStore
  /** Turn the review pane should open on (from the transcript's Review action). */
  reviewTurnId: number | null
  /** The side chat's store, or null while its pane is not open. */
  sideChat: SideChatStore | null
  sideChatDraft: string
  onSideChatDraftChange: (value: string) => void
  /** True while the side chat is bound to the session the workspace shows. */
  sideChatOnCurrentSession: boolean
  /** Rebind the side chat to the current session, clearing its thread. */
  onSideChatRebind: () => void
}

/**
 * One registry for the picker rows, the tab strip and the pane header: adding a
 * pane is one entry here plus its content component, never a shell change.
 */
export const SIDEBAR_TABS: SidebarTabSpec[] = [
  {
    id: 'review',
    labelKey: 'sidebar.review',
    shortcutKey: 'sidebar.shortcutReview',
    icon: ScanSearch,
    render: (props) => <ReviewPane store={props.store} focusTurnId={props.reviewTurnId} />
  },
  {
    id: 'terminal',
    labelKey: 'sidebar.terminal',
    shortcutKey: 'sidebar.shortcutTerminal',
    icon: SquareTerminal,
    render: (props) => <TerminalPane terminals={props.terminals} onNew={props.onNewTerminal} onEmpty={props.onTerminalsEmpty} />
  },
  {
    id: 'browser',
    labelKey: 'sidebar.browser',
    shortcutKey: 'sidebar.shortcutBrowser',
    icon: Globe,
    render: () => <SidebarPanePlaceholder kind="browser" />
  },
  {
    id: 'files',
    labelKey: 'sidebar.files',
    shortcutKey: 'sidebar.shortcutFiles',
    icon: Folder,
    render: () => <SidebarPanePlaceholder kind="files" />
  },
  {
    id: 'chat',
    labelKey: 'sidebar.chat',
    shortcutKey: 'sidebar.shortcutChat',
    icon: MessageCirclePlus,
    render: (props) =>
      props.sideChat ? (
        <SideChatPane
          store={props.sideChat}
          draft={props.sideChatDraft}
          onDraftChange={props.onSideChatDraftChange}
          onCurrentSession={props.sideChatOnCurrentSession}
          onRebind={props.onSideChatRebind}
        />
      ) : null
  }
]

const SIDEBAR_TAB_BY_ID = new Map(SIDEBAR_TABS.map((spec) => [spec.id, spec]))

function specFor(kind: SidebarTabKind): SidebarTabSpec {
  const spec = SIDEBAR_TAB_BY_ID.get(kind)
  if (!spec) throw new Error(`Unknown sidebar tab: ${kind}`)
  return spec
}

/** Keyboard hint chip — the panel lists what each pane's shortcut will be. */
function ShortcutChip({ value }: { value: string }) {
  return (
    <span className="inline-flex h-6 min-w-8 shrink-0 items-center justify-center rounded-md bg-muted px-1.5 text-xs font-medium text-muted-foreground">
      {value}
    </span>
  )
}

/**
 * Shown while the rail has no open tab: the picker centred in the panel, one
 * row per pane (icon, label, shortcut). A row click opens that pane.
 */
function SidebarPicker({ onOpen }: { onOpen: (kind: SidebarTabKind) => void }) {
  const { t } = useI18n()
  return (
    <div className="flex h-full items-center px-2">
      <SharedLayoutBg inset={6}>
        {SIDEBAR_TABS.map((spec) => (
          <button
            key={spec.id}
            type="button"
            onClick={() => onOpen(spec.id)}
            className="block w-full rounded-lg px-3 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="flex w-full items-center gap-3">
              <span className="grid size-5 shrink-0 place-items-center text-muted-foreground">
                <spec.icon aria-hidden="true" className="size-[18px]" />
              </span>
              <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                {t(spec.labelKey)}
              </span>
              <ShortcutChip value={t(spec.shortcutKey)} />
            </span>
          </button>
        ))}
      </SharedLayoutBg>
    </div>
  )
}

/** Placeholder body for a pane that is still to be implemented. */
function SidebarPanePlaceholder({ kind }: { kind: SidebarTabKind }) {
  const { t } = useI18n()
  const reduce = useReducedMotion()
  const spec = specFor(kind)
  return (
    <motion.div
      key={kind}
      initial={reduce ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={motionTransition(reduce, { duration: DURATION.fast, ease: EASE_OUT })}
      className="flex h-full flex-col items-center justify-center gap-2 text-center"
    >
      <spec.icon aria-hidden="true" className="size-6 text-muted-foreground/70" />
      <p className="text-sm text-muted-foreground">{t(spec.labelKey)}</p>
      <p className="text-xs text-muted-foreground/70">{t('sidebar.placeholder')}</p>
    </motion.div>
  )
}

/** Horizontal tab strip: beUI Tabs' underline indicator, one close button per
 * tab and the add button that re-opens the picker. */
function SidebarTabStrip({
  tabs,
  active,
  pickerOpen,
  onSelect,
  onClose,
  onTogglePicker
}: {
  tabs: SidebarTabKind[]
  active: SidebarTabKind | null
  pickerOpen: boolean
  onSelect: (kind: SidebarTabKind) => void
  onClose: (kind: SidebarTabKind) => void
  onTogglePicker: () => void
}) {
  const { t } = useI18n()
  return (
    <div className="flex h-11 shrink-0 items-center gap-1 border-b border-border bg-background pr-1.5">
      <div className="min-w-0 flex-1 overflow-x-auto p-1">
        <Tabs
          value={active ?? ''}
          onValueChange={(value) => onSelect(value as SidebarTabKind)}
          variant="underline"
          className="w-max"
        >
          <TabsList className="h-9 border-b-0 gap-0.5">
            {tabs.map((kind) => {
              const spec = specFor(kind)
              const label = t(spec.labelKey)
              const isActive = active === kind
              return (
                <div key={kind} className="group/tab relative flex items-center">
                  <TabsTrigger value={kind} className="h-9 min-h-0 gap-2 pl-2.5 pr-8">
                    <spec.icon aria-hidden="true" className="size-3.5 shrink-0" />
                    <span className="max-w-32 truncate text-xs">{label}</span>
                  </TabsTrigger>
                  <Tooltip
                    content={t('sidebar.closeTab', { label })}
                    wrapperClassName="absolute right-1 z-10"
                  >
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={t('sidebar.closeTab', { label })}
                      onClick={() => onClose(kind)}
                      className={cn(
                        'size-5 rounded-md focus-visible:opacity-100 group-hover/tab:opacity-100',
                        // The active tab keeps its close button visible; the others
                        // reveal it on hover, so the strip stays quiet.
                        isActive ? 'opacity-100' : 'opacity-0'
                      )}
                    >
                      <X aria-hidden="true" className="size-3" />
                    </Button>
                  </Tooltip>
                </div>
              )
            })}
          </TabsList>
        </Tabs>
      </div>
      <Tooltip content={t('sidebar.newTab')}>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t('sidebar.newTab')}
          aria-pressed={pickerOpen}
          onClick={onTogglePicker}
          className={cn('shrink-0', pickerOpen && 'bg-primary/5 text-foreground')}
        >
          <Plus aria-hidden="true" className="size-4" />
        </Button>
      </Tooltip>
    </div>
  )
}

interface SidebarPanelProps {
  open: boolean
  /** Panel width in px, owned by the workspace (it shares one budget with the
   * sidebar and the transcript, and persists what the user dragged). */
  width: number
  /** True while the user is dragging the panel edge: the width is then read
   * straight from `--panel-right` (the drag writes it to the DOM), so a drag
   * costs no React render at all and the panel tracks the pointer exactly. */
  resizing?: boolean
  /** True while the resize strip is hovered or dragging: light up the panel's
   * own border line instead of drawing a second one. */
  edgeActive?: boolean
  tabs: SidebarTabKind[]
  activeTab: SidebarTabKind | null
  onSelectTab: (kind: SidebarTabKind) => void
  onOpenTab: (kind: SidebarTabKind) => void
  onCloseTab: (kind: SidebarTabKind) => void
  /** Pane payloads, owned by the workspace (see SidebarPaneProps). */
  pane: SidebarPaneProps
}

/**
 * Right rail below the app header: a horizontal tab strip over the active
 * pane, or the picker while nothing is open. It is docked, not an overlay — it
 * takes a flex column of its own so the transcript reflows beside it, and the
 * shell animates its width so the slide stays a clip rather than a re-layout.
 */
export function SidebarPanel({
  open,
  width,
  resizing = false,
  edgeActive = false,
  tabs,
  activeTab,
  onSelectTab,
  onOpenTab,
  onCloseTab,
  pane
}: SidebarPanelProps) {
  const { t } = useI18n()
  const reduce = useReducedMotion()
  /** The add button's picker, shown over the pane area (never over the strip). */
  const [pickerOpen, setPickerOpen] = useState(false)
  const hasTabs = tabs.length > 0

  const openTab = (kind: SidebarTabKind) => {
    setPickerOpen(false)
    onOpenTab(kind)
  }

  return (
    <AnimatePresence initial={false}>
      {open ? (
        <motion.aside
          key="sidebar-panel"
          aria-label={t('sidebar.title')}
          data-panel="right"
          initial={{ width: 0, opacity: 0 }}
          animate={{ width: resizing ? 'var(--panel-right)' : width, opacity: 1 }}
          exit={{ width: 0, opacity: 0 }}
          transition={
            reduce || resizing ? { duration: 0 } : { duration: DURATION.base, ease: EASE_OUT }
          }
          className={cn(
            'relative shrink-0 overflow-hidden border-l bg-background',
            edgeActive ? 'border-primary' : 'border-border'
          )}
        >
          <div
            className="flex h-full flex-col"
            style={{ width: resizing ? 'var(--panel-right)' : width }}
          >
            {hasTabs ? (
              <SidebarTabStrip
                tabs={tabs}
                active={activeTab}
                pickerOpen={pickerOpen}
                onSelect={(kind) => {
                  setPickerOpen(false)
                  onSelectTab(kind)
                }}
                onClose={onCloseTab}
                onTogglePicker={() => setPickerOpen((current) => !current)}
              />
            ) : null}

            <div className="min-h-0 flex-1">
              {!hasTabs || pickerOpen ? (
                <SidebarPicker onOpen={openTab} />
              ) : (
                activeTab && specFor(activeTab).render(pane)
              )}
            </div>
          </div>
        </motion.aside>
      ) : null}
    </AnimatePresence>
  )
}
