import { useSyncExternalStore } from 'react'
import type { ToolCatalogDTO } from '../../../shared/types'

/**
 * Shared tools + extensions catalog behind Settings → Tools and
 * Settings → Extensions. One main-process read feeds both tabs, so toggling an
 * extension in one tab immediately re-marks its tools in the other.
 *
 * The catalog is only valid for the workspace that was active when it loaded,
 * so each Settings open refreshes it (the two sections mount together and the
 * in-flight guard collapses their requests into one).
 */

export interface CatalogState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  data: ToolCatalogDTO
  error: string | null
  /** Key of the package action currently running, e.g. `update:npm:…`. */
  busy: string | null
  /** Failure of the last package action (update/remove/install). */
  actionError: string | null
}

const EMPTY: ToolCatalogDTO = {
  tools: [],
  extensions: [],
  skills: [],
  skillDiagnostics: []
}

let state: CatalogState = {
  status: 'idle',
  data: EMPTY,
  error: null,
  busy: null,
  actionError: null
}
let inflight: Promise<void> | null = null
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

function setState(next: Partial<CatalogState>): void {
  state = { ...state, ...next }
  emit()
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Reload from the main process; concurrent callers share one request. */
export function refreshCatalog(): Promise<void> {
  if (inflight) return inflight
  setState({ status: 'loading', error: null })
  inflight = (async () => {
    try {
      setState({ status: 'ready', data: await window.pi.toolsCatalog(), error: null })
    } catch (error) {
      setState({ status: 'error', error: messageOf(error), data: EMPTY })
    } finally {
      inflight = null
    }
  })()
  return inflight
}

/** Persist one extension's enabled state; the main process returns the fresh catalog. */
export async function setExtensionEnabled(id: string, enabled: boolean): Promise<void> {
  try {
    const data = await window.pi.setExtensionEnabled(id, enabled)
    setState({ status: 'ready', data, error: null })
  } catch (error) {
    setState({ status: 'error', error: messageOf(error) })
  }
}

/** Run a package action (update/remove/install) behind a busy flag. */
async function runAction(
  key: string,
  call: () => Promise<ToolCatalogDTO>
): Promise<boolean> {
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

export function updateExtension(source: string): Promise<boolean> {
  return runAction(`update:${source}`, () => window.pi.updateExtension(source))
}

export function removeExtension(source: string): Promise<boolean> {
  return runAction(`remove:${source}`, () => window.pi.removeExtension(source))
}

export function installExtension(source: string): Promise<boolean> {
  return runAction(`install:${source}`, () => window.pi.installExtension(source))
}

/** Toggle a skill's model-invocation flag; the main process returns the fresh catalog. */
export function setSkillModelInvocation(
  filePath: string,
  disableModelInvocation: boolean
): Promise<boolean> {
  return runAction(`skill:${filePath}`, () =>
    window.pi.setSkillModelInvocation(filePath, disableModelInvocation)
  )
}

export function clearActionError(): void {
  setState({ actionError: null })
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function getSnapshot(): CatalogState {
  return state
}

export function useToolCatalog(): CatalogState {
  return useSyncExternalStore(subscribe, getSnapshot)
}
