import type { SessionSummaryDTO } from '../../../shared/types'
import type { SidebarResourceMove } from '@/components/agents/ai-sidebar'

const STORAGE_KEY = 'pi-app:session-sidebar:v1'
export const PINNED_GROUP = 'section:pinned'
export const CHATS_GROUP = 'section:chats'
export const PROJECTS_GROUP = 'section:projects'
export const UNGROUPED_GROUP = 'section:ungrouped'
export type SidebarView = 'projects' | 'groups' | 'timeline'
export type SidebarSort = 'manual' | 'updated' | 'created'
export type SidebarFilter = 'all' | 'running' | 'unread'

export interface SessionSidebarGroup {
  id: string
  name: string
  sessions: string[]
}

/** Presentation only: never rewrite a session's cwd or its SDK file. */
export interface SessionSidebarPreferences {
  pinned: string[]
  order: string[]
  archived: string[]
  unread: string[]
  groups: SessionSidebarGroup[]
  view: SidebarView
  sort: SidebarSort
  filter: SidebarFilter
  collapsed: string[]
  projectOrder: string[]
  sectionOrder: string[]
  showDetails: boolean
}

const strings = (input: unknown): string[] => Array.isArray(input)
  ? [...new Set(input.filter((value): value is string => typeof value === 'string' && value.length > 0))].slice(0, 20_000)
  : []

export function parseSidebarPreferences(raw: string | null): SessionSidebarPreferences {
  let value: Partial<SessionSidebarPreferences> = {}
  try {
    const parsed: unknown = JSON.parse(raw ?? '{}')
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) value = parsed
  } catch { /* Use defaults for missing/corrupt presentation state. */ }
  const groupIds = new Set<string>(), assignedPaths = new Set<string>()
  const groups: SessionSidebarGroup[] = []
  if (Array.isArray(value.groups)) for (const group of value.groups.slice(0, 200)) {
    if (!group || typeof group.id !== 'string' || !group.id.startsWith('group:') || groupIds.has(group.id) || typeof group.name !== 'string' || !group.name.trim()) continue
    groupIds.add(group.id)
    const sessions = strings(group.sessions).filter((path) => {
      if (assignedPaths.has(path)) return false
      assignedPaths.add(path)
      return true
    })
    groups.push({ id: group.id, name: group.name.trim().slice(0, 100), sessions })
  }
  const order = strings(value.order)
  return {
    pinned: strings(value.pinned), order,
    archived: strings(value.archived), unread: strings(value.unread), groups,
    view: ['projects', 'groups', 'timeline'].includes(value.view ?? '') ? value.view! : 'projects',
    // Old manual positions survive an upgrade; new profiles use activity sorting.
    sort: ['manual', 'updated', 'created'].includes(value.sort ?? '') ? value.sort! : order.length ? 'manual' : 'updated',
    filter: ['all', 'running', 'unread'].includes(value.filter ?? '') ? value.filter! : 'all',
    collapsed: strings(value.collapsed), projectOrder: strings(value.projectOrder),
    sectionOrder: [...strings(value.sectionOrder).filter((id) => id === PROJECTS_GROUP || id === CHATS_GROUP), PROJECTS_GROUP, CHATS_GROUP].filter((id, index, all) => all.indexOf(id) === index),
    showDetails: typeof value.showDetails === 'boolean' ? value.showDetails : true
  }
}

export function loadSidebarPreferences(): SessionSidebarPreferences {
  try {
    return parseSidebarPreferences(window.localStorage.getItem(STORAGE_KEY))
  } catch {
    return parseSidebarPreferences(null)
  }
}

export function saveSidebarPreferences(preferences: SessionSidebarPreferences): void {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences))
}

export function sessionTimestamp(session: SessionSummaryDTO, sort: SidebarSort): string {
  return sort === 'created' ? session.created ?? session.modified : session.modified
}

export function orderSessions(sessions: SessionSummaryDTO[], order: string[] | ReadonlyMap<string, number>, sort: SidebarSort = 'manual'): SessionSummaryDTO[] {
  const ranks = Array.isArray(order) ? new Map(order.map((path, index) => [path, index])) : order
  // Newly discovered sessions appear first; once moved, their position stays
  // put even when a background run changes the modification timestamp.
  return [...sessions].sort((a, b) => {
    if (sort === 'manual') {
      const aRank = ranks.get(a.path), bRank = ranks.get(b.path)
      if (aRank !== undefined && bRank !== undefined) return aRank - bRank
      if (aRank !== undefined) return 1
      if (bRank !== undefined) return -1
    }
    return sessionTimestamp(b, sort).localeCompare(sessionTimestamp(a, sort)) || a.path.localeCompare(b.path)
  })
}

export function canReorderSession(
  move: SidebarResourceMove,
  sessions: ReadonlyMap<string, SessionSummaryDTO>,
  pinned: ReadonlySet<string>
): boolean {
  if (move.position === 'inside' || !move.targetId || move.itemId === move.targetId) return false
  const source = sessions.get(move.itemId), target = sessions.get(move.targetId)
  return !!source && !!target && source.cwd === target.cwd &&
    pinned.has(source.path) === pinned.has(target.path)
}

export function reorderSession(
  preferences: SessionSidebarPreferences,
  sessions: ReadonlyMap<string, SessionSummaryDTO>,
  move: SidebarResourceMove
): SessionSidebarPreferences {
  const pinned = new Set(preferences.pinned)
  if (!canReorderSession(move, sessions, pinned)) return preferences
  const source = sessions.get(move.itemId)!
  const isPinned = pinned.has(move.itemId)
  const scope = [...sessions.values()].filter((session) =>
    isPinned ? pinned.has(session.path) : session.cwd === source.cwd && !pinned.has(session.path))
  // Use the complete scope, including rows hidden behind "Show more".
  const ordered = orderSessions(scope, isPinned ? preferences.pinned : preferences.order).map((session) => session.path)
  ordered.splice(ordered.indexOf(move.itemId), 1)
  ordered.splice(ordered.indexOf(move.targetId!) + (move.position === 'after' ? 1 : 0), 0, move.itemId)
  const included = new Set(ordered)
  return isPinned
    ? { ...preferences, pinned: [...ordered, ...preferences.pinned.filter((path) => !included.has(path))] }
    : { ...preferences, order: [...ordered, ...preferences.order.filter((path) => !included.has(path))] }
}

export function toggleSessionPin(preferences: SessionSidebarPreferences, path: string): SessionSidebarPreferences {
  return { ...preferences, pinned: preferences.pinned.includes(path)
    ? preferences.pinned.filter((p) => p !== path) : [path, ...preferences.pinned] }
}

export function forgetSidebarSessions(preferences: SessionSidebarPreferences, paths: Set<string>): SessionSidebarPreferences {
  return {
    ...preferences,
    pinned: preferences.pinned.filter((path) => !paths.has(path)), order: preferences.order.filter((path) => !paths.has(path)),
    archived: preferences.archived.filter((path) => !paths.has(path)), unread: preferences.unread.filter((path) => !paths.has(path)),
    groups: preferences.groups.map((group) => ({ ...group, sessions: group.sessions.filter((path) => !paths.has(path)) }))
  }
}

export function setSessionArchived(preferences: SessionSidebarPreferences, path: string, archived: boolean): SessionSidebarPreferences {
  return { ...preferences, archived: archived ? strings([path, ...preferences.archived]) : preferences.archived.filter((p) => p !== path) }
}

export function setSessionUnread(preferences: SessionSidebarPreferences, path: string, unread: boolean): SessionSidebarPreferences {
  return { ...preferences, unread: unread ? strings([path, ...preferences.unread]) : preferences.unread.filter((p) => p !== path) }
}

export function assignSessionGroup(preferences: SessionSidebarPreferences, path: string, groupId: string | null): SessionSidebarPreferences {
  if (groupId !== null && !preferences.groups.some((group) => group.id === groupId)) return preferences
  return { ...preferences, groups: preferences.groups.map((group) => ({ ...group, sessions: group.id === groupId ? strings([path, ...group.sessions]) : group.sessions.filter((p) => p !== path) })) }
}

export interface SidebarFolder { cwd: string; sessions: SessionSummaryDTO[] }
export type SidebarGroupKind = 'pinned' | 'projects' | 'project' | 'chats' | 'custom' | 'ungrouped' | 'today' | 'yesterday' | 'week' | 'month' | 'older'
export interface SidebarListGroup {
  id: string
  kind: SidebarGroupKind
  label?: string
  cwd?: string
  sessions: SessionSummaryDTO[]
  children?: SidebarListGroup[]
}

function dateBucket(timestamp: string, now: Date): SidebarGroupKind {
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const yesterday = new Date(day); yesterday.setDate(day.getDate() - 1)
  const week = new Date(day); week.setDate(day.getDate() - 7)
  const month = new Date(day); month.setDate(day.getDate() - 30)
  const time = Date.parse(timestamp)
  if (time >= day.getTime()) return 'today'
  if (time >= yesterday.getTime()) return 'yesterday'
  if (time >= week.getTime()) return 'week'
  if (time >= month.getTime()) return 'month'
  return 'older'
}

export function buildSidebarGroups(sessions: SessionSummaryDTO[], folders: SidebarFolder[], preferences: SessionSidebarPreferences, options: { archived?: boolean; query?: string; runningPaths?: ReadonlySet<string>; now?: Date } = {}): SidebarListGroup[] {
  const archived = new Set(preferences.archived), pinned = new Set(preferences.pinned), unread = new Set(preferences.unread)
  const normalize = (text: string) => text.normalize('NFKC').toLocaleLowerCase()
  const query = normalize(options.query?.trim() ?? '')
  const filtering = !!query || preferences.filter !== 'all'
  const visible = sessions.filter((session) => {
    if (archived.has(session.path) !== !!options.archived) return false
    if (preferences.filter === 'running' && !(session.running || options.runningPaths?.has(session.path))) return false
    if (preferences.filter === 'unread' && !unread.has(session.path)) return false
    return !query || normalize(`${session.label ?? ''} ${session.projectless ? '' : session.cwd}`).includes(query)
  })
  const pinnedSessions = options.archived ? [] : orderSessions(visible.filter((session) => pinned.has(session.path)), preferences.pinned)
  const rest = options.archived ? visible : visible.filter((session) => !pinned.has(session.path))
  const sort = (rows: SessionSummaryDTO[]) => orderSessions(rows, preferences.order, preferences.sort)
  const result: SidebarListGroup[] = pinnedSessions.length ? [{ id: PINNED_GROUP, kind: 'pinned', sessions: pinnedSessions }] : []
  if (preferences.view === 'timeline' || options.archived) {
    const buckets = new Map<SidebarGroupKind, SessionSummaryDTO[]>()
    const effectiveSort = preferences.sort === 'manual' ? 'updated' : preferences.sort
    for (const session of orderSessions(rest, [], effectiveSort)) {
      const bucket = dateBucket(sessionTimestamp(session, effectiveSort), options.now ?? new Date())
      const rows = buckets.get(bucket) ?? []; rows.push(session); buckets.set(bucket, rows)
    }
    return [...result, ...[...buckets].map(([kind, rows]) => ({ id: `date:${kind}`, kind, sessions: rows }))]
  }
  if (preferences.view === 'groups') {
    const byPath = new Map(rest.map((session) => [session.path, session]))
    const assigned = new Set(preferences.groups.flatMap((group) => group.sessions))
    for (const group of preferences.groups) {
      const rows = sort(group.sessions.flatMap((path) => byPath.has(path) ? [byPath.get(path)!] : []))
      if (rows.length || !filtering) result.push({ id: group.id, kind: 'custom', label: group.name, sessions: rows })
    }
    const ungrouped = sort(rest.filter((session) => !assigned.has(session.path)))
    if (ungrouped.length || !filtering) result.push({ id: UNGROUPED_GROUP, kind: 'ungrouped', sessions: ungrouped })
    return result
  }
  const byFolder = new Map<string, SessionSummaryDTO[]>()
  for (const session of rest) if (!session.projectless) {
    const rows = byFolder.get(session.cwd) ?? []; rows.push(session); byFolder.set(session.cwd, rows)
  }
  const ranks = new Map(preferences.projectOrder.map((cwd, index) => [cwd, index]))
  const projects = [...folders].sort((a, b) => (ranks.get(a.cwd) ?? ranks.size) - (ranks.get(b.cwd) ?? ranks.size)).flatMap((folder): SidebarListGroup[] => {
    const rows = sort(byFolder.get(folder.cwd) ?? [])
    return rows.length || !filtering ? [{ id: `folder:${folder.cwd}`, kind: 'project', cwd: folder.cwd, sessions: rows }] : []
  })
  const chats = sort(rest.filter((session) => session.projectless))
  const sections: SidebarListGroup[] = [
    ...(projects.length ? [{ id: PROJECTS_GROUP, kind: 'projects' as const, sessions: projects.flatMap((group) => group.sessions), children: projects }] : []),
    ...(chats.length || !filtering ? [{ id: CHATS_GROUP, kind: 'chats' as const, sessions: chats }] : [])
  ]
  return [...result, ...sections.sort((a, b) => preferences.sectionOrder.indexOf(a.id) - preferences.sectionOrder.indexOf(b.id))]
}

export function canMoveSidebarResource(preferences: SessionSidebarPreferences, sessions: ReadonlyMap<string, SessionSummaryDTO>, move: SidebarResourceMove, archived = false): boolean {
  if (move.position === 'inside' || !move.targetId || move.itemId === move.targetId || archived) return false
  if (preferences.view === 'projects') {
    if (preferences.sectionOrder.includes(move.itemId) && preferences.sectionOrder.includes(move.targetId)) return true
    if (move.itemId.startsWith('folder:') && move.targetId.startsWith('folder:')) return true
  }
  if (preferences.view === 'groups' && preferences.groups.some((group) => group.id === move.itemId) && preferences.groups.some((group) => group.id === move.targetId)) return true
  const pinned = new Set(preferences.pinned)
  if (!canReorderSession(move, sessions, pinned)) return false
  if (preferences.archived.includes(move.itemId) || preferences.archived.includes(move.targetId)) return false
  if (pinned.has(move.itemId)) return true
  if (preferences.view === 'timeline' || preferences.sort !== 'manual') return false
  if (preferences.view === 'groups') {
    const groupFor = (path: string) => preferences.groups.find((group) => group.sessions.includes(path))?.id
    if (groupFor(move.itemId) !== groupFor(move.targetId)) return false
  }
  return true
}

export function reorderSidebarResource(preferences: SessionSidebarPreferences, sessions: ReadonlyMap<string, SessionSummaryDTO>, move: SidebarResourceMove, folders: SidebarFolder[]): SessionSidebarPreferences {
  if (!canMoveSidebarResource(preferences, sessions, move)) return preferences
  const reorder = (ids: string[]) => {
    const next = [...ids]; next.splice(next.indexOf(move.itemId), 1)
    next.splice(next.indexOf(move.targetId!) + (move.position === 'after' ? 1 : 0), 0, move.itemId)
    return next
  }
  if (preferences.sectionOrder.includes(move.itemId)) return { ...preferences, sectionOrder: reorder(preferences.sectionOrder) }
  if (move.itemId.startsWith('folder:')) {
    const ranks = new Map(preferences.projectOrder.map((cwd, index) => [cwd, index]))
    const ids = [...folders].sort((a, b) => (ranks.get(a.cwd) ?? ranks.size) - (ranks.get(b.cwd) ?? ranks.size)).map((folder) => `folder:${folder.cwd}`)
    if (!ids.includes(move.itemId) || !ids.includes(move.targetId!)) return preferences
    return { ...preferences, projectOrder: reorder(ids).map((id) => id.slice(7)) }
  }
  if (move.itemId.startsWith('group:')) {
    const ids = reorder(preferences.groups.map((group) => group.id)), groups = new Map(preferences.groups.map((group) => [group.id, group]))
    return { ...preferences, groups: ids.map((id) => groups.get(id)!) }
  }
  return reorderSession(preferences, sessions, move)
}
