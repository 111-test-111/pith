"use client";

import { motion } from "motion/react";
import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { usePopoverPortalPosition } from "@/components/motion/popover-position";
// local patch (pi-app): shared overlay motion, with natural content geometry.
import { useOverlayMotion } from "@/lib/overlay-motion";
import { cn } from "@/lib/utils";
import { useComboboxContext } from "./context";

type Side = "top" | "bottom";
type Align = "start" | "center" | "end";

const VIEWPORT_PADDING = 8;

export interface ComboboxContentProps {
  children: ReactNode;
  side?: Side;
  align?: Align;
  sideOffset?: number;
  avoidCollisions?: boolean;
  className?: string;
}

export function ComboboxContent({
  children,
  side = "bottom",
  align = "start",
  sideOffset = 6,
  avoidCollisions = true,
  className,
}: ComboboxContentProps) {
  const context = useComboboxContext("ComboboxContent");
  const [portalReady, setPortalReady] = useState(false);
  const [actualSide, setActualSide] = useState<Side>(side);
  const overlay = useOverlayMotion(actualSide);
  const layout = usePopoverPortalPosition(
    context.triggerRef,
    context.contentRef,
    portalReady,
  );

  useEffect(() => setPortalReady(true), []);

  useLayoutEffect(() => {
    // Preserve the resolved side during exit, so top panels close upward.
    if (!context.open || !layout) return;
    if (!avoidCollisions) {
      setActualSide(side);
      return;
    }
    const below =
      window.innerHeight - (layout.trigger.top + layout.trigger.height);
    const above = layout.trigger.top;
    if (
      side === "bottom" &&
      below < layout.content.height + sideOffset &&
      above > below
    )
      setActualSide("top");
    else if (
      side === "top" &&
      above < layout.content.height + sideOffset &&
      below > above
    )
      setActualSide("bottom");
    else setActualSide(side);
  }, [avoidCollisions, context.open, layout, side, sideOffset]);

  if (!portalReady) return null;

  const triggerLeft = layout?.trigger.left ?? 0;
  const triggerWidth = layout?.trigger.width ?? 0;
  const contentWidth = layout?.content.width ?? triggerWidth;
  const desiredLeft =
    align === "end"
      ? triggerLeft + triggerWidth - contentWidth
      : align === "center"
        ? triggerLeft + (triggerWidth - contentWidth) / 2
        : triggerLeft;
  const maxLeft = Math.max(
    VIEWPORT_PADDING,
    window.innerWidth - contentWidth - VIEWPORT_PADDING,
  );
  const left = Math.min(Math.max(desiredLeft, VIEWPORT_PADDING), maxLeft);

  return createPortal(
    <motion.div
      ref={context.contentRef}
      data-combobox-content=""
      data-side={actualSide}
      aria-hidden={!context.open}
      inert={!context.open}
      {...overlay}
      animate={context.open && layout ? "open" : "closed"}
      style={
        {
          left,
          top:
            actualSide === "bottom" && layout
              ? layout.trigger.top + layout.trigger.height + sideOffset
              : undefined,
          bottom:
            actualSide === "top" && layout
              ? window.innerHeight - layout.trigger.top + sideOffset
              : undefined,
          minWidth: triggerWidth,
          pointerEvents: context.open ? "auto" : "none",
          transformOrigin: actualSide === "bottom" ? "top" : "bottom",
          visibility: layout ? "visible" : "hidden",
          "--combobox-trigger-width": `${triggerWidth}px`,
        } as CSSProperties
      }
      className={cn(
        // local patch (pi-app): floating lists use the shared surface geometry.
        "fixed z-[9999] w-(--combobox-trigger-width) overflow-hidden rounded-card border border-border bg-background text-popover-foreground shadow-overlay outline-none",
        className,
      )}
    >
      <div>
        {children}
      </div>
    </motion.div>,
    document.body,
  );
}
