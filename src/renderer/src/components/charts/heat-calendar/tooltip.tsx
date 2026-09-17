"use client";
// local patch (pi-app): the chart readout is a controlled, anchor-positioned
// surface, and the app's `Tooltip` is the hover-trigger fork with no controlled
// mode. This renders the shared `TooltipSurface` through its own portal rather
// than adding a second tooltip implementation to every call site in the app.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AnimatePresence } from "motion/react";
import { createPortal } from "react-dom";
import { NumberTicker } from "@/components/motion/number-ticker";
import { TooltipSurface } from "@/components/motion/tooltip-surface";
import { cn } from "@/lib/utils";
import { useHeatCalendar } from "./context";
import { fmtDay, fmtRange } from "./utils";

const GAP = 8;

export function HeatCalendarTooltip({
  children,
  className,
}: {
  children?: ReactNode | ((data: NonNullable<ReturnType<typeof useHeatCalendar>["tooltip"]>) => ReactNode);
  className?: string;
}) {
  const { gridRef, tooltipId, tip, tooltip, unit, locale } = useHeatCalendar();
  const [dismissed, setDismissed] = useState<typeof tip>(null);
  const surfaceRef = useRef<HTMLSpanElement>(null);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);
  const anchor = useMemo(
    () => ({
      get current() {
        return tip
          ? gridRef.current?.querySelector<HTMLElement>(`[data-heat-cell="${tip.w}-${tip.d}"]`) ?? null
          : null;
      },
    }),
    [gridRef, tip],
  );
  const open = tooltip !== null && dismissed !== tip;

  const place = () => {
    const node = anchor.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    const width = surfaceRef.current?.offsetWidth ?? 0;
    const height = surfaceRef.current?.offsetHeight ?? 0;
    const left = Math.max(
      GAP + width / 2,
      Math.min(rect.left + rect.width / 2, window.innerWidth - GAP - width / 2),
    );
    const top = Math.max(GAP + height, rect.top - GAP);
    setCoords((previous) =>
      previous?.top === top && previous.left === left ? previous : { top, left },
    );
  };

  useLayoutEffect(() => {
    if (!open) return;
    place();
    const observer = new ResizeObserver(place);
    if (anchor.current) observer.observe(anchor.current);
    if (surfaceRef.current) observer.observe(surfaceRef.current);
    return () => observer.disconnect();
  }, [open, tip, tooltip]);

  useEffect(() => {
    if (!open) return;
    const onMove = () => place();
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => {
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
    };
  }, [open, tip]);

  if (typeof document === "undefined") return null;
  return createPortal(
    <AnimatePresence>
      {open && coords ? (
        <span
          data-heat-tooltip=""
          className="pointer-events-none fixed z-[9999]"
          style={{ top: coords.top, left: coords.left, transform: "translate(-50%, -100%)" }}
        >
          <TooltipSurface
            ref={surfaceRef}
            side="top"
            id={tooltipId}
            style={{
              transformOrigin: "center bottom",
              maxWidth: "calc(100vw - 16px)",
              whiteSpace: "normal",
            }}
            className={cn("flex flex-wrap items-center gap-1.5", className)}
          >
            {tooltip &&
              (typeof children === "function"
                ? children(tooltip)
                : (children ?? (
                    <>
                      <span className="inline-flex items-center gap-1 font-mono tabular-nums">
                        <NumberTicker
                          value={tooltip.days > 1 ? tooltip.total : tooltip.count}
                          duration={0.35}
                          startOnView={false}
                        />{" "}
                        {unit}
                      </span>
                      <span className="text-muted-foreground">
                        {tooltip.days > 1 && tooltip.startDate && tooltip.endDate
                          ? `${fmtRange(locale).format(tooltip.startDate)} – ${fmtRange(locale).format(tooltip.endDate)}`
                          : fmtDay(locale).format(tooltip.date)}
                      </span>
                      {tooltip.days > 1 ? (
                        <span className="text-muted-foreground">{tooltip.days} days</span>
                      ) : null}
                    </>
                  )))}
          </TooltipSurface>
        </span>
      ) : null}
    </AnimatePresence>,
    document.body,
  );
}
