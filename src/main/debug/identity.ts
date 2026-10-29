import type { DebugCapabilitiesDTO, DebugSourceDTO } from '../../shared/types'

export const DEBUG_CAPABILITIES = [
  'supportsDisassembleRequest', 'supportsReadMemoryRequest', 'supportsInstructionBreakpoints',
  'supportsFunctionBreakpoints', 'supportsSteppingGranularity', 'supportsModulesRequest'
] as const satisfies readonly (keyof DebugCapabilitiesDTO)[]

export function debugCapabilities(raw: Record<string, unknown>): DebugCapabilitiesDTO {
  return Object.fromEntries(DEBUG_CAPABILITIES.map(key => [key, raw[key] === true])) as unknown as DebugCapabilitiesDTO
}

/** DAP source identity is not a filesystem existence heuristic. In particular,
 * LLDB's `binary\`symbol` paths identify adapter-owned assembly documents. */
export function debugSource(raw: unknown): DebugSourceDTO | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const source = raw as Record<string, unknown>
  const labels = {
    ...(typeof source.name === 'string' ? { name: source.name } : {}),
    ...(typeof source.origin === 'string' ? { origin: source.origin } : {}),
    ...(typeof source.presentationHint === 'string' ? { presentationHint: source.presentationHint } : {})
  }
  if (Number.isSafeInteger(source.sourceReference) && (source.sourceReference as number) > 0) {
    return { ...labels, kind: 'adapter', sourceReference: source.sourceReference as number,
      ...(typeof source.path === 'string' ? { path: source.path } : {}) }
  }
  return typeof source.path === 'string' && source.path.length > 0 ? { ...labels, kind: 'file', path: source.path } : undefined
}
