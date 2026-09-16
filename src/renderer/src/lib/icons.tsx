import { forwardRef, type ForwardRefExoticComponent, type RefAttributes } from 'react'
import { type LucideIcon, type LucideProps } from 'lucide-react'
import {
  AlertCircle as AlertCircleGlyph,
  AlertTriangle as AlertTriangleGlyph,
  ArrowDown as ArrowDownGlyph,
  ArrowDownWideNarrow as ArrowDownWideNarrowGlyph,
  ArrowLeft as ArrowLeftGlyph,
  ArrowRight as ArrowRightGlyph,
  ArrowUp as ArrowUpGlyph,
  ArrowUpNarrowWide as ArrowUpNarrowWideGlyph,
  ArrowUpRight as ArrowUpRightGlyph,
  Ban as BanGlyph,
  Bell as BellGlyph,
  BookDown as BookDownloadGlyph,
  BookOpenText as BookOpenTextGlyph,
  Bookmark as BookmarkGlyph,
  BookSearch as BookSearchGlyph,
  Bot as BotGlyph,
  Braces as BracesGlyph,
  Brain as BrainGlyph,
  ChartColumn as ChartGlyph,
  MessagesSquare as Chat01Glyph,
  Check as CheckGlyph,
  CheckCircle2 as CheckCircle2Glyph,
  ChevronDown as ChevronDownGlyph,
  ChevronLeft as ChevronLeftGlyph,
  ChevronRight as ChevronRightGlyph,
  ChevronsDownUp as ChevronsDownUpGlyph,
  ChevronsUpDown as ChevronsUpDownGlyph,
  Circle as CircleGlyph,
  CircleAlert as CircleAlertGlyph,
  CircleCheck as CircleCheckGlyph,
  CircleHelp as CircleHelpGlyph,
  CircleX as CircleXGlyph,
  Clock as ClockGlyph,
  Clock3 as Clock3Glyph,
  CloudDownload as CloudDownloadGlyph,
  TerminalSquare as CommandLineGlyph,
  Compass as CompassGlyph,
  Copy as CopyGlyph,
  LayoutDashboard as DashboardGlyph,
  Database as DatabaseGlyph,
  Diff as DiffGlyph,
  Download as DownloadGlyph,
  ExternalLink as ExternalLinkGlyph,
  Eye as EyeGlyph,
  EyeOff as EyeOffGlyph,
  FastForward as FastForwardGlyph,
  FileCode2 as FileCode2Glyph,
  FileDiff as FileDiffGlyph,
  FilePen as FilePenGlyph,
  FilePlus2 as FilePlus2Glyph,
  FileSearch as FileSearchGlyph,
  FileSearch2 as FileSearch2Glyph,
  FileText as FileTextGlyph,
  Folder as FolderGlyph,
  FolderInput as FolderInputGlyph,
  FolderKanban as FolderKanbanGlyph,
  FolderOpen as FolderOpenGlyph,
  FolderPlus as FolderPlusGlyph,
  FolderTree as FolderTreeGlyph,
  GitFork as GitForkGlyph,
  GitPullRequest as GitPullRequestGlyph,
  Globe as GlobeGlyph,
  Globe2 as Globe2Glyph,
  GraduationCap as GraduationCapGlyph,
  Image as ImageGlyph,
  ImageIcon as ImageIconGlyph,
  ImagePlus as ImagePlusGlyph,
  Info as InfoGlyph,
  PackageOpen as InstallingUpdatesGlyph,
  KeyRound as KeyRoundGlyph,
  Lightbulb as LightbulbGlyph,
  Link2 as Link2Glyph,
  ListTodo as ListTodoGlyph,
  Loader2 as Loader2Glyph,
  LoaderCircle as LoaderCircleGlyph,
  LogOut as LogOutGlyph,
  Maximize2 as Maximize2Glyph,
  MessageCirclePlus as MessageCirclePlusGlyph,
  MessageSquare as MessageSquareGlyph,
  MessageSquareDashed as MessageSquareDashedGlyph,
  MessageSquarePlus as MessageSquarePlusGlyph,
  MessageSquareText as MessageSquareTextGlyph,
  Minimize2 as Minimize2Glyph,
  Monitor as MonitorGlyph,
  Moon as MoonGlyph,
  MoreHorizontal as MoreHorizontalGlyph,
  Music as MusicNoteGlyph,
  Palette as PaletteGlyph,
  PanelLeft as PanelLeftGlyph,
  PanelRight as PanelRightGlyph,
  Paperclip as PaperclipGlyph,
  Pencil as PencilGlyph,
  PencilLine as PencilLineGlyph,
  Pin as PinGlyph,
  PinOff as PinOffGlyph,
  Plug as PlugGlyph,
  PlugZap as PlugZapGlyph,
  Plus as PlusGlyph,
  Puzzle as PuzzleGlyph,
  RefreshCw as RefreshCwGlyph,
  RotateCcw as RotateCcwGlyph,
  ScanSearch as ScanSearchGlyph,
  ScrollText as ScrollTextGlyph,
  Search as SearchGlyph,
  SearchX as SearchXGlyph,
  Settings as SettingsGlyph,
  Settings2 as Settings2Glyph,
  Shapes as ShapesGlyph,
  ShieldCheck as ShieldCheckGlyph,
  Sparkles as SparklesGlyph,
  SquareCode as SourceCodeGlyph,
  Square as SquareGlyph,
  SquareTerminal as SquareTerminalGlyph,
  Stethoscope as StethoscopeGlyph,
  Captions as SubtitleGlyph,
  Sun as SunGlyph,
  Terminal as TerminalGlyph,
  Type as TextFontGlyph,
  TextSearch as TextSearchGlyph,
  WrapText as WrapTextGlyph,
  ThumbsDown as ThumbsDownGlyph,
  ThumbsUp as ThumbsUpGlyph,
  Trash2 as Trash2Glyph,
  Undo2 as Undo2Glyph,
  User as UserGlyph,
  WandSparkles as WandSparklesGlyph,
  Wrench as WrenchGlyph,
  X as XGlyph,
  XCircle as XCircleGlyph,
  Zap as ZapGlyph,
  ZoomIn as ZoomInGlyph,
  ZoomOut as ZoomOutGlyph,
} from 'lucide-react'

/**
 * App and beUI glyphs share this entry point; the artwork is Lucide. Call sites
 * keep semantic names (several predate Lucide's current spelling for the same
 * shape), so changing the pack stays inside this file.
 */
export type IconProps = Omit<LucideProps, 'ref'>
export type IconComponent = ForwardRefExoticComponent<IconProps & RefAttributes<SVGSVGElement>>

function createIcon(name: string, glyph: LucideIcon): IconComponent {
  // Preserve the call-site accessibility default: an unlabelled glyph is
  // decorative, a labelled one is exposed to assistive tech.
  const Component = forwardRef<SVGSVGElement, IconProps>((props, ref) => {
    const Glyph = glyph as IconComponent
    return (
      <Glyph
        ref={ref}
        aria-hidden={props['aria-label'] || props['aria-labelledby'] ? undefined : true}
        focusable="false"
        data-app-icon={name}
        {...props}
      />
    )
  })
  Component.displayName = name
  return Component
}

// Keep semantic component names at call sites; map their artwork only here.
export const AlertCircle = /* @__PURE__ */ createIcon('AlertCircle', AlertCircleGlyph)
export const AlertTriangle = /* @__PURE__ */ createIcon('AlertTriangle', AlertTriangleGlyph)
export const ArrowDown = /* @__PURE__ */ createIcon('ArrowDown', ArrowDownGlyph)
export const ArrowDownWideNarrow = /* @__PURE__ */ createIcon('ArrowDownWideNarrow', ArrowDownWideNarrowGlyph)
export const ArrowLeft = /* @__PURE__ */ createIcon('ArrowLeft', ArrowLeftGlyph)
export const ArrowRight = /* @__PURE__ */ createIcon('ArrowRight', ArrowRightGlyph)
export const ArrowUp = /* @__PURE__ */ createIcon('ArrowUp', ArrowUpGlyph)
export const ArrowUpNarrowWide = /* @__PURE__ */ createIcon('ArrowUpNarrowWide', ArrowUpNarrowWideGlyph)
export const ArrowUpRight = /* @__PURE__ */ createIcon('ArrowUpRight', ArrowUpRightGlyph)
export const Ban = /* @__PURE__ */ createIcon('Ban', BanGlyph)
export const Bell = /* @__PURE__ */ createIcon('Bell', BellGlyph)
export const BookDownload = /* @__PURE__ */ createIcon('BookDownload', BookDownloadGlyph)
export const BookOpenText = /* @__PURE__ */ createIcon('BookOpenText', BookOpenTextGlyph)
export const Bookmark = /* @__PURE__ */ createIcon('Bookmark', BookmarkGlyph)
export const BookSearch = /* @__PURE__ */ createIcon('BookSearch', BookSearchGlyph)
export const Bot = /* @__PURE__ */ createIcon('Bot', BotGlyph)
export const Braces = /* @__PURE__ */ createIcon('Braces', BracesGlyph)
export const Brain = /* @__PURE__ */ createIcon('Brain', BrainGlyph)
export const Chart = /* @__PURE__ */ createIcon('Chart', ChartGlyph)
export const Chat01 = /* @__PURE__ */ createIcon('Chat01', Chat01Glyph)
export const Check = /* @__PURE__ */ createIcon('Check', CheckGlyph)
export const CheckCircle2 = /* @__PURE__ */ createIcon('CheckCircle2', CheckCircle2Glyph)
export const ChevronDown = /* @__PURE__ */ createIcon('ChevronDown', ChevronDownGlyph)
export const ChevronLeft = /* @__PURE__ */ createIcon('ChevronLeft', ChevronLeftGlyph)
export const ChevronRight = /* @__PURE__ */ createIcon('ChevronRight', ChevronRightGlyph)
export const ChevronsDownUp = /* @__PURE__ */ createIcon('ChevronsDownUp', ChevronsDownUpGlyph)
export const ChevronsUpDown = /* @__PURE__ */ createIcon('ChevronsUpDown', ChevronsUpDownGlyph)
export const Circle = /* @__PURE__ */ createIcon('Circle', CircleGlyph)
export const CircleAlert = /* @__PURE__ */ createIcon('CircleAlert', CircleAlertGlyph)
export const CircleCheck = /* @__PURE__ */ createIcon('CircleCheck', CircleCheckGlyph)
export const CircleHelp = /* @__PURE__ */ createIcon('CircleHelp', CircleHelpGlyph)
export const CircleX = /* @__PURE__ */ createIcon('CircleX', CircleXGlyph)
export const Clock = /* @__PURE__ */ createIcon('Clock', ClockGlyph)
export const Clock3 = /* @__PURE__ */ createIcon('Clock3', Clock3Glyph)
export const CloudDownload = /* @__PURE__ */ createIcon('CloudDownload', CloudDownloadGlyph)
export const CommandLine = /* @__PURE__ */ createIcon('CommandLine', CommandLineGlyph)
export const Compass = /* @__PURE__ */ createIcon('Compass', CompassGlyph)
export const Copy = /* @__PURE__ */ createIcon('Copy', CopyGlyph)
export const Dashboard = /* @__PURE__ */ createIcon('Dashboard', DashboardGlyph)
export const Database = /* @__PURE__ */ createIcon('Database', DatabaseGlyph)
export const Diff = /* @__PURE__ */ createIcon('Diff', DiffGlyph)
export const Download = /* @__PURE__ */ createIcon('Download', DownloadGlyph)
export const ExternalLink = /* @__PURE__ */ createIcon('ExternalLink', ExternalLinkGlyph)
export const Eye = /* @__PURE__ */ createIcon('Eye', EyeGlyph)
export const EyeOff = /* @__PURE__ */ createIcon('EyeOff', EyeOffGlyph)
export const FastForward = /* @__PURE__ */ createIcon('FastForward', FastForwardGlyph)
export const FileCode2 = /* @__PURE__ */ createIcon('FileCode2', FileCode2Glyph)
export const FileDiff = /* @__PURE__ */ createIcon('FileDiff', FileDiffGlyph)
export const FilePen = /* @__PURE__ */ createIcon('FilePen', FilePenGlyph)
export const FilePlus2 = /* @__PURE__ */ createIcon('FilePlus2', FilePlus2Glyph)
export const FileSearch = /* @__PURE__ */ createIcon('FileSearch', FileSearchGlyph)
export const FileSearch2 = /* @__PURE__ */ createIcon('FileSearch2', FileSearch2Glyph)
export const FileText = /* @__PURE__ */ createIcon('FileText', FileTextGlyph)
export const Folder = /* @__PURE__ */ createIcon('Folder', FolderGlyph)
export const FolderInput = /* @__PURE__ */ createIcon('FolderInput', FolderInputGlyph)
export const FolderKanban = /* @__PURE__ */ createIcon('FolderKanban', FolderKanbanGlyph)
export const FolderOpen = /* @__PURE__ */ createIcon('FolderOpen', FolderOpenGlyph)
export const FolderPlus = /* @__PURE__ */ createIcon('FolderPlus', FolderPlusGlyph)
export const FolderTree = /* @__PURE__ */ createIcon('FolderTree', FolderTreeGlyph)
export const GitFork = /* @__PURE__ */ createIcon('GitFork', GitForkGlyph)
export const GitPullRequest = /* @__PURE__ */ createIcon('GitPullRequest', GitPullRequestGlyph)
export const Globe = /* @__PURE__ */ createIcon('Globe', GlobeGlyph)
export const Globe2 = /* @__PURE__ */ createIcon('Globe2', Globe2Glyph)
export const GraduationCap = /* @__PURE__ */ createIcon('GraduationCap', GraduationCapGlyph)
export const Image = /* @__PURE__ */ createIcon('Image', ImageGlyph)
export const ImageIcon = /* @__PURE__ */ createIcon('ImageIcon', ImageIconGlyph)
export const ImagePlus = /* @__PURE__ */ createIcon('ImagePlus', ImagePlusGlyph)
export const Info = /* @__PURE__ */ createIcon('Info', InfoGlyph)
export const InstallingUpdates = /* @__PURE__ */ createIcon('InstallingUpdates', InstallingUpdatesGlyph)
export const KeyRound = /* @__PURE__ */ createIcon('KeyRound', KeyRoundGlyph)
export const Lightbulb = /* @__PURE__ */ createIcon('Lightbulb', LightbulbGlyph)
export const Link2 = /* @__PURE__ */ createIcon('Link2', Link2Glyph)
export const ListTodo = /* @__PURE__ */ createIcon('ListTodo', ListTodoGlyph)
export const Loader2 = /* @__PURE__ */ createIcon('Loader2', Loader2Glyph)
export const LoaderCircle = /* @__PURE__ */ createIcon('LoaderCircle', LoaderCircleGlyph)
export const LogOut = /* @__PURE__ */ createIcon('LogOut', LogOutGlyph)
export const Maximize2 = /* @__PURE__ */ createIcon('Maximize2', Maximize2Glyph)
export const MessageCirclePlus = /* @__PURE__ */ createIcon('MessageCirclePlus', MessageCirclePlusGlyph)
export const MessageSquare = /* @__PURE__ */ createIcon('MessageSquare', MessageSquareGlyph)
export const MessageSquareDashed = /* @__PURE__ */ createIcon('MessageSquareDashed', MessageSquareDashedGlyph)
export const MessageSquarePlus = /* @__PURE__ */ createIcon('MessageSquarePlus', MessageSquarePlusGlyph)
export const MessageSquareText = /* @__PURE__ */ createIcon('MessageSquareText', MessageSquareTextGlyph)
export const Minimize2 = /* @__PURE__ */ createIcon('Minimize2', Minimize2Glyph)
export const Monitor = /* @__PURE__ */ createIcon('Monitor', MonitorGlyph)
export const Moon = /* @__PURE__ */ createIcon('Moon', MoonGlyph)
export const MoreHorizontal = /* @__PURE__ */ createIcon('MoreHorizontal', MoreHorizontalGlyph)
export const MusicNote = /* @__PURE__ */ createIcon('MusicNote', MusicNoteGlyph)
export const Palette = /* @__PURE__ */ createIcon('Palette', PaletteGlyph)
export const PanelLeft = /* @__PURE__ */ createIcon('PanelLeft', PanelLeftGlyph)
export const PanelRight = /* @__PURE__ */ createIcon('PanelRight', PanelRightGlyph)
export const Paperclip = /* @__PURE__ */ createIcon('Paperclip', PaperclipGlyph)
export const Pencil = /* @__PURE__ */ createIcon('Pencil', PencilGlyph)
export const PencilLine = /* @__PURE__ */ createIcon('PencilLine', PencilLineGlyph)
export const Pin = /* @__PURE__ */ createIcon('Pin', PinGlyph)
export const PinOff = /* @__PURE__ */ createIcon('PinOff', PinOffGlyph)
export const Plug = /* @__PURE__ */ createIcon('Plug', PlugGlyph)
export const PlugZap = /* @__PURE__ */ createIcon('PlugZap', PlugZapGlyph)
export const Plus = /* @__PURE__ */ createIcon('Plus', PlusGlyph)
export const Puzzle = /* @__PURE__ */ createIcon('Puzzle', PuzzleGlyph)
export const RefreshCw = /* @__PURE__ */ createIcon('RefreshCw', RefreshCwGlyph)
export const RotateCcw = /* @__PURE__ */ createIcon('RotateCcw', RotateCcwGlyph)
export const ScanSearch = /* @__PURE__ */ createIcon('ScanSearch', ScanSearchGlyph)
export const ScrollText = /* @__PURE__ */ createIcon('ScrollText', ScrollTextGlyph)
export const Search = /* @__PURE__ */ createIcon('Search', SearchGlyph)
export const SearchX = /* @__PURE__ */ createIcon('SearchX', SearchXGlyph)
export const Settings = /* @__PURE__ */ createIcon('Settings', SettingsGlyph)
export const Settings2 = /* @__PURE__ */ createIcon('Settings2', Settings2Glyph)
export const Shapes = /* @__PURE__ */ createIcon('Shapes', ShapesGlyph)
export const ShieldCheck = /* @__PURE__ */ createIcon('ShieldCheck', ShieldCheckGlyph)
export const Sparkles = /* @__PURE__ */ createIcon('Sparkles', SparklesGlyph)
export const SourceCode = /* @__PURE__ */ createIcon('SourceCode', SourceCodeGlyph)
export const Square = /* @__PURE__ */ createIcon('Square', SquareGlyph)
export const SquareTerminal = /* @__PURE__ */ createIcon('SquareTerminal', SquareTerminalGlyph)
export const Stethoscope = /* @__PURE__ */ createIcon('Stethoscope', StethoscopeGlyph)
export const Subtitle = /* @__PURE__ */ createIcon('Subtitle', SubtitleGlyph)
export const Sun = /* @__PURE__ */ createIcon('Sun', SunGlyph)
export const Terminal = /* @__PURE__ */ createIcon('Terminal', TerminalGlyph)
export const TextFont = /* @__PURE__ */ createIcon('TextFont', TextFontGlyph)
export const TextSearch = /* @__PURE__ */ createIcon('TextSearch', TextSearchGlyph)
export const WrapText = /* @__PURE__ */ createIcon('WrapText', WrapTextGlyph)
export const ThumbsDown = /* @__PURE__ */ createIcon('ThumbsDown', ThumbsDownGlyph)
export const ThumbsUp = /* @__PURE__ */ createIcon('ThumbsUp', ThumbsUpGlyph)
export const Trash2 = /* @__PURE__ */ createIcon('Trash2', Trash2Glyph)
export const Undo2 = /* @__PURE__ */ createIcon('Undo2', Undo2Glyph)
export const User = /* @__PURE__ */ createIcon('User', UserGlyph)
export const WandSparkles = /* @__PURE__ */ createIcon('WandSparkles', WandSparklesGlyph)
export const Wrench = /* @__PURE__ */ createIcon('Wrench', WrenchGlyph)
export const X = /* @__PURE__ */ createIcon('X', XGlyph)
export const XCircle = /* @__PURE__ */ createIcon('XCircle', XCircleGlyph)
export const Zap = /* @__PURE__ */ createIcon('Zap', ZapGlyph)
export const ZoomIn = /* @__PURE__ */ createIcon('ZoomIn', ZoomInGlyph)
export const ZoomOut = /* @__PURE__ */ createIcon('ZoomOut', ZoomOutGlyph)
