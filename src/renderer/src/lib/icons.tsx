import { forwardRef, type ForwardRefExoticComponent, type RefAttributes } from 'react'
import { HugeiconsIcon, type HugeiconsIconProps, type IconSvgElement } from '@hugeicons/react'
import {
  AiContentGenerator02Icon,
  AiEditingIcon,
  Alert01Icon,
  AlertCircleIcon,
  Analytics02Icon,
  AnonymousIcon,
  ArchiveArrowUpIcon,
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
  BadgeCheckIcon,
  BanIcon,
  BellIcon,
  BookDownloadIcon,
  BookOpenCheckIcon,
  BookOpenIcon,
  BookOpenTextIcon,
  BookSearchIcon,
  Bookmark01Icon,
  BoxesIcon,
  BracesIcon,
  Brain03Icon,
  BugIcon,
  CameraIcon,
  Cancel01Icon,
  CancelCircleIcon,
  CancelSquareIcon,
  ChatAdd01Icon,
  ChatBlockedIcon,
  ChatIcon,
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
  Clock02Icon,
  Clock03Icon,
  CloudDownloadIcon,
  CodesandboxIcon,
  Columns3CogIcon,
  CommandLineIcon,
  CompassIcon,
  ConnectIcon,
  CoPresentIcon,
  Copy01Icon,
  DatabaseIcon,
  Delete02Icon,
  DiffIcon,
  Download01Icon,
  Edit02Icon,
  ElearningExchangeIcon,
  EnergyEllipseIcon,
  ExternalLinkIcon,
  EyeIcon,
  EyeOffIcon,
  FileAddIcon,
  FileCodeIcon,
  FileDiffIcon,
  FilePenIcon,
  FileSearchCornerIcon,
  FileSearchIcon,
  FileSecurityIcon,
  FileTextIcon,
  FirstAidKitIcon,
  FlaskConicalIcon,
  FlowSquareIcon,
  FocusIcon,
  FoldHorizontalIcon,
  Folder01Icon,
  Folder03Icon,
  FolderInputIcon,
  FolderKanbanIcon,
  FolderPlusIcon,
  FolderSearchIcon,
  FolderTreeIcon,
  FunctionSquareIcon,
  GavelIcon,
  GeometricShapes01Icon,
  GitForkIcon,
  GitMergeIcon,
  GitPullRequestIcon,
  GlobalIcon,
  HelpCircleIcon,
  HashIcon,
  Hospital02Icon,
  Image03Icon,
  InboxIcon,
  InfoIcon,
  InstallingUpdatesIcon,
  KeyRoundIcon,
  KeyboardIcon,
  LayersIcon,
  LayoutDashboardIcon,
  LightbulbIcon,
  Link02Icon,
  ListChecksIcon,
  ListFilterIcon,
  ListIndentIncreaseIcon,
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
  Navigator02Icon,
  NetworkIcon,
  NewspaperIcon,
  NoteAddIcon,
  PaletteIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  PanelRightCloseIcon,
  PanelRightOpenIcon,
  PaperclipIcon,
  PauseIcon,
  PenTool02Icon,
  PencilEdit02Icon,
  PencilLineIcon,
  PictureInPictureOnIcon,
  PinIcon,
  PinOffIcon,
  PlayIcon,
  PlusIcon,
  PowerIcon,
  PrinterIcon,
  PuzzleIcon,
  QuillWrite02Icon,
  RefreshCwIcon,
  ReplaceAllIcon,
  RotateCcwIcon,
  SafariIcon,
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
  SourceCodeCircleIcon,
  SourceCodeIcon,
  SparklesIcon,
  SquareArrowOutUpRightIcon,
  SquareCheckBigIcon,
  SquareDashedIcon,
  SquareIcon,
  SquareLibraryIcon,
  SquareTerminalIcon,
  StampIcon,
  StepForwardIcon,
  SubtitleIcon,
  Sun01Icon,
  TerminalIcon,
  TextFontIcon,
  TextSearchIcon,
  TextSmallcapsIcon,
  TextWrapIcon,
  ThumbsDownIcon,
  ThumbsUpIcon,
  TimerIcon,
  TimeScheduleIcon,
  Undo02Icon,
  UnfoldHorizontalIcon,
  UnfoldMoreIcon,
  UploadIcon,
  UserArrowLeftRightIcon,
  UserIcon,
  VolumeHighIcon,
  VolumeXIcon,
  WandSparklesIcon,
  Wrench01Icon,
  ZapIcon,
  ZoomInIcon,
  ZoomOutIcon
} from '@hugeicons/core-free-icons'
import {
  RiAddLine,
  RiAlertLine,
  RiAlignCenter,
  RiAnticlockwiseLine,
  RiArchive2Line,
  RiArrowDownLine,
  RiArrowDownSLine,
  RiArrowGoBackLine,
  RiArrowLeftLine,
  RiArrowLeftSLine,
  RiArrowRightLine,
  RiArrowRightSLine,
  RiArrowRightUpLine,
  RiArrowUpDownLine,
  RiArrowUpLine,
  RiArrowUpSLine,
  RiArticleLine,
  RiAttachmentLine,
  RiFilter3Line,
  RiHashtag,
  RiInboxUnarchiveLine,
  RiBarChartBoxLine,
  RiBookMarkedLine,
  RiBookReadLine,
  RiBookShelfLine,
  RiBookmark3Line,
  RiBox3Line,
  RiBracesLine,
  RiBrainLine,
  RiBug2Line,
  RiCalendarCheckLine,
  RiCameraLine,
  RiChat4Line,
  RiChatNewLine,
  RiCheckLine,
  RiCheckboxBlankCircleLine,
  RiCheckboxBlankLine,
  RiCheckboxCircleLine,
  RiCheckboxLine,
  RiCloseCircleLine,
  RiCloseLargeLine,
  RiClosedCaptioningLine,
  RiCodeBoxLine,
  RiCollapseDiagonalLine,
  RiCommandLine,
  RiCompass3Line,
  RiComputerLine,
  RiContractLeftRightLine,
  RiContractUpDownLine,
  RiCursorLine,
  RiDashboardLine,
  RiDatabase2Line,
  RiDeleteBin6Line,
  RiDeviceLine,
  RiDownload2Line,
  RiDownloadCloud2Line,
  RiDownloadLine,
  RiDraftLine,
  RiDragMove2Line,
  RiEdit2Line,
  RiEditBoxLine,
  RiEditLine,
  RiEqualizer3Line,
  RiErrorWarningLine,
  RiExpandDiagonalLine,
  RiExpandLeftRightLine,
  RiExpandUpDownLine,
  RiExternalLinkLine,
  RiEye2Line,
  RiEyeOffLine,
  RiFileAddLine,
  RiFileCodeLine,
  RiFileCopyLine,
  RiFileDownloadLine,
  RiFileEditLine,
  RiFileSearchLine,
  RiFileShield2Line,
  RiFileTextLine,
  RiFindReplaceLine,
  RiFirstAidKitLine,
  RiFlashlightLine,
  RiFlaskLine,
  RiFlowChart,
  RiFocus3Line,
  RiFolder6Line,
  RiFolderAddLine,
  RiFolderChartLine,
  RiFolderInfoLine,
  RiFolderOpenLine,
  RiFolderTransferLine,
  RiFontFamily,
  RiFontSize,
  RiFunctions,
  RiGitBranchLine,
  RiGitMergeLine,
  RiGitPullRequestLine,
  RiGlobalLine,
  RiGraduationCapLine,
  RiGroupLine,
  RiHammerLine,
  RiHistoryLine,
  RiImage2Line,
  RiImageAddLine,
  RiInbox2Line,
  RiIndentIncrease,
  RiInformationLine,
  RiKey2Line,
  RiLayoutColumnLine,
  RiLayoutRight2Line,
  RiLightbulbFlashLine,
  RiLink,
  RiListCheck3,
  RiListView,
  RiLoader3Line,
  RiLoader4Line,
  RiLogoutBoxLine,
  RiMagicLine,
  RiMoonLine,
  RiMore2Line,
  RiMoreLine,
  RiMusic2Line,
  RiNavigationLine,
  RiNotification3Line,
  RiPaletteLine,
  RiPauseLine,
  RiPenNibLine,
  RiPencilAiLine,
  RiPictureInPicture2Line,
  RiPlayLine,
  RiPlug2Line,
  RiPresentationLine,
  RiPrinterLine,
  RiProhibitedLine,
  RiPushpinLine,
  RiQuestionLine,
  RiQuillPenLine,
  RiRefreshLine,
  RiRobot2Line,
  RiRouteLine,
  RiScan2Line,
  RiScanLine,
  RiSearchLine,
  RiSendPlane2Line,
  RiSettings3Line,
  RiShapesLine,
  RiShieldCheckLine,
  RiShutDownLine,
  RiSidebarFoldLine,
  RiSidebarUnfoldLine,
  RiSkipForwardLine,
  RiSortAsc,
  RiSortDesc,
  RiSparklingLine,
  RiStackLine,
  RiStethoscopeLine,
  RiStickyNoteAddLine,
  RiStore2Line,
  RiSubtractLine,
  RiSunLine,
  RiTerminalBoxLine,
  RiTerminalLine,
  RiTextWrap,
  RiThumbDownLine,
  RiThumbUpLine,
  RiTimeLine,
  RiTimerLine,
  RiTodoLine,
  RiToolsLine,
  RiUnpinLine,
  RiUpload2Line,
  RiUploadLine,
  RiUser3Line,
  RiUserReceivedLine,
  RiVerifiedBadgeLine,
  RiVolumeMuteLine,
  RiVolumeUpLine,
  RiZoomInLine,
  RiZoomOutLine,
  type RemixiconComponentType
} from '@remixicon/react'
import { UI_ICON_SIZE, UI_ICON_STROKE } from './icon-metrics'
import { DiffArtwork } from './app-artwork'
import { KEYCAP_ARTWORK } from './keycap-artwork'
import { useUiStyle } from './ui-style'

/**
 * The single entry point for app and beUI glyphs. Square interfaces use Remix Line;
 * squircle interfaces keep Hugeicons Stroke Rounded on its native 24 grid.
 * GLYPHS pairs both drawings under stable semantic names. Remix choices favour
 * centered, nearly square silhouettes with a readable semantic match. Both
 * families keep their native 24-grid drawings at every UI size. Native paths
 * are never stretched, clipped or rounded to match the interface's corners.
 *
 * Remix Line draws filled outlines; Hugeicons preserves native 1.5 strokes and filled
 * details. Stroke overrides belong only to the stroke family. SVG refs, CSS
 * sizing, colour and accessibility pass through both official renderers.
 * File types use FileTypeIcon's separate Bearded/Pierre adapter. Keyboard-only
 * Lucide artwork and provider/Pith branding keep their own geometry in both styles.
 */
export type IconProps = Omit<HugeiconsIconProps, 'ref' | 'icon' | 'altIcon' | 'showAlt'>
export type IconComponent = ForwardRefExoticComponent<IconProps & RefAttributes<SVGSVGElement>>

/** One drawing per meaning; related semantic names can share their artwork. */
type Glyph = { rounded: IconSvgElement; square: RemixiconComponentType | null }

/** Deliberately prefer a balanced silhouette over a literal semantic match. */
const GLYPHS = {
  AlertCircle: { rounded: AlertCircleIcon, square: RiErrorWarningLine },
  AlertTriangle: { rounded: Alert01Icon, square: RiAlertLine },
  Anonymous: { rounded: AnonymousIcon, square: RiRobot2Line },
  ArrowBigRightDash: { rounded: ArrowBigRightDashIcon, square: RiArrowRightLine },
  ArrowDown: { rounded: ArrowDown02Icon, square: RiArrowDownLine },
  ArrowDownToLine: { rounded: ArrowDownToLineIcon, square: RiDownload2Line },
  ArrowDownUp: { rounded: ArrowUpDownIcon, square: RiArrowUpDownLine },
  ArrowDownWideNarrow: { rounded: ArrowDownWideNarrowIcon, square: RiSortDesc },
  ArrowLeft: { rounded: ArrowLeft02Icon, square: RiArrowLeftLine },
  ArrowLeftFromLine: { rounded: ArrowLeftFromLineIcon, square: RiLogoutBoxLine },
  ArrowRight: { rounded: ArrowRight02Icon, square: RiArrowRightLine },
  ArrowUp: { rounded: ArrowUp02Icon, square: RiArrowUpLine },
  ArrowUpFromLine: { rounded: ArrowUpFromLineIcon, square: RiUpload2Line },
  ArrowUpNarrowWide: { rounded: ArrowUpNarrowWideIcon, square: RiSortAsc },
  ArrowUpRight: { rounded: ArrowUpRight01Icon, square: RiArrowRightUpLine },
  ArrowsInLineHorizontal: { rounded: FoldHorizontalIcon, square: RiContractLeftRightLine },
  ArrowsOutLineHorizontal: { rounded: UnfoldHorizontalIcon, square: RiExpandLeftRightLine },
  Article: { rounded: NewspaperIcon, square: RiArticleLine },
  Archive: { rounded: SquareLibraryIcon, square: RiArchive2Line },
  ArchiveRestore: { rounded: ArchiveArrowUpIcon, square: RiInboxUnarchiveLine },
  Hash: { rounded: HashIcon, square: RiHashtag },
  ListFilter: { rounded: ListFilterIcon, square: RiFilter3Line },
  Backspace: { rounded: KEYCAP_ARTWORK.Backspace, square: null },
  BadgeCheck: { rounded: BadgeCheckIcon, square: RiVerifiedBadgeLine },
  Ban: { rounded: BanIcon, square: RiProhibitedLine },
  Bell: { rounded: BellIcon, square: RiNotification3Line },
  BookDownload: { rounded: BookDownloadIcon, square: RiFileDownloadLine },
  BookOpen: { rounded: BookOpenIcon, square: RiBookShelfLine },
  BookOpenCheck: { rounded: BookOpenCheckIcon, square: RiBookMarkedLine },
  BookOpenText: { rounded: BookOpenTextIcon, square: RiBookReadLine },
  Bug: { rounded: BugIcon, square: RiBug2Line },
  Bookmark: { rounded: Bookmark01Icon, square: RiBookmark3Line },
  BookSearch: { rounded: BookSearchIcon, square: RiFileSearchLine },
  Bot: { rounded: AnonymousIcon, square: RiRobot2Line },
  Boxes: { rounded: BoxesIcon, square: RiBox3Line },
  Braces: { rounded: BracesIcon, square: RiBracesLine },
  Brain: { rounded: Brain03Icon, square: RiBrainLine },
  CalendarCheck: { rounded: TimeScheduleIcon, square: RiCalendarCheckLine },
  Camera: { rounded: CameraIcon, square: RiCameraLine },
  Chart: { rounded: Analytics02Icon, square: RiBarChartBoxLine },
  Chat01: { rounded: ChatIcon, square: RiChat4Line },
  ChatAdd: { rounded: ChatAdd01Icon, square: RiChatNewLine },
  Chats: { rounded: ChatBlockedIcon, square: RiChat4Line },
  Check: { rounded: CheckIcon, square: RiCheckLine },
  CheckCircle2: { rounded: CheckmarkCircle02Icon, square: RiCheckboxCircleLine },
  CheckSquareOffset: { rounded: SquareCheckBigIcon, square: RiCheckboxLine },
  ChevronDown: { rounded: ChevronDownIcon, square: RiArrowDownSLine },
  ChevronLeft: { rounded: ChevronLeftIcon, square: RiArrowLeftSLine },
  ChevronRight: { rounded: ChevronRightIcon, square: RiArrowRightSLine },
  ChevronUp: { rounded: ChevronUpIcon, square: RiArrowUpSLine },
  ChevronsDownUp: { rounded: ChevronsDownUpIcon, square: RiContractUpDownLine },
  ChevronsUpDown: { rounded: UnfoldMoreIcon, square: RiExpandUpDownLine },
  Circle: { rounded: CircleIcon, square: RiCheckboxBlankCircleLine },
  CircleAlert: { rounded: AlertCircleIcon, square: RiErrorWarningLine },
  CircleCheck: { rounded: CheckmarkCircle02Icon, square: RiCheckboxCircleLine },
  CircleDashed: { rounded: CircleDashedIcon, square: RiLoader3Line },
  CircleHelp: { rounded: HelpCircleIcon, square: RiQuestionLine },
  CircleOff: { rounded: CircleOffIcon, square: RiProhibitedLine },
  CircleX: { rounded: CancelCircleIcon, square: RiCloseCircleLine },
  Clock: { rounded: Clock01Icon, square: RiTimeLine },
  Clock3: { rounded: Clock03Icon, square: RiTimeLine },
  CloudDownload: { rounded: CloudDownloadIcon, square: RiDownloadCloud2Line },
  Codesandbox: { rounded: CodesandboxIcon, square: RiBox3Line },
  Columns3Cog: { rounded: Columns3CogIcon, square: RiLayoutColumnLine },
  Command: { rounded: KEYCAP_ARTWORK.Command, square: null },
  CommandLine: { rounded: CommandLineIcon, square: RiTerminalBoxLine },
  Compass: { rounded: CompassIcon, square: RiCompass3Line },
  Control: { rounded: KEYCAP_ARTWORK.Control, square: null },
  CoPresent: { rounded: CoPresentIcon, square: RiPresentationLine },
  Copy: { rounded: Copy01Icon, square: RiFileCopyLine },
  Dashboard: { rounded: LayoutDashboardIcon, square: RiDashboardLine },
  Database: { rounded: DatabaseIcon, square: RiDatabase2Line },
  Diff: { rounded: DiffIcon, square: DiffArtwork },
  Download: { rounded: Download01Icon, square: RiDownloadLine },
  Edit02: { rounded: Edit02Icon, square: RiEditBoxLine },
  ExternalLink: { rounded: ExternalLinkIcon, square: RiExternalLinkLine },
  Eye: { rounded: EyeIcon, square: RiEye2Line },
  EyeOff: { rounded: EyeOffIcon, square: RiEyeOffLine },
  FileCode2: { rounded: FileCodeIcon, square: RiFileCodeLine },
  FileDiff: { rounded: FileDiffIcon, square: DiffArtwork },
  FilePen: { rounded: FilePenIcon, square: RiFileEditLine },
  FilePlus2: { rounded: FileAddIcon, square: RiFileAddLine },
  FileSearch: { rounded: FileSearchIcon, square: RiFileSearchLine },
  FileSearch2: { rounded: FileSearchCornerIcon, square: RiFileSearchLine },
  FileText: { rounded: FileTextIcon, square: RiFileTextLine },
  FirstAidKit: { rounded: FirstAidKitIcon, square: RiFirstAidKitLine },
  Flask: { rounded: FlaskConicalIcon, square: RiFlaskLine },
  FlowSquare: { rounded: FlowSquareIcon, square: RiFlowChart },
  Focus: { rounded: FocusIcon, square: RiFocus3Line },
  Folder: { rounded: Folder01Icon, square: RiFolder6Line },
  FolderInput: { rounded: FolderInputIcon, square: RiFolderTransferLine },
  FolderKanban: { rounded: FolderKanbanIcon, square: RiFolderChartLine },
  FolderOpen: { rounded: Folder03Icon, square: RiFolderOpenLine },
  FolderPlus: { rounded: FolderPlusIcon, square: RiFolderAddLine },
  FolderSearch: { rounded: FolderSearchIcon, square: RiFolderInfoLine },
  FolderTree: { rounded: FolderTreeIcon, square: RiListView },
  Gavel: { rounded: GavelIcon, square: RiHammerLine },
  Subagent: { rounded: AnonymousIcon, square: RiGroupLine },
  GitFork: { rounded: GitForkIcon, square: RiGitBranchLine },
  GitGraph: { rounded: GitMergeIcon, square: RiGitMergeLine },
  GitPullRequest: { rounded: GitPullRequestIcon, square: RiGitPullRequestLine },
  Globe: { rounded: GlobalIcon, square: RiGlobalLine },
  Globe2: { rounded: GlobalIcon, square: RiGlobalLine },
  Skills: { rounded: ElearningExchangeIcon, square: RiGraduationCapLine },
  History: { rounded: Clock02Icon, square: RiHistoryLine },
  Image: { rounded: Image03Icon, square: RiImage2Line },
  Inbox: { rounded: InboxIcon, square: RiInbox2Line },
  ImageIcon: { rounded: Image03Icon, square: RiImage2Line },
  ImagePlus: { rounded: Image03Icon, square: RiImageAddLine },
  Info: { rounded: InfoIcon, square: RiInformationLine },
  InstallingUpdates: { rounded: InstallingUpdatesIcon, square: RiDownloadCloud2Line },
  Keyboard: { rounded: KeyboardIcon, square: RiCommandLine },
  KeyArrowLeft: { rounded: KEYCAP_ARTWORK.KeyArrowLeft, square: null },
  KeyArrowRight: { rounded: KEYCAP_ARTWORK.KeyArrowRight, square: null },
  KeyArrowUp: { rounded: KEYCAP_ARTWORK.KeyArrowUp, square: null },
  KeyArrowDown: { rounded: KEYCAP_ARTWORK.KeyArrowDown, square: null },
  KeyRound: { rounded: KeyRoundIcon, square: RiKey2Line },
  Layers: { rounded: LayersIcon, square: RiStackLine },
  Lightbulb: { rounded: LightbulbIcon, square: RiLightbulbFlashLine },
  Link2: { rounded: Link02Icon, square: RiLink },
  LinkSimple: { rounded: Link02Icon, square: RiLink },
  ListChecks: { rounded: ListChecksIcon, square: RiListCheck3 },
  ListIndentIncrease: { rounded: ListIndentIncreaseIcon, square: RiIndentIncrease },
  ListTodo: { rounded: ListChecksIcon, square: RiTodoLine },
  ListTree: { rounded: ListTreeIcon, square: RiListView },
  Loader2: { rounded: LoaderCircleIcon, square: RiLoader4Line },
  LoaderCircle: { rounded: LoaderCircleIcon, square: RiLoader4Line },
  LogOut: { rounded: LogOutIcon, square: RiLogoutBoxLine },
  Maximize2: { rounded: ArrowExpand01Icon, square: RiExpandDiagonalLine },
  MessageCirclePlus: { rounded: MessageCirclePlusIcon, square: RiChatNewLine },
  MessageSquare: { rounded: MessageSquareIcon, square: RiChat4Line },
  MessageSquareDashed: { rounded: MessageSquareDashedIcon, square: RiChat4Line },
  MessageSquarePlus: { rounded: MessageSquarePlusIcon, square: RiChatNewLine },
  MessageSquareText: { rounded: MessageSquareTextIcon, square: RiChat4Line },
  Minimize2: { rounded: ArrowShrink01Icon, square: RiCollapseDiagonalLine },
  Minus: { rounded: MinusSignIcon, square: RiSubtractLine },
  Monitor: { rounded: MonitorIcon, square: RiComputerLine },
  Moon: { rounded: Moon02Icon, square: RiMoonLine },
  MoreHorizontal: { rounded: MoreHorizontalIcon, square: RiMoreLine },
  MoreVertical: { rounded: MoreVerticalIcon, square: RiMore2Line },
  MousePointer2: { rounded: MousePointer01Icon, square: RiCursorLine },
  MousePointerClick: { rounded: MousePointerClickIcon, square: RiCursorLine },
  MusicNote: { rounded: MusicNoteIcon, square: RiMusic2Line },
  Navigation: { rounded: NavigationIcon, square: RiNavigationLine },
  Network: { rounded: NetworkIcon, square: RiListView },
  Option: { rounded: KEYCAP_ARTWORK.Option, square: null },
  Palette: { rounded: PaletteIcon, square: RiPaletteLine },
  Printer: { rounded: PrinterIcon, square: RiPrinterLine },
  PanelLeftClose: { rounded: PanelLeftCloseIcon, square: RiSidebarFoldLine },
  PanelLeftOpen: { rounded: PanelLeftOpenIcon, square: RiSidebarUnfoldLine },
  PanelRightClose: { rounded: PanelRightCloseIcon, square: RiLayoutRight2Line },
  PanelRightOpen: { rounded: PanelRightOpenIcon, square: RiLayoutRight2Line },
  Paperclip: { rounded: PaperclipIcon, square: RiAttachmentLine },
  PenNib: { rounded: PenTool02Icon, square: RiPenNibLine },
  Pencil: { rounded: PencilEdit02Icon, square: RiEditLine },
  PencilLine: { rounded: PencilLineIcon, square: RiEdit2Line },
  PencilSparkles: { rounded: AiEditingIcon, square: RiPencilAiLine },
  Pause: { rounded: PauseIcon, square: RiPauseLine },
  Play: { rounded: PlayIcon, square: RiPlayLine },
  Pin: { rounded: PinIcon, square: RiPushpinLine },
  PinOff: { rounded: PinOffIcon, square: RiUnpinLine },
  PictureInPicture2: { rounded: PictureInPictureOnIcon, square: RiPictureInPicture2Line },
  Plug: { rounded: ConnectIcon, square: RiPlug2Line },
  PlugZap: { rounded: ConnectIcon, square: RiPlug2Line },
  Plus: { rounded: PlusIcon, square: RiAddLine },
  Power: { rounded: PowerIcon, square: RiShutDownLine },
  Puzzle: { rounded: PuzzleIcon, square: RiStore2Line },
  QuillWrite: { rounded: QuillWrite02Icon, square: RiQuillPenLine },
  RefreshCw: { rounded: RefreshCwIcon, square: RiRefreshLine },
  Replace: { rounded: ReplaceAllIcon, square: RiFindReplaceLine },
  RotateCcw: { rounded: RotateCcwIcon, square: RiAnticlockwiseLine },
  Safari: { rounded: SafariIcon, square: RiCompass3Line },
  ScanSearch: { rounded: ScanSearchIcon, square: RiScan2Line },
  ScanText: { rounded: ScanTextIcon, square: RiScanLine },
  ScrollText: { rounded: ScrollTextIcon, square: RiArticleLine },
  Search: { rounded: Search01Icon, square: RiSearchLine },
  SearchCode: { rounded: SearchCodeIcon, square: RiFileSearchLine },
  SearchX: { rounded: SearchXIcon, square: RiSearchLine },
  Selection: { rounded: SquareDashedIcon, square: RiDragMove2Line },
  Send: { rounded: SendIcon, square: RiSendPlane2Line },
  Settings: { rounded: Settings01Icon, square: RiSettings3Line },
  Smartphone: { rounded: SmartphoneIcon, square: RiDeviceLine },
  Settings2: { rounded: Settings02Icon, square: RiEqualizer3Line },
  Shapes: { rounded: GeometricShapes01Icon, square: RiShapesLine },
  ShieldCheck: { rounded: ShieldCheckIcon, square: RiShieldCheckLine },
  FileShield: { rounded: FileSecurityIcon, square: RiFileShield2Line },
  Shift: { rounded: KEYCAP_ARTWORK.Shift, square: null },
  NotebookPen: { rounded: EnergyEllipseIcon, square: RiDraftLine },
  Sparkles: { rounded: SparklesIcon, square: RiSparklingLine },
  SourceCodeCircle: { rounded: SourceCodeCircleIcon, square: RiCodeBoxLine },
  SourceCode: { rounded: SourceCodeIcon, square: RiCodeBoxLine },
  Square: { rounded: SquareIcon, square: RiCheckboxBlankLine },
  SquareArrowOutUpRight: { rounded: SquareArrowOutUpRightIcon, square: RiExternalLinkLine },
  SquareFunction: { rounded: FunctionSquareIcon, square: RiFunctions },
  SquareTerminal: { rounded: SquareTerminalIcon, square: RiTerminalBoxLine },
  Stamp: { rounded: StampIcon, square: RiVerifiedBadgeLine },
  StepForward: { rounded: StepForwardIcon, square: RiSkipForwardLine },
  Stethoscope: { rounded: Hospital02Icon, square: RiStethoscopeLine },
  StickyNotePlus: { rounded: NoteAddIcon, square: RiStickyNoteAddLine },
  Subtitle: { rounded: SubtitleIcon, square: RiClosedCaptioningLine },
  Sun: { rounded: Sun01Icon, square: RiSunLine },
  Terminal: { rounded: TerminalIcon, square: RiTerminalLine },
  TextAlignCenter: { rounded: AiContentGenerator02Icon, square: RiAlignCenter },
  TextFont: { rounded: TextFontIcon, square: RiFontFamily },
  TextSearch: { rounded: TextSearchIcon, square: RiFileSearchLine },
  Type: { rounded: TextSmallcapsIcon, square: RiFontSize },
  WrapText: { rounded: TextWrapIcon, square: RiTextWrap },
  ThumbsDown: { rounded: ThumbsDownIcon, square: RiThumbDownLine },
  ThumbsUp: { rounded: ThumbsUpIcon, square: RiThumbUpLine },
  Timer: { rounded: TimerIcon, square: RiTimerLine },
  Trash2: { rounded: Delete02Icon, square: RiDeleteBin6Line },
  Undo2: { rounded: Undo02Icon, square: RiArrowGoBackLine },
  Upload: { rounded: UploadIcon, square: RiUploadLine },
  User: { rounded: UserIcon, square: RiUser3Line },
  UserRoundArrowLeft: { rounded: UserArrowLeftRightIcon, square: RiUserReceivedLine },
  Volume2: { rounded: VolumeHighIcon, square: RiVolumeUpLine },
  VolumeX: { rounded: VolumeXIcon, square: RiVolumeMuteLine },
  WandSparkles: { rounded: WandSparklesIcon, square: RiMagicLine },
  Waypoints: { rounded: Navigator02Icon, square: RiRouteLine },
  Wrench: { rounded: Wrench01Icon, square: RiToolsLine },
  X: { rounded: Cancel01Icon, square: RiCloseLargeLine },
  XCircle: { rounded: CancelCircleIcon, square: RiCloseCircleLine },
  XSquare: { rounded: CancelSquareIcon, square: RiCloseLargeLine },
  Zap: { rounded: ZapIcon, square: RiFlashlightLine },
  ZoomIn: { rounded: ZoomInIcon, square: RiZoomInLine },
  ZoomOut: { rounded: ZoomOutIcon, square: RiZoomOutLine },
} satisfies Record<string, Glyph>

function createIcon(name: string, glyph: Glyph): IconComponent {
  const Component = forwardRef<SVGSVGElement, IconProps>(({ size = UI_ICON_SIZE.normal, ...props }, ref) => {
    const [style] = useUiStyle()
    const RemixGlyph = glyph.square
    if (style === 'square' && RemixGlyph) {
      // Filled outlines already encode Remix's weight. Passing a stroke (or a
      // foreign viewBox) would thicken/crop them, especially at 16px in chrome.
      const { strokeWidth, absoluteStrokeWidth, stroke, fill, strokeLinecap, strokeLinejoin, viewBox, children, ...svgProps } = props
      return (
        <RemixGlyph
          ref={ref}
          size={size}
          aria-hidden={props['aria-label'] || props['aria-labelledby'] ? undefined : true}
          focusable="false"
          data-app-icon={name}
          data-icon-family="remix"
          {...svgProps}
          stroke="none"
        />
      )
    }
    return (
      <HugeiconsIcon
        ref={ref}
        size={size}
        // Wrench's tiny handle dot is encoded at 2px; keep the stroke-only
        // drawing at the family's 1.5px weight without outlining filled details.
        strokeWidth={glyph.rounded === Wrench01Icon ? UI_ICON_STROKE : undefined}
        aria-hidden={props['aria-label'] || props['aria-labelledby'] ? undefined : true}
        focusable="false"
        data-app-icon={name}
        data-icon-family={RemixGlyph ? 'hugeicons' : 'lucide-keycap'}
        {...props}
        icon={glyph.rounded}
      />
    )
  })
  Component.displayName = name
  return Component
}

// Keep semantic names at call sites; map their artwork only here.
export const AlertCircle = /* @__PURE__ */ createIcon('AlertCircle', GLYPHS.AlertCircle)
export const AlertTriangle = /* @__PURE__ */ createIcon('AlertTriangle', GLYPHS.AlertTriangle)
export const Anonymous = /* @__PURE__ */ createIcon('Anonymous', GLYPHS.Anonymous)
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
export const BadgeCheck = /* @__PURE__ */ createIcon('BadgeCheck', GLYPHS.BadgeCheck)
export const Ban = /* @__PURE__ */ createIcon('Ban', GLYPHS.Ban)
export const Bell = /* @__PURE__ */ createIcon('Bell', GLYPHS.Bell)
export const BookDownload = /* @__PURE__ */ createIcon('BookDownload', GLYPHS.BookDownload)
export const BookOpen = /* @__PURE__ */ createIcon('BookOpen', GLYPHS.BookOpen)
export const BookOpenCheck = /* @__PURE__ */ createIcon('BookOpenCheck', GLYPHS.BookOpenCheck)
export const BookOpenText = /* @__PURE__ */ createIcon('BookOpenText', GLYPHS.BookOpenText)
export const Bookmark = /* @__PURE__ */ createIcon('Bookmark', GLYPHS.Bookmark)
export const BookSearch = /* @__PURE__ */ createIcon('BookSearch', GLYPHS.BookSearch)
export const Bot = /* @__PURE__ */ createIcon('Bot', GLYPHS.Bot)
export const Boxes = /* @__PURE__ */ createIcon('Boxes', GLYPHS.Boxes)
export const Braces = /* @__PURE__ */ createIcon('Braces', GLYPHS.Braces)
export const Brain = /* @__PURE__ */ createIcon('Brain', GLYPHS.Brain)
export const Bug = /* @__PURE__ */ createIcon('Bug', GLYPHS.Bug)
export const CalendarCheck = /* @__PURE__ */ createIcon('CalendarCheck', GLYPHS.CalendarCheck)
export const Camera = /* @__PURE__ */ createIcon('Camera', GLYPHS.Camera)
export const Chart = /* @__PURE__ */ createIcon('Chart', GLYPHS.Chart)
export const Chat01 = /* @__PURE__ */ createIcon('Chat01', GLYPHS.Chat01)
export const ChatAdd = /* @__PURE__ */ createIcon('ChatAdd', GLYPHS.ChatAdd)
export const Chats = /* @__PURE__ */ createIcon('Chats', GLYPHS.Chats)
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
export const Codesandbox = /* @__PURE__ */ createIcon('Codesandbox', GLYPHS.Codesandbox)
export const Columns3Cog = /* @__PURE__ */ createIcon('Columns3Cog', GLYPHS.Columns3Cog)
export const Command = /* @__PURE__ */ createIcon('Command', GLYPHS.Command)
export const CommandLine = /* @__PURE__ */ createIcon('CommandLine', GLYPHS.CommandLine)
export const Compass = /* @__PURE__ */ createIcon('Compass', GLYPHS.Compass)
export const Control = /* @__PURE__ */ createIcon('Control', GLYPHS.Control)
export const CoPresent = /* @__PURE__ */ createIcon('CoPresent', GLYPHS.CoPresent)
export const Copy = /* @__PURE__ */ createIcon('Copy', GLYPHS.Copy)
export const Dashboard = /* @__PURE__ */ createIcon('Dashboard', GLYPHS.Dashboard)
export const Database = /* @__PURE__ */ createIcon('Database', GLYPHS.Database)
export const Diff = /* @__PURE__ */ createIcon('Diff', GLYPHS.Diff)
export const Download = /* @__PURE__ */ createIcon('Download', GLYPHS.Download)
export const Edit02 = /* @__PURE__ */ createIcon('Edit02', GLYPHS.Edit02)
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
export const FlowSquare = /* @__PURE__ */ createIcon('FlowSquare', GLYPHS.FlowSquare)
export const Focus = /* @__PURE__ */ createIcon('Focus', GLYPHS.Focus)
export const Folder = /* @__PURE__ */ createIcon('Folder', GLYPHS.Folder)
export const FolderInput = /* @__PURE__ */ createIcon('FolderInput', GLYPHS.FolderInput)
export const FolderKanban = /* @__PURE__ */ createIcon('FolderKanban', GLYPHS.FolderKanban)
export const FolderOpen = /* @__PURE__ */ createIcon('FolderOpen', GLYPHS.FolderOpen)
export const FolderPlus = /* @__PURE__ */ createIcon('FolderPlus', GLYPHS.FolderPlus)
export const FolderSearch = /* @__PURE__ */ createIcon('FolderSearch', GLYPHS.FolderSearch)
export const FolderTree = /* @__PURE__ */ createIcon('FolderTree', GLYPHS.FolderTree)
export const Gavel = /* @__PURE__ */ createIcon('Gavel', GLYPHS.Gavel)
export const Subagent = /* @__PURE__ */ createIcon('Subagent', GLYPHS.Subagent)
export const GitGraph = /* @__PURE__ */ createIcon('GitGraph', GLYPHS.GitGraph)
export const GitFork = /* @__PURE__ */ createIcon('GitFork', GLYPHS.GitFork)
export const GitPullRequest = /* @__PURE__ */ createIcon('GitPullRequest', GLYPHS.GitPullRequest)
export const Globe = /* @__PURE__ */ createIcon('Globe', GLYPHS.Globe)
export const Globe2 = /* @__PURE__ */ createIcon('Globe2', GLYPHS.Globe2)
export const Skills = /* @__PURE__ */ createIcon('Skills', GLYPHS.Skills)
export const History = /* @__PURE__ */ createIcon('History', GLYPHS.History)
export const Image = /* @__PURE__ */ createIcon('Image', GLYPHS.Image)
export const Inbox = /* @__PURE__ */ createIcon('Inbox', GLYPHS.Inbox)
export const Archive = /* @__PURE__ */ createIcon('Archive', GLYPHS.Archive)
export const ArchiveRestore = /* @__PURE__ */ createIcon('ArchiveRestore', GLYPHS.ArchiveRestore)
export const Hash = /* @__PURE__ */ createIcon('Hash', GLYPHS.Hash)
export const ListFilter = /* @__PURE__ */ createIcon('ListFilter', GLYPHS.ListFilter)
export const ImageIcon = /* @__PURE__ */ createIcon('ImageIcon', GLYPHS.ImageIcon)
export const ImagePlus = /* @__PURE__ */ createIcon('ImagePlus', GLYPHS.ImagePlus)
export const Info = /* @__PURE__ */ createIcon('Info', GLYPHS.Info)
export const InstallingUpdates = /* @__PURE__ */ createIcon('InstallingUpdates', GLYPHS.InstallingUpdates)
export const Keyboard = /* @__PURE__ */ createIcon('Keyboard', GLYPHS.Keyboard)
export const KeyArrowLeft = /* @__PURE__ */ createIcon('KeyArrowLeft', GLYPHS.KeyArrowLeft)
export const KeyArrowRight = /* @__PURE__ */ createIcon('KeyArrowRight', GLYPHS.KeyArrowRight)
export const KeyArrowUp = /* @__PURE__ */ createIcon('KeyArrowUp', GLYPHS.KeyArrowUp)
export const KeyArrowDown = /* @__PURE__ */ createIcon('KeyArrowDown', GLYPHS.KeyArrowDown)
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
export const PanelLeftClose = /* @__PURE__ */ createIcon('PanelLeftClose', GLYPHS.PanelLeftClose)
export const PanelLeftOpen = /* @__PURE__ */ createIcon('PanelLeftOpen', GLYPHS.PanelLeftOpen)
export const PanelRightClose = /* @__PURE__ */ createIcon('PanelRightClose', GLYPHS.PanelRightClose)
export const PanelRightOpen = /* @__PURE__ */ createIcon('PanelRightOpen', GLYPHS.PanelRightOpen)
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
export const QuillWrite = /* @__PURE__ */ createIcon('QuillWrite', GLYPHS.QuillWrite)
export const RefreshCw = /* @__PURE__ */ createIcon('RefreshCw', GLYPHS.RefreshCw)
export const Replace = /* @__PURE__ */ createIcon('Replace', GLYPHS.Replace)
export const RotateCcw = /* @__PURE__ */ createIcon('RotateCcw', GLYPHS.RotateCcw)
export const Safari = /* @__PURE__ */ createIcon('Safari', GLYPHS.Safari)
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
export const FileShield = /* @__PURE__ */ createIcon('FileShield', GLYPHS.FileShield)
export const Shift = /* @__PURE__ */ createIcon('Shift', GLYPHS.Shift)
export const NotebookPen = /* @__PURE__ */ createIcon('NotebookPen', GLYPHS.NotebookPen)
export const Sparkles = /* @__PURE__ */ createIcon('Sparkles', GLYPHS.Sparkles)
export const SourceCodeCircle = /* @__PURE__ */ createIcon('SourceCodeCircle', GLYPHS.SourceCodeCircle)
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
export const Volume2 = /* @__PURE__ */ createIcon('Volume2', GLYPHS.Volume2)
export const VolumeX = /* @__PURE__ */ createIcon('VolumeX', GLYPHS.VolumeX)
export const WandSparkles = /* @__PURE__ */ createIcon('WandSparkles', GLYPHS.WandSparkles)
export const Waypoints = /* @__PURE__ */ createIcon('Waypoints', GLYPHS.Waypoints)
export const Wrench = /* @__PURE__ */ createIcon('Wrench', GLYPHS.Wrench)
export const X = /* @__PURE__ */ createIcon('X', GLYPHS.X)
export const XCircle = /* @__PURE__ */ createIcon('XCircle', GLYPHS.XCircle)
export const XSquare = /* @__PURE__ */ createIcon('XSquare', GLYPHS.XSquare)
export const Zap = /* @__PURE__ */ createIcon('Zap', GLYPHS.Zap)
export const ZoomIn = /* @__PURE__ */ createIcon('ZoomIn', GLYPHS.ZoomIn)
export const ZoomOut = /* @__PURE__ */ createIcon('ZoomOut', GLYPHS.ZoomOut)
