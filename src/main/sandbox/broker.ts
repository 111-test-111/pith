/**
 * The seam between the sandbox policy and pi-app's process ownership.
 *
 * DSH's own broker owns the child processes; pi-app already has exactly one
 * owner for managed bash (`main/bash/manager.ts`, with its bounded tails, task
 * records and process-tree kills). A second registry here would be a second
 * source of truth for the same lifetimes, so this module supplies only what
 * the owner cannot know: the confined argv, the scrubbed environment, and how
 * to read a runner's exit.
 */
import { localSandboxProvider } from './local'
import { buildSandboxPolicy } from './policy'
import type {
  ConfinedArgv,
  RunnerFailureRule,
  SandboxMode,
  SandboxPolicy,
  SandboxStatus
} from './types'

const SENSITIVE_ENV_PATTERN = /KEY|PASSWORD|SECRET|TOKEN/i

/**
 * The environment a confined command actually needs. Ambient credentials go:
 * a sandboxed shell is still a shell that the model wrote, and the file policy
 * says nothing about what it may read over the network.
 */
export function scrubbedParentEnv(
  ambient: NodeJS.ProcessEnv = process.env,
  explicit?: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  const env: Record<string, string | undefined> = {}
  for (const [name, value] of Object.entries(ambient)) {
    if (value === undefined) continue
    if (SENSITIVE_ENV_PATTERN.test(name)) continue
    if (name.toUpperCase().startsWith('DSH_')) continue
    env[name] = value
  }
  return { ...env, ...explicit } as NodeJS.ProcessEnv
}

export function sandboxPolicyFor(mode: SandboxMode, workspaceRoot: string): SandboxPolicy {
  return buildSandboxPolicy(mode, workspaceRoot)
}

/**
 * Wrap a shell invocation for the given policy. `danger-full-access` returns
 * the argv unchanged, which is what makes that mode the "host" path.
 */
export function confineShellArgv(
  argv: readonly string[],
  policy: SandboxPolicy
): ConfinedArgv | null {
  if (policy.mode === 'danger-full-access') return null
  return localSandboxProvider().confine(argv, policy)
}

/** Runner failures are not policy denials and must never read as command output. */
export function runnerFailureMessage(
  exitCode: number | null,
  stderr: string,
  rules: readonly RunnerFailureRule[]
): string | null {
  if (exitCode === 0 || exitCode === null) return null
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  for (const rule of rules) {
    if (rule.allowedExitCodes && !rule.allowedExitCodes.includes(exitCode)) continue
    const informational = (rule.informationalLines ?? []).map((line) => line.toLowerCase())
    for (const line of lines) {
      if (informational.includes(line.toLowerCase())) continue
      if (rule.fatalSignatures.some((signature) => line.toLowerCase().includes(signature.toLowerCase()))) {
        return line
      }
    }
  }
  return null
}

/**
 * Did the runner refuse the command? A denial is a policy outcome the user can
 * act on by changing the mode; a runner failure is an environment problem.
 */
export function sandboxDenied(
  exitCode: number | null,
  stderr: string,
  confined: Pick<ConfinedArgv, 'denialSignatures'>
): boolean {
  if (exitCode === 0 || exitCode === null) return false
  const haystack = stderr.toLowerCase()
  return confined.denialSignatures.some((signature) => haystack.includes(signature.toLowerCase()))
}

/** Capability readout: what the current mode will actually do on this host. */
export function sandboxStatus(mode: SandboxMode): SandboxStatus {
  if (mode === 'danger-full-access') {
    return {
      enabled: false,
      mode,
      backend: null,
      enforcement: null,
      support: 'host',
      reason: null,
      unsandboxed: true
    }
  }
  const selected = localSandboxProvider().selection()
  return {
    enabled: selected !== null,
    mode,
    backend: selected?.backend ?? null,
    enforcement: selected?.enforcement ?? null,
    support: selected === null ? 'dependencies-missing' : selected.enforcement === 'partial' ? 'partial' : 'ready',
    reason: selected === null ? 'No DSH sandbox runner is usable on this host' : null,
    unsandboxed: false
  }
}
