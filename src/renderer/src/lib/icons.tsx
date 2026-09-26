import { forwardRef, type ForwardRefExoticComponent, type RefAttributes } from 'react'
import { type LucideIcon, type LucideProps } from 'lucide-react'
import {
  AlertCircle as AlertCircleGlyph,
  AlertTriangle as AlertTriangleGlyph,
  ArrowBigRightDash as ArrowBigRightDashGlyph,
  ArrowDown as ArrowDownGlyph,
  ArrowDownUp as ArrowDownUpGlyph,
  ArrowDownWideNarrow as ArrowDownWideNarrowGlyph,
  ArrowLeft as ArrowLeftGlyph,
  ArrowLeftFromLine as ArrowLeftFromLineGlyph,
  ArrowRight as ArrowRightGlyph,
  ArrowUp as ArrowUpGlyph,
  ArrowUpNarrowWide as ArrowUpNarrowWideGlyph,
  ArrowUpRight as ArrowUpRightGlyph,
  Ban as BanGlyph,
  Bell as BellGlyph,
  Blocks as BlocksGlyph,
  BookDown as BookDownGlyph,
  Bookmark as BookmarkGlyph,
  BookOpen as BookOpenGlyph,
  BookOpenText as BookOpenTextGlyph,
  BookSearch as BookSearchGlyph,
  Bot as BotGlyph,
  BoxSelect as BoxSelectGlyph,
  Braces as BracesGlyph,
  Brain as BrainGlyph,
  BriefcaseMedical as BriefcaseMedicalGlyph,
  CalendarCheck as CalendarCheckGlyph,
  Camera as CameraGlyph,
  Captions as CaptionsGlyph,
  ChartColumn as ChartColumnGlyph,
  Check as CheckGlyph,
  CheckCircle2 as CheckCircle2Glyph,
  ChevronDown as ChevronDownGlyph,
  ChevronLeft as ChevronLeftGlyph,
  ChevronRight as ChevronRightGlyph,
  ChevronsDownUp as ChevronsDownUpGlyph,
  ChevronsUpDown as ChevronsUpDownGlyph,
  ChevronUp as ChevronUpGlyph,
  Circle as CircleGlyph,
  CircleAlert as CircleAlertGlyph,
  CircleCheck as CircleCheckGlyph,
  CircleDashed as CircleDashedGlyph,
  CircleHelp as CircleHelpGlyph,
  CircleX as CircleXGlyph,
  Clock as ClockGlyph,
  Clock3 as Clock3Glyph,
  CloudDownload as CloudDownloadGlyph,
  Command as CommandGlyph,
  Compass as CompassGlyph,
  Copy as CopyGlyph,
  Database as DatabaseGlyph,
  Delete as DeleteGlyph,
  Diff as DiffGlyph,
  Download as DownloadGlyph,
  Earth as EarthGlyph,
  ExternalLink as ExternalLinkGlyph,
  Eye as EyeGlyph,
  EyeOff as EyeOffGlyph,
  FileCode2 as FileCode2Glyph,
  FileDiff as FileDiffGlyph,
  FilePen as FilePenGlyph,
  FilePlus2 as FilePlus2Glyph,
  FileSearch as FileSearchGlyph,
  FileSearch2 as FileSearch2Glyph,
  FileText as FileTextGlyph,
  FlaskConical as FlaskConicalGlyph,
  Focus as FocusGlyph,
  Folder as FolderGlyph,
  FolderInput as FolderInputGlyph,
  FolderKanban as FolderKanbanGlyph,
  FolderOpen as FolderOpenGlyph,
  FolderPlus as FolderPlusGlyph,
  FolderTree as FolderTreeGlyph,
  FoldHorizontal as FoldHorizontalGlyph,
  GitFork as GitForkGlyph,
  GitPullRequest as GitPullRequestGlyph,
  Globe2 as Globe2Glyph,
  HatGlasses as HatGlassesGlyph,
  History as HistoryGlyph,
  Image as ImageGlyph,
  ImageIcon as ImageIconGlyph,
  ImagePlus as ImagePlusGlyph,
  Info as InfoGlyph,
  Keyboard as KeyboardGlyph,
  KeyRound as KeyRoundGlyph,
  Layers as LayersGlyph,
  LayoutDashboard as LayoutDashboardGlyph,
  Lightbulb as LightbulbGlyph,
  Link2 as Link2Glyph,
  ListChecks as ListChecksGlyph,
  ListIndentIncrease as ListIndentIncreaseGlyph,
  ListTodo as ListTodoGlyph,
  ListTree as ListTreeGlyph,
  Loader2 as Loader2Glyph,
  LoaderCircle as LoaderCircleGlyph,
  LogOut as LogOutGlyph,
  Maximize2 as Maximize2Glyph,
  MessageCircleMore as MessageCircleMoreGlyph,
  MessageCirclePlus as MessageCirclePlusGlyph,
  MessageSquare as MessageSquareGlyph,
  MessageSquareDashed as MessageSquareDashedGlyph,
  MessageSquarePlus as MessageSquarePlusGlyph,
  MessageSquareText as MessageSquareTextGlyph,
  MessagesSquare as MessagesSquareGlyph,
  Minimize2 as Minimize2Glyph,
  Minus as MinusGlyph,
  Monitor as MonitorGlyph,
  Moon as MoonGlyph,
  MoreHorizontal as MoreHorizontalGlyph,
  MoreVertical as MoreVerticalGlyph,
  MousePointer2 as MousePointer2Glyph,
  MousePointerClick as MousePointerClickGlyph,
  Music as MusicGlyph,
  Navigation as NavigationGlyph,
  Network as NetworkGlyph,
  Newspaper as NewspaperGlyph,
  Option as OptionGlyph,
  PackageOpen as PackageOpenGlyph,
  Palette as PaletteGlyph,
  PanelLeft as PanelLeftGlyph,
  PanelRight as PanelRightGlyph,
  Paperclip as PaperclipGlyph,
  Pen as PenGlyph,
  Pencil as PencilGlyph,
  PencilLine as PencilLineGlyph,
  Pin as PinGlyph,
  PinOff as PinOffGlyph,
  Plug as PlugGlyph,
  PlugZap as PlugZapGlyph,
  Plus as PlusGlyph,
  Power as PowerGlyph,
  Printer as PrinterGlyph,
  Puzzle as PuzzleGlyph,
  RefreshCw as RefreshCwGlyph,
  Replace as ReplaceGlyph,
  RotateCcw as RotateCcwGlyph,
  ScanSearch as ScanSearchGlyph,
  ScanText as ScanTextGlyph,
  ScrollText as ScrollTextGlyph,
  Search as SearchGlyph,
  SearchCode as SearchCodeGlyph,
  SearchX as SearchXGlyph,
  Send as SendGlyph,
  Settings as SettingsGlyph,
  Settings2 as Settings2Glyph,
  Shapes as ShapesGlyph,
  ShieldCheck as ShieldCheckGlyph,
  Siren as SirenGlyph,
  Smartphone as SmartphoneGlyph,
  Sparkles as SparklesGlyph,
  Square as SquareGlyph,
  SquareArrowOutUpRight as SquareArrowOutUpRightGlyph,
  SquareCheckBig as SquareCheckBigGlyph,
  SquareCode as SquareCodeGlyph,
  SquareFunction as SquareFunctionGlyph,
  SquareTerminal as SquareTerminalGlyph,
  Stamp as StampGlyph,
  Stethoscope as StethoscopeGlyph,
  Sun as SunGlyph,
  Terminal as TerminalGlyph,
  TerminalSquare as TerminalSquareGlyph,
  TextAlignCenter as TextAlignCenterGlyph,
  TextSearch as TextSearchGlyph,
  ThumbsDown as ThumbsDownGlyph,
  ThumbsUp as ThumbsUpGlyph,
  Timer as TimerGlyph,
  Trash2 as Trash2Glyph,
  Type as TypeGlyph,
  TypeOutline as TypeOutlineGlyph,
  Undo2 as Undo2Glyph,
  UnfoldHorizontal as UnfoldHorizontalGlyph,
  Upload as UploadGlyph,
  User as UserGlyph,
  WandSparkles as WandSparklesGlyph,
  WrapText as WrapTextGlyph,
  Wrench as WrenchGlyph,
  X as XGlyph,
  XCircle as XCircleGlyph,
  XSquare as XSquareGlyph,
  Zap as ZapGlyph,
  ZoomIn as ZoomInGlyph,
  ZoomOut as ZoomOutGlyph
} from 'lucide-react'

/**
 * Every UI glyph in the app comes through this one adapter, so a call site never
 * imports an icon package: it asks for a semantic name (`Search`,
 * `ChevronDown`) and gets the app's Lucide artwork.
 *
 * **Lucide is the app's one UI icon family.** Its drawings are 24-grid stroked
 * centerlines at a 2px default weight, so THIS adapter passes Lucide's own props
 * straight through — `size`, `strokeWidth` and `absoluteStrokeWidth` all mean
 * what the library says they mean (a stroke family is the reason those props
 * exist; the fill-artwork families the app has also used had to drop them). The
 * interface style preference (`lib/ui-style.ts`) changes corners, not icons, so
 * 直角 and 超椭圆 draw the same glyphs.
 *
 * The table below is the app's ONE mapping: semantic name → Lucide drawing. Most
 * names are Lucide's own (the vocabulary came from Lucide originally); the ones
 * Lucide has no drawing for take the nearest it carries, and those are called
 * out here rather than left to be rediscovered — `Earth` for the app's web and
 * browser marks (Lucide ships no brand drawings, so the browser tab, the browser
 * tool category and the in-pane page placeholders all draw it), `HatGlasses`
 * for the subagent mark (an undercover helper), `MessageCircleMore` for the
 * chat-text mark, `BoxSelect` for a marquee selection, `ChevronUp` for the ⌃
 * key cap (so `ChevronUp` and `Control` share one drawing), `Newspaper` for
 * an article, `Delete` for the backspace key, `SquareCheckBig` for the offset
 * checkbox, `FoldHorizontal` / `UnfoldHorizontal` for the side-panel
 * fullscreen pair. Names that share a drawing stay shared: a name exists per
 * meaning, not per drawing.
 *
 * `@phosphor-icons/react` stays declared in package.json on purpose: it is the
 * previous family, kept so a revert is a `git revert` of this file — nothing in
 * `src/` imports it any more.
 *
 * Not icons, and deliberately not here: the mac ⇧ key cap in
 * [ShortcutKeys.tsx](src/renderer/src/components/app/ShortcutKeys.tsx) is drawn
 * app-side, because Lucide ships ⌘ and ⌥ (`Command`, `Option`) and this adapter
 * maps ⌃ to its `ChevronUp` caret, but no shift drawing; the drawn marks in
 * `lib/animated-icons.tsx` are Lucide geometry too (they animate a pathLength
 * draw, which is what a stroke family is for); the waiting arc
 * (`lib/status-ring.tsx`) and the progress rings are geometry, not glyphs.
 */
export type IconProps = Omit<LucideProps, 'ref'>
export type IconComponent = ForwardRefExoticComponent<IconProps & RefAttributes<SVGSVGElement>>

/** Exactly one Lucide drawing per semantic name. */
const GLYPHS = {
  AlertCircle: AlertCircleGlyph,
  AlertTriangle: AlertTriangleGlyph,
  ArrowBigRightDash: ArrowBigRightDashGlyph,
  ArrowDown: ArrowDownGlyph,
  ArrowDownUp: ArrowDownUpGlyph,
  ArrowDownWideNarrow: ArrowDownWideNarrowGlyph,
  ArrowLeft: ArrowLeftGlyph,
  ArrowLeftFromLine: ArrowLeftFromLineGlyph,
  ArrowRight: ArrowRightGlyph,
  ArrowUp: ArrowUpGlyph,
  ArrowUpNarrowWide: ArrowUpNarrowWideGlyph,
  ArrowUpRight: ArrowUpRightGlyph,
  ArrowsInLineHorizontal: FoldHorizontalGlyph,
  ArrowsOutLineHorizontal: UnfoldHorizontalGlyph,
  Article: NewspaperGlyph,
  Backspace: DeleteGlyph,
  Ban: BanGlyph,
  Bell: BellGlyph,
  BookDownload: BookDownGlyph,
  BookOpen: BookOpenGlyph,
  BookOpenText: BookOpenTextGlyph,
  Bookmark: BookmarkGlyph,
  BookSearch: BookSearchGlyph,
  Bot: BotGlyph,
  Braces: BracesGlyph,
  Brain: BrainGlyph,
  CalendarCheck: CalendarCheckGlyph,
  Camera: CameraGlyph,
  Chart: ChartColumnGlyph,
  Chat01: MessagesSquareGlyph,
  ChatText: MessageCircleMoreGlyph,
  Check: CheckGlyph,
  CheckCircle2: CheckCircle2Glyph,
  CheckSquareOffset: SquareCheckBigGlyph,
  ChevronDown: ChevronDownGlyph,
  ChevronLeft: ChevronLeftGlyph,
  ChevronRight: ChevronRightGlyph,
  ChevronUp: ChevronUpGlyph,
  ChevronsDownUp: ChevronsDownUpGlyph,
  ChevronsUpDown: ChevronsUpDownGlyph,
  Circle: CircleGlyph,
  CircleAlert: CircleAlertGlyph,
  CircleCheck: CircleCheckGlyph,
  CircleDashed: CircleDashedGlyph,
  CircleHelp: CircleHelpGlyph,
  CircleX: CircleXGlyph,
  Clock: ClockGlyph,
  Clock3: Clock3Glyph,
  CloudDownload: CloudDownloadGlyph,
  Command: CommandGlyph,
  CommandLine: TerminalSquareGlyph,
  Compass: CompassGlyph,
  Control: ChevronUpGlyph,
  Copy: CopyGlyph,
  Dashboard: LayoutDashboardGlyph,
  Database: DatabaseGlyph,
  Diff: DiffGlyph,
  Download: DownloadGlyph,
  ExternalLink: ExternalLinkGlyph,
  Eye: EyeGlyph,
  EyeOff: EyeOffGlyph,
  FileCode2: FileCode2Glyph,
  FileDiff: FileDiffGlyph,
  FilePen: FilePenGlyph,
  FilePlus2: FilePlus2Glyph,
  FileSearch: FileSearchGlyph,
  FileSearch2: FileSearch2Glyph,
  FileText: FileTextGlyph,
  FirstAidKit: BriefcaseMedicalGlyph,
  Flask: FlaskConicalGlyph,
  Focus: FocusGlyph,
  Folder: FolderGlyph,
  FolderInput: FolderInputGlyph,
  FolderKanban: FolderKanbanGlyph,
  FolderOpen: FolderOpenGlyph,
  FolderPlus: FolderPlusGlyph,
  FolderTree: FolderTreeGlyph,
  Subagent: HatGlassesGlyph,
  GitFork: GitForkGlyph,
  GitPullRequest: GitPullRequestGlyph,
  Globe: EarthGlyph,
  Globe2: Globe2Glyph,
  Skills: BlocksGlyph,
  History: HistoryGlyph,
  Image: ImageGlyph,
  ImageIcon: ImageIconGlyph,
  ImagePlus: ImagePlusGlyph,
  Info: InfoGlyph,
  InstallingUpdates: PackageOpenGlyph,
  Keyboard: KeyboardGlyph,
  KeyRound: KeyRoundGlyph,
  Layers: LayersGlyph,
  Lightbulb: LightbulbGlyph,
  Link2: Link2Glyph,
  LinkSimple: Link2Glyph,
  ListChecks: ListChecksGlyph,
  ListIndentIncrease: ListIndentIncreaseGlyph,
  ListTodo: ListTodoGlyph,
  ListTree: ListTreeGlyph,
  Loader2: Loader2Glyph,
  LoaderCircle: LoaderCircleGlyph,
  LogOut: LogOutGlyph,
  Maximize2: Maximize2Glyph,
  MessageCirclePlus: MessageCirclePlusGlyph,
  MessageSquare: MessageSquareGlyph,
  MessageSquareDashed: MessageSquareDashedGlyph,
  MessageSquarePlus: MessageSquarePlusGlyph,
  MessageSquareText: MessageSquareTextGlyph,
  Minimize2: Minimize2Glyph,
  Minus: MinusGlyph,
  Monitor: MonitorGlyph,
  Moon: MoonGlyph,
  MoreHorizontal: MoreHorizontalGlyph,
  MoreVertical: MoreVerticalGlyph,
  MousePointer2: MousePointer2Glyph,
  MousePointerClick: MousePointerClickGlyph,
  MusicNote: MusicGlyph,
  Navigation: NavigationGlyph,
  Network: NetworkGlyph,
  Option: OptionGlyph,
  Palette: PaletteGlyph,
  Printer: PrinterGlyph,
  PanelLeft: PanelLeftGlyph,
  PanelRight: PanelRightGlyph,
  Paperclip: PaperclipGlyph,
  PenNib: PenGlyph,
  Pencil: PencilGlyph,
  PencilLine: PencilLineGlyph,
  Pin: PinGlyph,
  PinOff: PinOffGlyph,
  Plug: PlugGlyph,
  PlugZap: PlugZapGlyph,
  Plus: PlusGlyph,
  Power: PowerGlyph,
  Puzzle: PuzzleGlyph,
  RefreshCw: RefreshCwGlyph,
  Replace: ReplaceGlyph,
  RotateCcw: RotateCcwGlyph,
  ScanSearch: ScanSearchGlyph,
  ScanText: ScanTextGlyph,
  ScrollText: ScrollTextGlyph,
  Search: SearchGlyph,
  SearchCode: SearchCodeGlyph,
  SearchX: SearchXGlyph,
  Selection: BoxSelectGlyph,
  Send: SendGlyph,
  Settings: SettingsGlyph,
  Smartphone: SmartphoneGlyph,
  Settings2: Settings2Glyph,
  Shapes: ShapesGlyph,
  ShieldCheck: ShieldCheckGlyph,
  Siren: SirenGlyph,
  Sparkles: SparklesGlyph,
  SourceCode: SquareCodeGlyph,
  Square: SquareGlyph,
  SquareArrowOutUpRight: SquareArrowOutUpRightGlyph,
  SquareFunction: SquareFunctionGlyph,
  SquareTerminal: SquareTerminalGlyph,
  Stamp: StampGlyph,
  Stethoscope: StethoscopeGlyph,
  Subtitle: CaptionsGlyph,
  Sun: SunGlyph,
  Terminal: TerminalGlyph,
  TextAlignCenter: TextAlignCenterGlyph,
  TextFont: TypeOutlineGlyph,
  TextSearch: TextSearchGlyph,
  Type: TypeGlyph,
  WrapText: WrapTextGlyph,
  ThumbsDown: ThumbsDownGlyph,
  ThumbsUp: ThumbsUpGlyph,
  Timer: TimerGlyph,
  Trash2: Trash2Glyph,
  Undo2: Undo2Glyph,
  Upload: UploadGlyph,
  User: UserGlyph,
  WandSparkles: WandSparklesGlyph,
  Wrench: WrenchGlyph,
  X: XGlyph,
  XCircle: XCircleGlyph,
  XSquare: XSquareGlyph,
  Zap: ZapGlyph,
  ZoomIn: ZoomInGlyph,
  ZoomOut: ZoomOutGlyph
} satisfies Record<string, LucideIcon>

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
export const AlertCircle = /* @__PURE__ */ createIcon('AlertCircle', GLYPHS.AlertCircle)
export const AlertTriangle = /* @__PURE__ */ createIcon('AlertTriangle', GLYPHS.AlertTriangle)
export const ArrowBigRightDash = /* @__PURE__ */ createIcon('ArrowBigRightDash', GLYPHS.ArrowBigRightDash)
export const ArrowDown = /* @__PURE__ */ createIcon('ArrowDown', GLYPHS.ArrowDown)
export const ArrowDownUp = /* @__PURE__ */ createIcon('ArrowDownUp', GLYPHS.ArrowDownUp)
export const ArrowDownWideNarrow = /* @__PURE__ */ createIcon('ArrowDownWideNarrow', GLYPHS.ArrowDownWideNarrow)
export const ArrowLeft = /* @__PURE__ */ createIcon('ArrowLeft', GLYPHS.ArrowLeft)
export const ArrowLeftFromLine = /* @__PURE__ */ createIcon('ArrowLeftFromLine', GLYPHS.ArrowLeftFromLine)
export const ArrowRight = /* @__PURE__ */ createIcon('ArrowRight', GLYPHS.ArrowRight)
export const ArrowUp = /* @__PURE__ */ createIcon('ArrowUp', GLYPHS.ArrowUp)
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
export const BookOpenText = /* @__PURE__ */ createIcon('BookOpenText', GLYPHS.BookOpenText)
export const Bookmark = /* @__PURE__ */ createIcon('Bookmark', GLYPHS.Bookmark)
export const BookSearch = /* @__PURE__ */ createIcon('BookSearch', GLYPHS.BookSearch)
export const Bot = /* @__PURE__ */ createIcon('Bot', GLYPHS.Bot)
export const Braces = /* @__PURE__ */ createIcon('Braces', GLYPHS.Braces)
export const Brain = /* @__PURE__ */ createIcon('Brain', GLYPHS.Brain)
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
export const Pin = /* @__PURE__ */ createIcon('Pin', GLYPHS.Pin)
export const PinOff = /* @__PURE__ */ createIcon('PinOff', GLYPHS.PinOff)
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
export const Siren = /* @__PURE__ */ createIcon('Siren', GLYPHS.Siren)
export const Sparkles = /* @__PURE__ */ createIcon('Sparkles', GLYPHS.Sparkles)
export const SourceCode = /* @__PURE__ */ createIcon('SourceCode', GLYPHS.SourceCode)
export const Square = /* @__PURE__ */ createIcon('Square', GLYPHS.Square)
export const SquareArrowOutUpRight = /* @__PURE__ */ createIcon('SquareArrowOutUpRight', GLYPHS.SquareArrowOutUpRight)
export const SquareFunction = /* @__PURE__ */ createIcon('SquareFunction', GLYPHS.SquareFunction)
export const SquareTerminal = /* @__PURE__ */ createIcon('SquareTerminal', GLYPHS.SquareTerminal)
export const Stamp = /* @__PURE__ */ createIcon('Stamp', GLYPHS.Stamp)
export const Stethoscope = /* @__PURE__ */ createIcon('Stethoscope', GLYPHS.Stethoscope)
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
export const WandSparkles = /* @__PURE__ */ createIcon('WandSparkles', GLYPHS.WandSparkles)
export const Wrench = /* @__PURE__ */ createIcon('Wrench', GLYPHS.Wrench)
export const X = /* @__PURE__ */ createIcon('X', GLYPHS.X)
export const XCircle = /* @__PURE__ */ createIcon('XCircle', GLYPHS.XCircle)
export const XSquare = /* @__PURE__ */ createIcon('XSquare', GLYPHS.XSquare)
export const Zap = /* @__PURE__ */ createIcon('Zap', GLYPHS.Zap)
export const ZoomIn = /* @__PURE__ */ createIcon('ZoomIn', GLYPHS.ZoomIn)
export const ZoomOut = /* @__PURE__ */ createIcon('ZoomOut', GLYPHS.ZoomOut)
