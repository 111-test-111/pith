// local patch (pi-app): shared scalable typography for UI line metrics.
// local patch (pi-app): use the shared Hugeicons icon adapter.
"use client";
// beui.dev/components/blocks/infinite-masonry

import { useVirtualizer } from "@tanstack/react-virtual";
import { AlertCircle, Inbox } from "@/lib/icons";
import { motion, useReducedMotion } from "motion/react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
} from "react";
import { EASE_OUT, SPRING_PANEL } from "@/lib/ease";
import { cn } from "@/lib/utils";
// local patch (pi-app): shared controls, caller-localized labels and edge fades.
import { Button } from "@/components/motion/button";
import { useScrollFade } from "@/lib/hooks/use-scroll-fade";

export type InfiniteMasonryKey = string | number | bigint;

export interface InfiniteMasonryProps<T> {
  items: readonly T[];
  getItemKey: (item: T, index: number) => InfiniteMasonryKey;
  renderItem: (item: T, index: number, columnWidth: number) => ReactNode;
  onLoadMore: () => void | Promise<void>;
  hasMore: boolean;
  loading?: boolean;
  error?: ReactNode;
  onRetry?: () => void;
  estimateSize?: (item: T, index: number) => number;
  /** local patch (pi-app): a caller with reserved geometry can supply exact
   * heights. Image decoding then cannot rewrite lanes or scroll offsets. */
  itemSize?: (item: T, index: number, columnWidth: number) => number;
  /** local patch (pi-app): null keeps snapshots visible without placeholder rows. */
  renderLoadingItem?: ((index: number) => ReactNode) | null;
  emptyState?: ReactNode;
  endState?: ReactNode;
  minColumnWidth?: number;
  maxColumns?: number;
  gap?: number;
  overscan?: number;
  prefetch?: number;
  animateItems?: boolean;
  ariaLabel?: string;
  loadingLabel?: string;
  errorLabel?: string;
  retryLabel?: string;
  className?: string;
  contentClassName?: string;
  itemClassName?: string;
}

type MasonryMetrics = {
  columns: number;
  width: number;
};

function useMasonryMetrics({
  elementRef,
  gap,
  maxColumns,
  minColumnWidth,
}: {
  elementRef: React.RefObject<HTMLDivElement | null>;
  gap: number;
  maxColumns: number;
  minColumnWidth: number;
}) {
  const [metrics, setMetrics] = useState<MasonryMetrics>({
    columns: 1,
    width: 0,
  });

  // local patch (pi-app): reserve the right lanes before a newly mounted tab paints.
  useLayoutEffect(() => {
    const element = elementRef.current;
    if (!element) return;

    const update = (width: number) => {
      const columns = Math.min(
        maxColumns,
        Math.max(1, Math.floor((width + gap) / (minColumnWidth + gap))),
      );

      setMetrics((current) =>
        current.columns === columns && current.width === width
          ? current
          : { columns, width },
      );
    };

    update(element.getBoundingClientRect().width);

    const observer = new ResizeObserver(([entry]) => {
      update(entry.contentRect.width);
    });
    observer.observe(element);

    return () => observer.disconnect();
  }, [elementRef, gap, maxColumns, minColumnWidth]);

  return metrics;
}

function DefaultLoadingItem({ index }: { index: number }) {
  return (
    <div
      aria-hidden="true"
      className="animate-pulse rounded-item border border-border bg-card p-3"
      style={{ minHeight: 144 + (index % 3) * 36 }}
    >
      <div className="h-3 w-2/3 rounded-full bg-muted" />
      <div className="mt-3 h-2 w-full rounded-full bg-muted" />
      <div className="mt-2 h-2 w-4/5 rounded-full bg-muted" />
    </div>
  );
}

function DefaultEmptyState() {
  return (
    <div className="flex h-full min-h-64 flex-col items-center justify-center px-6 text-center">
      <Inbox className="size-8 text-muted-foreground" aria-hidden="true" />
      <p className="mt-3 text-sm font-medium text-foreground">No items yet</p>
      <p className="mt-1 max-w-xs text-xs leading-ui text-muted-foreground">
        New items will appear here when they become available.
      </p>
    </div>
  );
}

function MasonryItemReveal({
  itemKey,
  lane,
  revealedKeys,
  animate,
  children,
}: {
  itemKey: InfiniteMasonryKey;
  lane: number;
  revealedKeys: MutableRefObject<Set<InfiniteMasonryKey>>;
  animate: boolean;
  children: ReactNode;
}) {
  const [shouldReveal] = useState(
    () => animate && !revealedKeys.current.has(itemKey),
  );

  useEffect(() => {
    revealedKeys.current.add(itemKey);
  }, [itemKey, revealedKeys]);

  const delay = Math.min(lane, 3) * 0.04;

  return (
    <motion.div
      initial={shouldReveal ? { opacity: 0, y: 12 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={{
        y: { ...SPRING_PANEL, delay },
        opacity: { duration: 0.2, ease: EASE_OUT, delay },
      }}
    >
      {children}
    </motion.div>
  );
}

export function InfiniteMasonry<T>({
  items,
  getItemKey,
  renderItem,
  onLoadMore,
  hasMore,
  loading = false,
  error,
  onRetry,
  estimateSize = () => 240,
  itemSize,
  renderLoadingItem = (index) => <DefaultLoadingItem index={index} />,
  emptyState = <DefaultEmptyState />,
  endState,
  minColumnWidth = 208,
  maxColumns = 4,
  gap = 12,
  overscan = 4,
  prefetch = 3,
  animateItems = true,
  ariaLabel = "Infinite masonry feed",
  loadingLabel = "Loading more items",
  errorLabel = "Couldn't load more",
  retryLabel = "Try again",
  className,
  contentClassName,
  itemClassName,
}: InfiniteMasonryProps<T>) {
  const reduceMotion = useReducedMotion();
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const { maskImage } = useScrollFade(scrollRef, { contentRef });
  const loadMoreRef = useRef(onLoadMore);
  const loadPendingRef = useRef(false);
  const initialItemCountRef = useRef(items.length);
  const revealedKeysRef = useRef(new Set<InfiniteMasonryKey>());
  const { columns, width } = useMasonryMetrics({
    elementRef: contentRef,
    gap,
    maxColumns,
    minColumnWidth,
  });

  useEffect(() => {
    loadMoreRef.current = onLoadMore;
  }, [onLoadMore]);

  useEffect(() => {
    if (!loading) loadPendingRef.current = false;
  }, [loading]);

  const hasError = error !== undefined && error !== null;
  const columnWidth = Math.max(0, (width - gap * (columns - 1)) / columns);
  // local patch (pi-app): paging an exact layout appends real cards, without
  // temporary skeleton rows shrinking its scroll range when they disappear.
  const tailCount = hasError ? 1 : loading && renderLoadingItem !== null && (!itemSize || !items.length) ? columns : 0;
  const virtualizer = useVirtualizer({
    count: items.length + tailCount,
    getScrollElement: () => scrollRef.current,
    getItemKey: (index) =>
      index < items.length
        ? getItemKey(items[index], index)
        : `masonry-tail-${index - items.length}`,
    estimateSize: (index) =>
      index < items.length
        ? itemSize?.(items[index], index, columnWidth) ?? estimateSize(items[index], index)
        : 144 + ((index - items.length) % 3) * 36,
    gap,
    lanes: columns,
    overscan: overscan * columns,
    enabled: width > 0,
  });
  // local patch (pi-app): only a real width change invalidates known geometry.
  // Resize reflows existing data without remounting or fetching new pages.
  const previousWidth = useRef(columnWidth);
  useLayoutEffect(() => {
    if (itemSize && previousWidth.current !== columnWidth) virtualizer.measure();
    previousWidth.current = columnWidth;
  }, [columnWidth, !!itemSize, virtualizer]);

  const virtualItems = virtualizer.getVirtualItems();
  const viewportEnd =
    (virtualizer.scrollOffset ?? 0) + (virtualizer.scrollRect?.height ?? 0);
  const lastVisibleIndex = virtualItems.reduce(
    (lastIndex, item) =>
      item.start < viewportEnd ? Math.max(lastIndex, item.index) : lastIndex,
    -1,
  );

  useEffect(() => {
    if (
      hasError ||
      loading ||
      !hasMore ||
      loadPendingRef.current ||
      lastVisibleIndex < Math.max(0, items.length - prefetch)
    ) {
      return;
    }

    loadPendingRef.current = true;
    void Promise.resolve(loadMoreRef.current()).finally(() => {
      loadPendingRef.current = false;
    });
  }, [hasError, hasMore, items.length, lastVisibleIndex, loading, prefetch]);

  // local patch (pi-app): keep measured refs mounted through the initial empty
  // state. Otherwise the first asynchronous page permanently has width zero.
  const empty = items.length === 0 && !hasMore && (!loading || renderLoadingItem === null) && !hasError;

  return (
    <section
      ref={scrollRef}
      aria-label={ariaLabel}
      aria-busy={loading}
      style={{ maskImage, WebkitMaskImage: maskImage }}
      className={cn(
        "w-full contain-[layout_paint] overflow-y-auto overscroll-none rounded-panel border border-border bg-background p-3 [overflow-anchor:none]",
        className,
      )}
    >
      {empty ? emptyState : null}
      <div
        ref={contentRef}
        className={cn("relative w-full", contentClassName)}
        style={{ height: virtualizer.getTotalSize() }}
      >
        {virtualItems.map((virtualItem) => {
          const isTail = virtualItem.index >= items.length;
          const tailIndex = virtualItem.index - items.length;

          return (
            <div
              key={virtualItem.key}
              ref={!isTail && itemSize ? undefined : virtualizer.measureElement}
              data-index={virtualItem.index}
              className={cn(
                "absolute left-0 top-0 will-change-transform",
                !isTail && itemClassName,
              )}
              style={{
                width: columnWidth,
                transform: `translate3d(${virtualItem.lane * (columnWidth + gap)}px, ${virtualItem.start}px, 0)`,
              }}
            >
              {isTail ? (
                hasError ? (
                  <div className="flex min-h-36 flex-col items-start justify-center rounded-item border border-destructive/20 bg-destructive/5 p-4">
                    <div className="flex items-center gap-2 text-destructive">
                      <AlertCircle className="size-4" aria-hidden="true" />
                      <p className="text-sm font-medium">{errorLabel}</p>
                    </div>
                    <div className="mt-2 text-xs leading-ui text-muted-foreground">
                      {error}
                    </div>
                    {onRetry ? (
                      <Button
                        type="button"
                        onClick={onRetry}
                        variant="outline"
                        size="sm"
                        className="mt-3"
                      >
                        {retryLabel}
                      </Button>
                    ) : null}
                  </div>
                ) : (
                  renderLoadingItem?.(tailIndex)
                )
              ) : (
                <MasonryItemReveal
                  itemKey={virtualItem.key}
                  lane={virtualItem.lane}
                  revealedKeys={revealedKeysRef}
                  animate={
                    animateItems &&
                    !reduceMotion &&
                    virtualItem.index >= initialItemCountRef.current
                  }
                >
                  {renderItem(items[virtualItem.index], virtualItem.index, columnWidth)}
                </MasonryItemReveal>
              )}
            </div>
          );
        })}
      </div>

      {!hasMore && items.length > 0 && endState ? (
        <div className="py-4 text-center text-xs text-muted-foreground">
          {endState}
        </div>
      ) : null}
      <span className="sr-only" aria-live="polite">
        {loading ? loadingLabel : null}
      </span>
    </section>
  );
}
