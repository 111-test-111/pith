import {
  createElement,
  forwardRef,
  type ForwardRefExoticComponent,
  type ReactElement,
  type RefAttributes,
  type SVGProps
} from 'react'
import * as Carbon from '@carbon/icons-react'
import {
  Alert01Icon,
  AlertCircleIcon,
  ArrowDown02Icon,
  ArrowDownWideNarrowIcon,
  ArrowExpand01Icon,
  ArrowLeft02Icon,
  ArrowRight02Icon,
  ArrowShrink01Icon,
  ArrowUp02Icon,
  ArrowUpDownIcon,
  ArrowUpNarrowWideIcon,
  ArrowUpRight01Icon,
  BanIcon,
  BookDownloadIcon,
  Bookmark01Icon,
  BookOpenTextIcon,
  BookSearchIcon,
  BotIcon,
  BracesIcon,
  BrainIcon,
  Camera01Icon,
  CancelCircleIcon,
  CancelSquareIcon,
  Chart01Icon,
  Chat01Icon,
  CheckIcon,
  CheckmarkCircle02Icon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronsDownUpIcon,
  ChevronUpIcon,
  CircleIcon,
  CircleXIcon,
  Clock01Icon,
  Clock03Icon,
  CloudDownloadIcon,
  CommandLineIcon,
  CompassIcon,
  CopyIcon,
  DashboardSquare01Icon,
  Database02Icon,
  Delete02Icon,
  DiffIcon,
  Download01Icon,
  ExternalLinkIcon,
  EyeIcon,
  EyeOffIcon,
  FastForwardIcon,
  FileAddIcon,
  FileCodeIcon,
  FileDiffIcon,
  FilePenIcon,
  FileSearchCornerIcon,
  FileSearchIcon,
  FileTextIcon,
  Folder01Icon,
  FolderAddIcon,
  FolderInputIcon,
  FolderKanbanIcon,
  FolderOpenIcon,
  FolderTreeIcon,
  GeometricShapes01Icon,
  GitForkIcon,
  GitPullRequestIcon,
  GlobalIcon,
  Globe02Icon,
  GraduationCapIcon,
  HelpCircleIcon,
  HistoryIcon,
  Image01Icon,
  ImagePlusIcon,
  InfoIcon,
  InstallingUpdates01Icon,
  KeyboardIcon,
  KeyRoundIcon,
  Layers01Icon,
  LightbulbIcon,
  Link02Icon,
  ListChecksIcon,
  ListTodoIcon,
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
  MusicNote01Icon,
  Notification01Icon,
  PaletteIcon,
  PanelLeftIcon,
  PanelRightIcon,
  PaperclipIcon,
  PencilIcon,
  PencilLineIcon,
  PinIcon,
  PinOffIcon,
  PlugIcon,
  PlugZapIcon,
  PlusIcon,
  PrinterIcon,
  PuzzleIcon,
  RefreshCwIcon,
  RewindIcon,
  RotateCcwIcon,
  ScanSearchIcon,
  ScanTextIcon,
  ScrollTextIcon,
  Search01Icon,
  SearchXIcon,
  SendIcon,
  Settings01Icon,
  Settings02Icon,
  ShieldCheckIcon,
  SmartPhone01Icon,
  SourceCodeIcon,
  SparklesIcon,
  SquareArrowOutUpRightIcon,
  SquareIcon,
  SquareTerminalIcon,
  StethoscopeIcon,
  SubtitleIcon,
  Sun01Icon,
  TerminalIcon,
  TextFontIcon,
  TextSearchIcon,
  TextWrapIcon,
  ThumbsDownIcon,
  ThumbsUpIcon,
  Timer01Icon,
  TypeIcon,
  Undo02Icon,
  UnfoldMoreIcon,
  Upload01Icon,
  UserIcon,
  WandSparklesIcon,
  Wrench01Icon,
  XIcon,
  ZapIcon,
  ZoomInIcon,
  ZoomOutIcon,
} from '@hugeicons/core-free-icons'
import { useIconPack } from './icon-pack'

/**
 * App and beUI glyphs share this entry point, and it is a two-pack table: IBM
 * Carbon's line family for the square interface style (fill artwork, 16/20/32
 * grids — see below) and HugeIcons' stroke-rounded family for the squircle style
 * (24×24, stroke artwork). Call sites keep their semantic names and never choose
 * a pack — `iconPackOf(uiStyle)` feeds `lib/icon-pack.tsx`'s context and this
 * file renders whichever glyph the context names.
 *
 * The Carbon glyphs are named through a namespace import (`Carbon.Terminal_3270`)
 * rather than a named import list, because the package's own export names
 * collide with this file's semantic exports (`FolderTree`, `Globe`, `Search`,
 * `User`, `ZoomIn`, … would each merge two declarations). The table row is what
 * records which glyph a name takes; the build tree-shakes the rest away.
 *
 * Carbon does not draw on one grid: its utility glyphs are 16×16 (the arrows,
 * the carets, search, settings, user, view, upload, download, launch, …), a few
 * are 20×20 (`Checkmark`, `Time`) and the rest 32×32. 84 of its components also
 * pick their artwork by a `size` prop and default to 16, so the adapter passes
 * the box as width/height and never forwards `size`: every glyph draws the
 * artwork Carbon designs for 16px, which is what the app's Tailwind-sized icons
 * (`size-3.5`, `size-4`) actually are. A glyph whose view box is not 32×32 is
 * therefore expected, not a mistake — `scripts/check-icons.mjs` reads the view
 * box each module draws and asserts the adapter passes it through untouched.
 *
 * The square pack is Carbon because Carbon draws on a square grid with
 * right-angled joins, which is what that style is for. Wherever Carbon carries
 * both a round and a square mark the SQUARE one wins — `Info` →
 * `InformationSquare`, `AlertCircle` → `WarningSquare`, the success marks →
 * `CheckboxChecked`/`CheckboxCheckedFilled`, the two overflow marks →
 * `OverflowMenu*`, the two side panels → `OpenPanelLeft`/`OpenPanelRight`, the
 * stop mark → `SquareSolid` — and the round glyphs that remain are the ones
 * Carbon draws no square form of (`DotMark` for the status dot, `Help` for the
 * circled question mark, `ColorPalette`, and Carbon's two circle-X marks).
 *
 * Most names are Carbon's own for the same concept; the rest are semantic
 * matches rather than spelling matches, and each deliberate choice is recorded
 * here rather than at a call site:
 *
 *   Braces → Json (tool-call arguments are JSON), Ban → SquareSlash (Carbon's
 *   `NotAvailable` is two dashes in this version of the set, not a crossed-out
 *   circle), Puzzle → Extensions (Settings), Sparkles → MagicWand,
 *   WandSparkles → MagicWandFilled, ShieldCheck → Security, Bell → Notification,
 *   ScrollText → DocumentBlank (the prompt file), FilePlus2 → DocumentAdd,
 *   FileCode2 → Script, FilePen/Pencil/PencilLine → Edit/Pen/PenFountain,
 *   FileText → Document, BookOpenText → Book, BookDownload → DocumentDownload,
 *   BookSearch → SearchAdvanced, FileSearch → SearchLocate,
 *   FileSearch2 → SearchLocateMirror, TextSearch → TextMining,
 *   ScanSearch → Scan, ScanText → ScanAlt, ListTodo → Task,
 *   ListChecks → ListChecked, ChevronsDownUp → CollapseAll,
 *   ChevronsUpDown → ChevronSort, MoreVertical/MoreHorizontal →
 *   OverflowMenuVertical/Horizontal (Carbon has a real ⋮ and ⋯, so the square
 *   style needs no rotation), Monitor → Screen, Chart → ChartBar,
 *   Database → DataBase, FolderInput → FolderMoveTo, FolderKanban → Folders,
 *   Globe → Earth and Globe2 → Globe, GitFork → DirectionFork,
 *   GitPullRequest → PullRequest, ArrowDownUp → ArrowsVertical,
 *   ArrowUpNarrowWide/ArrowDownWideNarrow → SortAscending/SortDescending,
 *   ExternalLink → Launch, Rewind → SkipBackOutline,
 *   FastForward → SkipForwardOutline, RefreshCw → Renew, RotateCcw → Reset,
 *   Clock → Time, Clock3 → TimeFilled, InstallingUpdates → Upgrade,
 *   Type → LetterTt (the text-modality mark, distinct from TextFont's size
 *   mark), CircleHelp → Help, CircleCheck → CheckboxChecked,
 *   CheckCircle2 → CheckboxCheckedFilled, CircleX → MisuseOutline,
 *   XCircle → Misuse, MessageSquare → Chat, MessageSquareText → Comments,
 *   MessageSquareDashed → ChatOff, MessageCirclePlus → AddComment,
 *   Wrench → Tools, Palette → ColorPalette, MusicNote → Music,
 *   Stethoscope → Stethoscope, GraduationCap → Education,
 *   Subtitle → ClosedCaption, PanelLeft/PanelRight →
 *   OpenPanelLeft/OpenPanelRight, Paperclip → Attachment, Smartphone → Mobile,
 *   Trash2 → TrashCan, Zap → Flash, Ban → NotAvailable,
 *   SquareTerminal → Terminal_3270 and CommandLine → PromptSession, because
 *   Carbon ships no bare terminal glyph and the three terminal names must stay
 *   distinguishable from the plain `Terminal`, KeyRound → ApiKey (Carbon's
 *   `Key` is the letters "KEY"), Eye/EyeOff →
 *   View/ViewOff, LogOut → Logout, Maximize2/Minimize2 → Maximize/Minimize,
 *   MousePointer2/MousePointerClick → Cursor_1/Cursor_2, Lightbulb → Idea,
 *   Brain → MachineLearningModel (Carbon's `Brainstorm` draws a flow diagram,
 *   not a head, and its `MachineLearning` is deprecated in favour of this one),
 *   ImagePlus → DropPhoto
 *   (Carbon has no image-add), Diff and FileDiff → FileDiff, CircleAlert →
 *   the same WarningSquare as AlertCircle, ImageIcon → the same Image as
 *   Image, and Loader2/LoaderCircle → the same CircleDash.
 *
 * Where Carbon carries no equivalent at all the nearest glyph is used, and it
 * is listed here so the next reader does not go looking for a better one:
 * XSquare → Close (there is no square cancel, and `CloseFilled` would duplicate
 * the `XCircle` mark), PinOff → PinFilled, SearchX → the same Search as
 * Search, MessageSquarePlus → the same AddComment as MessageCirclePlus. Carbon
 * also flags its own `Ai` and `MachineLearning` components as removed in the
 * next major version, which is why neither is used here.
 */
export type IconProps = Omit<SVGProps<SVGSVGElement>, 'ref'> & {
  size?: string | number
  /** Lucide-era call-site compat: accepted; applied only by stroke artwork. */
  absoluteStrokeWidth?: boolean
}
export type IconComponent = ForwardRefExoticComponent<IconProps & RefAttributes<SVGSVGElement>>

/** One HugeIcons glyph: an SVG tag and its attributes, in document order.
 * Pinned locally instead of importing the package's React binding so this
 * adapter keeps ref forwarding, the a11y default and prop passthrough. */
type HugeGlyph = ReadonlyArray<readonly [string, Record<string, string | number>]>

/** Carbon's generated components are `forwardRef` components typed as
 * `CarbonIconType`; loose type for the one render-time cast below. */
type CarbonGlyph = (props: Record<string, unknown>) => ReactElement

/** The pack table: exactly one glyph per pack per semantic name. Adding a name
 * means adding a row here and an export below — nothing else. */
const GLYPHS = {
  AlertCircle: { carbon: Carbon.WarningSquare, huge: AlertCircleIcon },
  AlertTriangle: { carbon: Carbon.WarningAlt, huge: Alert01Icon },
  ArrowDown: { carbon: Carbon.ArrowDown, huge: ArrowDown02Icon },
  ArrowDownUp: { carbon: Carbon.ArrowsVertical, huge: ArrowUpDownIcon },
  ArrowDownWideNarrow: { carbon: Carbon.SortDescending, huge: ArrowDownWideNarrowIcon },
  ArrowLeft: { carbon: Carbon.ArrowLeft, huge: ArrowLeft02Icon },
  ArrowRight: { carbon: Carbon.ArrowRight, huge: ArrowRight02Icon },
  ArrowUp: { carbon: Carbon.ArrowUp, huge: ArrowUp02Icon },
  ArrowUpNarrowWide: { carbon: Carbon.SortAscending, huge: ArrowUpNarrowWideIcon },
  ArrowUpRight: { carbon: Carbon.ArrowUpRight, huge: ArrowUpRight01Icon },
  Ban: { carbon: Carbon.SquareSlash, huge: BanIcon },
  Bell: { carbon: Carbon.Notification, huge: Notification01Icon },
  BookDownload: { carbon: Carbon.DocumentDownload, huge: BookDownloadIcon },
  BookOpenText: { carbon: Carbon.Book, huge: BookOpenTextIcon },
  Bookmark: { carbon: Carbon.Bookmark, huge: Bookmark01Icon },
  BookSearch: { carbon: Carbon.SearchAdvanced, huge: BookSearchIcon },
  Bot: { carbon: Carbon.Bot, huge: BotIcon },
  Braces: { carbon: Carbon.Json, huge: BracesIcon },
  Brain: { carbon: Carbon.MachineLearningModel, huge: BrainIcon },
  Camera: { carbon: Carbon.Camera, huge: Camera01Icon },
  Chart: { carbon: Carbon.ChartBar, huge: Chart01Icon },
  Chat01: { carbon: Carbon.Chat, huge: Chat01Icon },
  Check: { carbon: Carbon.Checkmark, huge: CheckIcon },
  CheckCircle2: { carbon: Carbon.CheckboxCheckedFilled, huge: CheckmarkCircle02Icon },
  ChevronDown: { carbon: Carbon.ChevronDown, huge: ChevronDownIcon },
  ChevronLeft: { carbon: Carbon.ChevronLeft, huge: ChevronLeftIcon },
  ChevronRight: { carbon: Carbon.ChevronRight, huge: ChevronRightIcon },
  ChevronUp: { carbon: Carbon.ChevronUp, huge: ChevronUpIcon },
  ChevronsDownUp: { carbon: Carbon.CollapseAll, huge: ChevronsDownUpIcon },
  ChevronsUpDown: { carbon: Carbon.ChevronSort, huge: UnfoldMoreIcon },
  Circle: { carbon: Carbon.DotMark, huge: CircleIcon },
  CircleAlert: { carbon: Carbon.WarningSquare, huge: AlertCircleIcon },
  CircleCheck: { carbon: Carbon.CheckboxChecked, huge: CheckmarkCircle02Icon },
  CircleHelp: { carbon: Carbon.Help, huge: HelpCircleIcon },
  CircleX: { carbon: Carbon.MisuseOutline, huge: CircleXIcon },
  Clock: { carbon: Carbon.Time, huge: Clock01Icon },
  Clock3: { carbon: Carbon.TimeFilled, huge: Clock03Icon },
  CloudDownload: { carbon: Carbon.CloudDownload, huge: CloudDownloadIcon },
  CommandLine: { carbon: Carbon.PromptSession, huge: CommandLineIcon },
  Compass: { carbon: Carbon.Compass, huge: CompassIcon },
  Copy: { carbon: Carbon.Copy, huge: CopyIcon },
  Dashboard: { carbon: Carbon.Dashboard, huge: DashboardSquare01Icon },
  Database: { carbon: Carbon.DataBase, huge: Database02Icon },
  Diff: { carbon: Carbon.FileDiff, huge: DiffIcon },
  Download: { carbon: Carbon.Download, huge: Download01Icon },
  ExternalLink: { carbon: Carbon.Launch, huge: ExternalLinkIcon },
  Eye: { carbon: Carbon.View, huge: EyeIcon },
  EyeOff: { carbon: Carbon.ViewOff, huge: EyeOffIcon },
  FastForward: { carbon: Carbon.SkipForwardOutline, huge: FastForwardIcon },
  FileCode2: { carbon: Carbon.Script, huge: FileCodeIcon },
  FileDiff: { carbon: Carbon.FileDiff, huge: FileDiffIcon },
  FilePen: { carbon: Carbon.Edit, huge: FilePenIcon },
  FilePlus2: { carbon: Carbon.DocumentAdd, huge: FileAddIcon },
  FileSearch: { carbon: Carbon.SearchLocate, huge: FileSearchIcon },
  FileSearch2: { carbon: Carbon.SearchLocateMirror, huge: FileSearchCornerIcon },
  FileText: { carbon: Carbon.Document, huge: FileTextIcon },
  Folder: { carbon: Carbon.Folder, huge: Folder01Icon },
  FolderInput: { carbon: Carbon.FolderMoveTo, huge: FolderInputIcon },
  FolderKanban: { carbon: Carbon.Folders, huge: FolderKanbanIcon },
  FolderOpen: { carbon: Carbon.FolderOpen, huge: FolderOpenIcon },
  FolderPlus: { carbon: Carbon.FolderAdd, huge: FolderAddIcon },
  FolderTree: { carbon: Carbon.FolderTree, huge: FolderTreeIcon },
  GitFork: { carbon: Carbon.DirectionFork, huge: GitForkIcon },
  GitPullRequest: { carbon: Carbon.PullRequest, huge: GitPullRequestIcon },
  Globe: { carbon: Carbon.Earth, huge: Globe02Icon },
  Globe2: { carbon: Carbon.Globe, huge: GlobalIcon },
  GraduationCap: { carbon: Carbon.Education, huge: GraduationCapIcon },
  History: { carbon: Carbon.History, huge: HistoryIcon },
  Image: { carbon: Carbon.Image, huge: Image01Icon },
  ImageIcon: { carbon: Carbon.Image, huge: Image01Icon },
  ImagePlus: { carbon: Carbon.DropPhoto, huge: ImagePlusIcon },
  Info: { carbon: Carbon.InformationSquare, huge: InfoIcon },
  InstallingUpdates: { carbon: Carbon.Upgrade, huge: InstallingUpdates01Icon },
  Keyboard: { carbon: Carbon.Keyboard, huge: KeyboardIcon },
  KeyRound: { carbon: Carbon.ApiKey, huge: KeyRoundIcon },
  Layers: { carbon: Carbon.Layers, huge: Layers01Icon },
  Lightbulb: { carbon: Carbon.Idea, huge: LightbulbIcon },
  Link2: { carbon: Carbon.Link, huge: Link02Icon },
  ListChecks: { carbon: Carbon.ListChecked, huge: ListChecksIcon },
  ListTodo: { carbon: Carbon.Task, huge: ListTodoIcon },
  Loader2: { carbon: Carbon.CircleDash, huge: LoaderCircleIcon },
  LoaderCircle: { carbon: Carbon.CircleDash, huge: LoaderCircleIcon },
  LogOut: { carbon: Carbon.Logout, huge: LogOutIcon },
  Maximize2: { carbon: Carbon.Maximize, huge: ArrowExpand01Icon },
  MessageCirclePlus: { carbon: Carbon.AddComment, huge: MessageCirclePlusIcon },
  MessageSquare: { carbon: Carbon.Chat, huge: MessageSquareIcon },
  MessageSquareDashed: { carbon: Carbon.ChatOff, huge: MessageSquareDashedIcon },
  MessageSquarePlus: { carbon: Carbon.AddComment, huge: MessageSquarePlusIcon },
  MessageSquareText: { carbon: Carbon.Comments, huge: MessageSquareTextIcon },
  Minimize2: { carbon: Carbon.Minimize, huge: ArrowShrink01Icon },
  Minus: { carbon: Carbon.Subtract, huge: MinusSignIcon },
  Monitor: { carbon: Carbon.Screen, huge: MonitorIcon },
  Moon: { carbon: Carbon.Moon, huge: Moon02Icon },
  MoreHorizontal: { carbon: Carbon.OverflowMenuHorizontal, huge: MoreHorizontalIcon },
  MousePointer2: { carbon: Carbon.Cursor_1, huge: MousePointer01Icon },
  MousePointerClick: { carbon: Carbon.Cursor_2, huge: MousePointerClickIcon },
  MusicNote: { carbon: Carbon.Music, huge: MusicNote01Icon },
  Palette: { carbon: Carbon.ColorPalette, huge: PaletteIcon },
  Printer: { carbon: Carbon.Printer, huge: PrinterIcon },
  PanelLeft: { carbon: Carbon.OpenPanelLeft, huge: PanelLeftIcon },
  PanelRight: { carbon: Carbon.OpenPanelRight, huge: PanelRightIcon },
  Paperclip: { carbon: Carbon.Attachment, huge: PaperclipIcon },
  Pencil: { carbon: Carbon.Pen, huge: PencilIcon },
  PencilLine: { carbon: Carbon.PenFountain, huge: PencilLineIcon },
  Pin: { carbon: Carbon.Pin, huge: PinIcon },
  PinOff: { carbon: Carbon.PinFilled, huge: PinOffIcon },
  Plug: { carbon: Carbon.Plug, huge: PlugIcon },
  PlugZap: { carbon: Carbon.PlugFilled, huge: PlugZapIcon },
  Plus: { carbon: Carbon.Add, huge: PlusIcon },
  Puzzle: { carbon: Carbon.Extensions, huge: PuzzleIcon },
  RefreshCw: { carbon: Carbon.Renew, huge: RefreshCwIcon },
  Rewind: { carbon: Carbon.SkipBackOutline, huge: RewindIcon },
  RotateCcw: { carbon: Carbon.Reset, huge: RotateCcwIcon },
  ScanSearch: { carbon: Carbon.Scan, huge: ScanSearchIcon },
  ScanText: { carbon: Carbon.ScanAlt, huge: ScanTextIcon },
  ScrollText: { carbon: Carbon.DocumentBlank, huge: ScrollTextIcon },
  Search: { carbon: Carbon.Search, huge: Search01Icon },
  SearchX: { carbon: Carbon.Search, huge: SearchXIcon },
  Send: { carbon: Carbon.Send, huge: SendIcon },
  Settings: { carbon: Carbon.Settings, huge: Settings01Icon },
  Smartphone: { carbon: Carbon.Mobile, huge: SmartPhone01Icon },
  Settings2: { carbon: Carbon.SettingsAdjust, huge: Settings02Icon },
  Shapes: { carbon: Carbon.Shapes, huge: GeometricShapes01Icon },
  ShieldCheck: { carbon: Carbon.Security, huge: ShieldCheckIcon },
  Sparkles: { carbon: Carbon.MagicWand, huge: SparklesIcon },
  SourceCode: { carbon: Carbon.Code, huge: SourceCodeIcon },
  // A stop mark is a SOLID block: Carbon's outlined `Stop` is a ring drawn as
  // fill artwork, which renders as a hollow square however it is filled, so the
  // square style takes `SquareSolid` (Carbon's own 2px grid corner rounding
  // included). The HugeIcons side is stroke artwork; the call site's
  // `fill-current` fills it there, so both packs show the same solid square.
  Square: { carbon: Carbon.SquareSolid, huge: SquareIcon },
  SquareArrowOutUpRight: { carbon: Carbon.Launch, huge: SquareArrowOutUpRightIcon },
  SquareTerminal: { carbon: Carbon.Terminal_3270, huge: SquareTerminalIcon },
  Stethoscope: { carbon: Carbon.Stethoscope, huge: StethoscopeIcon },
  Subtitle: { carbon: Carbon.ClosedCaption, huge: SubtitleIcon },
  Sun: { carbon: Carbon.Sun, huge: Sun01Icon },
  Terminal: { carbon: Carbon.Terminal, huge: TerminalIcon },
  TextFont: { carbon: Carbon.TextFont, huge: TextFontIcon },
  TextSearch: { carbon: Carbon.TextMining, huge: TextSearchIcon },
  Type: { carbon: Carbon.LetterTt, huge: TypeIcon },
  WrapText: { carbon: Carbon.TextWrap, huge: TextWrapIcon },
  ThumbsDown: { carbon: Carbon.ThumbsDown, huge: ThumbsDownIcon },
  ThumbsUp: { carbon: Carbon.ThumbsUp, huge: ThumbsUpIcon },
  Timer: { carbon: Carbon.Timer, huge: Timer01Icon },
  Trash2: { carbon: Carbon.TrashCan, huge: Delete02Icon },
  Undo2: { carbon: Carbon.Undo, huge: Undo02Icon },
  Upload: { carbon: Carbon.Upload, huge: Upload01Icon },
  User: { carbon: Carbon.User, huge: UserIcon },
  WandSparkles: { carbon: Carbon.MagicWandFilled, huge: WandSparklesIcon },
  Wrench: { carbon: Carbon.Tools, huge: Wrench01Icon },
  X: { carbon: Carbon.Close, huge: XIcon },
  XCircle: { carbon: Carbon.Misuse, huge: CancelCircleIcon },
  XSquare: { carbon: Carbon.Close, huge: CancelSquareIcon },
  Zap: { carbon: Carbon.Flash, huge: ZapIcon },
  ZoomIn: { carbon: Carbon.ZoomIn, huge: ZoomInIcon },
  ZoomOut: { carbon: Carbon.ZoomOut, huge: ZoomOutIcon },
  MoreVertical: { carbon: Carbon.OverflowMenuVertical, huge: MoreVerticalIcon },
} satisfies Record<string, { carbon: Carbon.CarbonIconType; huge: HugeGlyph }>

const HUGE_STROKE = 1.5

/** Strip the attributes the wrapper owns (React's key, and the stroke weight
 * the caller may override) and render one HugeIcons tuple. */
function hugeChild([tag, attrs]: readonly [string, Record<string, string | number>], index: number) {
  const { key: _key, strokeWidth: _own, ...rest } = attrs
  return createElement(tag, { key: index, ...rest })
}

function createIcon(name: keyof typeof GLYPHS): IconComponent {
  const pair = GLYPHS[name]
  // Preserve the call-site accessibility default: an unlabelled glyph is
  // decorative, a labelled one is exposed to assistive tech.
  const Component = forwardRef<SVGSVGElement, IconProps>((props, ref) => {
    const pack = useIconPack()
    const { strokeWidth, size, className, ...rest } = props
    const ariaHidden = rest['aria-label'] || rest['aria-labelledby'] ? undefined : true
    if (pack === 'hugeicons') {
      // Stroke artwork: the requested weight (default 1.5) sits on the root so
      // every child inherits it; `absoluteStrokeWidth` has no relative scaling
      // to opt into, so it is simply "use the stroke as given".
      return createElement(
        'svg',
        {
          ref,
          'data-app-icon': name,
          'aria-hidden': ariaHidden,
          focusable: 'false',
          width: size ?? 24,
          height: size ?? 24,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: strokeWidth ?? HUGE_STROKE,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          className,
          ...rest
        },
        (pair.huge as HugeGlyph).map(hugeChild)
      )
    }
    // Fill artwork: stroke-only props are accepted for call-site compat and
    // dropped, because there is no stroke geometry to scale. Carbon's own
    // `Icon` wrapper already sets fill="currentColor" and focusable="false",
    // keeps `aria-hidden` (unless the call site labelled the glyph, which turns
    // it into an image with a role), forwards the ref and passes unknown props
    // through, so the artwork's view box is the only difference from the
    // hugeicons branch above.
    //
    // `size` is deliberately NOT forwarded: 84 of Carbon's components pick
    // their artwork by it and default to 16, and the app styles 454 icon call
    // sites with Tailwind size classes against a dozen that pass a number, so
    // Carbon's 16px-drawn artwork is the right artwork for this interface. The
    // box is ours (width/height), the drawing is Carbon's default.
    const Glyph = pair.carbon as CarbonGlyph
    return createElement(Glyph, {
      ref,
      'data-app-icon': name,
      'aria-hidden': ariaHidden,
      focusable: 'false',
      width: size ?? 24,
      height: size ?? 24,
      className,
      ...rest
    })
  })
  Component.displayName = name
  return Component as IconComponent
}

// Keep semantic component names at call sites; map their artwork only here.
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
export const Ban = /* @__PURE__ */ createIcon('Ban')
export const Bell = /* @__PURE__ */ createIcon('Bell')
export const BookDownload = /* @__PURE__ */ createIcon('BookDownload')
export const BookOpenText = /* @__PURE__ */ createIcon('BookOpenText')
export const Bookmark = /* @__PURE__ */ createIcon('Bookmark')
export const BookSearch = /* @__PURE__ */ createIcon('BookSearch')
export const Bot = /* @__PURE__ */ createIcon('Bot')
export const Braces = /* @__PURE__ */ createIcon('Braces')
export const Brain = /* @__PURE__ */ createIcon('Brain')
export const Camera = /* @__PURE__ */ createIcon('Camera')
export const Chart = /* @__PURE__ */ createIcon('Chart')
export const Chat01 = /* @__PURE__ */ createIcon('Chat01')
export const Check = /* @__PURE__ */ createIcon('Check')
export const CheckCircle2 = /* @__PURE__ */ createIcon('CheckCircle2')
export const ChevronDown = /* @__PURE__ */ createIcon('ChevronDown')
export const ChevronLeft = /* @__PURE__ */ createIcon('ChevronLeft')
export const ChevronRight = /* @__PURE__ */ createIcon('ChevronRight')
export const ChevronUp = /* @__PURE__ */ createIcon('ChevronUp')
export const ChevronsDownUp = /* @__PURE__ */ createIcon('ChevronsDownUp')
export const ChevronsUpDown = /* @__PURE__ */ createIcon('ChevronsUpDown')
export const Circle = /* @__PURE__ */ createIcon('Circle')
export const CircleAlert = /* @__PURE__ */ createIcon('CircleAlert')
export const CircleCheck = /* @__PURE__ */ createIcon('CircleCheck')
export const CircleHelp = /* @__PURE__ */ createIcon('CircleHelp')
export const CircleX = /* @__PURE__ */ createIcon('CircleX')
export const Clock = /* @__PURE__ */ createIcon('Clock')
export const Clock3 = /* @__PURE__ */ createIcon('Clock3')
export const CloudDownload = /* @__PURE__ */ createIcon('CloudDownload')
export const CommandLine = /* @__PURE__ */ createIcon('CommandLine')
export const Compass = /* @__PURE__ */ createIcon('Compass')
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
export const Folder = /* @__PURE__ */ createIcon('Folder')
export const FolderInput = /* @__PURE__ */ createIcon('FolderInput')
export const FolderKanban = /* @__PURE__ */ createIcon('FolderKanban')
export const FolderOpen = /* @__PURE__ */ createIcon('FolderOpen')
export const FolderPlus = /* @__PURE__ */ createIcon('FolderPlus')
export const FolderTree = /* @__PURE__ */ createIcon('FolderTree')
export const GitFork = /* @__PURE__ */ createIcon('GitFork')
export const GitPullRequest = /* @__PURE__ */ createIcon('GitPullRequest')
export const Globe = /* @__PURE__ */ createIcon('Globe')
export const Globe2 = /* @__PURE__ */ createIcon('Globe2')
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
// Both packs now carry a real vertical ellipsis (Carbon's OverflowMenuVertical,
// HugeIcons' MoreVertical), so this is an ordinary row: the square style no
// longer rotates the horizontal glyph a quarter turn to get one.
export const MoreVertical = /* @__PURE__ */ createIcon('MoreVertical')
export const MousePointer2 = /* @__PURE__ */ createIcon('MousePointer2')
export const MousePointerClick = /* @__PURE__ */ createIcon('MousePointerClick')
export const MusicNote = /* @__PURE__ */ createIcon('MusicNote')
export const Palette = /* @__PURE__ */ createIcon('Palette')
export const Printer = /* @__PURE__ */ createIcon('Printer')
export const PanelLeft = /* @__PURE__ */ createIcon('PanelLeft')
export const PanelRight = /* @__PURE__ */ createIcon('PanelRight')
export const Paperclip = /* @__PURE__ */ createIcon('Paperclip')
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
export const Send = /* @__PURE__ */ createIcon('Send')
export const Settings = /* @__PURE__ */ createIcon('Settings')
export const Smartphone = /* @__PURE__ */ createIcon('Smartphone')
export const Settings2 = /* @__PURE__ */ createIcon('Settings2')
export const Shapes = /* @__PURE__ */ createIcon('Shapes')
export const ShieldCheck = /* @__PURE__ */ createIcon('ShieldCheck')
export const Sparkles = /* @__PURE__ */ createIcon('Sparkles')
export const SourceCode = /* @__PURE__ */ createIcon('SourceCode')
export const Square = /* @__PURE__ */ createIcon('Square')
export const SquareArrowOutUpRight = /* @__PURE__ */ createIcon('SquareArrowOutUpRight')
export const SquareTerminal = /* @__PURE__ */ createIcon('SquareTerminal')
export const Stethoscope = /* @__PURE__ */ createIcon('Stethoscope')
export const Subtitle = /* @__PURE__ */ createIcon('Subtitle')
export const Sun = /* @__PURE__ */ createIcon('Sun')
export const Terminal = /* @__PURE__ */ createIcon('Terminal')
export const TextFont = /* @__PURE__ */ createIcon('TextFont')
export const TextSearch = /* @__PURE__ */ createIcon('TextSearch')
// The "T" glyph: a text modality marker (distinct from TextFont's size mark).
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
