import { SDK_BUILTIN_TOOL_NAMES, type ToolInfoDTO } from '../../../shared/types'

/**
 * Pure grouping for the subagent profile tool picker (Settings → Subagents).
 *
 * The universe is the shared tools catalog — SDK built-ins, app tools and
 * every extension tool, one row per name, exactly what Settings → Tools
 * shows — with one deliberate collapse: the MCP family (the `mcp` gateway,
 * `mcpScript` and every `mcp__<server>` proxy) answers ONE checkbox, because
 * the gateway alone reaches every server. When no live session exists to read
 * a catalog from, the SDK built-ins alone stand in so the editor still works.
 *
 * Names a profile already carries that the current universe does not register
 * are never dropped silently: they surface in their own group and survive a
 * save unchanged.
 */

/** MCP counts as one whole: the gateway, its scripting wrapper and every
 * per-server proxy share a single picker entry. */
export function isMcpToolName(name: string): boolean {
  return name === 'mcp' || name === 'mcpScript' || name.startsWith('mcp__')
}

/** One picker row. `names` has more than one member only for the MCP family. */
export interface SubagentToolOption {
  names: string[]
  label: string
  /** Extension/package label for extension tools. */
  meta?: string
}

export interface SubagentToolGroups {
  /** The single MCP entry, or null when no family member exists anywhere. */
  mcp: SubagentToolOption | null
  builtin: SubagentToolOption[]
  extension: SubagentToolOption[]
  /** Profile-carried names no current session registers (preserved on save). */
  unknown: SubagentToolOption[]
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
  // Gateway first, then the wrapper, then per-server proxies alphabetically.
  return [...names].sort((a, b) => {
    const rank = (name: string) => (name === 'mcp' ? 0 : name === 'mcpScript' ? 1 : 2)
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

  return {
    mcp: mcpNames.length ? { names: mcpNames, label: 'MCP' } : null,
    builtin: [...builtin.values()].sort(
      (a, b) =>
        SDK_BUILTIN_TOOL_NAMES.indexOf(a.label) - SDK_BUILTIN_TOOL_NAMES.indexOf(b.label) ||
        a.label.localeCompare(b.label)
    ),
    extension: [...extension.values()].sort(byLabel),
    unknown
  }
}

/** Every concrete tool name the groups can write, in canonical CSV order:
 * SDK built-ins first, then extension tools, then the MCP family, then
 * profile-carried unknowns — a stable order so repeated saves don't churn. */
export function canonicalToolNames(groups: SubagentToolGroups): string[] {
  return [
    ...groups.builtin.flatMap((option) => option.names),
    ...groups.extension.flatMap((option) => option.names),
    ...(groups.mcp?.names ?? []),
    ...groups.unknown.flatMap((option) => option.names)
  ]
}

/** Order-insensitive comparison of two tool lists. */
export function sameTools(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const sorted = [...a].sort()
  const against = [...b].sort()
  return sorted.every((name, index) => name === against[index])
}
