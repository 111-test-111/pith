/**
 * Tool-family grouping for Settings → Tools. A tool's "family" is the segment
 * before its first underscore (`ctx_execute` / `ctx_search` → `ctx`), which is
 * how extensions namespace large tool sets (`ctx_*`, `web_*`). Pure and
 * order-preserving: families always render at the head of the list in the
 * order their first member appeared, and the standalone tools follow in
 * catalog order, so grouping never reshuffles what the main process returned
 * beyond lifting the families up.
 */

export interface ToolGroup<T> {
  kind: 'group'
  prefix: string
  tools: T[]
}

export interface ToolEntry<T> {
  kind: 'tool'
  tool: T
}

export type ToolListEntry<T> = ToolGroup<T> | ToolEntry<T>

/** Members needed before a shared prefix becomes a group (a lone `bash_task`
 * stays a plain row — grouping one tool only adds a click). */
export const TOOL_GROUP_MIN_SIZE = 2

/** The leading `prefix_` segment of a namespaced tool name, else null. */
export function toolPrefix(name: string): string | null {
  const index = name.indexOf('_')
  if (index <= 0) return null
  return name.slice(0, index)
}

/** Collapse same-prefix tools into one entry each; every family leads the
 * list, so a large extension cannot push the grouped families down the page. */
export function buildToolList<T extends { name: string }>(
  tools: T[],
  minSize = TOOL_GROUP_MIN_SIZE
): ToolListEntry<T>[] {
  const buckets = new Map<string, T[]>()
  for (const tool of tools) {
    const prefix = toolPrefix(tool.name)
    if (!prefix) continue
    const bucket = buckets.get(prefix)
    if (bucket) bucket.push(tool)
    else buckets.set(prefix, [tool])
  }

  const families: ToolListEntry<T>[] = []
  const standalone: ToolListEntry<T>[] = []
  const emitted = new Set<string>()
  for (const tool of tools) {
    const prefix = toolPrefix(tool.name)
    const bucket = prefix ? buckets.get(prefix) : undefined
    if (!prefix || !bucket || bucket.length < minSize) {
      standalone.push({ kind: 'tool', tool })
      continue
    }
    if (emitted.has(prefix)) continue
    emitted.add(prefix)
    families.push({ kind: 'group', prefix, tools: bucket })
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
