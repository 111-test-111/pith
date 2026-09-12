import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import {
  ChevronDown,
  Folder,
  FolderInput,
  FolderOpen,
  LoaderCircle,
  MessageSquareDashed,
  MessageSquarePlus,
  PanelLeft,
  PanelRight,
  Pencil,
  Settings as SettingsIcon,
  Trash2
} from 'lucide-react'
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
  AnimatedSidebarRail,
  AnimatedSidebarTrigger
} from '@/components/motion/animated-sidebar'
import { ThemeButton } from './ThemeButton'
import { Button } from '@/components/motion/button'
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
  SessionSnapshotDTO,
  SessionSummaryDTO,
  ThinkingLevel,
  UserMsg
} from '../../../../shared/types'
import { PiStore } from '@/state/pi-store'
import type { StreamingBehavior } from '@/lib/streaming-behavior'
import { ChatView } from './ChatView'
import { Composer } from './Composer'
import { EditMessageDialog, type EditMessagePayload } from './EditMessageDialog'
import { SettingsPage } from './settings/SettingsPage'
import { SidebarPanel, type SidebarTabKind } from './SidebarPanel'
import { SideChatStore } from '@/state/side-chat-store'
import { AuthBridge } from './AuthBridge'
import { ConfirmDialog } from './ConfirmDialog'
import type { AuthNotifyDTO, AuthPromptDTO } from '../../../../shared/types'

interface WorkspaceProps {
  store: PiStore
  accent: string
  onAccentChange: (accent: string) => void
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
 * ResourceMenuAction styling with destructive tokens. */
function ResourceDeleteAction({ label, onSelect }: { label: string; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left text-xs text-destructive outline-none transition-colors hover:bg-destructive/10 focus-visible:bg-destructive/10 focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Trash2 aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate">{label}</span>
    </button>
  )
}

/** Rename row for the same menu; starts the sidebar's inline label editor. */
function ResourceRenameAction({ label, onSelect }: { label: string; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left text-xs text-foreground outline-none transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Pencil aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate">{label}</span>
    </button>
  )
}

export function Workspace({ store, accent, onAccentChange }: WorkspaceProps) {
  const { t } = useI18n()
  // Shell slice only: its identity is stable across streaming deltas, so the
  // sidebar/header/composer don't re-render while ChatView streams.
  const shell = useSyncExternalStore(store.subscribe, store.getShell)
  const [models, setModels] = useState<ModelDTO[]>([])
  const [sessions, setSessions] = useState<SessionSummaryDTO[]>([])
  const [folders, setFolders] = useState<string[]>([])
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [sidePanelOpen, setSidePanelOpen] = useState(false)
  /** Panes hosted by the right rail; state lives here so closing and
   * re-opening the rail restores the same tabs. */
  const [sidePanelTabs, setSidePanelTabs] = useState<SidebarTabKind[]>([])
  const [sidePanelTab, setSidePanelTab] = useState<SidebarTabKind | null>(null)
  /** The side chat's exchanges — created with its tab, dropped with it. */
  const [sideChat, setSideChat] = useState<SideChatStore | null>(null)
  /** Composer draft of the side chat; kept here so switching panel tabs (or
   * collapsing the rail) does not discard what was typed. */
  const [sideChatDraft, setSideChatDraft] = useState('')
  /** The live side chat, for handlers that must not depend on its identity. */
  const sideChatRef = useRef<SideChatStore | null>(null)
  const [authPrompt, setAuthPrompt] = useState<AuthPromptDTO | null>(null)
  const [authNotify, setAuthNotify] = useState<AuthNotifyDTO[]>([])
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
  const handleRecallQueue = useCallback(async (): Promise<RecalledItemDTO[]> => {
    try {
      const cleared = await window.pi.clearQueue()
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
  const openSidePanelTab = useCallback(
    (kind: SidebarTabKind) => {
      setSidePanelTabs((current) => (current.includes(kind) ? current : [...current, kind]))
      setSidePanelTab(kind)
      // A side chat is born with its tab.
      if (kind === 'chat') openSideChat()
    },
    [openSideChat]
  )

  /** Close a pane; the neighbour to its left takes over as the active tab. */
  const closeSidePanelTab = useCallback(
    (kind: SidebarTabKind) => {
      const index = sidePanelTabs.indexOf(kind)
      if (index < 0) return
      const next = sidePanelTabs.filter((tab) => tab !== kind)
      setSidePanelTabs(next)
      setSidePanelTab((active) =>
        active === kind ? (next[index - 1] ?? next[index] ?? null) : active
      )
      // Closing the side-chat tab destroys the thread — nothing outlives it.
      if (kind === 'chat') closeSideChat()
    },
    [sidePanelTabs, closeSideChat]
  )

  /** New session in `cwd` (defaults to the active folder). */
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
    } catch (error) {
      console.error('delete failed', error)
    } finally {
      void refreshSessions()
      void refreshFolders()
    }
  }, [pendingDelete, store, refreshSessions, refreshFolders])

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

  const sessionItems: SidebarResource[] = useMemo(
    () =>
      folderGroups.map((group) => {
        const limit = folderLimits[group.cwd] ?? SESSION_PAGE_SIZE
        const visible = group.sessions.slice(0, limit)
        const remaining = group.sessions.length - visible.length
        return {
          id: `folder:${group.cwd}`,
          label: basename(group.cwd),
          kind: 'folder' as const,
          children: [
            ...visible.map((session) => ({
              id: session.path,
              label: session.label ?? t('workspace.newChat'),
              kind: 'file' as const
            })),
            ...(remaining > 0
              ? [
                  {
                    id: moreRowId(group.cwd),
                    label: t('workspace.showMore'),
                    kind: 'file' as const
                  }
                ]
              : [])
          ]
        }
      }),
    [folderGroups, folderLimits, t]
  )
  const folderKey = folderGroups.map((group) => group.cwd).join('|')
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

  return (
    <ChatApp className="relative h-full rounded-none border-0">
      <AnimatedSidebar ariaLabel={t('workspace.sessions')} collapsible="offcanvas" className="min-h-0" panelClassName="h-full bg-background">
        <AnimatedSidebarContent className="gap-4 overflow-hidden px-2 py-4">
          <AnimatedSidebarGroup className="shrink-0 px-1 py-0">
            <AnimatedSidebarGroupContent>
              <AnimatedSidebarMenu className="gap-1">
                <AnimatedSidebarMenuItem>
                  <AnimatedSidebarMenuButton
                    icon={<MessageSquarePlus className="size-4" />}
                    onSelect={() => void newSession()}
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
            <AnimatedSidebarGroupLabel className="mb-1 h-8 px-2 text-xs font-medium normal-case tracking-normal">
              {t('workspace.sessions')}
            </AnimatedSidebarGroupLabel>
            <AnimatedSidebarGroupContent className="relative min-h-0 flex-1 overflow-hidden">
              <div
                className={[
                  'h-full overflow-y-auto overscroll-contain pb-8 [overflow-anchor:none]',
                  // “Show more” rows (identified by the [data-more-row] icon)
                  // are plain text actions, not session rows: no hover box and
                  // no row menu — hover only shifts the text color.
                  '[&_[role=treeitem]:has(span[data-more-row])]:hover:bg-transparent',
                  '[&_[role=treeitem]:has(span[data-more-row])]:hover:text-primary',
                  '[&_[role=treeitem]:has(span[data-more-row])>div:last-child]:!hidden'
                ].join(' ')}
                onClickCapture={(event) => {
                  // A click landing on an expanded folder row collapses it
                  // (aria-expanded is still "true" at capture time). Reset its
                  // reveal limit so the next expand starts from the first page.
                  const row = (event.target as HTMLElement).closest?.('[role=treeitem][aria-expanded]')
                  if (row?.getAttribute('aria-expanded') !== 'true') return
                  const cwd = row.querySelector('[data-folder-cwd]')?.getAttribute('data-folder-cwd')
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
                  activeId={shell.sessionPath ?? null}
                  defaultExpandedIds={folderGroups.map((group) => `folder:${group.cwd}`)}
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
                    if (id.startsWith('folder:')) return
                    const session = sessions.find((s) => s.path === id)
                    void openSession(id, session?.cwd)
                  }}
                  renderIcon={(item) => {
                    if (item.id.startsWith('more:')) {
                      return (
                        <span data-more-row className="grid place-items-center">
                          <ChevronDown className="size-3.5" />
                        </span>
                      )
                    }
                    // Folder rows carry their cwd so collapse clicks (captured
                    // above) can reset the reveal limit. The glyph follows the
                    // row's own `aria-expanded` (the row is `group/resource`),
                    // since renderIcon only receives the item, not its state.
                    if (item.kind === 'folder') {
                      return (
                        <span data-folder-cwd={item.id.slice('folder:'.length)} className="grid place-items-center">
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
                    return <MessageSquareDashed aria-hidden="true" className="size-4" />
                  }}
                  renderActions={(item) => {
                    // Only project (folder) rows get the shortcut; a session row
                    // would just duplicate "new chat in its own project".
                    if (item.kind !== 'folder') return null
                    const cwd = item.id.slice('folder:'.length)
                    return (
                      <button
                        type="button"
                        aria-label={t('workspace.newChatInFolder', { label: item.label })}
                        title={t('workspace.newChatInFolder', { label: item.label })}
                        onClick={(event) => {
                          // Keep the row's expand/select click from firing too.
                          event.stopPropagation()
                          void newSession(cwd)
                        }}
                        className="absolute right-11 top-1/2 z-10 grid size-7 -translate-y-1/2 place-items-center rounded-lg bg-background text-muted-foreground opacity-0 shadow-sm ring-1 ring-border/60 outline-none transition-opacity hover:bg-muted hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring group-hover/resource:opacity-100 group-data-[menu-open=true]/resource:opacity-100"
                      >
                        <MessageSquarePlus className="size-3.5" />
                      </button>
                    )
                  }}
                  renderMenu={(item, controls) =>
                    item.id.startsWith('more:') ? (
                      <span className="hidden" />
                    ) : item.kind === 'folder' ? (
                      <ResourceDeleteAction
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
                        <ResourceRenameAction
                          label={t('workspace.renameSession')}
                          onSelect={() => controls.rename()}
                        />
                        <ResourceDeleteAction
                          label={t('workspace.deleteSession')}
                          onSelect={() => {
                            controls.close()
                            setPendingDelete({ kind: 'session', id: item.id, label: item.label })
                          }}
                        />
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
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-background to-transparent"
              />
            </AnimatedSidebarGroupContent>
          </AnimatedSidebarGroup>
        </AnimatedSidebarContent>
        <AnimatedSidebarRail />
      </AnimatedSidebar>

      <AnimatedSidebarInset className="min-h-0 bg-background">
        <header className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-border px-3">
          <div className="flex min-w-0 items-center gap-2">
            <AnimatedSidebarTrigger className="text-muted-foreground hover:bg-muted hover:text-foreground">
              <PanelLeft className="size-4" />
            </AnimatedSidebarTrigger>
            <div className="flex min-w-0 items-baseline gap-2">
              <p className="shrink-0 truncate text-sm font-medium text-foreground">
                {currentModel ? currentModel.name : t('workspace.noModel')}
              </p>
              {shell.cwd ? (
                <>
                  <span aria-hidden="true" className="shrink-0 text-xs text-muted-foreground/50">
                    ·
                  </span>
                  <p className="min-w-0 truncate text-xs text-muted-foreground">{shell.cwd}</p>
                </>
              ) : null}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <Button
              variant="ghost"
              size="icon"
              aria-label={t('workspace.settings')}
              onClick={() => setSettingsOpen(true)}
            >
              <SettingsIcon className="size-4" />
            </Button>
            <ThemeButton />
            <Button
              variant="ghost"
              size="icon"
              aria-label={t('workspace.sidebar')}
              title={t('workspace.sidebar')}
              aria-pressed={sidePanelOpen}
              onClick={() => setSidePanelOpen((open) => !open)}
              className={cn(sidePanelOpen && 'bg-primary/5 text-foreground')}
            >
              <PanelRight className="size-4" />
            </Button>
          </div>
        </header>

        <div className="flex min-h-0 flex-1">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <ChatView
              store={store}
              scrollResetKey={scrollResetKey}
              onDismissError={() => store.clearError()}
              onResend={handleResend}
              onEditMessage={handleEditMessage}
              onFork={handleFork}
            />

            <Composer
              models={models}
              model={currentModel}
              thinkingLevel={shell.thinkingLevel}
              availableThinkingLevels={shell.availableThinkingLevels}
              busy={shell.isStreaming}
              escapeStopsRun={!settingsOpen && !authPrompt}
              contextUsage={shell.contextUsage}
              queued={shell.queue}
              onSend={handleSend}
              onQueue={handleQueue}
              onRecallQueue={handleRecallQueue}
              onStop={() => void window.pi.abort()}
              onModelChange={(model) => void handleModelChange(model)}
              onThinkingLevelChange={(level) => void handleThinkingChange(level)}
            />
          </div>

          <SidebarPanel
            open={sidePanelOpen}
            tabs={sidePanelTabs}
            activeTab={sidePanelTab}
            onSelectTab={setSidePanelTab}
            onOpenTab={openSidePanelTab}
            onCloseTab={closeSidePanelTab}
            pane={{
              sideChat,
              sideChatDraft,
              onSideChatDraftChange: setSideChatDraft,
              sideChatOnCurrentSession:
                sideChat != null && sideChat.boundSessionPath === shell.sessionPath,
              onSideChatRebind: rebindSideChat
            }}
          />
        </div>
      </AnimatedSidebarInset>

      <SettingsPage
        open={settingsOpen}
        onBack={() => setSettingsOpen(false)}
        accent={accent}
        onAccentChange={onAccentChange}
      />

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
  )
}
