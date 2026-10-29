import { useMemo } from 'react'
import { useTheme } from 'next-themes'
import { CommandPalette, type CommandItem } from '@/components/motion/command-palette'
import {
  Folder,
  MessageSquarePlus,
  Minimize2,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Settings,
  SquareTerminal,
  Sun
} from '@/lib/icons'
import { basename } from '@/lib/format'
import { useI18n } from '@/i18n'
import type { SessionSummaryDTO } from '../../../../shared/types'

/** Recently touched sessions first; the palette is a jump list, not an index. */
const SESSION_LIMIT = 12

const THEME_CYCLE = ['light', 'dark', 'system'] as const
type ThemeMode = (typeof THEME_CYCLE)[number]

const THEME_KEY: Record<ThemeMode, 'settings.light' | 'settings.dark' | 'settings.system'> = {
  light: 'settings.light',
  dark: 'settings.dark',
  system: 'settings.system'
}

/**
 * ⌘K palette. Commands are the actions the workspace already owns — the
 * palette adds a keyboard path to them, never a second implementation — plus a
 * jump list over the sessions the sidebar is showing.
 *
 * The surface (shortcut binding, filtering, focus and scroll lock) is beUI's
 * vendored CommandPalette; this file only names things via i18n and wires the
 * callbacks.
 */
export function AppCommandPalette({
  open,
  onOpenChange,
  sessions,
  activePath,
  folders,
  sidebarOpen,
  sidePanelOpen,
  onOpenSession,
  onNewSession,
  onOpenSettings,
  onNewTerminal,
  onCompact,
  onToggleSidebar,
  onToggleRail
}: {
  /** Controlled by the workspace: the shortcut dispatcher owns the ⌘K toggle. */
  open: boolean
  onOpenChange: (open: boolean) => void
  sessions: SessionSummaryDTO[]
  activePath: string | null
  folders: string[]
  sidebarOpen: boolean
  sidePanelOpen: boolean
  onOpenSession: (path: string, cwd?: string) => void
  onNewSession: (cwd?: string) => void
  onOpenSettings: () => void
  onNewTerminal: () => void
  /** Manual compaction; main waits for a safe boundary during a live run. */
  onCompact: () => void
  onToggleSidebar: () => void
  onToggleRail: () => void
}) {
  const { t } = useI18n()
  const { theme, setTheme } = useTheme()

  const items = useMemo<CommandItem[]>(() => {
    const nextTheme = THEME_CYCLE[(THEME_CYCLE.indexOf((theme as ThemeMode) ?? 'system') + 1) % THEME_CYCLE.length]

    const actions: CommandItem[] = [
      {
        id: 'action.new-chat',
        group: t('palette.group.actions'),
        label: t('workspace.newChat'),
        keywords: ['new', 'chat', 'session'],
        icon: MessageSquarePlus,
        onSelect: () => onNewSession()
      },
      {
        id: 'action.settings',
        group: t('palette.group.actions'),
        label: t('workspace.settings'),
        keywords: ['preferences', 'config'],
        icon: Settings,
        onSelect: onOpenSettings
      },
      {
        id: 'action.terminal',
        group: t('palette.group.actions'),
        label: t('sidebar.terminal'),
        keywords: ['shell', 'console'],
        icon: SquareTerminal,
        onSelect: onNewTerminal
      },
      {
        id: 'action.compact',
        group: t('palette.group.actions'),
        label: t('palette.compact'),
        keywords: ['compact', 'summarize', 'context', 'history'],
        icon: Minimize2,
        onSelect: onCompact
      },
      {
        id: 'action.theme',
        group: t('palette.group.actions'),
        label: t('workspace.themeLabel', { mode: t(THEME_KEY[nextTheme]) }),
        keywords: ['theme', 'dark', 'light', 'appearance'],
        icon: Sun,
        onSelect: () => setTheme(nextTheme)
      },
      {
        id: 'action.sidebar',
        group: t('palette.group.actions'),
        label: t(sidebarOpen ? 'palette.hideSidebar' : 'palette.showSidebar'),
        keywords: ['navigation', 'projects'],
        icon: sidebarOpen ? PanelLeftClose : PanelLeftOpen,
        onSelect: onToggleSidebar
      },
      {
        id: 'action.rail',
        group: t('palette.group.actions'),
        label: t(sidePanelOpen ? 'palette.hideRail' : 'palette.showRail'),
        keywords: ['panel', 'files', 'review', 'terminal'],
        icon: sidePanelOpen ? PanelRightClose : PanelRightOpen,
        onSelect: onToggleRail
      }
    ]

    const projects: CommandItem[] = folders.map((cwd) => ({
      id: `project:${cwd}`,
      group: t('palette.group.projects'),
      label: basename(cwd) || cwd,
      hint: cwd,
      keywords: [cwd, 'project', 'folder'],
      icon: Folder,
      onSelect: () => onNewSession(cwd)
    }))

    const recent: CommandItem[] = sessions.slice(0, SESSION_LIMIT).map((session) => ({
      id: `session:${session.path}`,
      group: t('palette.group.sessions'),
      // A session with no messages has no label yet; name its state instead of
      // rendering an empty row.
      label: session.label || t('palette.untitled'),
      hint: session.projectless ? t('files.workspace') : basename(session.cwd) || session.cwd,
      keywords: [session.cwd, session.path],
      onSelect: () => onOpenSession(session.path, session.cwd),
      // The active row is worth spotting even after the query narrows the list.
      badge: session.path === activePath ? t('palette.current') : undefined
    }))

    return [...actions, ...projects, ...recent]
    // `sessions` and `folders` are refreshed per turn; rebuilding the list is
    // cheap and keeps labels current.
  }, [
    activePath,
    folders,
    onNewSession,
    onCompact,
    onNewTerminal,
    onOpenSession,
    onOpenSettings,
    onToggleRail,
    onToggleSidebar,
    sessions,
    setTheme,
    t,
    theme
  ])

  return (
    <CommandPalette
      items={items}
      placeholder={t('palette.placeholder')}
      emptyMessage={t('palette.empty')}
      // The dispatcher owns the toggle key; the surface keeps only its Esc.
      shortcut={null}
      open={open}
      onOpenChange={onOpenChange}
    />
  )
}
