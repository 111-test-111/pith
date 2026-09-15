import { forwardRef, type RefAttributes, type ForwardRefExoticComponent } from 'react'
import { HugeiconsIcon, type HugeiconsIconProps, type IconSvgElement } from '@hugeicons/react'
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
  ArrowUpNarrowWideIcon,
  ArrowUpRight01Icon,
  BanIcon,
  BookOpenTextIcon,
  Bookmark01Icon,
  BotIcon,
  BracesIcon,
  BrainIcon,
  CancelCircleIcon,
  Chart01Icon,
  Chat01Icon,
  CheckIcon,
  CheckmarkCircle02Icon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronsDownUpIcon,
  CircleIcon,
  CircleXIcon,
  Clock01Icon,
  Clock03Icon,
  CloudDownloadIcon,
  CompassIcon,
  CopyIcon,
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
  FolderInputIcon,
  FolderKanbanIcon,
  FolderOpenIcon,
  FolderTreeIcon,
  GitForkIcon,
  GitPullRequestIcon,
  GeometricShapes01Icon,
  GlobalIcon,
  Globe02Icon,
  GraduationCapIcon,
  HelpCircleIcon,
  Image01Icon,
  ImagePlusIcon,
  InfoIcon,
  KeyRoundIcon,
  LightbulbIcon,
  Link02Icon,
  ListTodoIcon,
  LoaderCircleIcon,
  LogOutIcon,
  MessageCirclePlusIcon,
  MessageSquareDashedIcon,
  MessageSquareIcon,
  MessageSquarePlusIcon,
  MessageSquareTextIcon,
  MonitorIcon,
  Moon02Icon,
  MoreHorizontalIcon,
  MusicNote01Icon,
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
  PuzzleIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  ScanSearchIcon,
  ScrollTextIcon,
  Search01Icon,
  SearchXIcon,
  Settings01Icon,
  Settings02Icon,
  ShieldCheckIcon,
  SparklesIcon,
  SquareIcon,
  SquareTerminalIcon,
  SubtitleIcon,
  Sun01Icon,
  TerminalIcon,
  TextFontIcon,
  TextSearchIcon,
  TextWrapIcon,
  ThumbsDownIcon,
  ThumbsUpIcon,
  Undo02Icon,
  UnfoldMoreIcon,
  UserIcon,
  WandSparklesIcon,
  Wrench01Icon,
  XIcon,
  ZapIcon,
  ZoomInIcon,
  ZoomOutIcon
} from '@hugeicons/core-free-icons'

/** App and beUI glyphs share this entry point; the free pack is Stroke Rounded. */
export type IconProps = Omit<HugeiconsIconProps, 'icon' | 'altIcon' | 'showAlt'>
export type IconComponent = ForwardRefExoticComponent<IconProps & RefAttributes<SVGSVGElement>>

function createIcon(name: string, icon: IconSvgElement): IconComponent {
  // Preserve the pack's native 1.5 strokes and filled details. Forcing a default
  // strokeWidth through HugeiconsIcon would also add outlines to filled paths.
  const Component = forwardRef<SVGSVGElement, IconProps>((props, ref) => (
    <HugeiconsIcon
      ref={ref}
      aria-hidden={props['aria-label'] || props['aria-labelledby'] ? undefined : true}
      focusable="false"
      data-app-icon={name}
      {...props}
      icon={icon}
    />
  ))
  Component.displayName = name
  return Component
}

// Keep semantic component names at call sites; map their artwork only here.
export const AlertCircle = /* @__PURE__ */ createIcon('AlertCircle', AlertCircleIcon)
export const AlertTriangle = /* @__PURE__ */ createIcon('AlertTriangle', Alert01Icon)
export const ArrowDown = /* @__PURE__ */ createIcon('ArrowDown', ArrowDown02Icon)
export const ArrowDownWideNarrow = /* @__PURE__ */ createIcon('ArrowDownWideNarrow', ArrowDownWideNarrowIcon)
export const ArrowLeft = /* @__PURE__ */ createIcon('ArrowLeft', ArrowLeft02Icon)
export const ArrowRight = /* @__PURE__ */ createIcon('ArrowRight', ArrowRight02Icon)
export const ArrowUp = /* @__PURE__ */ createIcon('ArrowUp', ArrowUp02Icon)
export const ArrowUpNarrowWide = /* @__PURE__ */ createIcon('ArrowUpNarrowWide', ArrowUpNarrowWideIcon)
export const ArrowUpRight = /* @__PURE__ */ createIcon('ArrowUpRight', ArrowUpRight01Icon)
export const Ban = /* @__PURE__ */ createIcon('Ban', BanIcon)
export const BookOpenText = /* @__PURE__ */ createIcon('BookOpenText', BookOpenTextIcon)
export const Bookmark = /* @__PURE__ */ createIcon('Bookmark', Bookmark01Icon)
export const Bot = /* @__PURE__ */ createIcon('Bot', BotIcon)
export const Braces = /* @__PURE__ */ createIcon('Braces', BracesIcon)
export const Brain = /* @__PURE__ */ createIcon('Brain', BrainIcon)
export const Chart = /* @__PURE__ */ createIcon('Chart', Chart01Icon)
export const Chat01 = /* @__PURE__ */ createIcon('Chat01', Chat01Icon)
export const Check = /* @__PURE__ */ createIcon('Check', CheckIcon)
export const CheckCircle2 = /* @__PURE__ */ createIcon('CheckCircle2', CheckmarkCircle02Icon)
export const ChevronDown = /* @__PURE__ */ createIcon('ChevronDown', ChevronDownIcon)
export const ChevronLeft = /* @__PURE__ */ createIcon('ChevronLeft', ChevronLeftIcon)
export const ChevronRight = /* @__PURE__ */ createIcon('ChevronRight', ChevronRightIcon)
export const ChevronsDownUp = /* @__PURE__ */ createIcon('ChevronsDownUp', ChevronsDownUpIcon)
export const ChevronsUpDown = /* @__PURE__ */ createIcon('ChevronsUpDown', UnfoldMoreIcon)
export const Circle = /* @__PURE__ */ createIcon('Circle', CircleIcon)
export const CircleAlert = /* @__PURE__ */ createIcon('CircleAlert', AlertCircleIcon)
export const CircleCheck = /* @__PURE__ */ createIcon('CircleCheck', CheckmarkCircle02Icon)
export const CircleHelp = /* @__PURE__ */ createIcon('CircleHelp', HelpCircleIcon)
export const CircleX = /* @__PURE__ */ createIcon('CircleX', CircleXIcon)
export const Clock = /* @__PURE__ */ createIcon('Clock', Clock01Icon)
export const Clock3 = /* @__PURE__ */ createIcon('Clock3', Clock03Icon)
export const CloudDownload = /* @__PURE__ */ createIcon('CloudDownload', CloudDownloadIcon)
export const Compass = /* @__PURE__ */ createIcon('Compass', CompassIcon)
export const Copy = /* @__PURE__ */ createIcon('Copy', CopyIcon)
export const Diff = /* @__PURE__ */ createIcon('Diff', DiffIcon)
export const Download = /* @__PURE__ */ createIcon('Download', Download01Icon)
export const ExternalLink = /* @__PURE__ */ createIcon('ExternalLink', ExternalLinkIcon)
export const Eye = /* @__PURE__ */ createIcon('Eye', EyeIcon)
export const EyeOff = /* @__PURE__ */ createIcon('EyeOff', EyeOffIcon)
export const FastForward = /* @__PURE__ */ createIcon('FastForward', FastForwardIcon)
export const FileCode2 = /* @__PURE__ */ createIcon('FileCode2', FileCodeIcon)
export const FileDiff = /* @__PURE__ */ createIcon('FileDiff', FileDiffIcon)
export const FilePen = /* @__PURE__ */ createIcon('FilePen', FilePenIcon)
export const FilePlus2 = /* @__PURE__ */ createIcon('FilePlus2', FileAddIcon)
export const FileSearch = /* @__PURE__ */ createIcon('FileSearch', FileSearchIcon)
export const FileSearch2 = /* @__PURE__ */ createIcon('FileSearch2', FileSearchCornerIcon)
export const FileText = /* @__PURE__ */ createIcon('FileText', FileTextIcon)
export const Folder = /* @__PURE__ */ createIcon('Folder', Folder01Icon)
export const FolderInput = /* @__PURE__ */ createIcon('FolderInput', FolderInputIcon)
export const FolderKanban = /* @__PURE__ */ createIcon('FolderKanban', FolderKanbanIcon)
export const FolderOpen = /* @__PURE__ */ createIcon('FolderOpen', FolderOpenIcon)
export const FolderTree = /* @__PURE__ */ createIcon('FolderTree', FolderTreeIcon)
export const GitFork = /* @__PURE__ */ createIcon('GitFork', GitForkIcon)
export const GitPullRequest = /* @__PURE__ */ createIcon('GitPullRequest', GitPullRequestIcon)
export const Globe = /* @__PURE__ */ createIcon('Globe', Globe02Icon)
export const Globe2 = /* @__PURE__ */ createIcon('Globe2', GlobalIcon)
export const GraduationCap = /* @__PURE__ */ createIcon('GraduationCap', GraduationCapIcon)
export const Image = /* @__PURE__ */ createIcon('Image', Image01Icon)
export const ImageIcon = /* @__PURE__ */ createIcon('ImageIcon', Image01Icon)
export const ImagePlus = /* @__PURE__ */ createIcon('ImagePlus', ImagePlusIcon)
export const Info = /* @__PURE__ */ createIcon('Info', InfoIcon)
export const KeyRound = /* @__PURE__ */ createIcon('KeyRound', KeyRoundIcon)
export const Lightbulb = /* @__PURE__ */ createIcon('Lightbulb', LightbulbIcon)
export const Link2 = /* @__PURE__ */ createIcon('Link2', Link02Icon)
export const ListTodo = /* @__PURE__ */ createIcon('ListTodo', ListTodoIcon)
export const Loader2 = /* @__PURE__ */ createIcon('Loader2', LoaderCircleIcon)
export const LoaderCircle = /* @__PURE__ */ createIcon('LoaderCircle', LoaderCircleIcon)
export const LogOut = /* @__PURE__ */ createIcon('LogOut', LogOutIcon)
export const Maximize2 = /* @__PURE__ */ createIcon('Maximize2', ArrowExpand01Icon)
export const MessageCirclePlus = /* @__PURE__ */ createIcon('MessageCirclePlus', MessageCirclePlusIcon)
export const MessageSquare = /* @__PURE__ */ createIcon('MessageSquare', MessageSquareIcon)
export const MessageSquareDashed = /* @__PURE__ */ createIcon('MessageSquareDashed', MessageSquareDashedIcon)
export const MessageSquarePlus = /* @__PURE__ */ createIcon('MessageSquarePlus', MessageSquarePlusIcon)
export const MessageSquareText = /* @__PURE__ */ createIcon('MessageSquareText', MessageSquareTextIcon)
export const Minimize2 = /* @__PURE__ */ createIcon('Minimize2', ArrowShrink01Icon)
export const Monitor = /* @__PURE__ */ createIcon('Monitor', MonitorIcon)
export const Moon = /* @__PURE__ */ createIcon('Moon', Moon02Icon)
export const MoreHorizontal = /* @__PURE__ */ createIcon('MoreHorizontal', MoreHorizontalIcon)
export const MusicNote = /* @__PURE__ */ createIcon('MusicNote', MusicNote01Icon)
export const Palette = /* @__PURE__ */ createIcon('Palette', PaletteIcon)
export const PanelLeft = /* @__PURE__ */ createIcon('PanelLeft', PanelLeftIcon)
export const PanelRight = /* @__PURE__ */ createIcon('PanelRight', PanelRightIcon)
export const Paperclip = /* @__PURE__ */ createIcon('Paperclip', PaperclipIcon)
export const Pencil = /* @__PURE__ */ createIcon('Pencil', PencilIcon)
export const PencilLine = /* @__PURE__ */ createIcon('PencilLine', PencilLineIcon)
export const Pin = /* @__PURE__ */ createIcon('Pin', PinIcon)
export const PinOff = /* @__PURE__ */ createIcon('PinOff', PinOffIcon)
export const Plug = /* @__PURE__ */ createIcon('Plug', PlugIcon)
export const PlugZap = /* @__PURE__ */ createIcon('PlugZap', PlugZapIcon)
export const Plus = /* @__PURE__ */ createIcon('Plus', PlusIcon)
export const Puzzle = /* @__PURE__ */ createIcon('Puzzle', PuzzleIcon)
export const RefreshCw = /* @__PURE__ */ createIcon('RefreshCw', RefreshCwIcon)
export const RotateCcw = /* @__PURE__ */ createIcon('RotateCcw', RotateCcwIcon)
export const ScanSearch = /* @__PURE__ */ createIcon('ScanSearch', ScanSearchIcon)
export const ScrollText = /* @__PURE__ */ createIcon('ScrollText', ScrollTextIcon)
export const Search = /* @__PURE__ */ createIcon('Search', Search01Icon)
export const SearchX = /* @__PURE__ */ createIcon('SearchX', SearchXIcon)
export const Settings = /* @__PURE__ */ createIcon('Settings', Settings01Icon)
export const Settings2 = /* @__PURE__ */ createIcon('Settings2', Settings02Icon)
export const Shapes = /* @__PURE__ */ createIcon('Shapes', GeometricShapes01Icon)
export const ShieldCheck = /* @__PURE__ */ createIcon('ShieldCheck', ShieldCheckIcon)
export const Sparkles = /* @__PURE__ */ createIcon('Sparkles', SparklesIcon)
export const Square = /* @__PURE__ */ createIcon('Square', SquareIcon)
export const SquareTerminal = /* @__PURE__ */ createIcon('SquareTerminal', SquareTerminalIcon)
export const Subtitle = /* @__PURE__ */ createIcon('Subtitle', SubtitleIcon)
export const Sun = /* @__PURE__ */ createIcon('Sun', Sun01Icon)
export const Terminal = /* @__PURE__ */ createIcon('Terminal', TerminalIcon)
export const TextFont = /* @__PURE__ */ createIcon('TextFont', TextFontIcon)
export const TextSearch = /* @__PURE__ */ createIcon('TextSearch', TextSearchIcon)
export const WrapText = /* @__PURE__ */ createIcon('WrapText', TextWrapIcon)
export const ThumbsDown = /* @__PURE__ */ createIcon('ThumbsDown', ThumbsDownIcon)
export const ThumbsUp = /* @__PURE__ */ createIcon('ThumbsUp', ThumbsUpIcon)
export const Trash2 = /* @__PURE__ */ createIcon('Trash2', Delete02Icon)
export const Undo2 = /* @__PURE__ */ createIcon('Undo2', Undo02Icon)
export const User = /* @__PURE__ */ createIcon('User', UserIcon)
export const WandSparkles = /* @__PURE__ */ createIcon('WandSparkles', WandSparklesIcon)
export const Wrench = /* @__PURE__ */ createIcon('Wrench', Wrench01Icon)
export const X = /* @__PURE__ */ createIcon('X', XIcon)
export const XCircle = /* @__PURE__ */ createIcon('XCircle', CancelCircleIcon)
export const Zap = /* @__PURE__ */ createIcon('Zap', ZapIcon)
export const ZoomIn = /* @__PURE__ */ createIcon('ZoomIn', ZoomInIcon)
export const ZoomOut = /* @__PURE__ */ createIcon('ZoomOut', ZoomOutIcon)
