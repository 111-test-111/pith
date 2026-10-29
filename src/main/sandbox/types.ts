/**
 * DSH (DeepSeek Harness) local file-sandbox vocabulary, ported from pi-web.
 *
 * The boundary is deliberately narrow: it governs the file effects of the
 * first-party `bash`, `edit` and `write` tools only. Reads, network access,
 * MCP tools and extensions are outside it — there is no VM or container, and
 * no part of the app or the SDK runs isolated.
 */

import type { SandboxMode } from '../../shared/types'

/** The three DSH modes. `danger-full-access` bypasses the sandbox entirely. */
export type { SandboxMode }
export type ConfinedSandboxMode = Exclude<SandboxMode, 'danger-full-access'>
export type SandboxEnforcement = 'full' | 'partial'
export type SandboxBackend = 'bubblewrap' | 'landlock' | 'seatbelt' | 'windows-acl'

/** What the confined runner is asked to permit. */
export interface SandboxPolicy {
  mode: SandboxMode
  workspaceRoot: string
}

/**
 * How to tell "the runner refused this command" from "the runner itself
 * failed". A runner failure must never be reported as a policy denial, and
 * neither may be mistaken for the command's own output.
 */
export interface RunnerFailureRule {
  allowedExitCodes?: readonly number[]
  fatalSignatures: readonly string[]
  informationalLines?: readonly string[]
}

/** A command line already wrapped by the platform runner. */
export interface ConfinedArgv {
  argv: string[]
  backend: SandboxBackend
  enforcement: SandboxEnforcement
  denialSignatures: readonly string[]
  runnerFailureRules: readonly RunnerFailureRule[]
}

export interface SandboxStatus {
  /** True when a confined runner is selected for the current mode. */
  enabled: boolean
  mode: SandboxMode
  backend: SandboxBackend | null
  enforcement: SandboxEnforcement | null
  support: 'ready' | 'partial' | 'dependencies-missing' | 'host'
  reason: string | null
  /** True only for `danger-full-access`: the command runs on the host. */
  unsandboxed: boolean
}

/** Injectable realpath primitive, so the resolver is testable without a disk. */
export interface SandboxPathDependencies {
  realpath(candidate: string): string | undefined
}

/**
 * Thrown when a confined mode is requested but no runner is usable, or when
 * the runner fails. Both are fail-closed: the command is never retried on the
 * host.
 */
export class SandboxUnavailableError extends Error {
  readonly code = 'SANDBOX_UNAVAILABLE'

  constructor(mode: ConfinedSandboxMode, detail?: string) {
    super(
      `sandbox mode "${mode}" is requested but no sandbox backend is usable on this host; refusing to run the command unconfined.` +
        (detail ? ` Runner failure: ${detail}` : '')
    )
    this.name = 'SandboxUnavailableError'
  }
}

/** Thrown by the file-tool operations when a mutation target is outside the policy. */
export class SandboxFileDeniedError extends Error {
  readonly code = 'SANDBOX_FILE_DENIED'

  constructor(mode: SandboxMode, path: string) {
    super(`sandbox denied this file mutation under "${mode}": ${path}`)
    this.name = 'SandboxFileDeniedError'
  }
}
