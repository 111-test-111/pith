// local patch (pi-app): shared scalable typography for UI line metrics.
// local patch (pi-app): keep UI frames and focus rings in this component at 1px.
"use client";
// beui.dev/components/agents/chat-app

// local patch (pi-app): use the shared Hugeicons icon adapter.
import { Ban, ChevronDown, CircleCheck, CircleDashed, ListTodo } from "@/lib/icons";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { ActionSwapRollText } from "@/components/motion/action-swap-roll";
import { AgentDisclosure } from "@/components/agents/agent-disclosure";
import {
  EASE_OUT,
  SPRING_LAYOUT,
  SPRING_SWAP,
} from "@/lib/ease";
import { cn } from "@/lib/utils";
// local patch (pi-app): animate the shared stroke marks through the app's own mark table.
import { AnimatedIcon } from "@/lib/animated-icons";

export type TodoItemStatus =
  | "pending"
  | "in-progress"
  | "completed"
  | "cancelled";

export interface TodoItem {
  id: string;
  title: ReactNode;
  status?: TodoItemStatus;
  progress?: number;
  detail?: ReactNode;
}

export interface TodoListProps {
  // local patch (pi-app): the shared task panel owns the list's frame —
  // viewportClassName replaces the vendored edge padding (its `px-2 pb-2`
  // would otherwise win over a shorthand `p-1`) and, when given, also takes
  // over the cap, since a fixed height cannot survive `maxHeight`; listClassName
  // sets the row gap the vendored card rhythm leaves at zero.
  viewportClassName?: string;
  listClassName?: string;
  // local patch (pi-app): the shared task panel owns the heading/disclosure.
  headerless?: boolean;
  items: TodoItem[];
  title?: ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  collapseOnComplete?: boolean;
  maxHeight?: number;
  className?: string;
}

function statusLabel(status: TodoItemStatus) {
  if (status === "in-progress") return "In progress";
  if (status === "completed") return "Completed";
  if (status === "cancelled") return "Cancelled";
  return "Pending";
}

function TodoHeaderIcon({ complete }: { complete: boolean }) {
  const reduce = useReducedMotion() ?? false;

  return (
    <span
      aria-hidden="true"
      className="relative grid size-6 shrink-0 place-items-center"
    >
      <AnimatePresence initial={false} mode="popLayout">
        {complete ? (
          <AnimatedIcon
            icon="complete"
            draw={{
              initial: reduce ? { pathLength: 1 } : { pathLength: 0 },
              animate: { pathLength: 1 },
              transition: reduce ? { duration: 0 } : { duration: 0.24, ease: EASE_OUT },
            }}
            key="complete"
            viewBox="0 0 24 24"
            initial={reduce ? { opacity: 1 } : { opacity: 0, scale: 0.72 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0 }}
            transition={reduce ? { duration: 0 } : SPRING_SWAP}
            className="absolute size-5.5 overflow-visible text-emerald-500"
          />
        ) : (
          <motion.span
            key="todo"
            initial={reduce ? { opacity: 1 } : { opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.72 }}
            transition={reduce ? { duration: 0 } : SPRING_SWAP}
            className="absolute grid place-items-center text-muted-foreground"
          >
            <ListTodo className="size-4" />
          </motion.span>
        )}
      </AnimatePresence>
    </span>
  );
}

/** One Hugeicons glyph per settled outcome — the same marks the tool rows draw. */
const TODO_GLYPHS = {
  pending: CircleDashed,
  completed: CircleCheck,
  cancelled: Ban,
} as const;

function TodoStatusIcon({
  status,
  progress,
}: {
  status: TodoItemStatus;
  progress?: number;
}) {
  const reduce = useReducedMotion() ?? false;
  const running = status === "in-progress";
  // local patch (pi-app): in-progress uses the sidebar's live-session spin + theme
  // colour, but the same r=9 / 1.5 stroke circle as the other rows.
  // progress === 0 and reduced motion keep paused/retained rows still.
  const spinning = running && progress === undefined && !reduce;

  if (running) {
    return (
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        data-todo-progress
        className={cn(
          // local patch (pi-app): the shared task panel's rows all lead with a
          // size-4 box — the same one the bash/subagent rows' `ToolResult`
          // slot gives their icon — so the three panels line up.
          "size-4 shrink-0 text-primary",
          spinning && "animate-spin",
        )}
      >
        <circle
          cx="12"
          cy="12"
          r="9"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          pathLength="1"
          strokeDasharray="0.75 0.25"
        />
      </svg>
    );
  }

  // local patch (pi-app): a settled row is the icon adapter's own Hugeicons
  // artwork — `CircleDashed` while awaiting, `CircleCheck` when done, `Ban` when
  // dropped. The native rings share the 24 box and the waiting arc's 1.5 stroke;
  // `lib/status-ring.tsx` uses these same drawings for tool rows. Only the
  // running row stays drawn: no glyph carries the live spin.
  const Glyph = TODO_GLYPHS[status];
  return (
    <Glyph
      strokeWidth={1.5}
      className={cn(
        // local patch (pi-app): the shared task panel's rows all lead with a
        // size-4 box — the same one the bash/subagent rows' `ToolResult`
        // slot gives their icon — so the three panels line up.
        "size-4 shrink-0",
        // local patch (pi-app): every settled status owns a colour — done, dropped.
        status === "pending" && "text-muted-foreground",
        status === "completed" && "text-emerald-600 dark:text-emerald-400",
        status === "cancelled" && "text-rose-600 dark:text-rose-400",
      )}
    />
  );
}

export function TodoList({
  headerless = false,
  items,
  title = "To-dos",
  open,
  defaultOpen = true,
  onOpenChange,
  collapseOnComplete = true,
  maxHeight = 248,
  className,
  viewportClassName,
  listClassName,
}: TodoListProps) {
  const reduce = useReducedMotion() ?? false;
  const baseId = useId();
  const triggerId = `${baseId}-trigger`;
  const contentId = `${baseId}-content`;
  const viewportRef = useRef<HTMLDivElement>(null);
  const previousComplete = useRef(false);
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const currentOpen = open ?? internalOpen;
  // local patch (pi-app): which row the list positions itself on. The vendored
  // list always scrolled to the BOTTOM, so a long plan opened on its last, least
  // relevant row; the row that matters is the one being worked on, and with
  // nothing running it is the newest completed one. Last wins in both passes,
  // so a legacy list carrying several in-progress rows lands on the newest.
  let runningIndex = -1;
  let completedIndex = -1;
  items.forEach((item, index) => {
    const status = item.status ?? "pending";
    if (status === "in-progress") runningIndex = index;
    else if (status === "completed") completedIndex = index;
  });
  const targetIndex = runningIndex >= 0 ? runningIndex : completedIndex;
  // A list that is being positioned for the first time since it opened does it
  // instantly: the panel is appearing, and a glide inside it reads as a second,
  // unrelated animation. A task update in an already-positioned list scrolls.
  const positioned = useRef(false);
  const completed = items.filter((item) => item.status === "completed").length;
  const allComplete = items.length > 0 && completed === items.length;

  const setOpen = useCallback(
    (next: boolean) => {
      if (open === undefined) setInternalOpen(next);
      onOpenChange?.(next);
    },
    [onOpenChange, open],
  );

  useEffect(() => {
    if (previousComplete.current && !allComplete) {
      setOpen(true);
    }
    if (!previousComplete.current && allComplete && collapseOnComplete) {
      setOpen(false);
    }
    previousComplete.current = allComplete;
  }, [allComplete, collapseOnComplete, setOpen]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const list = viewport?.querySelector("ol");
    const target =
      list && targetIndex >= 0
        ? (list.children[targetIndex] as HTMLElement | undefined)
        : undefined;
    if (!viewport || !list || !target || !currentOpen) {
      positioned.current = false;
      return;
    }

    const behavior: ScrollBehavior =
      reduce || !positioned.current ? "auto" : "smooth";
    positioned.current = true;
    const frame = requestAnimationFrame(() => {
      const max = viewport.scrollHeight - viewport.clientHeight;
      if (max <= 0) return;
      // The row's offset inside the list is layout-only, so Motion's entrance or
      // `layout` transform on the row itself cannot skew it; the list's own
      // on-screen top already carries the scrollport's current position.
      const rowCenter =
        list.getBoundingClientRect().top +
        (target.offsetTop - list.offsetTop) +
        target.offsetHeight / 2;
      const viewportCenter =
        viewport.getBoundingClientRect().top + viewport.clientHeight / 2;
      const top = Math.min(
        max,
        Math.max(0, viewport.scrollTop + rowCenter - viewportCenter),
      );
      if (typeof viewport.scrollTo === "function") {
        viewport.scrollTo({ top, behavior });
      } else {
        viewport.scrollTop = top;
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [currentOpen, items.length, reduce, targetIndex]);

  return (
    <section
      aria-label="Agent task list"
      className={cn(
        "w-full overflow-hidden rounded-2xl border border-border/70",
        className,
      )}
    >
      {/* local patch (pi-app): embed the native rows in the task panel without a second toggle. */}
      {!headerless && <button
        id={triggerId}
        type="button"
        aria-expanded={currentOpen}
        aria-controls={contentId}
        onClick={() => setOpen(!currentOpen)}
        // local patch (pi-app): the expandable header fills on hover.
        className="group flex h-11 w-full items-center gap-2.5 rounded-2xl px-3.5 text-left outline-none transition-colors hover:bg-muted/50 focus-visible:ring-1 focus-visible:ring-ring"
      >
        <TodoHeaderIcon complete={allComplete} />
        {/* local patch (pi-app): task headings keep primary text contrast. */}
        <h3 className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
          {title}
        </h3>
        <span
          className={cn(
            "shrink-0 text-xs font-medium tabular-nums text-muted-foreground",
            allComplete && "text-emerald-600 dark:text-emerald-400",
          )}
        >
          <span className="sr-only">
            {completed} of {items.length} tasks completed
          </span>
          <span aria-hidden="true" className="inline-flex">
            <ActionSwapRollText value={String(completed)}>
              {completed}
            </ActionSwapRollText>
            <span>/</span>
            <span>{items.length}</span>
          </span>
        </span>
        <motion.span
          aria-hidden="true"
          animate={{ rotate: currentOpen ? 180 : 0 }}
          transition={reduce ? { duration: 0 } : SPRING_SWAP}
          className="text-muted-foreground/50 transition-colors group-hover:text-muted-foreground"
        >
          <ChevronDown className="size-3.5" />
        </motion.span>
      </button>}

      <AgentDisclosure
        id={contentId}
        role={headerless ? undefined : "region"}
        aria-labelledby={headerless ? undefined : triggerId}
        open={headerless || currentOpen}
      >
        <div
          ref={viewportRef}
          className={cn(
            "scrollbar-hide overflow-y-auto",
            // local patch (pi-app): the app's frame replaces the vendored padding.
            viewportClassName ?? "px-2 pb-2",
          )}
          style={viewportClassName ? undefined : { maxHeight }}
        >
          {items.length ? (
            <ol aria-live="polite" className={cn("space-y-0", listClassName)}>
            <AnimatePresence initial={false} mode="popLayout">
              {items.map((item) => {
                const status = item.status ?? "pending";
                return (
                  <motion.li
                    layout="position"
                    key={item.id}
                    initial={reduce ? { opacity: 1 } : { opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={reduce ? { opacity: 0 } : { opacity: 0, y: -3 }}
                    transition={
                      reduce
                        ? { duration: 0 }
                        : {
                            opacity: { duration: 0.18, ease: EASE_OUT },
                            y: SPRING_LAYOUT,
                            layout: SPRING_LAYOUT,
                          }
                    }
                    className="flex min-h-9 items-center gap-2.5 rounded-xl px-1.5 py-1"
                  >
                    <TodoStatusIcon status={status} progress={item.progress} />
                    <span className="sr-only">{statusLabel(status)}: </span>
                    <span
                      className={cn(
                        "min-w-0 flex-1 truncate text-sm leading-ui",
                        // local patch (pi-app): unfinished task titles use primary text contrast.
                        (status === "pending" || status === "in-progress") && "text-foreground",
                        status === "completed" && "text-muted-foreground/60",
                        status === "cancelled" && "text-muted-foreground/55",
                      )}
                    >
                      {/* local patch (pi-app): a real line-through instead of an
                          absolutely positioned strip. The strip could only sit at
                          one height, so a title wrapping to several lines got a
                          single strike across the box's middle; text decoration
                          propagates to every line box, so each wrapped row gets
                          its own strike. The draw-in becomes a colour fade — a
                          per-line wipe is not expressible — and fading the colour
                          both ways also animates un-completing a row. */}
                      <span
                        className={cn(
                          "inline-block max-w-full line-through transition-[text-decoration-color] delay-[60ms] duration-300 ease-out motion-reduce:transition-none",
                          status === "completed"
                            ? "decoration-current"
                            : "decoration-transparent",
                        )}
                      >
                        {item.title}
                      </span>
                    </span>
                    {item.detail ? (
                      <span
                        className={cn(
                          "shrink-0 text-sm text-muted-foreground/55",
                          // local patch (pi-app): the label carries the same status colour.
                          status === "in-progress" && "text-foreground/70",
                          status === "completed" &&
                            "text-emerald-600 dark:text-emerald-400",
                          status === "cancelled" &&
                            "text-rose-600 dark:text-rose-400",
                        )}
                      >
                        {item.detail}
                      </span>
                    ) : null}
                  </motion.li>
                );
              })}
            </AnimatePresence>
            </ol>
          ) : (
            <p className="px-1.5 py-2 text-sm text-muted-foreground">
              No tasks yet
            </p>
          )}
        </div>
      </AgentDisclosure>
    </section>
  );
}
