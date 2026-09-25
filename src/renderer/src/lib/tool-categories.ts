import { Compass, Database, Diff, GoogleChromeLogo, SquareTerminal, type IconComponent } from '@/lib/icons'
import type { MessageKey } from '@/i18n/locales/en'

/**
 * Systematic tool → category mapping. The transcript groups *consecutive* calls
 * that share a category into one collapsed row (see `ToolGroupView`), so this
 * registry is the single place that decides which tools read as one activity.
 *
 * Adding a category = append one entry below (icon + i18n label key + tools).
 * A category can opt in exact tool names through `tools` and, for a namespaced
 * family, every matching name through `prefix`. Tools matching neither render
 * as standalone rows, exactly as before.
 */
export type ToolCategoryId = 'exploration' | 'terminal' | 'changes' | 'context' | 'browser'

export interface ToolCategory {
  id: ToolCategoryId
  /** i18n key for the collapsed group's label ("Exploration"). */
  labelKey: MessageKey
  icon: IconComponent
  /** Exact tool names as the agent calls them (SDK built-ins + extensions). */
  tools: readonly string[]
  /** Optional namespace prefix, including its separator (for example `ctx_`). */
  prefix?: string
}

export const TOOL_CATEGORIES: readonly ToolCategory[] = [
  {
    id: 'exploration',
    labelKey: 'tool.categoryExploration',
    icon: Compass,
    tools: ['read', 'find', 'grep', 'ffgrep', 'fffind', 'ls', 'web_search', 'web_fetch']
  },
  {
    id: 'terminal',
    labelKey: 'tool.categoryTerminal',
    icon: SquareTerminal,
    tools: ['bash', 'bash_task', 'powershell']
  },
  {
    id: 'changes',
    labelKey: 'tool.categoryChanges',
    icon: Diff,
    tools: ['edit', 'write']
  },
  {
    id: 'context',
    labelKey: 'tool.categoryContext',
    icon: Database,
    prefix: 'ctx_',
    tools: [
      'ctx_execute', 'ctx_execute_file', 'ctx_batch_execute', 'ctx_index',
      'ctx_fetch_and_index', 'ctx_search', 'ctx_stats', 'ctx_doctor',
      'ctx_purge', 'ctx_insight', 'ctx_upgrade'
    ]
  },
  {
    id: 'browser',
    labelKey: 'tool.categoryBrowser',
    icon: GoogleChromeLogo,
    prefix: 'browser_',
    // The embedded-browser agent tools (src/main/browser/tools.ts's
    // APP_BROWSER_TOOL_NAMES, copied as literals — renderer code does not
    // import from src/main).
    tools: [
      'browser_navigate', 'browser_pages', 'browser_focus', 'browser_snapshot',
      'browser_click', 'browser_type', 'browser_press_key', 'browser_scroll',
      'browser_wait_for', 'browser_screenshot', 'browser_close', 'browser_hover',
      'browser_select', 'browser_upload'
    ]
  }
]

const CATEGORY_BY_TOOL = new Map<string, ToolCategory>(
  TOOL_CATEGORIES.flatMap((category) =>
    category.tools.map((tool) => [tool, category] as const)
  )
)
const PREFIXED_CATEGORIES = TOOL_CATEGORIES.filter(
  (category): category is ToolCategory & { prefix: string } => Boolean(category.prefix)
)

/** The category a tool belongs to, or `undefined` for an uncategorized tool. */
export function toolCategory(name: string): ToolCategory | undefined {
  return CATEGORY_BY_TOOL.get(name)
    ?? PREFIXED_CATEGORIES.find((category) => name.startsWith(category.prefix))
}

/** One maximal run of adjacent calls sharing a category. */
export interface ToolCategoryRun<T> {
  /** `undefined` for a run of uncategorized calls; two of those never merge. */
  category?: ToolCategory
  items: T[]
}

/**
 * Splits an ordered list of tool calls into runs of *adjacent* calls with the
 * same category. Only same-category neighbours merge: a `grep` followed by a
 * `bash`, or any call separated by reasoning/text, ends the run. Uncategorized
 * calls produce singleton runs and are never grouped by the caller.
 */
export function splitByToolCategory<T extends { name: string }>(
  calls: readonly T[]
): ToolCategoryRun<T>[] {
  const runs: ToolCategoryRun<T>[] = []
  for (const call of calls) {
    const category = toolCategory(call.name)
    const last = runs[runs.length - 1]
    if (category && last && last.category === category) last.items.push(call)
    else runs.push({ category, items: [call] })
  }
  return runs
}
