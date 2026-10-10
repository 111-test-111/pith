import { useSyncExternalStore } from 'react'
import type {
  McpConfigScope,
  McpServerDetailDTO,
  McpStateDTO,
  McpStatusPushDTO,
  McpUpsertServerPayload
} from '../../../shared/types'

/**
 * Settings → MCP store: one main-process read (`mcpState`) feeds the section,
 * writes return the fresh state. Optional native runtime observations ride
 * the sequence-free `pi:mcp-status` push, merged into the roster by name.
 */

export interface McpStoreState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  data: McpStateDTO | null
  error: string | null
  /** Key of the action currently running, e.g. `save:global` or `toggle:beui`. */
  busy: string | null
  actionError: string | null
}

let state: McpStoreState = { status: 'idle', data: null, error: null, busy: null, actionError: null }
let inflight: Promise<void> | null = null
let statusSubscription: (() => void) | null = null
let latestStatus: McpStatusPushDTO | null = null
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

function setState(next: Partial<McpStoreState>): void {
  state = { ...state, ...next }
  emit()
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sameRuntime(data: McpStateDTO, push: McpStatusPushDTO): boolean {
  return data.projectCwd === push.cwd && data.sessionPath === push.sessionPath
}

function sameServers(data: McpStateDTO, push: McpStatusPushDTO): boolean {
  const names = new Set(push.servers.map(server => server.name))
  return data.servers.length === names.size && data.servers.every(server => names.has(server.name))
}

/** Update connection facts without replacing editable config with runtime data. */
function withLiveStatus(data: McpStateDTO, push: McpStatusPushDTO): McpStateDTO {
  const live = new Map(push.servers.map((server) => [server.name, server]))
  let changed = false
  const servers = data.servers.map((server) => {
    const entry = live.get(server.name)
    if (!entry) return server
    if (server.status === entry.status && server.toolCount === entry.toolCount && server.disabled === entry.disabled) {
      return server
    }
    changed = true
    return { ...server, status: entry.status, toolCount: entry.toolCount, disabled: entry.disabled }
  })
  return changed ? { ...data, servers } : data
}

/** Read once; a newer push may supersede a snapshot still crossing IPC. */
async function readCurrentState(call: () => Promise<McpStateDTO>): Promise<McpStateDTO> {
  for (;;) {
    const before = latestStatus
    const data = await call()
    const push = latestStatus
    if (!push || push === before) return data
    if (sameRuntime(data, push) && sameServers(data, push)) return withLiveStatus(data, push)
    // Ownership or membership changed during the read. Refresh metadata,
    // never repeat a mutating call to obtain the selected session's roster.
    call = () => window.pi.mcpState()
  }
}

/** Complete native snapshots follow the selected session, including same-cwd switches. */
function applyLiveStatus(push: McpStatusPushDTO): void {
  latestStatus = push
  const data = state.data
  if (!data || !sameRuntime(data, push) || !sameServers(data, push)) {
    void refreshMcpState()
    return
  }
  const next = withLiveStatus(data, push)
  if (next === data) return
  detailCache.clear()
  setState({ data: next })
}

/** Reload from the main process; concurrent callers share one request. */
export function refreshMcpState(): Promise<void> {
  if (inflight) return inflight
  setState({ status: state.data ? state.status : 'loading', error: null })
  inflight = (async () => {
    try {
      const data = await readCurrentState(() => window.pi.mcpState())
      detailCache.clear()
      setState({ status: 'ready', data, error: null })
    } catch (error) {
      setState({ status: 'error', error: messageOf(error) })
    } finally {
      inflight = null
    }
  })()
  return inflight
}

/** Run one mutating action behind a busy flag; the fresh state comes back. */
async function runAction(key: string, call: () => Promise<McpStateDTO>): Promise<boolean> {
  setState({ busy: key, actionError: null })
  try {
    const data = await readCurrentState(call)
    detailCache.clear()
    setState({ status: 'ready', data, error: null, busy: null })
    return true
  } catch (error) {
    setState({ busy: null, actionError: messageOf(error) })
    return false
  }
}

/** Save a config file's raw text (JSON editor or a visual form upsert). */
export function writeMcpConfig(scope: McpConfigScope, content: string): Promise<boolean> {
  return runAction(`save:${scope}`, () => window.pi.mcpWriteConfig(scope, content))
}

/** Toggle one server's enabled state. */
export function setMcpServerDisabled(name: string, disabled: boolean): Promise<boolean> {
  return runAction(`toggle:${name}`, () => window.pi.mcpSetServerDisabled(name, disabled))
}

/** Save one server from the visual editor (upsert into its config file). */
export function upsertMcpServer(payload: McpUpsertServerPayload): Promise<boolean> {
  return runAction(`upsert:${payload.name}`, () => window.pi.mcpUpsertServer(payload))
}

/** Delete one server from its defining config file. */
export function deleteMcpServer(path: string, name: string): Promise<boolean> {
  return runAction(`delete:${name}`, () => window.pi.mcpDeleteServer(path, name))
}

/** Per-server detail cache, invalidated on every config or session refresh. */
const detailCache = new Map<string, McpServerDetailDTO>()

/** The cached detail for one server, or null when never fetched. */
export function peekMcpServerDetail(name: string): McpServerDetailDTO | null {
  return detailCache.get(name) ?? null
}

/** One server's currently registered tool metadata. */
export async function fetchMcpServerDetail(name: string): Promise<McpServerDetailDTO> {
  const owner = state.data?.sessionPath
  const detail = await window.pi.mcpServerDetail(name)
  if (owner === state.data?.sessionPath) detailCache.set(name, detail)
  return detail
}

export function clearMcpActionError(): void {
  setState({ actionError: null })
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  // Subscribe lazily while Settings → MCP is mounted.
  if (!statusSubscription) statusSubscription = window.pi.onMcpStatus(applyLiveStatus)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && statusSubscription) {
      statusSubscription()
      statusSubscription = null
    }
  }
}

function getSnapshot(): McpStoreState {
  return state
}

export function useMcpStore(): McpStoreState {
  return useSyncExternalStore(subscribe, getSnapshot)
}
