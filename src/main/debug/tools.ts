import { Type } from 'typebox'
import type { AgentSessionServices, ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { DebugManager } from './manager'
import { detectDebugAdapters } from './adapters'
import { escalationHintMarker, planFileDenialMarker, SANDBOX_ESCALATION_PROPERTIES, sandboxDenialMarker } from '../sandbox/escalation'
import type { SandboxMode } from '../sandbox/types'
import type { DebugSessionDTO } from '../../shared/types'

export const DEBUG_TOOL_NAME = 'debug'
export const APP_DEBUG_TOOL_NAMES = [DEBUG_TOOL_NAME] as const

const DEBUG_GUIDELINES = [
  'Reach for the debugger when a program crashes, hangs, or corrupts state: attach or launch, set breakpoints, step, and read the real frames and variables instead of sprinkling print statements. Small deterministic reproducers are still faster with plain bash.',
  'One debug session per chat. Starting while one is active fails; stop the old session first.',
  'control actions (continue/next/stepIn/stepOut/pause) block until the debuggee stops again or waitMs expires. settled=true means a stop (or termination) was reached; settled=false means it is still running — use control again or inspect output instead of re-sending the same step.',
  'threads/stack/scopes/variables/evaluate require a stopped debuggee. stack gives frame ids, scopes give variablesReferences, variables expand one level per call. Values are truncated server-side (50 items per level, 256 chars per value, 2048 chars per evaluate result).',
  'breakpoints replaces the whole breakpoint set of one file: pass every line that should keep a breakpoint, not just the new ones. A breakpoint with verified=false did not bind — check the file path is absolute and matches the debuggee\'s sources.',
  'output pages the debug console with a cursor, like bash_task output.',
  'Launching or stopping a debuggee is process control: the session sandbox mode gates it, and read-only refuses it. The debuggee itself is never file-sandboxed — a debugger needs full process-inspection rights by design.',
  'When a debug session ends (stop, termination, crash), its status is terminal: start a fresh session instead of retrying control actions.'
]

const debugParameters = Type.Object({
  action: Type.Union([
    Type.Literal('adapters'),
    Type.Literal('start'),
    Type.Literal('stop'),
    Type.Literal('breakpoints'),
    Type.Literal('control'),
    Type.Literal('threads'),
    Type.Literal('stack'),
    Type.Literal('scopes'),
    Type.Literal('variables'),
    Type.Literal('evaluate'),
    Type.Literal('output')
  ], { description: 'adapters: list detected debug adapters. start: launch a program or attach to a pid. breakpoints: replace one file\'s breakpoints. control: continue/pause/next/stepIn/stepOut, blocking until the next stop. threads/stack/scopes/variables/evaluate: inspect a stopped debuggee. output: page the debug console. stop: end the session.' }),
  adapter: Type.Optional(Type.String({ description: 'start: adapter id from the adapters list (e.g. "lldb-dap", "debugpy", "dlv").' })),
  kind: Type.Optional(Type.Union([Type.Literal('launch'), Type.Literal('attach')], { description: 'start: default launch. attach requires pid.' })),
  program: Type.Optional(Type.String({ description: 'start (launch): absolute path of the binary/script/package to debug.' })),
  args: Type.Optional(Type.Array(Type.String(), { description: 'start (launch): debuggee arguments.' })),
  cwd: Type.Optional(Type.String({ description: 'start: debuggee working directory; defaults to the workspace.' })),
  env: Type.Optional(Type.Record(Type.String(), Type.String(), { description: 'start: extra environment variables for the debuggee.' })),
  stopOnEntry: Type.Optional(Type.Boolean({ description: 'start (launch): stop at the entry point before any user code runs.' })),
  pid: Type.Optional(Type.Integer({ description: 'start (attach): process id to attach to.' })),
  file: Type.Optional(Type.String({ description: 'breakpoints: absolute file path.' })),
  lines: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }), { description: 'breakpoints: complete line set for the file (replaces, not adds).' })),
  control: Type.Optional(Type.Union([
    Type.Literal('continue'), Type.Literal('pause'), Type.Literal('next'), Type.Literal('stepIn'), Type.Literal('stepOut')
  ], { description: 'control: the stepping action.' })),
  threadId: Type.Optional(Type.Integer({ description: 'control/stack: thread; defaults to the thread that last stopped.' })),
  waitMs: Type.Optional(Type.Number({ minimum: 500, maximum: 120_000, description: 'control: stop-wait budget in ms, default 10000. Expiry is not failure: settled=false means still running.' })),
  frameId: Type.Optional(Type.Integer({ description: 'scopes/evaluate: stack frame id from stack.' })),
  levels: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: 'stack: frame count cap, default 20.' })),
  variablesReference: Type.Optional(Type.Integer({ description: 'variables: reference from scopes or a parent variable.' })),
  expression: Type.Optional(Type.String({ description: 'evaluate: expression in the debuggee\'s language, evaluated in the selected frame.' })),
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
        case 'start': {
          if (signal?.aborted || !options.canStart()) throw new Error('Debug session cancelled before launch')
          await requireExecMode(toolCallId, args, signal)
          const kind = args.kind ?? 'launch'
          const dto = await manager.start({
            sessionId,
            sessionPath,
            cwd,
            adapterId: args.adapter ?? '',
            kind,
            ...(args.program !== undefined ? { program: args.program } : {}),
            ...(args.args !== undefined ? { args: args.args } : {}),
            ...(args.env !== undefined ? { env: args.env } : {}),
            ...(args.stopOnEntry !== undefined ? { stopOnEntry: args.stopOnEntry } : {}),
            ...(args.pid !== undefined ? { pid: args.pid } : {}),
            ...(options.runInTerminal() ? { runInTerminal: options.runInTerminal()! } : {})
          })
          return { content: text(dto), details: details(dto) }
        }
        case 'stop': {
          await requireExecMode(toolCallId, args, signal)
          const dto = await manager.stop(sessionPath)
          return { content: text(dto), details: details(dto) }
        }
        case 'breakpoints': {
          if (!args.file || !args.lines) throw new Error('breakpoints requires file and lines (the file\'s complete breakpoint set)')
          const breakpoints = await manager.setBreakpoints(sessionPath, args.file, args.lines)
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
          return { content: text(await manager.variables(sessionPath, args.variablesReference)), details: undefined }
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
