// local patch (pi-app): keep UI frames and focus rings in this component at 1px.
"use client";
// beui.dev/components/motion/file-tree

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
// local patch (pi-app): archive collections reuse this tree with windowed rows.
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
// local patch (pi-app): use the shared UI icon adapter.
import { ChevronRight, FileText as File, Folder, FolderOpen } from "@/lib/icons";
import {
  Children,
  Fragment,
  useCallback,
  isValidElement,
  useMemo,
  useRef,
  useState,
  useLayoutEffect,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { SharedLayoutBg } from "@/components/motion/shared-layout-bg";
import { EASE_OUT, SPRING_LAYOUT, SPRING_SWAP } from "@/lib/ease";
import { cn } from "@/lib/utils";

type FileTreeItem = {
  value: string;
  name: string;
  // local patch (pi-app): app-owned middle ellipsis without losing the full name.
  label?: ReactNode;
  type: "file" | "folder";
  children?: FileTreeItem[];
  icon?: ReactNode;
  disabled?: boolean;
  className?: string;
};

export interface FileTreeFolderProps {
  value: string;
  name: string;
  // local patch (pi-app): presentation slot; name remains the accessible label.
  label?: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
  children?: ReactNode;
  className?: string;
}

export interface FileTreeFileProps {
  value: string;
  name: string;
  // local patch (pi-app): presentation slot; name remains the accessible label.
  label?: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
  className?: string;
}

export type FileTreeClassNames = {
  tree?: string;
  item?: string;
  icon?: string;
  label?: string;
  // local patch (pi-app): match the hover surface to app-level row density.
  pillContainer?: string;
};

export interface FileTreeProps {
  // local patch (pi-app): filesystem navigation restores whole branches at once.
  // Skip row entrance/layout motion while preserving the native tree controls.
  instant?: boolean;
  // local patch (pi-app): keep native tree semantics/keyboard navigation for
  // bounded archive indexes without mounting every expanded row.
  virtualize?: { scrollElement: HTMLElement | null; rowHeight: number; initialOffset?: number };
  children: ReactNode;
  value?: string | null;
  defaultValue?: string | null;
  onValueChange?: (value: string) => void;
  expandedIds?: string[];
  defaultExpandedIds?: string[];
  onExpandedChange?: (expandedIds: string[]) => void;
  ariaLabel?: string;
  indent?: number;
  className?: string;
  classNames?: FileTreeClassNames;
}

type FlatFileTreeItem = {
  item: FileTreeItem;
  depth: number;
  parentId: string | null;
  position: number;
  setSize: number;
};

// These declarative parts are read by FileTree and turned into one flattened,
// keyboard-navigable collection. They intentionally render nothing alone.
export function FileTreeFolder(_props: FileTreeFolderProps) {
  return null;
}

export function FileTreeFile(_props: FileTreeFileProps) {
  return null;
}

const ROW_ENTER = { duration: 0.22, ease: EASE_OUT } as const;
const BRANCH_DRAW = { duration: 0.3, ease: EASE_OUT } as const;

function flattenItems(
  items: FileTreeItem[],
  expanded: ReadonlySet<string>,
  depth = 0,
  parentId: string | null = null,
): FlatFileTreeItem[] {
  return items.flatMap((item, index) => {
    const row = {
      item,
      depth,
      parentId,
      position: index + 1,
      setSize: items.length,
    };

    if (
      item.type !== "folder" ||
      !expanded.has(item.value) ||
      !item.children?.length
    ) {
      return [row];
    }

    return [
      row,
      ...flattenItems(item.children, expanded, depth + 1, item.value),
    ];
  });
}

function itemsFromChildren(children: ReactNode): FileTreeItem[] {
  const items: FileTreeItem[] = [];

  Children.forEach(children, (child) => {
    if (!isValidElement(child)) return;

    if (child.type === Fragment) {
      const props = child.props as { children?: ReactNode };
      items.push(...itemsFromChildren(props.children));
      return;
    }

    if (child.type === FileTreeFolder) {
      const props = child.props as FileTreeFolderProps;
      items.push({
        value: props.value,
        name: props.name,
        // local patch (pi-app): preserve the app's label presentation.
        label: props.label,
        type: "folder",
        icon: props.icon,
        disabled: props.disabled,
        className: props.className,
        children: itemsFromChildren(props.children),
      });
      return;
    }

    if (child.type === FileTreeFile) {
      const props = child.props as FileTreeFileProps;
      items.push({
        value: props.value,
        name: props.name,
        // local patch (pi-app): preserve the app's label presentation.
        label: props.label,
        type: "file",
        icon: props.icon,
        disabled: props.disabled,
        className: props.className,
      });
    }
  });

  return items;
}

function DefaultIcon({
  item,
  open,
  reduce,
}: {
  item: FileTreeItem;
  open: boolean;
  reduce: boolean;
}) {
  if (item.type === "file") return <File className="size-4" />;
  if (reduce) {
    return open ? (
      <FolderOpen className="size-4" />
    ) : (
      <Folder className="size-4" />
    );
  }

  return (
    <AnimatePresence initial={false} mode="popLayout">
      <motion.span
        key={open ? "open" : "closed"}
        initial={{ opacity: 0, scale: 0.75, rotate: open ? -8 : 8 }}
        animate={{ opacity: 1, scale: 1, rotate: 0 }}
        exit={{ opacity: 0, scale: 0.75, rotate: open ? 8 : -8 }}
        transition={SPRING_SWAP}
        className="absolute inset-0 grid place-items-center"
      >
        {open ? (
          <FolderOpen className="size-4" />
        ) : (
          <Folder className="size-4" />
        )}
      </motion.span>
    </AnimatePresence>
  );
}

export function FileTree({
  instant = false,
  virtualize,
  children,
  value,
  defaultValue = null,
  onValueChange,
  expandedIds,
  defaultExpandedIds = [],
  onExpandedChange,
  ariaLabel = "Files",
  indent = 18,
  className,
  classNames,
}: FileTreeProps) {
  // local patch (pi-app): virtual positions are explicit, never animated.
  instant = instant || !!virtualize;
  // local patch (pi-app): automatic path reveals must not replay row springs.
  const reducedMotion = useReducedMotion() ?? false;
  const reduce = reducedMotion || instant;
  const [internalValue, setInternalValue] = useState(defaultValue);
  const [internalExpandedIds, setInternalExpandedIds] = useState(
    defaultExpandedIds,
  );
  const [focusedId, setFocusedId] = useState<string | null>(
    value ?? defaultValue,
  );
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  // local patch (pi-app): a selection change should update two rows, not rebuild
  // hundreds of SVG/motion subtrees. Keep only the currently visible collection.
  const renderedRows = useRef(new Map<string, {
    row: FlatFileTreeItem; open: boolean; selected: boolean; focused: boolean;
    reduce: boolean; instant: boolean; indent: number; classes: FileTreeClassNames | undefined;
    offset?: number; height?: number;
    element: ReactElement;
  }>());
  const selectedId = value === undefined ? internalValue : value;
  const currentExpandedIds = expandedIds ?? internalExpandedIds;
  const expanded = useMemo(
    () => new Set(currentExpandedIds),
    [currentExpandedIds],
  );
  const items = useMemo(() => itemsFromChildren(children), [children]);
  const rows = useMemo(() => flattenItems(items, expanded), [expanded, items]);

  // local patch (pi-app): a persistent tree follows external file-tab selection
  // once its lazily loaded row exists, without stealing actual DOM focus.
  const previousSelection = useRef(selectedId);
  const focusOnReveal = useRef(selectedId);
  if (previousSelection.current !== selectedId) {
    previousSelection.current = selectedId;
    focusOnReveal.current = selectedId;
  }
  const revealedFocus = focusOnReveal.current !== null && rows.some(({ item }) => item.value === focusOnReveal.current)
    ? focusOnReveal.current : null;
  if (revealedFocus !== null) focusOnReveal.current = null;

  // Keep a real row tabbable in the first commit and immediately after a
  // collapse removes the previously focused descendant.
  const focusedRow = revealedFocus ?? (
    focusedId !== null && rows.some(({ item }) => item.value === focusedId)
      ? focusedId
      : (rows[0]?.item.value ?? null));
  if (focusedId !== focusedRow) setFocusedId(focusedRow);

  // local patch (pi-app): retain the roving-focus row even outside the window;
  // keyboard moves scroll to the destination before focusing its mounted row.
  const focusedIndex = rows.findIndex(({ item }) => item.value === focusedRow);
  const virtualizer = useVirtualizer({
    enabled: !!virtualize,
    count: rows.length,
    getScrollElement: () => virtualize?.scrollElement ?? null,
    getItemKey: index => rows[index].item.value,
    estimateSize: () => virtualize?.rowHeight ?? 36,
    initialOffset: virtualize?.initialOffset ?? 0,
    overscan: 8,
    rangeExtractor: range => {
      const indices = defaultRangeExtractor(range);
      if (focusedIndex >= 0 && !indices.includes(focusedIndex)) indices.push(focusedIndex);
      return indices.sort((a, b) => a - b);
    },
  });
  const pendingFocus = useRef<string | null>(null);
  const focusRow = useCallback((id: string) => {
    setFocusedId(id);
    pendingFocus.current = id;
    if (virtualize) virtualizer.scrollToIndex(rows.findIndex(({ item }) => item.value === id), { align: "auto" });
    const row = rowRefs.current.get(id);
    if (row) { pendingFocus.current = null; row.focus({ preventScroll: !!virtualize }); }
  }, [rows, virtualize, virtualizer]);
  useLayoutEffect(() => {
    if (!pendingFocus.current) return;
    const row = rowRefs.current.get(pendingFocus.current);
    if (row) { pendingFocus.current = null; row.focus({ preventScroll: !!virtualize }); }
  });

  const selectItem = useCallback(
    (item: FileTreeItem) => {
      if (item.disabled) return;
      if (value === undefined) setInternalValue(item.value);
      onValueChange?.(item.value);
    },
    [onValueChange, value],
  );

  const setExpanded = useCallback(
    (next: string[]) => {
      if (expandedIds === undefined) setInternalExpandedIds(next);
      onExpandedChange?.(next);
    },
    [expandedIds, onExpandedChange],
  );

  const toggleFolder = useCallback(
    (id: string) => {
      const next = new Set(currentExpandedIds);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      setExpanded(Array.from(next));
    },
    [currentExpandedIds, setExpanded],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>, row: FlatFileTreeItem) => {
      const index = rows.findIndex(({ item }) => item.value === row.item.value);
      const previous = rows[index - 1];
      const next = rows[index + 1];
      const isFolder = row.item.type === "folder";
      const isOpen = expanded.has(row.item.value);

      if (event.key === "ArrowDown" && next) {
        event.preventDefault();
        focusRow(next.item.value);
      } else if (event.key === "ArrowUp" && previous) {
        event.preventDefault();
        focusRow(previous.item.value);
      } else if (event.key === "Home" && rows[0]) {
        event.preventDefault();
        focusRow(rows[0].item.value);
      } else if (event.key === "End" && rows.at(-1)) {
        event.preventDefault();
        focusRow(rows.at(-1)?.item.value ?? row.item.value);
      } else if (event.key === "ArrowRight" && isFolder) {
        event.preventDefault();
        if (!isOpen && !row.item.disabled) toggleFolder(row.item.value);
        else if (next?.parentId === row.item.value) focusRow(next.item.value);
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        if (isFolder && isOpen && !row.item.disabled)
          toggleFolder(row.item.value);
        else if (row.parentId) focusRow(row.parentId);
      } else if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        if (row.item.disabled) return;
        selectItem(row.item);
        if (isFolder) toggleFolder(row.item.value);
      }
    },
    [expanded, focusRow, rows, selectItem, toggleFolder],
  );

  // local patch (pi-app): reused rows delegate to current handlers, so keyboard
  // neighbours and controlled selection never retain an older tree snapshot.
  const handlers = useRef({ handleKeyDown, selectItem, toggleFolder });
  handlers.current = { handleKeyDown, selectItem, toggleFolder };
  // local patch (pi-app): instant collections use the row's own hover fill.
  // A shared layout pill can jump between transformed virtual rows and replay
  // an exit over a row that the pointer already left.
  const Collection = instant ? "div" : SharedLayoutBg;
  const Row = instant ? "div" : motion.div;
  const Branch = instant ? "span" : motion.span;
  const Chevron = instant ? "span" : motion.span;
  // local patch (pi-app): cache mounted rows only, including the focus anchor.
  const visibleRows = virtualize
    ? virtualizer.getVirtualItems().map(item => ({ row: rows[item.index], offset: item.start, height: item.size }))
    : rows.map(row => ({ row, offset: undefined, height: undefined }));
  const visibleIds = new Set(visibleRows.map(({ row }) => row.item.value));
  for (const id of renderedRows.current.keys()) if (!visibleIds.has(id)) renderedRows.current.delete(id);

  return (
    <Collection
      role="tree"
      aria-label={ariaLabel}
      aria-multiselectable="false"
      {...(instant ? {} : {
        inset: 0,
        pillClassName: "rounded-xl bg-muted",
        pillContainerClassName: cn("inset-y-auto top-0 h-9", classNames?.pillContainer),
      })}
      className={cn("flex w-full min-w-0 flex-col", className, classNames?.tree)}
      // local patch (pi-app): provide one full-height canvas for the scrollport.
      style={virtualize ? { position: "relative", height: virtualizer.getTotalSize() } : undefined}
    >
      {visibleRows.map(({ row, offset, height }) => {
          const isFolder = row.item.type === "folder";
          const isOpen = isFolder && expanded.has(row.item.value);
          const isSelected = selectedId === row.item.value;
          const isFocused = focusedRow === row.item.value;
          const cached = renderedRows.current.get(row.item.value);
          if (cached && cached.row === row && cached.open === isOpen && cached.selected === isSelected && cached.focused === isFocused && cached.reduce === reduce && cached.instant === instant && cached.indent === indent && cached.classes === classNames && cached.offset === offset && cached.height === height) return cached.element;

          const element = (
            <Row
              key={row.item.value}
              {...(instant ? { style: { opacity: row.item.disabled ? 0.42 : 1, ...(offset === undefined ? {} : { position: "absolute" as const, top: 0, left: 0, width: "100%", height, transform: `translateY(${offset}px)` }) } } : {
                layout: reduce ? false : "position" as const,
                initial: reduce ? false : { opacity: 0, y: -6 },
                animate: {
                  opacity: row.item.disabled ? 0.42 : 1, y: 0,
                  transition: reduce ? { duration: 0 } : { ...ROW_ENTER, delay: Math.min(row.position * 0.025, 0.1) },
                },
                transition: reduce ? { duration: 0 } : SPRING_LAYOUT,
              })}
            >
              <button
                ref={(node) => {
                  if (node) rowRefs.current.set(row.item.value, node);
                  else rowRefs.current.delete(row.item.value);
                }}
                type="button"
                role="treeitem"
                // local patch (pi-app): the app resolves a right-clicked row to
                // its path from the DOM, so the row must carry its value.
                data-tree-value={row.item.value}
                // local patch (pi-app): elided labels retain their full name.
                aria-label={row.item.name}
                aria-level={row.depth + 1}
                aria-posinset={row.position}
                aria-setsize={row.setSize}
                aria-selected={isSelected}
                aria-expanded={isFolder ? isOpen : undefined}
                aria-disabled={row.item.disabled || undefined}
                tabIndex={isFocused ? 0 : -1}
                onFocus={() => setFocusedId(row.item.value)}
                onKeyDown={(event) => handlers.current.handleKeyDown(event, row)}
                onClick={() => {
                  if (row.item.disabled) return;
                  handlers.current.selectItem(row.item);
                  if (isFolder) handlers.current.toggleFolder(row.item.value);
                }}
                className={cn(
                  "group/file-tree relative flex h-9 w-full items-center gap-2 overflow-hidden rounded-lg pr-2 text-left text-sm text-muted-foreground outline-none",
                  // local patch (pi-app): stable navigation rows share ordinary
                  // controls' CSS colour transition, without a moving overlay.
                  "transition-colors hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset",
                  instant && "hover:bg-muted",
                  "aria-disabled:cursor-not-allowed",
                  isSelected && "bg-muted font-medium text-foreground",
                  classNames?.item,
                  row.item.className,
                )}
                style={{ paddingLeft: 8 + row.depth * indent }}
              >
                {row.depth > 0 ? (
                  <Branch
                    aria-hidden="true"
                    {...(instant ? {} : {
                      initial: reduce ? false : { opacity: 0, scaleY: 0 },
                      animate: { opacity: 1, scaleY: 1 },
                      exit: { opacity: 0, scaleY: 0 },
                      transition: reduce ? { duration: 0 } : BRANCH_DRAW,
                    })}
                    className="absolute top-0 bottom-0 w-px origin-top bg-border/70"
                    style={{ left: 16 + (row.depth - 1) * indent }}
                  />
                ) : null}

                <Chevron
                  aria-hidden="true"
                  {...(instant ? { style: { transform: isOpen ? "rotate(90deg)" : undefined } } : {
                    animate: { rotate: isOpen ? 90 : 0 },
                    transition: reduce ? { duration: 0 } : SPRING_SWAP,
                  })}
                  className={cn(
                    "relative z-10 grid size-4 shrink-0 place-items-center",
                    !isFolder && "opacity-0",
                  )}
                >
                  {isFolder ? <ChevronRight className="size-3.5" /> : null}
                </Chevron>

                <span
                  aria-hidden="true"
                  className={cn(
                    "relative z-10 grid size-4 shrink-0 place-items-center text-muted-foreground transition-colors group-hover/file-tree:text-foreground",
                    isFolder && isOpen && "text-foreground",
                    classNames?.icon,
                  )}
                >
                  {row.item.icon ?? (
                    <DefaultIcon
                      item={row.item}
                      open={isOpen}
                      reduce={reduce}
                    />
                  )}
                </span>

                <span
                  className={cn(
                    "relative z-10 min-w-0 flex-1 truncate",
                    classNames?.label,
                  )}
                >
                  {/* local patch (pi-app): keep label layout outside the primitive. */}
                  {row.item.label ?? row.item.name}
                </span>
              </button>
            </Row>
          );
          renderedRows.current.set(row.item.value, { row, open: isOpen, selected: isSelected, focused: isFocused, reduce, instant, indent, classes: classNames, offset, height, element });
          return element;
        })}
    </Collection>
  );
}
