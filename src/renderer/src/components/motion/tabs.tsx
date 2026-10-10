"use client";
// beui.dev/components/motion/tabs

import { motion, MotionConfig, useReducedMotion, type Transition } from "motion/react";
import {
  createContext,
  useCallback,
  useContext,
  useId,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { EASE_OUT } from "@/lib/ease";
import { cn } from "@/lib/utils";

type Variant = "pill" | "underline" | "segment";

type Ctx = {
  value: string;
  setValue: (v: string) => void;
  layoutId: string;
  variant: Variant;
};

const TabsCtx = createContext<Ctx | null>(null);

function useTabs() {
  const ctx = useContext(TabsCtx);
  if (!ctx) throw new Error("Tabs.* must be used inside <Tabs>");
  return ctx;
}

// Weighty spring for the active-tab indicator: a touch of overshoot so it
// settles with life instead of snapping.
const transition: Transition = {
  type: "spring",
  stiffness: 170,
  damping: 24,
  mass: 1.2,
};

export function Tabs({
  defaultValue,
  value,
  onValueChange,
  variant = "pill",
  children,
  className,
}: {
  defaultValue?: string;
  value?: string;
  onValueChange?: (v: string) => void;
  variant?: Variant;
  children: ReactNode;
  className?: string;
}) {
  const [internal, setInternal] = useState(defaultValue ?? "");
  const layoutId = useId();
  const reduce = useReducedMotion();
  const controlled = value !== undefined;
  const current = controlled ? value : internal;
  const setValue = useCallback(
    (v: string) => {
      if (!controlled) setInternal(v);
      onValueChange?.(v);
    },
    [controlled, onValueChange],
  );
  const contextValue = useMemo(
    () => ({ value: current, setValue, layoutId, variant }),
    [current, layoutId, setValue, variant],
  );
  return (
    <MotionConfig transition={reduce ? { duration: 0 } : transition}>
      <TabsCtx.Provider value={contextValue}>
        {/* layoutRoot: the indicator's layoutId measures in page coordinates, so
            inside fixed/scrolled containers it would replay scroll offsets as
            movement. The pill only ever travels within the list, so scoping
            projection to the Tabs wrapper is always correct. */}
        <motion.div layoutRoot className={className}>
          {children}
        </motion.div>
      </TabsCtx.Provider>
    </MotionConfig>
  );
}

// local patch (pi-app): the pill LIST takes the scale's card step, not the
// capsule. A vertical pill list (the Settings nav, the Tools/Skills/Subagents/
// Extensions section lists) is several hundred pixels tall, and a 9999px radius
// clamps to half the WIDTH, turning its top and bottom into semicircles.
// `rounded-capsule` is `!important`, so no call site could override it. The
// moving INDICATOR below takes the CONTROL step like its tab — a selected row
// reads as a normal small-radius block, not a left/right-semicircle pill. A
// call site that genuinely wants a true capsule can use `rounded-full`
// (also `!important`).
const listClasses: Record<Variant, string> = {
  pill: "inline-flex items-center gap-1 rounded-card bg-card p-1",
  underline: "inline-flex items-center gap-1 border-b border-border",
  segment: "inline-flex items-center gap-0 rounded-lg bg-card p-0.5",
};

export function TabsList({ children, className }: { children: ReactNode; className?: string }) {
  const { variant } = useTabs();
  return (
    <div role="tablist" className={cn(listClasses[variant], className)}>
      {children}
    </div>
  );
}

export function TabsTrigger({
  value,
  children,
  className,
  indicatorClassName,
}: {
  value: string;
  children: ReactNode;
  className?: string;
  indicatorClassName?: string;
}) {
  const { value: current, setValue, layoutId, variant } = useTabs();
  const active = current === value;
  // local patch (pi-app): a tab's fill takes the scale's radius, so no tab
  // paints a hard-edged rectangle in the squircle style. The pill nav (the
  // Settings list, one row per section) takes the control step like the rows
  // it sits among; the compact horizontal strips — the segment variant's
  // browser pages and this underline variant — share the inner step.
  const fillRadius = variant === "pill" ? "rounded-control" : "rounded-md";

  if (variant === "underline") {
    return (
      <button
        type="button"
        role="tab"
        aria-selected={active}
        onClick={() => setValue(value)}
        className={cn(
          // local patch (pi-app): the registry's `pt-1 pb-2.5 -mb-px` recipe
          // is drawn for a tab that hangs below its own rule; the app's strips
          // stretch the trigger over the whole row instead (the rail's
          // `h-9 min-h-0`), and the asymmetric padding then pushed the icon and
          // label 2.5px above the row's centre — off the close button that
          // shares the row and off the add button at its end. Symmetric padding
          // and no negative margin put the box, its content and the indicator's
          // 1px rule on the row's own centre line.
          "relative isolate px-3 py-1 text-sm font-medium transition-colors min-h-[44px] inline-flex items-center",
          fillRadius,
          // local patch (pi-app): inactive tabs use a fill rather than a
          // border-only or text-only hover cue.
          active ? "text-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground",
          className,
        )}
      >
        {children}
        {active ? (
        <motion.span
          layoutId={layoutId}
          layout="position"
          className={cn(
            "absolute -bottom-px left-0 right-0 h-px bg-primary",
            indicatorClassName,
          )}
        />
      ) : null}
      </button>
    );
  }

  return (
    // local patch (pi-app): the wrapper is a flex container so its box IS the
    // trigger's box. As a block it lined its inline-flex button up on a text
    // baseline and added the strut's ~2px leading below it, so the absolute
    // selected indicator (inset-0) painted a taller block than the hover fill
    // the button itself paints — the selected 7d/30d pill sat 1px proud on each
    // side of the hovered one.
    <div className="relative flex">
      {active ? (
        <motion.span
          layoutId={layoutId}
          layout="position"
          // local patch (pi-app): CSS owns radius and shape for both the moving
          // indicator and its tab; inline numbers bypass the shared scale.
          // local patch (pi-app): tabs and single-choice segments keep a theme
          // tint for selection while their labels retain primary text contrast.
          className={cn(
            "absolute inset-0 bg-primary/15",
            fillRadius,
            indicatorClassName,
          )}
        />
      ) : null}
      <button
        type="button"
        role="tab"
        aria-selected={active}
        onClick={() => setValue(value)}
        className={cn(
          "relative z-10 inline-flex items-center justify-center whitespace-nowrap bg-transparent px-3.5 py-1.5 text-sm font-medium outline-none",
          "transition-colors",
          active
            ? "text-foreground"
            : "text-muted-foreground hover:bg-muted hover:text-foreground",
          fillRadius,
          className,
        )}
      >
        {children}
      </button>
    </div>
  );
}

export function TabsContent({ value, children, className }: { value: string; children: ReactNode; className?: string }) {
  const { value: current } = useTabs();
  const reduce = useReducedMotion();
  const active = current === value;
  // Inactive panels stay mounted but hidden, so their content (e.g. source
  // code) is present in the server-rendered HTML for crawlers and assistive
  // tech, instead of being dropped from the DOM.
  // local patch (pi-app): one element type for both states. The registry's
  // active `motion.div` vs inactive plain `div` switch changed the element
  // TYPE at the same tree position, so every tab change tore down the
  // deactivated panel's whole subtree and rebuilt it inside the hidden div —
  // remounting its components (state loss, effects refiring, a full commit
  // in the switch frame) even though the panel was supposed to stay mounted.
  // The panel is now a single motion.div whose animate target flips with
  // `active`: the entrance fade still replays on every activation (it
  // animates from the inactive target, opacity 0 / y 4), an inactive first
  // mount animates nothing (initial equals its animate target), and the
  // hidden attribute still removes inactive panels from layout and a11y.
  return (
    <motion.div
      hidden={!active}
      initial={{ opacity: 0, y: reduce ? 0 : 4 }}
      animate={active ? { opacity: 1, y: 0 } : { opacity: 0, y: reduce ? 0 : 4 }}
      transition={{ duration: 0.18, ease: EASE_OUT }}
      className={cn("mt-4", className)}
    >
      {children}
    </motion.div>
  );
}
