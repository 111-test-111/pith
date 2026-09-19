import {
  createElement,
  forwardRef,
  type ForwardRefExoticComponent,
  type ReactElement,
  type RefAttributes,
  type SVGProps
} from 'react'
import {
  RiAddLine,
  RiAlertLine,
  RiAnticlockwise2Line,
  RiArrowDownLine,
  RiArrowDownSLine,
  RiArrowUpDownLine,
  RiArrowGoBackLine,
  RiArrowLeftLine,
  RiArrowLeftSLine,
  RiArrowRightLine,
  RiArrowRightSLine,
  RiArrowRightUpLine,
  RiArrowUpLine,
  RiArrowUpSLine,
  RiAttachmentLine,
  RiBarChart2Line,
  RiBookOpenLine,
  RiBookmarkLine,
  RiBookReadLine,
  RiBracesLine,
  RiBrainLine,
  RiCameraLine,
  RiChat4Line,
  RiCheckboxBlankCircleLine,
  RiCheckboxCircleLine,
  RiCheckLine,
  RiClosedCaptioningLine,
  RiCloseCircleLine,
  RiCloseLargeLine,
  RiCloseLine,
  RiCodeSSlashLine,
  RiCompass3Line,
  RiComputerLine,
  RiContractUpDownLine,
  RiCursorFill,
  RiCursorLine,
  RiDashboardLine,
  RiDatabase2Line,
  RiDeleteBin6Line,
  RiDownload2Line,
  RiDownloadCloud2Line,
  RiDownloadLine,
  RiEdit2Line,
  RiEditLine,
  RiErrorWarningLine,
  RiExpandUpDownLine,
  RiExternalLinkLine,
  RiEyeLine,
  RiEyeOffLine,
  RiFileAddLine,
  RiFileCodeLine,
  RiFileCopyLine,
  RiFileDownloadLine,
  RiFileEditLine,
  RiFilePaperLine,
  RiFileSearchLine,
  RiFileTextLine,
  RiFileTransferLine,
  RiFlashlightLine,
  RiFolderAddLine,
  RiFolderLine,
  RiFolderOpenLine,
  RiFolderReceivedLine,
  RiFontSize2,
  RiFullscreenExitLine,
  RiFullscreenLine,
  RiGitBranchLine,
  RiGitPullRequestLine,
  RiGlobalLine,
  RiGraduationCapLine,
  RiHistoryLine,
  RiImage2Line,
  RiImageAddLine,
  RiImageLine,
  RiInformationLine,
  RiKeyLine,
  RiKeyboardLine,
  RiLayoutGridLine,
  RiLayoutLeftLine,
  RiLayoutRightLine,
  RiLightbulbLine,
  RiLinksLine,
  RiListCheck2,
  RiLoader2Line,
  RiLoader4Line,
  RiLogoutBoxRLine,
  RiMagicLine,
  RiMoonLine,
  RiMoreLine,
  RiMusic2Line,
  RiNotification3Line,
  RiPaletteLine,
  RiPlug2Line,
  RiPrinterLine,
  RiPlugLine,
  RiProhibitedLine,
  RiPushpinLine,
  RiPuzzleLine,
  RiQuestionLine,
  RiRecordCircleLine,
  RiRefreshLine,
  RiRewindLine,
  RiRobot2Line,
  RiScan2Line,
  RiScanLine,
  RiSearch2Line,
  RiSearchLine,
  RiSendPlane2Line,
  RiSettings4Line,
  RiSettingsLine,
  RiShapesLine,
  RiShieldCheckLine,
  RiSkipForwardLine,
  RiSmartphoneLine,
  RiSortAsc,
  RiSortDesc,
  RiSparkling2Line,
  RiStethoscopeLine,
  RiStopLargeLine,
  RiSubtractLine,
  RiStackLine,
  RiSunLine,
  RiTerminalBoxLine,
  RiTerminalLine,
  RiTerminalWindowLine,
  RiTimerLine,
  RiText,
  RiTextWrap,
  RiThumbDownLine,
  RiThumbUpLine,
  RiTimeLine,
  RiTodoLine,
  RiTreeLine,
  RiUnpinLine,
  RiUploadLine,
  RiUserLine,
  RiWrenchLine,
  RiZoomInLine,
  RiZoomOutLine,
  type RemixiconComponentType,
} from '@remixicon/react'
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
 * App and beUI glyphs share this entry point, and it is a two-pack table:
 * Remix Icon's line family (24×24, fill artwork) for the square interface
 * style and HugeIcons' stroke-rounded family for the squircle style. Call
 * sites keep their semantic names and never choose a pack — `iconPackOf(uiStyle)`
 * feeds `lib/icon-pack.tsx`'s context and this file renders whichever glyph
 * the context names. Several names predate the current packs' spelling of the
 * same shape, and a handful only ever had a nearest-neighbour, so their
 * nearest-neighbour choices are recorded here rather than at a call site:
 *
 *   BookDownload → file-download, Diff → file-transfer, Monitor → computer,
 *   ListTodo → todo, MoreVertical → the horizontal ellipsis rotated a quarter
 *   turn (Remix only; HugeIcons has its own ⋮), Chart → a column chart,
 *   BookSearch → a book with a magnifier, InstallingUpdates → the pack's own
 *   update mark, Type → a bare "T" (a modality marker, distinct from
 *   TextFont's size mark), XSquare → a square cancel, Rewind → the pack's own
 *   rewind mark.
 *
 * Two packs share one prop surface: `strokeWidth` and `absoluteStrokeWidth`
 * are accepted everywhere, dropped by Remix (fill artwork has no stroke to
 * scale) and applied by HugeIcons (stroke artwork, default 1.5).
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

/** The Remix components are typed as ComponentClass though they render as
 * plain function components; loose type for the one render-time cast below. */
type RemixGlyph = (props: Record<string, unknown>) => ReactElement

/** The pack table: exactly one glyph per pack per semantic name. Adding a name
 * means adding a row here and an export below — nothing else. */
const GLYPHS = {
  AlertCircle: { remix: RiAlertLine, huge: AlertCircleIcon },
  AlertTriangle: { remix: RiErrorWarningLine, huge: Alert01Icon },
  ArrowDown: { remix: RiArrowDownLine, huge: ArrowDown02Icon },
  ArrowDownUp: { remix: RiArrowUpDownLine, huge: ArrowUpDownIcon },
  ArrowDownWideNarrow: { remix: RiSortDesc, huge: ArrowDownWideNarrowIcon },
  ArrowLeft: { remix: RiArrowLeftLine, huge: ArrowLeft02Icon },
  ArrowRight: { remix: RiArrowRightLine, huge: ArrowRight02Icon },
  ArrowUp: { remix: RiArrowUpLine, huge: ArrowUp02Icon },
  ArrowUpNarrowWide: { remix: RiSortAsc, huge: ArrowUpNarrowWideIcon },
  ArrowUpRight: { remix: RiArrowRightUpLine, huge: ArrowUpRight01Icon },
  Ban: { remix: RiProhibitedLine, huge: BanIcon },
  Bell: { remix: RiNotification3Line, huge: Notification01Icon },
  BookDownload: { remix: RiFileDownloadLine, huge: BookDownloadIcon },
  BookOpenText: { remix: RiBookOpenLine, huge: BookOpenTextIcon },
  Bookmark: { remix: RiBookmarkLine, huge: Bookmark01Icon },
  BookSearch: { remix: RiBookReadLine, huge: BookSearchIcon },
  Bot: { remix: RiRobot2Line, huge: BotIcon },
  Braces: { remix: RiBracesLine, huge: BracesIcon },
  Brain: { remix: RiBrainLine, huge: BrainIcon },
  Camera: { remix: RiCameraLine, huge: Camera01Icon },
  Chart: { remix: RiBarChart2Line, huge: Chart01Icon },
  Chat01: { remix: RiChat4Line, huge: Chat01Icon },
  Check: { remix: RiCheckLine, huge: CheckIcon },
  CheckCircle2: { remix: RiCheckboxCircleLine, huge: CheckmarkCircle02Icon },
  ChevronDown: { remix: RiArrowDownSLine, huge: ChevronDownIcon },
  ChevronLeft: { remix: RiArrowLeftSLine, huge: ChevronLeftIcon },
  ChevronRight: { remix: RiArrowRightSLine, huge: ChevronRightIcon },
  ChevronUp: { remix: RiArrowUpSLine, huge: ChevronUpIcon },
  ChevronsDownUp: { remix: RiContractUpDownLine, huge: ChevronsDownUpIcon },
  ChevronsUpDown: { remix: RiExpandUpDownLine, huge: UnfoldMoreIcon },
  Circle: { remix: RiRecordCircleLine, huge: CircleIcon },
  CircleAlert: { remix: RiAlertLine, huge: AlertCircleIcon },
  CircleCheck: { remix: RiCheckboxCircleLine, huge: CheckmarkCircle02Icon },
  CircleHelp: { remix: RiQuestionLine, huge: HelpCircleIcon },
  CircleX: { remix: RiCloseCircleLine, huge: CircleXIcon },
  Clock: { remix: RiTimeLine, huge: Clock01Icon },
  Clock3: { remix: RiTimeLine, huge: Clock03Icon },
  CloudDownload: { remix: RiDownloadCloud2Line, huge: CloudDownloadIcon },
  CommandLine: { remix: RiTerminalBoxLine, huge: CommandLineIcon },
  Compass: { remix: RiCompass3Line, huge: CompassIcon },
  Copy: { remix: RiFileCopyLine, huge: CopyIcon },
  Dashboard: { remix: RiDashboardLine, huge: DashboardSquare01Icon },
  Database: { remix: RiDatabase2Line, huge: Database02Icon },
  Diff: { remix: RiFileTransferLine, huge: DiffIcon },
  Download: { remix: RiDownloadLine, huge: Download01Icon },
  ExternalLink: { remix: RiExternalLinkLine, huge: ExternalLinkIcon },
  Eye: { remix: RiEyeLine, huge: EyeIcon },
  EyeOff: { remix: RiEyeOffLine, huge: EyeOffIcon },
  FastForward: { remix: RiSkipForwardLine, huge: FastForwardIcon },
  FileCode2: { remix: RiFileCodeLine, huge: FileCodeIcon },
  FileDiff: { remix: RiFileTransferLine, huge: FileDiffIcon },
  FilePen: { remix: RiFileEditLine, huge: FilePenIcon },
  FilePlus2: { remix: RiFileAddLine, huge: FileAddIcon },
  FileSearch: { remix: RiFileSearchLine, huge: FileSearchIcon },
  FileSearch2: { remix: RiFileSearchLine, huge: FileSearchCornerIcon },
  FileText: { remix: RiFileTextLine, huge: FileTextIcon },
  Folder: { remix: RiFolderLine, huge: Folder01Icon },
  FolderInput: { remix: RiFolderReceivedLine, huge: FolderInputIcon },
  FolderKanban: { remix: RiLayoutGridLine, huge: FolderKanbanIcon },
  FolderOpen: { remix: RiFolderOpenLine, huge: FolderOpenIcon },
  FolderPlus: { remix: RiFolderAddLine, huge: FolderAddIcon },
  FolderTree: { remix: RiTreeLine, huge: FolderTreeIcon },
  GitFork: { remix: RiGitBranchLine, huge: GitForkIcon },
  GitPullRequest: { remix: RiGitPullRequestLine, huge: GitPullRequestIcon },
  Globe: { remix: RiGlobalLine, huge: Globe02Icon },
  Globe2: { remix: RiGlobalLine, huge: GlobalIcon },
  GraduationCap: { remix: RiGraduationCapLine, huge: GraduationCapIcon },
  History: { remix: RiHistoryLine, huge: HistoryIcon },
  Image: { remix: RiImageLine, huge: Image01Icon },
  ImageIcon: { remix: RiImage2Line, huge: Image01Icon },
  ImagePlus: { remix: RiImageAddLine, huge: ImagePlusIcon },
  Info: { remix: RiInformationLine, huge: InfoIcon },
  InstallingUpdates: { remix: RiDownload2Line, huge: InstallingUpdates01Icon },
  Keyboard: { remix: RiKeyboardLine, huge: KeyboardIcon },
  KeyRound: { remix: RiKeyLine, huge: KeyRoundIcon },
  Layers: { remix: RiStackLine, huge: Layers01Icon },
  Lightbulb: { remix: RiLightbulbLine, huge: LightbulbIcon },
  Link2: { remix: RiLinksLine, huge: Link02Icon },
  ListChecks: { remix: RiListCheck2, huge: ListChecksIcon },
  ListTodo: { remix: RiTodoLine, huge: ListTodoIcon },
  Loader2: { remix: RiLoader2Line, huge: LoaderCircleIcon },
  LoaderCircle: { remix: RiLoader4Line, huge: LoaderCircleIcon },
  LogOut: { remix: RiLogoutBoxRLine, huge: LogOutIcon },
  Maximize2: { remix: RiFullscreenLine, huge: ArrowExpand01Icon },
  MessageCirclePlus: { remix: RiChat4Line, huge: MessageCirclePlusIcon },
  MessageSquare: { remix: RiChat4Line, huge: MessageSquareIcon },
  MessageSquareDashed: { remix: RiChat4Line, huge: MessageSquareDashedIcon },
  MessageSquarePlus: { remix: RiChat4Line, huge: MessageSquarePlusIcon },
  MessageSquareText: { remix: RiChat4Line, huge: MessageSquareTextIcon },
  Minimize2: { remix: RiFullscreenExitLine, huge: ArrowShrink01Icon },
  Minus: { remix: RiSubtractLine, huge: MinusSignIcon },
  Monitor: { remix: RiComputerLine, huge: MonitorIcon },
  Moon: { remix: RiMoonLine, huge: Moon02Icon },
  MoreHorizontal: { remix: RiMoreLine, huge: MoreHorizontalIcon },
  MousePointer2: { remix: RiCursorLine, huge: MousePointer01Icon },
  MousePointerClick: { remix: RiCursorFill, huge: MousePointerClickIcon },
  MusicNote: { remix: RiMusic2Line, huge: MusicNote01Icon },
  Palette: { remix: RiPaletteLine, huge: PaletteIcon },
  Printer: { remix: RiPrinterLine, huge: PrinterIcon },
  PanelLeft: { remix: RiLayoutLeftLine, huge: PanelLeftIcon },
  PanelRight: { remix: RiLayoutRightLine, huge: PanelRightIcon },
  Paperclip: { remix: RiAttachmentLine, huge: PaperclipIcon },
  Pencil: { remix: RiEditLine, huge: PencilIcon },
  PencilLine: { remix: RiEdit2Line, huge: PencilLineIcon },
  Pin: { remix: RiPushpinLine, huge: PinIcon },
  PinOff: { remix: RiUnpinLine, huge: PinOffIcon },
  Plug: { remix: RiPlugLine, huge: PlugIcon },
  PlugZap: { remix: RiPlug2Line, huge: PlugZapIcon },
  Plus: { remix: RiAddLine, huge: PlusIcon },
  Puzzle: { remix: RiPuzzleLine, huge: PuzzleIcon },
  RefreshCw: { remix: RiRefreshLine, huge: RefreshCwIcon },
  Rewind: { remix: RiRewindLine, huge: RewindIcon },
  RotateCcw: { remix: RiAnticlockwise2Line, huge: RotateCcwIcon },
  ScanSearch: { remix: RiScan2Line, huge: ScanSearchIcon },
  ScanText: { remix: RiScanLine, huge: ScanTextIcon },
  ScrollText: { remix: RiFilePaperLine, huge: ScrollTextIcon },
  Search: { remix: RiSearchLine, huge: Search01Icon },
  SearchX: { remix: RiCloseCircleLine, huge: SearchXIcon },
  Send: { remix: RiSendPlane2Line, huge: SendIcon },
  Settings: { remix: RiSettingsLine, huge: Settings01Icon },
  Smartphone: { remix: RiSmartphoneLine, huge: SmartPhone01Icon },
  Settings2: { remix: RiSettings4Line, huge: Settings02Icon },
  Shapes: { remix: RiShapesLine, huge: GeometricShapes01Icon },
  ShieldCheck: { remix: RiShieldCheckLine, huge: ShieldCheckIcon },
  Sparkles: { remix: RiSparkling2Line, huge: SparklesIcon },
  SourceCode: { remix: RiCodeSSlashLine, huge: SourceCodeIcon },
  Square: { remix: RiStopLargeLine, huge: SquareIcon },
  SquareArrowOutUpRight: { remix: RiExternalLinkLine, huge: SquareArrowOutUpRightIcon },
  SquareTerminal: { remix: RiTerminalWindowLine, huge: SquareTerminalIcon },
  Stethoscope: { remix: RiStethoscopeLine, huge: StethoscopeIcon },
  Subtitle: { remix: RiClosedCaptioningLine, huge: SubtitleIcon },
  Sun: { remix: RiSunLine, huge: Sun01Icon },
  Terminal: { remix: RiTerminalLine, huge: TerminalIcon },
  TextFont: { remix: RiFontSize2, huge: TextFontIcon },
  TextSearch: { remix: RiSearch2Line, huge: TextSearchIcon },
  Type: { remix: RiText, huge: TypeIcon },
  WrapText: { remix: RiTextWrap, huge: TextWrapIcon },
  ThumbsDown: { remix: RiThumbDownLine, huge: ThumbsDownIcon },
  ThumbsUp: { remix: RiThumbUpLine, huge: ThumbsUpIcon },
  Timer: { remix: RiTimerLine, huge: Timer01Icon },
  Trash2: { remix: RiDeleteBin6Line, huge: Delete02Icon },
  Undo2: { remix: RiArrowGoBackLine, huge: Undo02Icon },
  Upload: { remix: RiUploadLine, huge: Upload01Icon },
  User: { remix: RiUserLine, huge: UserIcon },
  WandSparkles: { remix: RiMagicLine, huge: WandSparklesIcon },
  Wrench: { remix: RiWrenchLine, huge: Wrench01Icon },
  X: { remix: RiCloseLine, huge: XIcon },
  XCircle: { remix: RiCloseCircleLine, huge: CancelCircleIcon },
  XSquare: { remix: RiCloseLargeLine, huge: CancelSquareIcon },
  Zap: { remix: RiFlashlightLine, huge: ZapIcon },
  ZoomIn: { remix: RiZoomInLine, huge: ZoomInIcon },
  ZoomOut: { remix: RiZoomOutLine, huge: ZoomOutIcon },
  MoreVertical: { remix: RiMoreLine, huge: MoreVerticalIcon },
} satisfies Record<string, { remix: unknown; huge: HugeGlyph }>

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
    // dropped, because there is no stroke geometry to scale.
    const Glyph = pair.remix as RemixGlyph
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
// Remix packs no vertical ellipsis: the ⋮ is the horizontal glyph rotated a
// quarter turn, which only the Remix artwork needs — HugeIcons has its own
// vertical glyph. Both keep the same wrapper contract (a11y default, compat
// props dropped) plus the one transform.
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
