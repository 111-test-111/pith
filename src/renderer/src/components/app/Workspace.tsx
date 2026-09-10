import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import {
  ChevronDown,
  Folder,
  FolderInput,
  MessageSquarePlus,
  PanelLeft,
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
import { ThemeToggle } from '@/components/motion/theme-toggle'
import { Button } from '@/components/motion/button'
import { basename } from '@/lib/format'
import { useI18n } from '@/i18n'
import type {
  ImageContent,
  ModelDTO,
  SessionSnapshotDTO,
  SessionSummaryDTO,
  ThinkingLevel
} from '../../../../shared/types'
import { PiStore, type PiState } from '@/state/pi-store'
import { ChatView } from './ChatView'
import { Composer } from './Composer'
import { SettingsDialog } from './settings/SettingsDialog'
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

export function Workspace({ store, accent, onAccentChange }: WorkspaceProps) {
  const { t } = useI18n()
  const state = useSyncExternalStore(store.subscribe, store.getState) as PiState
  const [models, setModels] = useState<ModelDTO[]>([])
  const [sessions, setSessions] = useState<SessionSummaryDTO[]>([])
  const [folders, setFolders] = useState<string[]>([])
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [authPrompt, setAuthPrompt] = useState<AuthPromptDTO | null>(null)
  const [authNotify, setAuthNotify] = useState<AuthNotifyDTO[]>([])
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null)
  /** How many sessions each folder currently reveals; default SESSION_PAGE_SIZE. */
  const [folderLimits, setFolderLimits] = useState<Record<string, number>>({})

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
      if (event.type === 'agent_end') void refreshSessions()
    })
    const offPrompt = window.pi.onAuthPrompt(setAuthPrompt)
    const offNotify = window.pi.onAuthNotify((notify) => {
      setAuthNotify((current) => [...current.slice(-8), notify])
      if (notify.kind === 'auth_url' && notify.url) {
        // Most providers expect the system browser; the dialog also carries a link.
        void window.pi.openExternal(notify.url)
      }
    })
    return () => {
      offEvent()
      offPrompt()
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
      models.find((m) => state.model && m.providerId === state.model.providerId && m.id === state.model.id) ??
      null,
    [models, state.model]
  )

  const handleSend = useCallback(
    ({ text, images, files }: { text: string; images: ImageContent[]; files: string[] }) => {
      // Mirror the main process's file blocks so chips render on the optimistic echo.
      const blocks = files
        .map((f) => `<file path="${f.replace(/^\//, '')}">(pending)</file>`)
        .join('\n\n')
      store.appendOptimisticUser(files.length ? `${text}\n\n${blocks}` : text, images)
      void window.pi.prompt({ text, images, files })
    },
    [store]
  )

  const handleModelChange = useCallback(
    async (model: ModelDTO) => {
      const snapshot: SessionSnapshotDTO = await window.pi.setModel(model.providerId, model.id)
      store.applySnapshot(snapshot)
    },
    [store]
  )

  const handleThinkingChange = useCallback(
    async (level: ThinkingLevel) => {
      const snapshot: SessionSnapshotDTO = await window.pi.setThinkingLevel(level)
      store.applySnapshot(snapshot)
    },
    [store]
  )

  const newSession = useCallback(async () => {
    const snapshot: SessionSnapshotDTO = await window.pi.newSession()
    store.applySnapshot(snapshot)
    void refreshSessions()
  }, [store, refreshSessions])

  const openSession = useCallback(
    async (path: string, cwd?: string) => {
      const snapshot: SessionSnapshotDTO = await window.pi.openSession(path, cwd)
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
    try {
      const snapshot =
        target.kind === 'session'
          ? await window.pi.deleteSession(target.id)
          : await window.pi.deleteFolder(target.id)
      if (snapshot) store.applySnapshot(snapshot)
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
      const snapshot: SessionSnapshotDTO = await window.pi.init(result.cwd)
      store.applySnapshot(snapshot)
      void refreshSessions()
      void refreshModels()
      void refreshFolders()
    }
  }, [store, refreshModels, refreshSessions, refreshFolders])

  /**
   * Sidebar tree: one folder node per known folder (opened in the app or with
   * sessions on disk), active folder first, each listing its sessions.
   */
  const folderGroups = useMemo(() => {
    const byFolder = new Map<string, SessionSummaryDTO[]>()
    for (const session of sessions) {
      const list = byFolder.get(session.cwd) ?? []
      list.push(session)
      byFolder.set(session.cwd, list)
    }
    const ordered = [
      ...(state.cwd ? [state.cwd] : []),
      ...folders.filter((f) => f !== state.cwd),
      ...[...byFolder.keys()].filter((f) => f !== state.cwd && !folders.includes(f))
    ]
    const seen = new Set<string>()
    return ordered
      .filter((f) => !seen.has(f) && seen.add(f))
      .map((cwd) => ({ cwd, sessions: byFolder.get(cwd) ?? [] }))
  }, [sessions, folders, state.cwd])

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
              label: session.label,
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

  return (
    <ChatApp className="h-full rounded-none border-0">
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
                  'h-full overflow-y-auto overscroll-contain pb-8 [overflow-anchor:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
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
                  activeId={state.sessionPath ?? null}
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
                    // above) can reset the reveal limit. Static Folder glyph —
                    // the vendored open/closed glyph swap is given up for it.
                    if (item.kind === 'folder') {
                      return (
                        <span data-folder-cwd={item.id.slice('folder:'.length)} className="grid place-items-center">
                          <Folder className="size-4" />
                        </span>
                      )
                    }
                    return undefined
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
                      <ResourceDeleteAction
                        label={t('workspace.deleteSession')}
                        onSelect={() => {
                          controls.close()
                          setPendingDelete({ kind: 'session', id: item.id, label: item.label })
                        }}
                      />
                    )
                  }
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
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-border px-4">
          <div className="flex min-w-0 items-center gap-2.5">
            <AnimatedSidebarTrigger className="text-muted-foreground hover:bg-muted hover:text-foreground">
              <PanelLeft className="size-4" />
            </AnimatedSidebarTrigger>
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-foreground">
                {currentModel ? currentModel.name : t('workspace.noModel')}
              </p>
              <p className="truncate text-[11px] text-muted-foreground">
                {state.cwd ?? ''}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <Button
              variant="ghost"
              size="icon"
              aria-label={t('workspace.settings')}
              onClick={() => setSettingsOpen(true)}
            >
              <SettingsIcon className="size-4" />
            </Button>
            <ThemeToggle />
          </div>
        </header>

        <ChatView state={state} onDismissError={() => store.clearError()} />

        <Composer
          models={models}
          model={currentModel}
          thinkingLevel={state.thinkingLevel}
          busy={state.isStreaming}
          onSend={handleSend}
          onStop={() => void window.pi.abort()}
          onModelChange={(model) => void handleModelChange(model)}
          onThinkingLevelChange={(level) => void handleThinkingChange(level)}
        />
      </AnimatedSidebarInset>

      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
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

      <AuthBridge
        prompt={authPrompt}
        notify={authNotify}
        onReply={(requestId, value) => {
          setAuthPrompt(null)
          window.pi.replyAuth(requestId, value)
        }}
      />
    </ChatApp>
  )
}
