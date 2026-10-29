"use client";

import { AnimatePresence, motion } from "motion/react";
import {
  cloneElement,
  createContext,
  isValidElement,
  type ReactElement,
  type ReactNode,
  type Ref,
  type CSSProperties,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { usePopoverPortalPosition } from "@/components/motion/popover-position";
// local patch (pi-app): use the same entrance and exit as pickers and menus.
import { useOverlayMotion } from "@/lib/overlay-motion";
// local patch (pi-app): release focus/pointer ownership as soon as exit starts.
import { PresenceGate } from "@/lib/presence-gate";
import { cn } from "@/lib/utils";

// local patch (pi-app): image information can sit beside its shared anchor.
type Side = "top" | "right" | "bottom" | "left";
// local patch (pi-app): "center" anchors the panel on the trigger's midpoint
// (the turn's hover-preview pops out of the middle of its row).
type Align = "start" | "end" | "center";

type MorphContextValue = {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
  triggerId: string;
  contentId: string;
  /** The element the panel measures against — see `registerTrigger`. */
  triggerRef: React.MutableRefObject<HTMLElement | null>;
  registerTrigger: (node: HTMLElement | null) => void;
  contentRef: React.MutableRefObject<HTMLDivElement | null>;
};

const MorphContext = createContext<MorphContextValue | null>(null);

// local patch (pi-app): composed parts (date-range-picker's content) reach
// the panel through this hook because the app MorphPopoverContent owns its ref.
export function useMorphContext(component: string) {
  const ctx = useContext(MorphContext);
  if (!ctx) throw new Error(`${component} must be used within <MorphPopover>`);
  return ctx;
}

export interface MorphPopoverProps {
  children: ReactNode;
  /** Controlled open state. */
  open?: boolean;
  /** Uncontrolled initial open state. */
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  // local patch (pi-app): multiple file rows share one persistent preview;
  // switch its anchor/accessible label without remounting the portal.
  anchor?: HTMLElement | null;
  contentId?: string;
  className?: string;
}

/**
 * A popover whose panel opens from the trigger corner as one native surface.
 * Closes on outside pointer / Escape. Controlled or uncontrolled.
 */
export function MorphPopover({
  children,
  open: controlledOpen,
  defaultOpen = false,
  onOpenChange,
  anchor,
  contentId,
  className,
}: MorphPopoverProps) {
  const baseId = useId();
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const [trigger, setTrigger] = useState<HTMLElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const controlled = controlledOpen !== undefined;
  const open = controlled ? controlledOpen : internalOpen;

  const setOpen = useCallback(
    (next: boolean) => {
      if (!controlled) setInternalOpen(next);
      onOpenChange?.(next);
    },
    [controlled, onOpenChange],
  );
  const toggle = useCallback(() => setOpen(!open), [setOpen, open]);

  // A trigger normally registers itself through MorphPopoverTrigger. It can't
  // when something else already clones the element — a Tooltip wrapping the
  // button, say — and an unregistered trigger leaves the panel with nothing to
  // measure against, so it renders permanently invisible. The root boxes the
  // trigger exactly (the content portals out of it), so it stands in until a
  // real trigger registers, and stands in again if that one unmounts. Both are
  // state, so a trigger arriving while the panel is open re-anchors it.
  const anchorRef = useMemo<React.MutableRefObject<HTMLElement | null>>(
    () => ({ current: anchor ?? trigger ?? root }),
    [anchor, root, trigger],
  );

  // The panel is a `role="dialog"` and goes inert the moment it closes, so
  // focus cannot be left sitting inside it: a dismissal hands it back to the
  // trigger, the way the ARIA dialog pattern asks. A pointer dismissal takes
  // the focus onward itself when it lands on something focusable — this only
  // catches the case where it would otherwise be stranded. When no trigger has
  // registered, the root anchor stands in only if it can actually hold focus;
  // there is nowhere better than where the keyboard already is, so leave it.
  const close = useCallback(() => {
    const focused = document.activeElement;
    const inPanel =
      focused instanceof HTMLElement && contentRef.current?.contains(focused);
    // local patch (pi-app): return keyboard focus to the current shared anchor.
    const restore = anchor ?? trigger ?? (root && root.tabIndex >= 0 ? root : null);
    // local patch (pi-app): focus before dismissal, so a focus-to-preview handler
    // cannot reopen the panel in response to restoring keyboard focus on Escape.
    if (inPanel) restore?.focus({ preventScroll: true });
    setOpen(false);
  }, [anchor, root, setOpen, trigger]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    const onPointer = (e: PointerEvent) => {
      const target = e.target as Node;
      if (
        root &&
        !root.contains(target) &&
        !contentRef.current?.contains(target)
      )
        close();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointer);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointer);
    };
  }, [open, root, close]);

  const ctx = useMemo<MorphContextValue>(
    () => ({
      open,
      setOpen,
      toggle,
      // local patch (pi-app): shared rows supply their own trigger/content IDs.
      triggerId: anchor?.id || `${baseId}-trigger`,
      contentId: contentId ?? `${baseId}-content`,
      triggerRef: anchorRef,
      registerTrigger: setTrigger,
      contentRef,
    }),
    [open, setOpen, toggle, baseId, anchorRef, anchor, contentId],
  );

  return (
    <MorphContext.Provider value={ctx}>
      <div ref={setRoot} className={cn("relative inline-flex", className)}>
        {children}
      </div>
    </MorphContext.Provider>
  );
}

export interface MorphPopoverTriggerProps {
  children: ReactElement;
}

function mergeRefs<T>(...refs: Array<Ref<T> | undefined>) {
  return (node: T | null) => {
    for (const ref of refs) {
      if (typeof ref === "function") ref(node);
      else if (ref && typeof ref === "object")
        (ref as React.MutableRefObject<T | null>).current = node;
    }
  };
}

/** Wraps a single element, toggling the popover on click. */
export function MorphPopoverTrigger({ children }: MorphPopoverTriggerProps) {
  const ctx = useMorphContext("MorphPopoverTrigger");
  if (!isValidElement(children)) return children;

  const child = children as ReactElement<Record<string, unknown>>;
  const childOnClick = child.props.onClick as
    | ((e: unknown) => void)
    | undefined;
  const childRef = (child.props as { ref?: Ref<HTMLElement> }).ref;

  return cloneElement(child, {
    id: ctx.triggerId,
    ref: mergeRefs(childRef, ctx.registerTrigger),
    onClick: (e: unknown) => {
      childOnClick?.(e);
      ctx.toggle();
    },
    "aria-haspopup": "dialog",
    "aria-expanded": ctx.open,
    "aria-controls": ctx.open ? ctx.contentId : undefined,
  });
}

const originFor = (side: Side, align: Align) =>
  side === "right" || side === "left"
    ? `${side === "right" ? "left" : "right"} ${align === "end" ? "bottom" : align === "center" ? "center" : "top"}`
    : `${side === "bottom" ? "top" : "bottom"} ${align === "end" ? "right" : align === "center" ? "center" : "left"}`;

export interface MorphPopoverContentProps {
  children: ReactNode;
  side?: Side;
  align?: Align;
  /** Gap between trigger and panel, in px. Default 8. */
  sideOffset?: number;
  /** local patch (pi-app): accept a theme token; defaults to the window radius. */
  radius?: CSSProperties["borderRadius"];
  /** local patch (pi-app): skip the morph entirely — the panel mounts and
   * unmounts at rest, for a preview handing over to another one in the same
   * frame (a hover moving from one file to the next). */
  instant?: boolean;
  /** local patch (pi-app): keep a parent mounted while a confirmation owns focus. */
  inert?: boolean;
  className?: string;
}

export function MorphPopoverContent({
  children,
  side = "bottom",
  align = "end",
  sideOffset = 8,
  radius = "var(--app-radius-window)",
  instant = false,
  inert = false,
  className,
}: MorphPopoverContentProps) {
  const ctx = useMorphContext("MorphPopoverContent");
  const [portalReady, setPortalReady] = useState(false);
  const layout = usePopoverPortalPosition(
    ctx.triggerRef,
    ctx.contentRef,
    portalReady && ctx.open,
  );

  useEffect(() => setPortalReady(true), []);
  let left = layout
    ? align === "end"
      ? layout.trigger.left + layout.trigger.width - layout.content.width
      : align === "center"
        ? layout.trigger.left +
          layout.trigger.width / 2 -
          layout.content.width / 2
        : layout.trigger.left
    : 0;
  let top = layout
    ? side === "bottom"
      ? layout.trigger.top + layout.trigger.height + sideOffset
      : layout.trigger.top - layout.content.height - sideOffset
    : 0;
  let placement = side;
  // local patch (pi-app): lateral panels flip to the roomier side and clamp to
  // the viewport, using resting dimensions rather than animated rectangles.
  if (layout && (side === "right" || side === "left")) {
    const rightRoom = window.innerWidth - layout.trigger.left - layout.trigger.width - sideOffset - 8;
    const leftRoom = layout.trigger.left - sideOffset - 8;
    if (side === "right" && rightRoom < layout.content.width && leftRoom > rightRoom) placement = "left";
    if (side === "left" && leftRoom < layout.content.width && rightRoom > leftRoom) placement = "right";
    left = placement === "right"
      ? layout.trigger.left + layout.trigger.width + sideOffset
      : layout.trigger.left - layout.content.width - sideOffset;
    top = align === "center" ? layout.trigger.top + (layout.trigger.height - layout.content.height) / 2
      : align === "end" ? layout.trigger.top + layout.trigger.height - layout.content.height : layout.trigger.top;
    left = Math.max(8, Math.min(left, window.innerWidth - layout.content.width - 8));
    top = Math.max(8, Math.min(top, window.innerHeight - layout.content.height - 8));
  }
  const overlay = useOverlayMotion(placement, instant);

  // Keep the server and first client render identical, then mount the portal.
  if (!portalReady) return null;

  return createPortal(
    <AnimatePresence>
      {ctx.open ? (
        <PresenceGate>
          {({ gate }) => (
            <motion.div
              data-morph-popover-portal=""
              {...overlay}
              {...gate}
              // local patch (pi-app): suspend the whole parent's hit target and
              // paint it below the modal layer while a confirmation owns input.
              inert={inert || gate.inert}
              style={{
                ...gate.style,
                pointerEvents: inert ? "none" : gate.style?.pointerEvents,
                zIndex: inert ? 99 : undefined,
                left,
                top,
                visibility: layout ? "visible" : "hidden",
                transformOrigin: originFor(placement, align),
              }}
              className="fixed z-[9999]"
            >
              <motion.div
                ref={ctx.contentRef}
                id={ctx.contentId}
                role="dialog"
                inert={inert || undefined}
                aria-hidden={inert || undefined}
                aria-labelledby={ctx.triggerId}
                style={{ borderRadius: radius }}
                className={cn(
                  "overflow-hidden border border-border bg-background shadow-overlay",
                  className,
                )}
              >
                {children}
              </motion.div>
            </motion.div>
          )}
        </PresenceGate>
      ) : null}
    </AnimatePresence>,
    document.body,
  );
}
