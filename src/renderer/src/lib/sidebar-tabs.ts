export const SIDEBAR_TAB_KINDS = ['review', 'context', 'terminal', 'browser', 'files', 'chat', 'debug', 'trajectory', 'git'] as const
export type SidebarTabKind = typeof SIDEBAR_TAB_KINDS[number]
export type SidebarTabId = SidebarTabKind | `file:${string}` | `agent:${string}` | `scheduled:${string}`

export const fileTabId = (path: string): SidebarTabId => `file:${path}`
export const filePathForTab = (id: SidebarTabId | null): string | null => id?.startsWith('file:') ? id.slice(5) : null
export const agentTabId = (path: string): SidebarTabId => `agent:${path}`
export const agentPathForTab = (id: SidebarTabId | null): string | null => id?.startsWith('agent:') ? id.slice(6) : null
export const scheduledTabId = (path: string): SidebarTabId => `scheduled:${path}`
export const scheduledPathForTab = (id: SidebarTabId | null): string | null => id?.startsWith('scheduled:') ? id.slice(10) : null
