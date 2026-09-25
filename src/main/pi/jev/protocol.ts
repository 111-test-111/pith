import { Type, type Static } from 'typebox'
import { Check } from 'typebox/value'
import type { JevErrorCode, JevPreferences } from '../../../shared/types'

export const JEV_TOOL_NAME = 'jev_decide'
export const JEV_MODEL = 'jev-1.13.0'
export const JEV_MAX_BYTES = 64 * 1024
const text = () => Type.String({ minLength: 1, maxLength: 2000 })
const id = () => Type.String({ pattern: '^[A-Za-z][A-Za-z0-9_]{0,63}$' })
export const jevParameters = Type.Object({
  state: Type.String({ minLength: 1, maxLength: 32000, description: 'Only the evidence relevant to these questions. Plain text or serialized JSON; do not send credentials or entire conversations.' }),
  questions: Type.Record(id(), Type.Union([
    Type.Object({ type: Type.Literal('choice'), instructions: text(), criteria: Type.Record(id(), text(), { minProperties: 2, maxProperties: 32, additionalProperties: false }) }, { additionalProperties: false }),
    Type.Object({ type: Type.Literal('score'), instructions: text(), criteria: Type.Array(text(), { minItems: 2, maxItems: 10 }) }, { additionalProperties: false }),
    Type.Object({ type: Type.Literal('noul'), instructions: text(), criteria: Type.Optional(Type.Object({ true: text(), false: text() }, { additionalProperties: false })) }, { additionalProperties: false })
  ]), { minProperties: 1, maxProperties: 32, additionalProperties: false, description: 'Named independent questions about the same state. Ask one specific question per item or dimension.' })
}, { additionalProperties: false })
export type JevRequest = Static<typeof jevParameters>

export class JevError extends Error {
  constructor(readonly code: JevErrorCode) { super(`JEV_${code}`); this.name = 'JevError' }
}
export function parseJevRequest(value: unknown, preferences: JevPreferences): JevRequest {
  let serialized: string
  try { serialized = JSON.stringify(value) } catch { throw new JevError('invalid_input') }
  if (!Check(jevParameters, value)) throw new JevError('invalid_input')
  if (Buffer.byteLength(serialized, 'utf8') > JEV_MAX_BYTES || !value.state.trim()) throw new JevError('invalid_input')
  for (const question of Object.values(value.questions)) {
    if (!preferences[question.type]) throw new JevError('capability_disabled')
    if (!question.instructions.trim()) throw new JevError('invalid_input')
    if (question.criteria && Object.values(question.criteria).some(value => !value.trim())) throw new JevError('invalid_input')
  }
  // Snapshot caller-owned input before the first async boundary.
  return JSON.parse(serialized) as JevRequest
}
