/**
 * Tool-family grouping for Settings → Tools. A tool's family is the one the
 * registry *declares* — native MCP tools and historical adapter names, or a
 * declared namespace prefix (`ctx_*`, `browser_*`)
 * — and otherwise the extension that registers it, so a package whose tools
 * carry several prefixes or none at all still folds into ONE row (pi-lens:
 * `lens_*`, `ast_grep_*`, `read_symbol`, `lsp_navigation`).
 *
 * A leading `prefix_` segment is deliberately NOT a family on its own: that
 * rule scattered one extension across `lens`/`ast`/`read` and left the rest as
 * standalone rows. Prefix grouping stays a registry declaration, never a guess
 * about a name.
 *
 * Pure and order-preserving: families always render at the head of the list in
 * the order their first member appeared, and the standalone tools follow in
 * catalog order, so grouping never reshuffles what the main process returned
 * beyond lifting the families up.
 */

import { declaredToolFamily } from './tool-categories'

export interface ToolGroup<T> {
  kind: 'group'
  /** The family as it renders: a declared family key (`ctx`, `mcp`) or the
   * owning extension's label (`pi-lens`). */
  prefix: string
  tools: T[]
}

export interface ToolEntry<T> {
  kind: 'tool'
  tool: T
}

export type ToolListEntry<T> = ToolGroup<T> | ToolEntry<T>

/** Members needed before a shared family becomes a group (a lone member stays
 * a plain row — grouping one tool only adds a click). */
export const TOOL_GROUP_MIN_SIZE = 2

/**
 * The tool's owning extension as the catalog reports it, else `undefined`.
 *
 * Structural on purpose: the catalog's `ToolInfoDTO` satisfies it, and so does
 * a hand-built fixture. A disabled extension still names its tools (`source` is
 * the last definition that won), so its family keeps its identity while struck
 * through.
 */
export function extensionLabelOf(tool: {
  source: { kind: 'builtin' | 'extension'; label: string }
}): string | undefined {
  return tool.source.kind === 'extension' ? tool.source.label : undefined
}

/**
 * The family Settings → Tools folds a tool under: the one the registry declares
 * (which keeps its own key, so the MCP whole and `ctx_*`/`browser_*` read as
 * they always have), else the extension that owns it. `null` means standalone.
 */
export function toolGroupKey(name: string, extensionLabel?: string): string | null {
  // These are independent entry points. In SDK sessions the built-in extension
  // factories can share a source label, but that does not make their powers a
  // family with MCP (or with each other).
  if (name === 'codemode' || name === 'tool_search') return null
  return declaredToolFamily(name) ?? extensionLabel ?? null
}

export interface ToolListOptions<T> {
  /** The owning extension's label for a tool, when an extension owns it: one
   * extension is one family even when its tool names share nothing. */
  extensionOf?: (tool: T) => string | undefined
  minSize?: number
}

/** Collapse same-family tools into one entry each; every family leads the
 * list, so a large extension cannot push the grouped families down the page. */
export function buildToolList<T extends { name: string }>(
  tools: T[],
  options: ToolListOptions<T> = {}
): ToolListEntry<T>[] {
  const { extensionOf, minSize = TOOL_GROUP_MIN_SIZE } = options
  const familyOf = (tool: T): string | null => toolGroupKey(tool.name, extensionOf?.(tool))

  const buckets = new Map<string, T[]>()
  for (const tool of tools) {
    const family = familyOf(tool)
    if (!family) continue
    const bucket = buckets.get(family)
    if (bucket) bucket.push(tool)
    else buckets.set(family, [tool])
  }

  const families: ToolListEntry<T>[] = []
  const standalone: ToolListEntry<T>[] = []
  const emitted = new Set<string>()
  for (const tool of tools) {
    const family = familyOf(tool)
    const bucket = family ? buckets.get(family) : undefined
    if (!family || !bucket || bucket.length < minSize) {
      standalone.push({ kind: 'tool', tool })
      continue
    }
    if (emitted.has(family)) continue
    emitted.add(family)
    families.push({ kind: 'group', prefix: family, tools: bucket })
  }
  return [...families, ...standalone]
}

/** The group a tool belongs to, or null when it is a standalone row. */
export function groupPrefixOf<T extends { name: string }>(
  entries: ToolListEntry<T>[],
  name: string | undefined
): string | null {
  if (!name) return null
  for (const entry of entries) {
    if (entry.kind === 'group' && entry.tools.some((tool) => tool.name === name)) return entry.prefix
  }
  return null
}
