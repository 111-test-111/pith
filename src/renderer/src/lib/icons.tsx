import { forwardRef, type ForwardRefExoticComponent, type ReactElement, type RefAttributes, type SVGProps } from 'react'
import {
  RiAddLine,
  RiAlertLine,
  RiAnticlockwise2Line,
  RiArrowDownLine,
  RiArrowDownSLine,
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
  RiChat4Line,
  RiCheckboxBlankCircleLine,
  RiCheckboxCircleLine,
  RiCheckLine,
  RiClosedCaptioningLine,
  RiCloseCircleLine,
  RiCloseLine,
  RiCodeSSlashLine,
  RiCompass3Line,
  RiComputerLine,
  RiContractUpDownLine,
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
  RiImage2Line,
  RiImageAddLine,
  RiImageLine,
  RiInformationLine,
  RiKeyLine,
  RiLayoutGridLine,
  RiLayoutLeftLine,
  RiLayoutRightLine,
  RiLightbulbLine,
  RiLinksLine,
  RiLoader2Line,
  RiLoader4Line,
  RiLogoutBoxRLine,
  RiMagicLine,
  RiMentalHealthLine,
  RiMoonLine,
  RiMoreLine,
  RiMusic2Line,
  RiNodeTree,
  RiNotification3Line,
  RiPaletteLine,
  RiPlug2Line,
  RiPlugLine,
  RiProhibitedLine,
  RiPushpinLine,
  RiPuzzleLine,
  RiQuestionLine,
  RiRecordCircleLine,
  RiRefreshLine,
  RiRobot2Line,
  RiScan2Line,
  RiSearch2Line,
  RiSearchLine,
  RiSettings4Line,
  RiSettingsLine,
  RiShapesLine,
  RiShieldCheckLine,
  RiSkipForwardLine,
  RiSortAsc,
  RiSortDesc,
  RiSparkling2Line,
  RiStethoscopeLine,
  RiStopLargeLine,
  RiSubtractLine,
  RiSunLine,
  RiTerminalBoxLine,
  RiTerminalLine,
  RiTerminalWindowLine,
  RiTextWrap,
  RiThumbDownLine,
  RiThumbUpLine,
  RiTimeLine,
  RiTodoLine,
  RiUnpinLine,
  RiUserLine,
  RiWrenchLine,
  RiZoomInLine,
  RiZoomOutLine,
  type RemixiconComponentType,
} from '@remixicon/react'

/**
 * App and beUI glyphs share this entry point. Experimental square-style
 * branch: the artwork is Remix Icon's line family (24×24, currentColor) and
 * call sites keep their semantic names — several predate the current packs'
 * spelling of the same shape, and a handful (BookDownload → file-download,
 * Diff → file-transfer, Monitor → computer, ListTodo → todo …) only ever had
 * a nearest-neighbour in Remix, so changing or tuning the pack stays inside
 * this file.
 */
export type IconProps = Omit<SVGProps<SVGSVGElement>, 'ref'> & {
  size?: string | number
  /** Lucide-era call-site compat: accepted, never applied to line artwork. */
  absoluteStrokeWidth?: boolean
}
export type IconComponent = ForwardRefExoticComponent<IconProps & RefAttributes<SVGSVGElement>>

/** The pack types its icons as ComponentClass although they render as plain
 * function components; loose type for the one render-time cast below. */
type RemixGlyph = (props: Record<string, unknown>) => ReactElement

function createIcon(name: string, glyph: RemixiconComponentType): IconComponent {
  // Preserve the call-site accessibility default: an unlabelled glyph is
  // decorative, a labelled one is exposed to assistive tech. Stroke-only
  // Lucide-era props are accepted for compatibility and dropped — fill
  // artwork carries no stroke geometry.
  const Component = forwardRef<SVGSVGElement, IconProps>((props, ref) => {
    const { strokeWidth: _strokeWidth, absoluteStrokeWidth: _absolute, ...rest } = props
    const Glyph = glyph as unknown as RemixGlyph
    return (
      <Glyph
        ref={ref}
        aria-hidden={rest['aria-label'] || rest['aria-labelledby'] ? undefined : true}
        focusable="false"
        data-app-icon={name}
        {...rest}
      />
    )
  })
  Component.displayName = name
  return Component as IconComponent
}

// Keep semantic component names at call sites; map their artwork only here.
export const AlertCircle = /* @__PURE__ */ createIcon('AlertCircle', RiAlertLine)
export const AlertTriangle = /* @__PURE__ */ createIcon('AlertTriangle', RiErrorWarningLine)
export const ArrowDown = /* @__PURE__ */ createIcon('ArrowDown', RiArrowDownLine)
export const ArrowDownWideNarrow = /* @__PURE__ */ createIcon('ArrowDownWideNarrow', RiSortDesc)
export const ArrowLeft = /* @__PURE__ */ createIcon('ArrowLeft', RiArrowLeftLine)
export const ArrowRight = /* @__PURE__ */ createIcon('ArrowRight', RiArrowRightLine)
export const ArrowUp = /* @__PURE__ */ createIcon('ArrowUp', RiArrowUpLine)
export const ArrowUpNarrowWide = /* @__PURE__ */ createIcon('ArrowUpNarrowWide', RiSortAsc)
export const ArrowUpRight = /* @__PURE__ */ createIcon('ArrowUpRight', RiArrowRightUpLine)
export const Ban = /* @__PURE__ */ createIcon('Ban', RiProhibitedLine)
export const Bell = /* @__PURE__ */ createIcon('Bell', RiNotification3Line)
export const BookDownload = /* @__PURE__ */ createIcon('BookDownload', RiFileDownloadLine)
export const BookOpenText = /* @__PURE__ */ createIcon('BookOpenText', RiBookOpenLine)
export const Bookmark = /* @__PURE__ */ createIcon('Bookmark', RiBookmarkLine)
export const BookSearch = /* @__PURE__ */ createIcon('BookSearch', RiBookReadLine)
export const Bot = /* @__PURE__ */ createIcon('Bot', RiRobot2Line)
export const Braces = /* @__PURE__ */ createIcon('Braces', RiBracesLine)
export const Brain = /* @__PURE__ */ createIcon('Brain', RiMentalHealthLine)
export const Chart = /* @__PURE__ */ createIcon('Chart', RiBarChart2Line)
export const Chat01 = /* @__PURE__ */ createIcon('Chat01', RiChat4Line)
export const Check = /* @__PURE__ */ createIcon('Check', RiCheckLine)
export const CheckCircle2 = /* @__PURE__ */ createIcon('CheckCircle2', RiCheckboxCircleLine)
export const ChevronDown = /* @__PURE__ */ createIcon('ChevronDown', RiArrowDownSLine)
export const ChevronLeft = /* @__PURE__ */ createIcon('ChevronLeft', RiArrowLeftSLine)
export const ChevronRight = /* @__PURE__ */ createIcon('ChevronRight', RiArrowRightSLine)
export const ChevronsDownUp = /* @__PURE__ */ createIcon('ChevronsDownUp', RiContractUpDownLine)
export const ChevronsUpDown = /* @__PURE__ */ createIcon('ChevronsUpDown', RiExpandUpDownLine)
export const Circle = /* @__PURE__ */ createIcon('Circle', RiRecordCircleLine)
export const CircleAlert = /* @__PURE__ */ createIcon('CircleAlert', RiAlertLine)
export const CircleCheck = /* @__PURE__ */ createIcon('CircleCheck', RiCheckboxCircleLine)
export const CircleHelp = /* @__PURE__ */ createIcon('CircleHelp', RiQuestionLine)
export const CircleX = /* @__PURE__ */ createIcon('CircleX', RiCloseCircleLine)
export const Clock = /* @__PURE__ */ createIcon('Clock', RiTimeLine)
export const Clock3 = /* @__PURE__ */ createIcon('Clock3', RiTimeLine)
export const CloudDownload = /* @__PURE__ */ createIcon('CloudDownload', RiDownloadCloud2Line)
export const CommandLine = /* @__PURE__ */ createIcon('CommandLine', RiTerminalBoxLine)
export const Compass = /* @__PURE__ */ createIcon('Compass', RiCompass3Line)
export const Copy = /* @__PURE__ */ createIcon('Copy', RiFileCopyLine)
export const Dashboard = /* @__PURE__ */ createIcon('Dashboard', RiDashboardLine)
export const Database = /* @__PURE__ */ createIcon('Database', RiDatabase2Line)
export const Diff = /* @__PURE__ */ createIcon('Diff', RiFileTransferLine)
export const Download = /* @__PURE__ */ createIcon('Download', RiDownloadLine)
export const ExternalLink = /* @__PURE__ */ createIcon('ExternalLink', RiExternalLinkLine)
export const Eye = /* @__PURE__ */ createIcon('Eye', RiEyeLine)
export const EyeOff = /* @__PURE__ */ createIcon('EyeOff', RiEyeOffLine)
export const FastForward = /* @__PURE__ */ createIcon('FastForward', RiSkipForwardLine)
export const FileCode2 = /* @__PURE__ */ createIcon('FileCode2', RiFileCodeLine)
export const FileDiff = /* @__PURE__ */ createIcon('FileDiff', RiFileTransferLine)
export const FilePen = /* @__PURE__ */ createIcon('FilePen', RiFileEditLine)
export const FilePlus2 = /* @__PURE__ */ createIcon('FilePlus2', RiFileAddLine)
export const FileSearch = /* @__PURE__ */ createIcon('FileSearch', RiFileSearchLine)
export const FileSearch2 = /* @__PURE__ */ createIcon('FileSearch2', RiFileSearchLine)
export const FileText = /* @__PURE__ */ createIcon('FileText', RiFileTextLine)
export const Folder = /* @__PURE__ */ createIcon('Folder', RiFolderLine)
export const FolderInput = /* @__PURE__ */ createIcon('FolderInput', RiFolderReceivedLine)
export const FolderKanban = /* @__PURE__ */ createIcon('FolderKanban', RiLayoutGridLine)
export const FolderOpen = /* @__PURE__ */ createIcon('FolderOpen', RiFolderOpenLine)
export const FolderPlus = /* @__PURE__ */ createIcon('FolderPlus', RiFolderAddLine)
export const FolderTree = /* @__PURE__ */ createIcon('FolderTree', RiNodeTree)
export const GitFork = /* @__PURE__ */ createIcon('GitFork', RiGitBranchLine)
export const GitPullRequest = /* @__PURE__ */ createIcon('GitPullRequest', RiGitPullRequestLine)
export const Globe = /* @__PURE__ */ createIcon('Globe', RiGlobalLine)
export const Globe2 = /* @__PURE__ */ createIcon('Globe2', RiGlobalLine)
export const GraduationCap = /* @__PURE__ */ createIcon('GraduationCap', RiGraduationCapLine)
export const Image = /* @__PURE__ */ createIcon('Image', RiImageLine)
export const ImageIcon = /* @__PURE__ */ createIcon('ImageIcon', RiImage2Line)
export const ImagePlus = /* @__PURE__ */ createIcon('ImagePlus', RiImageAddLine)
export const Info = /* @__PURE__ */ createIcon('Info', RiInformationLine)
export const InstallingUpdates = /* @__PURE__ */ createIcon('InstallingUpdates', RiDownload2Line)
export const KeyRound = /* @__PURE__ */ createIcon('KeyRound', RiKeyLine)
export const Lightbulb = /* @__PURE__ */ createIcon('Lightbulb', RiLightbulbLine)
export const Link2 = /* @__PURE__ */ createIcon('Link2', RiLinksLine)
export const ListTodo = /* @__PURE__ */ createIcon('ListTodo', RiTodoLine)
export const Loader2 = /* @__PURE__ */ createIcon('Loader2', RiLoader2Line)
export const LoaderCircle = /* @__PURE__ */ createIcon('LoaderCircle', RiLoader4Line)
export const LogOut = /* @__PURE__ */ createIcon('LogOut', RiLogoutBoxRLine)
export const Maximize2 = /* @__PURE__ */ createIcon('Maximize2', RiFullscreenLine)
export const MessageCirclePlus = /* @__PURE__ */ createIcon('MessageCirclePlus', RiChat4Line)
export const MessageSquare = /* @__PURE__ */ createIcon('MessageSquare', RiChat4Line)
export const MessageSquareDashed = /* @__PURE__ */ createIcon('MessageSquareDashed', RiChat4Line)
export const MessageSquarePlus = /* @__PURE__ */ createIcon('MessageSquarePlus', RiChat4Line)
export const MessageSquareText = /* @__PURE__ */ createIcon('MessageSquareText', RiChat4Line)
export const Minimize2 = /* @__PURE__ */ createIcon('Minimize2', RiFullscreenExitLine)
export const Minus = /* @__PURE__ */ createIcon('Minus', RiSubtractLine)
export const Monitor = /* @__PURE__ */ createIcon('Monitor', RiComputerLine)
export const Moon = /* @__PURE__ */ createIcon('Moon', RiMoonLine)
export const MoreHorizontal = /* @__PURE__ */ createIcon('MoreHorizontal', RiMoreLine)
export const MusicNote = /* @__PURE__ */ createIcon('MusicNote', RiMusic2Line)
export const Palette = /* @__PURE__ */ createIcon('Palette', RiPaletteLine)
export const PanelLeft = /* @__PURE__ */ createIcon('PanelLeft', RiLayoutLeftLine)
export const PanelRight = /* @__PURE__ */ createIcon('PanelRight', RiLayoutRightLine)
export const Paperclip = /* @__PURE__ */ createIcon('Paperclip', RiAttachmentLine)
export const Pencil = /* @__PURE__ */ createIcon('Pencil', RiEditLine)
export const PencilLine = /* @__PURE__ */ createIcon('PencilLine', RiEdit2Line)
export const Pin = /* @__PURE__ */ createIcon('Pin', RiPushpinLine)
export const PinOff = /* @__PURE__ */ createIcon('PinOff', RiUnpinLine)
export const Plug = /* @__PURE__ */ createIcon('Plug', RiPlugLine)
export const PlugZap = /* @__PURE__ */ createIcon('PlugZap', RiPlug2Line)
export const Plus = /* @__PURE__ */ createIcon('Plus', RiAddLine)
export const Puzzle = /* @__PURE__ */ createIcon('Puzzle', RiPuzzleLine)
export const RefreshCw = /* @__PURE__ */ createIcon('RefreshCw', RiRefreshLine)
export const RotateCcw = /* @__PURE__ */ createIcon('RotateCcw', RiAnticlockwise2Line)
export const ScanSearch = /* @__PURE__ */ createIcon('ScanSearch', RiScan2Line)
export const ScrollText = /* @__PURE__ */ createIcon('ScrollText', RiFilePaperLine)
export const Search = /* @__PURE__ */ createIcon('Search', RiSearchLine)
export const SearchX = /* @__PURE__ */ createIcon('SearchX', RiCloseCircleLine)
export const Settings = /* @__PURE__ */ createIcon('Settings', RiSettingsLine)
export const Settings2 = /* @__PURE__ */ createIcon('Settings2', RiSettings4Line)
export const Shapes = /* @__PURE__ */ createIcon('Shapes', RiShapesLine)
export const ShieldCheck = /* @__PURE__ */ createIcon('ShieldCheck', RiShieldCheckLine)
export const Sparkles = /* @__PURE__ */ createIcon('Sparkles', RiSparkling2Line)
export const SourceCode = /* @__PURE__ */ createIcon('SourceCode', RiCodeSSlashLine)
export const Square = /* @__PURE__ */ createIcon('Square', RiStopLargeLine)
export const SquareTerminal = /* @__PURE__ */ createIcon('SquareTerminal', RiTerminalWindowLine)
export const Stethoscope = /* @__PURE__ */ createIcon('Stethoscope', RiStethoscopeLine)
export const Subtitle = /* @__PURE__ */ createIcon('Subtitle', RiClosedCaptioningLine)
export const Sun = /* @__PURE__ */ createIcon('Sun', RiSunLine)
export const Terminal = /* @__PURE__ */ createIcon('Terminal', RiTerminalLine)
export const TextFont = /* @__PURE__ */ createIcon('TextFont', RiFontSize2)
export const TextSearch = /* @__PURE__ */ createIcon('TextSearch', RiSearch2Line)
export const WrapText = /* @__PURE__ */ createIcon('WrapText', RiTextWrap)
export const ThumbsDown = /* @__PURE__ */ createIcon('ThumbsDown', RiThumbDownLine)
export const ThumbsUp = /* @__PURE__ */ createIcon('ThumbsUp', RiThumbUpLine)
export const Trash2 = /* @__PURE__ */ createIcon('Trash2', RiDeleteBin6Line)
export const Undo2 = /* @__PURE__ */ createIcon('Undo2', RiArrowGoBackLine)
export const User = /* @__PURE__ */ createIcon('User', RiUserLine)
export const WandSparkles = /* @__PURE__ */ createIcon('WandSparkles', RiMagicLine)
export const Wrench = /* @__PURE__ */ createIcon('Wrench', RiWrenchLine)
export const X = /* @__PURE__ */ createIcon('X', RiCloseLine)
export const XCircle = /* @__PURE__ */ createIcon('XCircle', RiCloseCircleLine)
export const Zap = /* @__PURE__ */ createIcon('Zap', RiFlashlightLine)
export const ZoomIn = /* @__PURE__ */ createIcon('ZoomIn', RiZoomInLine)
export const ZoomOut = /* @__PURE__ */ createIcon('ZoomOut', RiZoomOutLine)
