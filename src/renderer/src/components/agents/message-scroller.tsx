// local patch (pi-app): shared scalable typography for UI line metrics.
// local patch (pi-app): keep UI frames and focus rings in this component at 1px.
"use client";
// beui.dev/components/agents/chat-app

import { useReducedMotion } from "motion/react";
import {
  type ComponentPropsWithRef,
  type Ref,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  PreviewRail,
  type PreviewRailItem,
} from "@/components/motion/preview-rail";
import { cn } from "@/lib/utils";

const PREVIEW_TITLE_LENGTH = 56;
const PREVIEW_DESCRIPTION_LENGTH = 88;

function truncateMessageText(text: string, limit: number) {
  if (text.length <= limit) return text;
  const excerpt = text.slice(0, limit);
  const boundary = excerpt.lastIndexOf(" ");
  return `${excerpt.slice(0, boundary > limit * 0.65 ? boundary : limit).trim()}…`;
}

function getMessageText(message: HTMLElement) {
  const surface =
    message.querySelector<HTMLElement>('[data-slot="message-bubble-content"]') ??
    message.querySelector<HTMLElement>('[data-slot="message-content"]') ??
    message;
  return (surface.textContent ?? "").replace(/\s+/g, " ").trim();
}

function getMessagePreview(
  message: HTMLElement,
  assistantResponse?: HTMLElement,
) {
  const text = getMessageText(message);
  if (!text) {
    return { label: "Message", description: undefined };
  }

  if (text.length <= PREVIEW_TITLE_LENGTH) {
    const responseText = assistantResponse
      ? getMessageText(assistantResponse)
      : "";
    return {
      label: text,
      description: responseText
        ? truncateMessageText(responseText, PREVIEW_DESCRIPTION_LENGTH)
        : undefined,
    };
  }

  const titleExcerpt = text.slice(0, PREVIEW_TITLE_LENGTH);
  const titleBoundary = titleExcerpt.lastIndexOf(" ");
  const titleEnd =
    titleBoundary > PREVIEW_TITLE_LENGTH * 0.65
      ? titleBoundary
      : PREVIEW_TITLE_LENGTH;
  const label = `${text.slice(0, titleEnd).trim()}…`;
  const responseText = assistantResponse
    ? getMessageText(assistantResponse)
    : text.slice(titleEnd).trim();
  return {
    label,
    description: responseText
      ? truncateMessageText(responseText, PREVIEW_DESCRIPTION_LENGTH)
      : undefined,
  };
}

export interface MessageScrollerProps extends ComponentPropsWithRef<"div"> {
  /** Keep streamed output pinned while the reader remains near the end. */
  followOutput?: boolean;
  /** Distance from the end that still counts as following the output. */
  followThreshold?: number;
  /** Smoothly follow growing content. */
  smooth?: boolean;
  /** Reports when the reader leaves or returns to the live edge. */
  onFollowChange?: (following: boolean) => void;
  /** Accessible label for the scrollable transcript. */
  label?: string;
  /** Marks the transcript as waiting for more streamed content. */
  busy?: boolean;
  /** Adds a compact rail for navigating between rendered Message rows. */
  navigation?: "rail";
  /** Accessible label for the optional message navigation rail. */
  navigationLabel?: string;
  /**
   * Local extension (pi-app): drive the navigation rail from app data instead
   * of DOM text. Each item is located in the transcript by a
   * `[data-rail-id="<id>"]` attribute on the Message row it navigates to, so
   * the caller controls exactly what a tick is and what its hover preview
   * says (e.g. one tick per user turn, previewed from the message data).
   * Without it, the rail falls back to the stock per-row behavior.
   */
  railItems?: PreviewRailItem[];
  /** local patch (pi-app): changing this resets the viewport to the live edge
   * synchronously before the newly selected transcript is painted. */
  initialScrollKey?: string | null;
  viewportClassName?: string;
  contentClassName?: string;
  railClassName?: string;
  viewportRef?: Ref<HTMLElement>;
  viewportProps?: Omit<
    ComponentPropsWithRef<"section">,
    "children" | "className" | "ref"
  >;
  contentProps?: Omit<
    ComponentPropsWithRef<"div">,
    "children" | "className" | "ref"
  >;
}

export function MessageScroller({
  followOutput = true,
  followThreshold = 56,
  smooth = true,
  onFollowChange,
  label = "Conversation",
  busy,
  navigation,
  navigationLabel = "Message navigation",
  railItems,
  initialScrollKey,
  viewportClassName,
  contentClassName,
  railClassName,
  viewportRef: externalViewportRef,
  viewportProps,
  contentProps,
  className,
  children,
  ...props
}: MessageScrollerProps) {
  const reduce = useReducedMotion() ?? false;
  const viewportRef = useRef<HTMLElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(followOutput);
  const programmaticScrollRef = useRef(false);
  // local patch (pi-app): native anchoring scrolls can precede resize delivery.
  const viewportHeightRef = useRef<number | undefined>(undefined);
  const scrollTimerRef = useRef<number | undefined>(undefined);
  const positionFrameRef = useRef<number | undefined>(undefined);
  const railFrameRef = useRef<number | undefined>(undefined);
  const railIdRef = useRef(new WeakMap<HTMLElement, string>());
  const railIdCounterRef = useRef(0);
  const railTargetsRef = useRef(new Map<string, HTMLElement>());
  const [internalRailItems, setRailItems] = useState<PreviewRailItem[]>([]);
  const [positionedScrollKey, setPositionedScrollKey] = useState(initialScrollKey);
  const [activeRailId, setActiveRailId] = useState("");
  const [railOverflowing, setRailOverflowing] = useState(false);
  const {
    onScroll: onViewportScroll,
    onWheel: onViewportWheel,
    onTouchStart: onViewportTouchStart,
    onKeyDown: onViewportKeyDown,
    ...restViewportProps
  } = viewportProps ?? {};

  const setViewportRef = useCallback(
    (node: HTMLElement | null) => {
      viewportRef.current = node;
      viewportHeightRef.current = node?.clientHeight;
      if (typeof externalViewportRef === "function") {
        externalViewportRef(node);
      } else if (externalViewportRef) {
        externalViewportRef.current = node;
      }
    },
    [externalViewportRef],
  );

  const setFollowing = useCallback(
    (next: boolean) => {
      if (followingRef.current === next) return;
      followingRef.current = next;
      onFollowChange?.(next);
    },
    [onFollowChange],
  );

  const updateActiveRailItem = useCallback(() => {
    if (navigation !== "rail") return;
    const viewport = viewportRef.current;
    const targets = [...railTargetsRef.current.entries()];
    if (!viewport || targets.length === 0) return;

    const viewportRect = viewport.getBoundingClientRect();
    if (viewport.scrollTop <= followThreshold) {
      const firstId = targets[0]?.[0] ?? "";
      setActiveRailId((current) => (current === firstId ? current : firstId));
      return;
    }

    const distanceFromEnd =
      viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    if (distanceFromEnd <= followThreshold) {
      const lastId = targets.at(-1)?.[0] ?? "";
      setActiveRailId((current) => (current === lastId ? current : lastId));
      return;
    }

    const viewportCenter = viewportRect.top + viewportRect.height / 2;
    let nearestId = targets[0]?.[0] ?? "";
    let nearestDistance = Number.POSITIVE_INFINITY;

    for (const [id, element] of targets) {
      const rect = element.getBoundingClientRect();
      const messageCenter = rect.top + rect.height / 2;
      const distance = Math.abs(messageCenter - viewportCenter);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestId = id;
      }
    }

    setActiveRailId((current) =>
      current === nearestId ? current : nearestId,
    );
  }, [followThreshold, navigation]);

  const syncRailItems = useCallback(() => {
    if (navigation !== "rail") return;
    const content = contentRef.current;
    const viewport = viewportRef.current;
    if (!content || !viewport) return;

    // local patch (pi-app): app-driven rail — items arrive as data, rows are
    // located by the caller's data-rail-id instead of derived from DOM text.
    if (railItems) {
      const targets = new Map<string, HTMLElement>();
      const nextItems: PreviewRailItem[] = [];
      // One pass over the rows: a per-item querySelector rescans the whole
      // transcript for every tick, which is quadratic on a long session and
      // runs on every message change.
      const located = new Map<string, HTMLElement>();
      for (const element of content.querySelectorAll<HTMLElement>(
        "[data-rail-id]",
      )) {
        const id = element.dataset.railId;
        // First match wins, like a single querySelector("[data-rail-id=...]")
        if (id && !located.has(id)) located.set(id, element);
      }
      for (const item of railItems) {
        const element = located.get(item.id);
        if (!element) continue;
        targets.set(item.id, element);
        nextItems.push(item);
      }

      railTargetsRef.current = targets;
      setRailItems((current) => {
        const unchanged =
          current.length === nextItems.length &&
          current.every(
            (item, index) =>
              item.id === nextItems[index]?.id &&
              item.label === nextItems[index]?.label &&
              item.description === nextItems[index]?.description &&
              item.ariaLabel === nextItems[index]?.ariaLabel,
          );
        return unchanged ? current : nextItems;
      });
      setRailOverflowing(
        viewport.scrollHeight > viewport.clientHeight + 1 &&
          nextItems.length > 1,
      );
      return;
    }

    // Stock rail: message rows come from the DOM, so the query runs only on
    // this path (the app-driven branch above never needs it).
    const messages = Array.from(
      content.querySelectorAll<HTMLElement>('[data-slot="message"]'),
    );
    const targets = new Map<string, HTMLElement>();
    const nextItems = messages.map((message, index) => {
      let id = railIdRef.current.get(message);
      if (!id) {
        railIdCounterRef.current += 1;
        id = `message-rail-${railIdCounterRef.current}`;
        railIdRef.current.set(message, id);
      }
      targets.set(id, message);
      const sender = message.dataset.from ?? "conversation";
      const assistantResponse =
        sender === "user"
          ? messages
              .slice(index + 1)
              .find((candidate) => candidate.dataset.from === "assistant")
          : undefined;
      const preview = getMessagePreview(message, assistantResponse);

      return {
        id,
        label: preview.label,
        description: preview.description,
        ariaLabel: `Go to ${sender} message ${index + 1} of ${messages.length}`,
      };
    });

    railTargetsRef.current = targets;
    setRailItems((current) => {
      const unchanged =
        current.length === nextItems.length &&
        current.every(
          (item, index) =>
            item.id === nextItems[index]?.id &&
            item.label === nextItems[index]?.label &&
            item.description === nextItems[index]?.description &&
            item.ariaLabel === nextItems[index]?.ariaLabel,
        );
      return unchanged ? current : nextItems;
    });
    setRailOverflowing(
      viewport.scrollHeight > viewport.clientHeight + 1 && messages.length > 1,
    );
  }, [navigation, railItems]);

  const scheduleRailSync = useCallback(() => {
    if (navigation !== "rail") return;
    if (railFrameRef.current) cancelAnimationFrame(railFrameRef.current);
    railFrameRef.current = requestAnimationFrame(() => {
      syncRailItems();
      updateActiveRailItem();
    });
  }, [navigation, syncRailItems, updateActiveRailItem]);

  const scrollToEnd = useCallback((behavior: ScrollBehavior) => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    programmaticScrollRef.current = true;
    if (typeof viewport.scrollTo === "function") {
      viewport.scrollTo({ top: viewport.scrollHeight, behavior });
    } else {
      viewport.scrollTop = viewport.scrollHeight;
    }
    // local patch (pi-app): release the programmatic flag from handleScroll once
    // the scroll settles at the bottom (or from leaveLiveEdge on a user
    // gesture). The old 0ms timeout could fire before the scroll event; a
    // growing stream then read as a user scroll, switched following off and
    // left the transcript short of the bottom. The timer below is only a
    // safety net for a programmatic scroll that produces no event at all.
    if (scrollTimerRef.current) window.clearTimeout(scrollTimerRef.current);
    scrollTimerRef.current = window.setTimeout(() => {
      programmaticScrollRef.current = false;
    }, behavior === "smooth" ? 400 : 250);
  }, []);

  const handleScroll = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    const distance =
      viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    const resized = viewportHeightRef.current !== viewport.clientHeight;
    viewportHeightRef.current = viewport.clientHeight;

    // local patch (pi-app): composer resizing and content-visibility can emit
    // a native anchoring scroll before ResizeObserver. Preserve a following
    // reader through that event, rather than treating the new gap as intent.
    // Real scroll gestures refresh this snapshot in leaveLiveEdge below.
    if (resized && followingRef.current) {
      if (distance > 1) scrollToEnd("auto");
      updateActiveRailItem();
      return;
    }

    // local patch (pi-app): while a programmatic scroll is settling, keep the
    // following state untouched instead of re-deriving it from the distance.
    // Streamed growth moves the bottom between the scroll and its scroll event,
    // so deriving it here misread every follow-up scroll as the user leaving
    // the live edge — following went off and follow-scrolling stopped for good.
    if (programmaticScrollRef.current) {
      if (distance <= 1) programmaticScrollRef.current = false;
      updateActiveRailItem();
      return;
    }

    setFollowing(distance <= followThreshold);
    updateActiveRailItem();
  }, [followThreshold, scrollToEnd, setFollowing, updateActiveRailItem]);

  const leaveLiveEdge = useCallback(() => {
    programmaticScrollRef.current = false;
    viewportHeightRef.current = viewportRef.current?.clientHeight;
  }, []);

  useLayoutEffect(() => {
    followingRef.current = followOutput;
    if (followOutput) scrollToEnd("auto");
    // local patch (pi-app): a newly selected transcript remains visibility-
    // hidden through one positioning frame. The second instant scroll catches
    // layout completed later in the commit without exposing any travel.
    if (positionFrameRef.current) cancelAnimationFrame(positionFrameRef.current);
    // local patch (pi-app): mark the key positioned synchronously instead of
    // only in the rAF below. The rAF still re-scrolls after late layout, but if
    // it gets cancelled (a rapid second key change / remount) the old code left
    // `positionedScrollKey` stale and the whole transcript stayed `invisible`.
    setPositionedScrollKey(initialScrollKey);
    positionFrameRef.current = requestAnimationFrame(() => {
      if (followOutput) scrollToEnd("auto");
    });
    return () => {
      if (positionFrameRef.current) cancelAnimationFrame(positionFrameRef.current);
    };
  }, [followOutput, initialScrollKey, scrollToEnd]);

  useEffect(() => {
    const content = contentRef.current;
    if (!content || typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(() => {
      // local patch (pi-app): app-driven rail targets are user rows and its
      // labels come from data, so streamed assistant resizes do not require a
      // full transcript query/measurement on every chunk.
      if (!railItems) scheduleRailSync();
      if (!followOutput || !followingRef.current) return;      // local patch (pi-app): following cumulative output is always instant.
      // Smooth resize-follow both burns CPU and exposes top-to-bottom travel
      // while a newly selected transcript finishes laying out.
      // Only scroll when growth actually left the bottom: a width-only reflow
      // (or any frame where nothing changed below the fold) used to re-arm the
      // programmatic-scroll flag and its safety timer for nothing, which churns
      // on every frame of a fast stream.
      const viewport = viewportRef.current;
      if (
        viewport &&
        viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 1
      ) {
        return;
      }
      scrollToEnd("auto");
    });
    observer.observe(content);

    return () => observer.disconnect();
  }, [followOutput, scheduleRailSync, scrollToEnd, railItems]);

  // local patch (pi-app): the viewport's own size moves the live edge just
  // like content growth does — the composer below grows/shrinks with pasted
  // or removed attachments (and panels resize), cutting lines off at the
  // bottom without firing any scroll event. A reader at the live edge stays
  // pinned, instantly (ResizeObserver runs before paint); a reader who
  // scrolled away keeps their position untouched.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      viewportHeightRef.current = viewport.clientHeight;
      if (!followOutput || !followingRef.current) return;
      if (
        viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <=
        1
      ) {
        return;
      }
      scrollToEnd("auto");
    });
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [followOutput, scrollToEnd]);

  useEffect(() => {
    if (navigation !== "rail") {
      railTargetsRef.current.clear();
      setRailItems([]);
      setRailOverflowing(false);
      return;
    }

    const content = contentRef.current;
    const viewport = viewportRef.current;
    if (!content || !viewport) return;

    scheduleRailSync();
    // local patch (pi-app): when railItems are app-driven, streamed text and
    // assistant child mutations cannot add/remove navigation targets. Avoid a
    // subtree MutationObserver and content ResizeObserver in that mode; the
    // railItems dependency schedules the required sync after user rows change.
    const mutationObserver =
      railItems || typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver(scheduleRailSync);
    mutationObserver?.observe(content, {
      childList: true,
      characterData: true,
      subtree: true,
    });

    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(scheduleRailSync);
    if (!railItems) resizeObserver?.observe(content);
    resizeObserver?.observe(viewport);

    return () => {
      mutationObserver?.disconnect();
      resizeObserver?.disconnect();
    };
  }, [navigation, railItems, scheduleRailSync]);

  useEffect(
    () => () => {
      if (scrollTimerRef.current) window.clearTimeout(scrollTimerRef.current);
      if (positionFrameRef.current) cancelAnimationFrame(positionFrameRef.current);
      if (railFrameRef.current) cancelAnimationFrame(railFrameRef.current);
    },
    [],
  );

  const scrollToRailItem = useCallback(
    (item: PreviewRailItem) => {
      const viewport = viewportRef.current;
      const target = railTargetsRef.current.get(item.id);
      if (!viewport || !target) return;

      const lastItem = internalRailItems.at(-1)?.id === item.id;
      setActiveRailId(item.id);
      if (lastItem) {
        setFollowing(true);
        scrollToEnd(reduce || !smooth ? "auto" : "smooth");
        return;
      }

      setFollowing(false);
      programmaticScrollRef.current = true;
      const viewportRect = viewport.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      const top =
        viewport.scrollTop +
        targetRect.top -
        viewportRect.top -
        (viewport.clientHeight - targetRect.height) / 2;
      const behavior = reduce || !smooth ? "auto" : "smooth";

      if (typeof viewport.scrollTo === "function") {
        viewport.scrollTo({ top, behavior });
      } else {
        viewport.scrollTop = top;
      }
      if (scrollTimerRef.current) window.clearTimeout(scrollTimerRef.current);
      scrollTimerRef.current = window.setTimeout(() => {
        programmaticScrollRef.current = false;
      }, behavior === "smooth" ? 320 : 0);
    },
    [internalRailItems, reduce, scrollToEnd, setFollowing, smooth],
  );

  const viewport = (
    <section
      ref={setViewportRef}
      aria-label={label}
      {...restViewportProps}
      onScroll={(event) => {
        handleScroll();
        onViewportScroll?.(event);
      }}
      onWheel={(event) => {
        leaveLiveEdge();
        onViewportWheel?.(event);
      }}
      onTouchStart={(event) => {
        leaveLiveEdge();
        onViewportTouchStart?.(event);
      }}
      onKeyDown={(event) => {
        if (["ArrowUp", "PageUp", "Home"].includes(event.key)) {
          leaveLiveEdge();
        }
        onViewportKeyDown?.(event);
      }}
      className={cn(
        "h-full overflow-y-auto overscroll-contain outline-none [overflow-anchor:none] focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
        navigation === "rail"
          ? "[-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          : "[scrollbar-gutter:stable]",
        viewportClassName,
        positionedScrollKey !== initialScrollKey && "invisible",
        navigation === "rail" && railOverflowing && "pr-10",
      )}
    >
      <div
        ref={contentRef}
        role="log"
        aria-live="polite"
        aria-relevant="additions text"
        aria-busy={busy}
        className={contentClassName}
        {...contentProps}
      >
        {children}
      </div>
    </section>
  );

  return (
    <div
      data-slot="message-scroller"
      className={cn("min-h-0", className)}
      {...props}
    >
      {navigation === "rail" ? (
        <PreviewRail
          items={railOverflowing ? internalRailItems : []}
          label={navigationLabel}
          activeId={activeRailId}
          onItemSelect={scrollToRailItem}
          previewSide="before"
          highlightActive
          itemSize={14}
          className="h-full min-h-0 overflow-hidden"
          previewContainerClassName="right-8 left-3"
          previewClassName="mr-1 w-64 max-w-full [&_[data-slot=preview-rail-card]]:h-20 [&_[data-slot=preview-rail-card]]:overflow-hidden [&_[data-slot=preview-rail-card]]:p-3 [&_[data-slot=preview-rail-title]]:line-clamp-1 [&_[data-slot=preview-rail-title]]:text-xs [&_[data-slot=preview-rail-title]]:leading-ui-tight [&_[data-slot=preview-rail-description]]:line-clamp-2 [&_[data-slot=preview-rail-description]]:text-xs [&_[data-slot=preview-rail-description]]:leading-ui-tight"
          railClassName={cn(
            "absolute inset-y-3 right-1 w-7 content-center py-1 [&_[data-slot=preview-rail-item]]:w-7 [&_[data-slot=preview-rail-item]]:justify-end [&_[data-slot=preview-rail-tick]]:h-px [&_[data-slot=preview-rail-tick]]:w-4 [&_[data-slot=preview-rail-tick]]:origin-right",
            railOverflowing
              ? "pointer-events-auto opacity-100"
              : "pointer-events-none opacity-0",
            railClassName,
          )}
        >
          {viewport}
        </PreviewRail>
      ) : (
        viewport
      )}
    </div>
  );
}
