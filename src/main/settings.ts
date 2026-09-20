import { app } from 'electron'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { BASH_DEFAULT_MAX_WAIT_MS, BASH_MIN_WAIT_MS, BASH_MAX_WAIT_MS, type StartupSessionMode } from '../shared/types'
import { ASK_USER_DEFAULT_TIMEOUT_S, clampAskUserTimeoutSeconds } from '../shared/ask-user'
import { RESPONSE_TIMEOUT_DEFAULT_S, clampResponseTimeoutSeconds } from '../shared/response-timeout'
import { DEFAULT_SANDBOX_MODE, isSandboxMode } from './sandbox/mode'
import type { SandboxMode } from './sandbox/types'

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
  /** What a boot opens: the session that was active at quit, or always a new
   * one. Persisted so the choice holds across launches. */
  startup: StartupSessionMode
  /** File of the session that was active at quit; the `resume` startup opens
   * it. Kept apart from `cwd` because the newest file on disk is not always
   * the session the user was in. */
  startupSession: string | null
  /** Extensions the user switched off in Settings. Identified by the
   * extension's resolved path so the preference survives a package update.
   * Kept app-local — the pi CLI's own package config is left untouched. */
  disabledExtensions: string[]
  /** Last window size/position plus its maximized/full-screen state; null until
   * the first window has ever been sized. */
  windowBounds: WindowBounds | null
  /** Subagent delegation enabled; the `agent` tool is registered at session
   * build and dispatch is re-checked live. */
  subagentsEnabled: boolean
  /** The parent model may continue a finished subagent session under a fresh
   * run (the `agent` tool's `continue_session_id` parameter). */
  subagentReuseEnabled: boolean
  /** Parent↔child steering: the `agent_steer` tool on parents, the
   * `message_parent` tool injected into child ceilings. */
  subagentCommsEnabled: boolean
  /** Max simultaneous subagent runs per parent session (starting + active). */
  subagentMaxConcurrent: number
  /** Seconds an unanswered ask_user_question panel waits before it closes
   * itself. Any real interaction cancels the countdown. */
  askUserTimeoutSeconds: number
  /** Seconds a model request may go unanswered before it is retried (app-local;
   * injected into sessions in memory, never written to the SDK's global
   * settings file). */
  responseTimeoutSeconds: number
  /** DSH file-sandbox mode for this app: which file effects the first-party
   * `bash`, `edit` and `write` may perform. Reads, network, MCP and extensions
   * are outside it, and there is no approval gate — the mode is the policy. */
  sandboxMode: SandboxMode
  /** The user consented to the embedded browser once; the service skips the
   * consent prompt from then on and connects to the shell's CDP endpoint. */
  browserConsent: boolean
  /** The model's browser_* tools are registered into sessions at build time. */
  browserAgentToolsEnabled: boolean
}

const defaults: AppSettings = {
  checkpointsEnabled: true,
  bashMaxWaitMs: BASH_DEFAULT_MAX_WAIT_MS,
  cwd: null,
  folders: [],
  contextFiles: true,
  startup: 'resume',
  startupSession: null,
  disabledExtensions: [],
  windowBounds: null,
  subagentsEnabled: true,
  subagentReuseEnabled: false,
  subagentCommsEnabled: false,
  subagentMaxConcurrent: 4,
  askUserTimeoutSeconds: ASK_USER_DEFAULT_TIMEOUT_S,
  responseTimeoutSeconds: RESPONSE_TIMEOUT_DEFAULT_S,
  sandboxMode: DEFAULT_SANDBOX_MODE,
  browserConsent: false,
  browserAgentToolsEnabled: false
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
    // Anything that is not the explicit "always new" choice resumes, including
    // settings written before this preference existed.
    const startup: StartupSessionMode = raw.startup === 'new' ? 'new' : 'resume'
    const startupSession = typeof raw.startupSession === 'string' ? raw.startupSession : null
    const concurrent = raw.subagentMaxConcurrent
    const subagentMaxConcurrent = Number.isInteger(concurrent) && concurrent >= 1 && concurrent <= 16 ? concurrent : 4
    const askUserTimeoutSeconds = clampAskUserTimeoutSeconds(
      typeof raw.askUserTimeoutSeconds === 'number' ? raw.askUserTimeoutSeconds : ASK_USER_DEFAULT_TIMEOUT_S
    )
    const responseTimeoutSeconds = clampResponseTimeoutSeconds(
      typeof raw.responseTimeoutSeconds === 'number' ? raw.responseTimeoutSeconds : RESPONSE_TIMEOUT_DEFAULT_S
    )
    return { ...defaults, ...raw, bashMaxWaitMs, startup, startupSession, subagentMaxConcurrent, askUserTimeoutSeconds,
      responseTimeoutSeconds,
      sandboxMode: isSandboxMode(raw.sandboxMode) ? raw.sandboxMode : DEFAULT_SANDBOX_MODE }
  } catch {
    return { ...defaults }
  }
}

export function saveSettings(settings: AppSettings): void {
  mkdirSync(app.getPath('userData'), { recursive: true })
  writeFileSync(settingsPath(), JSON.stringify(settings, null, 2), 'utf8')
}
