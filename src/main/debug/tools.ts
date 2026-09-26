import type { AgentSessionServices, ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { DebugManager } from './manager'
import { detectDebugAdapters, readLaunchConfigurations, type DebugLaunchConfiguration } from './adapters'
import { escalationHintMarker, planFileDenialMarker, sandboxDenialMarker } from '../sandbox/escalation'
import type { SandboxMode } from '../sandbox/types'
import type { DebugSessionDTO } from '../../shared/types'
import { debugActions, debugParameters, dispatchDebugAction, prepareDebugArguments } from './action-registry'

export const DEBUG_TOOL_NAME = 'debug'
export const APP_DEBUG_TOOL_NAMES = [DEBUG_TOOL_NAME] as const

const DEBUG_GUIDELINES = [
  'Use {debugId?, stopId?, request: {action, ...}}. Parameters belong to their action; help lists actions, permissions and capabilities. Old flat calls remain compatible.',
  'Source-less workflow: stack retains instructionPointerReference/moduleId/source. source.kind=adapter MUST use source with sourceReference + sourceVersion from the session, never read its path as a file. disassemble takes the opaque PC as memoryReference; memory.read reads bounded bytes/gaps; registers returns register scopes to expand with variables. modules pages loaded modules and symbol status.',
  'Native breakpoint sets: breakpoints.instruction items [{instructionReference,offset?,condition?,hitCondition?}] and breakpoints.function items [{name,condition?,hitCondition?}] replace their entire sets. Pass debugId + current stopId. Instruction addresses are cleared on restart (ASLR); re-fetch PC/disassembly. Function names persist. breakpoints.native lists their bindings; verified is not condition validation.',
  'Use control granularity=instruction for real instruction next/stepIn/stepOut only when supportsSteppingGranularity is true; no silent fallback to source stepping. Capability flags in each session gate disassembly, memory, native breakpoints and modules. New reference operations require debugId and stopId; opaque references are strings, never convert them to numbers.',
  'Reach for the debugger when a program crashes, hangs, or corrupts state: attach or launch, set breakpoints, step, and read the real frames and variables instead of sprinkling print statements. Small deterministic reproducers are still faster with plain bash.',
  'Multiple debug sessions may run in this chat. sessions lists them. Pass debugId on every targeted action when more than one is live. Child agents own separate sessions: parent and siblings cannot inspect or control them.',
  'control actions (continue/next/stepIn/stepOut/pause) block until the debuggee stops again or waitMs expires. settled=true means a stop (or termination) was reached; settled=false means it is still running — use control again or inspect output instead of re-sending the same step.',
  'Read stopReason, stopDescription, stopText, hitBreakpointIds, conditionError and stopDiagnostics after every control. "breakpoint" can also mean a condition failed to evaluate, especially in LLDB; inspect output before concluding a condition matched. "step" is a completed step; "entry" is process entry (macOS may stop in the dynamic linker). A continue after a breakpoint interrupted an LLDB step may first complete that step.',
  'threads/stack/scopes/variables/evaluate require a stopped debuggee. stack gives frame ids, scopes give variablesReferences, variables expand one level per call (default page 50, truncated=true when more exist — page large arrays with start/count). Values are truncated server-side (256 chars per value, 2048 chars per evaluate result).',
  'Frame ids and variablesReferences are recycled at every stop: after any control action, re-fetch stack/scopes/variables instead of reusing ids from an earlier stop.',
  'lldb-dap answers evaluate in REPL form — "(int) $0 = 7". The $N handle is real: reuse it in later evaluate expressions of the same stop.',
  'breakpoints replaces the whole breakpoint set of one file: pass every item to keep. verified only reports binding, NOT expression validity or a true condition. conditionStatus=unvalidated remains until an adapter reports an error; never claim validation from verified=true. verified=false may be pending until a module loads. Use items:[{line,condition?,hitCondition?,logMessage?}] so each breakpoint owns its options. A condition normally stops when true but adapters may also stop on evaluation errors; hitCondition gates hit count and logMessage creates a logpoint.',
  'LLDB may parse C expressions as C++ and lack libc function return types. For a known int-returning function use its explicit declared type, e.g. (int)strcmp(key, "wanted") == 0. Verify the corrected expression in the stopped frame, replace the file\'s breakpoint set, then continue and inspect the actual values. Do not silently rewrite or re-evaluate arbitrary conditions: function calls can have side effects. A non-function alternative is comparing known fields/characters, but a single missed hit proves neither success nor failure. Check the bound line and preceding branches too: a condition cannot hit if an earlier return already excluded that state.',
  'output pages the debug console with a cursor, like bash_task output.',
  'Core inspection: start with adapter=lldb-dap, kind=core, coreFile and optional program for symbols (equivalent to lldb -c). It exposes stack/scopes/variables/registers, virtual source, disassembly, memory and modules when supported; control, restart, breakpoints and executable expressions are unavailable.',
  'Standalone js-debug creates adapter-owned child targets. Use sessions to find the stopped child debugId for inspection/stepping; stop the root to stop the whole target tree.',
  'Launching or stopping a debuggee is process control: the session sandbox mode gates it, and read-only refuses it. The debuggee itself is never file-sandboxed — a debugger needs full process-inspection rights by design.',
  'When a debug session ends (stop, termination, crash), its status is terminal: start a fresh session instead of retrying control actions.',
  'restart re-runs the debuggee: native DAP restart when the adapter supports it, otherwise stop+start with the same options (the session id changes). Source/function breakpoints persist; absolute instruction breakpoints are cleared on every restart.',
  'configurations lists .vscode/launch.json entries mapped onto adapters; start with configuration="<name>" to use one — explicit arguments override its values. Adapter-specific keys (sourceMaps, justMyCode, mode, …) pass through into the DAP request.'
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
  const requireExecMode = async (toolCallId: string, args: { sandbox_permissions?: unknown; justification?: unknown }, signal?: AbortSignal): Promise<void> => {
    const mode = options.escalate
      ? await options.escalate({ toolCallId, toolName: DEBUG_TOOL_NAME, sandboxPermissions: args.sandbox_permissions, justification: args.justification, ...(signal ? { signal } : {}) })
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
    prepareArguments: prepareDebugArguments,
    description: 'Drive isolated DAP targets with source or machine-level inspection: launch/attach/core, breakpoints, instruction/source stepping, stack/registers, memory and modules. Use action-specific requests; supports LLDB, debugpy, Delve and js-debug.',
    promptSnippet: 'Debug crashes with live state, source/assembly, registers, memory and breakpoints.',
    promptGuidelines: DEBUG_GUIDELINES,
    executionMode: 'sequential',
    async execute(toolCallId, args, signal, _onUpdate, ctx) {
      if (!options.enabled()) throw new Error('The debugger is disabled (Settings → General). Enable it to use the debug tool.')
      if (options.isPlanRestricted?.()) throw new Error('Debugging is unavailable while Plan mode is on; approve and execute the plan first.')
      const prepared = prepareDebugArguments(args)
      const { request, debugId, stopId } = prepared
      if (debugActions[request.action].policy.access === 'execute') await requireExecMode(toolCallId, prepared, signal)
      if (signal?.aborted || !options.enabled() || options.isPlanRestricted?.()) throw new Error('Debug action cancelled; debugger disabled or Plan mode changed')
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
          return manager.start({
            sessionId, sessionPath, workspaceCwd: services.cwd, signal,
            canStart: () => options.canStart() && options.enabled() && !options.isPlanRestricted?.(),
            coreFile: request.coreFile ?? config?.coreFile, name: config?.name,
            cwd: request.cwd ?? config?.cwd ?? ctx.cwd ?? services.cwd,
            adapterId, kind: request.kind ?? config?.kind ?? 'launch',
            program: request.program ?? config?.program, args: request.args ?? config?.args,
            env: request.env ?? config?.env, pid: request.pid ?? config?.pid,
            stopOnEntry: request.stopOnEntry ?? config?.stopOnEntry,
            ...(Object.keys(extraArguments).length ? { extraArguments } : {}),
            runInTerminal: options.runInTerminal()
          })
        }
      }, request)
      const session = ['start', 'restart', 'stop'].includes(request.action) ? value as DebugSessionDTO
        : value && typeof value === 'object' && 'session' in value ? (value as { session: DebugSessionDTO }).session : undefined
      return { content: text(value), details: session ? details(session) : undefined }
    }
  }]
}
