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
 * writes return the fresh state, and the adapter's live status snapshots ride
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

/** Merge a live adapter snapshot into the roster rows it names. */
function applyLiveStatus(push: McpStatusPushDTO): void {
  const data = state.data
  if (!data || data.projectCwd !== push.cwd) return
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
  if (changed) setState({ data: { ...data, servers } })
}

/** Reload from the main process; concurrent callers share one request. */
export function refreshMcpState(): Promise<void> {
  if (inflight) return inflight
  setState({ status: state.data ? state.status : 'loading', error: null })
  inflight = (async () => {
    try {
      const data = await window.pi.mcpState()
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
    const data = await call()
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

/** One server's cached tool/resource/prompt metadata, on demand (not stored). */
export function fetchMcpServerDetail(name: string): Promise<McpServerDetailDTO> {
  return window.pi.mcpServerDetail(name)
}

export function clearMcpActionError(): void {
  setState({ actionError: null })
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  // The live-status push is only worth its IPC traffic while the section is
  // mounted; subscribe lazily on first use and drop with the last listener.
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
