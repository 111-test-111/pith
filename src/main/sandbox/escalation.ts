/**
 * One-shot escalation: a strictly wider mode for exactly one tool call, after
 * the user says yes to that call.
 *
 * Ported from pi-web's `lib/permissions/escalation.ts`. The mode an escalated
 * call runs under is computed per call and never written to the session — the
 * session's own mode is unchanged, which is what makes it "once".
 */
import { waitForEscalation } from './pending'
import { isSandboxMode, type SandboxMode } from './mode'
import { Type } from 'typebox'
import type { SandboxEscalationOperationDTO } from '../../shared/types'

/** A call may only ever ask to move wider, never narrower or sideways. */
const WIDER_MODES: Readonly<Record<SandboxMode, readonly SandboxMode[]>> = {
  'read-only': ['workspace-write', 'danger-full-access'],
  'workspace-write': ['danger-full-access'],
  'danger-full-access': []
}

export function sandboxDenialMarker(mode: SandboxMode): string {
  return `[sandbox: file access denied under ${mode} mode]`
}

export function escalationHintMarker(subject: 'command' | 'operation'): string {
  return `[sandbox: escalation available — retry this exact ${subject} once with sandbox_permissions (the narrowest wider mode that suffices) + justification; the approval prompt asks the user]`
}

/**
 * Plan-mode wording for a file-effect denial. It must NOT read as an invitation
 * to escalate or to change a setting: Plan mode deliberately has no elevation
 * path, and the model's only correct moves are to keep investigating read-only
 * or to leave implementation to the user's next turn.
 */
export function planFileDenialMarker(subject: 'command' | 'operation'): string {
  return `[plan: ${subject === 'command' ? 'shell commands' : 'file changes'} are read-only while Plan mode is active; escalate requests are refused without asking the user]`
}

/** A held/re-activated bash or file call in Plan: rejected before any approval. */
export const PLAN_ESCALATION_REFUSED =
  '[plan: elevated file access is unavailable] sandbox_permissions and justification are refused in Plan mode without asking the user. Keep investigating read-only, or leave Plan mode before implementing.'

/** Plan shell with no full-enforcement DSH runner: refuse, never fall back to the host. */
export const PLAN_SHELL_UNAVAILABLE =
  '[plan: no full-enforcement read-only shell] Plan mode cannot run shell commands on this host, and it never falls back to unconfined execution. File investigation and plan authoring still work.'

/**
 * Flat object schema: `Type.Intersect` serializes as allOf, which some model
 * adapters discard, leaving the tool looking parameterless.
 */
export const SANDBOX_ESCALATION_PROPERTIES = {
  sandbox_permissions: Type.Optional(
    Type.Union([Type.Literal('workspace-write'), Type.Literal('danger-full-access')], {
      description: 'Strictly wider sandbox mode for this call only; requires user approval.'
    })
  ),
  justification: Type.Optional(Type.String({ description: 'Why this one call needs wider file access.' }))
}

export interface EscalationRuntime {
  sessionId: string
  sessionPath: string
  toolCallId: string
  toolName: string
  currentMode: SandboxMode
  operation: SandboxEscalationOperationDTO
  sandboxPermissions?: unknown
  justification?: unknown
  signal?: AbortSignal
  onChanged: () => void
}

/**
 * Validate the arguments and route the question.
 *
 * Absent arguments mean "no escalation requested" — an ordinary call. Present
 * ones are validated strictly, so a malformed request fails loudly instead of
 * silently running under the narrower mode.
 */
export async function resolveEscalatedMode(runtime: EscalationRuntime): Promise<SandboxMode> {
  const parsed = validateEscalationArgs(runtime.sandboxPermissions, runtime.justification)
  if (parsed.requestedMode === undefined || parsed.justification === undefined) return runtime.currentMode

  // Asking for what the call ALREADY has (the same mode or a narrower one) is
  // not an escalation: the current mode satisfies the request by definition,
  // so there is nothing to approve — and at the ceiling ('danger-full-access')
  // nothing wider exists to approve anyway. Erroring here wedged every tool
  // whose guidance says "retry once with sandbox_permissions" against a
  // session that was already unrestricted.
  if (!WIDER_MODES[runtime.currentMode].includes(parsed.requestedMode)) {
    return runtime.currentMode
  }

  const outcome = await waitForEscalation(
    {
      sessionId: runtime.sessionId,
      sessionPath: runtime.sessionPath,
      toolCallId: runtime.toolCallId,
      toolName: runtime.toolName,
      currentMode: runtime.currentMode,
      requestedMode: parsed.requestedMode,
      operation: runtime.operation,
      justification: parsed.justification,
      ...(runtime.signal ? { signal: runtime.signal } : {})
    },
    runtime.onChanged
  )

  if (outcome === 'allowed-once') return parsed.requestedMode
  if (outcome === 'rejected') {
    throw new Error(`the user rejected escalating this operation to "${parsed.requestedMode}"`)
  }
  throw new Error(`approval for escalating to "${parsed.requestedMode}" was cancelled`)
}

export function validateEscalationArgs(
  sandboxPermissions: unknown,
  justification: unknown
): { requestedMode?: SandboxMode; justification?: string } {
  if (sandboxPermissions === undefined && justification === undefined) return {}
  if (sandboxPermissions === undefined) {
    throw new Error('invalid escalation: justification is only valid together with sandbox_permissions')
  }
  if (justification === undefined) {
    throw new Error('invalid escalation: sandbox_permissions requires a justification')
  }
  if (!isSandboxMode(sandboxPermissions) || sandboxPermissions === 'read-only') {
    throw new Error('invalid sandbox_permissions: expected "workspace-write" or "danger-full-access"')
  }
  if (typeof justification !== 'string' || justification.trim().length === 0) {
    throw new Error('invalid justification: expected a non-empty sentence')
  }
  return { requestedMode: sandboxPermissions, justification: justification.trim() }
}
