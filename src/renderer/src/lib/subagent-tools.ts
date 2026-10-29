import { SDK_BUILTIN_TOOL_NAMES, type ToolInfoDTO } from '../../../shared/types'
import { isMcpTool } from './tool-categories'
import { TOOL_GROUP_MIN_SIZE, toolGroupKey } from './tool-groups'

/**
 * Pure grouping for the subagent profile tool picker (Settings → Subagents).
 *
 * The universe is the shared tools catalog — SDK built-ins, app tools and
 * every extension tool, one row per name, exactly what Settings → Tools
 * shows — with two collapsible levels: the MCP section's tools (native,
 * historical adapter entry points and per-server names) collapse into ONE
 * family row exactly like an extension family, and one family inside
 * a section becomes one row with a tri-state checkbox that selects the whole
 * family or opens to pick members one by one. A family is the one the registry
 * declares (`ctx_*`, `browser_*`) or else the extension that owns the tool, so
 * an extension whose names share no prefix (pi-lens: `lens_*`, `ast_grep_*`,
 * `read_symbol`, `lsp_navigation`) is one row rather than several.
 * When no live session exists to read a catalog from, the SDK built-ins alone
 * stand in so the editor still works.
 *
 * Names a profile already carries that the current universe does not register
 * are never dropped silently: they surface in their own group and survive a
 * save unchanged.
 */

/** MCP tools share a visual section, but each has an independent grant.
 * The category includes historical adapter names for saved profiles. */
export const isMcpToolName = isMcpTool

/** One picker row. `names` remains an array for the selection machinery. */
export interface SubagentToolOption {
  names: string[]
  label: string
  /** Extension/package label for extension tools. */
  meta?: string
}

/** One expanded family inside a section. */
export interface SubagentToolFamily {
  kind: 'family'
  /** The family as it renders: a declared family key (`ctx`) or the owning
   * extension's label (`pi-lens`). */
  prefix: string
  options: SubagentToolOption[]
}

/** One plain row inside a section. */
export interface SubagentToolRow {
  kind: 'option'
  option: SubagentToolOption
}

export type SubagentToolEntry = SubagentToolFamily | SubagentToolRow

export interface SubagentToolGroups {
  /** The whole MCP section as one collapsible family (native, historical
   * adapter and per-server names stay individual grants inside it). */
  mcp: SubagentToolEntry[]
  builtin: SubagentToolEntry[]
  extension: SubagentToolEntry[]
  /** Profile-carried names no current session registers (preserved on save). */
  unknown: SubagentToolEntry[]
}

/**
 * Nest same-family tools into one entry per family, IN PLACE: the first member
 * of a family emits the family entry (holding its members in their existing
 * relative order) and the rest are skipped. Unlike Settings → Tools' list,
 * which lifts families to the head of an otherwise unsorted catalog, every
 * section here is already ordered by the SDK's own built-in order and by name
 * — so nesting where the family already sits keeps the canonical CSV order
 * byte-identical to the pre-family output and repeated saves never churn.
 */
export function toToolEntries(
  options: SubagentToolOption[],
  minSize = TOOL_GROUP_MIN_SIZE
): SubagentToolEntry[] {
  const buckets = new Map<string, SubagentToolOption[]>()
  for (const option of options) {
    const prefix = familyOf(option)
    if (!prefix) continue
    const bucket = buckets.get(prefix)
    if (bucket) bucket.push(option)
    else buckets.set(prefix, [option])
  }
  const entries: SubagentToolEntry[] = []
  const emitted = new Set<string>()
  for (const option of options) {
    const prefix = familyOf(option)
    const bucket = prefix ? buckets.get(prefix) : undefined
    if (!prefix || !bucket || bucket.length < minSize) {
      entries.push({ kind: 'option', option })
      continue
    }
    if (emitted.has(prefix)) continue
    emitted.add(prefix)
    entries.push({ kind: 'family', prefix, options: bucket })
  }
  return entries
}

/** The family a single-name row belongs to: the one the registry declares,
 * else the extension that owns it. MCP options skip this family operation. */
function familyOf(option: SubagentToolOption): string | null {
  const name = option.names[0]
  if (option.names.length !== 1 || !name) return null
  return toolGroupKey(name, option.meta)
}

/** Every option an entry list carries, in render order. */
export function optionsOf(entries: SubagentToolEntry[]): SubagentToolOption[] {
  return entries.flatMap((entry) => (entry.kind === 'family' ? entry.options : [entry.option]))
}

const byLabel = (a: SubagentToolOption, b: SubagentToolOption) => a.label.localeCompare(b.label)

function mcpNamesOf(universe: ToolInfoDTO[], profileTools: 'all' | string[]): string[] {
  const names = new Set<string>()
  for (const tool of universe) {
    if (isMcpToolName(tool.name)) names.add(tool.name)
  }
  if (profileTools !== 'all') {
    for (const name of profileTools) {
      if (isMcpToolName(name)) names.add(name)
    }
  }
  // Historical adapter entry points first, then resource tools and per-server
  // tools. A stable order prevents profile CSV churn across refreshes.
  return [...names].sort((a, b) => {
    const rank = (name: string) =>
      name === 'mcp' ? 0 : name === 'mcpScript' ? 1 :
      name === 'list_mcp_resources' ? 2 : name === 'list_mcp_resource_templates' ? 3 :
      name === 'read_mcp_resource' ? 4 : 5
    return rank(a) - rank(b) || a.localeCompare(b)
  })
}

/** Build the picker groups for one profile against a tool universe. */
export function subagentToolGroups(universe: ToolInfoDTO[], profileTools: 'all' | string[]): SubagentToolGroups {
  const builtin = new Map<string, SubagentToolOption>()
  const extension = new Map<string, SubagentToolOption>()
  const known = new Set<string>()

  const offer = (name: string, meta?: string): void => {
    if (isMcpToolName(name) || known.has(name)) return
    known.add(name)
    const entry: SubagentToolOption = { names: [name], label: name, ...(meta ? { meta } : {}) }
    if (SDK_BUILTIN_TOOL_NAMES.includes(name) || !meta) builtin.set(name, entry)
    else extension.set(name, entry)
  }

  for (const tool of universe) offer(tool.name, tool.source.kind === 'extension' ? tool.source.label : undefined)
  // A catalog-less host still offers the SDK built-ins, so the editor works.
  if (universe.length === 0) for (const name of SDK_BUILTIN_TOOL_NAMES) offer(name)

  const mcpNames = mcpNamesOf(universe, profileTools)
  for (const name of mcpNames) known.add(name)

  const unknown: SubagentToolOption[] = []
  if (profileTools !== 'all') {
    for (const name of profileTools) {
      if (!known.has(name)) unknown.push({ names: [name], label: name })
    }
  }

  const mcpOptions = mcpNames.map((name) => ({ names: [name], label: name }))

  return {
    // The whole MCP section collapses into ONE family row, exactly like an
    // extension family: a tri-state checkbox selects every server in one
    // gesture, and the disclosure opens the still-independent per-tool grants.
    mcp: mcpOptions.length ? [{ kind: 'family', prefix: 'mcp', options: mcpOptions }] : [],
    builtin: toToolEntries(
      [...builtin.values()].sort(
        (a, b) =>
          SDK_BUILTIN_TOOL_NAMES.indexOf(a.label) - SDK_BUILTIN_TOOL_NAMES.indexOf(b.label) ||
          a.label.localeCompare(b.label)
      )
    ),
    extension: toToolEntries([...extension.values()].sort(byLabel)),
    unknown: toToolEntries(unknown)
  }
}

/** Every concrete tool name the groups can write, in canonical CSV order:
 * SDK built-ins first, then extension tools, then each MCP tool, then
 * profile-carried unknowns — a stable order so repeated saves don't churn. */
export function canonicalToolNames(groups: SubagentToolGroups): string[] {
  return [
    ...optionsOf(groups.builtin).flatMap((option) => option.names),
    ...optionsOf(groups.extension).flatMap((option) => option.names),
    ...optionsOf(groups.mcp).flatMap((option) => option.names),
    ...optionsOf(groups.unknown).flatMap((option) => option.names)
  ]
}

/** Order-insensitive comparison of two tool lists. */
export function sameTools(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const sorted = [...a].sort()
  const against = [...b].sort()
  return sorted.every((name, index) => name === against[index])
}
