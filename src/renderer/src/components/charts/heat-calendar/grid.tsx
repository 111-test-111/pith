// local patch (pi-app): shared scalable typography for UI annotations.
"use client";

import { AnimatePresence, motion } from "motion/react";
import type { ReactNode } from "react";
import { EASE_OUT, SPRING_PRESS } from "@/lib/ease";
import { cn } from "@/lib/utils";
import { useHeatCalendar } from "./context";
import { DAYS, fmtDay, GAP, MONTH_ROW, PITCH } from "./utils";

export function HeatCalendarGrid({ children, className }: { children?: ReactNode; className?: string }) {
  const {
    weeks,
    reduce,
    pinned,
    step,
    hover,
    level,
    bucket,
    fill,
    count,
    dateOf,
    future,
    cols,
    clear,
    span,
    select,
    hot,
    hotMonth,
    setHover,
    gridRef,
    tooltipId,
    unit,
    locale,
  } = useHeatCalendar();
  return (
    <div
      ref={gridRef}
      className={cn("relative grid", className)}
      style={{
        width: weeks * PITCH - GAP,
        maxWidth: "100%",
        gridTemplateColumns: `repeat(${weeks}, minmax(0, 1fr))`,
        gridTemplateRows: `${MONTH_ROW}px repeat(7, auto)`,
        gap: GAP,
      }}
      onPointerLeave={() => setHover(null)}
    >
      {cols.map((c) =>
        c.label ? (
          <span
            key={c.id}
            className={cn(
              "whitespace-nowrap text-micro leading-none transition-colors duration-200",
              hotMonth === c.m ? "text-foreground" : "text-muted-foreground",
            )}
            style={{ gridColumn: c.w + 1, gridRow: 1 }}
          >
            {c.label}
          </span>
        ) : null,
      )}
      {cols.map(({ id, w }) =>
        DAYS.map(({ id: dayId, d }) => {
          const date = dateOf(w, d);
          if (future(w, d)) return null;
          const v = level(w, d);
          const b = bucket(v);
          const i = w * 7 + d;
          const on = hot?.w === w && hot?.d === d;
          const hovered = hover?.w === w && hover?.d === d;
          const isEnd = span ? i === span.lo || i === span.hi : pinned?.w === w && pinned?.d === d;
          const dim = (step !== null && step !== b) || (span !== null && (i < span.lo || i > span.hi));
          return (
            // the outer span owns the legend dim so it never fights the transforms inside
            <span
              key={`${id}-${dayId}`}
              className="relative block aspect-square w-full transition-opacity duration-200"
              style={{
                gridColumn: w + 1,
                gridRow: d + 2,
                opacity: dim ? 0.25 : 1,
                zIndex: on || isEnd ? 1 : 0,
              }}
            >
              {/* the hit area is the cell plus half the gap on every side, so the grid
                    has no dead space between cells and a fast pointer never falls through;
                    the visual inside never takes pointer events, so a neighbouring cell
                    cannot steal a click either */}
              <motion.button
                type="button"
                aria-label={`${count(v)} ${unit}${date ? ` on ${fmtDay(locale).format(date)}` : ""}`}
                data-heat-cell={`${w}-${d}`}
                aria-pressed={isEnd}
                aria-describedby={on ? tooltipId : undefined}
                onPointerEnter={() => setHover({ w, d })}
                onFocus={() => setHover({ w, d })}
                onBlur={() => setHover(null)}
                onClick={() => select({ w, d })}
                onKeyDown={(e) => {
                  if (e.key === "Escape") clear();
                }}
                // local patch (pi-app): capsule-by-design cells, so the shape
                // token follows the UI style (see --app-radius-capsule).
                className="absolute -inset-0.5 block rounded-capsule outline-none focus-visible:ring-1 focus-visible:ring-ring"
                // local patch (pi-app): no press scale — a chart cell must not
                // dip inward while pressed (see `button/base`).
              >
                <motion.span
                  className="pointer-events-none absolute inset-0.5 block rounded-capsule"
                  style={{
                    // local patch (pi-app): hover recolours the particle instead of
                    // lifting it. The ring below carries the highlight, and because it
                    // sits at inset-0 with borderRadius:inherit it hugs this shape
                    // exactly however the cell is styled.
                    background: hovered ? `color-mix(in srgb, var(--foreground) 16%, ${fill(b)})` : fill(b),
                    boxShadow: isEnd ? "0 0 0 2px var(--background), 0 0 0 3px var(--foreground)" : "none",
                    transition: "background 150ms, box-shadow 150ms",
                  }}
                  // the diagonal wave: each cell arrives (w + d) steps after the corner
                  initial={reduce ? false : { opacity: 0, scale: 0.4 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={reduce ? { duration: 0 } : { ...SPRING_PRESS, delay: (w + d) * 0.018 }}
                >
                  {/* the ring lives INSIDE the cell: inset-0 fills its box and
                        `rounded-inherit` copies the cell's radius AND its
                        `corner-shape: round`, so it draws a true circle on a round
                        particle instead of a squircle-clamped one */}
                  <AnimatePresence>
                    {on && !isEnd ? (
                      <motion.span
                        className="pointer-events-none absolute inset-0 block rounded-inherit border"
                        style={{
                          borderColor: "color-mix(in srgb, var(--foreground) 55%, transparent)",
                        }}
                        initial={reduce ? false : { opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.12, ease: EASE_OUT }}
                      />
                    ) : null}
                  </AnimatePresence>
                </motion.span>
              </motion.button>
            </span>
          );
        }),
      )}

      {children}
    </div>
  );
}
