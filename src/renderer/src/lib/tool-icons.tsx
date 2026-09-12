import {
  CloudDownload,
  FilePen,
  FilePlus2,
  FileSearch,
  FileSearch2,
  FileText,
  FolderTree,
  Globe,
  Plug,
  ScanSearch,
  Search,
  SquareTerminal,
  TextSearch,
  Wrench,
  type LucideIcon
} from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Systematic tool → icon mapping for every place a tool is listed in the UI
 * (transcript rows, file-diff headers, Settings → Tools). It is keyed by the
 * exact tool name the agent calls.
 *
 * The mapping is exhaustive for the tools that exist today: the SDK's built-ins
 * plus what the bundled extensions register (`@tavily/pi-extension`,
 * `pi-mcp-adapter`, `@ff-labs/pi-fff`). Everything else — a tool a new extension
 * registers after this list was written — falls back to the wrench, until it
 * gets an explicit entry here. MCP namespaces are the one exception, handled by
 * prefix below.
 */
const TOOL_ICONS: Record<string, LucideIcon> = {
  // Built-in file + shell tools.
  bash: SquareTerminal,
  powershell: SquareTerminal,
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
  // MCP adapter — `mcp`, the batch script tool `mcpScript` and every per-server
  // namespace proxy (`mcp__context7`, …) share one MCP glyph; the proxies are
  // matched by prefix in `toolIconComponent` rather than listed here.
  mcp: Plug,
  mcpScript: Plug
}

/** Namespace-proxy tools are named `<adapter>__<server>`. */
const MCP_NAMESPACE_PREFIX = 'mcp__'

/**
 * Resolves the icon component for a tool name. Never returns `undefined`: an
 * unmapped tool gets the generic wrench, which is what the SDK itself uses for
 * custom tools.
 */
export function toolIconComponent(name: string): LucideIcon {
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
