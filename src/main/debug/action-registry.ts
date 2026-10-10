import { Type, type Static, type TObject, type TProperties } from 'typebox'
import { Check } from 'typebox/value'
import type { DebugCapabilitiesDTO, DebugPanelRequest, DebugSessionDTO } from '../../shared/types'
import { SANDBOX_ESCALATION_PROPERTIES } from '../sandbox/escalation'
import type { DebugManager } from './manager'
import { ToolFailure } from '../pi/tool-result'
import { debugResults } from './result-schema'
import { debugActionGuidance } from './usage'

const string = () => Type.String({ minLength: 1, maxLength: 8192 })
const int = () => Type.Integer({ minimum: 0 })
const optional = Type.Optional
const offset = () => Type.Integer({ minimum: -2_147_483_648, maximum: 2_147_483_647 })
const actionSchema = <A extends string, P extends TProperties>(action: A, properties: P) =>
  Type.Object({ action: Type.Literal(action), ...properties }, { additionalProperties: false })

const startSchema = actionSchema('start', {
  adapter: optional(string()), configuration: optional(string()),
  kind: optional(Type.Union([Type.Literal('launch'), Type.Literal('attach'), Type.Literal('core')])),
  coreFile: optional(string()), program: optional(string()), args: optional(Type.Array(Type.String())),
  cwd: optional(string()), env: optional(Type.Record(Type.String(), Type.String())),
  stopOnEntry: optional(Type.Boolean()), pid: optional(Type.Integer({ minimum: 1 })),
  breakpoints: optional(Type.Array(Type.Object({ file: string(), items: Type.Array(Type.Object({
    line: Type.Integer({ minimum: 1 }), condition: optional(Type.String()), hitCondition: optional(Type.String()),
    logMessage: optional(Type.String())
  }, { additionalProperties: false }), { maxItems: 500 }) }, { additionalProperties: false }), { maxItems: 100 })),
  functionBreakpoints: optional(Type.Array(Type.Object({ name: string(), condition: optional(Type.String()),
    hitCondition: optional(Type.String()) }, { additionalProperties: false }), { maxItems: 256 }))
})
export type DebugStartRequest = Static<typeof startSchema>

interface ActionPolicy {
  access: 'read' | 'execute'
  target: 'none' | 'session' | 'stopped'
  core: boolean
  capability?: keyof DebugCapabilitiesDTO
  /** New opaque-reference actions require both a target and a stop token. */
  pinned?: boolean
}
export interface DebugActionContext {
  manager: DebugManager
  sessionPath: string
  debugId?: string
  stopId?: number
  signal?: AbortSignal
  canStart?: () => boolean
  start?: (request: DebugStartRequest) => Promise<DebugSessionDTO>
  adapters?: (cwd?: string) => Promise<unknown>
  configurations?: (cwd?: string) => unknown
}
const read: ActionPolicy = { access: 'read', target: 'session', core: true }
const stopped: ActionPolicy = { ...read, target: 'stopped' }
const execute: ActionPolicy = { access: 'execute', target: 'session', core: false }
const none: ActionPolicy = { ...read, target: 'none' }

/** The schema, admission rules and handler travel together. Both the model and
 * IPC dispatcher enter here; adding an action never grows an unrelated bag. */
function define<S extends TObject, Result>(schema: S, policy: ActionPolicy, run: (context: DebugActionContext, request: Static<S>) => Result) {
  return { schema, policy, invoke(context: DebugActionContext, request: unknown): Result {
    if (!Check(schema, request)) throw new Error('Invalid debug action request')
    return run(context, request)
  } }
}

export const debugActions = {
  help: define(actionSchema('help', {
    topic: optional(Type.String({ minLength: 1, maxLength: 80, description: 'Action name for focused schemas and usage; omit to list all actions.' }))
  }), none, (_context, request) => debugHelp(request.topic)),
  sessions: define(actionSchema('sessions', {}), none, c => c.manager.list(c.sessionPath)),
  adapters: define(actionSchema('adapters', { cwd: optional(string()) }), { ...none, access: 'execute' }, (c, r) => {
    if (!c.adapters) throw new Error('Adapter discovery requires a model tool context')
    return c.adapters(r.cwd)
  }),
  configurations: define(actionSchema('configurations', { cwd: optional(string()) }), none, (c, r) => {
    if (!c.configurations) throw new Error('Configurations require a model tool context')
    return c.configurations(r.cwd)
  }),
  start: define(startSchema, { ...execute, target: 'none' }, (c, r) => {
    if (!c.start) throw new Error('Start requires a model tool context')
    return c.start(r)
  }),
  restart: define(actionSchema('restart', {}), execute, c => c.manager.restart(c.sessionPath, c.debugId, c.signal, c.canStart)),
  stop: define(actionSchema('stop', {}), { ...execute, core: true }, c => c.manager.stop(c.sessionPath, c.debugId)),
  wait: define(actionSchema('wait', {
    afterRevision: optional(Type.Integer({ minimum: 0, description: 'Previously observed revision of this debugId. Require a newer revision; omit to accept an already stopped target. Terminal targets always return immediately.' })),
    waitMs: optional(Type.Integer({ minimum: 0, maximum: 60_000, description: 'Passive observation deadline, default 10000 ms. 0 checks immediately; never resumes or stops the target.' })),
    until: optional(Type.Union([Type.Literal('stopped'), Type.Literal('changed')], { description: 'Default stopped: wait for a fully loaded stop or termination. changed: wait for any newer revision, even while running.' }))
  }), read, (c, r) => {
    if (!c.debugId) throw new ToolFailure('DEBUG_TARGET_REQUIRED', 'debugId is required for wait')
    return c.manager.wait(c.sessionPath, c.debugId, { ...r, signal: c.signal })
  }),
  breakpoints: define(actionSchema('breakpoints', {
    file: string(), items: Type.Array(Type.Object({ line: Type.Integer({ minimum: 1 }),
      condition: optional(Type.String()), hitCondition: optional(Type.String()), logMessage: optional(Type.String())
    }, { additionalProperties: false }), { maxItems: 500 })
  }), execute, async (c, r) => ({
    breakpoints: await c.manager.setBreakpoints(c.sessionPath, r.file, r.items.map(b => b.line), {
      conditions: r.items.map(b => b.condition ?? ''), hitConditions: r.items.map(b => b.hitCondition ?? ''), logMessages: r.items.map(b => b.logMessage ?? '')
    }, c.debugId), session: c.manager.get(c.sessionPath, c.debugId)
  })),
  'breakpoints.list': define(actionSchema('breakpoints.list', {}), read, c => c.manager.breakpoints(c.sessionPath, c.debugId)),
  'breakpoints.toggle': define(actionSchema('breakpoints.toggle', { file: string(), line: Type.Integer({ minimum: 1 }) }), execute,
    (c, r) => c.manager.toggleBreakpoint(c.sessionPath, r.file, r.line, c.manager.get(c.sessionPath, c.debugId).id)),
  control: define(actionSchema('control', {
    control: Type.Union(['continue', 'pause', 'next', 'stepIn', 'stepOut'].map(value => Type.Literal(value))),
    threadId: optional(int()), waitMs: optional(Type.Number({ minimum: 500, maximum: 120_000, description: 'Initial wait after sending control. Minimum 500 ms; use action=wait for a passive observation with waitMs=0.' })),
    granularity: optional(Type.Union([Type.Literal('statement'), Type.Literal('line'), Type.Literal('instruction')]))
  }), execute, (c, r) => c.manager.control(c.sessionPath, r.control as 'continue' | 'pause' | 'next' | 'stepIn' | 'stepOut', r.threadId, r.waitMs, c.debugId, c.stopId, r.granularity)),
  threads: define(actionSchema('threads', {}), read, c => c.manager.threads(c.sessionPath, c.debugId)),
  stack: define(actionSchema('stack', { threadId: optional(int()), levels: optional(Type.Integer({ minimum: 1, maximum: 100 })) }), stopped, (c, r) => {
    const thread = r.threadId ?? c.manager.get(c.sessionPath, c.debugId).activeThreadId
    if (thread === undefined) throw new Error('No stopped thread; pass threadId from threads')
    return c.manager.stack(c.sessionPath, thread, r.levels, c.debugId, c.stopId)
  }),
  scopes: define(actionSchema('scopes', { frameId: int() }), { ...stopped, pinned: true }, (c, r) => c.manager.scopes(c.sessionPath, r.frameId, c.debugId, c.stopId)),
  variables: define(actionSchema('variables', { variablesReference: int(), start: optional(int()), count: optional(Type.Integer({ minimum: 1, maximum: 500 })) }), { ...stopped, pinned: true },
    (c, r) => c.manager.variables(c.sessionPath, r.variablesReference, r.start, r.count, c.debugId, c.stopId)),
  evaluate: define(actionSchema('evaluate', { expression: string(), frameId: optional(int()), context: optional(Type.Union([Type.Literal('repl'), Type.Literal('watch')])) }),
    { ...execute, target: 'stopped' }, (c, r) => c.manager.evaluate(c.sessionPath, r.expression, r.frameId, c.debugId, c.stopId, r.context)),
  source: define(actionSchema('source', { sourceReference: Type.Integer({ minimum: 1 }), sourceVersion: int(),
    startLine: optional(Type.Integer({ minimum: 1 })), offset: optional(int()), limit: optional(Type.Integer({ minimum: 2, maximum: 32_768 })) }), { ...stopped, pinned: true },
    (c, r) => c.manager.source(c.sessionPath, r.sourceReference, r.sourceVersion, c.debugId!, c.stopId!, r.startLine, r.offset, r.limit)),
  disassemble: define(actionSchema('disassemble', { memoryReference: string(), offset: optional(offset()), instructionOffset: optional(offset()), count: optional(Type.Integer({ minimum: 1, maximum: 200 })) }),
    { ...stopped, pinned: true, capability: 'supportsDisassembleRequest' }, (c, r) => c.manager.disassemble(c.sessionPath, r.memoryReference, r.instructionOffset, r.count, c.debugId, c.stopId, r.offset)),
  'memory.read': define(actionSchema('memory.read', { memoryReference: string(), offset: optional(offset()), count: optional(Type.Integer({ minimum: 1, maximum: 4096 })) }),
    { ...stopped, pinned: true, capability: 'supportsReadMemoryRequest' }, (c, r) => c.manager.readMemory(c.sessionPath, r.memoryReference, r.offset, r.count, c.debugId, c.stopId)),
  modules: define(actionSchema('modules', { start: optional(int()), count: optional(Type.Integer({ minimum: 1, maximum: 100 })) }),
    { ...stopped, pinned: true, capability: 'supportsModulesRequest' }, (c, r) => c.manager.modules(c.sessionPath, r.start, r.count, c.debugId, c.stopId)),
  registers: define(actionSchema('registers', { frameId: int() }), { ...stopped, pinned: true }, async (c, r) =>
    (await c.manager.scopes(c.sessionPath, r.frameId, c.debugId, c.stopId)).filter(scope => scope.presentationHint === 'registers' || scope.name.toLowerCase() === 'registers')),
  'breakpoints.native': define(actionSchema('breakpoints.native', {}), read, c => c.manager.nativeBreakpoints(c.sessionPath, c.debugId)),
  'breakpoints.instruction': define(actionSchema('breakpoints.instruction', { items: Type.Array(Type.Object({
    instructionReference: string(), offset: optional(offset()), condition: optional(Type.String()), hitCondition: optional(Type.String())
  }, { additionalProperties: false }), { maxItems: 256 }) }),
    { ...execute, target: 'stopped', pinned: true, capability: 'supportsInstructionBreakpoints' }, (c, r) => c.manager.setInstructionBreakpoints(c.sessionPath, r.items, c.debugId!, c.stopId!)),
  'breakpoints.instruction.toggle': define(actionSchema('breakpoints.instruction.toggle', { instructionReference: string() }),
    { ...execute, target: 'stopped', pinned: true, capability: 'supportsInstructionBreakpoints' }, (c, r) => c.manager.toggleInstructionBreakpoint(c.sessionPath, r.instructionReference, c.debugId!, c.stopId!)),
  'breakpoints.instruction.update': define(actionSchema('breakpoints.instruction.update', { instructionReference: string(), offset: optional(offset()), enabled: Type.Boolean() }),
    { ...execute, target: 'stopped', pinned: true, capability: 'supportsInstructionBreakpoints' }, (c, r) => c.manager.updateInstructionBreakpoint(c.sessionPath, r.instructionReference, r.offset ?? 0, r.enabled, c.debugId!, c.stopId!)),
  'breakpoints.function': define(actionSchema('breakpoints.function', { items: Type.Array(Type.Object({
    name: string(), condition: optional(Type.String()), hitCondition: optional(Type.String())
  }, { additionalProperties: false }), { maxItems: 256 }) }),
    { ...execute, target: 'stopped', pinned: true, capability: 'supportsFunctionBreakpoints' }, (c, r) => c.manager.setFunctionBreakpoints(c.sessionPath, r.items, c.debugId, c.stopId)),
  'breakpoints.function.update': define(actionSchema('breakpoints.function.update', { name: string(), enabled: Type.Boolean() }),
    { ...execute, target: 'stopped', pinned: true, capability: 'supportsFunctionBreakpoints' }, (c, r) => c.manager.updateFunctionBreakpoint(c.sessionPath, r.name, r.enabled, c.debugId!, c.stopId!)),
  output: define(actionSchema('output', { cursor: optional(int()), maxChars: optional(Type.Integer({ minimum: 1, maximum: 65_536 })) }), read,
    (c, r) => c.manager.output(c.sessionPath, r.cursor, r.maxChars, c.debugId))
}
function debugHelp(topic?: string): unknown[] {
  if (topic !== undefined && !Object.hasOwn(debugActions, topic)) throw new Error(`Unknown debug help topic: ${topic}`)
  return Object.entries(debugActions).filter(([action]) => topic === undefined || action === topic)
    .map(([action, entry]) => ({ action, ...entry.policy, inputSchema: entry.schema,
      resultSchema: debugResults[action as DebugActionName].schema,
      guidelines: debugActionGuidance(action as DebugActionName) }))
}
export type DebugActionName = keyof typeof debugActions
export const debugParameters = Type.Object({
  debugId: optional(Type.String({ description: 'Target from sessions/start. Pin every targeted call when several targets are live.' })),
  stopId: optional(Type.Integer({ minimum: 0, description: 'Stop token from session; refresh references after every control.' })),
  request: Type.Union(Object.values(debugActions).map(entry => entry.schema)),
  ...SANDBOX_ESCALATION_PROPERTIES
}, { additionalProperties: false })

type Arguments = { debugId?: string; stopId?: number; sandbox_permissions?: unknown; justification?: unknown; request: Record<string, unknown> & { action: DebugActionName } }

/** SDK prepareArguments runs before schema validation. Keep direct callers on
 * the same path too. Legacy arrays are accepted only at this boundary. */
export function prepareDebugArguments(input: unknown): Arguments {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Expected debug request object')
  const raw = input as Record<string, unknown>
  let result: Record<string, unknown> = raw
  if (!('request' in raw)) {
    const { debugId, stopId, sandbox_permissions, justification, ...request } = raw
    if (request.action === 'breakpoints' && Array.isArray(request.lines)) {
      const lines = request.lines
      for (const key of ['conditions', 'hitConditions', 'logMessages']) {
        if (request[key] !== undefined && (!Array.isArray(request[key]) || request[key].length !== lines.length)) throw new Error(`${key} must be parallel to lines`)
      }
      request.items = lines.map((line, i) => ({ line,
        ...(Array.isArray(request.conditions) ? { condition: request.conditions[i] } : {}),
        ...(Array.isArray(request.hitConditions) ? { hitCondition: request.hitConditions[i] } : {}),
        ...(Array.isArray(request.logMessages) ? { logMessage: request.logMessages[i] } : {}) }))
      delete request.lines; delete request.conditions; delete request.hitConditions; delete request.logMessages
    }
    result = { ...(debugId !== undefined ? { debugId } : {}), ...(stopId !== undefined ? { stopId } : {}),
      ...(sandbox_permissions !== undefined ? { sandbox_permissions } : {}), ...(justification !== undefined ? { justification } : {}), request }
  }
  if (!Check(debugParameters, result)) throw new Error('Invalid debug arguments; use {debugId?, stopId?, request: {action, ...actionFields}}. Do not mix action parameters.')
  return result as Arguments
}

export async function dispatchDebugAction(context: DebugActionContext, request: unknown): Promise<unknown> {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('Missing debug action')
  const name = (request as { action?: unknown }).action
  if (typeof name !== 'string' || !Object.hasOwn(debugActions, name)) throw new Error('Unknown debug action')
  const entry = debugActions[name as DebugActionName]
  if (!Check(entry.schema, request)) throw new Error(`Invalid debug ${name} request`)
  const { target, core, capability, pinned } = entry.policy
  if ((pinned || name === 'evaluate' && (request as { frameId?: number }).frameId !== undefined) &&
      (!context.debugId || context.stopId === undefined)) throw new Error('debugId and stopId are required for this action')
  if (target !== 'none') {
    const session = context.manager.get(context.sessionPath, context.debugId)
    if (!core && session.kind === 'core') throw new Error('Core inspection cannot execute or change breakpoints')
    if (target === 'stopped') {
      if (session.status === 'terminated' || session.status === 'failed') throw new ToolFailure('DEBUG_SESSION_ENDED', 'The debug session has ended; start or restart it before inspection')
      if (session.status !== 'stopped') throw new ToolFailure('DEBUG_NOT_STOPPED', `Debug target is not stopped (status: ${session.status}); use wait before inspection`)
      if (context.stopId !== undefined && context.stopId !== session.stopId) throw new ToolFailure('DEBUG_STALE_STOP', 'Debug stop changed; refresh references')
    }
    if (capability && !session.capabilities?.[capability]) throw new Error(`Debug adapter does not support ${capability}`)
  }
  return entry.invoke(context, request)
}

export function dispatchDebugPanel(manager: DebugManager, input: DebugPanelRequest): Promise<unknown> {
  if (typeof input.debugId !== 'string' || !input.debugId || typeof input.sessionPath !== 'string') throw new Error('Missing debug target')
  const { sessionPath, debugId, stopId, ...request } = input
  const action = request.action === 'breakpoints' ? 'breakpoints.list' : request.action === 'breakpoint-toggle' ? 'breakpoints.toggle' : request.action
  if ((Object.hasOwn(debugActions, action) && debugActions[action as DebugActionName].policy.target === 'stopped' || action === 'control') && !Number.isSafeInteger(stopId)) throw new Error('Missing debug stop token')
  return dispatchDebugAction({ manager, sessionPath, debugId, stopId }, { ...request, action })
}
