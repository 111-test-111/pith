import { app } from 'electron'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

export interface AppSettings {
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
}

const defaults: AppSettings = { cwd: null, folders: [], contextFiles: true, disabledExtensions: [] }

function settingsPath(): string {
  return join(app.getPath('userData'), 'app-settings.json')
}

export function loadSettings(): AppSettings {
  try {
    const raw = JSON.parse(readFileSync(settingsPath(), 'utf8'))
    return { ...defaults, ...raw }
  } catch {
    return { ...defaults }
  }
}

export function saveSettings(settings: AppSettings): void {
  mkdirSync(app.getPath('userData'), { recursive: true })
  writeFileSync(settingsPath(), JSON.stringify(settings, null, 2), 'utf8')
}
