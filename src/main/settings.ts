import { app } from 'electron'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { BASH_DEFAULT_MAX_WAIT_MS, BASH_MIN_WAIT_MS, BASH_MAX_WAIT_MS } from '../shared/types'

/** Persisted geometry of the main window. `width`/`height` are the window's
 * normal (restored) size, so maximizing or going full screen does not clobber
 * the size to restore back to. */
export interface WindowBounds {
  x?: number
  y?: number
  width: number
  height: number
  maximized: boolean
  fullscreen: boolean
}

export interface AppSettings {
  checkpointsEnabled: boolean
  /** Initial blocking ceiling; commands keep running after this wait expires. */
  bashMaxWaitMs: number
  /** Null means a projectless chat; its internal cwd is never a project. */
  cwd: string | null
  /** Folders opened through the app, most recent first. Sessions of every
   * folder stay visible in the sidebar; `cwd` is the active one. */
  folders: string[]
  /** Inject AGENTS.md / CLAUDE.md context files into the system prompt
   * (global agent dir + ancestor directories). Default true. */
  contextFiles: boolean
  /** Extensions the user switched off in Settings. Identified by the
   * extension's resolved path so the preference survives a package update.
   * Kept app-local — the pi CLI's own package config is left untouched. */
  disabledExtensions: string[]
  /** Last window size/position plus its maximized/full-screen state; null until
   * the first window has ever been sized. */
  windowBounds: WindowBounds | null
}

const defaults: AppSettings = {
  checkpointsEnabled: true,
  bashMaxWaitMs: BASH_DEFAULT_MAX_WAIT_MS,
  cwd: null,
  folders: [],
  contextFiles: true,
  disabledExtensions: [],
  windowBounds: null
}

function settingsPath(): string {
  return join(app.getPath('userData'), 'app-settings.json')
}

export function loadSettings(): AppSettings {
  try {
    const raw = JSON.parse(readFileSync(settingsPath(), 'utf8'))
    const wait = raw.bashMaxWaitMs
    const bashMaxWaitMs = Number.isInteger(wait) && wait >= BASH_MIN_WAIT_MS && wait <= BASH_MAX_WAIT_MS
      ? wait : BASH_DEFAULT_MAX_WAIT_MS
    return { ...defaults, ...raw, bashMaxWaitMs }
  } catch {
    return { ...defaults }
  }
}

export function saveSettings(settings: AppSettings): void {
  mkdirSync(app.getPath('userData'), { recursive: true })
  writeFileSync(settingsPath(), JSON.stringify(settings, null, 2), 'utf8')
}
