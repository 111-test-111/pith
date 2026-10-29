import {
  ArrowDownUp,
  BookOpenCheck,
  Bug,
  CalendarCheck,
  Camera,
  CircleHelp,
  CloudDownload,
  Codesandbox,
  Columns3Cog,
  Compass,
  CoPresent,
  Edit02,
  FolderSearch,
  FolderTree,
  Gavel,
  Globe,
  Image,
  Keyboard,
  Layers,
  ListChecks,
  MessageSquareText,
  MousePointer2,
  MousePointerClick,
  NotebookPen,
  Plug,
  QuillWrite,
  ScanSearch,
  ScanText,
  Search,
  Selection,
  Send,
  SourceCodeCircle,
  SquareArrowOutUpRight,
  Subagent,
  Terminal,
  Timer,
  Upload,
  Wrench,
  XSquare,
  type IconComponent
} from '@/lib/icons'
import { cn } from '@/lib/utils'

/**
 * Systematic tool → icon mapping for every place a tool is listed in the UI
 * (transcript rows, file-diff headers, Settings → Tools). It is keyed by the
 * exact tool name the agent calls.
 *
 * The mapping is exhaustive for the tools that exist today: the SDK's built-ins
 * plus what the bundled extensions register (`@tavily/pi-extension`,
 * native MCP/codemode, `@ff-labs/pi-fff`, `context-mode`, `pi-lens`). Everything
 * else — a tool a new extension registers after this list was written — falls
 * back to the wrench, until it gets an explicit entry here. MCP namespaces are
 * the one exception, handled by prefix below.
 *
 * Two bundled extensions deliberately collapse to one glyph for the whole
 * family instead of one glyph per tool: context-mode (`ctx_*`) and pi-lens.
 * Their rows read as one activity, and a single mapping point keeps that
 * promise cheap to hold.
 */
const TOOL_ICONS: Record<string, IconComponent> = {
  // Built-in file + shell tools. The shell rows use the plain `Terminal` glyph;
  // the terminal *category* group keeps the boxed `SquareTerminal` (see
  // lib/tool-categories.ts), so a folded run and its rows are distinguishable.
  bash: Terminal,
  bash_task: Terminal,
  // A submitted plan wears the plan mode's own control glyph, so the tool row
  // matches the composer button that switched the session into plan mode.
  submit_plan: NotebookPen,
  todo_write: ListChecks,
  get_goal: Compass,
  update_goal: Compass,
  present: CoPresent,
  // The app's image tool paints a picture rather than declaring one, so it
  // takes the image glyph instead of `present`'s co-present one.
  image: Image,
  scheduled_task: CalendarCheck,
  jev_decide: Gavel,
  ask_user_question: CircleHelp,
  agent: Subagent,
  // Subagent communications (Settings → Subagents): the parent steering a
  // running child is a send; a child's message up to its parent is the
  // text-filled speech bubble.
  agent_steer: Send,
  message_parent: MessageSquareText,
  // The DAP debugger's row glyph (Settings → General enables the tool).
  debug: Bug,
  powershell: Terminal,
  read: BookOpenCheck,
  edit: Edit02,
  write: QuillWrite,
  grep: Search,
  find: FolderSearch,
  ls: FolderTree,
  // pi-fff (indexed search): the `ff`-prefixed variants of grep/find wear the
  // SAME glyphs as the built-ins they replace, so an indexed search reads as a
  // search; the combined multigrep (named `fff-multi-grep`, or `multi_grep` in
  // override mode) keeps a glyph of its own.
  ffgrep: Search,
  fffind: FolderSearch,
  'fff-multi-grep': ScanSearch,
  multi_grep: ScanSearch,
  // Tavily web tools.
  web_search: Globe,
  web_fetch: CloudDownload,
  // context-mode: one family glyph for the sandbox-execution + knowledge-base
  // tools. Every `ctx_*` row wears the same cog, so the family reads as one
  // activity and no row claims a job of its own by artwork. The transcript's
  // folded `context` group draws the same glyph (lib/tool-categories.ts).
  ctx_execute: Columns3Cog,
  ctx_execute_file: Columns3Cog,
  ctx_batch_execute: Columns3Cog,
  ctx_index: Columns3Cog,
  ctx_fetch_and_index: Columns3Cog,
  ctx_search: Columns3Cog,
  ctx_stats: Columns3Cog,
  ctx_doctor: Columns3Cog,
  ctx_purge: Columns3Cog,
  ctx_insight: Columns3Cog,
  ctx_upgrade: Columns3Cog,
  // pi-lens (code feedback): one family glyph as well. The extension ships
  // `lens_*`, `ast_grep_*`, `read_symbol` and `lsp_navigation`, and its
  // Settings → Tools row folds them under one family (lib/tool-groups.ts), so
  // the per-tool artwork it used to carry only added noise.
  lens_diagnostics: Codesandbox,
  lens_diagnostic_mark: Codesandbox,
  symbol_search: Codesandbox,
  read_symbol: Codesandbox,
  read_enclosing: Codesandbox,
  lsp_navigation: Codesandbox,
  project_report: Codesandbox,
  module_report: Codesandbox,
  effective_config: Codesandbox,
  pi_lens_activate_tools: Codesandbox,
  ast_grep_search: Codesandbox,
  ast_grep_replace: Codesandbox,
  ast_grep_outline: Codesandbox,
  // Native MCP resource tools and historical adapter entry points. Native
  // `mcp__<server>__<tool>` and old `mcp__<server>` proxies use the prefix
  // branch below. Codemode and tool search are separate capabilities.
  list_mcp_resources: Plug,
  list_mcp_resource_templates: Plug,
  read_mcp_resource: Plug,
  mcp: Plug,
  mcpScript: Plug,
  codemode: SourceCodeCircle,
  tool_search: Search,
  // Embedded browser agent tools. `browser_navigate` takes the `Compass` so it
  // stays distinct from web_search's `Globe`; one mapping per name even where
  // the artwork is shared (type/press_key are both the keyboard, by design).
  browser_navigate: Compass,
  browser_pages: Layers,
  browser_focus: SquareArrowOutUpRight,
  browser_snapshot: ScanText,
  browser_click: MousePointerClick,
  browser_type: Keyboard,
  browser_press_key: Keyboard,
  browser_scroll: ArrowDownUp,
  browser_wait_for: Timer,
  browser_screenshot: Camera,
  browser_close: XSquare,
  browser_hover: MousePointer2,
  browser_select: Selection,
  browser_upload: Upload
}

/** Native MCP tools and legacy adapter proxies share this namespace. */
const MCP_NAMESPACE_PREFIX = 'mcp__'

/**
 * Resolves the icon component for a tool name. Never returns `undefined`: an
 * unmapped tool gets the generic wrench, which is what the SDK itself uses for
 * custom tools.
 */
export function toolIconComponent(name: string): IconComponent {
  if (Object.hasOwn(TOOL_ICONS, name)) return TOOL_ICONS[name]
  if (name.startsWith(MCP_NAMESPACE_PREFIX)) return Plug
  return Wrench
}

/**
 * Renders the mapped glyph with the chrome the tool rows expect: fixed size,
 * never shrunk. The color is left to the caller's context (the tool rows' muted
 * chrome span, the tab's own label color), and `className` merges on top.
 */
export function ToolIcon({ name, className }: { name: string; className?: string }) {
  const Icon = toolIconComponent(name)
  return <Icon aria-hidden="true" className={cn('size-4 shrink-0', className)} />
}
