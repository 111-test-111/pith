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

  if (!WIDER_MODES[runtime.currentMode].includes(parsed.requestedMode)) {
    throw new Error(
      `sandbox escalation to "${parsed.requestedMode}" is not strictly wider than this call's current "${runtime.currentMode}" mode`
    )
  }

  const outcome = await waitForEscalation(
    {
      sessionId: runtime.sessionId,
      sessionPath: runtime.sessionPath,
      toolCallId: runtime.toolCallId,
      toolName: runtime.toolName,
      currentMode: runtime.currentMode,
      requestedMode: parsed.requestedMode,
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
