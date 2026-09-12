/**
 * Flattens a tool's JSON Schema (TypeBox) parameters into rows for
 * Settings → Tools. Pure formatting — no UI primitives — ported from the
 * pi-web tool definitions panel so both clients read a schema the same way.
 */

export interface ToolParameterField {
  name: string
  type: string
  description?: string
  required: boolean
  allowedValues?: string
  defaultValue?: string
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined) return ''
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export function formatSchemaType(schema: Record<string, unknown>): string {
  const variants = Array.isArray(schema.anyOf)
    ? schema.anyOf
    : Array.isArray(schema.oneOf)
      ? schema.oneOf
      : null
  if (variants) {
    return variants
      .map((variant) =>
        variant && typeof variant === 'object'
          ? formatSchemaType(variant as Record<string, unknown>)
          : 'unknown'
      )
      .filter((value, index, values) => values.indexOf(value) === index)
      .join(' | ')
  }

  if (schema.const !== undefined) return formatValue(schema.const)
  if (Array.isArray(schema.enum) && schema.enum.length > 0 && schema.type === undefined) {
    return [...new Set(schema.enum.map((value) => (value === null ? 'null' : typeof value)))].join(
      ' | '
    )
  }

  const rawType = schema.type
  const type = Array.isArray(rawType)
    ? rawType.filter((value): value is string => typeof value === 'string').join(' | ')
    : typeof rawType === 'string'
      ? rawType
      : typeof schema.$ref === 'string'
        ? (schema.$ref.split('/').pop() ?? 'object')
        : 'unknown'

  if (type === 'array') {
    const items = schema.items
    const itemType =
      items && typeof items === 'object'
        ? formatSchemaType(items as Record<string, unknown>)
        : 'unknown'
    return `${itemType}[]`
  }
  return type
}

/** One row per top-level property of the tool's parameter object schema. */
export function getToolParameterFields(
  parameters?: Record<string, unknown>
): ToolParameterField[] {
  const properties = parameters?.properties
  if (!properties || typeof properties !== 'object') return []
  const required = new Set(
    Array.isArray(parameters?.required)
      ? parameters.required.filter((value): value is string => typeof value === 'string')
      : []
  )

  return Object.entries(properties as Record<string, unknown>).map(([name, value]) => {
    const schema = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
    return {
      name,
      type: formatSchemaType(schema),
      description: typeof schema.description === 'string' ? schema.description : undefined,
      required: required.has(name),
      allowedValues: Array.isArray(schema.enum) ? schema.enum.map(formatValue).join(', ') : undefined,
      defaultValue: schema.default === undefined ? undefined : formatValue(schema.default)
    }
  })
}
