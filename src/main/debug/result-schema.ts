import { Type, type TSchema, type TObject } from 'typebox'
import type { DebugActionName } from './action-registry'
import { appToolOutputSchema } from '../pi/tool-result'

const s = Type.String(), n = Type.Number(), b = Type.Boolean(), opt = Type.Optional
const source = Type.Union([
  Type.Object({ kind: Type.Literal('file'), path: s }),
  Type.Object({ kind: Type.Literal('adapter'), sourceReference: n, path: opt(s), name: opt(s) })
])
const location = { file: opt(s), source: opt(source), instructionPointerReference: opt(s), moduleId: opt(Type.Union([s, n])), line: opt(n), column: opt(n), name: opt(s) }
const session = Type.Object({
  id: s, sessionId: s, sessionPath: s, adapterId: s, adapterLabel: s, target: s,
  kind: Type.Union(['launch', 'attach', 'core'].map(v => Type.Literal(v))),
  status: Type.Union(['starting', 'running', 'stopped', 'terminated', 'failed'].map(v => Type.Literal(v))),
  stopId: n, revision: n, sourceVersion: opt(n), activeThreadId: opt(n),
  parentId: opt(s), replacesId: opt(s), name: opt(s),
  stopReason: opt(s), stopDescription: opt(s), stopText: opt(s), stopDiagnostics: opt(s), conditionError: opt(b),
  hitBreakpointIds: opt(Type.Array(n)), location: opt(Type.Object(location)),
  capabilities: opt(Type.Object(Object.fromEntries([
    'supportsConfigurationDoneRequest', 'supportsConditionalBreakpoints', 'supportsHitConditionalBreakpoints', 'supportsLogPoints',
    'supportsEvaluateForHovers', 'supportsSetVariable', 'supportsRestartRequest', 'supportsTerminateRequest',
    'supportsDisassembleRequest', 'supportsReadMemoryRequest', 'supportsInstructionBreakpoints', 'supportsFunctionBreakpoints',
    'supportsSteppingGranularity', 'supportsModulesRequest'
  ].map(key => [key, opt(b)])))),
  startedAt: n, endedAt: opt(n), outputChars: n, lastOutputAt: opt(n), error: opt(s)
})
const binding = { id: opt(n), verified: b, message: opt(s), conditionStatus: opt(s), conditionError: opt(s) }
const breakpoint = Type.Object({ ...binding, file: s, line: n, requestedLine: opt(n), condition: opt(s), hitCondition: opt(s), logMessage: opt(s) })
const native = Type.Object({
  instruction: Type.Array(Type.Object({ ...binding, instructionReference: s, offset: opt(n), condition: opt(s), hitCondition: opt(s), boundInstructionReference: opt(s), boundOffset: opt(n) })),
  function: Type.Array(Type.Object({ ...binding, name: s, condition: opt(s), hitCondition: opt(s) }))
})
const scope = Type.Object({ name: s, variablesReference: n, expensive: opt(b), presentationHint: opt(s), namedVariables: opt(n), indexedVariables: opt(n) })
const variable = Type.Object({ name: s, value: s, type: opt(s), variablesReference: n, namedVariables: opt(n), indexedVariables: opt(n), memoryReference: opt(s), evaluateName: opt(s) })
const wrapped = (field: string, schema: TSchema) => ({ field, schema: Type.Object({ [field]: schema }) })
const object = (schema: TObject) => ({ field: null, schema })
const sessionResult = wrapped('session', session)
const nativeResult = object(native)

/** Array actions have named fields; object actions keep their named fields.
 * Completeness is checked against the action registry at compile time. */
export const debugResults = {
  help: wrapped('actions', Type.Array(Type.Object({ action: s, access: s, target: s, core: b, capability: opt(s), pinned: opt(b), inputSchema: Type.Object({}), resultSchema: Type.Object({}), guidelines: Type.Array(s) }))),
  sessions: wrapped('sessions', Type.Array(session, { description: 'Owned live targets plus bounded ended history. starting/running/stopped are live; terminated/failed are ended.' })),
  adapters: wrapped('adapters', Type.Array(Type.Object({ id: s, label: s, languages: Type.Array(s), available: b, detail: opt(s) }))),
  configurations: wrapped('configurations', Type.Array(Type.Object({ name: s, adapterId: s, kind: s, program: opt(s), cwd: opt(s), extraKeys: Type.Array(s) }))),
  start: sessionResult, restart: sessionResult, stop: sessionResult,
  wait: object(Type.Object({ session, revision: n,
    settled: Type.Boolean({ description: 'Target is stopped with top-frame loading complete, or terminal. Independent of whether the wait timed out.' }),
    timedOut: Type.Boolean({ description: 'The deadline expired before the wait condition was observed. Can be true together with settled.' }),
    changed: Type.Boolean({ description: 'Revision is newer than afterRevision, or than the revision at admission if omitted.' }) })),
  control: object(Type.Object({ session, settled: b })),
  threads: wrapped('threads', Type.Array(Type.Object({ id: n, name: s }))),
  stack: wrapped('frames', Type.Array(Type.Object({ ...location, id: n, name: s }))),
  scopes: wrapped('scopes', Type.Array(scope)), registers: wrapped('scopes', Type.Array(scope)),
  variables: object(Type.Object({ variables: Type.Array(variable), truncated: b })),
  evaluate: object(Type.Object({ result: s, type: opt(s), variablesReference: n, namedVariables: opt(n), indexedVariables: opt(n), memoryReference: opt(s) })),
  source: object(Type.Object({ debugId: s, sourceReference: n, sourceVersion: n, content: s, mimeType: opt(s), truncated: b,
    offset: opt(n), nextOffset: opt(n), totalChars: opt(n), startLine: opt(n), previousOffset: opt(n), continuedLine: opt(b) })),
  disassemble: object(Type.Object({ memoryReference: s, instructionOffset: n, instructions: Type.Array(Type.Object({ address: s, instruction: s, instructionBytes: opt(s), symbol: opt(s), source: opt(source), line: opt(n), presentationHint: opt(s) })) })),
  'memory.read': object(Type.Object({ address: s, data: s, hex: s, bytesRead: n, requestedCount: n, unreadableBytes: n, truncated: b })),
  modules: object(Type.Object({ modules: Type.Array(Type.Object({ id: Type.Union([s, n]), name: s, path: opt(s), addressRange: opt(s), symbolStatus: opt(s), symbolFilePath: opt(s), version: opt(s) })), totalModules: opt(n), truncated: b })),
  breakpoints: object(Type.Object({ session, breakpoints: Type.Array(breakpoint) })),
  'breakpoints.list': wrapped('breakpoints', Type.Array(breakpoint)),
  'breakpoints.toggle': wrapped('breakpoints', Type.Array(breakpoint)),
  'breakpoints.native': nativeResult, 'breakpoints.instruction': nativeResult,
  'breakpoints.instruction.toggle': nativeResult, 'breakpoints.instruction.update': nativeResult,
  'breakpoints.function': nativeResult, 'breakpoints.function.update': nativeResult,
  output: object(Type.Object({ session, output: s, cursor: n, truncated: b }))
} satisfies Record<DebugActionName, { field: string | null; schema: TSchema }>

export const debugOutputSchema = appToolOutputSchema(Type.Union(Object.entries(debugResults).map(([action, entry]) =>
  Type.Object({ action: Type.Literal(action), ...entry.schema.properties }))))

export function debugResultData(action: DebugActionName, value: unknown) {
  const { field } = debugResults[action]
  return { action, ...(field ? { [field]: value } : value as Record<string, unknown>) }
}
