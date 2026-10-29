import type { AgentSessionServices, ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { DebugManager } from './manager'
import { detectDebugAdapters, readLaunchConfigurations, type DebugLaunchConfiguration } from './adapters'
import { escalationHintMarker, planFileDenialMarker, sandboxDenialMarker } from '../sandbox/escalation'
import type { SandboxMode } from '../sandbox/types'
import type { DebugSessionDTO, SandboxEscalationOperationDTO } from '../../shared/types'
import { debugActions, debugParameters, dispatchDebugAction, prepareDebugArguments } from './action-registry'
import { appToolError, appToolResult, ToolFailure } from '../pi/tool-result'
import { debugOutputSchema, debugResultData } from './result-schema'

export const DEBUG_TOOL_NAME = 'debug'
export const APP_DEBUG_TOOL_NAMES = [DEBUG_TOOL_NAME] as const

const DEBUG_GUIDELINES = [
  'debug: use {debugId?, stopId?, request:{action,...}}. Call help (optional topic=action) for schemas and detailed workflows before unfamiliar operations.',
  'Pin the target and current stopId; refresh frame/variable references after control. Use sourceReference/sourceVersion for adapter sources, never file reads. Keep addresses as opaque strings.',
  'If control returns settled=false, use wait with afterRevision; never repeat a step to wait. Inspect stop diagnostics: verified breakpoints prove binding, not valid/matching conditions. Evaluation may have side effects.',
  'Debug targets are not file-sandboxed. Respect session permissions and capabilities; ended targets require a fresh start, core inspection is read-only, and restart clears instruction addresses.'
]

export interface DebugToolOptions {
  manager: DebugManager
  services: AgentSessionServices
  sessionId: string
  sessionPath: string
  /** Live enable flag: Settings can turn the debugger off between two calls. */
  enabled: () => boolean
  /** Live sandbox mode, read per call like bash. */
  sandboxMode: () => SandboxMode
  isPlanRestricted?: () => boolean
  /** Approval channel for a one-shot wider mode; absent means final denial. */
  escalate?: (input: {
    toolCallId: string
    toolName: 'debug'
    operation: SandboxEscalationOperationDTO
    sandboxPermissions: unknown
    justification: unknown
    signal?: AbortSignal
  }) => Promise<SandboxMode>
  canStart: () => boolean
  /** Live bridge to the sidebar terminal; absent means no runInTerminal
   * capability is advertised to the adapter. */
  runInTerminal: () => DebugRunInTerminal | undefined
}

export type DebugRunInTerminal = (input: {
  title: string
  cwd: string
  args: string[]
  env?: Record<string, string | null>
  signal?: AbortSignal
}) => Promise<{ shellProcessId: number; terminalId: string; dispose?: () => Promise<void> }>

const json = (value: unknown): string => JSON.stringify(value)

/** One launch.json configuration by name, with a useful error otherwise. */
function resolveConfiguration(cwd: string, name: string): DebugLaunchConfiguration {
  const configurations = readLaunchConfigurations(cwd)
  const config = configurations.find((item) => item.name === name)
  if (!config) {
    throw new Error(configurations.length === 0
      ? 'No launch configurations found (.vscode/launch.json is missing or has no mappable entries)'
      : `Unknown configuration "${name}". Available: ${configurations.map((item) => item.name).join(', ')}`)
  }
  return config
}

export function createDebugTools(options: DebugToolOptions): ToolDefinition[] {
  const { manager, services, sessionId, sessionPath } = options
  const details = (session: DebugSessionDTO) => ({ debugSession: session })
  const text = (value: unknown) => [{ type: 'text' as const, text: json(value) }]

  /** Process-control actions go through the same mode resolution as bash. */
  const requireExecMode = async (toolCallId: string, args: ReturnType<typeof prepareDebugArguments>, cwd: string, signal?: AbortSignal): Promise<void> => {
    const mode = options.escalate
      ? await options.escalate({ toolCallId, toolName: DEBUG_TOOL_NAME, operation: { cwd, parameters: { ...args } }, sandboxPermissions: args.sandbox_permissions, justification: args.justification, ...(signal ? { signal } : {}) })
      : options.sandboxMode()
    if (mode === 'read-only') {
      const restricted = options.isPlanRestricted?.() === true
      throw new Error(`${sandboxDenialMarker(mode)}\n${restricted ? planFileDenialMarker('operation') : escalationHintMarker('operation')}`)
    }
  }

  return [{
    name: DEBUG_TOOL_NAME,
    label: 'debug',
    parameters: debugParameters,
    outputSchema: debugOutputSchema,
    prepareArguments: prepareDebugArguments,
    description: 'Drive isolated DAP targets with source or machine-level inspection: launch/attach/core, breakpoints, instruction/source stepping, stack/registers, memory and modules. Use action-specific requests; supports LLDB, debugpy, Delve and js-debug. Scripts receive {ok,isError,data,content}: data.action identifies the result, start/restart/stop return data.session, stack returns data.frames, registers returns data.scopes. Inspect error.code/message on failure; use help for action input and result schemas.',
    promptSnippet: 'Debug crashes with live state, source/assembly, registers, memory and breakpoints.',
    promptGuidelines: DEBUG_GUIDELINES,
    executionMode: 'sequential',
    async execute(toolCallId, args, signal, _onUpdate, ctx) {
      if (!options.enabled()) throw new Error('The debugger is disabled (Settings → General). Enable it to use the debug tool.')
      if (options.isPlanRestricted?.()) throw new Error('Debugging is unavailable while Plan mode is on; approve and execute the plan first.')
      const prepared = prepareDebugArguments(args)
      const { request, debugId, stopId } = prepared
      if (debugActions[request.action].policy.access === 'execute') await requireExecMode(toolCallId, prepared, ctx.cwd || services.cwd, signal)
      if (signal?.aborted || !options.enabled() || options.isPlanRestricted?.()) throw new Error('Debug action cancelled; debugger disabled or Plan mode changed')
      try {
        const value = await dispatchDebugAction({
          manager, sessionPath, debugId, stopId, signal,
          canStart: () => options.canStart() && options.enabled() && !options.isPlanRestricted?.(),
          adapters: async (cwd) => {
            if (signal?.aborted || !options.canStart() || !options.enabled() || options.isPlanRestricted?.()) throw new Error('Debug adapter discovery cancelled')
            return detectDebugAdapters(cwd || ctx.cwd || services.cwd, signal)
          },
          configurations: cwd => readLaunchConfigurations(cwd || ctx.cwd || services.cwd)
            .map(({ extraArguments, ...summary }) => ({ ...summary, extraKeys: Object.keys(extraArguments) })),
          start: async request => {
            if (signal?.aborted || !options.canStart()) throw new Error('Debug session cancelled before launch')
            const config = request.configuration !== undefined ? resolveConfiguration(ctx.cwd || services.cwd, request.configuration) : undefined
            const adapterId = request.adapter ?? config?.adapterId ?? ''
            const extraArguments = { ...config?.extraArguments }
            if (adapterId === 'debugpy' && request.program !== undefined) delete extraArguments.module
            const files = request.breakpoints?.map(group => group.file) ?? []
            if (new Set(files).size !== files.length) throw new Error('Duplicate initial breakpoint file')
            return manager.start({
              sessionId, sessionPath, workspaceCwd: services.cwd, signal,
              canStart: () => options.canStart() && options.enabled() && !options.isPlanRestricted?.(),
              coreFile: request.coreFile ?? config?.coreFile, name: config?.name,
              cwd: request.cwd ?? config?.cwd ?? ctx.cwd ?? services.cwd,
              adapterId, kind: request.kind ?? config?.kind ?? 'launch',
              program: request.program ?? config?.program, args: request.args ?? config?.args,
              env: request.env ?? config?.env, pid: request.pid ?? config?.pid,
              stopOnEntry: request.stopOnEntry ?? config?.stopOnEntry,
              initialBreakpoints: request.breakpoints ? new Map(request.breakpoints.map(group => [group.file, group.items])) : undefined,
              initialFunctionBreakpoints: request.functionBreakpoints,
              ...(Object.keys(extraArguments).length ? { extraArguments } : {}),
              runInTerminal: options.runInTerminal()
            })
          }
        }, request)
        const session = ['start', 'restart', 'stop'].includes(request.action) ? value as DebugSessionDTO
          : value && typeof value === 'object' && 'session' in value ? (value as { session: DebugSessionDTO }).session : undefined
        return appToolResult({ content: text(value), details: session ? details(session) : undefined }, debugResultData(request.action, value))
      } catch (error) {
        if (error instanceof ToolFailure) return appToolError(error)
        throw error
      }
    }
  }]
}
