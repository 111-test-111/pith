"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useId } from "react";
import { EASE_OUT, SPRING_PRESS } from "@/lib/ease";
import { cn } from "@/lib/utils";

// local patch (pi-app): animate Lucide artwork through the shared SVG adapter.
import { AnimatedIcon } from "@/lib/animated-icons";
import { useUiStyle } from "@/lib/ui-style";

export interface CheckboxProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  indeterminate?: boolean;
  label?: string;
  className?: string;
  id?: string;
  "aria-label"?: string;
  /** Associates an external message (e.g. a form error) with the control. */
  "aria-describedby"?: string;
  // local patch (pi-app): the mark the box draws when it is on. `check` is the
  // list-selection glyph (multi-select, filters); `square` is the app's on/off
  // control — it replaced every `Switch`. Its on-state follows the interface
  // style: a primary point in the square style, the check glyph in the squircle
  // style, which is how it stays distinguishable from the radio's dot.
  mark?: 'check' | 'square';
}

export function Checkbox({
  checked,
  onCheckedChange,
  disabled,
  indeterminate,
  label,
  className,
  id: idProp,
  "aria-label": ariaLabel,
  "aria-describedby": ariaDescribedBy,
  mark = 'check',
}: CheckboxProps) {
  const autoId = useId();
  const id = idProp ?? autoId;
  const reduce = useReducedMotion();
  const [uiStyle] = useUiStyle();
  const showMark = checked || indeterminate;
  const square = mark === 'square';
  // local patch (pi-app): the on-state mark follows the interface style. The
  // square style keeps the point; the squircle style draws the check glyph,
  // which is what keeps this control distinguishable from the radio, whose
  // mark stays a dot. (Both controls' frames are circles in that style.)
  const pointMark = square && uiStyle === 'square';

  return (
    <label
      htmlFor={id}
      className={cn(
        "inline-flex items-center gap-3",
        disabled ? "cursor-not-allowed" : "cursor-pointer",
        className,
      )}
    >
      <motion.button
        id={id}
        type="button"
        role="checkbox"
        aria-checked={indeterminate ? "mixed" : checked}
        aria-label={ariaLabel}
        aria-describedby={ariaDescribedBy}
        disabled={disabled}
        onClick={() => !disabled && onCheckedChange(!checked)}
        whileTap={reduce || disabled ? undefined : { scale: 0.92 }}
        transition={SPRING_PRESS}
        data-state={
          checked ? "checked" : indeterminate ? "indeterminate" : "unchecked"
        }
        className={cn(
          // local patch (pi-app): text-sized (14px box, 9px mark) rather than
          // the vendored 20px one, which read heavier than the line it marks.
          // The frame takes the CONTROL step: hard-edged in the square style, a
          // circle in the squircle style (the control step is 14px on this 14px
          // box). The squircle checkbox is told apart from the radio by the MARK
          // it draws — the check glyph versus the radio's dot — not by its frame.
          "inline-flex size-3.5 shrink-0 items-center justify-center rounded-control border-2 outline-none transition-colors duration-200",
          "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
          "disabled:cursor-not-allowed disabled:opacity-60",
          showMark
            ? square
              ? // local patch (pi-app): the square mark's fill is the point
                // INSIDE the frame, so the box's own interior stays open and
                // only the frame takes the primary border when it is on.
                "border-primary bg-background"
              : "border-primary bg-primary text-primary-foreground"
            : "border-muted-foreground/50 bg-background hover:border-muted-foreground",
        )}
      >
        {pointMark ? (
          <AnimatePresence initial={false}>
            {showMark ? (
              <motion.span
                key="square"
                data-checkbox-mark
                // local patch (pi-app): the point-selection mark is a square
                // point in the square style (`--app-radius-capsule` is 0px
                // there). The squircle style does not render this branch at all:
                // `pointMark` is true only in the square style.
                className="size-1.5 rounded-capsule bg-primary"
                initial={reduce ? { opacity: 1 } : { opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={
                  reduce ? { duration: 0 } : { duration: 0.14, ease: EASE_OUT }
                }
                aria-hidden
              />
            ) : null}
          </AnimatePresence>
        ) : (
          <AnimatePresence initial={false}>
            {showMark ? (
              <AnimatedIcon
                icon={indeterminate ? "minus" : "check"}
                key={indeterminate ? "indeterminate" : "checked"}
                data-checkbox-mark
                width="9"
                height="9"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                initial={reduce ? { opacity: 1 } : { opacity: 0, scale: 0.5 }}
                animate={reduce ? { opacity: 1 } : { opacity: 1, scale: 1 }}
                exit={
                  reduce
                    ? { opacity: 0 }
                    : { opacity: 0, scale: 0.5, filter: "blur(4px)" }
                }
                transition={
                  reduce ? { duration: 0 } : { duration: 0.16, ease: EASE_OUT }
                }
                draw={{
                  initial: reduce ? { pathLength: 1 } : { pathLength: 0 },
                  animate: { pathLength: 1 },
                  transition: reduce ? { duration: 0 } : { duration: indeterminate ? 0.2 : 0.3, ease: EASE_OUT, delay: 0.04 },
                }}
                aria-hidden
            >
              <title>{indeterminate ? "Partially selected" : "Selected"}</title>
              </AnimatedIcon>
            ) : null}
          </AnimatePresence>
        )}
      </motion.button>
      {label ? (
        <span className={cn("select-none text-sm text-foreground", disabled && "opacity-60")}>
          {label}
        </span>
      ) : null}
    </label>
  );
}
