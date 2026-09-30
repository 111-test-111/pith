import {
  ArrowDownUp,
  BookDownload,
  BookOpenCheck,
  BookSearch,
  Braces,
  Bug,
  CalendarCheck,
  Camera,
  Chart,
  CircleHelp,
  CloudDownload,
  CommandLine,
  Compass,
  Dashboard,
  Database,
  FileCode2,
  FileSearch2,
  FirstAidKit,
  Flask,
  Focus,
  FolderSearch,
  FolderTree,
  Subagent,
  Globe,
  InstallingUpdates,
  Keyboard,
  Layers,
  ListChecks,
  ListIndentIncrease,
  ListTree,
  MousePointer2,
  MousePointerClick,
  MessageSquareText,
  Navigation,
  Network,
  PencilSparkles,
  Plug,
  Power,
  Replace,
  ScanText,
  ScanSearch,
  Search,
  SearchCode,
  Selection,
  Send,
  Settings2,
  NotebookPen,
  SourceCode,
  SquareArrowOutUpRight,
  SquareFunction,
  Stamp,
  Stethoscope,
  StickyNotePlus,
  Terminal,
  TextSearch,
  Timer,
  Trash2,
  Upload,
  UserRoundArrowLeft,
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
  present: UserRoundArrowLeft,
  scheduled_task: CalendarCheck,
  jev_decide: Flask,
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
  edit: PencilSparkles,
  write: StickyNotePlus,
  grep: Search,
  find: FolderSearch,
  ls: FolderTree,
  // pi-fff (indexed search): the `ff`-prefixed variants of grep/find, plus its
  // combined multigrep (named `fff-multi-grep`, or `multi_grep` in override
  // mode).
  ffgrep: TextSearch,
  fffind: FileSearch2,
  'fff-multi-grep': ScanSearch,
  multi_grep: ScanSearch,
  // Tavily web tools.
  web_search: Globe,
  web_fetch: CloudDownload,
  // context-mode: the sandbox-execution + knowledge-base family. The two
  // executors run code (`</>` glyphs — the batch one is the boxed `>_`, so it
  // stays distinguishable from the plain `Terminal` of `bash`), the knowledge
  // base owns the database/book glyphs, and the maintenance tools keep their
  // own verbs (diagnose / delete / dashboard / install).
  ctx_execute: SourceCode,
  ctx_execute_file: FileCode2,
  ctx_batch_execute: CommandLine,
  ctx_index: Database,
  ctx_fetch_and_index: BookDownload,
  ctx_search: BookSearch,
  ctx_stats: Chart,
  ctx_doctor: FirstAidKit,
  ctx_purge: Trash2,
  ctx_insight: Dashboard,
  ctx_upgrade: InstallingUpdates,
  // pi-lens (code feedback: LSP diagnostics, symbol comprehension, structural
  // analysis). One glyph per job, and the pairs stay tellable apart: the check-up
  // and the verdict it produces, one symbol and the scope enclosing it, the
  // project graph and the module inside it, the situational-tool switch, and the
  // ast-grep trio (structural search / rewrite / outline) against `symbol_search`
  // (a name, not a pattern) and `read_symbol` (a symbol body, not a listing).
  lens_diagnostics: Stethoscope,
  lens_diagnostic_mark: Stamp,
  symbol_search: Braces,
  read_symbol: SquareFunction,
  read_enclosing: Focus,
  lsp_navigation: Navigation,
  project_report: Network,
  module_report: ListTree,
  effective_config: Settings2,
  pi_lens_activate_tools: Power,
  ast_grep_search: SearchCode,
  ast_grep_replace: Replace,
  ast_grep_outline: ListIndentIncrease,
  // Native MCP resource tools and historical adapter entry points. Native
  // `mcp__<server>__<tool>` and old `mcp__<server>` proxies use the prefix
  // branch below. Codemode and tool search are separate capabilities.
  list_mcp_resources: Plug,
  list_mcp_resource_templates: Plug,
  read_mcp_resource: Plug,
  mcp: Plug,
  mcpScript: Plug,
  codemode: SourceCode,
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
