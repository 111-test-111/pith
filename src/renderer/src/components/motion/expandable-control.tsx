// local patch (pi-app): keep UI frames and focus rings in this component at 1px.
"use client";
// beui.dev/components/motion/expandable-control

import {
  AnimatePresence,
  type HTMLMotionProps,
  motion,
  type Transition,
  useReducedMotion,
  type Variants,
} from "motion/react";
import {
  type MouseEvent,
  type ReactNode,
  useCallback,
  useRef,
  useState,
} from "react";
import { cn } from "@/lib/utils";

// Matches the Motion Patterns "Layout continuity" recipe so the surface
// keeps its identity while its footprint changes.
const CONTINUITY_SPRING: Transition = {
  type: "spring",
  stiffness: 220,
  damping: 17,
  mass: 0.85,
};

const CONTINUITY_LABEL: Variants = {
  hidden: { opacity: 0, filter: "blur(4px)" },
  visible: { opacity: 1, filter: "blur(0px)" },
  exit: { opacity: 0, filter: "blur(4px)" },
};

type ExpandableStateProps = {
  expanded?: boolean;
  defaultExpanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
};

export interface ExpandableButtonProps
  extends Omit<HTMLMotionProps<"button">, "children">,
    ExpandableStateProps {
  icon: ReactNode;
  label: ReactNode;
}

export interface ExpandableChipProps extends ExpandableStateProps {
  label: ReactNode;
  actionIcon: ReactNode;
  actionLabel: string;
  onAction?: () => void;
  collapseOnAction?: boolean;
  disabled?: boolean;
  className?: string;
  labelClassName?: string;
  actionClassName?: string;
}

function useExpandableState({
  expanded,
  defaultExpanded = false,
  onExpandedChange,
}: ExpandableStateProps) {
  const [internalExpanded, setInternalExpanded] = useState(defaultExpanded);
  const isControlled = expanded !== undefined;
  const currentExpanded = expanded ?? internalExpanded;

  const setExpanded = useCallback(
    (nextExpanded: boolean) => {
      if (!isControlled) {
        setInternalExpanded(nextExpanded);
      }
      onExpandedChange?.(nextExpanded);
    },
    [isControlled, onExpandedChange],
  );

  return [currentExpanded, setExpanded] as const;
}

export function ExpandableButton({
  icon,
  label,
  expanded,
  defaultExpanded,
  onExpandedChange,
  className,
  onClick,
  disabled,
  type = "button",
  "aria-label": ariaLabel,
  ...props
}: ExpandableButtonProps) {
  const reduce = useReducedMotion();
  const [isExpanded, setExpanded] = useExpandableState({
    expanded,
    defaultExpanded,
    onExpandedChange,
  });

  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    onClick?.(event);
    if (!event.defaultPrevented) {
      setExpanded(!isExpanded);
    }
  };

  const transition = reduce ? { duration: 0 } : CONTINUITY_SPRING;

  return (
    <motion.span layout transition={transition} className="inline-flex">
      <motion.button
        {...props}
        layout
        type={type}
        aria-label={ariaLabel ?? (typeof label === "string" ? label : undefined)}
        aria-expanded={isExpanded}
        disabled={disabled}
        className={cn(
          // local patch (pi-app): capsule-by-design trigger, so the shape
          // token follows the UI style.
          // local patch (pi-app): the control keeps its width but paints no
          // frame; the pointer state is a fill.
          "relative inline-flex h-11 min-w-11 items-center overflow-hidden rounded-capsule border border-transparent bg-transparent p-1 pr-1 text-sm font-medium text-foreground outline-none transition-colors hover:bg-muted focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
          className,
        )}
        onClick={handleClick}
        // local patch (pi-app): no press scale — a control must not dip inward
        // while pressed (see `button/base`).
        transition={transition}
      >
        <motion.span
          layout="position"
          className="grid size-9 shrink-0 place-items-center"
          aria-hidden="true"
          transition={transition}
        >
          {icon}
        </motion.span>
        <AnimatePresence mode="popLayout" initial={false}>
          {isExpanded ? (
            <motion.span
              key="label"
              layout
              variants={CONTINUITY_LABEL}
              initial={reduce ? { opacity: 0 } : "hidden"}
              animate={reduce ? { opacity: 1 } : "visible"}
              exit={reduce ? { opacity: 0 } : "exit"}
              transition={transition}
              className="relative inline-flex w-max items-center whitespace-nowrap pr-3"
              aria-hidden="true"
            >
              {label}
            </motion.span>
          ) : null}
        </AnimatePresence>
      </motion.button>
    </motion.span>
  );
}

export function ExpandableChip({
  label,
  actionIcon,
  actionLabel,
  onAction,
  collapseOnAction = true,
  expanded,
  defaultExpanded,
  onExpandedChange,
  disabled,
  className,
  labelClassName,
  actionClassName,
}: ExpandableChipProps) {
  const reduce = useReducedMotion();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [isExpanded, setExpanded] = useExpandableState({
    expanded,
    defaultExpanded,
    onExpandedChange,
  });

  const handleAction = () => {
    onAction?.();
    if (collapseOnAction) {
      setExpanded(false);
      triggerRef.current?.focus();
    }
  };

  const transition = reduce ? { duration: 0 } : CONTINUITY_SPRING;

  return (
    <motion.span layout transition={transition} className="inline-flex">
      <motion.div
        layout
        className={cn(
          // local patch (pi-app): capsule-by-design chip surface, so the shape
          // token follows the UI style.
          "inline-flex h-10 items-center overflow-hidden rounded-capsule border border-transparent bg-transparent text-sm text-foreground has-[:focus-visible]:ring-1 has-[:focus-visible]:ring-inset has-[:focus-visible]:ring-ring",
          className,
        )}
        transition={transition}
      >
        <motion.button
          layout="position"
          ref={triggerRef}
          type="button"
          aria-expanded={isExpanded}
          disabled={disabled}
          className={cn(
            "h-full whitespace-nowrap py-0 pl-3 font-medium outline-none transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-50",
            isExpanded ? "pr-1" : "pr-3",
            labelClassName,
          )}
          onClick={() => setExpanded(!isExpanded)}
          transition={transition}
        >
          {label}
        </motion.button>
        <motion.span
          variants={CONTINUITY_LABEL}
          className={cn(
            // local patch (pi-app): follow the caller's height instead of the
            // vendored fixed h-10, so a compact chip does not clip its action.
            "relative inline-flex h-full shrink-0 items-center overflow-hidden",
            isExpanded ? "w-8" : "w-0",
          )}
          aria-hidden={!isExpanded}
          initial={false}
          animate={
            reduce
              ? { opacity: isExpanded ? 1 : 0 }
              : isExpanded
                ? "visible"
                : "hidden"
          }
          transition={transition}
        >
          <motion.button
            type="button"
            aria-label={actionLabel}
            disabled={disabled || !isExpanded}
            className={cn(
              // local patch (pi-app): the action icon control keeps the shared
              // control radius rather than a capsule.
              "flex h-full w-8 shrink-0 items-center justify-center rounded-icon text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none",
              disabled && "opacity-50",
              actionClassName,
            )}
            onClick={handleAction}
            // local patch (pi-app): no press scale — see `button/base`.
            transition={transition}
          >
            <span aria-hidden="true">{actionIcon}</span>
          </motion.button>
        </motion.span>
      </motion.div>
    </motion.span>
  );
}
