import { Type } from 'typebox'
import type { AgentSessionServices, ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { DebugManager } from './manager'
import { detectDebugAdapters, readLaunchConfigurations, type DebugLaunchConfiguration } from './adapters'
import { escalationHintMarker, planFileDenialMarker, SANDBOX_ESCALATION_PROPERTIES, sandboxDenialMarker } from '../sandbox/escalation'
import type { SandboxMode } from '../sandbox/types'
import type { DebugSessionDTO } from '../../shared/types'

export const DEBUG_TOOL_NAME = 'debug'
export const APP_DEBUG_TOOL_NAMES = [DEBUG_TOOL_NAME] as const

const DEBUG_GUIDELINES = [
  'Reach for the debugger when a program crashes, hangs, or corrupts state: attach or launch, set breakpoints, step, and read the real frames and variables instead of sprinkling print statements. Small deterministic reproducers are still faster with plain bash.',
  'Multiple debug sessions may run in this chat. sessions lists them. Pass debugId on every targeted action when more than one is live. Child agents own separate sessions: parent and siblings cannot inspect or control them.',
  'control actions (continue/next/stepIn/stepOut/pause) block until the debuggee stops again or waitMs expires. settled=true means a stop (or termination) was reached; settled=false means it is still running — use control again or inspect output instead of re-sending the same step.',
  'Read stopReason, stopDescription, stopText, hitBreakpointIds, conditionError and stopDiagnostics after every control. "breakpoint" can also mean a condition failed to evaluate, especially in LLDB; inspect output before concluding a condition matched. "step" is a completed step; "entry" is process entry (macOS may stop in the dynamic linker). A continue after a breakpoint interrupted an LLDB step may first complete that step.',
  'threads/stack/scopes/variables/evaluate require a stopped debuggee. stack gives frame ids, scopes give variablesReferences, variables expand one level per call (default page 50, truncated=true when more exist — page large arrays with start/count). Values are truncated server-side (256 chars per value, 2048 chars per evaluate result).',
  'Frame ids and variablesReferences are recycled at every stop: after any control action, re-fetch stack/scopes/variables instead of reusing ids from an earlier stop.',
  'lldb-dap answers evaluate in REPL form — "(int) $0 = 7". The $N handle is real: reuse it in later evaluate expressions of the same stop.',
  'breakpoints replaces the whole breakpoint set of one file: pass every line to keep. verified only reports binding, NOT expression validity or a true condition. conditionStatus=unvalidated remains until an adapter reports an error; never claim validation from verified=true. verified=false may be pending until a module loads. conditions/hitConditions/logMessages are parallel to lines. A condition normally stops when true but adapters may also stop on evaluation errors; hitCondition gates hit count and logMessage creates a logpoint.',
  'LLDB may parse C expressions as C++ and lack libc function return types. For a known int-returning function use its explicit declared type, e.g. (int)strcmp(key, "wanted") == 0. Verify the corrected expression in the stopped frame, replace the file\'s breakpoint set, then continue and inspect the actual values. Do not silently rewrite or re-evaluate arbitrary conditions: function calls can have side effects. A non-function alternative is comparing known fields/characters, but a single missed hit proves neither success nor failure. Check the bound line and preceding branches too: a condition cannot hit if an earlier return already excluded that state.',
  'output pages the debug console with a cursor, like bash_task output.',
  'Core inspection: start with adapter=lldb-dap, kind=core, coreFile and optional program for symbols (equivalent to lldb -c). It exposes stack/scopes/variables; control, restart, breakpoints and executable expressions are unavailable.',
  'Standalone js-debug creates adapter-owned child targets. Use sessions to find the stopped child debugId for inspection/stepping; stop the root to stop the whole target tree.',
  'Launching or stopping a debuggee is process control: the session sandbox mode gates it, and read-only refuses it. The debuggee itself is never file-sandboxed — a debugger needs full process-inspection rights by design.',
  'When a debug session ends (stop, termination, crash), its status is terminal: start a fresh session instead of retrying control actions.',
  'restart re-runs the debuggee: native DAP restart when the adapter supports it, otherwise stop+start with the same options (the session id changes). Breakpoints persist across a native restart; the fallback keeps the ones the manager knows.',
  'configurations lists .vscode/launch.json entries mapped onto adapters; start with configuration="<name>" to use one — explicit arguments override its values. Adapter-specific keys (sourceMaps, justMyCode, mode, …) pass through into the DAP request.'
]

const debugParameters = Type.Object({
  action: Type.Union([
    Type.Literal('adapters'),
    Type.Literal('sessions'),
    Type.Literal('configurations'),
    Type.Literal('start'),
    Type.Literal('restart'),
    Type.Literal('stop'),
    Type.Literal('breakpoints'),
    Type.Literal('control'),
    Type.Literal('threads'),
    Type.Literal('stack'),
    Type.Literal('scopes'),
    Type.Literal('variables'),
    Type.Literal('evaluate'),
    Type.Literal('output')
  ], { description: 'sessions: list this chat\'s debug targets and ids. adapters: list detected debug adapters. configurations: list .vscode/launch.json entries mapped onto adapters. start: launch a program or attach to a pid, optionally from a launch.json configuration. restart: re-run the debuggee. breakpoints: replace one file\'s breakpoints. control: continue/pause/next/stepIn/stepOut, blocking until the next stop. threads/stack/scopes/variables/evaluate: inspect a stopped debuggee. output: page the debug console. stop: end the session.' }),
  debugId: Type.Optional(Type.String({ description: 'Target id from sessions/start; required when multiple sessions are live.' })),
  stopId: Type.Optional(Type.Integer({ description: 'Inspection: stopId from the session snapshot; rejects stale frame/variable references.' })),
  coreFile: Type.Optional(Type.String({ description: 'start (core): absolute core dump path; use adapter lldb-dap and optionally program for symbols. Core targets expose stack/scopes/variables only.' })),
  adapter: Type.Optional(Type.String({ description: 'start: adapter id from the adapters list (e.g. "lldb-dap", "debugpy", "dlv").' })),
  configuration: Type.Optional(Type.String({ description: 'start: launch.json configuration name to start from (see action="configurations"); explicit arguments override its values.' })),
  kind: Type.Optional(Type.Union([Type.Literal('launch'), Type.Literal('attach'), Type.Literal('core')], { description: 'start: default launch. attach requires pid; core requires coreFile.' })),
  program: Type.Optional(Type.String({ description: 'start (launch): absolute path of the binary/script/package to debug; optional for a Python module launch configuration.' })),
  args: Type.Optional(Type.Array(Type.String(), { description: 'start (launch): debuggee arguments.' })),
  cwd: Type.Optional(Type.String({ description: 'start: debuggee working directory; defaults to the workspace.' })),
  env: Type.Optional(Type.Record(Type.String(), Type.String(), { description: 'start: extra environment variables for the debuggee.' })),
  stopOnEntry: Type.Optional(Type.Boolean({ description: 'start (launch): stop at the entry point before any user code runs.' })),
  pid: Type.Optional(Type.Integer({ description: 'start (attach): process id to attach to.' })),
  file: Type.Optional(Type.String({ description: 'breakpoints: absolute file path.' })),
  lines: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }), { description: 'breakpoints: complete line set for the file (replaces, not adds).' })),
  conditions: Type.Optional(Type.Array(Type.String(), { description: 'breakpoints: condition per line (parallel to lines; "" skips). verified confirms binding only. Adapters may stop on condition errors; inspect conditionError/stopDiagnostics and output.' })),
  hitConditions: Type.Optional(Type.Array(Type.String(), { description: 'breakpoints: hit-count condition per line (parallel to lines), e.g. ">=3".' })),
  logMessages: Type.Optional(Type.Array(Type.String(), { description: 'breakpoints: log message per line (parallel to lines; "" skips a line) — turns the line into a logpoint: printed to the debug console, never stopped at.' })),
  control: Type.Optional(Type.Union([
    Type.Literal('continue'), Type.Literal('pause'), Type.Literal('next'), Type.Literal('stepIn'), Type.Literal('stepOut')
  ], { description: 'control: the stepping action.' })),
  threadId: Type.Optional(Type.Integer({ description: 'control/stack: thread; defaults to the thread that last stopped.' })),
  waitMs: Type.Optional(Type.Number({ minimum: 500, maximum: 120_000, description: 'control: stop-wait budget in ms, default 10000. Expiry is not failure: settled=false means still running.' })),
  frameId: Type.Optional(Type.Integer({ description: 'scopes/evaluate: stack frame id from stack. evaluate defaults to the top frame of the stopped thread.' })),
  levels: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: 'stack: frame count cap, default 20.' })),
  variablesReference: Type.Optional(Type.Integer({ description: 'variables: reference from scopes or a parent variable.' })),
  start: Type.Optional(Type.Integer({ minimum: 0, description: 'variables: first child index (DAP indexed paging). Pair with count.' })),
  count: Type.Optional(Type.Integer({ minimum: 1, maximum: 500, description: 'variables: page size, default 50. The result\'s truncated flag tells whether another page exists.' })),
  expression: Type.Optional(Type.String({ description: 'evaluate: expression in the debuggee\'s language, evaluated in frameId or the stopped thread\'s top frame.' })),
  cursor: Type.Optional(Type.Integer({ minimum: 0, description: 'output: cursor from an earlier output call. Omit for recent output.' })),
  maxChars: Type.Optional(Type.Integer({ minimum: 1, maximum: 65_536, description: 'output: maximum returned characters, default 16384.' })),
  ...SANDBOX_ESCALATION_PROPERTIES
})

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
    description: 'Drive a real debugger over DAP: launch or attach, set breakpoints, step with blocking control, and inspect threads, stack frames, scopes, variables and expressions. Multiple isolated sessions per chat; lldb-dap, debugpy and delve are detected automatically.',
    promptSnippet: 'Debug programs with breakpoints, stepping and variable inspection instead of print statements.',
    promptGuidelines: DEBUG_GUIDELINES,
    executionMode: 'sequential',
    async execute(toolCallId, args, signal, _onUpdate, ctx) {
      if (!options.enabled()) throw new Error('The debugger is disabled (Settings → General). Enable it to use the debug tool.')
      if (options.isPlanRestricted?.()) throw new Error('Debugging is unavailable while Plan mode is on; approve and execute the plan first.')
      const cwd = args.cwd || ctx.cwd || services.cwd

      switch (args.action) {
        case 'sessions': return { content: text(manager.list(sessionPath)), details: undefined }
        case 'adapters': {
          // Discovery can execute workspace Python, not just inspect PATH.
          await requireExecMode(toolCallId, args, signal)
          if (signal?.aborted || !options.canStart() || !options.enabled() || options.isPlanRestricted?.()) throw new Error('Debug adapter discovery cancelled')
          return { content: text(await detectDebugAdapters(cwd, signal)), details: undefined }
        }
        case 'configurations': {
          const configurations = readLaunchConfigurations(cwd)
          // Values of pass-through keys are adapter-specific and bulky: the
          // key names are enough to tell configurations apart.
          return { content: text(configurations.map(({ extraArguments, ...summary }) => ({ ...summary, extraKeys: Object.keys(extraArguments) }))), details: undefined }
        }
        case 'start': {
          if (signal?.aborted || !options.canStart()) throw new Error('Debug session cancelled before launch')
          await requireExecMode(toolCallId, args, signal)
          // A named launch.json configuration supplies the defaults; explicit
          // tool arguments win over every one of them.
          const config = args.configuration !== undefined ? resolveConfiguration(ctx.cwd || services.cwd, args.configuration) : undefined
          const program = args.program ?? config?.program
          const configArgs = args.args ?? config?.args
          const env = args.env ?? config?.env
          const pid = args.pid ?? config?.pid
          const adapterId = args.adapter ?? config?.adapterId ?? ''
          const extraArguments = { ...config?.extraArguments }
          // An explicit script replaces a Python configuration's module entry.
          if (adapterId === 'debugpy' && args.program !== undefined) delete extraArguments.module
          const dto = await manager.start({
            sessionId,
            sessionPath,
            workspaceCwd: services.cwd,
            signal,
            canStart: () => options.canStart() && options.enabled() && !options.isPlanRestricted?.(),
            coreFile: args.coreFile ?? config?.coreFile,
            name: config?.name,
            cwd: args.cwd ?? config?.cwd ?? cwd,
            adapterId,
            kind: args.kind ?? config?.kind ?? 'launch',
            ...(program !== undefined ? { program } : {}),
            ...(configArgs !== undefined ? { args: configArgs } : {}),
            ...(env !== undefined ? { env } : {}),
            ...(args.stopOnEntry ?? config?.stopOnEntry ? { stopOnEntry: true } : {}),
            ...(pid !== undefined ? { pid } : {}),
            ...(Object.keys(extraArguments).length > 0 ? { extraArguments } : {}),
            ...(options.runInTerminal() ? { runInTerminal: options.runInTerminal()! } : {})
          })
          return { content: text(dto), details: details(dto) }
        }
        case 'restart': {
          await requireExecMode(toolCallId, args, signal)
          const dto = await manager.restart(sessionPath, args.debugId, signal, options.canStart)
          return { content: text(dto), details: details(dto) }
        }
        case 'stop': {
          await requireExecMode(toolCallId, args, signal)
          const dto = await manager.stop(sessionPath, args.debugId)
          return { content: text(dto), details: details(dto) }
        }
        case 'breakpoints': {
          await requireExecMode(toolCallId, args, signal)
          if (!args.file || !args.lines) throw new Error('breakpoints requires file and lines (the file\'s complete breakpoint set)')
          const extraArrays = [args.conditions, args.hitConditions, args.logMessages].filter((list) => Array.isArray(list))
          if (extraArrays.some((list) => list!.length !== args.lines!.length)) {
            throw new Error('conditions/hitConditions/logMessages must be parallel to lines (same length; use "" to skip a line)')
          }
          const extras = args.conditions ?? args.hitConditions ?? args.logMessages
            ? {
              ...(args.conditions ? { conditions: args.conditions } : {}),
              ...(args.hitConditions ? { hitConditions: args.hitConditions } : {}),
              ...(args.logMessages ? { logMessages: args.logMessages } : {})
            }
            : undefined
          const breakpoints = await manager.setBreakpoints(sessionPath, args.file, args.lines, extras, args.debugId)
          return { content: text({ breakpoints, session: manager.get(sessionPath, args.debugId) }), details: details(manager.get(sessionPath, args.debugId)) }
        }
        case 'control': {
          await requireExecMode(toolCallId, args, signal)
          if (!args.control) throw new Error('control requires the control parameter (continue/pause/next/stepIn/stepOut)')
          const result = await manager.control(sessionPath, args.control, args.threadId, args.waitMs, args.debugId, args.stopId)
          return { content: text(result), details: details(result.session) }
        }
        case 'threads': {
          return { content: text(await manager.threads(sessionPath, args.debugId)), details: undefined }
        }
        case 'stack': {
          const threadId = args.threadId ?? manager.get(sessionPath, args.debugId).activeThreadId
          if (threadId === undefined) throw new Error('stack requires a threadId (or a prior stop)')
          return { content: text(await manager.stack(sessionPath, threadId, args.levels, args.debugId, args.stopId)), details: undefined }
        }
        case 'scopes': {
          if (args.frameId === undefined) throw new Error('scopes requires a frameId from stack')
          return { content: text(await manager.scopes(sessionPath, args.frameId, args.debugId, args.stopId)), details: undefined }
        }
        case 'variables': {
          if (args.variablesReference === undefined) throw new Error('variables requires a variablesReference')
          return { content: text(await manager.variables(sessionPath, args.variablesReference, args.start, args.count, args.debugId, args.stopId)), details: undefined }
        }
        case 'evaluate': {
          // DAP evaluate (including watch) may execute arbitrary target code.
          await requireExecMode(toolCallId, args, signal)
          if (!args.expression) throw new Error('evaluate requires an expression')
          return { content: text(await manager.evaluate(sessionPath, args.expression, args.frameId, args.debugId, args.stopId)), details: undefined }
        }
        case 'output': {
          return { content: text(manager.output(sessionPath, args.cursor, args.maxChars, args.debugId)), details: undefined }
        }
        default:
          throw new Error(`Unknown debug action: ${String(args.action)}`)
      }
    }
  } satisfies ToolDefinition<typeof debugParameters>]
}
