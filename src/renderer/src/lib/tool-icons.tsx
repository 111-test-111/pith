import {
  ArrowDownUp,
  Bot,
  BookDownload,
  BookSearch,
  Camera,
  Chart,
  CircleHelp,
  CloudDownload,
  CommandLine,
  Compass,
  Dashboard,
  Database,
  FileCode2,
  FilePen,
  FilePlus2,
  FileSearch,
  FileSearch2,
  FileText,
  FolderTree,
  Globe,
  InstallingUpdates,
  Keyboard,
  Layers,
  ListChecks,
  ListTodo,
  MousePointer2,
  MousePointerClick,
  Plug,
  ScanText,
  ScanSearch,
  Search,
  SourceCode,
  SquareArrowOutUpRight,
  Stethoscope,
  Terminal,
  TextSearch,
  Timer,
  Trash2,
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
 * `pi-mcp-adapter`, `@ff-labs/pi-fff`, `context-mode`). Everything else — a tool
 * a new extension registers after this list was written — falls back to the
 * wrench, until it gets an explicit entry here. MCP namespaces are the one
 * exception, handled by prefix below.
 */
const TOOL_ICONS: Record<string, IconComponent> = {
  // Built-in file + shell tools. The shell rows use the plain `Terminal` glyph;
  // the terminal *category* group keeps the boxed `SquareTerminal` (see
  // lib/tool-categories.ts), so a folded run and its rows are distinguishable.
  bash: Terminal,
  bash_task: Terminal,
  todo_write: ListTodo,
  ask_user_question: CircleHelp,
  agent: Bot,
  powershell: Terminal,
  read: FileText,
  edit: FilePen,
  write: FilePlus2,
  grep: Search,
  find: FileSearch,
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
  ctx_doctor: Stethoscope,
  ctx_purge: Trash2,
  ctx_insight: Dashboard,
  ctx_upgrade: InstallingUpdates,
  // MCP adapter — `mcp`, the batch script tool `mcpScript` and every per-server
  // namespace proxy (`mcp__context7`, …) share one MCP glyph; the proxies are
  // matched by prefix in `toolIconComponent` rather than listed here.
  mcp: Plug,
  mcpScript: Plug,
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
  browser_select: ListChecks
}

/** Namespace-proxy tools are named `<adapter>__<server>`. */
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
