import { forwardRef, type ForwardRefExoticComponent, type RefAttributes } from 'react'
import { HugeiconsIcon, type HugeiconsIconProps, type IconSvgElement } from '@hugeicons/react'
import {
  AiEditingIcon,
  Alert01Icon,
  AlertCircleIcon,
  ArrowBigRightDashIcon,
  ArrowDown02Icon,
  ArrowDownToLineIcon,
  ArrowDownWideNarrowIcon,
  ArrowExpand01Icon,
  ArrowLeft02Icon,
  ArrowLeftFromLineIcon,
  ArrowRight02Icon,
  ArrowShrink01Icon,
  ArrowUp02Icon,
  ArrowUpDownIcon,
  ArrowUpFromLineIcon,
  ArrowUpNarrowWideIcon,
  ArrowUpRight01Icon,
  BanIcon,
  BellIcon,
  BlocksIcon,
  BookDownloadIcon,
  BookOpenCheckIcon,
  BookOpenIcon,
  BookOpenTextIcon,
  BookSearchIcon,
  Bookmark01Icon,
  BracesIcon,
  BrainIcon,
  BugIcon,
  CalendarCheckIcon,
  CameraIcon,
  Cancel01Icon,
  CancelCircleIcon,
  CancelSquareIcon,
  ChartIcon,
  Chat01Icon,
  CheckIcon,
  CheckmarkCircle02Icon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  ChevronsDownUpIcon,
  CircleDashedIcon,
  CircleIcon,
  CircleOffIcon,
  Clock01Icon,
  Clock03Icon,
  CloudDownloadIcon,
  CommandIcon,
  CommandLineIcon,
  CompassIcon,
  CopyIcon,
  DatabaseIcon,
  Delete02Icon,
  DiffIcon,
  Download01Icon,
  ExternalLinkIcon,
  EyeIcon,
  EyeOffIcon,
  FileAddIcon,
  FileCodeIcon,
  FileDiffIcon,
  FilePenIcon,
  FileSearchCornerIcon,
  FileSearchIcon,
  FileTextIcon,
  FirstAidKitIcon,
  FlaskConicalIcon,
  FocusIcon,
  FoldHorizontalIcon,
  Folder01Icon,
  FolderInputIcon,
  FolderKanbanIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  FolderSearchIcon,
  FolderTreeIcon,
  FunctionSquareIcon,
  GeometricShapes01Icon,
  GitForkIcon,
  GitPullRequestIcon,
  GlobalIcon,
  Globe02Icon,
  HelpCircleIcon,
  HistoryIcon,
  Image01Icon,
  ImagePlusIcon,
  InfoIcon,
  InstallingUpdatesIcon,
  KeyRoundIcon,
  KeyboardIcon,
  LayersIcon,
  LayoutDashboardIcon,
  LightbulbIcon,
  Link02Icon,
  ListChecksIcon,
  ListIndentIncreaseIcon,
  ListTodoIcon,
  ListTreeIcon,
  LoaderCircleIcon,
  LogOutIcon,
  MessageCirclePlusIcon,
  MessageSquareDashedIcon,
  MessageSquareIcon,
  MessageSquarePlusIcon,
  MessageSquareTextIcon,
  MinusSignIcon,
  MonitorIcon,
  Moon02Icon,
  MoreHorizontalIcon,
  MoreVerticalIcon,
  MousePointer01Icon,
  MousePointerClickIcon,
  MusicNoteIcon,
  NavigationIcon,
  NetworkIcon,
  NewspaperIcon,
  NoteAddIcon,
  NotebookPenIcon,
  OptionIcon,
  PaletteIcon,
  PanelLeftIcon,
  PanelRightIcon,
  PaperclipIcon,
  PauseIcon,
  PenTool02Icon,
  PencilIcon,
  PencilLineIcon,
  PictureInPictureOnIcon,
  PinIcon,
  PinOffIcon,
  PlayIcon,
  PlugIcon,
  PlugZapIcon,
  PlusIcon,
  PowerIcon,
  PrinterIcon,
  PuzzleIcon,
  RefreshCwIcon,
  ReplaceIcon,
  RotateCcwIcon,
  ScanSearchIcon,
  ScanTextIcon,
  ScrollTextIcon,
  Search01Icon,
  SearchCodeIcon,
  SearchXIcon,
  SendIcon,
  Settings01Icon,
  Settings02Icon,
  ShieldCheckIcon,
  SmartphoneIcon,
  SourceCodeIcon,
  SparklesIcon,
  SquareArrowOutUpRightIcon,
  SquareCheckBigIcon,
  SquareDashedIcon,
  SquareIcon,
  SquareTerminalIcon,
  StampIcon,
  StepForwardIcon,
  StethoscopeIcon,
  SubtitleIcon,
  Sun01Icon,
  TerminalIcon,
  TextAlignCenterIcon,
  TextFontIcon,
  TextSearchIcon,
  TextWrapIcon,
  ThumbsDownIcon,
  ThumbsUpIcon,
  TimerIcon,
  TypeIcon,
  Undo02Icon,
  UnfoldHorizontalIcon,
  UnfoldMoreIcon,
  UploadIcon,
  UserArrowLeftRightIcon,
  UserIcon,
  WandSparklesIcon,
  WaypointsIcon,
  Wrench01Icon,
  ZapIcon,
  ZoomInIcon,
  ZoomOutIcon
} from '@hugeicons/core-free-icons'
import { AGENT_ARTWORK as AgentBrandGlyph } from './brand-icons'
import { UI_ICON_SIZE, UI_ICON_STROKE } from './icon-metrics'
import { BACKSPACE_ARTWORK as BackspaceKeycapGlyph } from './keycap-artwork'

/**
 * The single entry point for app and beUI glyphs. GLYPHS binds semantic names to
 * Hugeicons Stroke Rounded artwork on its native 24 grid. Both corner presets
 * draw the same icons. UI canvases are 16px compact / 18px normal / 20px primary.
 *
 * The pack's native 1.5 strokes are preserved, including filled details: sending
 * a default strokeWidth to the renderer would outline those details too. Explicit
 * strokeWidth and absoluteStrokeWidth keep the official renderer's semantics.
 * SVG refs, CSS sizing and accessibility pass through as before.
 *
 * Bot/Subagent use the app-owned Agent SVG; Pi/Pith and provider brands keep
 * their dedicated SVG masters. File types stay behind FileTypeIcon (Catppuccin).
 * The mac Shift/Backspace keycaps and moving status/progress arcs are geometry;
 * draw-in marks in animated-icons.tsx use this same Hugeicons pack.
 */
export type IconProps = Omit<HugeiconsIconProps, 'ref' | 'icon' | 'altIcon' | 'showAlt'>
export type IconComponent = ForwardRefExoticComponent<IconProps & RefAttributes<SVGSVGElement>>

/** One drawing per meaning; related semantic names can share their artwork. */
const GLYPHS = {
  AlertCircle: AlertCircleIcon,
  AlertTriangle: Alert01Icon,
  ArrowBigRightDash: ArrowBigRightDashIcon,
  ArrowDown: ArrowDown02Icon,
  ArrowDownToLine: ArrowDownToLineIcon,
  ArrowDownUp: ArrowUpDownIcon,
  ArrowDownWideNarrow: ArrowDownWideNarrowIcon,
  ArrowLeft: ArrowLeft02Icon,
  ArrowLeftFromLine: ArrowLeftFromLineIcon,
  ArrowRight: ArrowRight02Icon,
  ArrowUp: ArrowUp02Icon,
  ArrowUpFromLine: ArrowUpFromLineIcon,
  ArrowUpNarrowWide: ArrowUpNarrowWideIcon,
  ArrowUpRight: ArrowUpRight01Icon,
  ArrowsInLineHorizontal: FoldHorizontalIcon,
  ArrowsOutLineHorizontal: UnfoldHorizontalIcon,
  Article: NewspaperIcon,
  Backspace: BackspaceKeycapGlyph,
  Ban: BanIcon,
  Bell: BellIcon,
  BookDownload: BookDownloadIcon,
  BookOpen: BookOpenIcon,
  BookOpenCheck: BookOpenCheckIcon,
  BookOpenText: BookOpenTextIcon,
  Bug: BugIcon,
  Bookmark: Bookmark01Icon,
  BookSearch: BookSearchIcon,
  Bot: AgentBrandGlyph,
  Braces: BracesIcon,
  Brain: BrainIcon,
  CalendarCheck: CalendarCheckIcon,
  Camera: CameraIcon,
  Chart: ChartIcon,
  Chat01: Chat01Icon,
  ChatText: Chat01Icon,
  Check: CheckIcon,
  CheckCircle2: CheckmarkCircle02Icon,
  CheckSquareOffset: SquareCheckBigIcon,
  ChevronDown: ChevronDownIcon,
  ChevronLeft: ChevronLeftIcon,
  ChevronRight: ChevronRightIcon,
  ChevronUp: ChevronUpIcon,
  ChevronsDownUp: ChevronsDownUpIcon,
  ChevronsUpDown: UnfoldMoreIcon,
  Circle: CircleIcon,
  CircleAlert: AlertCircleIcon,
  CircleCheck: CheckmarkCircle02Icon,
  CircleDashed: CircleDashedIcon,
  CircleHelp: HelpCircleIcon,
  CircleOff: CircleOffIcon,
  CircleX: CancelCircleIcon,
  Clock: Clock01Icon,
  Clock3: Clock03Icon,
  CloudDownload: CloudDownloadIcon,
  Command: CommandIcon,
  CommandLine: CommandLineIcon,
  Compass: CompassIcon,
  Control: ChevronUpIcon,
  Copy: CopyIcon,
  Dashboard: LayoutDashboardIcon,
  Database: DatabaseIcon,
  Diff: DiffIcon,
  Download: Download01Icon,
  ExternalLink: ExternalLinkIcon,
  Eye: EyeIcon,
  EyeOff: EyeOffIcon,
  FileCode2: FileCodeIcon,
  FileDiff: FileDiffIcon,
  FilePen: FilePenIcon,
  FilePlus2: FileAddIcon,
  FileSearch: FileSearchIcon,
  FileSearch2: FileSearchCornerIcon,
  FileText: FileTextIcon,
  FirstAidKit: FirstAidKitIcon,
  Flask: FlaskConicalIcon,
  Focus: FocusIcon,
  Folder: Folder01Icon,
  FolderInput: FolderInputIcon,
  FolderKanban: FolderKanbanIcon,
  FolderOpen: FolderOpenIcon,
  FolderPlus: FolderPlusIcon,
  FolderSearch: FolderSearchIcon,
  FolderTree: FolderTreeIcon,
  Subagent: AgentBrandGlyph,
  GitFork: GitForkIcon,
  GitPullRequest: GitPullRequestIcon,
  Globe: Globe02Icon,
  Globe2: GlobalIcon,
  Skills: BlocksIcon,
  History: HistoryIcon,
  Image: Image01Icon,
  ImageIcon: Image01Icon,
  ImagePlus: ImagePlusIcon,
  Info: InfoIcon,
  InstallingUpdates: InstallingUpdatesIcon,
  Keyboard: KeyboardIcon,
  KeyRound: KeyRoundIcon,
  Layers: LayersIcon,
  Lightbulb: LightbulbIcon,
  Link2: Link02Icon,
  LinkSimple: Link02Icon,
  ListChecks: ListChecksIcon,
  ListIndentIncrease: ListIndentIncreaseIcon,
  ListTodo: ListTodoIcon,
  ListTree: ListTreeIcon,
  Loader2: LoaderCircleIcon,
  LoaderCircle: LoaderCircleIcon,
  LogOut: LogOutIcon,
  Maximize2: ArrowExpand01Icon,
  MessageCirclePlus: MessageCirclePlusIcon,
  MessageSquare: MessageSquareIcon,
  MessageSquareDashed: MessageSquareDashedIcon,
  MessageSquarePlus: MessageSquarePlusIcon,
  MessageSquareText: MessageSquareTextIcon,
  Minimize2: ArrowShrink01Icon,
  Minus: MinusSignIcon,
  Monitor: MonitorIcon,
  Moon: Moon02Icon,
  MoreHorizontal: MoreHorizontalIcon,
  MoreVertical: MoreVerticalIcon,
  MousePointer2: MousePointer01Icon,
  MousePointerClick: MousePointerClickIcon,
  MusicNote: MusicNoteIcon,
  Navigation: NavigationIcon,
  Network: NetworkIcon,
  Option: OptionIcon,
  Palette: PaletteIcon,
  Printer: PrinterIcon,
  PanelLeft: PanelLeftIcon,
  PanelRight: PanelRightIcon,
  Paperclip: PaperclipIcon,
  PenNib: PenTool02Icon,
  Pencil: PencilIcon,
  PencilLine: PencilLineIcon,
  PencilSparkles: AiEditingIcon,
  Pause: PauseIcon,
  Play: PlayIcon,
  Pin: PinIcon,
  PinOff: PinOffIcon,
  PictureInPicture2: PictureInPictureOnIcon,
  Plug: PlugIcon,
  PlugZap: PlugZapIcon,
  Plus: PlusIcon,
  Power: PowerIcon,
  Puzzle: PuzzleIcon,
  RefreshCw: RefreshCwIcon,
  Replace: ReplaceIcon,
  RotateCcw: RotateCcwIcon,
  ScanSearch: ScanSearchIcon,
  ScanText: ScanTextIcon,
  ScrollText: ScrollTextIcon,
  Search: Search01Icon,
  SearchCode: SearchCodeIcon,
  SearchX: SearchXIcon,
  Selection: SquareDashedIcon,
  Send: SendIcon,
  Settings: Settings01Icon,
  Smartphone: SmartphoneIcon,
  Settings2: Settings02Icon,
  Shapes: GeometricShapes01Icon,
  ShieldCheck: ShieldCheckIcon,
  NotebookPen: NotebookPenIcon,
  Sparkles: SparklesIcon,
  SourceCode: SourceCodeIcon,
  Square: SquareIcon,
  SquareArrowOutUpRight: SquareArrowOutUpRightIcon,
  SquareFunction: FunctionSquareIcon,
  SquareTerminal: SquareTerminalIcon,
  Stamp: StampIcon,
  StepForward: StepForwardIcon,
  Stethoscope: StethoscopeIcon,
  StickyNotePlus: NoteAddIcon,
  Subtitle: SubtitleIcon,
  Sun: Sun01Icon,
  Terminal: TerminalIcon,
  TextAlignCenter: TextAlignCenterIcon,
  TextFont: TextFontIcon,
  TextSearch: TextSearchIcon,
  Type: TypeIcon,
  WrapText: TextWrapIcon,
  ThumbsDown: ThumbsDownIcon,
  ThumbsUp: ThumbsUpIcon,
  Timer: TimerIcon,
  Trash2: Delete02Icon,
  Undo2: Undo02Icon,
  Upload: UploadIcon,
  User: UserIcon,
  UserRoundArrowLeft: UserArrowLeftRightIcon,
  WandSparkles: WandSparklesIcon,
  Waypoints: WaypointsIcon,
  Wrench: Wrench01Icon,
  X: Cancel01Icon,
  XCircle: CancelCircleIcon,
  XSquare: CancelSquareIcon,
  Zap: ZapIcon,
  ZoomIn: ZoomInIcon,
  ZoomOut: ZoomOutIcon
} satisfies Record<string, IconSvgElement>

function createIcon(name: string, glyph: IconSvgElement): IconComponent {
  const Component = forwardRef<SVGSVGElement, IconProps>(({ size = UI_ICON_SIZE.normal, ...props }, ref) => (
    <HugeiconsIcon
      ref={ref}
      size={size}
      // Wrench's tiny handle dot is encoded at 2px; this stroke-only drawing
      // can use the official stroke prop to keep the app's 1.5px weight.
      strokeWidth={glyph === Wrench01Icon ? UI_ICON_STROKE : undefined}
      aria-hidden={props['aria-label'] || props['aria-labelledby'] ? undefined : true}
      focusable="false"
      data-app-icon={name}
      data-icon-family={glyph === AgentBrandGlyph ? 'brand' : glyph === BackspaceKeycapGlyph ? 'keycap' : 'hugeicons'}
      {...props}
      icon={glyph}
    />
  ))
  Component.displayName = name
  return Component
}

// Keep semantic names at call sites; map their artwork only here.
export const AlertCircle = /* @__PURE__ */ createIcon('AlertCircle', GLYPHS.AlertCircle)
export const AlertTriangle = /* @__PURE__ */ createIcon('AlertTriangle', GLYPHS.AlertTriangle)
export const ArrowBigRightDash = /* @__PURE__ */ createIcon('ArrowBigRightDash', GLYPHS.ArrowBigRightDash)
export const ArrowDown = /* @__PURE__ */ createIcon('ArrowDown', GLYPHS.ArrowDown)
export const ArrowDownToLine = /* @__PURE__ */ createIcon('ArrowDownToLine', GLYPHS.ArrowDownToLine)
export const ArrowDownUp = /* @__PURE__ */ createIcon('ArrowDownUp', GLYPHS.ArrowDownUp)
export const ArrowDownWideNarrow = /* @__PURE__ */ createIcon('ArrowDownWideNarrow', GLYPHS.ArrowDownWideNarrow)
export const ArrowLeft = /* @__PURE__ */ createIcon('ArrowLeft', GLYPHS.ArrowLeft)
export const ArrowLeftFromLine = /* @__PURE__ */ createIcon('ArrowLeftFromLine', GLYPHS.ArrowLeftFromLine)
export const ArrowRight = /* @__PURE__ */ createIcon('ArrowRight', GLYPHS.ArrowRight)
export const ArrowUp = /* @__PURE__ */ createIcon('ArrowUp', GLYPHS.ArrowUp)
export const ArrowUpFromLine = /* @__PURE__ */ createIcon('ArrowUpFromLine', GLYPHS.ArrowUpFromLine)
export const ArrowUpNarrowWide = /* @__PURE__ */ createIcon('ArrowUpNarrowWide', GLYPHS.ArrowUpNarrowWide)
export const ArrowUpRight = /* @__PURE__ */ createIcon('ArrowUpRight', GLYPHS.ArrowUpRight)
export const ArrowsInLineHorizontal = /* @__PURE__ */ createIcon('ArrowsInLineHorizontal', GLYPHS.ArrowsInLineHorizontal)
export const ArrowsOutLineHorizontal = /* @__PURE__ */ createIcon('ArrowsOutLineHorizontal', GLYPHS.ArrowsOutLineHorizontal)
export const Article = /* @__PURE__ */ createIcon('Article', GLYPHS.Article)
export const Backspace = /* @__PURE__ */ createIcon('Backspace', GLYPHS.Backspace)
export const Ban = /* @__PURE__ */ createIcon('Ban', GLYPHS.Ban)
export const Bell = /* @__PURE__ */ createIcon('Bell', GLYPHS.Bell)
export const BookDownload = /* @__PURE__ */ createIcon('BookDownload', GLYPHS.BookDownload)
export const BookOpen = /* @__PURE__ */ createIcon('BookOpen', GLYPHS.BookOpen)
export const BookOpenCheck = /* @__PURE__ */ createIcon('BookOpenCheck', GLYPHS.BookOpenCheck)
export const BookOpenText = /* @__PURE__ */ createIcon('BookOpenText', GLYPHS.BookOpenText)
export const Bookmark = /* @__PURE__ */ createIcon('Bookmark', GLYPHS.Bookmark)
export const BookSearch = /* @__PURE__ */ createIcon('BookSearch', GLYPHS.BookSearch)
export const Bot = /* @__PURE__ */ createIcon('Bot', GLYPHS.Bot)
export const Braces = /* @__PURE__ */ createIcon('Braces', GLYPHS.Braces)
export const Brain = /* @__PURE__ */ createIcon('Brain', GLYPHS.Brain)
export const Bug = /* @__PURE__ */ createIcon('Bug', GLYPHS.Bug)
export const CalendarCheck = /* @__PURE__ */ createIcon('CalendarCheck', GLYPHS.CalendarCheck)
export const Camera = /* @__PURE__ */ createIcon('Camera', GLYPHS.Camera)
export const Chart = /* @__PURE__ */ createIcon('Chart', GLYPHS.Chart)
export const Chat01 = /* @__PURE__ */ createIcon('Chat01', GLYPHS.Chat01)
export const ChatText = /* @__PURE__ */ createIcon('ChatText', GLYPHS.ChatText)
export const Check = /* @__PURE__ */ createIcon('Check', GLYPHS.Check)
export const CheckCircle2 = /* @__PURE__ */ createIcon('CheckCircle2', GLYPHS.CheckCircle2)
export const CheckSquareOffset = /* @__PURE__ */ createIcon('CheckSquareOffset', GLYPHS.CheckSquareOffset)
export const ChevronDown = /* @__PURE__ */ createIcon('ChevronDown', GLYPHS.ChevronDown)
export const ChevronLeft = /* @__PURE__ */ createIcon('ChevronLeft', GLYPHS.ChevronLeft)
export const ChevronRight = /* @__PURE__ */ createIcon('ChevronRight', GLYPHS.ChevronRight)
export const ChevronUp = /* @__PURE__ */ createIcon('ChevronUp', GLYPHS.ChevronUp)
export const ChevronsDownUp = /* @__PURE__ */ createIcon('ChevronsDownUp', GLYPHS.ChevronsDownUp)
export const ChevronsUpDown = /* @__PURE__ */ createIcon('ChevronsUpDown', GLYPHS.ChevronsUpDown)
export const Circle = /* @__PURE__ */ createIcon('Circle', GLYPHS.Circle)
export const CircleAlert = /* @__PURE__ */ createIcon('CircleAlert', GLYPHS.CircleAlert)
export const CircleCheck = /* @__PURE__ */ createIcon('CircleCheck', GLYPHS.CircleCheck)
export const CircleDashed = /* @__PURE__ */ createIcon('CircleDashed', GLYPHS.CircleDashed)
export const CircleHelp = /* @__PURE__ */ createIcon('CircleHelp', GLYPHS.CircleHelp)
export const CircleOff = /* @__PURE__ */ createIcon('CircleOff', GLYPHS.CircleOff)
export const CircleX = /* @__PURE__ */ createIcon('CircleX', GLYPHS.CircleX)
export const Clock = /* @__PURE__ */ createIcon('Clock', GLYPHS.Clock)
export const Clock3 = /* @__PURE__ */ createIcon('Clock3', GLYPHS.Clock3)
export const CloudDownload = /* @__PURE__ */ createIcon('CloudDownload', GLYPHS.CloudDownload)
export const Command = /* @__PURE__ */ createIcon('Command', GLYPHS.Command)
export const CommandLine = /* @__PURE__ */ createIcon('CommandLine', GLYPHS.CommandLine)
export const Compass = /* @__PURE__ */ createIcon('Compass', GLYPHS.Compass)
export const Control = /* @__PURE__ */ createIcon('Control', GLYPHS.Control)
export const Copy = /* @__PURE__ */ createIcon('Copy', GLYPHS.Copy)
export const Dashboard = /* @__PURE__ */ createIcon('Dashboard', GLYPHS.Dashboard)
export const Database = /* @__PURE__ */ createIcon('Database', GLYPHS.Database)
export const Diff = /* @__PURE__ */ createIcon('Diff', GLYPHS.Diff)
export const Download = /* @__PURE__ */ createIcon('Download', GLYPHS.Download)
export const ExternalLink = /* @__PURE__ */ createIcon('ExternalLink', GLYPHS.ExternalLink)
export const Eye = /* @__PURE__ */ createIcon('Eye', GLYPHS.Eye)
export const EyeOff = /* @__PURE__ */ createIcon('EyeOff', GLYPHS.EyeOff)
export const FileCode2 = /* @__PURE__ */ createIcon('FileCode2', GLYPHS.FileCode2)
export const FileDiff = /* @__PURE__ */ createIcon('FileDiff', GLYPHS.FileDiff)
export const FilePen = /* @__PURE__ */ createIcon('FilePen', GLYPHS.FilePen)
export const FilePlus2 = /* @__PURE__ */ createIcon('FilePlus2', GLYPHS.FilePlus2)
export const FileSearch = /* @__PURE__ */ createIcon('FileSearch', GLYPHS.FileSearch)
export const FileSearch2 = /* @__PURE__ */ createIcon('FileSearch2', GLYPHS.FileSearch2)
export const FileText = /* @__PURE__ */ createIcon('FileText', GLYPHS.FileText)
export const FirstAidKit = /* @__PURE__ */ createIcon('FirstAidKit', GLYPHS.FirstAidKit)
export const Flask = /* @__PURE__ */ createIcon('Flask', GLYPHS.Flask)
export const Focus = /* @__PURE__ */ createIcon('Focus', GLYPHS.Focus)
export const Folder = /* @__PURE__ */ createIcon('Folder', GLYPHS.Folder)
export const FolderInput = /* @__PURE__ */ createIcon('FolderInput', GLYPHS.FolderInput)
export const FolderKanban = /* @__PURE__ */ createIcon('FolderKanban', GLYPHS.FolderKanban)
export const FolderOpen = /* @__PURE__ */ createIcon('FolderOpen', GLYPHS.FolderOpen)
export const FolderPlus = /* @__PURE__ */ createIcon('FolderPlus', GLYPHS.FolderPlus)
export const FolderSearch = /* @__PURE__ */ createIcon('FolderSearch', GLYPHS.FolderSearch)
export const FolderTree = /* @__PURE__ */ createIcon('FolderTree', GLYPHS.FolderTree)
export const Subagent = /* @__PURE__ */ createIcon('Subagent', GLYPHS.Subagent)
export const GitFork = /* @__PURE__ */ createIcon('GitFork', GLYPHS.GitFork)
export const GitPullRequest = /* @__PURE__ */ createIcon('GitPullRequest', GLYPHS.GitPullRequest)
export const Globe = /* @__PURE__ */ createIcon('Globe', GLYPHS.Globe)
export const Globe2 = /* @__PURE__ */ createIcon('Globe2', GLYPHS.Globe2)
export const Skills = /* @__PURE__ */ createIcon('Skills', GLYPHS.Skills)
export const History = /* @__PURE__ */ createIcon('History', GLYPHS.History)
export const Image = /* @__PURE__ */ createIcon('Image', GLYPHS.Image)
export const ImageIcon = /* @__PURE__ */ createIcon('ImageIcon', GLYPHS.ImageIcon)
export const ImagePlus = /* @__PURE__ */ createIcon('ImagePlus', GLYPHS.ImagePlus)
export const Info = /* @__PURE__ */ createIcon('Info', GLYPHS.Info)
export const InstallingUpdates = /* @__PURE__ */ createIcon('InstallingUpdates', GLYPHS.InstallingUpdates)
export const Keyboard = /* @__PURE__ */ createIcon('Keyboard', GLYPHS.Keyboard)
export const KeyRound = /* @__PURE__ */ createIcon('KeyRound', GLYPHS.KeyRound)
export const Layers = /* @__PURE__ */ createIcon('Layers', GLYPHS.Layers)
export const Lightbulb = /* @__PURE__ */ createIcon('Lightbulb', GLYPHS.Lightbulb)
export const Link2 = /* @__PURE__ */ createIcon('Link2', GLYPHS.Link2)
export const LinkSimple = /* @__PURE__ */ createIcon('LinkSimple', GLYPHS.LinkSimple)
export const ListChecks = /* @__PURE__ */ createIcon('ListChecks', GLYPHS.ListChecks)
export const ListIndentIncrease = /* @__PURE__ */ createIcon('ListIndentIncrease', GLYPHS.ListIndentIncrease)
export const ListTodo = /* @__PURE__ */ createIcon('ListTodo', GLYPHS.ListTodo)
export const ListTree = /* @__PURE__ */ createIcon('ListTree', GLYPHS.ListTree)
export const Loader2 = /* @__PURE__ */ createIcon('Loader2', GLYPHS.Loader2)
export const LoaderCircle = /* @__PURE__ */ createIcon('LoaderCircle', GLYPHS.LoaderCircle)
export const LogOut = /* @__PURE__ */ createIcon('LogOut', GLYPHS.LogOut)
export const Maximize2 = /* @__PURE__ */ createIcon('Maximize2', GLYPHS.Maximize2)
export const MessageCirclePlus = /* @__PURE__ */ createIcon('MessageCirclePlus', GLYPHS.MessageCirclePlus)
export const MessageSquare = /* @__PURE__ */ createIcon('MessageSquare', GLYPHS.MessageSquare)
export const MessageSquareDashed = /* @__PURE__ */ createIcon('MessageSquareDashed', GLYPHS.MessageSquareDashed)
export const MessageSquarePlus = /* @__PURE__ */ createIcon('MessageSquarePlus', GLYPHS.MessageSquarePlus)
export const MessageSquareText = /* @__PURE__ */ createIcon('MessageSquareText', GLYPHS.MessageSquareText)
export const Minimize2 = /* @__PURE__ */ createIcon('Minimize2', GLYPHS.Minimize2)
export const Minus = /* @__PURE__ */ createIcon('Minus', GLYPHS.Minus)
export const Monitor = /* @__PURE__ */ createIcon('Monitor', GLYPHS.Monitor)
export const Moon = /* @__PURE__ */ createIcon('Moon', GLYPHS.Moon)
export const MoreHorizontal = /* @__PURE__ */ createIcon('MoreHorizontal', GLYPHS.MoreHorizontal)
export const MoreVertical = /* @__PURE__ */ createIcon('MoreVertical', GLYPHS.MoreVertical)
export const MousePointer2 = /* @__PURE__ */ createIcon('MousePointer2', GLYPHS.MousePointer2)
export const MousePointerClick = /* @__PURE__ */ createIcon('MousePointerClick', GLYPHS.MousePointerClick)
export const MusicNote = /* @__PURE__ */ createIcon('MusicNote', GLYPHS.MusicNote)
export const Navigation = /* @__PURE__ */ createIcon('Navigation', GLYPHS.Navigation)
export const Network = /* @__PURE__ */ createIcon('Network', GLYPHS.Network)
export const Option = /* @__PURE__ */ createIcon('Option', GLYPHS.Option)
export const Palette = /* @__PURE__ */ createIcon('Palette', GLYPHS.Palette)
export const Printer = /* @__PURE__ */ createIcon('Printer', GLYPHS.Printer)
export const PanelLeft = /* @__PURE__ */ createIcon('PanelLeft', GLYPHS.PanelLeft)
export const PanelRight = /* @__PURE__ */ createIcon('PanelRight', GLYPHS.PanelRight)
export const Paperclip = /* @__PURE__ */ createIcon('Paperclip', GLYPHS.Paperclip)
export const PenNib = /* @__PURE__ */ createIcon('PenNib', GLYPHS.PenNib)
export const Pencil = /* @__PURE__ */ createIcon('Pencil', GLYPHS.Pencil)
export const PencilLine = /* @__PURE__ */ createIcon('PencilLine', GLYPHS.PencilLine)
export const PencilSparkles = /* @__PURE__ */ createIcon('PencilSparkles', GLYPHS.PencilSparkles)
export const Pause = /* @__PURE__ */ createIcon('Pause', GLYPHS.Pause)
export const Play = /* @__PURE__ */ createIcon('Play', GLYPHS.Play)
export const Pin = /* @__PURE__ */ createIcon('Pin', GLYPHS.Pin)
export const PinOff = /* @__PURE__ */ createIcon('PinOff', GLYPHS.PinOff)
export const PictureInPicture2 = /* @__PURE__ */ createIcon('PictureInPicture2', GLYPHS.PictureInPicture2)
export const Plug = /* @__PURE__ */ createIcon('Plug', GLYPHS.Plug)
export const PlugZap = /* @__PURE__ */ createIcon('PlugZap', GLYPHS.PlugZap)
export const Plus = /* @__PURE__ */ createIcon('Plus', GLYPHS.Plus)
export const Power = /* @__PURE__ */ createIcon('Power', GLYPHS.Power)
export const Puzzle = /* @__PURE__ */ createIcon('Puzzle', GLYPHS.Puzzle)
export const RefreshCw = /* @__PURE__ */ createIcon('RefreshCw', GLYPHS.RefreshCw)
export const Replace = /* @__PURE__ */ createIcon('Replace', GLYPHS.Replace)
export const RotateCcw = /* @__PURE__ */ createIcon('RotateCcw', GLYPHS.RotateCcw)
export const ScanSearch = /* @__PURE__ */ createIcon('ScanSearch', GLYPHS.ScanSearch)
export const ScanText = /* @__PURE__ */ createIcon('ScanText', GLYPHS.ScanText)
export const ScrollText = /* @__PURE__ */ createIcon('ScrollText', GLYPHS.ScrollText)
export const Search = /* @__PURE__ */ createIcon('Search', GLYPHS.Search)
export const SearchCode = /* @__PURE__ */ createIcon('SearchCode', GLYPHS.SearchCode)
export const SearchX = /* @__PURE__ */ createIcon('SearchX', GLYPHS.SearchX)
export const Selection = /* @__PURE__ */ createIcon('Selection', GLYPHS.Selection)
export const Send = /* @__PURE__ */ createIcon('Send', GLYPHS.Send)
export const Settings = /* @__PURE__ */ createIcon('Settings', GLYPHS.Settings)
export const Smartphone = /* @__PURE__ */ createIcon('Smartphone', GLYPHS.Smartphone)
export const Settings2 = /* @__PURE__ */ createIcon('Settings2', GLYPHS.Settings2)
export const Shapes = /* @__PURE__ */ createIcon('Shapes', GLYPHS.Shapes)
export const ShieldCheck = /* @__PURE__ */ createIcon('ShieldCheck', GLYPHS.ShieldCheck)
export const NotebookPen = /* @__PURE__ */ createIcon('NotebookPen', GLYPHS.NotebookPen)
export const Sparkles = /* @__PURE__ */ createIcon('Sparkles', GLYPHS.Sparkles)
export const SourceCode = /* @__PURE__ */ createIcon('SourceCode', GLYPHS.SourceCode)
export const Square = /* @__PURE__ */ createIcon('Square', GLYPHS.Square)
export const SquareArrowOutUpRight = /* @__PURE__ */ createIcon('SquareArrowOutUpRight', GLYPHS.SquareArrowOutUpRight)
export const SquareFunction = /* @__PURE__ */ createIcon('SquareFunction', GLYPHS.SquareFunction)
export const SquareTerminal = /* @__PURE__ */ createIcon('SquareTerminal', GLYPHS.SquareTerminal)
export const StepForward = /* @__PURE__ */ createIcon('StepForward', GLYPHS.StepForward)
export const Stamp = /* @__PURE__ */ createIcon('Stamp', GLYPHS.Stamp)
export const Stethoscope = /* @__PURE__ */ createIcon('Stethoscope', GLYPHS.Stethoscope)
export const StickyNotePlus = /* @__PURE__ */ createIcon('StickyNotePlus', GLYPHS.StickyNotePlus)
export const Subtitle = /* @__PURE__ */ createIcon('Subtitle', GLYPHS.Subtitle)
export const Sun = /* @__PURE__ */ createIcon('Sun', GLYPHS.Sun)
export const Terminal = /* @__PURE__ */ createIcon('Terminal', GLYPHS.Terminal)
export const TextAlignCenter = /* @__PURE__ */ createIcon('TextAlignCenter', GLYPHS.TextAlignCenter)
export const TextFont = /* @__PURE__ */ createIcon('TextFont', GLYPHS.TextFont)
export const TextSearch = /* @__PURE__ */ createIcon('TextSearch', GLYPHS.TextSearch)
export const Type = /* @__PURE__ */ createIcon('Type', GLYPHS.Type)
export const WrapText = /* @__PURE__ */ createIcon('WrapText', GLYPHS.WrapText)
export const ThumbsDown = /* @__PURE__ */ createIcon('ThumbsDown', GLYPHS.ThumbsDown)
export const ThumbsUp = /* @__PURE__ */ createIcon('ThumbsUp', GLYPHS.ThumbsUp)
export const Timer = /* @__PURE__ */ createIcon('Timer', GLYPHS.Timer)
export const Trash2 = /* @__PURE__ */ createIcon('Trash2', GLYPHS.Trash2)
export const Undo2 = /* @__PURE__ */ createIcon('Undo2', GLYPHS.Undo2)
export const Upload = /* @__PURE__ */ createIcon('Upload', GLYPHS.Upload)
export const User = /* @__PURE__ */ createIcon('User', GLYPHS.User)
export const UserRoundArrowLeft = /* @__PURE__ */ createIcon('UserRoundArrowLeft', GLYPHS.UserRoundArrowLeft)
export const WandSparkles = /* @__PURE__ */ createIcon('WandSparkles', GLYPHS.WandSparkles)
export const Waypoints = /* @__PURE__ */ createIcon('Waypoints', GLYPHS.Waypoints)
export const Wrench = /* @__PURE__ */ createIcon('Wrench', GLYPHS.Wrench)
export const X = /* @__PURE__ */ createIcon('X', GLYPHS.X)
export const XCircle = /* @__PURE__ */ createIcon('XCircle', GLYPHS.XCircle)
export const XSquare = /* @__PURE__ */ createIcon('XSquare', GLYPHS.XSquare)
export const Zap = /* @__PURE__ */ createIcon('Zap', GLYPHS.Zap)
export const ZoomIn = /* @__PURE__ */ createIcon('ZoomIn', GLYPHS.ZoomIn)
export const ZoomOut = /* @__PURE__ */ createIcon('ZoomOut', GLYPHS.ZoomOut)
