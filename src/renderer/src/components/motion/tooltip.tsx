"use client";
// beui.dev/components/motion/tooltip

import {
  autoUpdate,
  flip,
  offset,
  platform as domPlatform,
  shift,
  useFloating,
  type Placement,
} from "@floating-ui/react";
import {
  AnimatePresence,
  motion,
  useReducedMotion,
  type Variants,
} from "motion/react";
import {
  cloneElement,
  isValidElement,
  type PointerEvent,
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { EASE_OUT } from "@/lib/ease";
import { useDismiss } from "@/lib/hooks/use-dismiss";
import { useHoverGesture } from "@/lib/hooks/use-hover-gesture";
import { useTapGesture } from "@/lib/hooks/use-tap-gesture";
import { cn } from "@/lib/utils";

type Side = "top" | "right" | "bottom" | "left";
type Align = "start" | "center" | "end";

export interface TooltipProps {
  content: ReactNode;
  children: ReactElement;
  /** Preferred side — a hint: placement may flip away from it to fit. */
  side?: Side;
  /** local patch (pi-app): preferred cross-axis alignment, also a hint. The
   * resolved placement can still become diagonal (`top-start`) or another side. */
  align?: Align;
  /** Delay before showing (ms). Default 120. */
  delay?: number;
  /** local patch (pi-app): keep the anchor mounted while a row edits or opens its menu. */
  disabled?: boolean;
  className?: string;
  /** Classes for the outer wrapper span. Use to fix baseline / fill parent. */
  wrapperClassName?: string;
}

// Gap between trigger and tooltip, in px.
const GAP = 8;

// Distance the bubble keeps from the window edges.
const VIEWPORT_MARGIN = 8;

// Offset is in the direction *away* from the trigger — content originates near
// the trigger and rises into resting position. Keyed by the resolved side.
const offsetFrom: Record<Side, { x?: number; y?: number }> = {
  top: { y: 8 },
  bottom: { y: -8 },
  left: { x: 8 },
  right: { x: -8 },
};

function buildVariants(side: Side): Variants {
  const o = offsetFrom[side];
  return {
    initial: {
      opacity: 0,
      scale: 0.9,
      filter: "blur(5px)",
      x: o.x ?? 0,
      y: o.y ?? 0,
    },
    animate: {
      opacity: 1,
      scale: 1,
      filter: "blur(0px)",
      x: 0,
      y: 0,
      transition: {
        type: "spring",
        stiffness: 380,
        damping: 30,
        mass: 0.7,
        opacity: { duration: 0.14, ease: EASE_OUT },
        filter: { duration: 0.18, ease: EASE_OUT },
      },
    },
    exit: {
      opacity: 0,
      scale: 0.94,
      filter: "blur(3px)",
      x: (o.x ?? 0) * 0.6,
      y: (o.y ?? 0) * 0.6,
      transition: { duration: 0.12, ease: EASE_OUT },
    },
  };
}

const REDUCED_VARIANTS: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: 0.14, ease: EASE_OUT } },
  exit: { opacity: 0, transition: { duration: 0.1, ease: EASE_OUT } },
};

// local patch (pi-app): a press only dismisses the label when the press can
// open something of its own.
//
// The rule used to be unconditional, so pressing a trigger that is not a
// control — the composer's context ring is a `role="status"` readout, and the
// file find bar's match counter is another — took away the label the user was
// pointing at and gave nothing back: the bubble only returned after leaving the
// trigger and re-entering it. A real control (button, menu item, option, a
// focusable field) still drops the label on press, because the overlay that
// press opens must never carry the stale bubble above itself.
const INTERACTIVE_PRESS =
  'button, a[href], input, select, textarea, summary, [tabindex], [role="button"], [role="link"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="option"], [role="tab"], [role="switch"], [role="checkbox"], [role="radio"], [role="slider"]';

function pressCanAct(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(INTERACTIVE_PRESS) !== null;
}

/** The corner the bubble grows out of: the one facing its trigger. */
function originFor(placement: Placement): string {
  const [side, align] = placement.split("-") as [Side, Align | undefined];
  if (side === "top" || side === "bottom") {
    const x = align === "start" ? "left" : align === "end" ? "right" : "center";
    return `${x} ${side === "top" ? "bottom" : "top"}`;
  }
  const y = align === "start" ? "top" : align === "end" ? "bottom" : "center";
  return `${side === "left" ? "right" : "left"} ${y}`;
}

// Once any tooltip has just closed, neighbouring tooltips open without the
// initial delay — moving along a toolbar feels instant after the first one.
const WARM_WINDOW_MS = 300;
let lastHiddenAt = 0;

// local patch (pi-app): a label follows the pointer and the keyboard, never a
// programmatic focus move.
//
// Every overlay hands focus back to its trigger when it closes
// (`CenterMorphModalContent` and `MorphPopover` both do), and that `focus` is
// not the user asking for a label: it resurrected the tooltip of a trigger the
// pointer had already left — closing the session-search panel by clicking the
// backdrop left the search button's label on screen, with nothing left to move
// the pointer or the focus away. Focus therefore opens a label only when the
// keyboard was the last input, which is the line the platform's own
// `:focus-visible` heuristic draws, drawn here so it stays observable to
// `scripts/check-tooltip.mjs`.
let keyboardInput = false;
if (typeof window !== "undefined") {
  window.addEventListener("keydown", () => { keyboardInput = true }, true);
  window.addEventListener("pointerdown", () => { keyboardInput = false }, true);
}

export function Tooltip({
  content,
  children,
  side = "top",
  align = "center",
  delay = 120,
  disabled = false,
  className,
  wrapperClassName,
}: TooltipProps) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const anchorRef = useRef<HTMLSpanElement>(null);
  const hover = useHoverGesture();
  const tap = useTapGesture<boolean>();
  const reduce = useReducedMotion();

  // local patch (pi-app): viewport-aware placement.
  //
  // beUI pinned the bubble to a point on the trigger's edge and centred it with
  // a translate, so nothing kept it inside the window: every tooltip on a
  // control near an edge — the top bar, the right rail, the composer's context
  // ring — was clipped, and each call site worked around it by hand. flip/shift
  // resolve the placement instead. Overflow along the side axis flips the
  // bubble; overflow along the alignment axis resolves to a *diagonal*
  // placement (`top-start`) or slides it along the edge, which is what a native
  // tooltip does and what a fixed translate map cannot express. `autoUpdate`
  // keeps the bubble pinned while the page scrolls, the window resizes, or the
  // content changes (the context ring's readout is live).
  const middleware = useMemo(
    () => [
      offset(GAP),
      flip({ padding: VIEWPORT_MARGIN }),
      // `crossAxis` is the slide: without it, a bubble whose preferred side
      // fits but which overflows an edge stays centred and gets clipped.
      shift({ padding: VIEWPORT_MARGIN, crossAxis: true }),
    ],
    [],
  );

  // Measure the layout box rather than the animated rect: the entrance animates
  // `scale`, and a rect read mid-animation would freeze the bubble at ~90% of
  // its size (no ResizeObserver fires for a transform, so the error would stay
  // until the next scroll or resize).
  const platform = useMemo(
    () => ({
      ...domPlatform,
      getDimensions: (element: Element) => {
        const node = element as HTMLElement;
        return { width: node.offsetWidth, height: node.offsetHeight };
      },
    }),
    [],
  );

  const { refs, floatingStyles, placement, isPositioned } = useFloating({
    open,
    strategy: "fixed",
    placement: align === "center" ? side : (`${side}-${align}` as Placement),
    // The entrance animation owns `transform`.
    transform: false,
    whileElementsMounted: autoUpdate,
    middleware,
    platform,
  });

  const resolvedSide = placement.split("-")[0] as Side;
  const variants = useMemo(
    () => (reduce ? REDUCED_VARIANTS : buildVariants(resolvedSide)),
    [reduce, resolvedSide],
  );

  // The wrapper is both the element the bubble is placed against and the one
  // the hover, tap and dismissal handlers observe.
  const setAnchor = useCallback(
    (node: HTMLSpanElement | null) => {
      anchorRef.current = node;
      refs.setReference(node);
    },
    [refs],
  );

  const show = useCallback(() => {
    if (disabled) return;
    if (timer.current) clearTimeout(timer.current);
    const warm = Date.now() - lastHiddenAt < WARM_WINDOW_MS;
    timer.current = setTimeout(() => setOpen(true), warm ? 0 : delay);
  }, [delay, disabled]);

  const hide = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (open) lastHiddenAt = Date.now();
    setOpen(false);
  }, [open]);

  // local patch (pi-app): cancel pending/open labels without replacing their
  // trigger, so editing and portalled menus retain layout and focus.
  useEffect(() => {
    if (disabled) hide();
  }, [disabled, hide]);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  // A finger never hovers, and Safari does not focus a button on tap either, so
  // the label is only reachable if the tap itself opens the tooltip. A click
  // carries no pointerType, so the pointerdown that preceded it is what says
  // whether this was a tap; keyboard activation arrives with no pointerdown at
  // all, and focus has already shown the label there.
  const toggleOnTap = useCallback(() => {
    const gesture = tap.take();
    if (disabled || !gesture || gesture.pointerType === "mouse") return;
    if (gesture.state) {
      hide();
      return;
    }
    if (timer.current) clearTimeout(timer.current);
    setOpen(true);
  }, [disabled, hide, tap]);

  // ...and closed again by the next tap that lands somewhere else. The label
  // covers nothing interactive, so that tap passes through to what it hit.
  useDismiss(open, hide, anchorRef);

  if (!isValidElement(children)) return children;

  // The label describes the trigger, so it has to name the trigger itself.
  // Everything else the tooltip needs is read off the anchor below instead of
  // cloned on: a handler written onto the child is the child's handler as far
  // as that child can tell, and a component that owns its activation —
  // hard-wiring onClick and spreading the rest of its props over it, as
  // ThemeToggle does — then runs the tooltip's instead of its own. Composing
  // with `props.onClick` cannot save it either, because a component element's
  // props hold nothing the component does internally.
  const trigger = cloneElement(children as ReactElement<Record<string, unknown>>, {
    "aria-describedby": id,
  });

  return (
    <>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: the anchor is not a
          control — it observes the trigger it wraps. Every event listed reaches
          it on its own (pointerdown/click/keydown/pointercancel bubble, focus
          and blur arrive as focusin/focusout, and enter/leave are derived from
          pointerover/pointerout along a path the anchor is on), so the trigger
          keeps every handler it came with. */}
      <span
        ref={setAnchor}
        className={cn("relative inline-flex align-middle", wrapperClassName)}
        // Pointer events, not the mouse pair: a tap fires compatibility
        // mouseenter/mouseleave that carry no pointerType, which raced the tap
        // path into opening and closing the same label.
        onPointerEnter={(event: PointerEvent) => {
          if (hover.enter(event)) show();
        }}
        onPointerLeave={(event: PointerEvent) => {
          if (hover.leave(event)) hide();
        }}
        onFocus={() => {
          // A programmatic focus move is not a request for the label; see
          // `keyboardInput` above.
          if (keyboardInput) show();
        }}
        onBlur={hide}
        onPointerDown={(event: PointerEvent) => {
          // Pressing a real trigger is not a request for the label either, and
          // the overlay the press may open would otherwise carry the old bubble
          // above it: hide on press, as a native tooltip does. A trigger that
          // cannot act (see `pressCanAct`) keeps its label. The tap record still
          // holds the state the press began on, so `toggleOnTap` keeps acting on
          // what the finger pressed, not on what this hid.
          tap.start(event, open);
          if (pressCanAct(event.target)) hide();
        }}
        // A gesture the platform took away sends no click, and a key press
        // starts an activation that never had a pointer behind it. Either way
        // the record has to go, or the next click reads a finger that has long
        // since lifted.
        onPointerCancel={tap.drop}
        onKeyDown={tap.drop}
        onClick={toggleOnTap}
      >
        {trigger}
      </span>
      {typeof document !== "undefined"
        ? createPortal(
            <AnimatePresence>
              {open ? (
                <motion.span
                  ref={refs.setFloating}
                  id={id}
                  role="tooltip"
                  // The resolved placement, for tests and for spotting a bubble
                  // that had to move (flip/shift) away from its preferred side.
                  data-placement={placement}
                  variants={variants}
                  initial="initial"
                  animate="animate"
                  exit="exit"
                  // Until the first measurement lands the bubble is mounted only
                  // so it can be measured — hiding it keeps it out of (0, 0).
                  // While it is closing it stays visible, so the exit animation
                  // still plays.
                  style={{
                    ...floatingStyles,
                    visibility: isPositioned || !open ? undefined : "hidden",
                    transformOrigin: originFor(placement),
                  }}
                  className={cn(
                    "pointer-events-none fixed z-[9999] block whitespace-nowrap rounded-lg border border-border bg-background px-2.5 py-1 text-xs font-medium text-foreground shadow-lg",
                    className,
                  )}
                >
                  {content}
                </motion.span>
              ) : null}
            </AnimatePresence>,
            document.body,
          )
        : null}
    </>
  );
}
