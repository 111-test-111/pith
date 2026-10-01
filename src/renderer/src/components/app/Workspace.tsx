import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore
} from 'react'
import { isNothingToCompactError } from '../../../../shared/compaction-errors'
import {
  ArrowDown,
  ArrowUp,
  ArrowsInLineHorizontal,
  ArrowsOutLineHorizontal,
  Chat01,
  CalendarCheck,
  ChevronDown,
  ChevronRight,
  Copy,
  Folder,
  FolderInput,
  FolderOpen,
  LoaderCircle,
  type IconComponent,
  MessageSquareDashed,
  MessageSquarePlus,
  PanelLeft,
  PanelRight,
  Pencil,
  PictureInPicture2,
  Pin,
  PinOff,
  Minimize2,
  RefreshCw,
  Settings as SettingsIcon,
  TextAlignCenter,
  Trash2
} from '@/lib/icons'
import { ChatApp } from '@/components/agents/chat-app'
import { AISidebar, type SidebarResource } from '@/components/agents/ai-sidebar'
import {
  AnimatedSidebar,
  AnimatedSidebarContent,
  AnimatedSidebarGroup,
  AnimatedSidebarGroupContent,
  AnimatedSidebarGroupLabel,
  AnimatedSidebarInset,
  AnimatedSidebarMenu,
  AnimatedSidebarMenuButton,
  AnimatedSidebarMenuItem,
  AnimatedSidebarTrigger
} from '@/components/motion/animated-sidebar'
import { ThemeButton } from './ThemeButton'
import { useToast } from './ToastProvider'
import { SandboxEscalationPanel } from './SandboxEscalationPanel'
import { AskUserPanel } from './AskUserPanel'
import { WindowTitlebar } from './WindowTitlebar'
import { TitlebarOverflow } from './TitlebarOverflow'
import { useOverflowFade } from '@/lib/hooks/use-overflow-fade'
import { useScrollFade } from '@/lib/hooks/use-scroll-fade'
import { Button } from '@/components/motion/button'
import { Tooltip } from '@/components/motion/tooltip'
import { basename } from '@/lib/format'
import { cn } from '@/lib/utils'
import { extractUserParts } from '@/lib/user-message'
import { useI18n } from '@/i18n'
import type {
  AssistantMsg,
  ImageContent,
  ModelDTO,
  ModelRefDTO,
  RecalledItemDTO,
  RewindMode,
  SessionSnapshotDTO,
  SessionSummaryDTO,
  ThinkingLevel,
  UserMsg
} from '../../../../shared/types'
import { PiStore } from '@/state/pi-store'
import { useSidebarGlass } from '@/lib/sidebar-glass'
import { SidebarGlassWash, sidebarGlassPanelClassName } from './SidebarGlass'
import type { StreamingBehavior } from '@/lib/streaming-behavior'
import { ChatView } from './ChatView'
import { Composer } from './Composer'
import { BROWSER_ANNOTATION_EVENT } from './BrowserAnnotate'
import type { NewSessionContext } from './NewSession'
import { EditMessageDialog, type EditMessagePayload } from './EditMessageDialog'
import { SettingsPage } from './settings/SettingsPage'
import { ScheduledTasksView } from './scheduled-tasks/ScheduledTasksView'
import { useScheduledTasks } from '@/state/scheduled-tasks-store'
import { SidebarPanel, agentTabId, fileTabId, filePathForTab, type SidebarTabKind, type SidebarTabId } from './SidebarPanel'
import { SessionSearch, SessionSearchTrigger } from './SessionSearch'
import { AppCommandPalette } from './CommandPalette'
import {
  dispatchGuestIdentity,
  guestRelayIdentities
} from '@/lib/shortcuts/shortcut-dispatcher'
import {
  useShortcutBindings,
  useShortcutDispatcher,
  useShortcutHandlers,
  type ShortcutHandlers
} from '@/lib/shortcuts/use-shortcuts'
import {
  CHATS_GROUP, PINNED_GROUP, canReorderSession, forgetSidebarSessions,
  loadSidebarPreferences, orderSessions, reorderSession, saveSidebarPreferences,
  toggleSessionPin, type SessionSidebarPreferences
} from '@/lib/session-sidebar'
import { PanelResizeHandle } from './PanelResizeHandle'
import {
  CHAT_MIN,
  DEFAULT_PANEL_LAYOUT,
  LEFT_PANEL_MAX,
  LEFT_PANEL_MIN,
  RIGHT_PANEL_MAX,
  RIGHT_PANEL_MIN,
  clampPanelWidth,
  fitPanelLayout,
  loadPanelLayout,
  savePanelLayout,
  type PanelLayout
} from '@/lib/panel-layout'
import { SideChatStore } from '@/state/side-chat-store'
import { TerminalStore } from '@/state/terminal-store'
import { DebugStore } from '@/state/debug-store'
import { FileBrowserStore } from '@/state/file-browser-store'
import { BrowserStore } from '@/lib/browser/store'
import { subscribeBrowserPopups } from '@/lib/browser/popup'
import { subscribeBrowserDownloads } from '@/lib/browser/downloads'
import { BROWSER_OPEN_LINK_EVENT } from '@/lib/browser/open-link'
import { HUMAN_OWNER } from '../../../../shared/browser'
import { FileNavigationProvider, type FileTarget } from '@/lib/file-navigation'
import { AuthBridge } from './AuthBridge'
import { AlertTriangle, ArrowLeftFromLine } from '@/lib/icons'
import { RewindDialog } from './RewindDialog'
import { ConfirmDialog } from './ConfirmDialog'
import { SystemPromptDialog } from './SystemPromptDialog'
import type { AuthNotifyDTO, AuthPromptDTO, BrowserStatusDTO } from '../../../../shared/types'
import type { UiStyle } from '@/lib/ui-style'

interface WorkspaceProps {
  store: PiStore
  accent: string
  onAccentChange: (accent: string) => void
  uiStyle: UiStyle
  onUiStyleChange: (style: UiStyle) => void
}

interface PendingDelete {
  kind: 'session' | 'folder'
  /** Session file path, or folder cwd for project deletion. */
  id: string
  label: string
}

/** Sessions revealed per folder expand step ("show more" adds one page). */
const SESSION_PAGE_SIZE = 5
const moreRowId = (cwd: string) => `more:${cwd}`

/** Menu row shown inside beUI's AISidebar row menu — mirrors the vendored
 * ResourceMenuAction styling, in the given tone. Every extra row the app adds
 * to that menu (pin, move, rename, delete) goes through here so they all read
 * alike; the ghost variant's muted text is overridden by `text-foreground`
 * (`cn` resolves the conflict in the caller's favor). */
function SidebarRowMenuAction({ icon: Icon, label, tone = 'default', onSelect }: {
  icon: IconComponent
  label: string
  tone?: 'default' | 'destructive'
  onSelect: () => void
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={onSelect}
      className={cn(
        'flex h-8 w-full items-center justify-start gap-2 rounded-lg px-2.5 text-left text-xs outline-none transition-colors focus-visible:ring-1 focus-visible:ring-ring',
        tone === 'destructive'
          ? 'text-destructive hover:bg-destructive/10 focus-visible:bg-destructive/10'
          : 'text-foreground hover:bg-muted focus-visible:bg-muted'
      )}
    >
      <Icon aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate">{label}</span>
    </Button>
  )
}

export function Workspace({ store, accent, onAccentChange, uiStyle, onUiStyleChange }: WorkspaceProps) {
  const { t } = useI18n()
  const toast = useToast()
  const [continuingPaths, setContinuingPaths] = useState<ReadonlySet<string>>(new Set())
  const continueRequests = useRef(new Set<string>())
  const titleFade = useOverflowFade()
  // One keyboard dispatcher owns every app shortcut (lib/shortcuts); the
  // workspace registers the shell-level commands further down, the composer
  // registers stopAgent, and the vendored ⌘B/⌘K listeners are disabled.
  useShortcutDispatcher()
  const shortcutBindings = useShortcutBindings()
  // A focused webview guest emits no DOM keydown: push the current binding
  // identities to main, which relays matching presses back for dispatch.
  useEffect(() => {
    window.pi.setBrowserAppShortcuts(guestRelayIdentities())
  }, [shortcutBindings])
  useEffect(
    () =>
      window.pi.onBrowserGuestAppShortcut(({ identity, repeat }) =>
        dispatchGuestIdentity(identity, repeat)
      ),
    []
  )
  const [sidebarPreferences, setSidebarPreferences] = useState(loadSidebarPreferences)
  const [sidebarSaveError, setSidebarSaveError] = useState(false)
  /** Frosted-glass session sidebar (Settings → Appearance, default on): only
   * this column consumes it, and the setter lives in the settings row. */
  const [sidebarGlass] = useSidebarGlass()
  const persistSidebarPreferences = useCallback((next: SessionSidebarPreferences) => {
    saveSidebarPreferences(next)
    setSidebarPreferences(next)
    setSidebarSaveError(false)
  }, [])
  // Shell slice only: its identity is stable across streaming deltas, so the
  // sidebar/header/composer don't re-render while ChatView streams.
  const shell = useSyncExternalStore(store.subscribe, store.getShell)
  // Subscribe to a boolean so transcript deltas never re-render the shell.
  // Errors/notices still belong to ChatView, even before the first message.
  const isNewSession = useSyncExternalStore(store.subscribe, () => {
    const state = store.getState()
    return state.ready && state.messages.length === 0 && !state.isStreaming &&
      !state.streaming && !state.error && !state.notice
  })
  const [models, setModels] = useState<ModelDTO[]>([])
  const [sessions, setSessions] = useState<SessionSummaryDTO[]>([])
  const [folders, setFolders] = useState<string[]>([])
  const [settingsOpen, setSettingsOpen] = useState(false)
  /** ⌘K palette and ⌘⇧F session search: controlled here so the shortcut
   * dispatcher owns their toggle keys (each surface re-admits its own key
   * through data-shortcut-passthrough to toggle closed). */
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [sessionSearchOpen, setSessionSearchOpen] = useState(false)
  // The scheduled tasks surface opens over the chat like Settings does; the
  // badge count rides the push-fed store.
  const [scheduledOpen, setScheduledOpen] = useState(false)
  const { unreadCount: scheduledUnread } = useScheduledTasks()
  const [sidePanelMode, setSidePanelMode] = useState<'closed' | 'docked' | 'fullscreen'>('closed')
  const sidePanelOpen = sidePanelMode !== 'closed'
  const sidePanelFullscreen = sidePanelMode === 'fullscreen'
  // Every closing path clears fullscreen atomically, including closing the
  // last tab and the command palette. Opening an already-open tab keeps it.
  const setSidePanelOpen = useCallback((value: boolean | ((open: boolean) => boolean)) => {
    setSidePanelMode((mode) => {
      const open = typeof value === 'function' ? value(mode !== 'closed') : value
      return open ? (mode === 'closed' ? 'docked' : mode) : 'closed'
    })
  }, [])
  /** Left session sidebar open state — controlled so the shell knows how much
   * room the panels actually take, and so the resize strip can toggle it. */
  const [sidebarOpen, setSidebarOpen] = useState(true)
  /**
   * Panel widths the user has SET (dragged), persisted. Kept apart from what is
   * on screen: a narrow window fits the panels down, and widening it again must
   * bring back the widths the user chose rather than ratchet them narrower for
   * good.
   */
  const [panelPreference, setPanelPreference] = useState(loadPanelLayout)
  /** Shell width the fit is computed against (panel widths share its budget). */
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth)
  /** Which panel edge is being dragged right now (widths are direct then). */
  const [resizing, setResizing] = useState<'left' | 'right' | null>(null)
  /** Resize strips that are hovered or dragging, so the panel border they sit
   * on can light up. */
  const [activeEdge, setActiveEdge] = useState<{ left: boolean; right: boolean }>({
    left: false,
    right: false
  })
  /** Width captured when a drag starts, so each move is start + total travel. */
  const dragStartWidth = useRef(0)
  /** The pair a drag is currently showing — committed to state on release. */
  const dragPair = useRef<PanelLayout | null>(null)
  /** The two panel elements that carry their own width; written directly while
   * a drag runs (see `applyPanelWidth`), and from the layout effect otherwise. */
  const leftPanelRef = useRef<HTMLElement | null>(null)
  const rightPanelRef = useRef<HTMLElement | null>(null)
  /** The session list's own scrollport. It carries no bottom padding (the last
   * row reaches the panel's bottom line), so the edge that hides content is
   * marked with the shared ramp instead of chopping a row in half. */
  const sessionListRef = useRef<HTMLDivElement>(null)
  const { maskImage: sessionListMask } = useScrollFade(sessionListRef)
  /** Panes hosted by the right rail; state lives here so closing and
   * re-opening the rail restores the same tabs. */
  const [sidePanelTabs, setSidePanelTabs] = useState<SidebarTabId[]>([])
  const [sidePanelTab, setSidePanelTab] = useState<SidebarTabId | null>(null)
  const [terminals] = useState(() => new TerminalStore())
  const [debugStore] = useState(() => new DebugStore())
  const [files] = useState(() => new FileBrowserStore())
  useEffect(() => () => terminals.dispose(), [terminals])
  useEffect(() => () => debugStore.dispose(), [debugStore])
  // DAP runInTerminal: a debug adapter asks for a real terminal to host the
  // debuggee. Spawn the tab first (opening the terminal pane auto-births a tab
  // only when none exists, and ours already does), and answer main with the
  // shell's pid. Main owns cancellation and command delivery.
  useEffect(() => {
    return window.pi.onDebugTerminalRequest((request) => {
      void terminals.spawnForDebug(request.cwd, request.title).then((result) => {
        if ('error' in result) {
          window.pi.debugTerminalResponse({ requestId: request.requestId, error: result.error })
          return
        }
        window.pi.debugTerminalResponse({ requestId: request.requestId, shellProcessId: result.pid, terminalId: result.id })
        openSidePanelTabRef.current?.('terminal')
      })
    })
  }, [terminals])
  // The embedded browser's store lives as long as the workspace. Its pane is
  // kept mounted across rail tab switches (SidebarPanel's hidden layer), so
  // pages survive those; closing the browser tab unmounts the pane and
  // destroys its guest pages, and so does folding the rail — unless the
  // keep-alive pref holds the folded aside mounted (SidebarPanel), in which
  // case the guests simply live on. Either way, an unmounted pane is restored
  // from the open-pages snapshot on its next mount: owner-carrying entries (an
  // agent page re-registers under its `agent:<sessionId>`), strip repainted in
  // the pane's first commit, only the content reloads.
  const [browserStore] = useState(() => new BrowserStore())
  /** The tab list as a ref: the browser-state subscription below registers
   * once and must read the open state without re-subscribing per change. */
  const sidePanelTabsRef = useRef<SidebarTabId[]>([])
  /** Agent pendingCreate ids the auto-open has already reacted to — a
   * deliberate close is not fought over the same pending batch (already-seen
   * ids never reopen); a NEW pending create opens again. */
  const browserAutoOpenedRef = useRef(new Set<string>())
  /** Latest rail opener; `openSidePanelTab` is defined further down, so the
   * subscription reads it through this ref. */
  const openSidePanelTabRef = useRef<((kind: SidebarTabKind) => void) | null>(null)
  useEffect(() => {
    sidePanelTabsRef.current = sidePanelTabs
  }, [sidePanelTabs])
  useEffect(() => {
    const applyBrowserStatus = (status: BrowserStatusDTO) => {
      browserStore.applyStatus(status)
      // An agent-created page (browser_navigate & co.) needs a pane to host its
      // guest webview: auto-open the browser tab while it is closed. Human
      // pendingCreates never trigger this — the user is already driving.
      const agentPending = status.pendingCreates.filter((p) => p.owner !== HUMAN_OWNER)
      if (agentPending.length > 0) {
        const open = !sidePanelTabsRef.current.includes('browser')
          && agentPending.some((p) => !browserAutoOpenedRef.current.has(p.id))
        for (const p of agentPending) browserAutoOpenedRef.current.add(p.id)
        if (open) openSidePanelTabRef.current?.('browser')
      } else {
        browserAutoOpenedRef.current.clear()
      }
    }
    const unsubscribeState = window.pi.onBrowserState(applyBrowserStatus)
    // Open a closed browser pane only for a newly received popup event, never for queued content. Queues survive pane closure and drain on remount; a user-closed pane must not reopen repeatedly for the same batch.
    const unsubscribePopups = subscribeBrowserPopups(browserStore, () => {
      if (!sidePanelTabsRef.current.includes('browser')) openSidePanelTabRef.current?.('browser')
    })
    // Keep the latest five download events in the store; the toolbar-level indicator survives page switching.
    const unsubscribeDownloads = subscribeBrowserDownloads(browserStore)
    void window.pi.browserStatus().then((status) => applyBrowserStatus(status)).catch(() => {})
    return () => {
      unsubscribeState()
      unsubscribePopups()
      unsubscribeDownloads()
    }
  }, [browserStore])
  const newTerminal = useCallback(() => {
    const current = store.getShell()
    terminals.create(current.projectless ? null : current.cwd)
  }, [store, terminals])
  /** The side chat's exchanges — created with its tab, dropped with it. */
  const [sideChat, setSideChat] = useState<SideChatStore | null>(null)
  /** Composer draft of the side chat; kept here so switching panel tabs (or
   * collapsing the rail) does not discard what was typed. */
  const [sideChatDraft, setSideChatDraft] = useState('')
  /** Browser annotation → composer draft insert (Task 16). The MAIN
   * composer's draft state is fully internal to Composer — there is no
   * external setter and no shared store — so the narrowest intrusion is a
   * one-way "append to draft" payload: Workspace owns the window-event
   * subscription and hands Composer a fresh { text, seq } per annotation;
   * Composer appends it with selectStarter's semantics (existing draft kept,
   * \n\n separator) and focuses the field. The seq (not just the object)
   * matters because two annotations can compose identical text — a value
   * prop alone would not re-fire. */
  const [composerAppend, setComposerAppend] = useState<{ text: string; seq: number } | null>(null)
  const composerAppendSeqRef = useRef(0)
  useEffect(() => {
    const onAnnotation = (event: Event) => {
      const detail = (event as CustomEvent<{ text?: unknown }>).detail
      if (typeof detail?.text !== 'string' || detail.text.length === 0) return
      composerAppendSeqRef.current += 1
      setComposerAppend({ text: detail.text, seq: composerAppendSeqRef.current })
    }
    window.addEventListener(BROWSER_ANNOTATION_EVENT, onAnnotation)
    return () => window.removeEventListener(BROWSER_ANNOTATION_EVENT, onAnnotation)
  }, [])
  /** The turn the review tab should show — set by a transcript Review click. */
  const [reviewTurnId, setReviewTurnId] = useState<number | null>(null)
  /** The live side chat, for handlers that must not depend on its identity. */
  const sideChatRef = useRef<SideChatStore | null>(null)
  const [authPrompt, setAuthPrompt] = useState<AuthPromptDTO | null>(null)
  const [authNotify, setAuthNotify] = useState<AuthNotifyDTO[]>([])
  const [rewindTarget, setRewindTarget] = useState<{ path: string; messageTimestamp?: number; messageEntryId?: string; mode?: RewindMode } | null>(null)
  const [rewindWarning, setRewindWarning] = useState(false)
  const closeRewind = useCallback(() => setRewindTarget(null), [])
  /** One anchored open shared by both entry points: the message names the
   * checkpoint, the mode is what the entry point stands for. */
  const openRewindAt = useCallback((message: UserMsg, mode: RewindMode) => {
    const path = store.getShell().sessionPath
    if (path) setRewindTarget({ path, messageTimestamp: message.timestamp, messageEntryId: message.sessionEntryId, mode })
  }, [store])
  const rewindMessage = useCallback((message: UserMsg) => openRewindAt(message, 'conversation'), [openRewindAt])
  /** The changed-files list's Undo: the same checkpoint, but the restore is
   * preselected to files-only — the workspace writes go, the chat stays. */
  const undoFilesTurn = useCallback((message: UserMsg) => openRewindAt(message, 'files'), [openRewindAt])
  useEffect(() => {
    const path = shell.sessionPath
    setRewindWarning(false)
    if (!path) return
    let cancelled = false, request = 0
    const refresh = async () => {
      const sequence = ++request
      try {
        const reply = await window.pi.rewindList(path)
        if (cancelled || sequence !== request) return
        setRewindWarning('error' in reply || !!reply.value.error)
        if ('value' in reply && reply.value.pending.length) setRewindTarget({ path })
      } catch { if (!cancelled && sequence === request) setRewindWarning(true) }
    }
    void refresh()
    const unsubscribe = window.pi.onRewind(event => { if (event.sessionPath === path) void refresh() })
    return () => { cancelled = true; unsubscribe() }
  }, [shell.sessionPath])
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null)
  /** How many sessions each folder currently reveals; default SESSION_PAGE_SIZE. */
  const [folderLimits, setFolderLimits] = useState<Record<string, number>>({})
  /** Paths of sessions with a live agent run, tracked from pi events. The
   * event stream keeps a background turn's spinner after the user switches
   * to another session, when the session list itself is not re-read. */
  const [liveSessionPaths, setLiveSessionPaths] = useState<ReadonlySet<string>>(new Set())
  /** Latest navigation wins when session creation/opening responses race. */
  const navigationRequest = useRef(0)
  /** Latest model/thinking change still in flight, so an immediate Resend from
   * the edit dialog waits for it instead of re-prompting on the old model. */
  const settingsPending = useRef<Promise<unknown>>(Promise.resolve())
  /** The user message open in the edit-and-resend dialog, if any. */
  const [editTarget, setEditTarget] = useState<UserMsg | null>(null)
  /** Model + thinking level captured when the dialog opens, restored on Cancel
   * so dismissing the editor leaves no session change behind. */
  const editBaseline = useRef<{ model: ModelRefDTO | null; thinkingLevel: ThinkingLevel } | null>(
    null
  )
  /** Bumped on resend/retry so the transcript jumps back to the live edge
   * (the retried user message) even if the user had scrolled up or the
   * rewind left the scroll position mid-history. */
  const [scrollResetKey, setScrollResetKey] = useState(0)

  const refreshModels = useCallback(async () => {
    try {
      setModels(await window.pi.models())
    } catch {
      /* provider discovery failures are non-fatal */
    }
  }, [])

  const refreshSessions = useCallback(async () => {
    try {
      setSessions(await window.pi.listSessions())
    } catch {
      /* ignore */
    }
  }, [])

  const refreshFolders = useCallback(async () => {
    try {
      setFolders((await window.pi.appInfo()).folders)
    } catch {
      /* ignore */
    }
  }, [])

  useEffect(() => {
    void refreshModels()
    void refreshSessions()
    void refreshFolders()
    const offEvent = window.pi.onEvent((event) => {
      // Track agent runs per session from the event stream: they are emitted for
      // background sessions too, so the sidebar spinner survives switching away
      // from a running session. `agent_settled` (not `agent_end`) ends the run:
      // auto-retry, compaction and queued messages continue after agent_end.
      const path = event.sessionPath
      if (path) {
        if (event.type === 'agent_start') {
          setLiveSessionPaths((current) => (current.has(path) ? current : new Set(current).add(path)))
        } else if (event.type === 'agent_settled' || event.type === 'pi_error') {
          setLiveSessionPaths((current) => {
            if (!current.has(path)) return current
            const next = new Set(current)
            next.delete(path)
            return next
          })
        }
      }
      // A materialized new session is already listed; refresh again as soon
      // as its first user message is persisted so the temporary localized
      // "New chat" label becomes the real title without waiting for the turn.
      if (
        event.type === 'agent_start' ||
        event.type === 'agent_end' ||
        event.type === 'session_info_changed' ||
        (event.type === 'message_end' && event.message?.role === 'user')
      ) {
        void refreshSessions()
      }
    })
    const offPrompt = window.pi.onAuthPrompt(setAuthPrompt)
    const offDismiss = window.pi.onAuthDismiss(({ requestId, providerId }) => {
      // The SDK settled a prompt out of band (or it timed out) — drop its dialog.
      setAuthPrompt((current) =>
        current && (current.requestId === requestId || current.providerId === providerId)
          ? null
          : current
      )
      // A finished/cancelled login also closes its result UI (device code, links).
      if (providerId) setAuthNotify((current) => current.filter((n) => n.providerId !== providerId))
    })
    const offNotify = window.pi.onAuthNotify((notify) => {
      setAuthNotify((current) => [...current.slice(-8), notify])
      // Bring the provider's page up immediately. Device-code flows get no
      // prompt but still need the browser (their URI often carries the code).
      const target =
        notify.kind === 'auth_url'
          ? notify.url
          : notify.kind === 'device_code'
            ? notify.verificationUri
            : undefined
      if (target) void window.pi.openExternal(target)
    })
    return () => {
      offEvent()
      offPrompt()
      offDismiss()
      offNotify()
    }
  }, [refreshModels, refreshSessions, refreshFolders])

  useEffect(() => {
    if (!settingsOpen) void refreshModels()
  }, [settingsOpen, refreshModels])

  useEffect(() => {
    if (!authPrompt) setAuthNotify([])
  }, [authPrompt])

  const currentModel = useMemo(
    () =>
      models.find((m) => shell.model && m.providerId === shell.model.providerId && m.id === shell.model.id) ??
      null,
    [models, shell.model]
  )

  const handleSend = useCallback(
    ({ text, images, files }: { text: string; images: ImageContent[]; files: string[] }) => {
      // Mirror the main process's file blocks so chips render on the optimistic echo.
      const blocks = files
        .map((f) => `<file path="${f.replace(/^\//, '')}">(pending)</file>`)
        .join('\n\n')
      store.appendOptimisticUser(files.length ? `${text}\n\n${blocks}` : text, images)
      // Sending always returns to the live edge, even if the user was reading
      // history when they hit send.
      setScrollResetKey((value) => value + 1)
      void window.pi.prompt({ text, images, files })
    },
    [store]
  )

  /**
   * Queue a draft against the running turn — main passes streamingBehavior to
   * AgentSession.prompt(), which decides atomically between queueing and a new
   * run. No optimistic transcript echo: the composer's queue panel (fed by the
   * SDK's queue_update) carries the state until the message is delivered.
   */
  const handleQueue = useCallback(
    (payload: {
      text: string
      images: ImageContent[]
      files: string[]
      streamingBehavior: StreamingBehavior
    }) => {
      void window.pi.prompt(payload)
    },
    []
  )

  /** Recall queued messages: main clears the SDK queues and returns them
   * with full payloads (images, file paths) for the composer to restore. */
  const handleRecallQueue = useCallback(async (stopping = false): Promise<RecalledItemDTO[]> => {
    try {
      const cleared = await window.pi.clearQueue(stopping)
      store.clearQueue()
      return [...cleared.steering, ...cleared.followUp]
    } catch (error) {
      console.error('recall queue failed', error)
      return []
    }
  }, [store])

  const handleModelChange = useCallback(
    async (model: ModelDTO) => {
      const targetPath = store.getShell().sessionPath
      const run = window.pi.setModel(model.providerId, model.id)
      settingsPending.current = run
      const snapshot: SessionSnapshotDTO = await run
      if (store.getShell().sessionPath === targetPath) store.applySnapshot(snapshot)
    },
    [store]
  )

  const handleThinkingChange = useCallback(
    async (level: ThinkingLevel) => {
      const targetPath = store.getShell().sessionPath
      const run = window.pi.setThinkingLevel(level)
      settingsPending.current = run
      const snapshot: SessionSnapshotDTO = await run
      if (store.getShell().sessionPath === targetPath) store.applySnapshot(snapshot)
    },
    [store]
  )

  /**
   * Resend/retry a user message: main rewinds the session to it and re-prompts.
   * The response snapshot replaces the transcript; the fresh run's events take
   * over from there. A message that never persisted (failed send) is re-sent
   * without rewinding — same IPC either way.
   */
  const handleResend = useCallback(
    async (message: UserMsg) => {
      const targetPath = store.getShell().sessionPath
      const { text, images } = extractUserParts(message.content)
      try {
        const snapshot = await window.pi.resendMessage({ timestamp: message.timestamp, text, images })
        if (store.getShell().sessionPath === targetPath) store.applySnapshot(snapshot)
        setScrollResetKey((value) => value + 1)
      } catch (error) {
        console.error('resend failed', error)
      }
    },
    [store]
  )

  const handleContinue = useCallback(async (message: AssistantMsg) => {
    const sessionPath = store.getShell().sessionPath
    if (!sessionPath || continueRequests.current.has(sessionPath)) return
    continueRequests.current.add(sessionPath)
    setContinuingPaths(new Set(continueRequests.current))
    try {
      await window.pi.continueMessage({ sessionPath, timestamp: message.timestamp })
    } catch (error) {
      console.error('continue failed', error)
      toast.error({ title: t('chat.messageContinueFailed') })
    } finally {
      continueRequests.current.delete(sessionPath)
      setContinuingPaths(new Set(continueRequests.current))
    }
  }, [store, t, toast])

  /** Open the edit dialog for a user message; capture the session settings so
   * Cancel can restore them. Does not touch the session yet. */
  const handleEditMessage = useCallback(
    (message: UserMsg) => {
      const shell = store.getShell()
      editBaseline.current = { model: shell.model, thinkingLevel: shell.thinkingLevel }
      setEditTarget(message)
    },
    [store]
  )

  /**
   * Resend the edited message: main rewinds the session to it and re-prompts
   * with the dialog's text/images/files (`edited: true`, so the stored
   * text/images are not restored). The session model/thinking picked in the
   * dialog were already applied through the normal setters and stay. The
   * response snapshot replaces the transcript.
   */
  const handleEditResend = useCallback(
    async (payload: EditMessagePayload) => {
      const target = editTarget
      if (!target) return
      const targetPath = store.getShell().sessionPath
      try {
        await settingsPending.current.catch(() => {})
        const snapshot = await window.pi.resendMessage({
          timestamp: target.timestamp,
          text: payload.text,
          images: payload.images,
          files: payload.files,
          edited: true
        })
        if (store.getShell().sessionPath === targetPath) store.applySnapshot(snapshot)
        setScrollResetKey((value) => value + 1)
      } catch (error) {
        console.error('edit resend failed', error)
      } finally {
        editBaseline.current = null
        setEditTarget(null)
      }
    },
    [store, editTarget]
  )

  /** Dismiss the editor without resending; restore any model/thinking change
   * the user made inside it so Cancel is truly a no-op. */
  const handleCancelEdit = useCallback(async () => {
    const before = editBaseline.current
    editBaseline.current = null
    setEditTarget(null)
    if (!before) return
    const shell = store.getShell()
    const modelChanged =
      (shell.model?.providerId ?? null) !== (before.model?.providerId ?? null) ||
      (shell.model?.id ?? null) !== (before.model?.id ?? null)
    try {
      if (modelChanged) {
        await settingsPending.current.catch(() => {})
        if (before.model) {
          const snapshot = await window.pi.setModel(before.model.providerId, before.model.id)
          store.applySnapshot(snapshot)
        }
      }
      if (store.getShell().thinkingLevel !== before.thinkingLevel) {
        const snapshot = await window.pi.setThinkingLevel(before.thinkingLevel)
        store.applySnapshot(snapshot)
      }
    } catch (error) {
      console.error('restore edit settings failed', error)
    }
  }, [store])

  /**
   * Manual compaction — the CLI's `/compact`. The SDK's manual entry point
   * aborts whatever is running first and never retries the interrupted turn,
   * so a live run is refused here rather than silently killed: the user stops
   * the turn deliberately, then compacts. Shared by the title row's pocket and
   * the command palette, which must not drift apart.
   */
  const handleCompact = useCallback(async () => {
    const targetPath = store.getShell().sessionPath
    if (store.getShell().isStreaming) { toast.info({ title: t('palette.compactBusy') }); return }
    if (!targetPath) return
    try {
      const snapshot = await window.pi.compactSession(targetPath)
      if (store.getShell().sessionPath === targetPath) store.applySnapshot(snapshot)
    } catch (error) {
      // A brand-new / just-started session has nothing to summarize. Keep it
      // out of the transcript and report it as a transient toast instead.
      if (isNothingToCompactError(error)) {
        toast.error({ title: t('palette.compactNothingToCompact') })
        return
      }
      // Other compaction failures still render as their own `SummaryRow` error
      // row in the transcript, where the reason can be read and kept.
    }
  }, [store, t, toast])

  /**
   * Manual resource reload — the app's `/reload`. Extensions, skills, prompts
   * and context files are re-read from disk and each live session's derived
   * system prompt is rebuilt, which is how an edit made OUTSIDE the app (an
   * extension's source, a SKILL.md, an AGENTS.md) reaches the next turn without
   * a restart. A live run is refused — reloading swaps the extension runner
   * under the request in flight — so the user stops the turn first, exactly as
   * with compaction.
   */
  const handleReload = useCallback(async () => {
    const targetPath = store.getShell().sessionPath
    if (store.getShell().isStreaming) { toast.info({ title: t('palette.reloadBusy') }); return }
    if (!targetPath) return
    try {
      const snapshot = await window.pi.reloadSession(targetPath)
      if (store.getShell().sessionPath === targetPath) store.applySnapshot(snapshot)
      toast.success({ title: t('palette.reloadDone') })
    } catch {
      toast.error({ title: t('palette.reloadFailed') })
    }
  }, [store, t, toast])

  /**
   * The overflow menu's "View system prompt" entry. The prompt is fetched
   * from main on EVERY open — never cached renderer-side — so the dialog
   * always shows the session's current effective system prompt: the SDK
   * rebuilds it on model, tool and resource changes, and a reload lands in
   * the next read.
   */
  const [systemPromptText, setSystemPromptText] = useState<string | null>(null)
  const showSystemPrompt = useCallback(async () => {
    try {
      setSystemPromptText(await window.pi.systemPrompt(store.getShell().sessionPath ?? undefined))
    } catch {
      toast.error({ title: t('systemPrompt.loadFailed') })
    }
  }, [store, t, toast])

  /** Fork the session at an assistant message: the fork opens as the active
   * session, gets its localized "Fork of …" title, and joins the sidebar. */
  const handleFork = useCallback(
    async (message: AssistantMsg) => {
      const request = ++navigationRequest.current
      try {
        const { snapshot, baseLabel } = await window.pi.forkFromMessage(message.timestamp)
        if (request !== navigationRequest.current) return
        store.applySnapshot(snapshot)
        if (snapshot.sessionPath && baseLabel) {
          await window.pi
            .renameSession(snapshot.sessionPath, t('chat.forkOf', { name: baseLabel }))
            .catch(() => {})
        }
        void refreshSessions()
      } catch (error) {
        console.error('fork failed', error)
      }
    },
    [store, refreshSessions, t]
  )

  /**
   * Open the side chat. It is renderer state only — the questions are no-tools
   * completions over this session's committed context, so there is no session
   * to create and nothing to clean up when the tab closes.
   */
  const openSideChat = useCallback(() => {
    if (sideChatRef.current) return
    const created = new SideChatStore(store.getShell().sessionPath)
    sideChatRef.current = created
    setSideChatDraft('')
    setSideChat(created)
  }, [store])

  /** Stable so a shell re-render (a panel resize) never re-renders the
   * transcript: `ChatView` is memoized on its props. */
  const dismissChatError = useCallback(() => store.clearError(), [store])

  /** Destroy the side chat: stop its answer and drop every exchange. */
  const closeSideChat = useCallback(() => {
    const current = sideChatRef.current
    sideChatRef.current = null
    setSideChatDraft('')
    setSideChat(null)
    current?.dispose()
  }, [])

  /**
   * Point the side chat at the session the workspace is showing now. The thread
   * and its context belong to the session it was asked against, so rebinding
   * starts over: closing the old store aborts any running answer and drops the
   * exchanges, then a new store binds to the current session. A click while the
   * two already match does nothing.
   */
  const rebindSideChat = useCallback(() => {
    const current = sideChatRef.current
    const target = store.getShell().sessionPath
    if (current && current.boundSessionPath === target) return
    closeSideChat()
    openSideChat()
  }, [closeSideChat, openSideChat, store])

  /** Open a pane in the right rail (idempotent) and make it the active tab. */
  const openSidePanelTabId = useCallback((id: SidebarTabId) => {
    setSidePanelTabs((current) => (current.includes(id) ? current : [...current, id]))
    setSidePanelTab(id)
    // A tab opened from the chat (a subagent session) must reveal the rail; the
    // picker path is already inside it, where this is a no-op.
    setSidePanelOpen(true)
  }, [])

  const openSidePanelTab = useCallback(
    (kind: SidebarTabKind) => {
      openSidePanelTabId(kind)
      // A side chat is born with its tab.
      if (kind === 'chat') openSideChat()
      if (kind === 'terminal' && terminals.getSnapshot().tabs.length === 0) newTerminal()
    },
    [openSidePanelTabId, openSideChat, terminals, newTerminal]
  )
  // The browser-state subscription registered earlier reads the opener through
  // its ref — synced here, after the callback it wraps exists.
  useEffect(() => {
    openSidePanelTabRef.current = openSidePanelTab
  })

  // Ordinary HTTP(S) chat clicks open the browser pane through open-link. The queue also covers events preceding subscription: BrowserPane drains on later mount.
  useEffect(() => {
    const open = () => openSidePanelTabRef.current?.('browser')
    window.addEventListener(BROWSER_OPEN_LINK_EVENT, open)
    return () => window.removeEventListener(BROWSER_OPEN_LINK_EVENT, open)
  }, [])

  /**
   * A delegation's "open session" shows the child BESIDE the chat. Navigating
   * the visible conversation to a read-only child used to lose the user's place
   * in the parent for what is usually a glance; the pane's own action still
   * offers the full view when that is what they want.
   */
  const openAgentPane = useCallback((path: string) => {
    openSidePanelTabId(agentTabId(path))
  }, [openSidePanelTabId])
  /** The rail's agent tabs are keyed by the CHILD session file. */
  const agentRuns = useMemo(
    () => new Map((shell.subagents ?? []).map((run) => [run.sessionPath, run])),
    [shell.subagents]
  )

  /** Local conversation links reveal the files pane and preserve other tabs. */
  const openFile = useCallback((target: FileTarget) => {
    files.open(store.getShell().cwd ?? '', target)
  }, [files, store])

  useEffect(() => files.subscribeOpen(path => {
    const id = fileTabId(path)
    setSidePanelTabs(current => {
      if (current.includes(id)) return current.filter(tab => tab !== 'files')
      return current.includes('files') ? current.map(tab => tab === 'files' ? id : tab) : [...current, id]
    })
    setSidePanelTab(id)
    setSidePanelOpen(true)
  }), [files])

  const selectSidePanelTab = useCallback((id: SidebarTabId) => {
    const path = filePathForTab(id)
    if (path) files.select(path)
    setSidePanelTab(id)
  }, [files])

  /** Close a pane; the neighbour to its left takes over as the active tab. */
  const closeSidePanelTab = useCallback(
    (kind: SidebarTabId) => {
      const index = sidePanelTabs.indexOf(kind)
      if (index < 0) return
      const next = sidePanelTabs.filter((tab) => tab !== kind)
      setSidePanelTabs(next)
      setSidePanelTab((active) =>
        active === kind ? (next[index - 1] ?? next[index] ?? null) : active
      )
      // Closing the side-chat tab destroys the thread — nothing outlives it.
      if (kind === 'chat') closeSideChat()
      if (kind === 'terminal') terminals.dispose()
      const filePath = filePathForTab(kind)
      if (filePath) files.close(filePath)
      // An empty rail has nothing to show (and its picker is one button away in
      // the header), so closing the last tab folds it away.
      if (next.length === 0) setSidePanelOpen(false)
    },
    [sidePanelTabs, closeSideChat, terminals, files]
  )

  /**
   * Close every tab but one. Each tab keeps its own teardown (the side chat is
   * destroyed, the terminal disposed, the file closed), so this loops through
   * the same path rather than dropping the list.
   */
  const closeOtherSidePanelTabs = useCallback(
    (keep: SidebarTabId) => {
      for (const tab of sidePanelTabs) if (tab !== keep) closeSidePanelTab(tab)
      setSidePanelTabs([keep])
      setSidePanelTab(keep)
    },
    [sidePanelTabs, closeSidePanelTab]
  )

  const closeAllSidePanelTabs = useCallback(() => {
    for (const tab of sidePanelTabs) closeSidePanelTab(tab)
    setSidePanelTabs([])
    setSidePanelTab(null)
    setSidePanelOpen(false)
  }, [sidePanelTabs, closeSidePanelTab])

  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  /**
   * What is actually on screen: the three columns share one budget, so when the
   * window shrinks (or a panel opens) the shortfall comes out of the panels —
   * never out of the transcript, which keeps `CHAT_MIN` at every size.
   */
  const panelLayout = useMemo(
    () =>
      fitPanelLayout(panelPreference, viewportWidth, {
        left: sidebarOpen,
        right: sidePanelOpen
      }),
    [panelPreference, viewportWidth, sidebarOpen, sidePanelOpen]
  )

  // Only a drag changes the preference, so this is a per-gesture write, never a
  // per-pointermove one.
  useEffect(() => {
    savePanelLayout(panelPreference)
  }, [panelPreference])

  /** A panel's own element, re-queried whenever the cached one was unmounted
   * (the rail folds, a session switch rebuilds the sidebar). */
  const panelElement = useCallback((side: 'left' | 'right') => {
    const cached = side === 'left' ? leftPanelRef.current : rightPanelRef.current
    if (cached?.isConnected) return cached
    const found = document.querySelector<HTMLElement>(
      side === 'left' ? 'aside[data-slot="sidebar"]' : '[data-panel="right"]'
    )
    if (side === 'left') leftPanelRef.current = found
    else rightPanelRef.current = found
    return found
  }, [])

  /**
   * Publish one panel's width as a CSS variable ON THAT PANEL.
   *
   * Deliberately not on a shared ancestor: a custom property is inherited, so
   * writing it higher up invalidates the computed style of every element below —
   * ~25k of them in a long session, once per pointermove, which measured as 0.8s
   * of style recalc for a single drag. On the panel itself the invalidation stops
   * at that panel's own subtree, and the drag costs no React render at all: the
   * two panels, and only they, reflow.
   */
  const applyPanelWidth = useCallback(
    (side: 'left' | 'right', px: number) => {
      const element = panelElement(side)
      element?.style.setProperty(side === 'left' ? '--sidebar-width' : '--panel-right', `${px}px`)
    },
    [panelElement]
  )

  // Commit path: what is on screen is what the panels carry.
  useLayoutEffect(() => {
    applyPanelWidth('left', panelLayout.left)
    applyPanelWidth('right', panelLayout.right)
  }, [panelLayout, applyPanelWidth])


  /**
   * One panel's drag: the width it started at plus the pointer's total travel,
   * clamped by its own bounds — and, when the pair would no longer fit beside
   * the transcript, taken out of the OTHER panel (down to its minimum) rather
   * than out of the chat.
   *
   * Nothing here goes through React: the pair is written straight to the CSS
   * variables, so the two panels and the transcript reflow while the rest of the
   * shell is untouched. `dragPair` carries the result to the release, which
   * commits it as the user's new preference.
   */
  const resizePanels = useCallback(
    (side: 'left' | 'right', delta: number) => {
      const base = panelLayout
      const min = side === 'left' ? LEFT_PANEL_MIN : RIGHT_PANEL_MIN
      const max = side === 'left' ? LEFT_PANEL_MAX : RIGHT_PANEL_MAX
      // The other panel gives way only while both are on screen, and it can
      // always give way down to its own floor — so the dragged panel's ceiling
      // is what is left once that floor and the transcript's `CHAT_MIN` are
      // reserved. Without it a drag past the sibling's floor crushes the
      // transcript, which is the one column that must never be the one to give.
      const siblingVisible = side === 'left' ? sidePanelOpen : sidebarOpen
      const siblingMin = side === 'left' ? RIGHT_PANEL_MIN : LEFT_PANEL_MIN
      const value = clampPanelWidth(
        dragStartWidth.current + delta,
        min,
        max,
        siblingVisible ? siblingMin : 0,
        viewportWidth
      )
      const next: PanelLayout = { ...base, [side]: value }

      if (siblingVisible) {
        const room = Math.max(0, viewportWidth - CHAT_MIN) - value
        const sibling = side === 'left' ? 'right' : 'left'
        next[sibling] = Math.round(Math.max(siblingMin, Math.min(base[sibling], room)))
      }

      dragPair.current = next
      applyPanelWidth('left', next.left)
      applyPanelWidth('right', next.right)
    },
    [panelLayout, sidebarOpen, sidePanelOpen, viewportWidth, applyPanelWidth]
  )

  /** Light up the border line a resize strip sits on (nothing else is drawn). */
  const setEdgeActive = useCallback((edge: 'left' | 'right', active: boolean) => {
    setActiveEdge((current) => (current[edge] === active ? current : { ...current, [edge]: active }))
  }, [])
  const onLeftEdgeActive = useCallback(
    (active: boolean) => setEdgeActive('left', active),
    [setEdgeActive]
  )
  const onRightEdgeActive = useCallback(
    (active: boolean) => setEdgeActive('right', active),
    [setEdgeActive]
  )

  /** Release: make what the drag showed the user's preference, so the rendered
   * layout is exactly what is on screen (and nothing jumps). */
  const commitPanelDrag = useCallback(() => {
    setResizing(null)
    const pair = dragPair.current
    dragPair.current = null
    if (pair) setPanelPreference(pair)
  }, [])

  /**
   * Open the review tab on one turn: the transcript's changed-files card hands
   * over its turn's first assistant message, which is the identity the pane
   * groups its own turns by. Reviewing is something the user asked to see, so
   * the rail opens with it.
   */
  const openReview = useCallback(
    (turnId: number) => {
      setReviewTurnId(turnId)
      openSidePanelTab('review')
      setSidePanelOpen(true)
    },
    [openSidePanelTab]
  )

  /** Top-level action starts a chat without a project; project + passes cwd. */
  const newSession = useCallback(
    async (cwd?: string) => {
      const request = ++navigationRequest.current
      const snapshot: SessionSnapshotDTO = await window.pi.newSession(cwd)
      if (request !== navigationRequest.current) return
      store.applySnapshot(snapshot)
      void refreshSessions()
      void refreshFolders()
    },
    [store, refreshSessions, refreshFolders]
  )

  const openSession = useCallback(
    async (path: string, cwd?: string) => {
      const request = ++navigationRequest.current
      // Queue main-process activation first, then paint an already-visited
      // session synchronously instead of waiting for the IPC round trip and
      // full snapshot serialization.
      const opening = window.pi.openSession(path, cwd)
      store.activateCachedSession(path)
      const snapshot: SessionSnapshotDTO = await opening
      if (request !== navigationRequest.current) return
      store.applySnapshot(snapshot)
      void refreshFolders()
    },
    [store, refreshFolders]
  )

  /** History's View conversation navigates the main transcript. The task
   * page sits above the workspace, so close it only after activation succeeds. */
  const openScheduledConversation = useCallback(async (path: string) => {
    await openSession(path)
    setScheduledOpen(false)
    setSidePanelOpen(false)
  }, [openSession, setSidePanelOpen])

  /** Runs after the confirm dialog's Delete press; trash is reversible. */
  const confirmDelete = useCallback(async () => {
    const target = pendingDelete
    if (!target) return
    setPendingDelete(null)
    const request = ++navigationRequest.current
    try {
      const snapshot =
        target.kind === 'session'
          ? await window.pi.deleteSession(target.id)
          : await window.pi.deleteFolder(target.id)
      if (snapshot && request === navigationRequest.current) store.applySnapshot(snapshot)
      const removed = new Set(target.kind === 'session' ? [target.id] : sessions.filter((s) => s.cwd === target.id).map((s) => s.path))
      try { persistSidebarPreferences(forgetSidebarSessions(sidebarPreferences, removed)) }
      catch { setSidebarSaveError(true) }
    } catch (error) {
      console.error('delete failed', error)
    } finally {
      void refreshSessions()
      void refreshFolders()
    }
  }, [pendingDelete, store, refreshSessions, refreshFolders, sessions, sidebarPreferences, persistSidebarPreferences])

  const deleteSessionCount = useMemo(
    () => (pendingDelete?.kind === 'folder' ? sessions.filter((s) => s.cwd === pendingDelete.id).length : 0),
    [pendingDelete, sessions]
  )

  const changeFolder = useCallback(async () => {
    const result = await window.pi.pickDirectory()
    if (!('cancelled' in result)) {
      const request = ++navigationRequest.current
      const snapshot: SessionSnapshotDTO = await window.pi.init(result.cwd)
      if (request !== navigationRequest.current) return
      store.applySnapshot(snapshot)
      void refreshSessions()
      void refreshModels()
      void refreshFolders()
    }
  }, [store, refreshModels, refreshSessions, refreshFolders])

  /**
   * Sidebar tree: one folder node per known folder (opened in the app or with
   * sessions on disk), active folder first, each listing its sessions. The
   * active folder is only listed while it is known or still has sessions —
   * deleting a project drops it until a new session shows up there.
   */
  const folderGroups = useMemo(() => {
    const byFolder = new Map<string, SessionSummaryDTO[]>()
    for (const session of sessions) {
      if (session.projectless) continue
      const list = byFolder.get(session.cwd) ?? []
      list.push(session)
      byFolder.set(session.cwd, list)
    }
    const activeListed =
      shell.cwd != null && (folders.includes(shell.cwd) || byFolder.has(shell.cwd))
    const ordered = [
      ...(shell.cwd && activeListed ? [shell.cwd] : []),
      ...folders.filter((f) => f !== shell.cwd),
      ...[...byFolder.keys()].filter((f) => f !== shell.cwd && !folders.includes(f))
    ]
    const seen = new Set<string>()
    return ordered
      .filter((f) => !seen.has(f) && seen.add(f))
      .map((cwd) => ({ cwd, sessions: byFolder.get(cwd) ?? [] }))
  }, [sessions, folders, shell.cwd])

  const sessionsByPath = useMemo(() => new Map(sessions.map((session) => [session.path, session])), [sessions])

  /** Sidebar row action: copy the session's own ID (the SDK header's id), not
   * its file path — that is the value other tools address the session by. */
  const copySessionId = useCallback((path: string) => {
    const sessionId = sessionsByPath.get(path)?.id
    if (!sessionId) {
      toast.error({ title: t('workspace.sessionIdCopyFailed') })
      return
    }
    navigator.clipboard
      .writeText(sessionId)
      .then(() => toast.success({ title: t('workspace.sessionIdCopied') }))
      .catch(() => toast.error({ title: t('workspace.sessionIdCopyFailed') }))
  }, [sessionsByPath, t, toast])

  /** Projects a new chat can be started in: the sidebar's own folder order,
   * with the active cwd kept in front even before the list catches up. The
   * projectless workspace is never offered as a path — only as "no project". */
  const newSessionProjects = useMemo(() => {
    const options = folderGroups.map((group) => ({ cwd: group.cwd, label: basename(group.cwd) }))
    if (shell.cwd && !shell.projectless && !options.some((option) => option.cwd === shell.cwd)) {
      options.unshift({ cwd: shell.cwd, label: basename(shell.cwd) })
    }
    return options
  }, [folderGroups, shell.cwd, shell.projectless])

  /** Landing-page context: which project the new chat runs in, and how to move
   * it. Changing it creates a fresh session there (the SDK fixes a session's
   * cwd at creation); an unanswered session is only written once an assistant
   * reply lands, so switching back and forth leaves no stray file behind. */
  const newSessionStart = useMemo<NewSessionContext | undefined>(() => {
    if (!isNewSession) return undefined
    const active = shell.cwd && !shell.projectless ? shell.cwd : null
    return {
      projectName: active ? basename(active) : null,
      cwd: active,
      projects: newSessionProjects,
      onProjectChange: (cwd) => newSession(cwd ?? undefined),
      // "New project…": ask for a folder that is not a known project yet and
      // start the chat there. `newSession` remembers it as a folder, so the
      // sidebar lists it (and its sessions) from that moment on.
      onCreateProject: async () => {
        try {
          const result = await window.pi.pickDirectory()
          if ('cancelled' in result) return
          await newSession(result.cwd)
        } catch (error) {
          console.error('project pick failed', error)
        }
      }
    }
  }, [isNewSession, shell.cwd, shell.projectless, newSessionProjects, newSession])

  const pinnedPaths = useMemo(() => new Set(sidebarPreferences.pinned), [sidebarPreferences.pinned])
  const sidebarGroups = useMemo(() => {
    const ranks = new Map(sidebarPreferences.order.map((path, index) => [path, index]))
    const pinned = orderSessions(sessions.filter((session) => pinnedPaths.has(session.path)), sidebarPreferences.pinned)
    const chats = orderSessions(sessions.filter((session) => session.projectless && !pinnedPaths.has(session.path)), ranks)
    return [
      ...(pinned.length ? [{ id: PINNED_GROUP, label: t('workspace.pinnedSessions'), sessions: pinned }] : []),
      ...folderGroups.map((group) => ({
        id: `folder:${group.cwd}`, label: basename(group.cwd),
        sessions: orderSessions(group.sessions.filter((session) => !pinnedPaths.has(session.path)), ranks)
      })),
      { id: CHATS_GROUP, label: t('workspace.projectlessSessions'), sessions: chats }
    ]
  }, [sessions, pinnedPaths, sidebarPreferences, folderGroups, t])
  const sessionItems: SidebarResource[] = useMemo(() => sidebarGroups.map((group) => {
    const visible = group.sessions.slice(0, folderLimits[group.id] ?? SESSION_PAGE_SIZE)
    return {
      id: group.id, label: group.label, kind: 'folder',
      children: [
        ...visible.map((session) => ({ id: session.path, label: session.label ?? t('workspace.newChat'), kind: 'file' as const })),
        ...(visible.length < group.sessions.length
          ? [{ id: moreRowId(group.id), label: t('workspace.showMore'), kind: 'file' as const }] : [])
      ]
    }
  }), [sidebarGroups, folderLimits, t])
  const folderKey = sidebarGroups.map((group) => group.id).join('|')
  /** Session paths whose live SDK session is currently streaming, so the
   * sidebar row shows the running spinner instead of the file glyph. The
   * visible session is included from the shell slice so the spinner appears
   * the instant its turn starts, without waiting for the list refresh. */
  const runningPaths = useMemo(() => {
    const paths = new Set(liveSessionPaths)
    for (const session of sessions) {
      if (session.running) paths.add(session.path)
    }
    if (shell.isStreaming && shell.sessionPath) paths.add(shell.sessionPath)
    return paths
  }, [liveSessionPaths, sessions, shell.isStreaming, shell.sessionPath])

  /**
   * A pane shortcut toggles: the pane's tab is already active in an open rail
   * → fold the rail; otherwise open/switch to it (openSidePanelTab also
   * births the side chat / first terminal their tabs need).
   */
  const toggleRailPane = useCallback(
    (kind: SidebarTabKind) => {
      if (sidePanelOpen && sidePanelTab === kind) setSidePanelOpen(false)
      else openSidePanelTab(kind)
    },
    [sidePanelOpen, sidePanelTab, openSidePanelTab, setSidePanelOpen]
  )

  /** ⌘⌥←/→ cycle the rail's tabs in strip order. */
  const cycleRailTab = useCallback(
    (direction: 1 | -1) => {
      if (sidePanelTabs.length < 2) return
      const index = sidePanelTab ? sidePanelTabs.indexOf(sidePanelTab) : -1
      const next =
        sidePanelTabs[(index + direction + sidePanelTabs.length) % sidePanelTabs.length]
      if (next) selectSidePanelTab(next)
    },
    [sidePanelTabs, sidePanelTab, selectSidePanelTab]
  )

  // The shell's shortcut commands. The record is memoized; registration is a
  // lease, so a re-render never leaves a stale closure behind.
  const shortcutHandlers = useMemo<ShortcutHandlers>(
    () => ({
      newSession: () => {
        void newSession()
      },
      commandPalette: () => setPaletteOpen((open) => !open),
      sessionSearch: () => setSessionSearchOpen((open) => !open),
      openSettings: () => setSettingsOpen((open) => !open),
      toggleSidebar: () => setSidebarOpen((open) => !open),
      toggleRail: () => setSidePanelOpen((open) => !open),
      openReview: () => toggleRailPane('review'),
      openTrajectory: () => toggleRailPane('trajectory'),
      openContext: () => toggleRailPane('context'),
      openTerminal: () => toggleRailPane('terminal'),
      openDebug: () => toggleRailPane('debug'),
      openBrowser: () => toggleRailPane('browser'),
      openFiles: () => toggleRailPane('files'),
      openSideChat: () => toggleRailPane('chat'),
      closeRailTab: () => {
        if (sidePanelTab) closeSidePanelTab(sidePanelTab)
      },
      nextRailTab: () => cycleRailTab(1),
      prevRailTab: () => cycleRailTab(-1)
    }),
    [
      newSession,
      setSidePanelOpen,
      toggleRailPane,
      cycleRailTab,
      sidePanelTab,
      closeSidePanelTab
    ]
  )
  useShortcutHandlers(shortcutHandlers)

  return (
    <FileNavigationProvider cwd={shell.cwd ?? ''} openFile={openFile}>
    <SessionSearch sessions={sessions} activePath={shell.sessionPath ?? null} runningPaths={runningPaths} onOpen={openSession} open={sessionSearchOpen} onOpenChange={setSessionSearchOpen}>
    <ChatApp
      className="relative h-full flex-col rounded-none border-0"
      sidebarWidth={`${panelLayout.left}px`}
      open={sidebarOpen}
      onOpenChange={setSidebarOpen}
      // The dispatcher owns the sidebar's ⌘B; the vendored listener stays off.
      keyboardShortcut={null}
    >
      {/* The title row owns the shell's top rule: it spans the whole window,
          sidebar included, so the line under the header reaches the app's left
          edge. The content pane therefore carries no top border of its own. */}
      <WindowTitlebar className="border-b border-border/50">
        <Tooltip content={t('workspace.toggleSessions')}>
          <AnimatedSidebarTrigger aria-label={t('workspace.toggleSessions')} className="size-8 text-muted-foreground hover:bg-muted hover:text-foreground">
            <PanelLeft className="size-[18px]" />
          </AnimatedSidebarTrigger>
        </Tooltip>
        <div className="flex min-w-0 flex-1 items-center gap-2 text-sm">
          {shell.cwd && !shell.projectless ? (
            <>
              <Tooltip content={shell.cwd}>
                <span data-window-interactive className="flex max-w-40 items-center gap-1.5 text-muted-foreground">
                  <Folder className="size-3.5 shrink-0" aria-hidden="true" />
                  <span className="truncate">{basename(shell.cwd)}</span>
                </span>
              </Tooltip>
              <ChevronRight className="size-3 shrink-0 text-muted-foreground/50" aria-hidden="true" />
            </>
          ) : null}
          <span ref={titleFade.viewportRef} className="min-w-0 overflow-hidden whitespace-nowrap font-medium text-foreground data-[overflow]:[mask-image:linear-gradient(to_right,black_calc(100%-24px),transparent)]">
            <span ref={titleFade.textRef} className="inline-block">
              {shell.scheduledTaskSession
                ? t('scheduledTasks.run.conversationTitle')
                : isNewSession ? t('workspace.newChat') : sessionsByPath.get(shell.sessionPath ?? '')?.label ?? t('workspace.newChat')}
            </span>
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {/* Everything added to this row after its original toolbar lives in
              here, so the controls that follow keep their places. The
              checkpoint entry goes in last because the pocket unfolds
              leftward: that keeps it next to the chevron, where it sat when it
              led this group, instead of jumping a width to the left. */}
          <TitlebarOverflow
            actions={[
              {
                id: 'compact',
                label: t('palette.compact'),
                icon: <Minimize2 className="size-[18px]" />,
                disabled: !shell.sessionPath || shell.scheduledTaskSession,
                onSelect: () => void handleCompact()
              },
              {
                id: 'reload',
                label: t('palette.reload'),
                icon: <RefreshCw className="size-[18px]" />,
                disabled: !shell.sessionPath || shell.scheduledTaskSession,
                onSelect: () => void handleReload()
              },
              {
                id: 'system-prompt',
                label: t('workspace.systemPrompt'),
                icon: <TextAlignCenter className="size-[18px]" />,
                // Always available: the manager falls back to the active
                // session, so an unpersisted chat has a prompt to show too.
                onSelect: () => void showSystemPrompt()
              },
              {
                id: 'picture-in-picture',
                label: t('pip.open'),
                icon: <PictureInPicture2 className="size-[18px]" />,
                disabled: !shell.sessionPath,
                onSelect: () => {
                  if (!shell.sessionPath) return
                  const target = sidePanelFullscreen
                    ? document.querySelector<HTMLElement>('[data-panel="right"][data-panel-fullscreen]')
                    : document.querySelector<HTMLElement>('[data-pip-source="conversation"]')
                  if (!target) { toast.error({ title: t('pip.openError') }); return }
                  const bounds = target.getBoundingClientRect()
                  void window.pi.openPictureInPicture({
                    sessionPath: shell.sessionPath,
                    source: {
                      kind: sidePanelFullscreen ? 'sidebar' : 'conversation',
                      rect: {
                        x: Math.floor(bounds.left), y: Math.floor(bounds.top),
                        width: Math.ceil(bounds.right) - Math.floor(bounds.left),
                        height: Math.ceil(bounds.bottom) - Math.floor(bounds.top)
                      }
                    }
                  })
                    .then((opened) => { if (!opened) toast.error({ title: t('pip.openError') }) })
                    .catch(() => toast.error({ title: t('pip.openError') }))
                }
              },
              // A scheduled run owns its own conversation: it has no checkpoint
              // entry, exactly as it has no rewind affordances anywhere else.
              ...(shell.scheduledTaskSession ? [] : [{
                id: 'rewind',
                label: t(rewindWarning ? 'rewind.captureWarning' : 'rewind.title'),
                icon: rewindWarning ? <AlertTriangle className="size-4 text-destructive" /> : <ArrowLeftFromLine className="size-[18px]" />,
                disabled: !shell.sessionPath,
                onSelect: () => { if (shell.sessionPath) setRewindTarget({ path: shell.sessionPath }) }
              }])
            ]}
          />
          <Tooltip content={t('workspace.settings')} className={settingsOpen ? 'hidden' : undefined}>
            <Button variant="ghost" size="icon" className="size-8" aria-label={t('workspace.settings')} onClick={() => setSettingsOpen(true)}>
              <SettingsIcon className="size-[18px]" />
            </Button>
          </Tooltip>
          <ThemeButton />
          {/* Fullscreen stays in the row, beside the rail toggle it belongs to,
              and wears one of the two horizontal arrow pairs rather than the
              diagonal `Minimize2` it used to share with the pocket's summarize
              action — two controls, two readings. */}
          <Tooltip content={t(sidePanelFullscreen ? 'workspace.exitSidebarFullscreen' : 'workspace.sidebarFullscreen')}>
            <Button
              variant="ghost"
              size="icon"
              className="size-8"
              aria-label={t(sidePanelFullscreen ? 'workspace.exitSidebarFullscreen' : 'workspace.sidebarFullscreen')}
              aria-pressed={sidePanelFullscreen}
              data-titlebar-action="sidebar-fullscreen"
              disabled={!sidePanelOpen}
              onClick={() => setSidePanelMode((mode) => mode === 'closed' ? mode : mode === 'fullscreen' ? 'docked' : 'fullscreen')}
            >
              {sidePanelFullscreen ? <ArrowsInLineHorizontal className="size-[18px]" /> : <ArrowsOutLineHorizontal className="size-[18px]" />}
            </Button>
          </Tooltip>
          <Tooltip content={t('workspace.sidebar')}>
            <Button variant="ghost" size="icon" aria-label={t('workspace.sidebar')} aria-pressed={sidePanelOpen}
              onClick={() => setSidePanelOpen((open) => !open)} className={cn('size-8', sidePanelOpen && 'bg-primary/5 text-foreground')}>
              <PanelRight className="size-[18px]" />
            </Button>
          </Tooltip>
        </div>
      </WindowTitlebar>
      <div className="flex min-h-0 flex-1">
      <AnimatedSidebar
        ariaLabel={t('workspace.sessions')}
        collapsible="offcanvas"
        // ANY panel drag writes both width variables straight to the DOM, so
        // both panels read them — not just the one whose own strip is pulled.
        resizing={resizing !== null}
        className="min-h-0 data-[mobile=true]:pt-[var(--app-titlebar-height)]"
        // Glass on: the panel surface goes translucent and frosted, and the
        // accent wash painted behind it shows through (SidebarGlass.tsx builds
        // both layers). Glass off is the plain opaque column, with no wash
        // mounted at all.
        backdrop={sidebarGlass ? <SidebarGlassWash /> : undefined}
        panelClassName={cn(sidebarGlassPanelClassName(sidebarGlass), activeEdge.left && 'border-primary')}
      >
        {/* pb-0 overrides the vendored content's own py-2: the session list's
            last row must reach the panel's bottom line, not stop 8px above it
            (the row's own leading keeps the text off the edge). */}
        <AnimatedSidebarContent className="gap-5 overflow-hidden px-2 pb-0 pt-2">
          <AnimatedSidebarGroup className="shrink-0 px-1 py-0">
            <AnimatedSidebarGroupContent>
              <AnimatedSidebarMenu className="gap-1">
                <AnimatedSidebarMenuItem>
                  <AnimatedSidebarMenuButton
                    icon={<MessageSquarePlus className="size-4" />}
                    onSelect={() => void newSession()}
                    // No resting background: a permanent box on the row read as
                    // a floating grey slab against the glass panel. It wears no
                    // emphasis of its own either: the primary action reads from
                    // its position and glyph, and the vendored button's
                    // `font-medium` plus a full-contrast `text-foreground` made
                    // this single row heavier and darker than every other
                    // sidebar label, so both are explicitly turned back to the
                    // sidebar's shared tone and weight.
                    className="font-normal"
                  >
                    {t('workspace.newChat')}
                  </AnimatedSidebarMenuButton>
                </AnimatedSidebarMenuItem>
                <AnimatedSidebarMenuItem>
                  <AnimatedSidebarMenuButton
                    icon={<FolderInput className="size-4" />}
                    onSelect={() => void changeFolder()}
                    className="font-normal"
                  >
                    {t('workspace.openFolder')}
                  </AnimatedSidebarMenuButton>
                </AnimatedSidebarMenuItem>
              </AnimatedSidebarMenu>
            </AnimatedSidebarGroupContent>
          </AnimatedSidebarGroup>

          <AnimatedSidebarGroup className="min-h-0 flex-1 px-1 py-0">
            <div className="mb-1 flex h-8 shrink-0 items-center justify-between pr-1">
              <AnimatedSidebarGroupLabel className="flex h-8 items-center px-2 text-xs font-medium normal-case tracking-normal">
                {t('workspace.sessions')}
              </AnimatedSidebarGroupLabel>
              <div className="flex items-center gap-0.5">
                <Tooltip content={t('scheduledTasks.open')}>
                  <Button variant="ghost" size="icon" aria-label={t('scheduledTasks.open')} className="relative" onClick={() => setScheduledOpen(true)}>
                    <CalendarCheck aria-hidden="true" className="size-4" />
                    {scheduledUnread > 0 ? (
                      <span
                        aria-label={t('scheduledTasks.unread', { count: scheduledUnread })}
                        className="absolute -right-0.5 -top-0.5 grid min-w-4 place-items-center rounded-capsule bg-primary px-1 text-[10px] font-semibold leading-4 text-primary-foreground"
                      >
                        {scheduledUnread}
                      </span>
                    ) : null}
                  </Button>
                </Tooltip>
                <SessionSearchTrigger />
              </div>
            </div>
            {sidebarSaveError ? <p role="alert" className="px-2 pb-2 text-xs text-destructive">{t('workspace.sidebarSaveError')}</p> : null}
            <AnimatedSidebarGroupContent className="relative min-h-0 flex-1 overflow-hidden">
              <div
                ref={sessionListRef}
                style={sessionListMask ? { maskImage: sessionListMask, WebkitMaskImage: sessionListMask } : undefined}
                className={[
                  'h-full overflow-y-auto overscroll-contain [overflow-anchor:none]',
                  // “Show more” rows (identified by the [data-more-row] icon)
                  // are plain text actions, not session rows: no hover box and
                  // no row menu — hover only shifts the text color.
                  '[&_[role=treeitem]:has(span[data-more-row])]:hover:bg-transparent',
                  '[&_[role=treeitem]:has(span[data-more-row])]:hover:text-primary',
                  '[&_[role=treeitem]:has(span[data-more-row])>div:last-child]:!hidden',
                  '[&_[role=treeitem]:has(span[data-session-section])>div:last-child]:!hidden'
                ].join(' ')}
                onClickCapture={(event) => {
                  // A click landing on an expanded folder row collapses it
                  // (aria-expanded is still "true" at capture time). Reset its
                  // reveal limit so the next expand starts from the first page.
                  const row = (event.target as HTMLElement).closest?.('[role=treeitem][aria-expanded]')
                  if (row?.getAttribute('aria-expanded') !== 'true') return
                  const cwd = row.querySelector('[data-sidebar-group]')?.getAttribute('data-sidebar-group')
                  if (!cwd) return
                  setFolderLimits((current) => {
                    if (!(cwd in current)) return current
                    const next = { ...current }
                    delete next[cwd]
                    return next
                  })
                }}
              >
                <AISidebar
                  key={folderKey}
                  items={sessionItems}
                  allowNesting={false}
                  canDrag={(item) => sessionsByPath.has(item.id)}
                  canMove={(move) => canReorderSession(move, sessionsByPath, pinnedPaths)}
                  onMove={(move) => persistSidebarPreferences(reorderSession(sidebarPreferences, sessionsByPath, move))}
                  onMoveError={() => setSidebarSaveError(true)}
                  activeId={shell.sessionPath ?? null}
                  defaultExpandedIds={sidebarGroups.map((group) => group.id)}
                  ariaLabel={t('workspace.sessionsAria')}
                  onActiveChange={(id) => {
                    if (id.startsWith('more:')) {
                      const cwd = id.slice('more:'.length)
                      setFolderLimits((current) => ({
                        ...current,
                        [cwd]: (current[cwd] ?? SESSION_PAGE_SIZE) + SESSION_PAGE_SIZE
                      }))
                      return
                    }
                    const session = sessionsByPath.get(id)
                    if (session) void openSession(id, session.cwd)
                  }}
                  renderIcon={(item) => {
                    if (item.id.startsWith('more:')) {
                      return (
                        <span data-more-row className="grid place-items-center">
                          <ChevronDown className="size-3.5" />
                        </span>
                      )
                    }
                    if (item.id === PINNED_GROUP || item.id === CHATS_GROUP) {
                      const Icon = item.id === PINNED_GROUP ? Pin : MessageSquareDashed
                      return <span data-session-section data-sidebar-group={item.id} className="grid place-items-center"><Icon className="size-4" /></span>
                    }
                    // Group identity lets collapse clicks reset the reveal limit. The glyph follows the
                    // row's own `aria-expanded` (the row is `group/resource`),
                    // since renderIcon only receives the item, not its state.
                    if (item.kind === 'folder') {
                      return (
                        <span data-sidebar-group={item.id} className="grid place-items-center">
                          <Folder className="size-4 group-aria-expanded/resource:hidden" />
                          <FolderOpen className="hidden size-4 group-aria-expanded/resource:block" />
                        </span>
                      )
                    }
                    if (runningPaths.has(item.id)) {
                      return (
                        <LoaderCircle
                          aria-hidden="true"
                          className="size-4 animate-spin text-primary"
                        />
                      )
                    }
                    return <Chat01 aria-hidden="true" className="size-4" />
                  }}
                  renderActions={(item) => {
                    // Only project (folder) rows get the shortcut; a session row
                    // would just duplicate "new chat in its own project".
                    if (!item.id.startsWith('folder:')) return null
                    const cwd = item.id.slice('folder:'.length)
                    return (
                      <Tooltip
                        content={t('workspace.newChatInFolder', { label: item.label })}
                        wrapperClassName="absolute right-11 top-1/2 z-10 -translate-y-1/2"
                      >
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={t('workspace.newChatInFolder', { label: item.label })}
                          onClick={(event) => {
                            // Keep the row's expand/select click from firing too.
                            event.stopPropagation()
                            void newSession(cwd)
                          }}
                          className="grid size-7 place-items-center rounded-lg bg-background text-muted-foreground opacity-0 shadow-sm outline-none transition-[opacity,color,background-color] hover:bg-muted hover:text-foreground focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-ring group-hover/resource:opacity-100 group-data-[menu-open=true]/resource:opacity-100"
                        >
                          <MessageSquarePlus className="size-3.5" />
                        </Button>
                      </Tooltip>
                    )
                  }}
                  renderMenu={(item, controls) =>
                    item.id.startsWith('more:') || item.id.startsWith('section:') ? (
                      <span className="hidden" />
                    ) : item.kind === 'folder' ? (
                      <SidebarRowMenuAction
                        icon={Trash2}
                        tone="destructive"
                        label={t('workspace.deleteProject')}
                        onSelect={() => {
                          controls.close()
                          setPendingDelete({
                            kind: 'folder',
                            id: item.id.slice('folder:'.length),
                            label: item.label
                          })
                        }}
                      />
                    ) : (
                      <>
                        <SidebarRowMenuAction
                          icon={pinnedPaths.has(item.id) ? PinOff : Pin}
                          label={t(pinnedPaths.has(item.id) ? 'workspace.unpinSession' : 'workspace.pinSession')}
                          onSelect={() => {
                            controls.close()
                            try { persistSidebarPreferences(toggleSessionPin(sidebarPreferences, item.id)) }
                            catch { setSidebarSaveError(true) }
                          }}
                        />
                        {controls.moves.up ? <SidebarRowMenuAction icon={ArrowUp} label={t('workspace.moveSessionUp')}
                          onSelect={() => { controls.close(); controls.moves.up?.() }} /> : null}
                        {controls.moves.down ? <SidebarRowMenuAction icon={ArrowDown} label={t('workspace.moveSessionDown')}
                          onSelect={() => { controls.close(); controls.moves.down?.() }} /> : null}
                        <SidebarRowMenuAction icon={ArrowLeftFromLine} label={t('rewind.title')} onSelect={() => {
                          controls.close()
                          const session = sessionsByPath.get(item.id)
                          if (session) void openSession(session.path, session.cwd).then(() => setRewindTarget({ path: session.path }))
                        }} />
                        <SidebarRowMenuAction icon={Pencil} label={t('workspace.renameSession')}
                          onSelect={() => controls.rename()} />
                        <SidebarRowMenuAction icon={Copy} label={t('workspace.copySessionId')}
                          onSelect={() => {
                            controls.close()
                            copySessionId(item.id)
                          }} />
                        <SidebarRowMenuAction icon={Trash2} tone="destructive" label={t('workspace.deleteSession')}
                          onSelect={() => {
                            controls.close()
                            setPendingDelete({ kind: 'session', id: item.id, label: item.label })
                          }} />
                      </>
                    )
                  }
                  onRename={(item, label) => {
                    if (item.id.startsWith('more:') || item.kind === 'folder') return
                    setSessions((current) =>
                      current.map((session) =>
                        session.path === item.id ? { ...session, label } : session
                      )
                    )
                    void window.pi.renameSession(item.id, label)
                  }}
                />
              </div>
            </AnimatedSidebarGroupContent>
          </AnimatedSidebarGroup>
        </AnimatedSidebarContent>
      </AnimatedSidebar>

      {/* The resize strip replaces the vendored rail: it lives outside the
          sidebar (whose panel clips its own content), drags the width, and
          toggles the sidebar on a press that never dragged. */}
      {sidebarOpen ? (
        <PanelResizeHandle
          grow="right"
          label={t('workspace.resizeSessions')}
          onResizeStart={() => {
            dragStartWidth.current = panelLayout.left
            setResizing('left')
          }}
          onResize={(delta) => resizePanels('left', delta)}
          onResizeEnd={commitPanelDrag}
          onToggle={() => setSidebarOpen((open) => !open)}
          onActiveChange={onLeftEdgeActive}
        />
      ) : null}

      {/* No top border here: the rule belongs to the title row. The pull left
          by the resize strip's half-width keeps the pane's own left edge on the
          sidebar's right border, so the strip's 3px overlap costs it nothing. */}
      <AnimatedSidebarInset className="isolate min-h-0 overflow-hidden bg-background md:-ml-[3px]">
        <div className="flex min-h-0 flex-1">
          <div data-pip-source="conversation" className="flex min-h-0 min-w-0 flex-1 flex-col" inert={sidePanelFullscreen} aria-hidden={sidePanelFullscreen || undefined}>
            {!isNewSession ? (
              <ChatView
                onRefinePlan={shell.scheduledTaskSession ? undefined : () => window.dispatchEvent(new CustomEvent('pith:refine-plan', { detail: { sessionPath: shell.sessionPath } }))}
                store={store}
                scrollResetKey={scrollResetKey}
                onDismissError={dismissChatError}
                onResend={shell.scheduledTaskSession ? undefined : handleResend}
                onContinue={shell.scheduledTaskSession || (shell.sessionPath !== null && continuingPaths.has(shell.sessionPath)) ? undefined : handleContinue}
                onEditMessage={shell.scheduledTaskSession ? undefined : handleEditMessage}
                onRewindMessage={shell.scheduledTaskSession ? undefined : rewindMessage}
                onUndoFiles={shell.scheduledTaskSession ? undefined : undoFilesTurn}
                onFork={shell.scheduledTaskSession ? undefined : handleFork}
                onReview={openReview}
                onOpenSession={openAgentPane}
              />
            ) : null}

            {/* A pending escalation blocks one tool call in the running turn, so
                it sits where the user's next action lives: above the composer. */}
            {shell.escalations[0] ? (
              <SandboxEscalationPanel
                request={shell.escalations[0]}
                onAnswer={(decision) => {
                  const request = shell.escalations[0]
                  if (request) void window.pi.respondEscalation(request.requestId, request.sessionPath, decision)
                }}
              />
            ) : null}

            {/* A pending question set blocks the running turn on the user's
                answer, so it lives where the next action is — above the
                composer, after any escalation card. */}
            {shell.pendingAskUser[0] ? (
              <AskUserPanel
                request={shell.pendingAskUser[0]}
                onEngage={(requestId) => {
                  const request = shell.pendingAskUser[0]
                  if (request) void window.pi.askUserEngage(requestId, request.sessionPath)
                }}
                onRespond={(requestId, payload) => {
                  const request = shell.pendingAskUser[0]
                  if (request) void window.pi.respondAskUser(requestId, request.sessionPath, payload)
                }}
              />
            ) : null}

            <Composer
              start={newSessionStart}
              models={models}
              model={currentModel}
              thinkingLevel={shell.thinkingLevel}
              availableThinkingLevels={shell.availableThinkingLevels}
              busy={shell.isStreaming}
              initializing={shell.initializing}
              readOnly={shell.subagentChild || shell.scheduledTaskSession}
              readOnlyKind={shell.scheduledTaskSession ? 'scheduled' : 'subagent'}
              readOnlyParentPath={shell.subagentParentPath}
              onOpenSession={(path) => void openSession(path)}
              escapeStopsRun={!settingsOpen && !scheduledOpen && !authPrompt}
              plan={shell.plan}
              onPlanState={(path, plan) => store.dispatch({ type: 'plan_state_update', sessionPath: path, plan })}
              sandboxMode={shell.sandboxMode}
              sandbox={shell.sandbox}
              sessionPath={shell.sessionPath}
              onSandboxSnapshot={(snapshot) => store.applySnapshot(snapshot)}
              contextUsage={shell.contextUsage}
              onOpenContext={() => openSidePanelTab('context')}
              queued={shell.queue}
              onSend={handleSend}
              onQueue={handleQueue}
              onRecallQueue={handleRecallQueue}
              onModelChange={(model) => void handleModelChange(model)}
              onThinkingLevelChange={(level) => void handleThinkingChange(level)}
              appendDraft={composerAppend}
            />
          </div>

          {sidePanelOpen && !sidePanelFullscreen ? (
            <PanelResizeHandle
              grow="left"
              label={t('workspace.resizePanel')}
              onResizeStart={() => {
                dragStartWidth.current = panelLayout.right
                setResizing('right')
              }}
              onResize={(delta) => resizePanels('right', delta)}
              onResizeEnd={commitPanelDrag}
              onActiveChange={onRightEdgeActive}
            />
          ) : null}

          <SidebarPanel
            open={sidePanelOpen}
            fullscreen={sidePanelFullscreen}
            width={panelLayout.right}
            // Any drag, not just this panel's own: a left-panel drag shrinks
            // this one live (the pair gives way immediately), and a panel that
            // kept reading its committed React width would only follow on
            // release — after the transcript had already been squeezed.
            resizing={resizing !== null}
            edgeActive={activeEdge.right}
            tabs={sidePanelTabs}
            activeTab={sidePanelTab}
            onSelectTab={selectSidePanelTab}
            onOpenTab={openSidePanelTab}
            onCloseTab={closeSidePanelTab}
            onCloseOtherTabs={closeOtherSidePanelTabs}
            onCloseAllTabs={closeAllSidePanelTabs}
            pane={{
              files,
              terminals,
              debug: debugStore,
              onNewTerminal: newTerminal,
              onTerminalsEmpty: () => closeSidePanelTab('terminal'),
              browserStore,
              // Per-kind teardown is `closeSidePanelTab`'s job; the browser
              // pane owns none (its store lives with the workspace).
              onBrowserEmpty: () => closeSidePanelTab('browser'),
              store,
              reviewTurnId,
              sideChat,
              sideChatDraft,
              onSideChatDraftChange: setSideChatDraft,
              sideChatOnCurrentSession:
                sideChat != null && sideChat.boundSessionPath === shell.sessionPath,
              onSideChatRebind: rebindSideChat,
              agentRuns,
              onOpenSessionInChat: (path) => void openSession(path)
            }}
          />
        </div>
      </AnimatedSidebarInset>
      </div>

      <SettingsPage
        open={settingsOpen}
        onBack={() => setSettingsOpen(false)}
        accent={accent}
        onAccentChange={onAccentChange}
        uiStyle={uiStyle}
        onUiStyleChange={onUiStyleChange}
      />

      <ScheduledTasksView
        open={scheduledOpen}
        onBack={() => setScheduledOpen(false)}
        currentSessionId={shell.sessionId ?? null}
        currentCwd={shell.cwd ?? null}
        currentProjectless={shell.projectless}
        sessions={sessions}
        folders={folders}
        models={models}
        onOpenRunSession={openScheduledConversation}
      />

      <RewindDialog sessionPath={rewindTarget?.path ?? null} messageTimestamp={rewindTarget?.messageTimestamp} messageEntryId={rewindTarget?.messageEntryId} initialMode={rewindTarget?.mode} onClose={closeRewind} onCommitted={value => {
        if (value.snapshot?.sessionPath === store.getShell().sessionPath) store.applySnapshot(value.snapshot)
        setScrollResetKey(previous => previous + 1)
        // A conversation restore re-decides what the sidebar shows for this
        // session: restoring to before its first turn leaves the selected
        // branch empty (it must not stay listed as an openable chat), and an
        // Undo brings the history back. `messageCount` observes that change
        // only through a fresh list.
        void refreshSessions()
      }} />
      <ConfirmDialog
        open={pendingDelete !== null}
        title={t(
          pendingDelete?.kind === 'folder'
            ? 'workspace.confirmDeleteProjectTitle'
            : 'workspace.confirmDeleteSessionTitle'
        )}
        message={
          pendingDelete?.kind === 'folder'
            ? t('workspace.confirmDeleteProjectMessage', {
                count: deleteSessionCount,
                sessionsWord: t(
                  deleteSessionCount === 1 ? 'workspace.sessionOne' : 'workspace.sessionMany'
                ),
                label: pendingDelete.label
              })
            : t('workspace.confirmDeleteSessionMessage', { label: pendingDelete?.label ?? '' })
        }
        onConfirm={() => void confirmDelete()}
        onClose={() => setPendingDelete(null)}
      />

      <SystemPromptDialog prompt={systemPromptText} onClose={() => setSystemPromptText(null)} />

      <EditMessageDialog
        open={editTarget !== null}
        message={editTarget}
        models={models}
        model={currentModel}
        thinkingLevel={shell.thinkingLevel}
        availableThinkingLevels={shell.availableThinkingLevels}
        onModelChange={(model) => void handleModelChange(model)}
        onThinkingLevelChange={(level) => void handleThinkingChange(level)}
        onResend={(payload) => void handleEditResend(payload)}
        onCancel={() => void handleCancelEdit()}
      />

      <AuthBridge
        prompt={authPrompt}
        notify={authNotify}
        onReply={(requestId, value) => {
          setAuthPrompt(null)
          window.pi.replyAuth(requestId, value)
        }}
        onCancel={(providerId) => void window.pi.cancelLogin(providerId)}
      />
    </ChatApp>
    </SessionSearch>
    {/* ⌘K. The surface portals, so its place in this tree costs no layout. */}
    <AppCommandPalette
      open={paletteOpen}
      onOpenChange={setPaletteOpen}
      sessions={sessions}
      activePath={shell.sessionPath ?? null}
      folders={folders}
      sidebarOpen={sidebarOpen}
      sidePanelOpen={sidePanelOpen}
      onOpenSession={(path, cwd) => void openSession(path, cwd)}
      onNewSession={(cwd) => void newSession(cwd)}
      onOpenSettings={() => setSettingsOpen(true)}
      onNewTerminal={newTerminal}
      onCompact={() => void handleCompact()}
      onToggleSidebar={() => setSidebarOpen((open) => !open)}
      onToggleRail={() => setSidePanelOpen((open) => !open)}
    />
    </FileNavigationProvider>
  )
}
