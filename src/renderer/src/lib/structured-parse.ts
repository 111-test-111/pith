import { parse as parseJsonc, type ParseError } from 'jsonc-parser'
import { parseAllDocuments } from 'yaml'
import { parse as parseToml } from 'smol-toml'
import { XMLParser, XMLValidator } from 'fast-xml-parser'
import type { StructuredFormat, StructuredResult, StructuredValue } from '../../../shared/file-preview'

const MAX_NODES = 50000
const MAX_DEPTH = 128
const MAX_RECORDS = 20000
class ParseLimit extends Error {}

/** YAML aliases may be cyclic, and TOML dates/bigints are not JSON values.
 * Produce the finite, serializable tree the common viewer accepts. */
function normalize(input: unknown): StructuredValue {
  let nodes = 0
  const ancestors = new WeakSet<object>()
  const visit = (value: unknown, depth: number): StructuredValue => {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) throw new ParseLimit()
    if (value === null || value === undefined) return null
    if (typeof value === 'string' || typeof value === 'boolean') return value
    if (typeof value === 'number') return Number.isFinite(value) ? value : String(value)
    if (typeof value === 'bigint') return value.toString()
    if (value instanceof Date) return value.toISOString()
    if (typeof value !== 'object') throw new Error('invalid')
    if (ancestors.has(value)) throw new Error('invalid')
    ancestors.add(value)
    let result: StructuredValue
    if (Array.isArray(value)) result = value.map(item => visit(item, depth + 1))
    else result = Object.fromEntries(Object.entries(value).map(([key, child]) => [key, visit(child, depth + 1)]))
    ancestors.delete(value)
    return result
  }
  return visit(input, 0)
}

export function parseStructured(raw: string, format: StructuredFormat, truncated: boolean): StructuredResult {
  const text = raw.replace(/^\uFEFF/, '')
  if (truncated && format !== 'jsonl') return { error: 'tooLarge' }
  try {
    let value: unknown
    if (format === 'jsonl') {
      const lines = text.split(/\r?\n/)
      // The byte cap may cut the last record; only complete records survive.
      if (truncated && !text.endsWith('\n')) lines.pop()
      const records: unknown[] = []
      let capped = truncated
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].trim()) continue
        if (records.length === MAX_RECORDS) { capped = true; break }
        try { records.push(JSON.parse(lines[i])) } catch { return { error: 'invalid', line: i + 1 } }
      }
      return { value: normalize(records), records: records.length, truncated: capped }
    }
    if (format === 'jsonc') {
      const errors: ParseError[] = []
      value = parseJsonc(text, errors, { allowTrailingComma: true, disallowComments: false, allowEmptyContent: false })
      if (errors.length) return { error: 'invalid' }
    } else if (format === 'yaml') {
      const documents = parseAllDocuments(text)
      if (documents.some(document => document.errors.length > 0)) return { error: 'invalid' }
      const values = documents.map(document => document.toJS({ maxAliasCount: 50 }))
      value = values.length === 1 ? values[0] : values
    } else if (format === 'toml') value = parseToml(text)
    else {
      // Entity/DTD expansion is outside a read-only file tree's grammar.
      if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(text) || XMLValidator.validate(text) !== true) return { error: 'invalid' }
      value = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', ignoreDeclaration: true, ignorePiTags: true, parseTagValue: false, parseAttributeValue: false, processEntities: true }).parse(text)
    }
    return { value: normalize(value), truncated: false }
  } catch (error) { return { error: error instanceof ParseLimit ? 'tooLarge' : 'invalid' } }
}
