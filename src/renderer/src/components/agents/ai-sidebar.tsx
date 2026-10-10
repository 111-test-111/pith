// local patch (pi-app): shared scalable typography for UI annotations.
// local patch (pi-app): keep UI frames and focus rings in this component at 1px.
"use client";
// beui.dev/components/agents/chat-app

// local patch (pi-app): use the shared UI icon adapter.
import {
  ArrowDown,
  ArrowUp,
  Bookmark,
  FileText,
  Folder,
  FolderInput,
  FolderOpen,
  type IconComponent,
  MoreHorizontal,
  Pencil,
  Undo2,
} from "@/lib/icons";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
// local patch (pi-app): inline rename shares the sidebar filter style.
import { SINGLE_LINE_INPUT_PADDING, SINGLE_LINE_INPUT_TEXT } from "@/lib/input-style";
import {
  type DragEvent,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  MorphPopover,
  MorphPopoverContent,
  MorphPopoverTrigger,
} from "@/components/motion/popover-morph";
import { EASE_OUT, SPRING_LAYOUT } from "@/lib/ease";
import { useTouchCapable } from "@/lib/hooks/use-touch-capable";
import { cn } from "@/lib/utils";

export type SidebarResourceKind =
  | "folder"
  | "project"
  | "file"
  | "bookmark";

export interface SidebarResource {
  id: string;
  label: string;
  kind: SidebarResourceKind;
  children?: SidebarResource[];
  disabled?: boolean;
}

export type SidebarResourceDropPosition = "before" | "inside" | "after";

export interface SidebarResourceMove {
  itemId: string;
  targetId: string | null;
  position: SidebarResourceDropPosition;
}

/**
 * The moves this row can make right now, the same four the keyboard offers on
 * `Alt+Shift+Arrow`. A pointer drag is the fast path for them; a finger has no
 * drag to give, so the row menu carries them too. Absent keys are moves this
 * row cannot make from where it sits.
 */
export interface SidebarResourceMoveCommands {
  up?: () => void;
  down?: () => void;
  into?: { label: string; run: () => void };
  out?: () => void;
}

export interface SidebarResourceMenuControls {
  close: () => void;
  rename: () => void;
  moves: SidebarResourceMoveCommands;
}

export interface AISidebarProps {
  items?: SidebarResource[];
  defaultItems?: SidebarResource[];
  onItemsChange?: (items: SidebarResource[]) => void;
  /** Reject the promise to roll the optimistic move back. */
  onMove?: (move: SidebarResourceMove) => void | Promise<void>;
  onMoveError?: (error: unknown, move: SidebarResourceMove) => void;
  onRename?: (item: SidebarResource, label: string) => void | Promise<void>;
  activeId?: string | null;
  defaultActiveId?: string | null;
  onActiveChange?: (id: string) => void;
  defaultExpandedIds?: string[];
  // local patch (pi-app): the app owns persistent collapse and row presentation.
  expandedIds?: string[];
  onExpandedIdsChange?: (ids: string[]) => void;
  renderLabel?: (item: SidebarResource, label: ReactNode) => ReactNode;
  // local patch (pi-app): app tooltips can observe the entire row, including its icon.
  renderRow?: (item: SidebarResource, row: ReactElement, state: {
    renaming: boolean;
    menuOpen: boolean;
    dragging: boolean;
  }) => ReactNode;
  canRename?: (item: SidebarResource) => boolean;
  hasMenu?: (item: SidebarResource) => boolean;
  menuClassName?: string;
  menuHeight?: number;
  labels?: {
    actionsFor: (label: string) => string;
    renameLabel: (label: string) => string;
    movePending: string;
    moved: (label: string, target: string, position: SidebarResourceDropPosition) => string;
    moveFailed: (label: string) => string;
    renameFailed: (label: string) => string;
  };
  /** Allow rows to drop INTO container rows (sub-folder nesting) via drag,
   * the row menu, and keyboard moves. False limits every move path to
   * before/after reordering. Default: true. */
  allowNesting?: boolean;
  // local patch (pi-app): app-owned membership rules apply before optimistic
  // updates, and to pointer, keyboard and menu moves alike.
  canDrag?: (item: SidebarResource) => boolean;
  canMove?: (move: SidebarResourceMove) => boolean;
  renderIcon?: (item: SidebarResource) => ReactNode;
  renderMenu?: (
    item: SidebarResource,
    controls: SidebarResourceMenuControls,
  ) => ReactNode;
  /** local patch (pi-app): extra row actions rendered to the left of the
   * built-in menu button (used for the per-project "new chat" button). */
  renderActions?: (item: SidebarResource) => ReactNode;
  ariaLabel?: string;
  className?: string;
}

interface FlatResource {
  item: SidebarResource;
  depth: number;
  parentId: string | null;
}

interface DropTarget {
  id: string | null;
  position: SidebarResourceDropPosition;
}

const ROW_REVEAL = {
  duration: 0.16,
  ease: EASE_OUT,
} as const;

function canContain(item: SidebarResource) {
  return item.kind === "folder" || item.kind === "project";
}

function flattenResources(
  items: SidebarResource[],
  expanded: Set<string>,
  depth = 0,
  parentId: string | null = null,
): FlatResource[] {
  return items.flatMap((item) => {
    const row = { item, depth, parentId };
    if (!item.children?.length || !expanded.has(item.id)) return [row];
    return [
      row,
      ...flattenResources(item.children, expanded, depth + 1, item.id),
    ];
  });
}

function findResource(
  items: SidebarResource[],
  id: string,
): SidebarResource | undefined {
  for (const item of items) {
    if (item.id === id) return item;
    const child = item.children ? findResource(item.children, id) : undefined;
    if (child) return child;
  }
}

function containsResource(item: SidebarResource, id: string): boolean {
  return (
    item.id === id ||
    item.children?.some((child) => containsResource(child, id)) === true
  );
}

function removeResource(
  items: SidebarResource[],
  id: string,
): { items: SidebarResource[]; removed?: SidebarResource } {
  let removed: SidebarResource | undefined;
  const next: SidebarResource[] = [];

  for (const item of items) {
    if (item.id === id) {
      removed = item;
      continue;
    }

    if (item.children?.length) {
      const childResult = removeResource(item.children, id);
      if (childResult.removed) {
        removed = childResult.removed;
        next.push({ ...item, children: childResult.items });
        continue;
      }
    }

    next.push(item);
  }

  return { items: next, removed };
}

function insertResource(
  items: SidebarResource[],
  resource: SidebarResource,
  targetId: string | null,
  position: SidebarResourceDropPosition,
): SidebarResource[] {
  if (targetId === null) return [...items, resource];

  const next: SidebarResource[] = [];
  for (const item of items) {
    if (item.id === targetId) {
      if (position === "before") next.push(resource, item);
      else if (position === "after") next.push(item, resource);
      else next.push({ ...item, children: [...(item.children ?? []), resource] });
      continue;
    }

    if (item.children?.length) {
      next.push({
        ...item,
        children: insertResource(item.children, resource, targetId, position),
      });
    } else {
      next.push(item);
    }
  }
  return next;
}

function moveResource(
  items: SidebarResource[],
  move: SidebarResourceMove,
): SidebarResource[] | null {
  const source = findResource(items, move.itemId);
  if (!source || source.disabled) return null;
  if (move.targetId && containsResource(source, move.targetId)) return null;

  const target = move.targetId ? findResource(items, move.targetId) : undefined;
  if (
    move.position === "inside" &&
    (!target || target.disabled || !canContain(target))
  )
    return null;

  const removed = removeResource(items, move.itemId);
  if (!removed.removed) return null;
  return insertResource(
    removed.items,
    removed.removed,
    move.targetId,
    move.position,
  );
}

function renameResource(
  items: SidebarResource[],
  id: string,
  label: string,
): SidebarResource[] {
  return items.map((item) => ({
    ...item,
    label: item.id === id ? label : item.label,
    children: item.children
      ? renameResource(item.children, id, label)
      : undefined,
  }));
}

function defaultIcon(item: SidebarResource, expanded: boolean) {
  const Icon =
    item.kind === "folder" || item.kind === "project"
      ? expanded
        ? FolderOpen
        : Folder
      : item.kind === "bookmark"
          ? Bookmark
          : FileText;
  return <Icon className="size-4" />;
}

// local patch (pi-app): labels stay still on hover; app labels may add a tooltip.
function ResourceLabel({ children }: { children: string }) {
  return (
    // Floating actions overlay the label without reserving space or shifting it.
    <span data-resource-label className="relative z-0 block min-w-0 flex-1 overflow-hidden whitespace-nowrap [mask-image:linear-gradient(to_right,black_calc(100%_-_2rem),transparent)]">
      {children}
    </span>
  );
}

function ResourceMenuAction({
  icon: Icon,
  onSelect,
  children,
}: {
  icon: IconComponent;
  onSelect: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left text-xs text-foreground outline-none transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:ring-1 focus-visible:ring-ring"
    >
      <Icon aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate">{children}</span>
    </button>
  );
}

// local patch (pi-app): the row menu is portalled to the viewport, so a row
// near the bottom edge would have its panel cut off by the window — see
// ResourceRow.resolveMenuSide. Tallest menu the app renders (seven h-8 actions
// plus the panel's padding and divider), and the gap kept from the window edge.
const ROW_MENU_HEIGHT = 232;
const ROW_MENU_EDGE_MARGIN = 12;

interface ResourceRowProps {
  row: FlatResource;
  // local patch (pi-app): project and synthetic rows cannot start a drag.
  draggable: boolean;
  // local patch (pi-app): synthetic sections are never renamed or given empty menus.
  renameable: boolean;
  hasMenu: boolean;
  active: boolean;
  expanded: boolean;
  focused: boolean;
  draggingId: string | null;
  dropTarget: DropTarget | null;
  menuOpen: boolean;
  moves: SidebarResourceMoveCommands;
  renaming: boolean;
  onDragEnd: () => void;
  onDragOver: (event: DragEvent<HTMLDivElement>, row: FlatResource) => void;
  onDragStart: (event: DragEvent<HTMLDivElement>, id: string) => void;
  onDrop: (event: DragEvent<HTMLDivElement>) => void;
  onFocus: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  onMenuOpenChange: (open: boolean) => void;
  onRenameCancel: () => void;
  onRenameCommit: (label: string) => void;
  onRenameStart: () => void;
  onSelect: () => void;
  onToggle: () => void;
  renderIcon?: (item: SidebarResource) => ReactNode;
  renderMenu?: AISidebarProps["renderMenu"];
  renderActions?: AISidebarProps["renderActions"];
  renderLabel?: AISidebarProps["renderLabel"];
  renderRow?: AISidebarProps["renderRow"];
  labels?: AISidebarProps["labels"];
  menuClassName?: string;
  menuHeight: number;
  setRef: (node: HTMLDivElement | null) => void;
}

function ResourceRow({
  row,
  draggable,
  renameable,
  hasMenu,
  active,
  expanded,
  focused,
  draggingId,
  dropTarget,
  menuOpen,
  moves,
  renaming,
  onDragEnd,
  onDragOver,
  onDragStart,
  onDrop,
  onFocus,
  onKeyDown,
  onMenuOpenChange,
  onRenameCancel,
  onRenameCommit,
  onRenameStart,
  onSelect,
  onToggle,
  renderIcon,
  renderMenu,
  renderActions,
  renderLabel,
  renderRow,
  labels,
  menuClassName,
  menuHeight,
  setRef,
}: ResourceRowProps) {
  const reduce = useReducedMotion() ?? false;
  const canTouch = useTouchCapable();
  const inputRef = useRef<HTMLInputElement>(null);
  // local patch (pi-app): a row near the bottom of the window must open its
  // menu upward — the panel is portalled to the viewport, so it is otherwise
  // cut off by the window edge. The row measures itself (the merged ref keeps
  // the parent's row map intact) and settles the direction on hover, before
  // the panel mounts, and again as the menu opens, for the keyboard and touch
  // opens that never hover.
  const rowNodeRef = useRef<HTMLDivElement | null>(null);
  const [menuSide, setMenuSide] = useState<"top" | "bottom">("bottom");
  const measureRow = useCallback((node: HTMLDivElement | null) => {
    rowNodeRef.current = node;
    setRef(node);
  }, [setRef]);
  /** Upward when the room below the row cannot hold the menu; when neither
   * side fits, the roomier one wins. */
  const resolveMenuSide = useCallback(() => {
    const node = rowNodeRef.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    const below = window.innerHeight - rect.bottom - ROW_MENU_EDGE_MARGIN;
    const above = rect.top - ROW_MENU_EDGE_MARGIN;
    setMenuSide(below >= Math.min(menuHeight, window.innerHeight - 24) || below >= above ? "bottom" : "top");
  }, [menuHeight]);
  useLayoutEffect(() => {
    if (menuOpen) resolveMenuSide();
  }, [menuOpen, resolveMenuSide]);
  const skipRenameBlurRef = useRef(false);
  const draggedRef = useRef(false);
  const [draft, setDraft] = useState(row.item.label);
  const acceptsChildren = canContain(row.item);
  const isDragging = draggingId === row.item.id;
  const dropPosition = dropTarget?.id === row.item.id ? dropTarget.position : null;

  useEffect(() => {
    if (!renaming) return;
    skipRenameBlurRef.current = false;
    setDraft(row.item.label);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }, [renaming, row.item.label]);

  const runFromMenu = (action: () => void) => () => {
    onMenuOpenChange(false);
    action();
  };

  const menu = renderMenu?.(row.item, {
    close: () => onMenuOpenChange(false),
    rename: () => {
      onMenuOpenChange(false);
      onRenameStart();
    },
    moves,
  }) ?? (
    <>
      <ResourceMenuAction icon={Pencil} onSelect={runFromMenu(onRenameStart)}>
        Rename
      </ResourceMenuAction>
      {moves.up || moves.down || moves.into || moves.out ? (
        <div aria-hidden="true" className="my-1 h-px bg-border" />
      ) : null}
      {moves.up ? (
        <ResourceMenuAction icon={ArrowUp} onSelect={runFromMenu(moves.up)}>
          Move up
        </ResourceMenuAction>
      ) : null}
      {moves.down ? (
        <ResourceMenuAction icon={ArrowDown} onSelect={runFromMenu(moves.down)}>
          Move down
        </ResourceMenuAction>
      ) : null}
      {moves.into ? (
        <ResourceMenuAction
          icon={FolderInput}
          onSelect={runFromMenu(moves.into.run)}
        >
          Move into {moves.into.label}
        </ResourceMenuAction>
      ) : null}
      {moves.out ? (
        <ResourceMenuAction icon={Undo2} onSelect={runFromMenu(moves.out)}>
          Move out
        </ResourceMenuAction>
      ) : null}
    </>
  );

  const element = (
    // local patch (registry beui.dev/components/agents/ai-sidebar has no enter
    // animation): rows fade/slide in when a folder expands, so children stop
    // popping in while siblings glide. No `exit` — collapse keeps its
    // instant-removal + sibling-glide behavior. Reduce-motion skips entirely.
    <motion.div
      ref={measureRow}
      layout="position"
      initial={reduce ? false : { opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={
        reduce
          ? { duration: 0 }
          : { ...SPRING_LAYOUT, opacity: ROW_REVEAL, y: ROW_REVEAL }
      }
      role="treeitem"
      aria-level={row.depth + 1}
      aria-selected={acceptsChildren ? undefined : active}
      aria-expanded={acceptsChildren ? expanded : undefined}
      aria-disabled={row.item.disabled || undefined}
      tabIndex={focused ? 0 : -1}
      draggable={draggable && !row.item.disabled && !renaming}
      data-menu-open={menuOpen || undefined}
      // local patch (pi-app): stable app identity for the shared context-menu resolver.
      data-resource-id={row.item.id}
      data-drop={dropPosition ?? undefined}
      data-dragging={isDragging || undefined}
      onFocus={onFocus}
      onKeyDown={onKeyDown}
      onClick={(event) => {
        // local patch (pi-app): the row menu is portalled to the viewport, so a
        // press inside it bubbles back through THIS row's React tree — without
        // this guard every menu action (Copy session ID among them) also
        // selected the session behind the open menu.
        if (
          event.target instanceof Element &&
          event.target.closest("[data-sidebar-resource-menu]")
        )
          return;
        if (
          event.defaultPrevented ||
          draggedRef.current ||
          renaming ||
          row.item.disabled
        )
          return;
        if (acceptsChildren) onToggle();
        else onSelect();
      }}
      onDoubleClick={(event) => {
        if (acceptsChildren || row.item.disabled || !renameable) return;
        event.preventDefault();
        onRenameStart();
      }}
      onMouseEnter={resolveMenuSide}
      onDragStartCapture={(event) => {
        // local patch (pi-app): reject synthetic/descendant drags as well.
        if (!draggable || row.item.disabled || renaming) {
          event.preventDefault();
          return;
        }
        draggedRef.current = true;
        // local patch (pi-app): Chromium snapshots the composited row (a
        // motion layout layer) onto an opaque white square for the native
        // drag image. Build an offscreen clone styled as a theme card and
        // use that as the drag image instead, anchored to the pointer.
        const source = event.currentTarget;
        const ghost = source.cloneNode(true) as HTMLElement;
        ghost.removeAttribute("data-dragging");
        ghost.removeAttribute("data-drop");
        ghost.setAttribute("aria-hidden", "true");
        ghost.className = cn(
          source.className,
          // local patch (pi-app): the floating drag image shares themed elevation.
          "bg-background shadow-overlay ring-1 ring-border",
        );
        ghost.style.position = "fixed";
        ghost.style.left = "0px";
        ghost.style.top = "-10000px";
        ghost.style.width = `${source.offsetWidth}px`;
        ghost.style.margin = "0";
        ghost.style.transform = "none";
        ghost.style.pointerEvents = "none";
        document.body.appendChild(ghost);
        // setDragImage is only honored on the real drag's data store; guard
        // so synthetic events can't break the drag state below.
        try {
          const rect = source.getBoundingClientRect();
          const dx = Math.max(
            0,
            Math.min(source.offsetWidth, event.clientX - rect.left),
          );
          const dy = Math.max(
            0,
            Math.min(source.offsetHeight, event.clientY - rect.top),
          );
          event.dataTransfer.setDragImage(ghost, dx, dy);
        } catch {
          ghost.remove();
        }
        requestAnimationFrame(() => {
          if (ghost.isConnected) ghost.remove();
        });
        onDragStart(event, row.item.id);
      }}
      onDragEndCapture={() => {
        onDragEnd();
        requestAnimationFrame(() => {
          draggedRef.current = false;
        });
      }}
      onDragOver={(event) => onDragOver(event, row)}
      onDrop={onDrop}
      className={cn(
        "group/resource relative flex min-h-9 w-full min-w-0 cursor-pointer items-center gap-2.5 rounded-xl pr-3 text-sm outline-none",
        "text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
        "focus-visible:bg-muted/70 focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset",
        "data-[menu-open=true]:bg-muted data-[menu-open=true]:text-foreground",
        "data-[dragging=true]:opacity-40",
        "data-[drop=inside]:bg-primary/10 data-[drop=inside]:ring-1 data-[drop=inside]:ring-primary/45",
        // local patch (pi-app): drop indicators are square strips on the
        // square-style branch instead of 2px capsules.
        "data-[drop=before]:before:absolute data-[drop=before]:before:-top-0.5 data-[drop=before]:before:right-2 data-[drop=before]:before:left-2 data-[drop=before]:before:h-0.5 data-[drop=before]:before:rounded-detail data-[drop=before]:before:bg-primary",
        "data-[drop=after]:after:absolute data-[drop=after]:after:-bottom-0.5 data-[drop=after]:after:right-2 data-[drop=after]:after:left-2 data-[drop=after]:after:h-0.5 data-[drop=after]:after:rounded-detail data-[drop=after]:after:bg-primary",
        !acceptsChildren && active && "bg-muted text-foreground",
        row.item.disabled && "cursor-not-allowed opacity-45",
      )}
      style={{ paddingLeft: `${12 + row.depth * 16}px` }}
    >
      <span aria-hidden="true" className="grid size-5 shrink-0 place-items-center">
        {renderIcon?.(row.item) ?? defaultIcon(row.item, expanded)}
      </span>

      {renaming ? (
        <input
          ref={inputRef}
          value={draft}
          aria-label={labels?.renameLabel(row.item.label) ?? `Rename ${row.item.label}`}
          onChange={(event) => setDraft(event.target.value)}
          draggable={false}
          onClick={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
          onBlur={() => {
            if (!skipRenameBlurRef.current) onRenameCommit(draft);
          }}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Enter") {
              skipRenameBlurRef.current = true;
              onRenameCommit(draft);
            }
            if (event.key === "Escape") {
              skipRenameBlurRef.current = true;
              onRenameCancel();
            }
          }}
          // local patch (pi-app): inline rename uses the same inset as other single-line inputs.
          className={cn("mx-1 min-w-0 flex-1 rounded-md border border-border bg-background text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring", SINGLE_LINE_INPUT_TEXT, SINGLE_LINE_INPUT_PADDING)}
        />
      ) : (
        renderLabel?.(row.item, <ResourceLabel>{row.item.label}</ResourceLabel>) ??
          <ResourceLabel>{row.item.label}</ResourceLabel>
      )}

      {!renaming && !row.item.disabled ? renderActions?.(row.item) : null}
      {!renaming && !row.item.disabled && hasMenu ? (
        // local patch (pi-app): float the actions menu over the row instead of
        // reserving a ~28px slot for it, so a title can use the full row width
        // instead of stopping well short of the right edge.
        <MorphPopover
          open={menuOpen}
          onOpenChange={onMenuOpenChange}
          className="absolute right-3 top-1/2 z-10 -translate-y-1/2"
        >
          <MorphPopoverTrigger>
            <button
              type="button"
              draggable={false}
              tabIndex={-1}
              aria-label={labels?.actionsFor(row.item.label) ?? `Actions for ${row.item.label}`}
              onClick={(event) => event.stopPropagation()}
              className={cn(
                // local patch (pi-app): opaque background so the row hover
                // state can't show the title through the floating menu button.
                // local patch (pi-app): the floating action has a fill cue
                // without a persistent outline.
                "grid size-7 shrink-0 place-items-center rounded-lg bg-background text-muted-foreground outline-none transition-[opacity,color,background-color] hover:bg-muted hover:text-foreground focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-ring group-hover/resource:opacity-100 group-data-[menu-open=true]/resource:opacity-100",
                // A finger never hovers, and this menu is the only path to
                // rename and move without a drag — keep it on screen there.
                canTouch ? "opacity-100" : "opacity-0",
              )}
            >
              <MoreHorizontal aria-hidden="true" className="size-4" />
            </button>
          </MorphPopoverTrigger>
          {/* local patch (pi-app): follows `menuSide` — see resolveMenuSide. */}
          <MorphPopoverContent
            side={menuSide}
            align="end"
            sideOffset={8}
            // local patch (pi-app): resource menus consume the shared surface radius.
            radius="var(--app-radius-card)"
            className={cn("w-40 p-1.5", menuClassName)}
          >
            <div data-sidebar-resource-menu={row.item.id}>{menu}</div>
          </MorphPopoverContent>
        </MorphPopover>
      ) : null}
    </motion.div>
  );
  return renderRow?.(row.item, element, { renaming, menuOpen, dragging: isDragging }) ?? element;
}

export function AISidebar({
  items,
  defaultItems = [],
  onItemsChange,
  onMove,
  onMoveError,
  onRename,
  activeId,
  defaultActiveId = null,
  onActiveChange,
  defaultExpandedIds = [],
  expandedIds: expandedIdsProp,
  onExpandedIdsChange,
  renderLabel,
  renderRow,
  canRename,
  hasMenu,
  menuClassName,
  menuHeight = ROW_MENU_HEIGHT,
  labels,
  allowNesting = true,
  canDrag,
  canMove,
  renderIcon,
  renderMenu,
  renderActions,
  ariaLabel = "Resources",
  className,
}: AISidebarProps) {
  const [internalItems, setInternalItems] = useState(items ?? defaultItems);
  const [internalActiveId, setInternalActiveId] = useState(defaultActiveId);
  const [internalExpandedIds, setInternalExpandedIds] = useState(
    () => new Set(defaultExpandedIds),
  );
  // local patch (pi-app): controlled expansion survives new sections and list refreshes.
  const expandedIds = useMemo(() => expandedIdsProp ? new Set(expandedIdsProp) : internalExpandedIds, [expandedIdsProp, internalExpandedIds]);
  const setExpandedIds = useCallback((update: (current: Set<string>) => Set<string>) => {
    const next = update(expandedIds);
    if (expandedIdsProp === undefined) setInternalExpandedIds(next);
    onExpandedIdsChange?.([...next]);
  }, [expandedIds, expandedIdsProp, onExpandedIdsChange]);
  const [focusedId, setFocusedId] = useState<string | null>(
    activeId ?? defaultActiveId,
  );
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const movePendingRef = useRef(false);
  const renderedItems = internalItems;
  const selectedId = activeId ?? internalActiveId;

  useEffect(() => {
    if (items) setInternalItems(items);
  }, [items]);

  const flat = useMemo(
    () => flattenResources(renderedItems, expandedIds),
    [expandedIds, renderedItems],
  );

  // Which row carries the roving tabindex is resolved during render, never in
  // a passive effect: an effect lands after the browser paints, so the first
  // commit — and, on a server-rendered page, the markup itself — would have no
  // tabbable row and Tab would skip the whole tree. The same hole opens again
  // whenever a collapse or a rolled-back move takes the focused row out of it.
  const focusedRow =
    focusedId !== null && flat.some((row) => row.item.id === focusedId)
      ? focusedId
      : (flat[0]?.item.id ?? null);
  if (focusedId !== focusedRow) setFocusedId(focusedRow);

  useEffect(() => {
    if (!menuOpenId) return;
    const frame = requestAnimationFrame(() => {
      const menus = Array.from(
        document.querySelectorAll<HTMLElement>("[data-sidebar-resource-menu]"),
      );
      menus
        .find((menu) => menu.dataset.sidebarResourceMenu === menuOpenId)
        ?.querySelector<HTMLElement>("button, a[href]")
        ?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [menuOpenId]);

  const updateItems = useCallback(
    (next: SidebarResource[]) => {
      setInternalItems(next);
      onItemsChange?.(next);
    },
    [onItemsChange],
  );

  const performMove = useCallback(
    async (move: SidebarResourceMove) => {
      // local patch (pi-app): never reparent the optimistic tree on rejection.
      if (canMove && !canMove(move)) return;
      if (movePendingRef.current) {
        setAnnouncement(labels?.movePending ?? "Wait for the current move to finish.");
        return;
      }
      const before = renderedItems;
      const next = moveResource(before, move);
      if (!next || next === before) return;

      movePendingRef.current = true;
      updateItems(next);
      setDropTarget(null);
      setDraggingId(null);
      const moved = findResource(before, move.itemId);
      const target = move.targetId ? findResource(before, move.targetId) : null;
      setAnnouncement(
        labels && target ? labels.moved(moved?.label ?? move.itemId, target.label, move.position) : target
          ? `Moved ${moved?.label ?? "item"} ${move.position} ${target.label}.`
          : `Moved ${moved?.label ?? "item"} to the top level.`,
      );

      try {
        await onMove?.(move);
      } catch (error) {
        updateItems(before);
        setAnnouncement(labels?.moveFailed(moved?.label ?? move.itemId) ?? `Move failed. ${moved?.label ?? "Item"} was restored.`);
        onMoveError?.(error, move);
      } finally {
        movePendingRef.current = false;
      }
    },
    [canMove, onMove, onMoveError, renderedItems, updateItems, labels],
  );

  const focusRow = useCallback((id: string) => {
    setFocusedId(id);
    requestAnimationFrame(() => rowRefs.current.get(id)?.focus());
  }, []);

  const select = useCallback(
    (id: string) => {
      if (activeId === undefined) setInternalActiveId(id);
      onActiveChange?.(id);
    },
    [activeId, onActiveChange],
  );

  const toggle = useCallback((id: string) => {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, [setExpandedIds]);

  // The same four moves `Alt+Shift+Arrow` performs, handed to the row menu so
  // they survive on a device with no drag and no modifier keys.
  const moveCommands = useCallback(
    (row: FlatResource): SidebarResourceMoveCommands => {
      if (row.item.disabled) return {};
      // local patch (pi-app): fixed-membership lists move among siblings even
      // when a neighbouring section is expanded, without crossing its children.
      const peers = allowNesting ? flat : flat.filter((entry) => entry.parentId === row.parentId);
      const index = peers.findIndex(({ item }) => item.id === row.item.id);
      const previous = peers[index - 1];
      const next = peers[index + 1];
      const parentId = row.parentId;
      const commands: SidebarResourceMoveCommands = {};

      if (previous) {
        commands.up = () =>
          void performMove({
            itemId: row.item.id,
            targetId: previous.item.id,
            position: "before",
          });
      }
      if (next) {
        commands.down = () =>
          void performMove({
            itemId: row.item.id,
            targetId: next.item.id,
            position: "after",
          });
      }
      // Only offer the reparent when it lands somewhere new — the row above a
      // folder's first child is the folder it already lives in.
      if (
        allowNesting &&
        previous &&
        canContain(previous.item) &&
        previous.item.id !== parentId
      ) {
        commands.into = {
          label: previous.item.label,
          run: () => {
            setExpandedIds((current) => new Set(current).add(previous.item.id));
            void performMove({
              itemId: row.item.id,
              targetId: previous.item.id,
              position: "inside",
            });
          },
        };
      }
      if (parentId) {
        commands.out = () =>
          void performMove({
            itemId: row.item.id,
            targetId: parentId,
            position: "after",
          });
      }

      // local patch (pi-app): hide forbidden commands, not just their effects.
      if (canMove) {
        if (previous && !canMove({ itemId: row.item.id, targetId: previous.item.id, position: "before" })) delete commands.up;
        if (next && !canMove({ itemId: row.item.id, targetId: next.item.id, position: "after" })) delete commands.down;
        if (previous && !canMove({ itemId: row.item.id, targetId: previous.item.id, position: "inside" })) delete commands.into;
        if (parentId && !canMove({ itemId: row.item.id, targetId: parentId, position: "after" })) delete commands.out;
      }
      return commands;
    },
    [allowNesting, canMove, flat, performMove, setExpandedIds],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>, row: FlatResource) => {
      const index = flat.findIndex(({ item }) => item.id === row.item.id);
      const previous = flat[index - 1];
      const next = flat[index + 1];
      const moveModifier = event.altKey && event.shiftKey;

      if (event.key === "ArrowDown" && !moveModifier && next) {
        event.preventDefault();
        focusRow(next.item.id);
        return;
      }
      if (event.key === "ArrowUp" && !moveModifier && previous) {
        event.preventDefault();
        focusRow(previous.item.id);
        return;
      }
      if (event.key === "Home" && flat[0]) {
        event.preventDefault();
        focusRow(flat[0].item.id);
        return;
      }
      if (event.key === "End" && flat.at(-1)) {
        event.preventDefault();
        focusRow(flat.at(-1)?.item.id ?? row.item.id);
        return;
      }

      if (row.item.disabled) {
        if (event.key === "ArrowLeft" && row.parentId) {
          event.preventDefault();
          focusRow(row.parentId);
        } else if (
          moveModifier ||
          ["ArrowRight", "Enter", " ", "F2", "ContextMenu"].includes(
            event.key,
          ) ||
          (event.shiftKey && event.key === "F10")
        ) {
          event.preventDefault();
        }
        return;
      }

      if (moveModifier && event.key === "ArrowUp") {
        event.preventDefault();
        moveCommands(row).up?.();
        return;
      }
      if (moveModifier && event.key === "ArrowDown") {
        event.preventDefault();
        moveCommands(row).down?.();
        return;
      }
      if (
        moveModifier &&
        event.key === "ArrowRight" &&
        allowNesting &&
        previous &&
        canContain(previous.item)
      ) {
        event.preventDefault();
        setExpandedIds((current) => new Set(current).add(previous.item.id));
        void performMove({ itemId: row.item.id, targetId: previous.item.id, position: "inside" });
        return;
      }
      if (moveModifier && event.key === "ArrowLeft" && row.parentId) {
        event.preventDefault();
        void performMove({ itemId: row.item.id, targetId: row.parentId, position: "after" });
        return;
      }

      if (event.key === "ArrowRight" && canContain(row.item)) {
        event.preventDefault();
        if (!expandedIds.has(row.item.id)) toggle(row.item.id);
        else if (next?.parentId === row.item.id) focusRow(next.item.id);
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        if (expandedIds.has(row.item.id)) toggle(row.item.id);
        else if (row.parentId) focusRow(row.parentId);
      } else if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        if (canContain(row.item)) toggle(row.item.id);
        else select(row.item.id);
      } else if (event.key === "F2") {
        event.preventDefault();
        if (canRename?.(row.item) ?? true) setRenamingId(row.item.id);
      } else if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
        event.preventDefault();
        if (hasMenu?.(row.item) ?? true) setMenuOpenId(row.item.id);
      }
    },
    [allowNesting, expandedIds, flat, focusRow, performMove, select, toggle, canRename, hasMenu, setExpandedIds, moveCommands],
  );

  // local patch (pi-app): omit the root drop affordance when membership is fixed.
  const canDropAtRoot = !!draggingId && (!canMove || canMove({ itemId: draggingId, targetId: null, position: "after" }));

  return (
    <>
      <div
      role="tree"
      aria-label={ariaLabel}
      aria-multiselectable="false"
      onDragOver={(event) => {
        if (!draggingId || event.target !== event.currentTarget) return;
        if (!canDropAtRoot) {
          setDropTarget(null);
          event.dataTransfer.dropEffect = "none";
          return;
        }
        event.preventDefault();
        setDropTarget({ id: null, position: "after" });
      }}
      onDrop={(event) => {
        event.preventDefault();
        if (draggingId && dropTarget?.id === null && canDropAtRoot) {
          void performMove({
            itemId: draggingId,
            targetId: dropTarget.id,
            position: dropTarget.position,
          });
        }
      }}
      className={cn(
        "relative flex min-w-0 flex-col gap-0.5 [overflow-anchor:none] group-data-[state=collapsed]/sidebar:hidden",
        draggingId && "select-none",
        canDropAtRoot && "pb-9",
        className,
      )}
    >
      <AnimatePresence initial={false}>
        {flat.map((row) => (
          <ResourceRow
            key={row.item.id}
            row={row}
            draggable={canDrag?.(row.item) ?? true}
            renameable={canRename?.(row.item) ?? true}
            hasMenu={hasMenu?.(row.item) ?? true}
            active={selectedId === row.item.id}
            expanded={expandedIds.has(row.item.id)}
            focused={focusedRow === row.item.id}
            draggingId={draggingId}
            dropTarget={dropTarget}
            menuOpen={menuOpenId === row.item.id}
            moves={moveCommands(row)}
            renaming={renamingId === row.item.id}
            onFocus={() => setFocusedId(row.item.id)}
            onSelect={() => select(row.item.id)}
            onToggle={() => toggle(row.item.id)}
            onKeyDown={(event) => handleKeyDown(event, row)}
            onRenameStart={() => setRenamingId(row.item.id)}
            onRenameCancel={() => setRenamingId(null)}
            onRenameCommit={(label) => {
              const trimmed = label.trim();
              setRenamingId(null);
              if (!trimmed || trimmed === row.item.label) return;
              const before = renderedItems;
              updateItems(renameResource(before, row.item.id, trimmed));
              void Promise.resolve(onRename?.(row.item, trimmed)).catch(() => {
                updateItems(before);
                setAnnouncement(labels?.renameFailed(row.item.label) ?? `Rename failed. ${row.item.label} was restored.`);
              });
            }}
            onMenuOpenChange={(open) => {
              setMenuOpenId(open ? row.item.id : null);
              if (!open) focusRow(row.item.id);
            }}
            onDragStart={(event, id) => {
              setDraggingId(id);
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData("text/plain", id);
            }}
            onDragEnd={() => {
              setDraggingId(null);
              setDropTarget(null);
            }}
            onDragOver={(event, targetRow) => {
              // local patch (pi-app): invalid targets clear any previous marker;
              // otherwise dropping on a project can execute an earlier valid move.
              event.stopPropagation();
              setDropTarget(null);
              event.dataTransfer.dropEffect = "none";
              if (!draggingId || draggingId === targetRow.item.id) return;
              const source = findResource(renderedItems, draggingId);
              if (source && containsResource(source, targetRow.item.id)) return;
              const rect = event.currentTarget.getBoundingClientRect();
              const ratio = (event.clientY - rect.top) / rect.height;
              const position =
                allowNesting &&
                !targetRow.item.disabled &&
                canContain(targetRow.item) &&
                ratio >= 0.25 &&
                ratio <= 0.75
                  ? "inside"
                  : ratio < 0.5
                    ? "before"
                    : "after";
              if (canMove && !canMove({ itemId: draggingId, targetId: targetRow.item.id, position })) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
              setDropTarget({ id: targetRow.item.id, position });
            }}
            onDrop={(event) => {
              event.preventDefault();
              event.stopPropagation();
              if (draggingId && dropTarget && dropTarget.id === row.item.id) {
                void performMove({
                  itemId: draggingId,
                  targetId: dropTarget.id,
                  position: dropTarget.position,
                });
              }
            }}
            renderIcon={renderIcon}
            renderMenu={renderMenu}
            renderActions={renderActions}
            renderLabel={renderLabel}
            renderRow={renderRow}
            labels={labels}
            menuClassName={menuClassName}
            menuHeight={menuHeight}
            setRef={(node) => {
              if (node) rowRefs.current.set(row.item.id, node);
              else rowRefs.current.delete(row.item.id);
            }}
          />
        ))}
      </AnimatePresence>

      {canDropAtRoot ? (
        <div
          aria-hidden="true"
          data-active={dropTarget?.id === null || undefined}
          className="absolute inset-x-1 bottom-0 flex h-8 items-center justify-center rounded-lg border border-dashed border-border text-micro text-muted-foreground data-[active=true]:border-primary/50 data-[active=true]:bg-primary/10 data-[active=true]:text-foreground"
        >
          Move to top level
        </div>
      ) : null}

      </div>
      <span className="sr-only" aria-live="polite">
        {announcement}
      </span>
    </>
  );
}
