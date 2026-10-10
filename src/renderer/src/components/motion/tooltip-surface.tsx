"use client";

import { motion } from "motion/react";
import { type ComponentProps, type ReactNode, type Ref } from "react";
// local patch (pi-app): tooltips and chart readouts share all overlay timing.
import { useOverlayMotion } from "@/lib/overlay-motion";
import { cn } from "@/lib/utils";

type Side = "top" | "right" | "bottom" | "left";

/** The shared visual surface for trigger tooltips and chart readouts. Positioning belongs to the caller. */
export function TooltipSurface({
  children,
  side = "top",
  className,
  ref,
  ...props
}: Omit<ComponentProps<typeof motion.span>, "children"> & {
  children?: ReactNode;
  side?: Side;
  ref?: Ref<HTMLSpanElement>;
}) {
  const overlay = useOverlayMotion(side);
  return (
    <motion.span
      ref={ref}
      role="tooltip"
      {...overlay}
      className={cn(
        "block whitespace-nowrap rounded-lg border border-border bg-background px-2.5 py-1 text-xs font-medium text-foreground shadow-overlay",
        className,
      )}
      {...props}
    >
      {children}
    </motion.span>
  );
}
