import { Type, type TSchema } from 'typebox'
import type { AgentToolResult } from '@earendil-works/pi-coding-agent'

export class ToolFailure extends Error {
  readonly code: string
  constructor(code: string, message: string) { super(message); this.code = code; this.name = 'ToolFailure' }
}

export const toolContentSchema = Type.Array(Type.Union([
  Type.Object({ type: Type.Literal('text'), text: Type.String() }),
  Type.Object({ type: Type.Literal('image'), data: Type.String(), mimeType: Type.String() })
]))

/** Text remains the model/transcript view. Scripts receive this explicit
 * envelope through the SDK's outputSchema/structuredContent projection. */
export function appToolOutputSchema(data: TSchema): TSchema {
  return Type.Union([
    Type.Object({ ok: Type.Literal(true), isError: Type.Literal(false), data, content: toolContentSchema }),
    Type.Object({ ok: Type.Literal(false), isError: Type.Literal(true),
      error: Type.Object({ code: Type.String(), message: Type.String() }),
      data: Type.Optional(data), content: toolContentSchema })
  ])
}

export function appToolResult<D>(result: AgentToolResult<D>, data?: unknown, error?: { code: string; message: string }): AgentToolResult<D> {
  return { ...result, isError: Boolean(error), structuredContent: {
    ok: !error, isError: Boolean(error), ...(error ? { error } : {}),
    ...(data === undefined ? {} : { data }), content: result.content
  } as unknown as NonNullable<AgentToolResult<D>['structuredContent']> }
}

export function appToolError(error: unknown): AgentToolResult<undefined> {
  const message = error instanceof Error ? error.message : String(error)
  return appToolResult({ content: [{ type: 'text', text: message }], details: undefined }, undefined,
    { code: error instanceof ToolFailure ? error.code : 'TOOL_FAILED', message })
}
