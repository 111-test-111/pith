import type { SessionSummaryDTO } from '../../../shared/types'
import type { SidebarResourceMove } from '@/components/agents/ai-sidebar'

const STORAGE_KEY = 'pi-app:session-sidebar:v1'
export const PINNED_GROUP = 'section:pinned'
export const CHATS_GROUP = 'section:chats'

/** Presentation only: never rewrite a session's cwd or its SDK file. */
export interface SessionSidebarPreferences {
  pinned: string[]
  order: string[]
}

export function parseSidebarPreferences(raw: string | null): SessionSidebarPreferences {
  try {
    const value = JSON.parse(raw ?? '{}')
    const paths = (input: unknown): string[] => Array.isArray(input)
      ? [...new Set(input.filter((path): path is string => typeof path === 'string' && path.length > 0))].slice(0, 20_000)
      : []
    return { pinned: paths(value?.pinned), order: paths(value?.order) }
  } catch {
    return { pinned: [], order: [] }
  }
}

export function loadSidebarPreferences(): SessionSidebarPreferences {
  try {
    return parseSidebarPreferences(window.localStorage.getItem(STORAGE_KEY))
  } catch {
    return { pinned: [], order: [] }
  }
}

export function saveSidebarPreferences(preferences: SessionSidebarPreferences): void {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences))
}

export function orderSessions(sessions: SessionSummaryDTO[], order: string[] | ReadonlyMap<string, number>): SessionSummaryDTO[] {
  const ranks = Array.isArray(order) ? new Map(order.map((path, index) => [path, index])) : order
  // Newly discovered sessions appear first; once moved, their position stays
  // put even when a background run changes the modification timestamp.
  return [...sessions].sort((a, b) => {
    const aRank = ranks.get(a.path), bRank = ranks.get(b.path)
    if (aRank !== undefined && bRank !== undefined) return aRank - bRank
    if (aRank !== undefined) return 1
    if (bRank !== undefined) return -1
    return b.modified.localeCompare(a.modified) || a.path.localeCompare(b.path)
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
  return { pinned: preferences.pinned.filter((path) => !paths.has(path)), order: preferences.order.filter((path) => !paths.has(path)) }
}
