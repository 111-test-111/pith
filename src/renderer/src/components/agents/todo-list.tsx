"use client";
// beui.dev/components/agents/chat-app

// local patch (pi-app): use the shared Lucide icon adapter.
import { ChevronDown, ListTodo } from "@/lib/icons";
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
// local patch (pi-app): animate Lucide artwork through the shared SVG adapter.
import { AnimatedIcon, IconPaths } from "@/lib/animated-icons";

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
  // colour, but the same r=9 / 1.5 stroke circle as completed/pending rows.
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

  return (
    <motion.svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      initial={false}
      className={cn(
        // local patch (pi-app): same box as the in-progress ring and the
        // bash/subagent rows' icon slot (see above).
        "size-4 shrink-0 overflow-visible text-muted-foreground",
        // local patch (pi-app): every settled status owns a colour — done, dropped.
        status === "completed" && "text-emerald-600 dark:text-emerald-400",
        status === "cancelled" && "text-rose-600 dark:text-rose-400",
      )}
    >
      <motion.circle
        cx="12"
        cy="12"
        r="9"
        fill="currentColor"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeDasharray={status === "pending" ? "2 3" : undefined}
        strokeLinecap="round"
        initial={false}
        animate={{ fillOpacity: status === "completed" ? 0.06 : 0 }}
        transition={reduce ? { duration: 0 } : { duration: 0.18, ease: EASE_OUT }}
      />
      <IconPaths
        icon="check"
        transform="translate(3 3) scale(0.75)"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        initial={false}
        animate={{
          pathLength: status === "completed" ? 1 : 0,
          opacity: status === "completed" ? 1 : 0,
        }}
        transition={reduce ? { duration: 0 } : { duration: 0.24, ease: EASE_OUT }}
      />
      <IconPaths
        icon="cancel"
        transform="translate(3 3) scale(0.75)"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        initial={false}
        animate={{
          pathLength: status === "cancelled" ? 1 : 0,
          opacity: status === "cancelled" ? 1 : 0,
        }}
        transition={reduce ? { duration: 0 } : { duration: 0.2, ease: EASE_OUT }}
      />
    </motion.svg>
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
  const completed = items.filter((item) => item.status === "completed").length;
  const allComplete = items.length > 0 && completed === items.length;
  const itemCount = items.length;

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
    if (!viewport || itemCount === 0) return;

    const frame = requestAnimationFrame(() => {
      if (viewport.scrollHeight <= viewport.clientHeight) return;
      if (typeof viewport.scrollTo === "function") {
        viewport.scrollTo({
          top: viewport.scrollHeight,
          behavior: reduce ? "auto" : "smooth",
        });
      } else {
        viewport.scrollTop = viewport.scrollHeight;
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [itemCount, reduce]);

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
        className="group flex h-11 w-full items-center gap-2.5 rounded-2xl px-3.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <TodoHeaderIcon complete={allComplete} />
        <h3 className="min-w-0 flex-1 truncate text-sm font-medium text-foreground/90">
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
                        "min-w-0 flex-1 truncate text-sm leading-5",
                        status === "pending" && "text-muted-foreground/65",
                        status === "in-progress" && "text-foreground",
                        status === "completed" && "text-muted-foreground/60",
                        status === "cancelled" && "text-muted-foreground/55",
                      )}
                    >
                      <span className="relative inline-block max-w-full">
                        {item.title}
                        <motion.span
                          aria-hidden="true"
                          initial={false}
                          animate={{
                            scaleX: status === "completed" ? 1 : 0,
                            opacity: status === "completed" ? 1 : 0,
                          }}
                          transition={
                            reduce
                              ? { duration: 0 }
                              : { duration: 0.28, ease: EASE_OUT, delay: 0.06 }
                          }
                          className="absolute inset-x-0 top-1/2 h-px origin-left bg-current"
                        />
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
