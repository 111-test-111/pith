import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AISidebar, type AISidebarProps, type SidebarResource, type SidebarResourceMove } from '@/components/agents/ai-sidebar'
import { AnimatedSidebarGroup, AnimatedSidebarGroupContent, AnimatedSidebarGroupLabel } from '@/components/motion/animated-sidebar'
import { Button } from '@/components/motion/button'
import { Checkbox } from '@/components/motion/checkbox'
import { CenterMorphModal, CenterMorphModalContent } from '@/components/motion/center-morph-modal'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/components/motion/context-menu'
import { MENU_ITEM_CLASS } from '@/lib/menu-item'
import { Input } from '@/components/motion/input'
import { MorphPopover, MorphPopoverContent, MorphPopoverTrigger } from '@/components/motion/popover-morph'
import { RadioGroup, RadioGroupItem } from '@/components/motion/radio'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/motion/select'
import { Tabs, TabsList, TabsTrigger } from '@/components/motion/tabs'
import { Tooltip } from '@/components/motion/tooltip'
import { Archive, ArchiveRestore, ArrowDown, ArrowLeftFromLine, ArrowUp, CalendarCheck, Chat01, Chats, ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, Clock3, Copy, Folder, FolderInput, FolderOpen, Hash, Layers, ListFilter, LoaderCircle, MessageSquareDashed, MessageSquarePlus, Pencil, Pin, PinOff, Plus, Trash2, type IconComponent } from '@/lib/icons'
import { basename } from '@/lib/format'
import { FORM_INPUT_LABEL, FORM_PANEL_TITLE, FORM_FIELD_TITLE } from '@/lib/form-standard'
import { useScrollFade } from '@/lib/hooks/use-scroll-fade'
import { assignSessionGroup, buildSidebarGroups, canMoveSidebarResource, reorderSidebarResource, sessionTimestamp, setSessionArchived, setSessionUnread, toggleSessionPin, type SessionSidebarPreferences, type SidebarFolder, type SidebarListGroup, type SidebarSort, type SidebarFilter, type SidebarView } from '@/lib/session-sidebar'
import { cn } from '@/lib/utils'
import { useI18n } from '@/i18n'
import type { MessageKey } from '@/i18n/locales/en'
import type { SessionSummaryDTO } from '../../../../shared/types'
import { ConfirmDialog } from './ConfirmDialog'
import { LabelTooltip } from './LabelTooltip'
import { SessionSearchTrigger } from './SessionSearch'

const PAGE_SIZE = 5
type PreferenceUpdate = (current: SessionSidebarPreferences) => SessionSidebarPreferences
interface Props {
  sessions: SessionSummaryDTO[]
  folders: SidebarFolder[]
  activePath: string | null
  runningPaths: ReadonlySet<string>
  preferences: SessionSidebarPreferences
  onPreferencesChange: (update: PreferenceUpdate) => boolean
  saveError: boolean
  scheduledUnread: number
  onOpenScheduled: () => void
  onOpenSession: (path: string, cwd: string) => Promise<void>
  onNewSession: (cwd?: string) => void
  onOpenFolder: () => void
  onRenameSession: (path: string, name: string) => Promise<void>
  onCopySessionId: (path: string) => void
  onRewindSession: (path: string, cwd: string) => void
  onDeleteSession: (session: SessionSummaryDTO) => void
  onDeleteFolder: (cwd: string, label: string) => void
}
interface Action { key: string; label: string; icon: IconComponent; run: () => void; destructive?: boolean; separator?: boolean }
interface Editor { kind: 'new-group' | 'group' | 'session' | 'assign'; id?: string; name: string; groupId?: string; assignPath?: string }
const GROUP_LABELS = {
  pinned: 'workspace.pinnedSessions', projects: 'sessionSidebar.projects', chats: 'workspace.projectlessSessions',
  ungrouped: 'sessionSidebar.ungrouped', today: 'sessionSidebar.today', yesterday: 'sessionSidebar.yesterday',
  week: 'sessionSidebar.week', month: 'sessionSidebar.month', older: 'sessionSidebar.older'
} as const

/** All list organization is presentation state; SDK operations stay in Workspace. */
export function SessionsSidebar(props: Props) {
  const { sessions, folders, activePath, runningPaths, preferences, onPreferencesChange: update } = props
  const { t, locale } = useI18n()
  const [archived, setArchived] = useState(false)
  const [query, setQuery] = useState('')
  const [limits, setLimits] = useState<Record<string, number>>({})
  const [optionsOpen, setOptionsOpen] = useState(false)
  const [contextId, setContextId] = useState<string | null>(null)
  const contextTargetRef = useRef<string | null>(null)
  const [contextOpen, setContextOpen] = useState(false)
  const [editor, setEditor] = useState<Editor | null>(null)
  const [editorBusy, setEditorBusy] = useState(false)
  const editorBusyRef = useRef(false)
  const [editorFailed, setEditorFailed] = useState(false)
  const [removeGroup, setRemoveGroup] = useState<{ id: string; name: string } | null>(null)
  const [operationError, setOperationError] = useState<{ key: MessageKey; name?: string } | null>(null)
  const editorInputRef = useRef<HTMLInputElement>(null)
  const editorCancelRef = useRef<HTMLButtonElement>(null)
  const editorReturnRef = useRef<HTMLElement | null>(null)
  const tabsRef = useRef<HTMLDivElement>(null)
  const { maskImage: tabsMaskImage } = useScrollFade(tabsRef, { axis: 'horizontal', dependsOn: archived })
  const listRef = useRef<HTMLDivElement>(null)
  const { maskImage } = useScrollFade(listRef)
  const sessionsByPath = useMemo(() => new Map(sessions.map((session) => [session.path, session])), [sessions])
  const pinnedPaths = useMemo(() => new Set(preferences.pinned), [preferences.pinned])
  const unreadPaths = useMemo(() => new Set(preferences.unread), [preferences.unread])
  const archivedCount = useMemo(() => sessions.filter((session) => preferences.archived.includes(session.path)).length, [sessions, preferences.archived])
  const groups = useMemo(() => buildSidebarGroups(sessions, folders, preferences, { archived, query, runningPaths }), [sessions, folders, preferences, archived, query, runningPaths])
  const groupMap = useMemo(() => {
    const map = new Map<string, SidebarListGroup>()
    const visit = (group: SidebarListGroup) => { map.set(group.id, group); group.children?.forEach(visit) }
    groups.forEach(visit)
    return map
  }, [groups])
  const expandedIds = useMemo(() => [...groupMap.keys()].filter((id) => !preferences.collapsed.includes(id)), [groupMap, preferences.collapsed])
  const allExpanded = expandedIds.length === groupMap.size
  const count = groups.reduce((sum, group) => sum + group.sessions.length, 0)
  const labelFor = (group: SidebarListGroup) => group.kind === 'project' ? basename(group.cwd!) : group.kind === 'custom' ? group.label! : t(GROUP_LABELS[group.kind])
  const items = useMemo(() => {
    const resource = (group: SidebarListGroup): SidebarResource => {
      const visible = group.sessions.slice(0, limits[group.id] ?? PAGE_SIZE)
      // Keep the current conversation reachable when it sits beyond the first page.
      const active = group.sessions.find((session) => session.path === activePath)
      if (active && !visible.includes(active)) visible.push(active)
      return {
        id: group.id, label: labelFor(group), kind: 'folder',
        children: group.children ? group.children.map(resource) : [
          ...visible.map((session) => ({ id: session.path, label: session.label ?? t('workspace.newChat'), kind: 'file' as const })),
          ...(visible.length < group.sessions.length ? [{ id: `more:${group.id}`, label: t('workspace.showMore'), kind: 'file' as const }] : [])
        ]
      }
    }
    return groups.map(resource)
  }, [groups, limits, activePath, t])

  useEffect(() => { setLimits({}); listRef.current?.scrollTo({ top: 0 }) }, [preferences.view, preferences.sort, preferences.filter, archived, query])
  useEffect(() => {
    if (!editor) return
    setEditorFailed(false)
    let frame = 0
    const focus = () => {
      const target = editor.kind === 'assign' ? editorCancelRef.current : editorInputRef.current
      if (target) { target.focus({ preventScroll: true }); if (target instanceof HTMLInputElement) target.select() }
      else frame = requestAnimationFrame(focus)
    }
    frame = requestAnimationFrame(focus)
    return () => cancelAnimationFrame(frame)
  }, [editor?.kind, editor?.id])

  const clearFilters = () => { setQuery(''); update((current) => ({ ...current, filter: 'all' })) }
  const changeView = (view: SidebarView) => {
    if (update((current) => ({ ...current, view }))) { setArchived(false); setOperationError(null) }
  }
  const setExpanded = (ids: string[]) => {
    const next = new Set(ids)
    // local patch (pi-app): collapsing a group drops its "show more" page, so
    // reopening it starts from the first page instead of the expanded count.
    setLimits((current) => {
      const kept = Object.entries(current).filter(([id]) => next.has(id))
      return kept.length === Object.keys(current).length ? current : Object.fromEntries(kept)
    })
    update((current) => ({ ...current, collapsed: [...current.collapsed.filter((id) => !groupMap.has(id)), ...[...groupMap.keys()].filter((id) => !next.has(id))] }))
  }
  const move = (request: SidebarResourceMove) => update((current) => reorderSidebarResource(current, sessionsByPath, request, folders))
  const openSession = async (session: SessionSummaryDTO) => {
    setOperationError(null)
    try {
      await props.onOpenSession(session.path, session.cwd)
    } catch { setOperationError({ key: 'sessionSidebar.openFailed' }) }
  }
  const rename = async (id: string, name: string) => {
    name = name.slice(0, 100)
    if (id.startsWith('group:')) {
      if (!update((current) => ({ ...current, groups: current.groups.map((group) => group.id === id ? { ...group, name } : group) }))) throw new Error('sidebar persistence failed')
      return
    }
    try { await props.onRenameSession(id, name); setOperationError(null) }
    catch (error) { setOperationError({ key: 'sessionSidebar.renameFailed', name: sessionsByPath.get(id)?.label ?? t('workspace.newChat') }); throw error }
  }
  const openEditor = (next: Editor) => {
    if (!editor) editorReturnRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setEditor(next)
  }
  const closeEditor = () => {
    const id = editor?.id ?? editor?.assignPath
    setEditor(null)
    requestAnimationFrame(() => {
      const row = id ? [...(listRef.current?.querySelectorAll<HTMLElement>('[data-resource-id]') ?? [])].find((node) => node.dataset.resourceId === id) : null
      const target = row ?? (editorReturnRef.current?.isConnected ? editorReturnRef.current : null) ?? listRef.current?.closest('.session-sidebar')?.querySelector<HTMLInputElement>('input')
      target?.focus({ preventScroll: true })
    })
  }
  const resolveContextTarget = (target: EventTarget | null): string | null => {
    const id = target instanceof Element ? target.closest('[data-resource-id]')?.getAttribute('data-resource-id') : null
    return id && actionsFor(id).length ? id : null
  }
  const actionsFor = (id: string): Action[] => {
    const session = sessionsByPath.get(id), group = groupMap.get(id)
    const actions: Action[] = []
    const add = (key: string, label: string, icon: IconComponent, run: () => void, destructive = false, separator = false) => actions.push({ key, label, icon, run, destructive, separator })
    if (session) {
      add('pin', t(pinnedPaths.has(id) ? 'workspace.unpinSession' : 'workspace.pinSession'), pinnedPaths.has(id) ? PinOff : Pin, () => { update((current) => toggleSessionPin(current, id)) })
      add('group', t('sessionSidebar.assignGroup'), Layers, () => openEditor({ kind: 'assign', id, name: session.label ?? t('workspace.newChat'), groupId: preferences.groups.find((entry) => entry.sessions.includes(id))?.id ?? 'none' }))
      add('unread', t(unreadPaths.has(id) ? 'sessionSidebar.markRead' : 'sessionSidebar.markUnread'), MessageSquareDashed, () => { update((current) => setSessionUnread(current, id, !current.unread.includes(id))) })
      const isArchived = preferences.archived.includes(id)
      add('archive', t(isArchived ? 'sessionSidebar.unarchive' : 'sessionSidebar.archive'), isArchived ? ArchiveRestore : Archive, () => { update((current) => setSessionArchived(current, id, !current.archived.includes(id))) })
      add('rename', t('workspace.renameSession'), Pencil, () => openEditor({ kind: 'session', id, name: session.label ?? '' }), false, true)
      add('rewind', t('rewind.title'), ArrowLeftFromLine, () => props.onRewindSession(id, session.cwd))
      add('copy', t('workspace.copySessionId'), Copy, () => props.onCopySessionId(id))
    } else if (group) {
      if (group.kind === 'project' || group.kind === 'chats') add('new', t('workspace.newChat'), MessageSquarePlus, () => props.onNewSession(group.cwd))
      if (group.kind === 'projects') add('folder', t('workspace.openFolder'), FolderInput, props.onOpenFolder)
      if (group.kind === 'custom') {
        add('rename', t('sessionSidebar.renameGroup'), Pencil, () => openEditor({ kind: 'group', id, name: group.label! }))
        add('remove', t('sessionSidebar.removeGroup'), Trash2, () => setRemoveGroup({ id, name: group.label! }), true)
      }
    }
    const peers = session
      ? [...groupMap.values()].find((entry) => !entry.children && entry.sessions.some((row) => row.path === id))?.sessions.map((row) => row.path) ?? []
      : group?.kind === 'project' ? groups.find((entry) => entry.kind === 'projects')?.children?.map((entry) => entry.id) ?? [] : groups.map((entry) => entry.id)
    const index = peers.indexOf(id)
    for (const [targetId, position, key, icon] of [[peers[index - 1], 'before', 'workspace.moveSessionUp', ArrowUp], [peers[index + 1], 'after', 'workspace.moveSessionDown', ArrowDown]] as const) {
      const request = { itemId: id, targetId: targetId ?? null, position }
      if (canMoveSidebarResource(preferences, sessionsByPath, request, archived)) add(position, t(key), icon, () => { move(request) })
    }
    if (session) add('delete', t('workspace.deleteSession'), Trash2, () => props.onDeleteSession(session), true, true)
    if (group?.kind === 'project') add('delete', t('workspace.deleteProject'), Trash2, () => props.onDeleteFolder(group.cwd!, labelFor(group)), true, true)
    return actions
  }
  const renderActionsMenu = (id: string, close: () => void, context = false): ReactNode => actionsFor(id).map((action) => {
    const Icon = action.icon
    return <div key={action.key}>
      {action.separator ? context ? <ContextMenuSeparator /> : <div className="my-1 h-px bg-border" /> : null}
      {context ? <ContextMenuItem tone={action.destructive ? 'destructive' : 'default'} onSelect={action.run}>
        <Icon aria-hidden="true" className="size-4 shrink-0" /><span>{action.label}</span>
      </ContextMenuItem> : <Button variant={action.destructive ? 'destructive' : 'ghost'} size="sm" onClick={() => { close(); action.run() }}
        className={cn(MENU_ITEM_CLASS, !action.destructive && 'text-foreground')}>
        <Icon aria-hidden="true" className="size-4 shrink-0" /><span>{action.label}</span>
      </Button>}
    </div>
  })
  const labels = useMemo<AISidebarProps['labels']>(() => ({
    actionsFor: (name) => t('sessionSidebar.actionsFor', { name }), renameLabel: (name) => t('sessionSidebar.renameLabel', { name }),
    movePending: t('sessionSidebar.movePending'), moved: (name, target, position) => t(position === 'before' ? 'sessionSidebar.movedBefore' : 'sessionSidebar.movedAfter', { name, target }),
    moveFailed: (name) => t('sessionSidebar.moveFailed', { name }), renameFailed: (name) => t('sessionSidebar.renameFailed', { name })
  }), [t])
  const shortDate = useMemo(() => new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }), [locale])
  const fullDate = useMemo(() => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }), [locale])
  const saveEditor = async () => {
    if (!editor || editorBusyRef.current || (editor.kind !== 'assign' && !editor.name.trim())) return
    editorBusyRef.current = true; setEditorBusy(true); setEditorFailed(false)
    try {
      if (editor.kind === 'new-group') {
        const id = `group:${crypto.randomUUID()}`
        if (!update((current) => {
          const next = { ...current, view: 'groups' as const, groups: [...current.groups, { id, name: editor.name.trim(), sessions: [] }] }
          return editor.assignPath ? assignSessionGroup(next, editor.assignPath, id) : next
        })) throw new Error('sidebar persistence failed')
        setArchived(false)
      } else if (editor.kind === 'assign') {
        if (!update((current) => assignSessionGroup(current, editor.id!, editor.groupId === 'none' ? null : editor.groupId!))) throw new Error('sidebar persistence failed')
      } else await rename(editor.id!, editor.name.trim())
      closeEditor()
    } catch { setEditorFailed(true) }
    finally { editorBusyRef.current = false; setEditorBusy(false) }
  }
  const editorTitle = editor ? t(editor.kind === 'new-group' ? 'sessionSidebar.newGroup' : editor.kind === 'group' ? 'sessionSidebar.renameGroup' : editor.kind === 'assign' ? 'sessionSidebar.assignGroup' : 'workspace.renameSession') : ''

  return <AnimatedSidebarGroup className="session-sidebar min-h-0 flex-1 px-1 py-0" data-archived={archived} data-details={preferences.showDetails}>
    <div className="flex h-8 shrink-0 items-center justify-between gap-1 pr-1">
      <AnimatedSidebarGroupLabel className="flex h-8 min-w-0 items-center gap-2 px-2 text-xs font-medium normal-case tracking-normal">
        <span>{t(archived ? 'sessionSidebar.archived' : 'workspace.sessions')}</span>
        <span className="text-micro font-normal tabular-nums text-muted-foreground" aria-label={t('sessionSidebar.count', { count })}>{count}</span>
      </AnimatedSidebarGroupLabel>
      <div className="flex shrink-0 items-center gap-0.5">
        <Tooltip content={t('scheduledTasks.open')}><Button variant="ghost" size="icon" aria-label={t('scheduledTasks.open')} className="relative" onClick={props.onOpenScheduled}>
          <CalendarCheck aria-hidden="true" className="size-4" />
          {props.scheduledUnread > 0 ? <span aria-label={t('scheduledTasks.unread', { count: props.scheduledUnread })} className="absolute right-0 top-0 grid min-w-4 place-items-center rounded-capsule bg-primary px-1 text-micro font-semibold text-primary-foreground">{props.scheduledUnread}</span> : null}
        </Button></Tooltip>
        <SessionSearchTrigger />
        <MorphPopover open={optionsOpen} onOpenChange={setOptionsOpen}>
          <Tooltip content={t('sessionSidebar.options')}><MorphPopoverTrigger><Button variant="ghost" size="icon" aria-label={t('sessionSidebar.options')} className={cn(preferences.filter !== 'all' && 'text-primary')}><ListFilter aria-hidden="true" className="size-4" /></Button></MorphPopoverTrigger></Tooltip>
          <MorphPopoverContent radius="var(--app-radius-card)" className="w-56 max-h-[calc(100dvh-24px)] overflow-y-auto p-3">
            <div className="space-y-4" data-session-options>
              <fieldset><legend className="mb-2 text-xs font-medium text-muted-foreground">{t('sessionSidebar.sort')}</legend>
                <RadioGroup value={preferences.sort === 'manual' && (archived || preferences.view === 'timeline') ? 'updated' : preferences.sort} onValueChange={(sort) => { update((current) => ({ ...current, sort: sort as SidebarSort })) }} className="gap-2">
                  <RadioGroupItem value="updated" label={t('sessionSidebar.sortUpdated')} />
                  <RadioGroupItem value="created" label={t('sessionSidebar.sortCreated')} />
                  <RadioGroupItem value="manual" label={t('sessionSidebar.sortManual')} disabled={archived || preferences.view === 'timeline'} />
                </RadioGroup>
              </fieldset>
              <fieldset><legend className="mb-2 text-xs font-medium text-muted-foreground">{t('sessionSidebar.filter')}</legend>
                <RadioGroup value={preferences.filter} onValueChange={(filter) => { update((current) => ({ ...current, filter: filter as SidebarFilter })) }} className="gap-2">
                  <RadioGroupItem value="all" label={t('sessionSidebar.all')} /><RadioGroupItem value="running" label={t('sessionSidebar.running')} /><RadioGroupItem value="unread" label={t('sessionSidebar.unread')} />
                </RadioGroup>
              </fieldset>
              <Checkbox mark="square" checked={preferences.showDetails} onCheckedChange={(showDetails) => { update((current) => ({ ...current, showDetails })) }} label={t('sessionSidebar.showDetails')} />
            </div>
          </MorphPopoverContent>
        </MorphPopover>
      </div>
    </div>
    <div className="mb-2 flex h-9 shrink-0 items-center gap-0.5 px-1">
      {archived ? <Button variant="ghost" size="sm" onClick={() => setArchived(false)} className="h-8 min-w-0 justify-start gap-2 px-1.5 text-xs"><ChevronRight aria-hidden="true" className="size-4 rotate-180" />{t('sessionSidebar.closeArchive')}</Button> :
        <div ref={tabsRef} className="min-w-0 overflow-x-auto p-px" style={tabsMaskImage ? { maskImage: tabsMaskImage, WebkitMaskImage: tabsMaskImage } : undefined}>
          <Tabs value={preferences.view} onValueChange={(view) => changeView(view as SidebarView)} variant="underline" className="w-max">
            <TabsList className="h-8 gap-0 border-b-0">
              {([['groups', Layers], ['projects', Folder], ['timeline', Clock3]] as const).map(([view, Icon]) => <TabsTrigger key={view} value={view} className="h-8 min-h-0 gap-1.5 whitespace-nowrap px-1.5 py-0 text-xs">
                <Icon aria-hidden="true" className="size-4 shrink-0" />{t(`sessionSidebar.${view}`)}
              </TabsTrigger>)}
            </TabsList>
          </Tabs>
        </div>}
      <Tooltip content={t(archived ? 'sessionSidebar.closeArchive' : 'sessionSidebar.openArchive')} wrapperClassName="ml-auto shrink-0"><Button variant="ghost" size="icon" aria-label={t(archived ? 'sessionSidebar.closeArchive' : 'sessionSidebar.openArchive')} aria-pressed={archived} onClick={() => { setArchived(!archived); clearFilters(); setOperationError(null) }} className={cn('relative size-8 shrink-0', archived && 'text-primary')}>
        <Archive aria-hidden="true" className="size-4" />{archivedCount > 0 ? <span className="session-archive-count text-micro tabular-nums">{archivedCount}</span> : null}
      </Button></Tooltip>
    </div>
    <div className="mb-2 flex shrink-0 items-center gap-1 px-1">
      <Input value={query} onChange={setQuery} aria-label={t('sessionSidebar.filterPlaceholder')} placeholder={t('sessionSidebar.filterPlaceholder')} className="min-w-0 flex-1" classNames={{ field: 'bg-transparent' }} />
      {!archived && preferences.view === 'groups' ? <Tooltip content={t('sessionSidebar.newGroup')}><Button variant="ghost" size="icon" className="size-7 shrink-0" aria-label={t('sessionSidebar.newGroup')} onClick={() => openEditor({ kind: 'new-group', name: '' })}><Plus aria-hidden="true" className="size-4" /></Button></Tooltip> : null}
      <Tooltip content={t(allExpanded ? 'sessionSidebar.collapseAll' : 'sessionSidebar.expandAll')}><Button variant="ghost" size="icon" className="size-7 shrink-0" disabled={!groupMap.size} aria-label={t(allExpanded ? 'sessionSidebar.collapseAll' : 'sessionSidebar.expandAll')} onClick={() => setExpanded(allExpanded ? [] : [...groupMap.keys()])}>{allExpanded ? <ChevronsDownUp aria-hidden="true" className="size-4" /> : <ChevronsUpDown aria-hidden="true" className="size-4" />}</Button></Tooltip>
    </div>
    {archived ? <p className="px-2 pb-2 text-caption leading-ui text-muted-foreground">{t('sessionSidebar.archiveDescription')}</p> : null}
    {preferences.filter !== 'all' || query ? <div className="flex shrink-0 items-center justify-between px-2 pb-1 text-caption text-muted-foreground"><span>{t(preferences.filter === 'all' ? 'sessionSidebar.all' : `sessionSidebar.${preferences.filter}`)}</span><Button variant="ghost" size="sm" className="h-6 px-1 text-caption" onClick={clearFilters}>{t('sessionSidebar.clearFilter')}</Button></div> : null}
    {props.saveError ? <p role="alert" className="px-2 pb-2 text-xs text-destructive">{t('workspace.sidebarSaveError')}</p> : null}
    {operationError ? <p role="alert" className="px-2 pb-2 text-xs text-destructive">{t(operationError.key, { name: operationError.name ?? '' })}</p> : null}
    <AnimatedSidebarGroupContent className="relative min-h-0 flex-1 overflow-hidden">
      <ContextMenu open={contextOpen} onOpenChange={(open) => setContextOpen(open && contextTargetRef.current !== null)}>
        <ContextMenuTrigger>
          <div ref={listRef} style={maskImage ? { maskImage, WebkitMaskImage: maskImage } : undefined} className="h-full overflow-y-auto overscroll-contain [overflow-anchor:none]"
            onContextMenu={(event) => {
              const id = resolveContextTarget(event.target)
              if (!id) { event.preventDefault(); return }
              contextTargetRef.current = id
              setContextId(id)
            }}
            onPointerDown={(event) => {
              if (event.pointerType !== 'touch' && event.pointerType !== 'pen') return
              const id = resolveContextTarget(event.target)
              // A long press must resolve its own row, while ordinary touch
              // scrolling and section taps remain available on synthetic rows.
              contextTargetRef.current = id
              setContextId(id)
            }}>
            <AISidebar items={items} activeId={activePath} expandedIds={expandedIds} onExpandedIdsChange={setExpanded} allowNesting={false} ariaLabel={t('workspace.sessions')} className="sessions-tree" labels={labels}
              canDrag={(item) => !archived && (item.id.startsWith('folder:') || item.id.startsWith('group:') || item.id === 'section:projects' || item.id === 'section:chats' || sessionsByPath.has(item.id) && (pinnedPaths.has(item.id) || preferences.view !== 'timeline' && preferences.sort === 'manual'))}
              canMove={(request) => canMoveSidebarResource(preferences, sessionsByPath, request, archived)}
              onMove={(request) => { if (!move(request)) throw new Error('sidebar persistence failed') }}
              canRename={(item) => sessionsByPath.has(item.id) || item.id.startsWith('group:')}
              hasMenu={(item) => actionsFor(item.id).length > 0}
              menuHeight={420} menuClassName="w-52 max-h-[calc(100dvh-24px)] overflow-y-auto"
              onActiveChange={(id) => {
                if (id.startsWith('more:')) { const groupId = id.slice(5); setLimits((current) => ({ ...current, [groupId]: (current[groupId] ?? PAGE_SIZE) + PAGE_SIZE })); return }
                const session = sessionsByPath.get(id); if (session) void openSession(session)
              }}
              onRename={(item, name) => rename(item.id, name)}
              renderMenu={(item, controls) => renderActionsMenu(item.id, controls.close)}
              renderIcon={(item) => {
                if (item.id.startsWith('more:')) return <span data-more-row><ChevronDown aria-hidden="true" className="size-3.5" /></span>
                const group = groupMap.get(item.id)
                if (group) {
                  const Icon = group.kind === 'pinned' ? Pin : group.kind === 'custom' ? Hash : group.kind === 'chats' ? Chats : group.kind === 'ungrouped' ? Layers : group.kind === 'project' || group.kind === 'projects' ? Folder : Clock3
                  return <span data-sidebar-group={item.id} className="grid place-items-center"><Icon aria-hidden="true" className={cn('size-4', group.kind === 'project' && 'group-aria-expanded/resource:hidden')} />{group.kind === 'project' ? <FolderOpen aria-hidden="true" className="hidden size-4 group-aria-expanded/resource:block" /> : null}</span>
                }
                return runningPaths.has(item.id) ? <span role="status" aria-label={t('sessionSidebar.runningStatus')}><LoaderCircle aria-hidden="true" className="size-4 animate-spin text-primary" /></span> : <Chat01 aria-hidden="true" className="size-4" />
              }}
              renderLabel={(item, label) => {
                const group = groupMap.get(item.id), session = sessionsByPath.get(item.id)
                if (group) return <LabelTooltip content={<span data-session-group-tooltip className="line-clamp-6">{group.cwd ?? item.label}</span>} wrap side="right" align="start" delay={100} wrapperClassName="min-w-0 flex-1" className="max-w-[min(20rem,calc(100vw-16px))] font-normal leading-ui shadow-overlay [overflow-wrap:anywhere]">
                  <span data-session-group={group.kind} className="flex min-w-0 flex-1 items-center gap-2">{label}<span className="session-group-count text-micro tabular-nums">{group.sessions.length}</span><ChevronRight aria-hidden="true" className="size-3 shrink-0 transition-transform group-aria-expanded/resource:rotate-90 motion-reduce:transition-none" /></span>
                </LabelTooltip>
                if (!session) return label
                const time = new Date(sessionTimestamp(session, preferences.sort))
                const validDate = Number.isFinite(time.getTime())
                const project = session.projectless ? t('workspace.projectlessSessions') : basename(session.cwd)
                return <span data-session-row className={cn('flex min-w-0 flex-1 flex-col justify-center', unreadPaths.has(item.id) && 'font-medium text-foreground')}>
                  <span className="flex min-w-0 items-center gap-1.5">{unreadPaths.has(item.id) ? <span className="size-1.5 shrink-0 rounded-full bg-primary" aria-label={t('sessionSidebar.unread')} /> : null}{label}</span>
                  {preferences.showDetails ? <span data-session-meta className="truncate text-caption font-normal leading-ui text-muted-foreground/75">{project}{validDate ? <> · <time dateTime={sessionTimestamp(session, preferences.sort)}>{shortDate.format(time)}</time></> : null}</span> : null}
                </span>
              }}
              renderRow={(item, row, state) => {
                const session = sessionsByPath.get(item.id)
                if (!session) return row
                const time = new Date(sessionTimestamp(session, preferences.sort))
                const validDate = Number.isFinite(time.getTime())
                return <LabelTooltip content={<span className="block">
                  <span data-session-title-tooltip className="line-clamp-6">{item.label}</span>
                  <span data-session-details-tooltip className="mt-1 block text-caption text-muted-foreground">
                    <span className="block">{t('sessionSidebar.messages', { count: session.messageCount })}{validDate ? ` · ${fullDate.format(time)}` : ''}</span>
                    {!session.projectless ? <span className="line-clamp-2">{session.cwd}</span> : null}
                  </span>
                </span>} wrap side="right" align="start" delay={100} disabled={state.renaming || state.menuOpen || state.dragging} wrapperClassName="block w-full min-w-0" className="max-w-[min(20rem,calc(100vw-16px))] font-normal leading-ui shadow-overlay [overflow-wrap:anywhere]">{row}</LabelTooltip>
              }}
              renderActions={(item) => {
                const group = groupMap.get(item.id)
                if (!group || !['projects', 'project', 'chats'].includes(group.kind)) return null
                const label = group.kind === 'projects' ? t('workspace.openFolder') : t('workspace.newChatInFolder', { label: labelFor(group) })
                const Icon = group.kind === 'projects' ? FolderInput : MessageSquarePlus
                return <Tooltip content={label} wrapperClassName="absolute right-11 top-1/2 z-10 -translate-y-1/2"><Button variant="ghost" size="icon" aria-label={label} onClick={(event) => { event.stopPropagation(); if (group.kind === 'projects') props.onOpenFolder(); else props.onNewSession(group.cwd) }} className="session-group-action size-7 rounded-control bg-background"><Icon aria-hidden="true" className="size-4" /></Button></Tooltip>
              }}
            />
            {!count && (!sessions.length || archived || query || preferences.filter !== 'all' || preferences.view === 'timeline') ? <div className="flex flex-col items-center gap-2 px-4 py-8 text-center text-xs text-muted-foreground">{archived ? <Archive className="size-5" aria-hidden="true" /> : <Chat01 className="size-5" aria-hidden="true" />}<p>{t(query || preferences.filter !== 'all' ? 'sessionSidebar.noMatches' : archived ? 'sessionSidebar.noArchive' : 'sessionSidebar.noSessions')}</p></div> : null}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-56">{contextId ? renderActionsMenu(contextId, () => {}, true) : null}</ContextMenuContent>
      </ContextMenu>
    </AnimatedSidebarGroupContent>
    <CenterMorphModal open={!!editor} onOpenChange={(open) => { if (!open && !editorBusyRef.current) closeEditor() }}>
      <CenterMorphModalContent ariaLabel={editorTitle} closeButtonLabel={t('common.cancel')} initialFocusRef={editor?.kind === 'assign' ? editorCancelRef : editorInputRef} dismissible={!editorBusy} showCloseButton={!editorBusy} className="max-w-md">
        {editor ? <form className="p-5" data-session-editor={editor.kind} onSubmit={(event) => { event.preventDefault(); void saveEditor() }}>
          <h2 className={cn(FORM_PANEL_TITLE, 'pr-8')}>{editorTitle}</h2>
          {editor.kind === 'new-group' || editor.kind === 'assign' ? <p className="mt-1.5 text-caption text-muted-foreground">{t('sessionSidebar.groupDescription')}</p> : null}
          <div data-form-items className="mt-5 grid grid-cols-2 gap-5">
            <div className="col-span-2 flex flex-col gap-1.5">
              {editor.kind === 'assign' ? <><span className={FORM_FIELD_TITLE}>{t('sessionSidebar.groups')}</span><Select value={editor.groupId} onValueChange={(groupId) => setEditor({ ...editor, groupId })} disabled={editorBusy}>
                <SelectTrigger aria-label={t('sessionSidebar.groups')}><SelectValue className="text-sm" /></SelectTrigger>
                <SelectContent portal><SelectItem value="none">{t('sessionSidebar.ungrouped')}</SelectItem>{preferences.groups.map((group) => <SelectItem key={group.id} value={group.id}>{group.name}</SelectItem>)}</SelectContent>
              </Select><Button variant="ghost" size="sm" className="justify-start gap-2 self-start px-0 text-xs" onClick={() => openEditor({ kind: 'new-group', name: '', assignPath: editor.id })}><Plus aria-hidden="true" className="size-4" />{t('sessionSidebar.newGroup')}</Button></> :
                <Input ref={editorInputRef} label={t(editor.kind === 'session' ? 'workspace.renameSession' : 'sessionSidebar.groupName')} classNames={FORM_INPUT_LABEL} value={editor.name} maxLength={100} disabled={editorBusy} onChange={(name) => setEditor({ ...editor, name })} />}
            </div>
          </div>
          {editorFailed ? <p role="alert" className="mt-1.5 text-xs text-destructive">{t(editor.kind === 'session' ? 'sessionSidebar.renameFailed' : 'workspace.sidebarSaveError', { name: editor.name })}</p> : null}
          <div className="mt-5 flex justify-end gap-2"><Button ref={editorCancelRef} variant="outline" size="sm" disabled={editorBusy} onClick={closeEditor}>{t('common.cancel')}</Button><Button type="submit" size="sm" disabled={editorBusy || editor.kind !== 'assign' && !editor.name.trim()}>{t('common.save')}</Button></div>
        </form> : null}
      </CenterMorphModalContent>
    </CenterMorphModal>
    <ConfirmDialog open={!!removeGroup} title={t('sessionSidebar.removeGroupTitle')} message={t('sessionSidebar.removeGroupMessage', { name: removeGroup?.name ?? '' })} confirmLabel={t('sessionSidebar.removeGroup')} onClose={() => setRemoveGroup(null)} onConfirm={() => { if (removeGroup) update((current) => ({ ...current, groups: current.groups.filter((group) => group.id !== removeGroup.id), collapsed: current.collapsed.filter((id) => id !== removeGroup.id) })) }} />
  </AnimatedSidebarGroup>
}
