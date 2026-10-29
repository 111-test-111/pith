// local patch (pi-app): keep UI frames and focus rings in this component at 1px.
"use client";

// local patch (pi-app): use the shared UI icon adapter.
import { Check, ChevronDown } from "@/lib/icons";
import {
  motion,
  useReducedMotion,
} from "motion/react";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
// local patch (pi-app): let modal callers portal the same select panel above
// clipped dialog and scroll surfaces without changing the ordinary layout path.
import { createPortal } from "react-dom";
// local patch (pi-app): all picker panels use the app's shared overlay motion.
import { OVERLAY_ENTER, useOverlayMotion } from "@/lib/overlay-motion";
import { cn } from "@/lib/utils";

type Placement = "bottom" | "top";

interface SelectContextValue {
  value: string | undefined;
  open: boolean;
  setOpen: (open: boolean) => void;
  select: (value: string) => void;
  register: (value: string, label: string) => void;
  unregister: (value: string) => void;
  labelFor: (value: string | undefined) => string | undefined;
  reduce: boolean;
  triggerId: string;
  listId: string;
  disabled: boolean;
  placement: Placement;
  setPlacement: (p: Placement) => void;
  panelRef: React.RefObject<HTMLDivElement | null>;
}

const SelectContext = createContext<SelectContextValue | null>(null);

function useSelectContext(component: string) {
  const ctx = useContext(SelectContext);
  if (!ctx) throw new Error(`${component} must be used within <Select>`);
  return ctx;
}

export interface SelectProps {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  /**
   * Controlled open state of the panel. A layout that stacks selects can hold
   * this to keep exactly one panel open — the panel is absolutely positioned
   * inside its field, so two open at once paint over each other's options.
   */
  open?: boolean;
  /** Uncontrolled initial open state. Default false. */
  defaultOpen?: boolean;
  /**
   * Fires whenever the panel opens or closes. The panel is absolutely
   * positioned inside the field, so a layout that stacks selects has to know
   * which one is open to paint it above its neighbours.
   */
  onOpenChange?: (open: boolean) => void;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
}

export function Select({
  value,
  defaultValue,
  onValueChange,
  open: openProp,
  defaultOpen = false,
  onOpenChange,
  disabled = false,
  className,
  children,
}: SelectProps) {
  const reduce = useReducedMotion() ?? false;
  const baseId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const [internal, setInternal] = useState(defaultValue);
  const [labels, setLabels] = useState<Map<string, string>>(new Map());
  const [placement, setPlacement] = useState<Placement>("bottom");

  const controlled = value !== undefined;
  const current = controlled ? value : internal;
  const openControlled = openProp !== undefined;
  const open = openControlled ? openProp : internalOpen;

  const setOpen = useCallback(
    (next: boolean) => {
      // local patch (pi-app): return focus before the retained panel goes inert.
      if (!next && panelRef.current?.contains(document.activeElement)) {
        document.getElementById(`${baseId}-trigger`)?.focus({ preventScroll: true });
      }
      if (!openControlled) setInternalOpen(next);
      onOpenChange?.(next);
    },
    [baseId, onOpenChange, openControlled],
  );

  const select = useCallback(
    (next: string) => {
      if (!controlled) setInternal(next);
      onValueChange?.(next);
      setOpen(false);
    },
    [controlled, onValueChange, setOpen],
  );

  const register = useCallback((v: string, label: string) => {
    setLabels((m) => (m.get(v) === label ? m : new Map(m).set(v, label)));
  }, []);
  const unregister = useCallback((v: string) => {
    setLabels((m) => {
      if (!m.has(v)) return m;
      const next = new Map(m);
      next.delete(v);
      return next;
    });
  }, []);

  // close on outside pointer / escape
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    const onPointer = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node) && !panelRef.current?.contains(e.target as Node))
        setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointer);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointer);
    };
  }, [open, setOpen]);

  const ctx = useMemo<SelectContextValue>(
    () => ({
      value: current,
      open,
      setOpen,
      select,
      register,
      unregister,
      labelFor: (v) => (v === undefined ? undefined : labels.get(v)),
      reduce,
      triggerId: `${baseId}-trigger`,
      listId: `${baseId}-list`,
      disabled,
      placement,
      setPlacement,
      panelRef,
    }),
    [
      current,
      open,
      setOpen,
      select,
      register,
      unregister,
      labels,
      reduce,
      baseId,
      disabled,
      placement,
    ],
  );

  return (
    <SelectContext.Provider value={ctx}>
      <div ref={rootRef} className={cn("relative", className)}>
        {children}
      </div>
    </SelectContext.Provider>
  );
}

export interface SelectTriggerProps {
  className?: string;
  /**
   * local patch (pi-app): forwarded as the button's accessible name. The
   * registry version rendered the button from `className`/`children` alone, so
   * every call site's `aria-label` (the model picker's, the new-chat project
   * picker's) was silently dropped and a trigger was announced as its value.
   */
  "aria-label"?: string;
  children: ReactNode;
}

export function SelectTrigger({ className, "aria-label": ariaLabel, children }: SelectTriggerProps) {
  const ctx = useSelectContext("SelectTrigger");
  return (
    <motion.button
      type="button"
      id={ctx.triggerId}
      disabled={ctx.disabled}
      aria-label={ariaLabel}
      aria-haspopup="listbox"
      aria-expanded={ctx.open}
      aria-controls={ctx.listId}
      onClick={() => ctx.setOpen(!ctx.open)}
      // local patch (pi-app): opening a panel leaves its trigger geometry intact.
      className={cn(
        // local patch (pi-app): reserve the transparent border's layout space;
        // pointer hover fills the trigger, keyboard focus keeps a visible ring.
        "relative z-10 flex w-full items-center justify-between gap-2 rounded-xl border border-transparent bg-background px-3 py-2 text-sm text-foreground outline-none transition-colors",
        "hover:bg-muted focus-visible:ring-1 focus-visible:ring-ring",
        "disabled:pointer-events-none disabled:opacity-50",
        className,
      )}
    >
      {children}
      <motion.span
        aria-hidden
        animate={{ rotate: ctx.open ? 180 : 0 }}
        transition={ctx.reduce ? { duration: 0 } : OVERLAY_ENTER}
        className="text-muted-foreground"
      >
        <ChevronDown className="h-4 w-4" />
      </motion.span>
    </motion.button>
  );
}

export interface SelectValueProps {
  placeholder?: string;
  className?: string;
}

export function SelectValue({ placeholder, className }: SelectValueProps) {
  const ctx = useSelectContext("SelectValue");
  const label = ctx.labelFor(ctx.value);
  return (
    <span
      className={cn(label ? "text-foreground" : "text-muted-foreground", className)}
    >
      {label ?? placeholder ?? "Select"}
    </span>
  );
}

export interface SelectContentProps {
  className?: string;
  children: ReactNode;
  /** local patch (pi-app): modal selects keep the vendored control and escape clipping. */
  portal?: boolean;
  portalAlign?: "start" | "end";
  portalWidth?: number;
}

export function SelectContent({ className, children, portal = false, portalAlign = "start", portalWidth }: SelectContentProps) {
  const ctx = useSelectContext("SelectContent");
  const innerRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);
  const [floatingPosition, setFloatingPosition] = useState({ left: 0, top: 0, width: 0 });
  const [portalReady, setPortalReady] = useState(false);
  const open = ctx.open;
  const { setPlacement } = ctx;
  const overlay = useOverlayMotion(ctx.placement);

  // local patch (pi-app): measure the full border box for placement only;
  // natural height keeps every row and both padding edges visible during motion.
  const panelHeight = useCallback(() => {
    const node = innerRef.current;
    if (!node) return 0;
    const panel = node.parentElement;
    const styles = panel ? getComputedStyle(panel) : null;
    const border = styles
      ? parseFloat(styles.borderTopWidth) + parseFloat(styles.borderBottomWidth)
      : 0;
    return node.offsetHeight + (Number.isFinite(border) ? border : 0);
  }, []);

  useLayoutEffect(() => {
    if (portal) return;
    const node = innerRef.current;
    if (!node) return;
    const measure = () => setHeight(panelHeight());
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [panelHeight, portal]);

  // On open, flip upward when there isn't room below and there's more above.
  useLayoutEffect(() => {
    if (!open || portal) return;
    const trigger = document.getElementById(ctx.triggerId);
    if (!trigger || !innerRef.current) return;
    const rect = trigger.getBoundingClientRect();
    const h = panelHeight();
    const below = window.innerHeight - rect.bottom;
    const above = rect.top;
    setPlacement(below < h + 16 && above > below ? "top" : "bottom");
  }, [open, portal, ctx.triggerId, setPlacement, panelHeight, height]);

  // local patch (pi-app): set the real trigger width BEFORE measuring the
  // portalled list. Its initial fixed width is zero; measuring at that width
  // made option text wrap, then the panel flashed tall before shrinking.
  // The first visible frame uses the final width, height and placement.
  useLayoutEffect(() => {
    if (!portal) return;
    // local patch (pi-app): keep the last placement visible through the exit.
    if (!open) return;
    const update = () => {
      const trigger = document.getElementById(ctx.triggerId);
      const panel = ctx.panelRef.current;
      if (!trigger || !panel) return;
      const rect = trigger.getBoundingClientRect();
      const width = Math.min(portalWidth ?? rect.width, window.innerWidth - 16);
      panel.style.width = `${width}px`;
      const measuredHeight = panelHeight();
      setHeight((previous) => previous === measuredHeight ? previous : measuredHeight);
      const below = window.innerHeight - rect.bottom;
      const above = rect.top;
      const nextPlacement = below < measuredHeight + 16 && above > below ? "top" : "bottom";
      setPlacement(nextPlacement);
      const left = Math.max(8, Math.min(
        portalAlign === "end" ? rect.right - width : rect.left,
        window.innerWidth - width - 8,
      ));
      const top = nextPlacement === "top" ? rect.top - measuredHeight - 8 : rect.bottom + 8;
      setFloatingPosition((previous) =>
        previous.left === left && previous.top === top && previous.width === width
          ? previous : { left, top, width },
      );
      setPortalReady(true);
    };
    update();
    const observer = new ResizeObserver(update);
    if (innerRef.current) observer.observe(innerRef.current);
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      observer.disconnect();
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [portal, open, ctx.triggerId, ctx.panelRef, setPlacement, panelHeight, portalAlign, portalWidth]);

  const isTop = ctx.placement === "top";

  // Items stay mounted (open just animates the panel) so each item's label
  // registration persists — otherwise the trigger would fall back to the
  // placeholder the moment the panel closes.
  const panel = (
    <motion.div
      ref={ctx.panelRef}
      id={ctx.listId}
      role="listbox"
      aria-labelledby={ctx.triggerId}
      aria-hidden={!open}
      inert={!open}
      {...overlay}
      animate={open && (!portal || portalReady) ? "open" : "closed"}
      style={{
        transformOrigin: isTop ? "bottom" : "top",
        overflow: "hidden",
        pointerEvents: open ? "auto" : "none",
        ...(portal ? floatingPosition : {}),
        visibility: portal && !portalReady ? "hidden" : undefined,
      }}
      className={cn(
        // local patch (pi-app): all floating surfaces share themed elevation.
        portal ? "fixed z-[110]" : "absolute left-0 right-0 z-20",
        "rounded-xl border border-border bg-background shadow-overlay",
        !portal && (isTop ? "bottom-full mb-2" : "top-full mt-2"),
        className,
      )}
    >
      <div ref={innerRef} className="p-1">
        {children}
      </div>
    </motion.div>
  );
  return portal ? createPortal(panel, document.body) : panel;
}

export interface SelectItemProps {
  value: string;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
}

export function SelectItem({
  value,
  disabled = false,
  className,
  children,
}: SelectItemProps) {
  const ctx = useSelectContext("SelectItem");
  const selected = ctx.value === value;
  const label = typeof children === "string" ? children : value;

  useLayoutEffect(() => {
    ctx.register(value, label);
    return () => ctx.unregister(value);
  }, [ctx.register, ctx.unregister, value, label]);

  return (
    <li>
      <button
        type="button"
        role="option"
        aria-selected={selected}
        disabled={disabled}
        onClick={() => ctx.select(value)}
        className={cn(
          "flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm outline-none transition-colors",
          // local patch (pi-app): a committed single choice keeps its theme tint.
          selected
            ? "bg-primary/15 text-foreground"
            : "text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:bg-muted",
          "disabled:pointer-events-none disabled:opacity-50",
          className,
        )}
      >
        {children}
        {selected ? <Check className="h-3.5 w-3.5 shrink-0" /> : null}
      </button>
    </li>
  );
}
