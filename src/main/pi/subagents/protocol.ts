import type { SessionEntry } from '@earendil-works/pi-coding-agent'
import type { SubagentMessageDetails, SubagentRunDTO, SubagentRunStatus, SubagentWrittenFileDTO } from '../../../shared/types'
import { validGoalBillingOwner, type GoalBillingOwner } from '../../../shared/goal.ts'

/** Persistence + wire protocol for subagent runs. Shared by runtime, manager
 * and the disk reader below; deliberately free of Electron imports so the
 * record shapes can be unit-checked without an app instance. */

/** Child-session custom entry announcing a run start. One per run: a resume
 * appends another one with a fresh runId, which is what makes an in-flight
 * (or interrupted) resume distinguishable from its previous terminal state. */
export const SUBAGENT_RUN_TYPE = 'pith_subagent_run'
/** Child-session custom entry with a run's terminal record, keyed by runId. */
export const SUBAGENT_RESULT_TYPE = 'pith_subagent_result'
/** Owned parent-branch evidence of dispatch, including each explicit resume. */
export const SUBAGENT_DISPATCH_TYPE = 'pith_subagent_dispatch'
/** Custom message type the parent receives when a background run completes. */
export const SUBAGENT_COMPLETION_TYPE = 'subagent_completion'
/** Custom message type the parent receives when a running child sends it a
 * message through the `message_parent` tool (subagent communications). */
export const SUBAGENT_MESSAGE_TYPE = 'subagent_message'

export const SUBAGENT_TOOL_NAME = 'agent'
/** Parent-side steering tool (Settings → Subagents → communications). */
export const AGENT_STEER_TOOL_NAME = 'agent_steer'
/** Child-side tool that sends a message up to the parent session. Injected
 * into every child ceiling while subagent communications are enabled, so it
 * is available regardless of the profile's own tool list — it is a
 * communication primitive, not a capability over the workspace. */
export const MESSAGE_PARENT_TOOL_NAME = 'message_parent'
/** Tools a subagent session must never see, regardless of its profile:
 * delegation recursion and the parent-only steering tool. */
export const SUBAGENT_EXCLUDED_TOOLS = [SUBAGENT_TOOL_NAME, AGENT_STEER_TOOL_NAME, 'submit_plan'] as const

/** Data persisted with a `pith_subagent_run` entry. */
export interface SubagentRunStartData {
  version: 1
  parentDispatch?: true
  runId: string
  parentSessionId: string
  parentSessionPath: string
  parentToolCallId: string
  profile: string
  description: string
  task: string
  runInBackground: boolean
  createdAt: string
  goalOwner?: GoalBillingOwner
  /** Frozen dispatch-time resource snapshot; also the restore contract when
   * the child session is reopened later. */
  resource: {
    tools: string[]
    planRestricted?: true
    /** True when the frozen ceiling names at least one tool the parent
     * attributes to an extension: the child then loads extensions so those
     * tools can register (the create allowlist admits them by name). Absent
     * on pure built-in/app ceilings, which stay extension-free — an
     * explore/review delegation must not multiply MCP hosts. Persisted with
     * the run so a reopened child restores the same loader decision. */
    extensions?: true
    model?: string
    thinkingLevel?: string
    maxTurns?: number
    inheritContext: boolean
    appendSystemPrompt?: string
  }
}

/** Data persisted with a `pith_subagent_result` entry. */
export interface SubagentRunResultData {
  version: 1
  runId: string
  status: SubagentRunStatus
  completedAt: string
  result?: string
  error?: string
  /** The runtime itself ended the run at its dispatched turn limit. */
  limitReached?: true
  writtenFiles?: SubagentWrittenFileDTO[]
  writtenFilesScope?: 'run'
}

/** Details carried by a `subagent_message` custom message live in
 * shared/types.ts (the renderer's quiet tool row reads the same fields the
 * model-facing prose in the message content carries). */
export type { SubagentMessageDetails }

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}
const asString = (value: unknown): string | undefined => (typeof value === 'string' && value.length > 0 ? value : undefined)
const asBoolean = (value: unknown): boolean | undefined => (typeof value === 'boolean' ? value : undefined)
const asNumber = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)
const asStringArray = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.every((item) => typeof item === 'string') ? value as string[] : undefined

function parseStart(data: unknown): SubagentRunStartData | null {
  const record = asRecord(data)
  if (!record || record.version !== 1) return null
  const runId = asString(record.runId)
  const parentSessionId = asString(record.parentSessionId)
  const parentSessionPath = asString(record.parentSessionPath)
  const profile = asString(record.profile)
  const task = asString(record.task)
  const resource = asRecord(record.resource)
  if (!runId || !parentSessionId || !parentSessionPath || !profile || !task || !resource || record.goalOwner !== undefined && !validGoalBillingOwner(record.goalOwner)) return null
  const tools = asStringArray(resource.tools)
  if (!tools) return null
  return {
    version: 1,
    ...(record.parentDispatch === true ? { parentDispatch: true as const } : {}),
    runId,
    parentSessionId,
    parentSessionPath,
    parentToolCallId: asString(record.parentToolCallId) ?? '',
    profile,
    description: asString(record.description) ?? 'Subagent',
    task,
    runInBackground: asBoolean(record.runInBackground) === true,
    createdAt: asString(record.createdAt) ?? new Date(0).toISOString(),
    ...(validGoalBillingOwner(record.goalOwner) ? { goalOwner: { ...record.goalOwner } } : {}),
    resource: {
      tools,
      ...(resource.planRestricted === true ? { planRestricted: true as const } : {}),
      ...(resource.extensions === true ? { extensions: true as const } : {}),
      model: asString(resource.model),
      thinkingLevel: asString(resource.thinkingLevel),
      maxTurns: asNumber(resource.maxTurns),
      inheritContext: asBoolean(resource.inheritContext) === true,
      appendSystemPrompt: asString(resource.appendSystemPrompt)
    }
  }
}

function parseWrittenFiles(value: unknown): SubagentWrittenFileDTO[] | undefined {
  if (!Array.isArray(value)) return undefined
  const files: SubagentWrittenFileDTO[] = []
  for (const item of value) {
    const record = asRecord(item)
    const filePath = asString(record?.filePath)
    if (!filePath) continue
    files.push({
      filePath,
      displayPath: asString(record!.displayPath) ?? filePath,
      ...(record!.kind === 'generated-image' ? { kind: 'generated-image' as const } : {}),
      added: asNumber(record!.added),
      removed: asNumber(record!.removed),
      patch: asString(record!.patch)
    })
  }
  return files.length ? files : undefined
}

function parseResult(data: unknown): SubagentRunResultData | null {
  const record = asRecord(data)
  if (!record || record.version !== 1) return null
  const runId = asString(record!.runId)
  const status = asString(record!.status)
  const completedAt = asString(record!.completedAt)
  if (!runId || !completedAt || (status !== 'completed' && status !== 'failed' && status !== 'aborted')) return null
  return {
    version: 1,
    runId,
    status,
    completedAt,
    result: asString(record.result),
    error: asString(record.error),
    ...(record.limitReached === true ? { limitReached: true as const } : {}),
    writtenFiles: parseWrittenFiles(record.writtenFiles),
    ...(record.writtenFilesScope === 'run' ? { writtenFilesScope: 'run' as const } : {})
  }
}

/** One run reconstructed purely from session entries (no runtime state). */
export interface DiskSubagentRun {
  start: SubagentRunStartData
  result: SubagentRunResultData | null
  startEntryId?: string
  resultEntryId?: string
}

/**
 * Fold child-session entries into per-run records.
 *
 * Each start entry opens a run; a result entry closes the run whose runId it
 * carries. The session's CURRENT state is its LAST start entry: a result only
 * applies to the run it names, so a resumed session whose new run has not
 * finished reads as running/interrupted instead of its previous terminal
 * state — the stale-completed bug the single-result design had.
 */
export function readDiskSubagentRuns(entries: readonly SessionEntry[]): DiskSubagentRun[] {
  const runs = new Map<string, DiskSubagentRun>()
  const order: string[] = []
  for (const entry of entries) {
    if (entry.type !== 'custom') continue
    if (entry.customType === SUBAGENT_RUN_TYPE) {
      const start = parseStart(entry.data)
      if (!start || runs.has(start.runId)) continue
      runs.set(start.runId, { start, result: null, startEntryId: entry.id })
      order.push(start.runId)
    } else if (entry.customType === SUBAGENT_RESULT_TYPE) {
      const result = parseResult(entry.data)
      if (!result) continue
      const run = runs.get(result.runId)
      if (run && !run.result) { run.result = result; run.resultEntryId = entry.id }
    }
  }
  return order.map((runId) => runs.get(runId)!)
}

/** The session's latest run as a DTO, or null when it has none. */
export function currentDiskRun(entries: readonly SessionEntry[], sessionId: string, sessionPath: string): SubagentRunDTO | null {
  const runs = readDiskSubagentRuns(entries)
  const current = runs[runs.length - 1]
  if (!current) return null
  return diskRunToDTO(current, sessionId, sessionPath)
}

export function diskRunToDTO(run: DiskSubagentRun, sessionId: string, sessionPath: string): SubagentRunDTO {
  return {
    runId: run.start.runId,
    sessionId,
    sessionPath,
    parentToolCallId: run.start.parentToolCallId,
    profile: run.start.profile,
    description: run.start.description,
    task: run.start.task,
    runInBackground: run.start.runInBackground,
    status: run.result ? run.result.status : 'interrupted',
    createdAt: run.start.createdAt,
    ...(run.result ? { completedAt: run.result.completedAt } : {}),
    ...(run.result?.result ? { result: run.result.result } : {}),
    ...(run.result?.error ? { error: run.result.error } : {}),
    ...(run.result?.limitReached ? { limitReached: true } : {}),
    ...(run.result?.writtenFiles ? { writtenFiles: run.result.writtenFiles } : {}),
    ...(run.result?.writtenFilesScope ? { writtenFilesScope: run.result.writtenFilesScope } : {}),
    model: run.start.resource.model,
    tools: [...run.start.resource.tools],
    seq: 0
  }
}

/**
 * Roster rows are panel metadata: they are re-serialized on every progress
 * tick and inside every session snapshot, so file patches (up to 64 KiB each)
 * stay out of them. The patches ride the `agent` tool result and the
 * `subagent_completion` notice instead — the two payloads the changed-files
 * list and rewind coverage actually read. `result` is kept: the card shows the
 * child's final answer. Called on both the publish and the recover path, so no
 * roster row can leak a patch back into the wire shape.
 */
export function slimRunForRoster(run: SubagentRunDTO): SubagentRunDTO {
  if (!run.writtenFiles?.some((file) => file.patch !== undefined)) return run
  return {
    ...run,
    writtenFiles: run.writtenFiles.map((file) => ({
      filePath: file.filePath,
      displayPath: file.displayPath,
      ...(file.kind === 'generated-image' ? { kind: file.kind } : {}),
      ...(file.added !== undefined ? { added: file.added } : {}),
      ...(file.removed !== undefined ? { removed: file.removed } : {})
    }))
  }
}

/**
 * Merge one run DTO into a live roster map.
 *
 * `seq` is a per-parent monotonic revision: an update for a session whose
 * roster entry already carries a HIGHER seq is dropped, so a late terminal
 * event from an aborted run cannot overwrite the card of the run that
 * replaced it. Equal seq still applies (idempotent field refreshes).
 */
export function applyRunToRoster(roster: Map<string, SubagentRunDTO>, run: SubagentRunDTO): boolean {
  const existing = roster.get(run.sessionId)
  if (existing && run.seq < existing.seq) return false
  if (existing && run.seq === existing.seq && run.status === existing.status &&
    JSON.stringify(existing) === JSON.stringify(run)) return false
  roster.set(run.sessionId, run)
  return true
}
