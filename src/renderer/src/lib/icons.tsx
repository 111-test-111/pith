import {
  createElement,
  forwardRef,
  type ForwardRefExoticComponent,
  type ReactElement,
  type RefAttributes,
  type SVGProps
} from 'react'
import * as Phosphor from '@phosphor-icons/react'
import type { Icon as PhosphorGlyph, IconWeight } from '@phosphor-icons/react'

/**
 * Every UI glyph in the app comes through this one adapter, so a call site
 * never imports an icon package: it asks for a semantic name (`Search`,
 * `ChevronDown`) and gets the app's Phosphor regular-weight artwork.
 *
 * Phosphor is the app's only UI icon family — the interface style preference
 * changes corners, not icons, so both 直角 and 超椭圆 draw the same glyphs.
 *
 * The namespace import keeps all 150+ mappings in one reviewable table; the
 * static table properties stay tree-shakeable.
 */
export type IconProps = Omit<SVGProps<SVGSVGElement>, 'ref'> & {
  size?: string | number
  /** Lucide-era compatibility: retained at call sites, dropped by the adapter
   * because Phosphor's regular family is fill artwork, not a stroke. */
  absoluteStrokeWidth?: boolean
}
export type IconComponent = ForwardRefExoticComponent<IconProps & RefAttributes<SVGSVGElement>>

/** Exactly one Phosphor glyph per semantic name. */
const GLYPHS = {
  AlertCircle: Phosphor.WarningCircleIcon,
  AlertTriangle: Phosphor.WarningIcon,
  ArrowDown: Phosphor.ArrowDownIcon,
  ArrowDownUp: Phosphor.ArrowsDownUpIcon,
  ArrowDownWideNarrow: Phosphor.SortDescendingIcon,
  ArrowLeft: Phosphor.ArrowLeftIcon,
  ArrowRight: Phosphor.ArrowRightIcon,
  ArrowUp: Phosphor.ArrowUpIcon,
  ArrowUpNarrowWide: Phosphor.SortAscendingIcon,
  ArrowUpRight: Phosphor.ArrowUpRightIcon,
  ArrowsInLineHorizontal: Phosphor.ArrowsInLineHorizontalIcon,
  ArrowsOutLineHorizontal: Phosphor.ArrowsOutLineHorizontalIcon,
  Article: Phosphor.ArticleIcon,
  Backspace: Phosphor.BackspaceIcon,
  Ban: Phosphor.ProhibitIcon,
  Bell: Phosphor.BellIcon,
  BookDownload: Phosphor.BookOpenIcon,
  BookOpen: Phosphor.BookOpenIcon,
  BookOpenText: Phosphor.BookOpenTextIcon,
  Bookmark: Phosphor.BookmarkIcon,
  BookSearch: Phosphor.BookOpenTextIcon,
  Bot: Phosphor.BabyIcon,
  Braces: Phosphor.BracketsCurlyIcon,
  Brain: Phosphor.BrainIcon,
  CalendarCheck: Phosphor.CalendarCheckIcon,
  Camera: Phosphor.CameraIcon,
  Chart: Phosphor.ChartBarIcon,
  Chat01: Phosphor.ChatsIcon,
  ChatText: Phosphor.ChatTextIcon,
  Check: Phosphor.CheckIcon,
  CheckCircle2: Phosphor.CheckCircleIcon,
  CheckSquareOffset: Phosphor.CheckSquareOffsetIcon,
  ChevronDown: Phosphor.CaretDownIcon,
  ChevronLeft: Phosphor.CaretLeftIcon,
  ChevronRight: Phosphor.CaretRightIcon,
  ChevronUp: Phosphor.CaretUpIcon,
  ChevronsDownUp: Phosphor.ArrowsInLineVerticalIcon,
  ChevronsUpDown: Phosphor.CaretUpDownIcon,
  Circle: Phosphor.CircleIcon,
  CircleAlert: Phosphor.WarningCircleIcon,
  CircleCheck: Phosphor.CheckCircleIcon,
  CircleDashed: Phosphor.CircleDashedIcon,
  CircleHelp: Phosphor.QuestionIcon,
  CircleX: Phosphor.XCircleIcon,
  Clock: Phosphor.ClockIcon,
  Clock3: Phosphor.ClockAfternoonIcon,
  CloudDownload: Phosphor.CloudArrowDownIcon,
  Command: Phosphor.CommandIcon,
  CommandLine: Phosphor.CommandIcon,
  Compass: Phosphor.CompassIcon,
  Control: Phosphor.ControlIcon,
  Copy: Phosphor.CopyIcon,
  Dashboard: Phosphor.GaugeIcon,
  Database: Phosphor.DatabaseIcon,
  Diff: Phosphor.PlusMinusIcon,
  Download: Phosphor.DownloadIcon,
  ExternalLink: Phosphor.ArrowSquareOutIcon,
  Eye: Phosphor.EyeIcon,
  EyeOff: Phosphor.EyeSlashIcon,
  FastForward: Phosphor.FastForwardIcon,
  FileCode2: Phosphor.FileCodeIcon,
  FileDiff: Phosphor.GitDiffIcon,
  FilePen: Phosphor.FileTextIcon,
  FilePlus2: Phosphor.FilePlusIcon,
  FileSearch: Phosphor.FileMagnifyingGlassIcon,
  FileSearch2: Phosphor.FileMagnifyingGlassIcon,
  FileText: Phosphor.FileTextIcon,
  FirstAidKit: Phosphor.FirstAidKitIcon,
  Flask: Phosphor.FlaskIcon,
  Folder: Phosphor.FolderIcon,
  FolderInput: Phosphor.FolderPlusIcon,
  FolderKanban: Phosphor.FoldersIcon,
  FolderOpen: Phosphor.FolderDashedIcon,
  FolderPlus: Phosphor.FolderPlusIcon,
  FolderTree: Phosphor.TreeStructureIcon,
  Ghost: Phosphor.GhostIcon,
  GitFork: Phosphor.GitForkIcon,
  GitPullRequest: Phosphor.GitPullRequestIcon,
  Globe: Phosphor.GlobeIcon,
  Globe2: Phosphor.GlobeSimpleIcon,
  GoogleChromeLogo: Phosphor.GoogleChromeLogoIcon,
  GraduationCap: Phosphor.GraduationCapIcon,
  History: Phosphor.ClockCounterClockwiseIcon,
  Image: Phosphor.ImageIcon,
  ImageIcon: Phosphor.ImageIcon,
  ImagePlus: Phosphor.ImagesSquareIcon,
  Info: Phosphor.InfoIcon,
  InstallingUpdates: Phosphor.ArrowsClockwiseIcon,
  Keyboard: Phosphor.KeyboardIcon,
  KeyRound: Phosphor.KeyIcon,
  Layers: Phosphor.StackIcon,
  Lightbulb: Phosphor.LightbulbIcon,
  Link2: Phosphor.LinkIcon,
  LinkSimple: Phosphor.LinkSimpleIcon,
  ListChecks: Phosphor.ListChecksIcon,
  ListTodo: Phosphor.ListChecksIcon,
  Loader2: Phosphor.SpinnerGapIcon,
  LoaderCircle: Phosphor.SpinnerGapIcon,
  LogOut: Phosphor.SignOutIcon,
  Maximize2: Phosphor.ArrowsOutIcon,
  MessageCirclePlus: Phosphor.ChatCircleDotsIcon,
  MessageSquare: Phosphor.ChatsIcon,
  MessageSquareDashed: Phosphor.ChatCenteredSlashIcon,
  MessageSquarePlus: Phosphor.ChatCenteredIcon,
  MessageSquareText: Phosphor.ChatTextIcon,
  Minimize2: Phosphor.ArrowsInIcon,
  Minus: Phosphor.MinusIcon,
  Monitor: Phosphor.MonitorIcon,
  Moon: Phosphor.MoonIcon,
  MoreHorizontal: Phosphor.DotsThreeIcon,
  MousePointer2: Phosphor.CursorIcon,
  MousePointerClick: Phosphor.CursorClickIcon,
  MusicNote: Phosphor.MusicNoteIcon,
  Option: Phosphor.OptionIcon,
  Palette: Phosphor.PaletteIcon,
  Printer: Phosphor.PrinterIcon,
  PanelLeft: Phosphor.SidebarSimpleIcon,
  PanelRight: Phosphor.SidebarSimpleIcon,
  Paperclip: Phosphor.PaperclipIcon,
  PenNib: Phosphor.PenNibIcon,
  Pencil: Phosphor.PencilIcon,
  PencilLine: Phosphor.PencilLineIcon,
  Pin: Phosphor.PushPinIcon,
  PinOff: Phosphor.PushPinSlashIcon,
  Plug: Phosphor.PlugIcon,
  PlugZap: Phosphor.PlugChargingIcon,
  Plus: Phosphor.PlusIcon,
  Puzzle: Phosphor.WindmillIcon,
  RefreshCw: Phosphor.ArrowClockwiseIcon,
  Rewind: Phosphor.RewindIcon,
  RotateCcw: Phosphor.ArrowCounterClockwiseIcon,
  ScanSearch: Phosphor.ScanIcon,
  ScanText: Phosphor.ScanIcon,
  ScrollText: Phosphor.ScrollIcon,
  Search: Phosphor.MagnifyingGlassIcon,
  SearchX: Phosphor.MagnifyingGlassMinusIcon,
  Selection: Phosphor.SelectionIcon,
  Send: Phosphor.PaperPlaneTiltIcon,
  Settings: Phosphor.GearIcon,
  Smartphone: Phosphor.DeviceMobileIcon,
  Settings2: Phosphor.SlidersHorizontalIcon,
  Shapes: Phosphor.ShapesIcon,
  ShieldCheck: Phosphor.ShieldCheckIcon,
  Siren: Phosphor.SirenIcon,
  Sparkles: Phosphor.SparkleIcon,
  SourceCode: Phosphor.CodeIcon,
  Square: Phosphor.SquareIcon,
  SquareArrowOutUpRight: Phosphor.ArrowSquareOutIcon,
  SquareTerminal: Phosphor.TerminalWindowIcon,
  Stethoscope: Phosphor.StethoscopeIcon,
  Subtitle: Phosphor.SubtitlesIcon,
  Sun: Phosphor.SunIcon,
  Terminal: Phosphor.TerminalIcon,
  TextAlignCenter: Phosphor.TextAlignCenterIcon,
  TextFont: Phosphor.TextTIcon,
  TextSearch: Phosphor.ListMagnifyingGlassIcon,
  Type: Phosphor.TextTIcon,
  WrapText: Phosphor.TextAlignLeftIcon,
  ThumbsDown: Phosphor.ThumbsDownIcon,
  ThumbsUp: Phosphor.ThumbsUpIcon,
  Timer: Phosphor.TimerIcon,
  Trash2: Phosphor.TrashIcon,
  Undo2: Phosphor.ArrowUUpLeftIcon,
  Upload: Phosphor.UploadIcon,
  User: Phosphor.UserIcon,
  WandSparkles: Phosphor.MagicWandIcon,
  Wrench: Phosphor.WrenchIcon,
  X: Phosphor.XIcon,
  XCircle: Phosphor.XCircleIcon,
  XSquare: Phosphor.XSquareIcon,
  Zap: Phosphor.LightningIcon,
  ZoomIn: Phosphor.MagnifyingGlassPlusIcon,
  ZoomOut: Phosphor.MagnifyingGlassMinusIcon,
  MoreVertical: Phosphor.DotsThreeVerticalIcon,
} satisfies Record<string, PhosphorGlyph>

/** The two names whose Phosphor artwork needs an extra prop. `Square` is the
 * composer's solid stop control; `PanelRight` is the left panel's glyph
 * mirrored, since Phosphor ships only one sidebar drawing. */
const GLYPH_PROPS: Partial<Record<keyof typeof GLYPHS, { mirrored?: boolean; weight?: IconWeight }>> = {
  PanelRight: { mirrored: true },
  Square: { weight: 'fill' }
}

function createIcon(name: keyof typeof GLYPHS): IconComponent {
  const Glyph = GLYPHS[name] as unknown as (props: Record<string, unknown>) => ReactElement
  const Component = forwardRef<SVGSVGElement, IconProps>((props, ref) => {
    const { strokeWidth: _strokeWidth, absoluteStrokeWidth: _absoluteStrokeWidth, size, className, ...rest } = props
    const ariaHidden = rest['aria-label'] || rest['aria-labelledby'] ? undefined : true
    // Phosphor forwards unknown SVG attributes at runtime, but its public
    // IconProps intentionally narrows them; the loose cast keeps data
    // attributes and native aria props available.
    return createElement(Glyph, {
      ref,
      'data-app-icon': name,
      'aria-hidden': ariaHidden,
      focusable: 'false',
      size: size ?? 24,
      color: 'currentColor',
      weight: 'regular',
      className,
      ...GLYPH_PROPS[name],
      ...rest
    })
  })
  Component.displayName = name
  return Component as IconComponent
}

// Keep semantic component names at call sites; map artwork only above.
export const AlertCircle = /* @__PURE__ */ createIcon('AlertCircle')
export const AlertTriangle = /* @__PURE__ */ createIcon('AlertTriangle')
export const ArrowDown = /* @__PURE__ */ createIcon('ArrowDown')
export const ArrowDownUp = /* @__PURE__ */ createIcon('ArrowDownUp')
export const ArrowDownWideNarrow = /* @__PURE__ */ createIcon('ArrowDownWideNarrow')
export const ArrowLeft = /* @__PURE__ */ createIcon('ArrowLeft')
export const ArrowRight = /* @__PURE__ */ createIcon('ArrowRight')
export const ArrowUp = /* @__PURE__ */ createIcon('ArrowUp')
export const ArrowUpNarrowWide = /* @__PURE__ */ createIcon('ArrowUpNarrowWide')
export const ArrowUpRight = /* @__PURE__ */ createIcon('ArrowUpRight')
export const ArrowsInLineHorizontal = /* @__PURE__ */ createIcon('ArrowsInLineHorizontal')
export const ArrowsOutLineHorizontal = /* @__PURE__ */ createIcon('ArrowsOutLineHorizontal')
export const Article = /* @__PURE__ */ createIcon('Article')
export const Backspace = /* @__PURE__ */ createIcon('Backspace')
export const Ban = /* @__PURE__ */ createIcon('Ban')
export const Bell = /* @__PURE__ */ createIcon('Bell')
export const BookDownload = /* @__PURE__ */ createIcon('BookDownload')
export const BookOpen = /* @__PURE__ */ createIcon('BookOpen')
export const BookOpenText = /* @__PURE__ */ createIcon('BookOpenText')
export const Bookmark = /* @__PURE__ */ createIcon('Bookmark')
export const BookSearch = /* @__PURE__ */ createIcon('BookSearch')
export const Bot = /* @__PURE__ */ createIcon('Bot')
export const Braces = /* @__PURE__ */ createIcon('Braces')
export const Brain = /* @__PURE__ */ createIcon('Brain')
export const CalendarCheck = /* @__PURE__ */ createIcon('CalendarCheck')
export const Camera = /* @__PURE__ */ createIcon('Camera')
export const Chart = /* @__PURE__ */ createIcon('Chart')
export const Chat01 = /* @__PURE__ */ createIcon('Chat01')
export const ChatText = /* @__PURE__ */ createIcon('ChatText')
export const Check = /* @__PURE__ */ createIcon('Check')
export const CheckCircle2 = /* @__PURE__ */ createIcon('CheckCircle2')
export const CheckSquareOffset = /* @__PURE__ */ createIcon('CheckSquareOffset')
export const ChevronDown = /* @__PURE__ */ createIcon('ChevronDown')
export const ChevronLeft = /* @__PURE__ */ createIcon('ChevronLeft')
export const ChevronRight = /* @__PURE__ */ createIcon('ChevronRight')
export const ChevronUp = /* @__PURE__ */ createIcon('ChevronUp')
export const ChevronsDownUp = /* @__PURE__ */ createIcon('ChevronsDownUp')
export const ChevronsUpDown = /* @__PURE__ */ createIcon('ChevronsUpDown')
export const Circle = /* @__PURE__ */ createIcon('Circle')
export const CircleAlert = /* @__PURE__ */ createIcon('CircleAlert')
export const CircleCheck = /* @__PURE__ */ createIcon('CircleCheck')
export const CircleDashed = /* @__PURE__ */ createIcon('CircleDashed')
export const CircleHelp = /* @__PURE__ */ createIcon('CircleHelp')
export const CircleX = /* @__PURE__ */ createIcon('CircleX')
export const Clock = /* @__PURE__ */ createIcon('Clock')
export const Clock3 = /* @__PURE__ */ createIcon('Clock3')
export const CloudDownload = /* @__PURE__ */ createIcon('CloudDownload')
export const Command = /* @__PURE__ */ createIcon('Command')
export const CommandLine = /* @__PURE__ */ createIcon('CommandLine')
export const Compass = /* @__PURE__ */ createIcon('Compass')
export const Control = /* @__PURE__ */ createIcon('Control')
export const Copy = /* @__PURE__ */ createIcon('Copy')
export const Dashboard = /* @__PURE__ */ createIcon('Dashboard')
export const Database = /* @__PURE__ */ createIcon('Database')
export const Diff = /* @__PURE__ */ createIcon('Diff')
export const Download = /* @__PURE__ */ createIcon('Download')
export const ExternalLink = /* @__PURE__ */ createIcon('ExternalLink')
export const Eye = /* @__PURE__ */ createIcon('Eye')
export const EyeOff = /* @__PURE__ */ createIcon('EyeOff')
export const FastForward = /* @__PURE__ */ createIcon('FastForward')
export const FileCode2 = /* @__PURE__ */ createIcon('FileCode2')
export const FileDiff = /* @__PURE__ */ createIcon('FileDiff')
export const FilePen = /* @__PURE__ */ createIcon('FilePen')
export const FilePlus2 = /* @__PURE__ */ createIcon('FilePlus2')
export const FileSearch = /* @__PURE__ */ createIcon('FileSearch')
export const FileSearch2 = /* @__PURE__ */ createIcon('FileSearch2')
export const FileText = /* @__PURE__ */ createIcon('FileText')
export const FirstAidKit = /* @__PURE__ */ createIcon('FirstAidKit')
export const Flask = /* @__PURE__ */ createIcon('Flask')
export const Folder = /* @__PURE__ */ createIcon('Folder')
export const FolderInput = /* @__PURE__ */ createIcon('FolderInput')
export const FolderKanban = /* @__PURE__ */ createIcon('FolderKanban')
export const FolderOpen = /* @__PURE__ */ createIcon('FolderOpen')
export const FolderPlus = /* @__PURE__ */ createIcon('FolderPlus')
export const FolderTree = /* @__PURE__ */ createIcon('FolderTree')
export const Ghost = /* @__PURE__ */ createIcon('Ghost')
export const GitFork = /* @__PURE__ */ createIcon('GitFork')
export const GitPullRequest = /* @__PURE__ */ createIcon('GitPullRequest')
export const Globe = /* @__PURE__ */ createIcon('Globe')
export const Globe2 = /* @__PURE__ */ createIcon('Globe2')
export const GoogleChromeLogo = /* @__PURE__ */ createIcon('GoogleChromeLogo')
export const GraduationCap = /* @__PURE__ */ createIcon('GraduationCap')
export const History = /* @__PURE__ */ createIcon('History')
export const Image = /* @__PURE__ */ createIcon('Image')
export const ImageIcon = /* @__PURE__ */ createIcon('ImageIcon')
export const ImagePlus = /* @__PURE__ */ createIcon('ImagePlus')
export const Info = /* @__PURE__ */ createIcon('Info')
export const InstallingUpdates = /* @__PURE__ */ createIcon('InstallingUpdates')
export const Keyboard = /* @__PURE__ */ createIcon('Keyboard')
export const KeyRound = /* @__PURE__ */ createIcon('KeyRound')
export const Layers = /* @__PURE__ */ createIcon('Layers')
export const Lightbulb = /* @__PURE__ */ createIcon('Lightbulb')
export const Link2 = /* @__PURE__ */ createIcon('Link2')
export const LinkSimple = /* @__PURE__ */ createIcon('LinkSimple')
export const ListChecks = /* @__PURE__ */ createIcon('ListChecks')
export const ListTodo = /* @__PURE__ */ createIcon('ListTodo')
export const Loader2 = /* @__PURE__ */ createIcon('Loader2')
export const LoaderCircle = /* @__PURE__ */ createIcon('LoaderCircle')
export const LogOut = /* @__PURE__ */ createIcon('LogOut')
export const Maximize2 = /* @__PURE__ */ createIcon('Maximize2')
export const MessageCirclePlus = /* @__PURE__ */ createIcon('MessageCirclePlus')
export const MessageSquare = /* @__PURE__ */ createIcon('MessageSquare')
export const MessageSquareDashed = /* @__PURE__ */ createIcon('MessageSquareDashed')
export const MessageSquarePlus = /* @__PURE__ */ createIcon('MessageSquarePlus')
export const MessageSquareText = /* @__PURE__ */ createIcon('MessageSquareText')
export const Minimize2 = /* @__PURE__ */ createIcon('Minimize2')
export const Minus = /* @__PURE__ */ createIcon('Minus')
export const Monitor = /* @__PURE__ */ createIcon('Monitor')
export const Moon = /* @__PURE__ */ createIcon('Moon')
export const MoreHorizontal = /* @__PURE__ */ createIcon('MoreHorizontal')
export const MoreVertical = /* @__PURE__ */ createIcon('MoreVertical')
export const MousePointer2 = /* @__PURE__ */ createIcon('MousePointer2')
export const MousePointerClick = /* @__PURE__ */ createIcon('MousePointerClick')
export const MusicNote = /* @__PURE__ */ createIcon('MusicNote')
export const Option = /* @__PURE__ */ createIcon('Option')
export const Palette = /* @__PURE__ */ createIcon('Palette')
export const Printer = /* @__PURE__ */ createIcon('Printer')
export const PanelLeft = /* @__PURE__ */ createIcon('PanelLeft')
export const PanelRight = /* @__PURE__ */ createIcon('PanelRight')
export const Paperclip = /* @__PURE__ */ createIcon('Paperclip')
export const PenNib = /* @__PURE__ */ createIcon('PenNib')
export const Pencil = /* @__PURE__ */ createIcon('Pencil')
export const PencilLine = /* @__PURE__ */ createIcon('PencilLine')
export const Pin = /* @__PURE__ */ createIcon('Pin')
export const PinOff = /* @__PURE__ */ createIcon('PinOff')
export const Plug = /* @__PURE__ */ createIcon('Plug')
export const PlugZap = /* @__PURE__ */ createIcon('PlugZap')
export const Plus = /* @__PURE__ */ createIcon('Plus')
export const Puzzle = /* @__PURE__ */ createIcon('Puzzle')
export const RefreshCw = /* @__PURE__ */ createIcon('RefreshCw')
export const Rewind = /* @__PURE__ */ createIcon('Rewind')
export const RotateCcw = /* @__PURE__ */ createIcon('RotateCcw')
export const ScanSearch = /* @__PURE__ */ createIcon('ScanSearch')
export const ScanText = /* @__PURE__ */ createIcon('ScanText')
export const ScrollText = /* @__PURE__ */ createIcon('ScrollText')
export const Search = /* @__PURE__ */ createIcon('Search')
export const SearchX = /* @__PURE__ */ createIcon('SearchX')
export const Selection = /* @__PURE__ */ createIcon('Selection')
export const Send = /* @__PURE__ */ createIcon('Send')
export const Settings = /* @__PURE__ */ createIcon('Settings')
export const Smartphone = /* @__PURE__ */ createIcon('Smartphone')
export const Settings2 = /* @__PURE__ */ createIcon('Settings2')
export const Shapes = /* @__PURE__ */ createIcon('Shapes')
export const ShieldCheck = /* @__PURE__ */ createIcon('ShieldCheck')
export const Siren = /* @__PURE__ */ createIcon('Siren')
export const Sparkles = /* @__PURE__ */ createIcon('Sparkles')
export const SourceCode = /* @__PURE__ */ createIcon('SourceCode')
export const Square = /* @__PURE__ */ createIcon('Square')
export const SquareArrowOutUpRight = /* @__PURE__ */ createIcon('SquareArrowOutUpRight')
export const SquareTerminal = /* @__PURE__ */ createIcon('SquareTerminal')
export const Stethoscope = /* @__PURE__ */ createIcon('Stethoscope')
export const Subtitle = /* @__PURE__ */ createIcon('Subtitle')
export const Sun = /* @__PURE__ */ createIcon('Sun')
export const Terminal = /* @__PURE__ */ createIcon('Terminal')
export const TextAlignCenter = /* @__PURE__ */ createIcon('TextAlignCenter')
export const TextFont = /* @__PURE__ */ createIcon('TextFont')
export const TextSearch = /* @__PURE__ */ createIcon('TextSearch')
export const Type = /* @__PURE__ */ createIcon('Type')
export const WrapText = /* @__PURE__ */ createIcon('WrapText')
export const ThumbsDown = /* @__PURE__ */ createIcon('ThumbsDown')
export const ThumbsUp = /* @__PURE__ */ createIcon('ThumbsUp')
export const Timer = /* @__PURE__ */ createIcon('Timer')
export const Trash2 = /* @__PURE__ */ createIcon('Trash2')
export const Undo2 = /* @__PURE__ */ createIcon('Undo2')
export const Upload = /* @__PURE__ */ createIcon('Upload')
export const User = /* @__PURE__ */ createIcon('User')
export const WandSparkles = /* @__PURE__ */ createIcon('WandSparkles')
export const Wrench = /* @__PURE__ */ createIcon('Wrench')
export const X = /* @__PURE__ */ createIcon('X')
export const XCircle = /* @__PURE__ */ createIcon('XCircle')
export const XSquare = /* @__PURE__ */ createIcon('XSquare')
export const Zap = /* @__PURE__ */ createIcon('Zap')
export const ZoomIn = /* @__PURE__ */ createIcon('ZoomIn')
export const ZoomOut = /* @__PURE__ */ createIcon('ZoomOut')
