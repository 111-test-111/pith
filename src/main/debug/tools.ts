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
  'One debug session per chat. Starting while one is active fails; stop the old session first.',
  'control actions (continue/next/stepIn/stepOut/pause) block until the debuggee stops again or waitMs expires. settled=true means a stop (or termination) was reached; settled=false means it is still running — use control again or inspect output instead of re-sending the same step.',
  'Read stopReason after every control: "step" is a completed step, "breakpoint" a bound breakpoint, "entry" the process entry (on macOS the entry stop lands in the dynamic linker — continue to reach your own code). lldb-dap note: a continue issued after a breakpoint interrupted a step completes that step first (reason "step"), then runs free.',
  'threads/stack/scopes/variables/evaluate require a stopped debuggee. stack gives frame ids, scopes give variablesReferences, variables expand one level per call (default page 50, truncated=true when more exist — page large arrays with start/count). Values are truncated server-side (256 chars per value, 2048 chars per evaluate result).',
  'Frame ids and variablesReferences are recycled at every stop: after any control action, re-fetch stack/scopes/variables instead of reusing ids from an earlier stop.',
  'lldb-dap answers evaluate in REPL form — "(int) $0 = 7". The $N handle is real: reuse it in later evaluate expressions of the same stop.',
  'breakpoints replaces the whole breakpoint set of one file: pass every line that should keep a breakpoint, not just the new ones. A breakpoint with verified=false did not bind — check the file path is absolute and matches the debuggee\'s sources. Parallel conditions/hitConditions/logMessages arrays refine a line: a condition stops only when true, a hitCondition gates by hit count (">=3"), a logMessage makes a logpoint that prints without stopping.',
  'output pages the debug console with a cursor, like bash_task output.',
  'Launching or stopping a debuggee is process control: the session sandbox mode gates it, and read-only refuses it. The debuggee itself is never file-sandboxed — a debugger needs full process-inspection rights by design.',
  'When a debug session ends (stop, termination, crash), its status is terminal: start a fresh session instead of retrying control actions.',
  'restart re-runs the debuggee: native DAP restart when the adapter supports it, otherwise stop+start with the same options (the session id changes). Breakpoints persist across a native restart; the fallback keeps the ones the manager knows.',
  'configurations lists .vscode/launch.json entries mapped onto adapters; start with configuration="<name>" to use one — explicit arguments override its values. Adapter-specific keys (sourceMaps, justMyCode, mode, …) pass through into the DAP request.'
]

const debugParameters = Type.Object({
  action: Type.Union([
    Type.Literal('adapters'),
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
  ], { description: 'adapters: list detected debug adapters. configurations: list .vscode/launch.json entries mapped onto adapters. start: launch a program or attach to a pid, optionally from a launch.json configuration. restart: re-run the debuggee. breakpoints: replace one file\'s breakpoints. control: continue/pause/next/stepIn/stepOut, blocking until the next stop. threads/stack/scopes/variables/evaluate: inspect a stopped debuggee. output: page the debug console. stop: end the session.' }),
  adapter: Type.Optional(Type.String({ description: 'start: adapter id from the adapters list (e.g. "lldb-dap", "debugpy", "dlv").' })),
  configuration: Type.Optional(Type.String({ description: 'start: launch.json configuration name to start from (see action="configurations"); explicit arguments override its values.' })),
  kind: Type.Optional(Type.Union([Type.Literal('launch'), Type.Literal('attach')], { description: 'start: default launch. attach requires pid.' })),
  program: Type.Optional(Type.String({ description: 'start (launch): absolute path of the binary/script/package to debug.' })),
  args: Type.Optional(Type.Array(Type.String(), { description: 'start (launch): debuggee arguments.' })),
  cwd: Type.Optional(Type.String({ description: 'start: debuggee working directory; defaults to the workspace.' })),
  env: Type.Optional(Type.Record(Type.String(), Type.String(), { description: 'start: extra environment variables for the debuggee.' })),
  stopOnEntry: Type.Optional(Type.Boolean({ description: 'start (launch): stop at the entry point before any user code runs.' })),
  pid: Type.Optional(Type.Integer({ description: 'start (attach): process id to attach to.' })),
  file: Type.Optional(Type.String({ description: 'breakpoints: absolute file path.' })),
  lines: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }), { description: 'breakpoints: complete line set for the file (replaces, not adds).' })),
  conditions: Type.Optional(Type.Array(Type.String(), { description: 'breakpoints: stop condition per line (parallel to lines; "" skips a line). The breakpoint stops only when the condition evaluates true.' })),
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
}) => Promise<{ shellProcessId: number; terminalId: string }>

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
    description: 'Drive a real debugger over DAP: launch or attach, set breakpoints, step with blocking control, and inspect threads, stack frames, scopes, variables and expressions. One session per chat; lldb-dap, debugpy and delve are detected automatically.',
    promptSnippet: 'Debug programs with breakpoints, stepping and variable inspection instead of print statements.',
    promptGuidelines: DEBUG_GUIDELINES,
    executionMode: 'sequential',
    async execute(toolCallId, args, signal, _onUpdate, ctx) {
      if (!options.enabled()) throw new Error('The debugger is disabled (Settings → General). Enable it to use the debug tool.')
      if (options.isPlanRestricted?.()) throw new Error('Debugging is unavailable while Plan mode is on; approve and execute the plan first.')
      const cwd = args.cwd || ctx.cwd || services.cwd

      switch (args.action) {
        case 'adapters': {
          return { content: text(await detectDebugAdapters(cwd)), details: undefined }
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
          const config = args.configuration !== undefined ? resolveConfiguration(cwd, args.configuration) : undefined
          const program = args.program ?? config?.program
          const configArgs = args.args ?? config?.args
          const env = args.env ?? config?.env
          const pid = args.pid ?? config?.pid
          const dto = await manager.start({
            sessionId,
            sessionPath,
            cwd: args.cwd ?? config?.cwd ?? cwd,
            adapterId: args.adapter ?? config?.adapterId ?? '',
            kind: args.kind ?? config?.kind ?? 'launch',
            ...(program !== undefined ? { program } : {}),
            ...(configArgs !== undefined ? { args: configArgs } : {}),
            ...(env !== undefined ? { env } : {}),
            ...(args.stopOnEntry ?? config?.stopOnEntry ? { stopOnEntry: true } : {}),
            ...(pid !== undefined ? { pid } : {}),
            ...(config?.extraArguments !== undefined && Object.keys(config.extraArguments).length > 0 ? { extraArguments: config.extraArguments } : {}),
            ...(options.runInTerminal() ? { runInTerminal: options.runInTerminal()! } : {})
          })
          return { content: text(dto), details: details(dto) }
        }
        case 'restart': {
          await requireExecMode(toolCallId, args, signal)
          const dto = await manager.restart(sessionPath)
          return { content: text(dto), details: details(dto) }
        }
        case 'stop': {
          await requireExecMode(toolCallId, args, signal)
          const dto = await manager.stop(sessionPath)
          return { content: text(dto), details: details(dto) }
        }
        case 'breakpoints': {
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
          const breakpoints = await manager.setBreakpoints(sessionPath, args.file, args.lines, extras)
          return { content: text({ breakpoints, session: manager.get(sessionPath) }), details: details(manager.get(sessionPath)) }
        }
        case 'control': {
          if (!args.control) throw new Error('control requires the control parameter (continue/pause/next/stepIn/stepOut)')
          const result = await manager.control(sessionPath, args.control, args.threadId, args.waitMs)
          return { content: text(result), details: details(result.session) }
        }
        case 'threads': {
          return { content: text(await manager.threads(sessionPath)), details: undefined }
        }
        case 'stack': {
          const threadId = args.threadId ?? manager.get(sessionPath).activeThreadId
          if (threadId === undefined) throw new Error('stack requires a threadId (or a prior stop)')
          return { content: text(await manager.stack(sessionPath, threadId, args.levels)), details: undefined }
        }
        case 'scopes': {
          if (args.frameId === undefined) throw new Error('scopes requires a frameId from stack')
          return { content: text(await manager.scopes(sessionPath, args.frameId)), details: undefined }
        }
        case 'variables': {
          if (args.variablesReference === undefined) throw new Error('variables requires a variablesReference')
          return { content: text(await manager.variables(sessionPath, args.variablesReference, args.start, args.count)), details: undefined }
        }
        case 'evaluate': {
          if (!args.expression) throw new Error('evaluate requires an expression')
          return { content: text(await manager.evaluate(sessionPath, args.expression, args.frameId)), details: undefined }
        }
        case 'output': {
          return { content: text(manager.output(sessionPath, args.cursor, args.maxChars)), details: undefined }
        }
        default:
          throw new Error(`Unknown debug action: ${String(args.action)}`)
      }
    }
  } satisfies ToolDefinition<typeof debugParameters>]
}
