/**
 * App-owned `edit` and `write`, replacing the SDK built-ins so every file
 * mutation passes the DSH sandbox policy on its way to disk.
 *
 * Ported from pi-web's `lib/sandbox/file-tools-extension.ts`. On a denial the
 * model is told the escalation exists and how to ask; the answer comes from the
 * user through the approval channel, and it is valid for exactly one call.
 *
 * Reads are deliberately unrestricted, exactly as in DSH: only mutation
 * targets are checked, and they are checked immediately before each side
 * effect (never once per tool call), so a symlink swapped in between two
 * writes cannot slip through.
 */
import {
  createEditToolDefinition,
  createWriteToolDefinition,
  type EditOperations,
  type ToolDefinition,
  type WriteOperations
} from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { constants } from 'node:fs'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { buildSandboxPolicy, writableRoots } from '../sandbox/policy'
import { isSandboxPathWithin, resolveSandboxPath } from '../sandbox/paths'
import { escalationHintMarker, PLAN_ESCALATION_REFUSED, planFileDenialMarker, SANDBOX_ESCALATION_PROPERTIES, sandboxDenialMarker } from '../sandbox/escalation'
import { SandboxFileDeniedError, type SandboxMode } from '../sandbox/types'
import type { SandboxEscalationOperationDTO } from '../../shared/types'

export const APP_FILE_TOOL_NAMES = ['edit', 'write'] as const

/** Take the SDK's own definition types: they bind the parameter schema. */
type EditToolDefinition = ReturnType<typeof createEditToolDefinition>
type WriteToolDefinition = ReturnType<typeof createWriteToolDefinition>

export interface SandboxFileToolOptions {
  cwd: string
  getMode: () => SandboxMode
  /**
   * Live Plan-mode read: a denial is a Plan outcome, not a wider-mode request,
   * so the hint must not offer escalation. Read per call, like the mode itself.
   */
  isPlanRestricted?: () => boolean
  /**
   * Ask for a strictly wider mode for this one call. Omitted means this app has
   * no approval channel: the call then runs under the session's mode and a
   * denial is final.
   */
  escalate?: (input: {
    toolCallId: string
    toolName: 'edit' | 'write'
    operation: SandboxEscalationOperationDTO
    sandboxPermissions: unknown
    justification: unknown
    signal?: AbortSignal
  }) => Promise<SandboxMode>
}

/** Flat object schema: `Type.Intersect` serializes as allOf, which some model
 * adapters discard, leaving the tool looking parameterless. */
type EscalationInput = Record<string, unknown> & { sandbox_permissions?: unknown; justification?: unknown }

function denial(mode: SandboxMode, path: string): SandboxFileDeniedError {
  return new SandboxFileDeniedError(mode, path)
}

/**
 * Resolve a mutation target against the policy. Returns the canonical path the
 * write must use, so the bytes land where the check looked.
 */
function writablePath(path: string, cwd: string, mode: SandboxMode): string {
  if (mode === 'danger-full-access') return path
  // read-only denies mutation outright: DSH's read-only is a filesystem
  // effect, not a read-only workspace.
  if (mode === 'read-only') throw denial(mode, path)

  const canonical = resolveSandboxPath(path, { cwd, homeDir: homedir() })
  if (canonical === null) throw denial(mode, path)
  const roots = writableRoots(buildSandboxPolicy(mode, cwd))
  if (!roots.some((root) => isSandboxPathWithin(canonical, root))) throw denial(mode, path)
  return canonical
}

/**
 * The same check for an app-owned tool that writes its own bytes.
 *
 * `edit`/`write` pass these operations into the SDK; a tool that produces files
 * itself (for example `image`) must resolve every target here first, so it
 * honours the session's file policy instead of being a way around it. Returns
 * the canonical path the write must use, and raises the same hinted denial.
 */
export function writableTarget(path: string, cwd: string, mode: SandboxMode): string {
  try {
    return writablePath(path, cwd, mode)
  } catch (error) {
    withHint(error, mode)
  }
}

function editOperations(cwd: string, mode: SandboxMode): EditOperations {
  return {
    // The before-image is a read; it stays unrestricted.
    readFile: (path) => readFile(path),
    access: async (path) => {
      await access(writablePath(path, cwd, mode), constants.R_OK | constants.W_OK)
    },
    writeFile: async (path, content) => {
      await writeFile(writablePath(path, cwd, mode), content, 'utf8')
    }
  }
}

function writeOperations(cwd: string, mode: SandboxMode): WriteOperations {
  return {
    mkdir: async (path) => {
      await mkdir(writablePath(path, cwd, mode), { recursive: true })
    },
    writeFile: async (path, content) => {
      await writeFile(writablePath(path, cwd, mode), content, 'utf8')
    }
  }
}

/**
 * A sandbox denial must read as a policy outcome with a way forward, not as a
 * bare path error the model simply retries. Ordinary mode is unchanged; Plan's
 * denial is raised in `execute` BEFORE the SDK's own edit/write wrapper (which
 * collapses the operations error into a plain message) can swallow the reason.
 */
function withHint(error: unknown, mode: SandboxMode): never {
  if (error instanceof SandboxFileDeniedError) {
    throw new Error(`${sandboxDenialMarker(mode)}\n${error.message}\n${escalationHintMarker('operation')}`)
  }
  throw error
}

/**
 * Plan's file-effect refusal. Raised without touching the filesystem or asking
 * the approval channel, so an edit/write reference held from before Plan (or a
 * call whose schema carries escalation parameters) cannot mutate anything.
 */
function planFileDenied(input: EscalationInput): never {
  if (input.sandbox_permissions !== undefined || input.justification !== undefined) {
    throw new Error(PLAN_ESCALATION_REFUSED)
  }
  throw new Error(`${sandboxDenialMarker('read-only')}\n${planFileDenialMarker('operation')}`)
}

export function createSandboxFileTools(options: SandboxFileToolOptions): ToolDefinition<any, any, any>[] {
  const { cwd, getMode, escalate } = options
  const inPlan = () => options.isPlanRestricted?.() === true

  /** One answer per call: the approval is for this call, not for the session. */
  const modeForCall = async (
    toolName: 'edit' | 'write',
    toolCallId: string,
    input: EscalationInput,
    signal?: AbortSignal
  ): Promise<SandboxMode> => {
    if (!escalate) return getMode()
    return escalate({
      toolCallId,
      toolName,
      operation: { cwd, parameters: input },
      sandboxPermissions: input.sandbox_permissions,
      justification: input.justification,
      ...(signal ? { signal } : {})
    })
  }

  const editBase = createEditToolDefinition(cwd)
  // SAFETY: every field but `description`/`parameters`/`execute` is spread from
  // the SDK's own definition, so the runtime shape is the SDK's. The schema
  // cannot be expressed in `ToolDefinition` because it is *widened* with the
  // escalation properties, and the SDK's parameter schema is invariant.
  const edit = {
    ...editBase,
    description: `${editBase.description} If a file-effect denial says escalation is available, retry that exact operation once with sandbox_permissions and justification.`,
    parameters: Type.Object({ ...editBase.parameters.properties, ...SANDBOX_ESCALATION_PROPERTIES }),
    executionMode: 'sequential' as const,
    async execute(toolCallId: string, params: unknown, signal?: AbortSignal, onUpdate?: unknown, context?: unknown) {
      const input = params as EscalationInput
      if (inPlan()) planFileDenied(input)
      const mode = await modeForCall('edit', toolCallId, input, signal)
      try {
        return await createEditToolDefinition(cwd, { operations: editOperations(cwd, mode) }).execute(
          toolCallId,
          params as never,
          signal,
          onUpdate as never,
          context as never
        )
      } catch (error) {
        withHint(error, mode)
      }
    }
  } as unknown as EditToolDefinition

  const writeBase = createWriteToolDefinition(cwd)
  // SAFETY: as for `edit` above — the base is the SDK's own write definition
  // and only the schema is widened, so the assertion cannot hide a shape drift.
  const write = {
    ...writeBase,
    description: `${writeBase.description} If a file-effect denial says escalation is available, retry that exact operation once with sandbox_permissions and justification.`,
    parameters: Type.Object({ ...writeBase.parameters.properties, ...SANDBOX_ESCALATION_PROPERTIES }),
    executionMode: 'sequential' as const,
    async execute(toolCallId: string, params: unknown, signal?: AbortSignal, onUpdate?: unknown, context?: unknown) {
      const input = params as EscalationInput
      if (inPlan()) planFileDenied(input)
      const mode = await modeForCall('write', toolCallId, input, signal)
      try {
        return await createWriteToolDefinition(cwd, { operations: writeOperations(cwd, mode) }).execute(
          toolCallId,
          params as never,
          signal,
          onUpdate as never,
          context as never
        )
      } catch (error) {
        withHint(error, mode)
      }
    }
  } as unknown as WriteToolDefinition

  return [edit, write]
}
