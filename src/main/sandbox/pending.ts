/**
 * In-memory DSH-style one-shot approval channel for sandbox escalation.
 *
 * Nothing here is persisted: an escalation is a question about one call, and a
 * question that lost its answerer (a closed app, a deleted session, an aborted
 * turn) must settle as cancelled rather than linger.
 */
import { randomUUID } from 'node:crypto'
import type { SandboxEscalationDecision, SandboxEscalationOperationDTO, SandboxEscalationRequestDTO, SandboxMode } from '../../shared/types'

export type EscalationOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

export interface WaitForEscalationInput {
  sessionId: string
  sessionPath: string
  toolCallId: string
  toolName: string
  currentMode: SandboxMode
  requestedMode: SandboxMode
  operation: SandboxEscalationOperationDTO
  justification: string
  signal?: AbortSignal
}

interface RegistryEntry {
  request: SandboxEscalationRequestDTO
  settle: (outcome: EscalationOutcome) => void
}

const registry = new Map<string, RegistryEntry>()

/** Pending questions for one session, oldest first. */
export function listPendingEscalations(sessionPath: string): SandboxEscalationRequestDTO[] {
  return [...registry.values()]
    .filter((entry) => entry.request.sessionPath === sessionPath)
    .sort((a, b) => a.request.createdAt - b.request.createdAt)
    .map((entry) => entry.request)
}

export function hasPendingEscalations(sessionPath: string): boolean {
  return listPendingEscalations(sessionPath).length > 0
}

/**
 * Ask the user. `onChanged` fires whenever the pending set changes, so the
 * caller can publish a fresh list; a missing answerer fails closed because the
 * promise only ever settles through an explicit answer, an abort or a clear.
 */
export function waitForEscalation(
  input: WaitForEscalationInput,
  onChanged: () => void
): Promise<EscalationOutcome> {
  if (input.signal?.aborted) return Promise.resolve('cancelled')
  return new Promise((resolve) => {
    const requestId = randomUUID()
    const request: SandboxEscalationRequestDTO = {
      requestId,
      sessionId: input.sessionId,
      sessionPath: input.sessionPath,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      currentMode: input.currentMode,
      requestedMode: input.requestedMode,
      operation: structuredClone(input.operation),
      justification: input.justification,
      createdAt: Date.now()
    }

    const settle = (outcome: EscalationOutcome) => {
      const entry = registry.get(requestId)
      if (entry?.request !== request) return
      registry.delete(requestId)
      input.signal?.removeEventListener('abort', onAbort)
      onChanged()
      resolve(outcome)
    }
    const onAbort = () => settle('cancelled')

    registry.set(requestId, { request, settle })
    input.signal?.addEventListener('abort', onAbort, { once: true })
    onChanged()
  })
}

/**
 * Answer one question. The session is part of the check: an id alone must never
 * be enough to settle another session's request.
 */
export function respondToEscalation(
  requestId: string,
  sessionPath: string,
  decision: SandboxEscalationDecision
): boolean {
  const entry = registry.get(requestId)
  if (!entry || entry.request.sessionPath !== sessionPath) return false
  entry.settle(decision === 'approve' ? 'allowed-once' : 'rejected')
  return true
}

/** Settle every question a session still has open (stop, delete, dispose). */
export function clearSessionEscalations(sessionPath: string): void {
  for (const entry of [...registry.values()]) {
    if (entry.request.sessionPath !== sessionPath) continue
    entry.settle('cancelled')
  }
}
