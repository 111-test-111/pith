import { TrajectoryPane } from './TrajectoryPane'
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import {
  CalendarCheck,
  Chart,
  ChatAdd,
  CheckSquareOffset,
  Folder,
  Subagent,
  Globe,
  Plus,
  SquareTerminal,
  Bug,
  Waypoints,
  GitFork,
  X,
  type IconComponent
} from '@/lib/icons'
import { Button } from '@/components/motion/button'
import { SharedLayoutBg } from '@/components/motion/shared-layout-bg'
import { Tabs, TabsList, TabsTrigger } from '@/components/motion/tabs'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@/components/motion/context-menu'
import { Tooltip } from '@/components/motion/tooltip'
import { DURATION, EASE_OUT } from '@/lib/ease'
import { useI18n } from '@/i18n'
import type { MessageKey } from '@/i18n/locales/en'
import type { ShortcutId } from '@/lib/shortcuts/keyboard-shortcuts'
import { ShortcutBindingChip } from './ShortcutKeys'
import { cn } from '@/lib/utils'
import { basename } from '@/lib/format'
import { LabelTooltip } from './LabelTooltip'
import { FileTypeIcon } from './FileTypeIcon'
import { MiddleEllipsis } from './MiddleEllipsis'
import { SideChatPane } from './SideChatPane'
import { ReviewPane } from './ReviewPane'
import { ContextDetailPane } from './ContextDetailPane'
import { TerminalPane } from './TerminalPane'
import { DebugPane } from './DebugPane'
import { FilesPane } from './FilesPane'
import { BrowserPane } from './BrowserPane'
import { SubagentSessionPane } from './SubagentSessionPane'
import { ScheduledSessionPane } from './ScheduledSessionPane'
import { GitPane } from './git/GitPane'
import type { GitStore } from '@/state/git-store'
import type { FileBrowserStore } from '@/state/file-browser-store'
import type { TerminalStore } from '@/state/terminal-store'
import type { DebugStore } from '@/state/debug-store'
import type { SideChatStore } from '@/state/side-chat-store'
import type { PiStore } from '@/state/pi-store'
import type { BrowserStore } from '@/lib/browser/store'
import { useBrowserKeepAlivePref } from '@/lib/browser/keep-alive'
import { getOpenBrowserPagesRevision } from '@/lib/browser/session'
import type { SubagentRunDTO } from '../../../../shared/types'

/** Fallback width before the workspace has applied the user's panel layout. */
export const SIDEBAR_PANEL_WIDTH = 400

/** The panes the right rail can host. Besides the fixed kinds, the rail hosts
 * one tab per open FILE and per open SUBAGENT SESSION (both keyed by path). */
export type SidebarTabKind = 'review' | 'context' | 'terminal' | 'browser' | 'files' | 'chat' | 'debug' | 'trajectory' | 'git'
export type SidebarTabId = SidebarTabKind | `file:${string}` | `agent:${string}` | `scheduled:${string}`
export const fileTabId = (path: string): SidebarTabId => `file:${path}`
export const filePathForTab = (id: SidebarTabId | null): string | null => id?.startsWith('file:') ? id.slice(5) : null
/** A subagent child session shown READ-ONLY beside the chat: opening it here
 * keeps the visible conversation in place instead of navigating away from it. */
export const agentTabId = (path: string): SidebarTabId => `agent:${path}`
export const agentPathForTab = (id: SidebarTabId | null): string | null => id?.startsWith('agent:') ? id.slice(6) : null
/** A scheduled run's session shown READ-ONLY beside the chat: the session
 * itself never lists in the sidebar/search, so the tasks view opens it here. */
export const scheduledTabId = (path: string): SidebarTabId => `scheduled:${path}`
export const scheduledPathForTab = (id: SidebarTabId | null): string | null => id?.startsWith('scheduled:') ? id.slice(10) : null

interface SidebarTabSpec {
  id: SidebarTabKind
  labelKey: MessageKey
  /** The shortcut command that opens this pane; the chip follows rebinding. */
  shortcutId: ShortcutId
  icon: IconComponent
  /** Content of an opened tab — each pane lands here as it is implemented. */
  render: (props: SidebarPaneProps) => ReactNode
}

/**
 * Data a pane may render, handed in by the workspace that owns it. Panes that
 * don't need it ignore the argument (only the side chat does today).
 */
export interface SidebarPaneProps {
  git?: GitStore
  files: FileBrowserStore
  terminals: TerminalStore
  onNewTerminal: () => void
  onTerminalsEmpty: () => void
  /** The embedded browser's store, owned by the workspace (it outlives the
   *  pane: an unmount kills the guests and the open-pages snapshot restores
   *  them after a fold; explicit close follows the restore-tabs preference);
   *  only tab close folds the rail entry. */
  browserStore: BrowserStore
  /** The browser's last page closed: the tab folds away (no extra teardown). */
  onBrowserEmpty: () => void
  /** The workspace store, for panes that read the session's transcript. */
  store: PiStore
  /** The debug session mirror, owned by the workspace. */
  debug: DebugStore
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
  /** This session's subagent runs, keyed by the CHILD session file: it names
   * the rail's agent tabs and feeds the pane's status header. */
  agentRuns: ReadonlyMap<string, SubagentRunDTO>
  /** Send a rail-opened child to the main chat (its read-only session view). */
  onOpenSessionInChat: (path: string) => void
}

/**
 * One registry for the picker rows, the tab strip and the pane header: adding a
 * pane is one entry here plus its content component, never a shell change.
 */
export const SIDEBAR_TABS: SidebarTabSpec[] = [
  { id: 'git', labelKey: 'git.title', shortcutId: 'openGit', icon: GitFork, render: props => props.git ? <GitPane git={props.git} store={props.store} /> : null },
  { id: 'trajectory', labelKey: 'sidebar.trajectory', shortcutId: 'openTrajectory', icon: Waypoints, render: props => <TrajectoryPane store={props.store} agentRuns={props.agentRuns} /> },
  {
    id: 'review',
    labelKey: 'sidebar.review',
    shortcutId: 'openReview',
    icon: CheckSquareOffset,
    render: (props) => <ReviewPane store={props.store} focusTurnId={props.reviewTurnId} />
  },
  {
    id: 'context',
    labelKey: 'sidebar.context',
    shortcutId: 'openContext',
    icon: Chart,
    render: (props) => <ContextDetailPane store={props.store} />
  },
  {
    id: 'terminal',
    labelKey: 'sidebar.terminal',
    shortcutId: 'openTerminal',
    icon: SquareTerminal,
    render: (props) => <TerminalPane terminals={props.terminals} onNew={props.onNewTerminal} onEmpty={props.onTerminalsEmpty} />
  },
  {
    id: 'debug',
    labelKey: 'sidebar.debug',
    shortcutId: 'openDebug',
    icon: Bug,
    render: (props) => <DebugPane store={props.store} debug={props.debug} />
  },
  {
    id: 'browser',
    labelKey: 'sidebar.browser',
    shortcutId: 'openBrowser',
    icon: Globe,
    // Never rendered through this registry: the pane content area below hosts
    // the browser pane itself in a keep-alive layer, because its webviews are
    // process-backed and die on unmount. A second instance here would
    // double-host every page. (Were it ever rendered, this slot is by
    // construction the active pane — hence `active`.)
    render: (props) => <BrowserPane store={props.browserStore} onEmpty={props.onBrowserEmpty} active />
  },
  {
    id: 'files',
    labelKey: 'sidebar.files',
    shortcutId: 'openFiles',
    icon: Folder,
    render: (props) => <FilesPane files={props.files} store={props.store} debug={props.debug} filePath={null} />
  },
  {
    id: 'chat',
    labelKey: 'sidebar.chat',
    shortcutId: 'openSideChat',
    icon: ChatAdd,
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

/**
 * Shown while the rail has no open tab: the picker centred in the panel, one
 * row per pane (icon, label, its current shortcut). A row click opens it.
 */
function SidebarPicker({ onOpen }: { onOpen: (kind: SidebarTabKind) => void }) {
  const { t } = useI18n()
  return (
    <div className="flex h-full items-center px-2">
      {/* Extend the hover fill through the wrapper's 8px side padding. */}
      <SharedLayoutBg inset={8} className="pane-picker">
        {SIDEBAR_TABS.map((spec) => (
          <button
            key={spec.id}
            type="button"
            onClick={() => onOpen(spec.id)}
            // SharedLayoutBg paints the row's only hover background.
            className="block w-full rounded-lg px-3 py-2.5 text-left outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <span className="flex w-full items-center gap-3">
              <span className="grid size-5 shrink-0 place-items-center text-muted-foreground">
                <spec.icon aria-hidden="true" className="size-[18px]" />
              </span>
              <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                {t(spec.labelKey)}
              </span>
              <ShortcutBindingChip id={spec.shortcutId} />
            </span>
          </button>
        ))}
      </SharedLayoutBg>
    </div>
  )
}

/** Horizontal tab strip: beUI Tabs' underline indicator, one close button per
 * tab and the add button that re-opens the picker. */
function SidebarTabStrip({
  tabs,
  active,
  pickerOpen,
  agentRuns,
  onSelect,
  onClose,
  onCloseOthers,
  onCloseAll,
  onTogglePicker
}: {
  tabs: SidebarTabId[]
  active: SidebarTabId | null
  pickerOpen: boolean
  agentRuns: ReadonlyMap<string, SubagentRunDTO>
  onSelect: (kind: SidebarTabId) => void
  onClose: (kind: SidebarTabId) => void
  onCloseOthers: (kind: SidebarTabId) => void
  onCloseAll: () => void
  onTogglePicker: () => void
}) {
  const { t } = useI18n()
  const scroll = useRef<HTMLDivElement>(null)
  // The tab under the pointer, resolved from the DOM: the strip renders one
  // menu for every tab, so the row identity has to be read at the moment of the
  // right-click (a ref cannot race the trigger's own open).
  const menuTab = useRef<SidebarTabId | null>(null)
  useLayoutEffect(() => {
    const viewport = scroll.current
    const selected = viewport?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
    if (!viewport || !selected) return
    const tab = selected.getBoundingClientRect(), bounds = viewport.getBoundingClientRect()
    if (tab.left < bounds.left) viewport.scrollLeft += tab.left - bounds.left - 4
    else if (tab.right > bounds.right) viewport.scrollLeft += tab.right - bounds.right + 4
  }, [active, tabs])
  return (
    // Height is content-driven (4px + its 36px tab list + 4px = 44px) plus the
    // 1px rule, i.e. exactly the recipe of the transcript's task strip above
    // (`px-4 py-1.5` + its 32px buttons). A fixed `h-11` would make this rule
    // 1px higher than that one, because the height would then be border-box —
    // 44 including the border the other strip adds on top.
    <ContextMenu>
      <ContextMenuTrigger>
        <div data-sidebar-tabs className="flex shrink-0 items-center gap-1 border-b border-border bg-background pr-1.5"
          onContextMenu={(event) => {
            const wrapper = (event.target as HTMLElement).closest<HTMLElement>('[data-sidebar-tab]')
            menuTab.current = (wrapper?.getAttribute('data-sidebar-tab') as SidebarTabId | null) ?? null
          }}>
      <div ref={scroll} className="min-w-0 flex-1 overflow-x-auto p-1">
        <Tabs
          value={active ?? ''}
          onValueChange={(value) => onSelect(value as SidebarTabId)}
          variant="underline"
          className="w-max"
        >
          <TabsList className="h-9 border-b-0 gap-0.5">
            {tabs.map((kind) => {
              const path = filePathForTab(kind)
              const agentPath = agentPathForTab(kind)
              const scheduledPath = scheduledPathForTab(kind)
              // `specFor` only knows the fixed kinds: an agent/scheduled tab
              // (like a file tab) takes its own label and icon, and must NOT
              // be resolved through the registry.
              const spec = agentPath || scheduledPath ? null : specFor(path ? 'files' : kind as SidebarTabKind)
              const label = agentPath
                ? agentRuns.get(agentPath)?.description ?? t('subagent.sessionTab')
                : scheduledPath ? t('scheduledTasks.pane.title') : path ? basename(path) : t(spec!.labelKey)
              // A JSX tag name cannot carry a non-null assertion, so the icon
              // component is bound here where the union still narrows.
              const TabIcon = spec?.icon
              const isActive = active === kind
              return (
                <div key={kind} data-sidebar-tab={kind} className="group/tab relative flex items-center">
                  <LabelTooltip content={path ?? (agentPath ?? scheduledPath ? label : '')}><TabsTrigger value={kind} className="h-9 min-h-0 gap-2 pl-2.5 pr-8">
                    {agentPath ? <Subagent aria-hidden="true" className="size-4 shrink-0" /> : scheduledPath ? <CalendarCheck aria-hidden="true" className="size-4 shrink-0" /> : path ? <FileTypeIcon path={path} variant="tab" className="size-4 shrink-0" /> : TabIcon ? <TabIcon aria-hidden="true" className="size-4 shrink-0" /> : null}
                    <MiddleEllipsis name={label} className="max-w-32 text-xs" />
                  </TabsTrigger></LabelTooltip>
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
          className={cn('shrink-0', pickerOpen && 'bg-muted text-foreground')}
        >
          <Plus aria-hidden="true" className="size-4" />
        </Button>
      </Tooltip>
        </div>
      </ContextMenuTrigger>
      {/* One menu for the whole strip; the tab comes from the row under the
          pointer, so no per-tab wrapper is needed. */}
      <ContextMenuContent ariaLabel={t('sidebar.tabMenu')}>
        <ContextMenuItem onSelect={() => menuTab.current && onClose(menuTab.current)}>
          {t('sidebar.tabClose')}
        </ContextMenuItem>
        <ContextMenuItem
          disabled={tabs.length < 2}
          onSelect={() => menuTab.current && onCloseOthers(menuTab.current)}
        >
          {t('sidebar.tabCloseOthers')}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={onCloseAll}>{t('sidebar.tabCloseAll')}</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

interface SidebarPanelProps {
  open: boolean
  /** Cover the chat within the inset, leaving the session sidebar accessible. */
  fullscreen?: boolean
  /** Panel width in px, owned by the workspace (it shares one budget with the
   * sidebar and the transcript, and persists what the user dragged). */
  width: number
  /** True while either panel edge is being dragged: the pair is then read
   * straight from `--panel-right` (the drag writes it to the DOM), so a drag
   * costs no React render at all and the panel tracks the pointer exactly —
   * including while the OTHER panel's strip is the one being pulled, which
   * shrinks this one live. */
  resizing?: boolean
  /** True while the resize strip is hovered or dragging: light up the panel's
   * own border line instead of drawing a second one. */
  edgeActive?: boolean
  tabs: SidebarTabId[]
  activeTab: SidebarTabId | null
  onSelectTab: (kind: SidebarTabId) => void
  onOpenTab: (kind: SidebarTabKind) => void
  onCloseTab: (kind: SidebarTabId) => void
  onCloseOtherTabs: (keep: SidebarTabId) => void
  onCloseAllTabs: () => void
  /** Pane payloads, owned by the workspace (see SidebarPaneProps). */
  pane: SidebarPaneProps
}

/**
 * Right rail below the app header: a horizontal tab strip over the active
 * pane, or the picker while nothing is open. Normally docked beside the chat;
 * fullscreen anchors to the workspace inset, so its bounds follow window and
 * session-sidebar resizing directly in CSS without remounting the active pane.
 */
export function SidebarPanel({
  open,
  fullscreen = false,
  width,
  resizing = false,
  edgeActive = false,
  tabs,
  activeTab,
  onSelectTab,
  onOpenTab,
  onCloseTab,
  onCloseOtherTabs,
  onCloseAllTabs,
  pane
}: SidebarPanelProps) {
  const { t } = useI18n()
  const reduce = useReducedMotion()
  const { browserKeepAlive } = useBrowserKeepAlivePref()
  /** The add button's picker, shown over the pane area (never over the strip). */
  const [pickerOpen, setPickerOpen] = useState(false)
  // A conversation link also reveals an already-active file while the + picker
  // is open; activeTab alone does not change in that case.
  useEffect(() => pane.files.subscribeOpen(() => setPickerOpen(false)), [pane.files])
  const hasTabs = tabs.length > 0
  /** Keep-alive across rail FOLDS (Settings → Browser): with the pref on and a
   *  browser tab present, a folded rail keeps this aside mounted at width 0 /
   *  opacity 0 instead of exiting — the same opacity form the rail-tab
   *  keep-alive layer already uses, so the webviews (and their guests)
   *  survive the fold exactly as they survive a tab switch. The inner column
   *  keeps its fixed width, so the fold CLIPS and never resizes: in-progress
   *  page activity never pauses and the expand is pixel-identical. Closing the
   *  browser tab, or turning the pref off, still takes the exit path below. */
  const browserHoldAlive = !open && browserKeepAlive && tabs.includes('browser')
  /** The browser pane's keep-alive layer is interactive only while the rail is
   *  OPEN, its tab is the active one and the picker is closed; otherwise it
   *  stays mounted but invisible (see the pane content area). */
  const browserPaneLive = open && hasTabs && !pickerOpen && activeTab === 'browser'
  const asideRef = useRef<HTMLElement | null>(null)
  // A fold that KEEPS the pane mounted must not leave DOM focus inside the
  // invisible aside — keystrokes aimed at the chat would land in a webview
  // nobody can see. Blur whatever the pane held; an exiting fold needs no
  // help (its DOM goes away and focus falls back to the body).
  useEffect(() => {
    if (open || !browserHoldAlive) return
    const host = asideRef.current
    const active = document.activeElement
    if (host && active instanceof HTMLElement && host.contains(active) && active !== document.body) {
      active.blur()
    }
  }, [open, browserHoldAlive])

  const openTab = (kind: SidebarTabKind) => {
    setPickerOpen(false)
    onOpenTab(kind)
  }

  return (
    <AnimatePresence initial={false}>
      {open || browserHoldAlive ? (
        <motion.aside
          ref={asideRef}
          key="sidebar-panel"
          aria-label={t('sidebar.title')}
          aria-hidden={!open || undefined}
          data-panel="right"
          data-panel-fullscreen={fullscreen || undefined}
          initial={{ width: 0, opacity: 0 }}
          animate={{
            width: open ? (fullscreen ? '100%' : resizing ? 'var(--panel-right)' : width) : 0,
            opacity: open ? 1 : 0
          }}
          exit={{ width: 0, opacity: 0 }}
          transition={
            reduce || resizing ? { duration: 0 } : { duration: DURATION.base, ease: EASE_OUT }
          }
          className={cn(
            'shrink-0 overflow-hidden bg-background',
            fullscreen ? 'absolute inset-y-0 right-0 z-30' : 'relative',
            !open && 'pointer-events-none'
          )}
        >
          {/* The 1px left rule is drawn by this column, never by the aside:
              the aside's animated width is its BORDER box, so a border up
              there would shrink its content box by a pixel while this column —
              pinned to the rail's docked width so a fold clips instead of
              reflowing the pane — kept asking for the whole width. The column
              then spilt 1px past the rail's right edge (clipped by the aside),
              and every right-aligned control inside it sat 1px further right
              than the same control in fullscreen: switching the rail to
              fullscreen nudged the pane's whole right edge. On this box the
              column's border box IS the aside's content box, so both states
              resolve to identical pixels, and a fold (or the kept-alive fold at
              width 0) clips the rule away with the panel — no animated border
              width, and the theme token stays intact.

              FULLSCREEN is the one state where the rule goes invisible rather
              than gone: the rail then anchors to the workspace inset, whose
              left edge sits exactly on the session sidebar's right border (the
              drag strip's 3px straddle is pulled back by the inset), so a
              painted rule here stacked a second 1px line against that sidebar
              rule — a 2px seam. The boundary belongs to the session sidebar,
              exactly as it does against the chat when the rail is folded. The
              1px stays TRANSPARENT rather than removed so this box keeps the
              same border box in both states: dropping the width instead left
              the pane a pixel wider in fullscreen than when docked. */}
          <div
            className={cn(
              'flex h-full flex-col border-l',
              fullscreen
                ? 'border-l-transparent'
                : edgeActive ? 'border-primary' : 'border-border'
            )}
            style={{ width: fullscreen ? '100%' : resizing ? 'var(--panel-right)' : width }}
          >
            {hasTabs ? (
              <SidebarTabStrip
                tabs={tabs}
                active={activeTab}
                pickerOpen={pickerOpen}
                agentRuns={pane.agentRuns}
                onSelect={(kind) => {
                  setPickerOpen(false)
                  onSelectTab(kind)
                }}
                onClose={onCloseTab}
                onCloseOthers={onCloseOtherTabs}
                onCloseAll={onCloseAllTabs}
                onTogglePicker={() => setPickerOpen((current) => !current)}
              />
            ) : null}

            <div className="sidebar-pane-container relative min-h-0 min-w-0 flex-1">
              {/* The browser pane mounts at this one stable tree position for as
                  long as its rail tab EXISTS. While another tab is active it
                  lives in a hidden-but-painted layer — opacity, never
                  display:none/visibility, because the embedded-browser iron
                  rule keeps agent pages interactive/screenshotable at full
                  speed — so switching rail tabs never unmounts its
                  process-backed webviews. Closing the browser tab unmounts it;
                  folding the rail does too UNLESS the keep-alive pref holds
                  the folded aside mounted (see browserHoldAlive above) — the
                  open-pages snapshot re-materializes pages on the next mount
                  in that case: the same strip in the pane's first commit,
                  entries carrying their original owners (an agent page
                  re-registers under `agent:<sessionId>`, so its session's
                  tools find it again). The registry's browser render above is
                  therefore never called. `active` threads `browserPaneLive`
                  so the pane's global shortcuts register only while the tab
                  is on screen. */}
              {tabs.includes('browser') ? (
                <div
                  aria-hidden={!browserPaneLive || undefined}
                  className={cn('absolute inset-0', !browserPaneLive && 'pointer-events-none opacity-0')}
                >
                  <BrowserPane key={getOpenBrowserPagesRevision()} store={pane.browserStore} onEmpty={pane.onBrowserEmpty} active={browserPaneLive} />
                </div>
              ) : null}
              {!hasTabs || pickerOpen ? (
                <SidebarPicker onOpen={openTab} />
              ) : (
                activeTab && (activeTab !== 'trajectory' || open) && activeTab !== 'browser' && (() => {
                  const agentPath = agentPathForTab(activeTab)
                  if (agentPath) {
                    return (
                      <SubagentSessionPane
                        sessionPath={agentPath}
                        run={pane.agentRuns.get(agentPath) ?? null}
                        onOpenInChat={pane.onOpenSessionInChat}
                      />
                    )
                  }
                  const scheduledPath = scheduledPathForTab(activeTab)
                  if (scheduledPath) {
                    return <ScheduledSessionPane sessionPath={scheduledPath} />
                  }
                  const path = filePathForTab(activeTab)
                  return path
                    ? <FilesPane files={pane.files} store={pane.store} debug={pane.debug} filePath={path} />
                    : specFor(activeTab as SidebarTabKind).render(pane)
                })()
              )}
            </div>
          </div>
        </motion.aside>
      ) : null}
    </AnimatePresence>
  )
}
